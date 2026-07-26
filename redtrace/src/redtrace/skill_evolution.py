from __future__ import annotations

import json
import logging
import os
import re
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from redtrace.capabilities import (
    CapabilityStore,
    SkillConflictError,
    SkillRecord,
    _atomic_write,
    _frontmatter,
)

LOG = logging.getLogger(__name__)
TOKEN_PATTERN = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]{2,}", re.IGNORECASE)
NAME_LINE_PATTERN = re.compile(r"^(name:\s*).+$", re.MULTILINE)
DEFAULT_QUEUE_LIMIT = 128
DEFAULT_MATCH_THRESHOLD = 0.34
DEFAULT_DUPLICATE_RATIO = 0.08


@dataclass(frozen=True, slots=True)
class EvolutionDecision:
    proposal_id: str
    status: str
    reason: str
    skill: str | None = None
    version: int | None = None
    revision: str | None = None
    merged: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "proposalId": self.proposal_id,
            "status": self.status,
            "reason": self.reason,
            "skill": self.skill,
            "version": self.version,
            "revision": self.revision,
            "merged": list(self.merged),
        }


class SkillEvolutionEngine:
    """Durable, deterministic Skill evolution without additional model calls."""

    def __init__(self, store: CapabilityStore | None = None):
        self.store = store or CapabilityStore()
        self.inbox = self.store.skill_meta_dir / "inbox"
        self.queue_limit = _positive_env("REDTRACE_SKILL_QUEUE_LIMIT", DEFAULT_QUEUE_LIMIT)
        self.match_threshold = _float_env("REDTRACE_SKILL_MATCH_THRESHOLD", DEFAULT_MATCH_THRESHOLD)
        self.max_duplicate_ratio = _float_env(
            "REDTRACE_SKILL_MAX_DUPLICATE_RATIO",
            DEFAULT_DUPLICATE_RATIO,
        )

    def submit(self, proposal: dict[str, Any]) -> str:
        self.store.ensure()
        self.inbox.mkdir(parents=True, exist_ok=True)
        if len(list(self.inbox.glob("*.json"))) >= self.queue_limit:
            raise ValueError(f"Skill evolution queue is full ({self.queue_limit})")
        content = proposal.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("proposal content must be a complete SKILL.md")
        if len(content) > self.store.max_skill_chars:
            raise ValueError(f"proposal exceeds {self.store.max_skill_chars} characters")
        proposal_id = uuid.uuid4().hex
        payload = dict(proposal)
        payload["proposal_id"] = proposal_id
        _atomic_write(
            self.inbox / f"{proposal_id}.json",
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        )
        return proposal_id

    def pending_count(self) -> int:
        return len(list(self.inbox.glob("*.json"))) if self.inbox.is_dir() else 0

    def process_pending(self, limit: int = 8) -> int:
        processed = 0
        for path in sorted(self.inbox.glob("*.json"))[: max(1, limit)]:
            decision: EvolutionDecision
            proposal: dict[str, Any] = {}
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(loaded, dict):
                    raise ValueError("proposal root must be an object")
                proposal = loaded
                decision = self.evolve(proposal)
            except Exception as exc:
                proposal_id = str(proposal.get("proposal_id") or path.stem)
                decision = EvolutionDecision(proposal_id, "rejected", str(exc))
                LOG.warning("Skill evolution proposal rejected id=%s reason=%s", proposal_id, exc)
            self.store.record_skill_audit(
                {
                    "action": f"evolution-{decision.status}",
                    "actor": str(proposal.get("worker") or "worker"),
                    "proposalId": decision.proposal_id,
                    "skill": decision.skill,
                    "version": decision.version,
                    "revision": decision.revision,
                    "reason": decision.reason[:500],
                    "projectId": proposal.get("project_id"),
                    "intentId": proposal.get("intent_id"),
                    "taskType": proposal.get("task_type"),
                    "impact": proposal.get("impact"),
                    "validation": proposal.get("validation"),
                    "merged": list(decision.merged),
                }
            )
            path.unlink(missing_ok=True)
            processed += 1
        return processed

    def evolve(self, proposal: dict[str, Any]) -> EvolutionDecision:
        proposal_id = str(proposal.get("proposal_id") or uuid.uuid4().hex)
        proposed_name = str(proposal.get("proposed_name") or "").strip().lower()
        content = str(proposal.get("content") or "").rstrip() + "\n"
        summary = str(proposal.get("summary") or "").strip()
        validation = proposal.get("validation")
        impact = proposal.get("impact")
        self._validate_evidence(summary, validation, impact)
        self._validate_content(content)

        records = self.store.list_skills()
        target = self._select_target(proposal, proposed_name, content, records)
        if target is None:
            self._make_room(records)
            candidate_name = proposed_name
            if not candidate_name:
                raise ValueError("proposed_name is required for a new Skill")
            metadata = _frontmatter(content)
            if metadata.get("name", "").strip().lower() != candidate_name:
                raise ValueError("new Skill frontmatter name must match proposed_name")
            expected_revision = None
            action = "evolve-create"
        else:
            candidate_name = target.name
            content = _replace_frontmatter_name(content, candidate_name)
            self._validate_replacement(target, content)
            expected = proposal.get("expected_revision")
            if expected is not None and str(expected) != target.revision:
                raise SkillConflictError(
                    f"proposal is based on stale {candidate_name} revision {expected}; current is {target.revision}"
                )
            expected_revision = target.revision
            action = "evolve-update"

        actor = str(proposal.get("worker") or "worker")
        record = self.store.write_skill(
            candidate_name,
            content,
            enabled=True,
            expected_revision=expected_revision,
            actor=actor,
            reason=summary,
            action=action,
        )
        merged = self._merge_redundant_skills(record)
        return EvolutionDecision(
            proposal_id,
            "accepted",
            "validated improvement committed",
            skill=record.name,
            version=record.version,
            revision=record.revision,
            merged=tuple(merged),
        )

    def _validate_evidence(self, summary: str, validation: Any, impact: Any) -> None:
        if not summary or len(summary) > 500:
            raise ValueError("summary must contain 1-500 characters")
        if not isinstance(validation, list) or not validation or len(validation) > 8:
            raise ValueError("1-8 concrete validation results are required")
        if any(not isinstance(item, str) or not item.strip() or len(item) > 300 for item in validation):
            raise ValueError("validation results must be non-empty strings up to 300 characters")
        if not isinstance(impact, dict) or impact.get("task_succeeded") is not True:
            raise ValueError("a successful task is required before Skill evolution")
        metrics = (
            impact.get("tool_calls_saved", 0),
            impact.get("invalid_steps_avoided", 0),
            impact.get("duration_saved_ms", 0),
        )
        if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in metrics):
            raise ValueError("impact metrics must be non-negative integers")
        if not any(metrics):
            raise ValueError("proposal must measure saved tool calls, avoided steps, or saved duration")

    def _validate_content(self, content: str) -> None:
        if len(content) > self.store.max_skill_chars:
            raise ValueError(f"SKILL.md exceeds {self.store.max_skill_chars} characters")
        metadata = _frontmatter(content)
        if not metadata.get("name") or not metadata.get("description"):
            raise ValueError("Skill frontmatter must include name and description")
        duplicate_ratio = _duplicate_paragraph_ratio(content)
        if duplicate_ratio > self.max_duplicate_ratio:
            raise ValueError(f"duplicate paragraph ratio {duplicate_ratio:.3f} exceeds {self.max_duplicate_ratio:.3f}")

    def _validate_replacement(self, current: SkillRecord, candidate: str) -> None:
        if current.content == candidate:
            raise ValueError("proposal does not change the Skill")
        current_body = _normalized_body(current.content)
        candidate_body = _normalized_body(candidate)
        if current_body and candidate_body.startswith(current_body):
            raise ValueError("simple append-only evolution is forbidden; merge, replace, or compress the Skill")
        growth_budget = min(4096, max(512, int(len(current.content) * 0.10)))
        if len(candidate) > len(current.content) + growth_budget:
            raise ValueError(f"replacement grows by more than the {growth_budget}-character evolution budget")
        current_duplicates = _duplicate_paragraph_ratio(current.content)
        candidate_duplicates = _duplicate_paragraph_ratio(candidate)
        if candidate_duplicates > max(self.max_duplicate_ratio, current_duplicates):
            raise ValueError("replacement increases duplicate content")

    def _select_target(
        self,
        proposal: dict[str, Any],
        proposed_name: str,
        content: str,
        records: list[SkillRecord],
    ) -> SkillRecord | None:
        requested = str(proposal.get("target_skill") or "").strip().lower()
        if requested:
            for record in records:
                if record.name == requested:
                    return record
            raise ValueError(f"target Skill does not exist: {requested}")
        for record in records:
            if record.name == proposed_name:
                return record
        query = " ".join(
            [
                proposed_name,
                str(proposal.get("summary") or ""),
                _frontmatter(content).get("description", ""),
                _headings(content),
            ]
        )
        best: tuple[float, SkillRecord] | None = None
        for record in records:
            score = _skill_similarity(query, proposed_name, record)
            if best is None or score > best[0]:
                best = (score, record)
        return best[1] if best is not None and best[0] >= self.match_threshold else None

    def _make_room(self, records: list[SkillRecord]) -> None:
        if len(records) < self.store.max_skills:
            return
        disabled = sorted(
            (record for record in records if not record.enabled),
            key=lambda record: (record.updated_at or "", record.name),
        )
        if not disabled:
            raise ValueError(f"skill count limit reached ({self.store.max_skills})")
        victim = disabled[0]
        self.store.delete_skill(
            victim.name,
            actor="evolver",
            reason="retired disabled Skill to enforce count limit",
            action="retire",
        )

    def _merge_redundant_skills(self, target: SkillRecord) -> list[str]:
        merged: list[str] = []
        target_lines = _content_lines(target.content)
        if not target_lines:
            return merged
        for other in self.store.list_skills():
            if other.name == target.name:
                continue
            name_similarity = _containment(_tokens(target.name), _tokens(other.name))
            description_similarity = _containment(
                _tokens(target.description),
                _tokens(other.description),
            )
            covered = len(_content_lines(other.content) & target_lines) / max(1, len(_content_lines(other.content)))
            if max(name_similarity, description_similarity) >= 0.75 and covered >= 0.95:
                self.store.delete_skill(
                    other.name,
                    actor="evolver",
                    reason=f"redundant content merged into {target.name}",
                    action="merge-delete",
                )
                merged.append(other.name)
        return merged


