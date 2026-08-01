from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from redtrace.capabilities import (
    MANIFEST_PATH,
    CapabilityStore,
    SkillConflictError,
    workspace_payload,
)
from redtrace.skill_evolution import (
    NativeSkillAuthor,
    SkillEvolutionEngine,
    SkillEvolutionWorker,
)


def _skill(name: str, description: str, guidance: str) -> str:
    return f"""---
name: {name}
description: {description}
---

# {name}

## Workflow

{guidance}
"""


def _proposal(name: str, content: str, *, target: str | None = None, revision: str | None = None) -> dict:
    return {
        "proposal_id": "proposal-1",
        "proposed_name": name,
        "target_skill": target,
        "content": content,
        "summary": "Validated a shorter workflow that avoids one redundant probe.",
        "validation": ["The successful task reached the same confirmed fact with one fewer tool call."],
        "impact": {
            "task_succeeded": True,
            "tool_calls_saved": 1,
            "invalid_steps_avoided": 0,
            "duration_saved_ms": 0,
        },
        "worker": "codex-1",
        "expected_revision": revision,
    }


def _complete_skill(name: str, workflow: str = "Run a bounded probe, then verify the result.") -> str:
    return f"""---
name: {name}
description: Reusable web verification workflow. Use for bounded web vulnerability validation.
---

# {name}

## Trigger conditions

Use when a web behavior needs a bounded, reproducible check.

## Applicability and scope

Apply only to authorized targets with an available HTTP client.

## Workflow

{workflow}

## Validation standard

Require a repeatable response difference and preserve a bounded evidence reference.

## Failure handling

Stop after an inconclusive bounded retry and record the failed boundary.

## Safety boundaries

Stay within authorization and avoid destructive requests.
"""


def _feedback(
    *,
    name: str = "web-verification",
    target: str | None = None,
    evolution_type: str = "CAPTURE",
    project: str = "project-a",
    intent: str = "intent-a",
) -> dict:
    return {
        "evolution_type": evolution_type,
        "proposed_name": name,
        "target_skill": target,
        "summary": "A bounded response comparison reliably removes an unnecessary probe.",
        "applicability": "Authorized web validation with an HTTP client.",
        "procedure": [
            "Send one bounded baseline request.",
            "Change one input and compare the relevant response property.",
        ],
        "validation": [
            "The changed input reproduced the same response difference twice."
        ],
        "evidence_refs": ["context:ev-1"],
        "impact": {
            "task_succeeded": False,
            "step_verified": True,
            "tool_calls_saved": 0,
            "invalid_steps_avoided": 1,
            "duration_saved_ms": 0,
        },
        "project_id": project,
        "intent_id": intent,
        "worker": "codex-1",
    }


class _Author:
    def __init__(self, content: str):
        self.content = content
        self.calls = 0

    def author(self, proposal, target, related) -> str:
        self.calls += 1
        return self.content


def test_version_conflict_and_rollback_are_audited(tmp_path: Path) -> None:
    store = CapabilityStore(tmp_path)
    first = store.write_skill("web-recon", _skill("web-recon", "Focused web recon.", "Probe A, then verify B."))
    second = store.write_skill(
        "web-recon",
        _skill("web-recon", "Focused web recon.", "Verify B first; probe A only when needed."),
        expected_revision=first.revision,
        actor="test-worker",
        reason="one fewer probe",
    )

    assert second.version == 2
    assert [item["version"] for item in store.list_skill_versions("web-recon")] == [2, 1]
    with pytest.raises(SkillConflictError):
        store.write_skill(
            "web-recon",
            _skill("web-recon", "Focused web recon.", "stale"),
            expected_revision=first.revision,
        )

    rolled_back = store.rollback_skill("web-recon", 1, expected_revision=second.revision)
    assert rolled_back.version == 3
    assert rolled_back.content == first.content
    assert any(event["action"] == "rollback" for event in store.read_skill_audit())


