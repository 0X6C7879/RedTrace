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
            "${REDTRACE_CONFIG_FILE:-${REDTRACE_DISPATCH_CONFIG_FILE:-./redtrace.yaml}}"
            in volume
            for volume in volumes
        )

    dispatcher = services["redtrace-dispatcher"]
    assert dispatcher["depends_on"]["redtrace-worker-image"]["condition"] == "service_completed_successfully"


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
        (REPO_ROOT / "redtrace.container.example.yaml").read_text(encoding="utf-8")
    )

    assert config["runtime"]["execution"] == "container"
    assert config["container"]["image"] == "redtrace-worker-container:latest"
    assert config["container"]["network_mode"] == "redtrace-network"


def test_docker_context_excludes_host_virtual_environments_and_secrets() -> None:
    patterns = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()

    assert "**/.venv" in patterns
    assert ".redtrace-secrets" in patterns


def test_benchmark_image_installs_and_verifies_extended_offline_toolchain() -> None:
    dockerfile = (REPO_ROOT / "Dockerfile.benchmark").read_text(encoding="utf-8")
    installer = (REPO_ROOT / "container" / "install-benchmark-extras.sh").read_text(
        encoding="utf-8"
    )
    verifier = (REPO_ROOT / "container" / "verify-offline.sh").read_text(
        encoding="utf-8"
    )

    assert "bash /tmp/install-benchmark-extras.sh all" in dockerfile
    assert "GRYPE_DB_AUTO_UPDATE=false" in dockerfile
    assert 'CMD ["bash", "start.sh"]' in dockerfile
    for expected in (
        "semgrep",
        "gitleaks",
        "pwndbg",
        "pwninit",
        "uncompyle6",
        "pycdc",
        "wasm-tools",
        "ilspycmd",
        "promptmap2",
        "agent-threat-bench",
        "agentdojo",
        "cargo-build-sbf",
        "anchor",
        "sui",
        "aptos",
        "scarb",
        "snforge",
        "sncast",
        "starknet-devnet",
        "blueprint",
        "wasmd",
        "cosmwasm-check",
        "cargo-contract",
        "substrate-contracts-node",
    ):
        assert expected in installer
        assert expected in verifier

    for cache in (
        "wheelhouse",
        "pnpm-store",
        "cargo",
        "go",
        "maven",
        "gradle",
        "solidity-libs",
        "grype-db",
    ):
        assert cache in installer


def test_hosted_export_script_flattens_tests_and_enforces_upload_limit() -> None:
    script = (REPO_ROOT / "build-benchmark-image.ps1").read_text(encoding="utf-8")

    assert "docker export" in script
    assert '$ImportArgs = @("import")' in script
    assert "docker @ImportArgs" in script
    assert "docker run --rm --network none" in script
    assert "docker save --output" in script
    assert "gzip -9" in script
    assert "$Size -gt 3GB" in script
