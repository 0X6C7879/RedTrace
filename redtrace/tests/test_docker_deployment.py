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

    for service_name in ("redtrace-server", "redtrace-dispatcher"):
        volumes = services[service_name]["volumes"]
        assert any(
            "${REDTRACE_DISPATCH_CONFIG_FILE:-./dispatch.yaml}" in volume
            for volume in volumes
        )

    dispatcher = services["redtrace-dispatcher"]
    assert dispatcher["depends_on"]["redtrace-worker-image"]["condition"] == (
        "service_completed_successfully"
    )


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
