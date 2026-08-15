from __future__ import annotations

import json

from conftest import FakeContainerManager, make_intent, make_project
from redtrace.blackboard_cli import build_parser
from redtrace.board.models import Fact
from redtrace.dispatcher.prompting import (
    format_fact_ids,
    format_open_intents,
    load_prompt,
    render_prompt,
)
from redtrace.dispatcher.scheduler import project_policy
from redtrace.dispatcher.tasks import common


def _fact_descriptions(payload: dict) -> dict[str, str]:
    return {fact["id"]: fact["description"] for fact in payload["facts"]}


def test_reason_snapshot_preserves_fact_over_800_chars() -> None:
    project = make_project()
    project.facts[0].description = "x" * 5000

    payload = json.loads(project_policy.reason_graph_snapshot(project))

    assert payload["facts"][0]["description"] == "x" * 5000
    assert "truncated" not in json.dumps(payload)


def test_reason_snapshot_exceeds_64kib_without_loss() -> None:
    project = make_project()
    project.facts.extend(
        Fact(id=f"f{index:03}", description=f"bulk fact {index}: " + "x" * 5000)
        for index in range(100)
    )

    snapshot = project_policy.reason_graph_snapshot(project)
    payload = json.loads(snapshot)

    assert len(snapshot.encode()) > 64 * 1024
    assert _fact_descriptions(payload) == {
        fact.id: fact.description for fact in project.facts
    }
    assert [hint["id"] for hint in payload["hints"]] == [
        hint.id for hint in project.hints
    ]


def test_reason_snapshot_handles_1000_facts() -> None:
    project = make_project()
    project.facts.extend(
        Fact(id=f"f{index:04}", description=f"fact number {index} with full detail")
        for index in range(1000)
    )

    payload = json.loads(project_policy.reason_graph_snapshot(project))

    assert len(payload["facts"]) == len(project.facts)
    assert _fact_descriptions(payload) == {
        fact.id: fact.description for fact in project.facts
    }


def test_reason_snapshot_includes_completed_and_open_intents() -> None:
    completed = make_intent("i-completed")
    completed.to = "f002"
    open_intent = make_intent("i-open")
    open_intent.to = None
    project = make_project(intents=[completed, open_intent])

    payload = json.loads(project_policy.reason_graph_snapshot(project))

    by_id = {intent["id"]: intent for intent in payload["intents"]}
    assert set(by_id) == {"i-completed", "i-open"}
    # Concluded lineage is preserved, not dropped.
    assert by_id["i-completed"]["to"] == "f002"
    assert by_id["i-open"]["to"] is None


def test_write_graph_snapshot_reference_inlines_nothing() -> None:
    graph = "UNIQUE_GRAPH_MARKER_9f3a7c" + "x" * 5000
    manager = FakeContainerManager()

    reference = common.write_graph_snapshot_reference(
        manager, "container-proj", graph, phase="reason_execute"
    )

    assert graph not in reference
    assert any(graph == content for _, _, content in manager.writes)
    assert "redtrace-blackboard" in reference
    assert "有界" not in reference
    assert "截断" not in reference


def test_reason_prompt_contains_only_graph_file_reference() -> None:
    project = make_project()
    project.facts[0].description = "UNIQUE_GRAPH_MARKER_9f3a7c"
    snapshot = project_policy.reason_graph_snapshot(project)

    manager = FakeContainerManager()
    reference = common.write_graph_snapshot_reference(
        manager, "container-proj_001", snapshot, phase="reason_execute"
    )
    prompt = render_prompt(
        load_prompt("default", "reason.md"),
        {
            "graph_yaml": reference,
            "fact_ids": format_fact_ids(
                [fact.id for fact in project.facts if fact.id != "goal"]
            ),
            "open_intents": format_open_intents([]),
            "execution": "{}",
            "max_intents": "3",
        },
    )

    assert "UNIQUE_GRAPH_MARKER_9f3a7c" not in prompt
    assert reference in prompt


def test_blackboard_cli_query_subcommands_available() -> None:
    parser = build_parser()

    assert parser.parse_args(["snapshot"]).command == "snapshot"
    assert parser.parse_args(["changes"]).command == "changes"
    assert parser.parse_args(["node", "f001"]).command == "node"
    assert parser.parse_args(["context", "f001"]).command == "context"
    assert parser.parse_args(["source", "f001"]).command == "source"
    assert parser.parse_args(["path", "origin", "goal"]).command == "path"