def test_out_of_band_entrypoint_change_loses_trust_until_imported(
    tmp_path: Path,
) -> None:
    store = CapabilityStore(tmp_path)
    original = store.write_skill(
        "web-recon",
        _skill("web-recon", "Focused web recon.", "Probe, then verify."),
        trust="trusted",
        successful_reuses=3,
    )
    entrypoint = tmp_path / "skills" / "web-recon" / "SKILL.md"
    entrypoint.write_text(
        _skill("web-recon", "Focused web recon.", "Verify before probing."),
        encoding="utf-8",
    )

    drifted = store.get_skill("web-recon")

    assert drifted.revision != original.revision
    assert drifted.trust == "provisional"
    assert drifted.successful_reuses == 0
    assert drifted.provisional_task == "out-of-band"


def test_evolution_prefers_matching_skill_and_rejects_append_only_growth(tmp_path: Path) -> None:
    store = CapabilityStore(tmp_path)
    current = store.write_skill(
        "web-recon",
        _skill(
            "web-recon",
            "Focused web reconnaissance.",
            "Start with a bounded HTTP probe. Verify useful findings before deeper enumeration.",
        ),
    )
    engine = SkillEvolutionEngine(store)
    replacement = _skill(
        "web-recon-advanced",
        "Focused web reconnaissance with verified branching.",
        "Run one bounded HTTP probe. Continue only from a verified, actionable response.",
    )

    decision = engine.evolve(
        _proposal("web-recon-advanced", replacement, revision=current.revision)
    )

    assert decision.status == "accepted"
    assert decision.skill == "web-recon"
    assert [skill.name for skill in store.list_skills()] == ["web-recon"]
    assert store.get_skill("web-recon").version == 2
    assert "name: web-recon\n" in store.get_skill("web-recon").content

    append_only = store.get_skill("web-recon").content.rstrip() + "\n\nExtra unmerged advice.\n"
    with pytest.raises(ValueError, match="append-only"):
        engine.evolve(
            _proposal(
                "web-recon",
                append_only,
                target="web-recon",
                revision=store.get_skill("web-recon").revision,
            )
        )


def test_durable_queue_never_authors_zero_impact_feedback(tmp_path: Path) -> None:
    store = CapabilityStore(tmp_path)
    store.write_skill("web-recon", _skill("web-recon", "Focused web recon.", "Probe, then verify."))
    engine = SkillEvolutionEngine(store)
    proposal = _proposal(
        "web-recon",
        _skill("web-recon", "Focused web recon.", "Verify first; probe only when needed."),
        target="web-recon",
    )
    proposal["impact"] = {
        "task_succeeded": True,
        "tool_calls_saved": 0,
        "invalid_steps_avoided": 0,
        "duration_saved_ms": 0,
    }
    proposal_id = engine.submit(proposal)

    assert engine.process_pending() == 1
    assert engine.pending_count() == 0
    assert engine.deferred_count() == 1

    for intent in ("intent-b", "intent-c", "intent-d"):
        repeated = dict(proposal)
        repeated["intent_id"] = intent
        assert engine.submit(repeated) == proposal_id

    assert engine.pending_count() == 0
    assert engine.deferred_count() == 1
    assert store.get_skill("web-recon").version == 1
    assert not any(
        event.get("proposalId") == proposal_id
        and event.get("action") == "evolution-accepted"
        for event in store.read_skill_audit()
    )


def test_deferred_candidate_is_explainable_and_discardable(tmp_path: Path) -> None:
    engine = SkillEvolutionEngine(CapabilityStore(tmp_path))
    proposal = _proposal(
        "web-recon",
        _skill("web-recon", "Focused web recon.", "Verify before probing."),
        target="web-recon",
    )
    proposal["impact"] = {
        "task_succeeded": True,
        "tool_calls_saved": 0,
        "invalid_steps_avoided": 0,
        "duration_saved_ms": 0,
    }
    proposal_id = engine.submit(proposal)
    assert engine.process_pending() == 1

    items = engine.deferred_items()

    assert items[0]["proposalId"] == proposal_id
    assert items[0]["evidenceTier"] == "unmeasured"
    assert items[0]["requirementsMet"] == 2
    assert items[0]["requirementsTotal"] == 5
    assert items[0]["verificationStatus"] == "queued"
    assert "空闲 Worker" in items[0]["verificationLabel"]
    assert engine.discard_deferred(proposal_id) is True
    assert engine.deferred_count() == 0
    assert engine.discard_deferred(proposal_id) is False
    assert any(
        event.get("action") == "evolution-discarded"
        and event.get("proposalId") == proposal_id
        for event in engine.store.read_skill_audit()
    )


