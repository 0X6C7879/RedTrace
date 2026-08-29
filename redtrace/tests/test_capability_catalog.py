from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from redtrace.board.models import ALL_CAPABILITIES, SECURITY_CAPABILITIES
from redtrace.capabilities import CapabilityStore, SkillCatalogError
from redtrace.dispatcher.contracts import CAPABILITY_NAMES as DISPATCH_CAPABILITY_NAMES
from redtrace.server import db
from redtrace.server.app import app

REPO_ROOT = Path(__file__).resolve().parents[2]

WEB_SKILLS = [
    "api-security",
    "browser-automation",
    "browser-persistence",
    "database-security",
    "email-security",
    "file-parser-chain",
    "graphql-rpc-drift",
    "identity-federation",
    "js-reverse",
    "jwt-claim-confusion",
    "mailbox-abuse",
    "oauth-oidc-chain",
    "playwright-skill",
    "queue-worker-drift",
    "race-condition-state-drift",
    "src-hunter",
    "supply-chain",
    "supply-chain-security",
    "template-render-path",
    "web-runtime",
    "websocket-runtime",
]


def _repo_store() -> CapabilityStore:
    return CapabilityStore(REPO_ROOT)


def _common_names(store: CapabilityStore) -> set[str]:
    return {
        record.name
        for record in store.list_skills()
        if record.enabled and "common" in record.capabilities
    }


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "redtrace.db")
    with TestClient(app) as test_client:
        yield test_client


def _create_project(client: TestClient) -> str:
    response = client.post(
        "/projects",
        json={"title": "catalog", "origin": "start", "goal": "done"},
    )
    assert response.status_code == 201
    return response.json()["project"]["id"]


# ── Fixed Capability vocabulary ────────────────────────────────────────────


def test_capability_enum_is_fixed_at_10_directions() -> None:
    assert ALL_CAPABILITIES == (
        "common",
        "web",
        "pentest",
        "binary",
        "crypto",
        "cloud",
        "blockchain",
        "hardware",
        "ai-security",
        "defense",
    )
    assert SECURITY_CAPABILITIES == tuple(ALL_CAPABILITIES[1:])
    assert len(SECURITY_CAPABILITIES) == 9
    assert set(DISPATCH_CAPABILITY_NAMES) == set(ALL_CAPABILITIES)


def test_capability_lists_agree_across_prompt_and_dsh_contracts() -> None:
    prompt = (
        REPO_ROOT
        / "redtrace"
        / "src"
        / "redtrace"
        / "dispatcher"
        / "prompts"
        / "default"
        / "reason.md"
    ).read_text(encoding="utf-8")
    for name in ALL_CAPABILITIES:
        assert name in prompt, f"reason prompt is missing capability: {name}"
    assert "固定 10 项" in prompt

    contracts_ts = (
        REPO_ROOT / "packages" / "redtrace-dsh" / "src" / "contracts.ts"
    ).read_text(encoding="utf-8")
    block = re.search(
        r"export const CAPABILITY_NAMES = \[(.*?)\] as const",
        contracts_ts,
        re.DOTALL,
    )
    assert block is not None
    ts_contract_names = set(re.findall(r"'([^']+)'", block.group(1)))
    assert ts_contract_names == set(ALL_CAPABILITIES)

    types_ts = (
        REPO_ROOT / "packages" / "redtrace-dsh" / "src" / "types.ts"
    ).read_text(encoding="utf-8")
    union = re.search(
        r"export type CapabilityName =((?:\s*\|?\s*'[^']+')+)\s*\n",
        types_ts,
    )
    assert union is not None
    ts_type_names = set(re.findall(r"'([^']+)'", union.group(1)))
    assert ts_type_names == set(ALL_CAPABILITIES)

    dsh_prompt = (
        REPO_ROOT / "packages" / "redtrace-dsh" / "src" / "prompt.ts"
    ).read_text(encoding="utf-8")
    for name in ALL_CAPABILITIES:
        assert name in dsh_prompt, f"DSH Reason prompt is missing capability: {name}"


# ── Repository Skill classification ────────────────────────────────────────


def test_repo_skills_are_fully_classified() -> None:
    store = _repo_store()
    classifications = store.classify_skills()

    assert len(classifications) >= 80
    for item in classifications:
        assert item["valid"], f"unclassified Skill: {item['name']}: {item['diagnostics']}"
        assert item["capabilities"]

    names = {item["name"] for item in classifications}
    assert not any(name.startswith("competition-") for name in names)
    assert "ctf-sandbox-orchestrator" not in names


