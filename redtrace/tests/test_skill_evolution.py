from __future__ import annotations

import time
from pathlib import Path

import pytest

from redtrace.capabilities import CapabilityStore, SkillConflictError
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


def test_durable_queue_requires_measured_task_improvement(tmp_path: Path) -> None:
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
    rejected = next(event for event in store.read_skill_audit() if event.get("proposalId") == proposal_id)
    assert rejected["action"] == "evolution-rejected"
    assert store.get_skill("web-recon").version == 1


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