def test_autonomous_worker_evidence_requeues_deferred_candidate(
    tmp_path: Path,
) -> None:
    store = CapabilityStore(tmp_path)
    store.write_skill(
        "web-recon",
        _skill("web-recon", "Focused web recon.", "Probe, then verify."),
    )
    engine = SkillEvolutionEngine(store)
    proposal = _proposal(
        "web-recon",
        _skill(
            "web-recon",
            "Focused web recon.",
            "Verify first; probe only when needed.",
        ),
        target="web-recon",
        revision=store.get_skill("web-recon").revision,
    )
    proposal["impact"] = {
        "task_succeeded": True,
        "tool_calls_saved": 0,
        "invalid_steps_avoided": 0,
        "duration_saved_ms": 0,
    }
    proposal_id = engine.submit(proposal)
    assert engine.process_pending() == 1

    claimed = engine.claim_deferred_verification("codex-idle")
    assert claimed is not None
    assert claimed["verification"]["status"] == "running"

    ready = engine.apply_autonomous_verification(
        proposal_id,
        "codex-idle",
        {
            "validation": "Independent reuse reached the same verified result.",
            "metric": "tool_calls_saved",
            "metric_value": 1,
        },
    )

    assert ready is True
    assert engine.deferred_count() == 0
    assert engine.pending_count() == 1
    assert engine.process_pending(proposal_id=proposal_id) == 1
    assert engine.decision_for(proposal_id)["status"] == "accepted"
    assert store.get_skill("web-recon").version == 2


def test_failed_autonomous_author_is_deferred_for_another_worker(
    tmp_path: Path,
) -> None:
    author = _Author("---\nname: web-verification\n---\n\n# Incomplete\n")
    engine = SkillEvolutionEngine(CapabilityStore(tmp_path), author=author)
    proposal = _feedback()
    proposal.update(
        {
            "proposal_id": "proposal-ai",
            "occurrences": 3,
            "source_tasks": ["project-a:intent-a", "ai-verification:proposal-ai:1"],
            "verification": {
                "status": "running",
                "worker": "Pi",
                "attempts": 1,
                "failed_workers": [],
            },
        }
    )
    engine.inbox.mkdir(parents=True)
    (engine.inbox / "proposal-ai.json").write_text(
        json.dumps(proposal),
        encoding="utf-8",
    )

    assert engine.process_pending(proposal_id="proposal-ai") == 1
    assert engine.deferred_count() == 1
    assert engine.decision_for("proposal-ai")["status"] == "deferred"
    assert engine.claim_deferred_verification("Pi") is None
    claimed = engine.claim_deferred_verification("Claude")
    assert claimed is not None
    assert claimed["verification"]["worker"] == "Claude"
    assert claimed["verification"]["failed_workers"] == ["Pi"]


def test_background_worker_drains_proposals_without_blocking_submit(tmp_path: Path) -> None:
    store = CapabilityStore(tmp_path)
    current = store.write_skill(
        "web-recon",
        _skill("web-recon", "Focused web recon.", "Probe broadly, then verify every response."),
    )
    engine = SkillEvolutionEngine(store)
    worker = SkillEvolutionWorker(engine)
    worker.start()
    try:
        proposal_id = engine.submit(
            _proposal(
                "web-recon",
                _skill("web-recon", "Focused web recon.", "Probe once, then follow only verified responses."),
                target="web-recon",
                revision=current.revision,
            )
        )
        worker.notify()
        deadline = time.monotonic() + 2
        while engine.pending_count() and time.monotonic() < deadline:
            time.sleep(0.01)
    finally:
        worker.stop()

    assert engine.pending_count() == 0
    accepted = next(event for event in store.read_skill_audit() if event.get("proposalId") == proposal_id)
    assert accepted["action"] == "evolution-accepted"
    assert store.get_skill("web-recon").version == 2