class SkillEvolutionWorker:
    """One low-priority daemon drains durable proposals outside task execution."""

    def __init__(self, engine: SkillEvolutionEngine | None = None):
        self.engine = engine or SkillEvolutionEngine()
        self._event = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="redtrace-skill-evolution", daemon=True)
        self._thread.start()
        if self.engine.pending_count():
            self._event.set()

    def notify(self) -> None:
        self._event.set()

    def stop(self) -> None:
        self._stop.set()
        self._event.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            self._event.wait()
            self._event.clear()
            if self._stop.is_set():
                break
            while self.engine.process_pending() and not self._stop.is_set():
                pass


def _positive_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _float_env(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default
    return value if 0 <= value <= 1 else default


def _tokens(text: str) -> set[str]:
    return {token.lower() for token in TOKEN_PATTERN.findall(text) if len(token) > 1}


def _containment(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / min(len(left), len(right))


def _skill_similarity(query: str, proposed_name: str, record: SkillRecord) -> float:
    name_score = _containment(_tokens(proposed_name), _tokens(record.name))
    context_score = _containment(
        _tokens(query),
        _tokens(" ".join((record.name, record.description, _headings(record.content)))),
    )
    return (name_score * 0.65) + (context_score * 0.35)


def _headings(content: str) -> str:
    return " ".join(line.lstrip("#").strip() for line in content.splitlines() if line.startswith("#"))


def _normalized_body(content: str) -> str:
    parts = content.split("---", 2)
    body = parts[2] if len(parts) == 3 else content
    return "\n".join(line.rstrip() for line in body.strip().splitlines())


def _content_lines(content: str) -> set[str]:
    return {
        re.sub(r"\s+", " ", line).strip().lower()
        for line in _normalized_body(content).splitlines()
        if len(re.sub(r"\s+", " ", line).strip()) >= 24
    }


def _duplicate_paragraph_ratio(content: str) -> float:
    paragraphs = [
        re.sub(r"\s+", " ", paragraph).strip().lower()
        for paragraph in re.split(r"\n\s*\n", _normalized_body(content))
    ]
    paragraphs = [paragraph for paragraph in paragraphs if len(paragraph) >= 40]
    if not paragraphs:
        return 0.0
    return (len(paragraphs) - len(set(paragraphs))) / len(paragraphs)


def _replace_frontmatter_name(content: str, name: str) -> str:
    parts = content.split("---", 2)
    if len(parts) != 3:
        return content
    frontmatter = NAME_LINE_PATTERN.sub(rf"\g<1>{name}", parts[1], count=1)
    return f"---{frontmatter}---{parts[2]}"