def test_skills_carry_no_profile_classification_or_prerequisite_text() -> None:
    skills_dir = REPO_ROOT / "skills"
    for skill_dir in sorted(skills_dir.iterdir()):
        if not skill_dir.is_dir() or not (skill_dir / "SKILL.md").is_file():
            continue
        content = (skill_dir / "SKILL.md").read_text(encoding="utf-8").lower()
        assert "competition:" not in content, skill_dir.name
        assert "competition profile" not in content, skill_dir.name
        assert "downstream-only" not in content, skill_dir.name
        assert "must load the orchestrator" not in content, skill_dir.name
        assert "load the orchestrator first" not in content, skill_dir.name
        assert "先加载" not in content, skill_dir.name


# ── Resolver behaviour ─────────────────────────────────────────────────────


def test_web_catalog_is_common_plus_all_matching_web_skills() -> None:
    store = _repo_store()
    catalog = store.resolve_skill_catalog(["web"])
    assert set(catalog["skills"]) == _common_names(store) | set(WEB_SKILLS)
    assert catalog["capabilities"] == ["web"]
    assert set(catalog) == {"skills", "capabilities", "diagnostics"}


def test_multi_capability_catalog_is_deduped_union() -> None:
    store = _repo_store()
    union = store.resolve_skill_catalog(["web", "pentest"])["skills"]
    assert union == sorted(set(union))
    assert union == store.resolve_skill_catalog(["pentest", "web"])["skills"]
    web_only = set(store.resolve_skill_catalog(["web"])["skills"])
    pentest_only = set(store.resolve_skill_catalog(["pentest"])["skills"])
    assert set(union) == web_only | pentest_only


def test_every_single_capability_catalog_keeps_the_common_skills() -> None:
    store = _repo_store()
    for capability in ALL_CAPABILITIES:
        catalog = store.resolve_skill_catalog([capability])
        assert _common_names(store) <= set(catalog["skills"]), capability


def test_unrelated_capability_skills_stay_invisible() -> None:
    catalog = _repo_store().resolve_skill_catalog(["web"])
    assert "ad-certificate-abuse" not in catalog["skills"]
    assert "k8s-control-plane" not in catalog["skills"]


def test_resolver_rejects_invalid_requests() -> None:
    store = _repo_store()
    with pytest.raises(ValueError, match="at least one capability"):
        store.resolve_skill_catalog([])
    with pytest.raises(ValueError, match="must not contain duplicates"):
        store.resolve_skill_catalog(["web", "web"])
    with pytest.raises(ValueError, match="unknown capability"):
        store.resolve_skill_catalog(["code-audit"])


def test_resolver_fails_closed_on_invalid_skill_metadata(tmp_path: Path) -> None:
    skill_dir = tmp_path / "skills" / "recon"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: recon\ndescription: Unclassified.\n---\n\n# Recon\n",
        encoding="utf-8",
    )

    with pytest.raises(SkillCatalogError) as exc_info:
        CapabilityStore(tmp_path).resolve_skill_catalog(["web"])

    messages = [item["skill"] for item in exc_info.value.diagnostics]
    assert "recon" in messages


# ── Resolver API ───────────────────────────────────────────────────────────


def test_resolve_endpoint_returns_catalog_and_rejects_bad_requests(
    client: TestClient, monkeypatch
) -> None:
    monkeypatch.setenv("REDTRACE_CAPABILITIES_ROOT", str(REPO_ROOT))
    resolved = client.post(
        "/capabilities/resolve",
        json={"capabilities": ["web"]},
    )
    assert resolved.status_code == 200
    assert set(resolved.json()["skills"]) == _common_names(_repo_store()) | set(WEB_SKILLS)

    unknown = client.post(
        "/capabilities/resolve",
        json={"capabilities": ["code-audit"]},
    )
    assert unknown.status_code == 422
    empty = client.post(
        "/capabilities/resolve",
        json={"capabilities": []},
    )
    assert empty.status_code == 422

    catalog = client.get("/capabilities/catalog")
    assert catalog.status_code == 200
    assert catalog.json()["capabilities"] == list(ALL_CAPABILITIES)
    assert all(item["valid"] for item in catalog.json()["skills"])


# ── Intent capability contract ─────────────────────────────────────────────


def test_intent_creation_validates_capabilities(client: TestClient) -> None:
    project_id = _create_project(client)

    def create(payload: dict) -> int:
        return client.post(f"/projects/{project_id}/intents", json=payload).status_code

    base = {"from": ["origin"], "description": "direction", "creator": "reasoner"}
    assert create({**base, "capabilities": []}) == 422
    assert create({**base, "capabilities": ["web", "web"]}) == 422
    assert create({**base, "capabilities": ["api"]}) == 422
    assert create({**base, "capabilities": ["code-audit"]}) == 422
    assert create({**base, "capabilities": ["web"]}) == 201

    detail = client.get(f"/projects/{project_id}")
    assert [intent["capabilities"] for intent in detail.json()["intents"]] == [["web"]]