def test_verified_partial_subflow_creates_provisional_skill_in_background(
    tmp_path: Path,
) -> None:
    store = CapabilityStore(tmp_path)
    author = _Author(_complete_skill("web-verification"))
    engine = SkillEvolutionEngine(store, author=author)

    decision = engine.evolve(_feedback())

    assert decision.status == "accepted"
    assert decision.trust == "provisional"
    assert author.calls == 1
    record = store.get_skill("web-verification")
    assert record.trust == "provisional"
    assert record.provisional_task == "project-a:intent-a"


def test_matching_existing_skill_is_updated_instead_of_duplicated(
    tmp_path: Path,
) -> None:
    store = CapabilityStore(tmp_path)
    current = store.write_skill(
        "web-recon",
        _complete_skill("web-recon", "Run two broad probes, then verify."),
    )
    author = _Author(
        _complete_skill(
            "web-recon-fast",
            "Run one bounded probe and continue only from a verified response.",
        )
    )
    engine = SkillEvolutionEngine(store, author=author)
    feedback = _feedback(name="web-recon-fast", evolution_type="IMPROVE")
    feedback["summary"] = "Web recon uses one bounded verified probe."
    feedback["expected_revision"] = current.revision

    decision = engine.evolve(feedback)

    assert decision.skill == "web-recon"
    assert [record.name for record in store.list_skills()] == ["web-recon"]
    assert "name: web-recon\n" in store.get_skill("web-recon").content


def test_duplicate_feedback_is_coalesced_before_authoring(tmp_path: Path) -> None:
    engine = SkillEvolutionEngine(
        CapabilityStore(tmp_path),
        author=_Author(_complete_skill("web-verification")),
    )

    first = engine.submit(_feedback())
    second = engine.submit(_feedback(intent="intent-b"))

    assert second == first
    assert engine.pending_count() == 1
    queued = next(engine.inbox.glob("*.json")).read_text(encoding="utf-8")
    assert '"occurrences":2' in queued


def test_deferred_feedback_accumulates_and_requeues(tmp_path: Path) -> None:
    author = _Author(_complete_skill("web-verification"))
    engine = SkillEvolutionEngine(CapabilityStore(tmp_path), author=author)
    feedback = _feedback()
    feedback["procedure"] = []

    proposal_id = engine.submit(feedback)
    assert engine.process_pending() == 1
    assert engine.deferred_count() == 1

    assert engine.submit(_feedback(intent="intent-b") | {"procedure": []}) == proposal_id
    assert engine.deferred_count() == 1
    assert engine.pending_count() == 0

    assert engine.submit(_feedback(intent="intent-c") | {"procedure": []}) == proposal_id
    assert engine.deferred_count() == 0
    assert engine.pending_count() == 1
    assert engine.process_pending() == 1
    assert author.calls == 1
    event = next(
        item
        for item in engine.store.read_skill_audit()
        if item.get("proposalId") == proposal_id
    )
    assert event["action"] == "evolution-accepted"


def test_source_task_is_a_bounded_evidence_reference(tmp_path: Path) -> None:
    author = _Author(_complete_skill("web-verification"))
    engine = SkillEvolutionEngine(CapabilityStore(tmp_path), author=author)
    feedback = _feedback()
    feedback["evidence_refs"] = []

    decision = engine.evolve(feedback)

    assert decision.status == "accepted"
    assert author.calls == 1


def test_ready_deferred_feedback_is_restored_on_startup(tmp_path: Path) -> None:
    engine = SkillEvolutionEngine(CapabilityStore(tmp_path))
    proposal_id = engine.submit(_feedback())
    queued = engine.inbox / f"{proposal_id}.json"
    engine.deferred.mkdir(parents=True)
    queued.replace(engine.deferred / queued.name)

    assert engine.restore_ready_deferred() == 1
    assert engine.pending_count() == 1
    assert engine.deferred_count() == 0


