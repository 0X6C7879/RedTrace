from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from redtrace.capabilities import (
    MANIFEST_PATH,
    CapabilityStore,
    SkillConflictError,
    workspace_payload,
)
from redtrace.skill_evolution import SkillEvolutionEngine, SkillEvolutionWorker


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


def test_durable_queue_accepts_verified_task_with_zero_metrics(tmp_path: Path) -> None:
    """Relaxed validation: task_succeeded=True with valid metrics is accepted."""
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

    assert engine.pending_count() == 1
    assert engine.process_pending() == 1
    assert engine.pending_count() == 0
    accepted = next(event for event in store.read_skill_audit() if event.get("proposalId") == proposal_id)
    assert accepted["action"] == "evolution-accepted"
    assert store.get_skill("web-recon").version == 2


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
