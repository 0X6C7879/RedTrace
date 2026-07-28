from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_local_deploy_script_is_self_contained_and_idempotent() -> None:
    script = (REPO_ROOT / "deploy-local.sh").read_text(encoding="utf-8")

    assert "D:\\AI\\ctf-skills" not in script
    assert "/ctf-skills/scripts" not in script
    assert 'case "$DISTRO_ID" in' in script
    assert "mirrors.aliyun.com/kali" in script
    assert "mirrors.aliyun.com/ubuntu" in script
    assert "registry.npmmirror.com" in script
    assert "mirrors.aliyun.com/pypi/simple" in script
    assert "dpkg-query -W" in script
    assert 'if has "$command"; then' in script
    assert "rtk gain" in script
    assert "@anthropic-ai/claude-code@latest" in script
    assert "@openai/codex@latest" in script
    assert "@earendil-works/pi-coding-agent@latest" in script
    assert "uv sync --frozen" in script
    assert "REDTRACE_LOCAL_PATH_PREPEND" in script
    assert "pid_is_running" in script
    assert "detected Windows WSL" in script
    assert "ensure_brave_search_skill" in script
    assert "set_common_env_secret" in script
    assert "test_brave_search_skill" in script
    assert "REDTRACE_SKIP_BRAVE_TEST" in script
    assert 'chmod 600 "$CONFIG_PATH"' in script


def test_macos_deploy_configures_and_tests_brave_search_securely() -> None:
    script = (REPO_ROOT / "deploy-macos.sh").read_text(encoding="utf-8")

    assert "ensure_brave_search_skill" in script
    assert "npm ci --prefix" in script
    assert "set_common_env_secret" in script
    assert "test_brave_search_skill" in script
    assert "REDTRACE_SKIP_BRAVE_TEST" in script
    assert "skipping optional Python and Ruby security tools" in script
    assert "start_launch_agents" in script
    assert "launchctl bootstrap" in script
    assert "KeepAlive" in script
    assert "DEFAULT_USE_LAUNCHD" in script
    assert "os.setsid()" in script
    assert 'chmod 600 "$CONFIG_PATH"' in script