def test_native_author_prefers_source_worker_and_falls_back(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    author = NativeSkillAuthor(tmp_path)
    workers = {
        "claude": SimpleNamespace(name="Claude", api_configured=lambda: True),
        "pi": SimpleNamespace(name="Pi", api_configured=lambda: True),
    }
    monkeypatch.setattr(author, "_configured_worker", workers.get)
    monkeypatch.setattr(
        "redtrace.skill_evolution.shutil.which",
        lambda tool: None if tool == "nice" else f"/bin/{tool}",
    )

    assert author._select_tools({"worker": "Pi"})[:2] == ["pi", "claude"]

    calls: list[str] = []
    monkeypatch.setattr(author, "_select_tools", lambda proposal: ["pi", "claude"])
    monkeypatch.setattr(author, "_configured_worker", lambda tool: None)
    monkeypatch.setattr(author, "_prompt", lambda proposal, target, related: "prompt")
    monkeypatch.setattr(author, "_command", lambda tool, prompt, worker: [tool])

    def run(command, **kwargs):
        calls.append(command[0])
        if command[0] == "pi":
            raise subprocess.TimeoutExpired(command, kwargs["timeout"])
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=_complete_skill("web-verification"),
            stderr="",
        )

    monkeypatch.setattr("redtrace.skill_evolution.subprocess.run", run)

    content = author.author(_feedback(), None, [])

    assert calls == ["pi", "claude"]
    assert content.startswith("---\nname: web-verification")


def test_reserved_worker_returns_structured_autonomous_verification(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = SimpleNamespace(
        name="codex-idle",
        type="codex",
        env={},
        api_configured=lambda: False,
    )
    author = NativeSkillAuthor(tmp_path, preferred_worker=worker)
    monkeypatch.setattr(
        "redtrace.skill_evolution.shutil.which",
        lambda tool: None if tool == "nice" else f"/bin/{tool}",
    )
    monkeypatch.setattr(author, "_command", lambda *args: ["codex"])
    payload = {
        "verified": True,
        "validation": "The evidence confirms one reusable shortcut.",
        "metric": "invalid_steps_avoided",
        "metric_value": 2,
    }
    stdout = json.dumps(
        {
            "item": {
                "type": "agent_message",
                "text": json.dumps(payload),
            }
        }
    )
    monkeypatch.setattr(
        "redtrace.skill_evolution.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args[0], 0, stdout=stdout, stderr=""
        ),
    )

    assert author.verify(_feedback(), {"facts": []}) == {
        "validation": payload["validation"],
        "metric": "invalid_steps_avoided",
        "metric_value": 2,
    }


def test_reserved_author_repairs_incomplete_draft_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = SimpleNamespace(
        name="claude-idle",
        type="claudecode",
        env={},
        api_configured=lambda: False,
    )
    author = NativeSkillAuthor(tmp_path, preferred_worker=worker)
    monkeypatch.setattr(
        "redtrace.skill_evolution.shutil.which",
        lambda tool: None if tool == "nice" else f"/bin/{tool}",
    )
    monkeypatch.setattr(author, "_command", lambda *args: ["claude"])
    outputs = iter(
        [
            "---\nname: web-verification\ndescription: Verify web behavior.\n---\n\n# Draft\n",
            _complete_skill("web-verification"),
        ]
    )
    calls = 0

    def run(*args, **kwargs):
        nonlocal calls
        calls += 1
        return subprocess.CompletedProcess(
            args[0], 0, stdout=next(outputs), stderr=""
        )

    monkeypatch.setattr("redtrace.skill_evolution.subprocess.run", run)

    content = author.author(_feedback(), None, [])

    assert calls == 2
    assert "## Safety boundaries" in content


