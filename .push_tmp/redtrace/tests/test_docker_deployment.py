from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_compose_builds_local_kali_worker_on_portable_bridge() -> None:
    compose = yaml.safe_load(
        (REPO_ROOT / "docker-compose.yaml").read_text(encoding="utf-8")
    )
    services = compose["services"]

    worker = services["redtrace-worker-image"]
    assert worker["build"]["context"] == "./container"
    assert worker["image"] == "redtrace-worker-container:latest"
    assert compose["networks"]["default"]["name"] == "redtrace-network"

    reverse_init = services["redtrace-route-skills-init"]
    assert reverse_init["image"] == worker["image"]
    assert reverse_init["depends_on"]["redtrace-worker-image"]["condition"] == (
        "service_completed_successfully"
    )
    assert reverse_init["command"] == [
        "bash",
        "/opt/redtrace/claude-plugin/skills/route-skills/redtrace-tools/initialize.sh",
    ]
    assert "./skills:/opt/redtrace/claude-plugin/skills" in reverse_init["volumes"]

    for service_name in ("redtrace-server", "redtrace-dispatcher"):
        volumes = services[service_name]["volumes"]
        assert any(
            "${REDTRACE_DISPATCH_CONFIG_FILE:-./dispatch.yaml}" in volume
            for volume in volumes
        )
        assert services[service_name]["depends_on"]["redtrace-route-skills-init"][
            "condition"
        ] == "service_completed_successfully"

    dispatcher = services["redtrace-dispatcher"]
    assert "redtrace-worker-image" not in dispatcher["depends_on"]


def test_dockerfiles_are_kali_based_and_architecture_neutral() -> None:
    app_dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
    worker_dockerfile = (REPO_ROOT / "container" / "Dockerfile").read_text(
        encoding="utf-8"
    )

    assert app_dockerfile.startswith("FROM kalilinux/kali-rolling:latest")
    assert worker_dockerfile.startswith("FROM kalilinux/kali-rolling:latest")
    assert "ARG TARGETARCH" in worker_dockerfile
    assert "amd64|arm64" in worker_dockerfile
    assert "FROM --platform=" not in app_dockerfile
    assert "FROM --platform=" not in worker_dockerfile

    assert "@openai/codex" not in app_dockerfile
    assert "@anthropic-ai/claude-code" not in app_dockerfile
    assert "pi-coding-agent" not in app_dockerfile
    assert "ARG CODEX_VERSION=0.146.0" in worker_dockerfile
    assert "ARG CLAUDE_CODE_VERSION=2.1.220" in worker_dockerfile
    assert "ARG PI_CODING_AGENT_VERSION=0.83.0" in worker_dockerfile
    assert "ARG PLAYWRIGHT_CLI_VERSION=0.1.17" in worker_dockerfile
    assert "@earendil-works/pi-coding-agent" in worker_dockerfile
    assert "@mariozechner/pi-coding-agent" not in worker_dockerfile


def test_shipped_docker_config_uses_local_image_and_named_network() -> None:
    config = yaml.safe_load(
        (REPO_ROOT / "dispatch.example.yaml").read_text(encoding="utf-8")
    )

    assert config["runtime"]["execution"] == "container"
    assert config["container"]["image"] == "redtrace-worker-container:latest"
    assert config["container"]["network_mode"] == "redtrace-network"


def test_docker_context_excludes_host_virtual_environments_and_secrets() -> None:
    patterns = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()

    assert "**/.venv" in patterns
    assert ".redtrace-secrets" in patterns
