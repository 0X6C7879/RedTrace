from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken


SECRET_REF_PATTERN = re.compile(r"^\$\{REDTRACE_SECRET:([a-f0-9]{32})\}$")


def resolve_dispatch_config_path(path: str | Path | None = None) -> Path:
    configured = path or os.environ.get("REDTRACE_DISPATCH_CONFIG") or "dispatch.yaml"
    return Path(configured).expanduser().resolve()


def resolve_secrets_dir(config_path: Path) -> Path:
    configured = os.environ.get("REDTRACE_CONFIG_SECRETS_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return config_path.parent / ".redtrace-secrets"


def secret_reference(secret_id: str) -> str:
    return f"${{REDTRACE_SECRET:{secret_id}}}"


def secret_id_from_reference(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    match = SECRET_REF_PATTERN.fullmatch(value)
    return match.group(1) if match else None


def atomic_write_bytes(path: Path, content: bytes, *, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        try:
            os.chmod(temporary_path, mode)
        except OSError:
            pass
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        try:
            os.chmod(path, mode)
        except OSError:
            pass
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def atomic_write_text(path: Path, content: str, *, mode: int = 0o600) -> None:
    atomic_write_bytes(path, content.encode("utf-8"), mode=mode)


class SecretStore:
    """Small encrypted store shared by the server and dispatcher.

    The YAML file contains only opaque references. The Fernet key and ciphertext are
    permission-restricted and live outside the source-controlled configuration.
    """

    def __init__(self, config_path: Path):
        root = resolve_secrets_dir(config_path)
        self.key_path = root / "master.key"
        self.data_path = root / "worker-config.enc"

    def load(self) -> dict[str, str]:
        if not self.data_path.exists():
            return {}
        try:
            plaintext = Fernet(self._read_key()).decrypt(self.data_path.read_bytes())
            value = json.loads(plaintext)
        except (InvalidToken, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError("worker secret store could not be decrypted") from exc
        if not isinstance(value, dict) or any(
            not isinstance(key, str) or not isinstance(secret, str)
            for key, secret in value.items()
        ):
            raise RuntimeError("worker secret store has an invalid format")
        return value

    def save(self, secrets: dict[str, str]) -> None:
        payload = json.dumps(
            secrets,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        ciphertext = Fernet(self._read_or_create_key()).encrypt(payload)
        atomic_write_bytes(self.data_path, ciphertext)

    def _read_key(self) -> bytes:
        try:
            key = self.key_path.read_bytes().strip()
        except FileNotFoundError as exc:
            raise RuntimeError("worker secret key is missing") from exc
        try:
            Fernet(key)
        except (ValueError, TypeError) as exc:
            raise RuntimeError("worker secret key is invalid") from exc
        return key

    def _read_or_create_key(self) -> bytes:
        if self.key_path.exists():
            return self._read_key()
        self.key_path.parent.mkdir(parents=True, exist_ok=True)
        key = Fernet.generate_key()
        try:
            fd = os.open(
                self.key_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except FileExistsError:
            return self._read_key()
        with os.fdopen(fd, "wb") as handle:
            handle.write(key + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        return key


def resolve_config_secrets(config_path: Path, data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    workers = data.get("workers")
    if not isinstance(workers, list):
        return data

    referenced = any(
        secret_id_from_reference(value)
        for value in (
            data.get("common_env", {}).values()
            if isinstance(data.get("common_env"), dict)
            else ()
        )
    )
    for worker in workers:
        if not isinstance(worker, dict) or not isinstance(worker.get("env"), dict):
            continue
        if any(secret_id_from_reference(value) for value in worker["env"].values()):
            referenced = True
            break
    if not referenced:
        return data

    secrets = SecretStore(config_path).load()
    resolved = dict(data)
    common_env = data.get("common_env")
    if isinstance(common_env, dict):
        common_copy = dict(common_env)
        for key, value in common_copy.items():
            secret_id = secret_id_from_reference(value)
            if secret_id is None:
                continue
            try:
                common_copy[key] = secrets[secret_id]
            except KeyError as exc:
                raise ValueError("common_env references a missing secret") from exc
        resolved["common_env"] = common_copy
    resolved_workers: list[Any] = []
    for worker in workers:
        if not isinstance(worker, dict) or not isinstance(worker.get("env"), dict):
            resolved_workers.append(worker)
            continue
        worker_copy = dict(worker)
        env_copy = dict(worker["env"])
        for key, value in env_copy.items():
            secret_id = secret_id_from_reference(value)
            if secret_id is None:
                continue
            try:
                env_copy[key] = secrets[secret_id]
            except KeyError as exc:
                worker_name = str(worker.get("name") or "<unnamed>")
                raise ValueError(
                    f"worker {worker_name} references a missing secret"
                ) from exc
        worker_copy["env"] = env_copy
        resolved_workers.append(worker_copy)
    resolved["workers"] = resolved_workers
    return resolved
