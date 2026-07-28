from __future__ import annotations

import logging
import os
import signal
import shutil
import subprocess
import threading
from contextlib import suppress
from collections.abc import Callable

from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.runtime.stream_buffer import (
    BoundedLineEmitter,
    BoundedTextBuffer,
)

LOG = logging.getLogger(__name__)

STREAM_JOIN_TIMEOUT_SECONDS = 30.0
FORCE_KILL_REAP_TIMEOUT_SECONDS = 10.0
OutputHandler = Callable[[str, str], None]


class LocalProcess:
    """Runs a worker command as a host subprocess.

    Mirrors the container ManagedProcess surface (start/communicate/kill/cancel) but
    executes on the dispatcher host: its own process group so children are killed as a
    group, a Python-enforced timeout instead of the ``timeout`` coreutil, and a
    SIGTERM -> grace -> SIGKILL shutdown so the CLI can flush its session before dying.
    """

    def __init__(
        self,
        command: list[str],
        cwd: str,
        env: dict[str, str],
        timeout_seconds: int | None = None,
        term_grace_seconds: int = 30,
        max_output_chars: int = 32 * 1024 * 1024,
    ):
        self.command = command
        self.env = env
        self._cwd = cwd
        self._timeout_seconds = timeout_seconds
        self._term_grace = max(1.0, float(term_grace_seconds))
        self._process: subprocess.Popen[str] | None = None
        self._stdout = BoundedTextBuffer(max_output_chars)
        self._stderr = BoundedTextBuffer(max_output_chars)
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._timed_out = False
        self._cancel_reason: str | None = None
        self._kill_lock = threading.Lock()
        self._on_output: OutputHandler | None = None

    def set_output_handler(self, handler: OutputHandler | None) -> None:
        self._on_output = handler

    def start(self) -> None:
        command = self._platform_command()
        popen_options: dict[str, object] = {}
        if os.name == "nt":
            popen_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_options["start_new_session"] = True
        try:
            self._process = subprocess.Popen(
                command,
                cwd=self._cwd,
                env=self.env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                **popen_options,
            )
        except FileNotFoundError as exc:
            executable = self.command[0] if self.command else "<empty>"
            raise RuntimeError(
                f"local Worker executable was not found: {executable}"
            ) from exc
        except OSError as exc:
            executable = self.command[0] if self.command else "<empty>"
            raise RuntimeError(
                f"failed to start local Worker executable {executable}: {exc}"
            ) from exc
        self._stdout_thread = threading.Thread(
            target=self._drain,
            args=("stdout", self._process.stdout, self._stdout),
            daemon=True,
        )
        self._stderr_thread = threading.Thread(
            target=self._drain,
            args=("stderr", self._process.stderr, self._stderr),
            daemon=True,
        )
        self._stdout_thread.start()
        self._stderr_thread.start()

    def _platform_command(self) -> list[str]:
        if os.name != "nt" or not self.command:
            return self.command
        executable = shutil.which(
            self.command[0],
            path=self.env.get("PATH"),
        )
        if executable is None:
            return self.command
        if os.path.splitext(executable)[1].lower() not in {".bat", ".cmd"}:
            return [executable, *self.command[1:]]
        powershell_shim = os.path.splitext(executable)[0] + ".ps1"
        if os.path.isfile(powershell_shim):
            powershell = (
                shutil.which("pwsh.exe", path=self.env.get("PATH"))
                or shutil.which("powershell.exe", path=self.env.get("PATH"))
                or "powershell.exe"
            )
            return [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                powershell_shim,
                *self.command[1:],
            ]
        comspec = self.env.get("COMSPEC") or os.environ.get("COMSPEC", "cmd.exe")
        invocation = subprocess.list2cmdline([executable, *self.command[1:]])
        return [comspec, "/d", "/s", "/c", invocation]

    def communicate(self, timeout: float | None) -> ProcessResult:
        assert self._process is not None
        wait_for = float(self._timeout_seconds) if self._timeout_seconds is not None else timeout
        try:
            self._process.wait(timeout=wait_for)
        except subprocess.TimeoutExpired:
            self._timed_out = True
            self._terminate()
        with suppress(subprocess.TimeoutExpired):
            self._process.wait(timeout=FORCE_KILL_REAP_TIMEOUT_SECONDS)
        if self._stdout_thread is not None:
            self._stdout_thread.join(timeout=STREAM_JOIN_TIMEOUT_SECONDS)
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=STREAM_JOIN_TIMEOUT_SECONDS)
        returncode = self._process.returncode
        if returncode is None:
            returncode = 137 if self._timed_out else 1
        return ProcessResult(
            returncode=returncode,
            stdout=self._stdout.text(),
            stderr=self._stderr.text(),
            timed_out=self._timed_out,
            cancelled=self._cancel_reason is not None,
            cancel_reason=self._cancel_reason,
            stdout_bytes=self._stdout.total_bytes,
            stderr_bytes=self._stderr.total_bytes,
            stdout_truncated=self._stdout.truncated,
            stderr_truncated=self._stderr.truncated,
        )

    def kill(self) -> None:
        self._terminate()

    def cancel(self, reason: str) -> None:
        if self._cancel_reason is None:
            self._cancel_reason = reason
        self._terminate()

    def _terminate(self) -> None:
        with self._kill_lock:
            process = self._process
            if process is None or process.poll() is not None:
                return
            self._signal_group(process, signal.SIGTERM)
            try:
                process.wait(timeout=self._term_grace)
                return
            except subprocess.TimeoutExpired:
                pass
            self._signal_group(process, getattr(signal, "SIGKILL", 9))

    @staticmethod
    def _signal_group(process: subprocess.Popen[str], sig: int) -> None:
        if os.name == "nt":
            command = ["taskkill", "/PID", str(process.pid), "/T"]
            force_kill = sig == getattr(signal, "SIGKILL", 9)
            if force_kill:
                command.append("/F")
            try:
                subprocess.run(
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=30,
                    check=False,
                )
            except (OSError, subprocess.SubprocessError):
                with suppress(OSError, ValueError):
                    process.kill() if force_kill else process.terminate()
            return
        try:
            os.killpg(os.getpgid(process.pid), sig)
        except (AttributeError, ProcessLookupError, PermissionError):
            with suppress(OSError, ValueError):
                process.send_signal(sig)

    def _drain(
        self,
        channel: str,
        pipe,
        sink: BoundedTextBuffer,
    ) -> None:
        callback = self._on_output
        emitter = (
            BoundedLineEmitter(lambda line: self._notify_output(callback, channel, line))
            if callback is not None
            else None
        )
        try:
            while chunk := pipe.readline(64 * 1024):
                sink.append(chunk)
                if emitter is not None:
                    emitter.feed(chunk)
        except (ValueError, OSError):
            pass
        finally:
            if emitter is not None:
                emitter.flush()
            with suppress(Exception):
                pipe.close()

    @staticmethod
    def _notify_output(
        callback: OutputHandler,
        channel: str,
        line: str,
    ) -> None:
        try:
            callback(channel, line)
        except Exception:
            LOG.debug("worker output callback failed", exc_info=True)