def test_independent_reuse_promotes_provisional_skill_to_trusted(
    tmp_path: Path,
) -> None:
    store = CapabilityStore(tmp_path)
    engine = SkillEvolutionEngine(
        store,
        author=_Author(_complete_skill("web-verification")),
    )
    engine.evolve(_feedback())
    provisional_digest, provisional_files = workspace_payload(store)
    provisional_manifest = json.loads(
        provisional_files[MANIFEST_PATH].decode()
    )
    assert provisional_manifest["skillTrust"]["web-verification"] == "provisional"
    reuse = _feedback(
        target="web-verification",
        evolution_type="IMPROVE",
        project="project-b",
        intent="intent-b",
    )
    reuse["reuse_validated"] = True

    decision = engine.evolve(reuse)

    assert decision.trust == "trusted"
    record = store.get_skill("web-verification")
    assert record.trust == "trusted"
    assert record.successful_reuses == 1
    trusted_digest, trusted_files = workspace_payload(store)
    trusted_manifest = json.loads(trusted_files[MANIFEST_PATH].decode())
    assert trusted_manifest["skillTrust"]["web-verification"] == "trusted"
    assert trusted_digest != provisional_digest


def test_same_project_reuse_cannot_self_promote_provisional_revision(
    tmp_path: Path,
) -> None:
    store = CapabilityStore(tmp_path)
    engine = SkillEvolutionEngine(
        store,
        author=_Author(_complete_skill("web-verification")),
    )
    engine.evolve(_feedback(project="project-a", intent="intent-a"))
    reuse = _feedback(
        target="web-verification",
        evolution_type="IMPROVE",
        project="project-a",
        intent="intent-b",
    )
    reuse["reuse_validated"] = True

    with pytest.raises(ValueError, match="independent project"):
        engine.evolve(reuse)


def test_each_content_revision_restarts_provisional_validation(
    tmp_path: Path,
) -> None:
    store = CapabilityStore(tmp_path)
    current = store.write_skill(
        "web-verification",
        _complete_skill("web-verification"),
        trust="trusted",
        successful_reuses=4,
    )
    proposal = _proposal(
        "web-verification",
        _complete_skill(
            "web-verification",
            "Run one bounded probe, verify it twice, then stop.",
        ),
        target="web-verification",
        revision=current.revision,
    )
    proposal["project_id"] = "project-b"
    proposal["intent_id"] = "intent-b"

    decision = SkillEvolutionEngine(store).evolve(proposal)

    assert decision.trust == "provisional"
    updated = store.get_skill("web-verification")
    assert updated.successful_reuses == 0
    assert updated.provisional_task == "project-b:intent-b"


def test_feedback_with_target_specific_data_is_rejected_before_queue(
    tmp_path: Path,
) -> None:
    engine = SkillEvolutionEngine(CapabilityStore(tmp_path))
    feedback = _feedback()
    feedback["summary"] = "The workflow worked against https://private.example/path."

    with pytest.raises(ValueError, match="target- or task-specific"):
        engine.submit(feedback)


def test_retire_disables_skill_and_preserves_history(tmp_path: Path) -> None:
    store = CapabilityStore(tmp_path)
    current = store.write_skill(
        "web-verification",
        _complete_skill("web-verification"),
    )
    engine = SkillEvolutionEngine(store)
    feedback = _feedback(
        target="web-verification",
        evolution_type="RETIRE",
    )
    feedback["expected_revision"] = current.revision

    decision = engine.evolve(feedback)

    assert decision.trust == "retired"
    retired = store.get_skill("web-verification")
    assert retired.enabled is False
    assert retired.trust == "retired"
    assert len(store.list_skill_versions("web-verification")) >= 2


def test_repeated_verified_fix_failures_lower_trust_then_disable(
    tmp_path: Path,
) -> None:
    store = CapabilityStore(tmp_path)
    store.write_skill(
        "web-verification",
        _complete_skill("web-verification"),
    )
    invalid_author = _Author(
        _skill(
            "web-verification",
            "Incomplete replacement.",
            "This omits the required safety and validation sections.",
        )
    )
    engine = SkillEvolutionEngine(store, author=invalid_author)
    feedback = _feedback(
        target="web-verification",
        evolution_type="FIX",
    )

    for _ in range(engine.failure_limit):
        engine.submit(feedback)
        assert engine.process_pending() == 1

    record = store.get_skill("web-verification")
    assert record.failure_count == engine.failure_limit
    assert record.trust == "retired"
    assert record.enabled is False