def test_bootstrap_intent_may_omit_capabilities(client: TestClient) -> None:
    project_id = _create_project(client)
    created = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "bootstrap",
            "creator": "dispatcher.bootstrap",
            "capabilities": [],
        },
    )
    assert created.status_code == 201
    assert created.json()["capabilities"] == []


def test_intent_capabilities_editable_until_claimed(client: TestClient) -> None:
    project_id = _create_project(client)
    created = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "direction",
            "creator": "reasoner",
            "capabilities": ["web"],
        },
    )
    assert created.status_code == 201
    intent_id = created.json()["id"]
    path = f"/projects/{project_id}/intents/{intent_id}/capabilities"

    def update(payload: dict) -> int:
        return client.patch(path, json=payload).status_code

    assert update({"capabilities": []}) == 422
    assert update({"capabilities": ["web", "web"]}) == 422
    assert update({"capabilities": ["api"]}) == 422
    assert update({"capabilities": ["code-audit"]}) == 422
    assert update({"capabilities": ["web", "pentest"]}) == 200
    detail = client.get(f"/projects/{project_id}").json()
    assert detail["intents"][0]["capabilities"] == ["web", "pentest"]

    assert (
        client.post(
            f"/projects/{project_id}/intents/{intent_id}/claim",
            json={"worker": "explorer"},
        ).status_code
        == 200
    )
    assert update({"capabilities": ["binary"]}) == 409


def test_legacy_intent_capabilities_normalize_on_read(client: TestClient) -> None:
    project_id = _create_project(client)
    created = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "resume legacy intent",
            "creator": "reasoner",
            "capabilities": ["web"],
        },
    )
    intent_id = created.json()["id"]
    with db.get_conn(immediate=True) as conn:
        conn.execute(
            "UPDATE intents SET capabilities = ? WHERE id = ? AND project_id = ?",
            (
                json.dumps(
                    ["api", "identity", "ad", "pwn", "firmware-iot", "forensics"]
                ),
                intent_id,
                project_id,
            ),
        )

    detail = client.get(f"/projects/{project_id}").json()
    assert detail["intents"][0]["capabilities"] == [
        "web",
        "pentest",
        "binary",
        "hardware",
        "defense",
    ]


def test_project_has_no_skill_profile_contract(client: TestClient) -> None:
    project_id = _create_project(client)
    detail = client.get(f"/projects/{project_id}")
    assert "skill_profile" not in detail.json()["project"]
    assert client.put(f"/projects/{project_id}/skill-profile", json={}).status_code == 404


# ── One-time migration backfill ────────────────────────────────────────────


def test_configure_backfills_legacy_intent_capabilities(
    tmp_path: Path, monkeypatch
) -> None:
    path = tmp_path / "legacy-capabilities.db"
    from sqlite3 import connect

    with connect(path) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute(
            "ALTER TABLE projects ADD COLUMN skill_profile "
            "TEXT NOT NULL DEFAULT 'standard'"
        )
        conn.execute(
            "INSERT INTO projects (id, title, created_at) "
            "VALUES ('proj_001', 'legacy', '2026-01-01T00:00:00Z')"
        )
        for intent_id, creator, worker, to_fact_id in (
            ("i_active", "reasoner", None, None),
            ("i_claimed", "reasoner", "worker-a", None),
            ("i_done", "reasoner", "worker-a", "f001"),
            ("i_bootstrap", "dispatcher.bootstrap", None, None),
        ):
            conn.execute(
                "INSERT INTO intents "
                "(id, project_id, description, creator, worker, to_fact_id, created_at) "
                "VALUES (?, 'proj_001', 'investigate', ?, ?, ?, '2026-01-01T00:00:01Z')",
                (intent_id, creator, worker, to_fact_id),
            )
        conn.execute(
            "INSERT INTO facts (id, project_id, description) "
            "VALUES ('f001', 'proj_001', 'fact')"
        )

    monkeypatch.setattr(db, "_db_path", None)
    db.configure(path)

    with db.get_conn() as conn:
        rows = {
            row["id"]: json.loads(row["capabilities"])
            for row in conn.execute("SELECT id, capabilities FROM intents")
        }
        project_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(projects)")
        }

    assert "skill_profile" not in project_columns
    assert rows["i_active"] == list(SECURITY_CAPABILITIES)
    assert rows["i_claimed"] == list(SECURITY_CAPABILITIES)
    assert rows["i_done"] == []
    assert rows["i_bootstrap"] == []
