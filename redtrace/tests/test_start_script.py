from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "start-redtrace.sh"


def test_start_script_is_valid_bash() -> None:
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


def test_start_script_help_documents_both_components() -> None:
    result = subprocess.run(
        ["bash", str(SCRIPT), "--help"],
        check=True,
        capture_output=True,
        text=True,
    )

    assert "RedTrace Server and Dispatcher" in result.stdout
    assert "--config PATH" in result.stdout
    assert "Ctrl+C" in result.stdout
    assert "already listening" in result.stdout


def test_start_script_uses_portable_project_relative_defaults() -> None:
    script = SCRIPT.read_text(encoding="utf-8")

    assert '#!/usr/bin/env bash' in script
    assert 'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"' in script
    assert 'CONFIG_PATH="$SCRIPT_DIR/redtrace.yaml"' in script
    assert 'uv run --project "$PROJECT_DIR" redtrace serve' in script
    assert 'uv run --project "$PROJECT_DIR" redtrace dispatch' in script
    assert "launchctl" not in script
    assert "systemctl" not in script


def test_start_script_supervises_and_stops_both_components(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    state_dir = tmp_path / "state"
    fake_bin.mkdir()
    state_dir.mkdir()

    fake_uv = fake_bin / "uv"
    fake_uv.write_text(
        """#!/usr/bin/env bash
set -eu
case " $* " in
  *" redtrace serve "*)
    marker="$FAKE_REDTRACE_STATE/server"
    ;;
  *" redtrace dispatch "*)
    marker="$FAKE_REDTRACE_STATE/dispatcher"
    ;;
  *)
    exit 2
    ;;
esac
touch "$marker"
trap 'rm -f "$marker"; exit 0' TERM INT HUP
while :; do sleep 1; done
""",
        encoding="utf-8",
    )
    fake_uv.chmod(0o755)

    fake_curl = fake_bin / "curl"
    fake_curl.write_text(
        """#!/usr/bin/env bash
test -f "$FAKE_REDTRACE_STATE/server"
""",
        encoding="utf-8",
    )
    fake_curl.chmod(0o755)

    config = tmp_path / "redtrace.yaml"
    config.write_text("server: http://127.0.0.1:8000\nworkers: []\n", encoding="utf-8")
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}{os.pathsep}{environment['PATH']}",
            "FAKE_REDTRACE_STATE": str(state_dir),
            "REDTRACE_START_TIMEOUT": "5",
            "REDTRACE_SHUTDOWN_TIMEOUT": "2",
        }
    )

    process = subprocess.Popen(
        ["bash", str(SCRIPT), "--config", str(config)],
        cwd=REPO_ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if (state_dir / "server").exists() and (state_dir / "dispatcher").exists():
            break
        if process.poll() is not None:
            break
        time.sleep(0.05)

    assert process.poll() is None
    assert (state_dir / "server").exists()
    assert (state_dir / "dispatcher").exists()

    process.send_signal(signal.SIGTERM)
    output, _ = process.communicate(timeout=5)

    assert process.returncode == 143, output
    assert not (state_dir / "server").exists()
    assert not (state_dir / "dispatcher").exists()


def test_start_script_rebuilds_a_broken_project_environment(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    project = repo / "redtrace"
    broken_python = project / ".venv" / "bin" / "python3"
    fake_bin = tmp_path / "bin"
    state_dir = tmp_path / "state"
    broken_python.parent.mkdir(parents=True)
    fake_bin.mkdir()
    state_dir.mkdir()
    (repo / "start-redtrace.sh").write_text(
        SCRIPT.read_text(encoding="utf-8"), encoding="utf-8"
    )
    broken_python.write_bytes(b"")
    broken_python.chmod(0o755)
    (repo / "redtrace.yaml").write_text(
        "server: http://127.0.0.1:8000\nworkers: []\n", encoding="utf-8"
    )

    healthy_python = fake_bin / "python3"
    healthy_python.write_text(
        "#!/usr/bin/env bash\nprintf 'redtrace-python:3.13\\n'\n",
        encoding="utf-8",
    )
    healthy_python.chmod(0o755)

    fake_uv = fake_bin / "uv"
    fake_uv.write_text(
        """#!/usr/bin/env bash
set -eu
if [[ "$1" == "venv" ]]; then
  target="${@: -1}"
  mkdir -p "$target/bin"
  printf '#!/usr/bin/env bash\nprintf "redtrace-python:3.13\\n"\n' >"$target/bin/python3"
  chmod +x "$target/bin/python3"
  touch "$FAKE_REDTRACE_STATE/rebuilt"
  exit 0
fi
if [[ " $* " == *" redtrace dispatch "* ]]; then
  project=""
  previous=""
  for argument in "$@"; do
    if [[ "$previous" == "--project" ]]; then project="$argument"; fi
    previous="$argument"
  done
  "$project/.venv/bin/python3" -c 'import sys' || exit 2
  marker="$FAKE_REDTRACE_STATE/dispatcher"
  touch "$marker"
  trap 'rm -f "$marker"; exit 0' TERM INT HUP
  while :; do sleep 1; done
fi
exit 2
""",
        encoding="utf-8",
    )
    fake_uv.chmod(0o755)
    fake_curl = fake_bin / "curl"
    fake_curl.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    fake_curl.chmod(0o755)

    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}{os.pathsep}{environment['PATH']}",
            "FAKE_REDTRACE_STATE": str(state_dir),
            "REDTRACE_SHUTDOWN_TIMEOUT": "2",
        }
    )
    process = subprocess.Popen(
        ["bash", str(repo / "start-redtrace.sh")],
        cwd=repo,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if (state_dir / "rebuilt").exists() and (
            state_dir / "dispatcher"
        ).exists():
            break
        if process.poll() is not None:
            break
        time.sleep(0.05)

    try:
        assert process.poll() is None
        assert (state_dir / "rebuilt").exists()
        assert (state_dir / "dispatcher").exists()
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            process.communicate(timeout=5)
