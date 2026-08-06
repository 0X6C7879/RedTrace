# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""benchctl — the single generic harness for all RedTrace Benchmark Packs.

Usage: uv run --no-project benchpacks/benchctl.py <command> ...
Commands: list | doctor | prepare | run | resume | status | stop | close-all
          task {list|start|context|submit|hint|close} <pack> [...]
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tomllib
from datetime import datetime
from pathlib import Path
from string import Template
from typing import Any

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
RUNTIME = ROOT / ".runtime"
RESULTS = ROOT / "results"
SDK_COMMANDS = {"doctor", "run", "resume", "stop", "close-all", "task"}


# ---------- pack / config ----------

def pack_dir(pack: str) -> Path:
    directory = ROOT / pack
    if not (directory / "pack.toml").is_file():
        sys.exit(f"pack not found: {pack}")
    return directory


def load_pack(pack: str) -> tuple[Path, dict, dict]:
    directory = pack_dir(pack)
    manifest = tomllib.loads((directory / "pack.toml").read_text("utf-8"))
    config_path = directory / manifest.get("credentials", {}).get("config_file", "config.local.toml")
    config = tomllib.loads(config_path.read_text("utf-8")) if config_path.is_file() else {}
    return directory, manifest, config


def required_missing(manifest: dict, config: dict) -> list[str]:
    missing = []
    for key in manifest.get("credentials", {}).get("required", []):
        node: Any = config
        for part in key.split("."):
            node = node.get(part) if isinstance(node, dict) else None
        if not isinstance(node, str) or not node.strip() or "example" in node or "请替换" in node:
            missing.append(key)
    return missing


def venv_python(pack: str) -> Path | None:
    base = RUNTIME / pack / "venv"
    for candidate in (base / "Scripts" / "python.exe", base / "bin" / "python"):
        if candidate.exists():
            return candidate
    return None


def reexec_in_pack_env(pack: str, args: list[str]) -> None:
    """Adapter commands must run inside the pack venv where the SDK lives."""
    if os.environ.get("BENCH_INNER"):
        return
    python = venv_python(pack)
    if python is None:
        sys.exit(f"pack '{pack}' is not prepared; run: benchctl prepare {pack}")
    env = {**os.environ, "BENCH_INNER": "1"}
    sys.exit(subprocess.run([str(python), str(ROOT / "benchctl.py"), *args], env=env).returncode)


def load_adapter(pack: str):
    sys.path.insert(0, str(ROOT))
    directory, manifest, config = load_pack(pack)
    missing = required_missing(manifest, config)
    if missing:
        sys.exit(f"config.local.toml missing required fields: {', '.join(missing)}")
    spec = importlib.util.spec_from_file_location(
        "pack_adapter", directory / manifest["adapter"]["module"]
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, manifest["adapter"]["class"])(config), directory, manifest, config


# ---------- state / results ----------

def state_path(pack: str) -> Path:
    return RUNTIME / pack / "state.json"


def load_state(pack: str) -> dict:
    path = state_path(pack)
    if path.is_file():
        return json.loads(path.read_text("utf-8"))
    return {"pack": pack, "run_id": None, "status": "idle", "tasks": {}}


def save_state(pack: str, state: dict) -> None:
    path = state_path(pack)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        path.with_name("state.json.bak").write_bytes(path.read_bytes())
    tmp = path.with_name("state.json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(path)


def run_dir(pack: str) -> Path:
    run_id = load_state(pack).get("run_id") or "manual"
    directory = RESULTS / pack / run_id
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def mask(text: str) -> str:
    return text[:4] + "***" if len(text) > 4 else "***"


# ---------- prepare ----------

def relink(target: Path, link: Path) -> None:
    if link.is_symlink() or link.exists():
        if link.is_dir() and not link.is_symlink():
            shutil.rmtree(link)
        else:
            link.unlink()
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.symlink(target, link, target_is_directory=target.is_dir())
    except OSError:  # Windows without symlink privilege: fall back to junction
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            check=True, capture_output=True,
        )


def build_overlay(pack: str, directory: Path, manifest: dict) -> Path:
    capabilities = RUNTIME / pack / "capabilities"
    skills_root = capabilities / "skills"
    for skill in sorted((REPO / "skills").iterdir()):
        if skill.is_dir() and not skill.name.startswith("."):
            relink(skill, skills_root / skill.name)
    relink(directory, skills_root / manifest["skill"]["name"])
    relink(REPO / "mcp", capabilities / "mcp")
    relink(REPO / "plugins", capabilities / "plugins")
    return capabilities


def write_compose_override(pack: str) -> None:
    capabilities = (RUNTIME / pack / "capabilities").as_posix()
    block = (
        f"    volumes:\n      - {capabilities}:/redtrace/benchmark-capabilities:ro\n"
        "    environment:\n      REDTRACE_CAPABILITIES_ROOT: /redtrace/benchmark-capabilities\n"
    )
    (RUNTIME / pack / "compose.override.yaml").write_text(
        f"services:\n  redtrace-server:\n{block}  redtrace-dispatcher:\n{block}", "utf-8"
    )


def cmd_prepare(pack: str) -> None:
    directory, manifest, _config = load_pack(pack)
    runtime = RUNTIME / pack
    (RESULTS / pack).mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "UV_CACHE_DIR": str(runtime / "uv-cache")}
    python = venv_python(pack)
    if python is None:
        subprocess.run(["uv", "venv", str(runtime / "venv")], env=env, check=True)
        python = venv_python(pack)
    deps = manifest.get("python", {}).get("dependencies", [])
    if deps:
        subprocess.run(["uv", "pip", "install", "--python", str(python), *deps], env=env, check=True)
    build_overlay(pack, directory, manifest)
    write_compose_override(pack)
    bin_dir = REPO / ".redtrace" / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    (bin_dir / "benchctl").write_text(
        f'#!/usr/bin/env bash\nexec python3 "{(ROOT / "benchctl.py").as_posix()}" "$@"\n', "utf-8"
    )
    if not state_path(pack).is_file():
        save_state(pack, load_state(pack))
    print(f"{pack}: prepared (venv, SDK, overlay, compose.override)")


# ---------- read-only commands ----------

def cmd_list() -> None:
    for directory in sorted(ROOT.iterdir()):
        if not (directory / "pack.toml").is_file():
            continue
        manifest = tomllib.loads((directory / "pack.toml").read_text("utf-8"))
        config_path = directory / manifest.get("credentials", {}).get("config_file", "config.local.toml")
        config = tomllib.loads(config_path.read_text("utf-8")) if config_path.is_file() else None
        if config is None or required_missing(manifest, config):
            status = "not-configured"
        elif venv_python(manifest["id"]) is None:
            status = "not-prepared"
        else:
            status = "ready"
        print(f"{manifest['id']:<12} {status}")


def cmd_status(pack: str) -> None:
    print(json.dumps(load_state(pack), ensure_ascii=False, indent=2))


# ---------- doctor ----------

async def cmd_doctor(pack: str) -> None:
    adapter, directory, manifest, config = load_adapter(pack)
    token = config["platform"]["token"]
    print(f"platform.base_url = {config['platform']['base_url']}")
    print(f"platform.token    = {mask(token)}")
    print(f"python            = {sys.version.split()[0]}")
    first_dep = manifest["python"]["dependencies"][0]
    try:
        __import__(first_dep.replace("-", "_"))
        print(f"sdk {first_dep:<17}= installed")
    except ImportError:
        print(f"sdk {first_dep:<17}= MISSING (run: benchctl prepare {pack})")
    try:
        import httpx
        response = httpx.get(config.get("redtrace", {}).get("base_url", "http://127.0.0.1:8000") + "/projects", timeout=10)
        print(f"redtrace server   = HTTP {response.status_code}")
    except Exception as exc:
        print(f"redtrace server   = UNREACHABLE ({exc})")
    try:
        result = await adapter.check_connection()
        print(f"vpn               = {'ok' if getattr(result, 'ok', False) else 'NOT OK'} ({getattr(result, 'client_ip', '?')})")
    except Exception as exc:
        print(f"vpn               = FAILED ({type(exc).__name__})")
    overlay = RUNTIME / pack / "capabilities" / "skills" / manifest["skill"]["name"]
    print(f"skill overlay     = {'ok' if overlay.exists() else 'MISSING (run: benchctl prepare ' + pack + ')'}")


# ---------- redtrace api ----------

def redtrace_base(config: dict) -> str:
    return config.get("redtrace", {}).get("base_url", "http://127.0.0.1:8000").rstrip("/")


def create_project(pack: str, config: dict, directory: Path, challenge: dict, started: dict) -> str:
    import httpx
    template = Template((directory / "prompts" / "task.md").read_text("utf-8"))
    goal = template.safe_substitute(
        task_id=challenge["unique_code"],
        description=challenge["description"],
        difficulty=challenge.get("difficulty", ""),
        addresses="\n".join(started.get("container_addr", [])) or "(pending)",
        flag_count=challenge["flag_count"],
        correct=challenge["correct_flag_count"],
        benchctl=f'python "{(ROOT / "benchctl.py").as_posix()}"',
    )
    response = httpx.post(
        f"{redtrace_base(config)}/projects",
        json={"title": f"[{pack}] {challenge['unique_code']}", "origin": f"benchmark pack {pack}", "goal": goal},
        timeout=30,
    )
    response.raise_for_status()
    project_id = response.json()["project"]["id"]
    workspace = REPO / "workspaces" / project_id
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "benchctl").write_text(
        f'#!/usr/bin/env bash\nexec python3 "{(ROOT / "benchctl.py").as_posix()}" "$@"\n', "utf-8"
    )
    append_jsonl(run_dir(pack) / "redtrace-projects.json", {"task_id": challenge["unique_code"], "project_id": project_id})
    return project_id


def project_status(config: dict, project_id: str) -> str | None:
    import httpx
    try:
        projects = httpx.get(f"{redtrace_base(config)}/projects", timeout=10).json()
        return next((p["status"] for p in projects if p["id"] == project_id), None)
    except Exception:
        return None


# ---------- run ----------

def stop_requested(pack: str) -> bool:
    return load_state(pack).get("status") == "stopping"


async def start_with_retry(adapter, task_id: str) -> dict:
    for attempt in range(3):
        try:
            return await adapter.start_task(task_id)
        except Exception as exc:
            if adapter.classify_error(exc) == "resource_unavailable" and attempt < 2:
                await asyncio.sleep(2 ** attempt)
                continue
            raise


async def solve(pack: str, adapter, config: dict, directory: Path, state: dict,
                sem: asyncio.Semaphore, challenge: dict) -> None:
    task_id = challenge["unique_code"]
    run_cfg = config.get("run", {})
    container_cfg = config.get("container", {})
    async with sem:
        if stop_requested(pack):
            return
        rdir = run_dir(pack)
        entry = state["tasks"].setdefault(task_id, {})
        entry["difficulty"] = challenge.get("difficulty", "")
        if entry.get("platform_status") == "completed":
            return
        try:
            started = await start_with_retry(adapter, task_id)
        except Exception as exc:
            entry.update(status="failed", error=str(exc))
            save_state(pack, state)
            append_jsonl(rdir / "errors.jsonl", {"task_id": task_id, "phase": "start", "error": f"{type(exc).__name__}: {exc}"})
            return
        entry.update(
            container_addresses=started.get("container_addr", []),
            started_at=now_iso(), closed=False,
        )
        save_state(pack, state)
        try:
            entry["redtrace_project_id"] = create_project(pack, config, directory, challenge, started)
        except Exception as exc:
            append_jsonl(rdir / "errors.jsonl", {"task_id": task_id, "phase": "project", "error": str(exc)})
        save_state(pack, state)
        deadline = time.monotonic() + float(run_cfg.get("task_timeout_seconds", 21600))
        poll = float(run_cfg.get("poll_interval_seconds", 2))
        max_wrong = int(run_cfg.get("max_wrong_submissions", 5))
        outcome = "timeout"
        while time.monotonic() < deadline:
            if stop_requested(pack):
                outcome = "stopped"
                break
            await asyncio.sleep(poll)
            entry.update(load_state(pack)["tasks"].get(task_id, {}))  # merge agent-side updates
            try:
                info = await adapter.get_task_context(task_id)
            except Exception as exc:
                policy = adapter.classify_error(exc)
                if policy == "challenge_not_found":
                    info = None
                elif policy == "invalid_state":
                    continue
                elif policy == "connection":
                    state["status"] = "stopping"
                    save_state(pack, state)
                    append_jsonl(rdir / "errors.jsonl", {"task_id": task_id, "phase": "poll", "error": str(exc)})
                    break
                else:
                    append_jsonl(rdir / "errors.jsonl", {"task_id": task_id, "phase": "poll", "error": str(exc)})
                    continue
            if info is None:
                outcome = "failed"
                break
            entry.update(
                correct_flags=info["correct_flag_count"], total_flags=info["flag_count"],
                platform_status="completed" if info["is_completed"] else info["container_status"],
            )
            if info["is_completed"]:
                outcome = "completed"
                break
            if entry.get("wrong_submissions", 0) >= max_wrong:
                outcome = "wrong_limit"
                break
            status = project_status(config, entry.get("redtrace_project_id", ""))
            if status and status not in ("active",) and not info["is_completed"]:
                outcome = status
                break
        completed = outcome == "completed"
        should_close = container_cfg.get("close_on_completed" if completed else "close_on_failure", True)
        if should_close and not entry.get("closed"):
            try:
                await adapter.close_task(task_id)
                entry["closed"] = True
            except Exception as exc:
                append_jsonl(rdir / "errors.jsonl", {"task_id": task_id, "phase": "close", "error": str(exc)})
        entry.update(status=outcome, finished_at=now_iso())
        save_state(pack, state)
        append_jsonl(rdir / "challenges.jsonl", {"task_id": task_id, **{k: entry.get(k) for k in
            ("difficulty", "status", "started_at", "finished_at", "correct_flags", "total_flags",
             "wrong_submissions", "redtrace_project_id", "closed")}})


def write_summary(pack: str, state: dict) -> None:
    rdir = run_dir(pack)
    tasks = state["tasks"]
    summary = {
        "pack": pack, "run_id": state.get("run_id"), "status": state.get("status"),
        "started_at": state.get("started_at"), "finished_at": now_iso(),
        "total": len(tasks),
        "completed": sum(1 for t in tasks.values() if t.get("platform_status") == "completed"),
        "tasks": tasks,
    }
    (rdir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), "utf-8")
    lines = [f"# Benchmark report: {pack} ({state.get('run_id')})", "",
             f"- status: {state.get('status')}", f"- tasks: {summary['total']}, completed: {summary['completed']}", "",
             "| task | status | flags | project |", "|---|---|---|---|"]
    for task_id, t in tasks.items():
        lines.append(f"| {task_id} | {t.get('status')} | {t.get('correct_flags', '?')}/{t.get('total_flags', '?')} | {t.get('redtrace_project_id', '-')} |")
    (rdir / "report.md").write_text("\n".join(lines) + "\n", "utf-8")


async def cmd_run(pack: str, resume: bool = False, mode: str = "local", dispatch: str = "dispatch.yaml") -> None:
    adapter, directory, manifest, config = load_adapter(pack)
    state = load_state(pack) if resume else None
    try:
        async with adapter:  # VPN precheck; VpnCheckError aborts before any state change
            if state is None or not state.get("tasks"):
                state = {"pack": pack, "run_id": datetime.now().strftime("%Y-%m-%d_%H%M%S"),
                         "started_at": now_iso(), "status": "running", "mode": mode,
                         "dispatch": dispatch, "tasks": {}}
            else:
                state["status"] = "running"
            save_state(pack, state)
            run_cfg = config.get("run", {})
            challenges = await adapter.list_tasks()
            skip_completed = bool(run_cfg.get("skip_completed", True))
            todo = [c for c in challenges if not (skip_completed and c["is_completed"])]
            sem = asyncio.Semaphore(max(1, int(run_cfg.get("parallel_tasks", 1))))
            await asyncio.gather(*(solve(pack, adapter, config, directory, state, sem, c) for c in todo))
            state = load_state(pack)
            if state["status"] == "running":
                state["status"] = "finished"
    except KeyboardInterrupt:
        state = load_state(pack)
        state["status"] = "stopped"
    except Exception as exc:
        policy = adapter.classify_error(exc)
        state = load_state(pack)
        if policy == "vpn":
            state["status"] = "aborted-vpn"
            print("VPN检测未通过,请检查靶场VPN网络配置 — 未开始跑分，状态保留")
        elif policy == "task_not_found":
            state["status"] = "ended"
        elif policy == "connection":
            state["status"] = "stopped"
        else:
            state["status"] = "error"
            append_jsonl(run_dir(pack) / "errors.jsonl", {"phase": "run", "error": f"{type(exc).__name__}: {exc}"})
    save_state(pack, state)
    if state.get("status") in ("stopping", "stopped") and config.get("container", {}).get("close_on_user_stop", True):
        await close_started(pack, adapter)
    write_summary(pack, state)
    print(f"{pack}: run {state.get('status')} -> {run_dir(pack)}")


async def close_started(pack: str, adapter) -> None:
    state = load_state(pack)
    for task_id, entry in state["tasks"].items():
        if entry.get("closed") or not entry.get("started_at"):
            continue
        try:
            await adapter.close_task(task_id)
            entry["closed"] = True
        except Exception:
            pass
    save_state(pack, state)


# ---------- close-all / stop / task ----------

async def cmd_close_all(pack: str) -> None:
    adapter, _d, _m, _c = load_adapter(pack)
    async with adapter:
        for challenge in await adapter.list_tasks():
            if challenge["container_status"] in ("available", "stop_pending"):
                try:
                    await adapter.close_task(challenge["unique_code"])
                    print(f"closed {challenge['unique_code']}")
                except Exception as exc:
                    print(f"failed {challenge['unique_code']}: {exc}")
    state = load_state(pack)
    for entry in state["tasks"].values():
        entry["closed"] = True
    save_state(pack, state)


def cmd_stop(pack: str) -> None:
    state = load_state(pack)
    state["status"] = "stopping"
    save_state(pack, state)
    print(f"{pack}: stopping requested")


async def cmd_task(pack: str, action: str, task_id: str | None, answer: str | None) -> None:
    adapter, _d, manifest, config = load_adapter(pack)
    async with adapter:
        if action == "list":
            for c in await adapter.list_tasks():
                print(f"{c['unique_code']:<12} {c['difficulty']:<8} flags {c['correct_flag_count']}/{c['flag_count']} "
                      f"{'completed' if c['is_completed'] else c['container_status']} {','.join(c['container_addr'])}")
            return
        if not task_id:
            sys.exit("task id required")
        state = load_state(pack)
        entry = state["tasks"].setdefault(task_id, {})
        if action == "start":
            started = await adapter.start_task(task_id)
            entry.update(container_addresses=started["container_addr"], started_at=now_iso(), closed=False)
            save_state(pack, state)
            print("\n".join(started["container_addr"]) or "started (no address yet)")
        elif action == "context":
            info = await adapter.get_task_context(task_id)
            print(json.dumps(info, ensure_ascii=False, indent=2) if info else "challenge not found")
        elif action == "submit":
            pattern = manifest.get("answer", {}).get("pattern")
            if pattern and not re.fullmatch(pattern, answer or ""):
                sys.exit(f"answer does not match pack pattern: {pattern}")
            digest = hashlib.sha256((answer or "").encode()).hexdigest()
            hashes = entry.setdefault("submitted_hashes", [])
            if digest in hashes:
                print("duplicate candidate, skipped")
                return
            hashes.append(digest)
            try:
                result = await adapter.submit_answer(task_id, answer or "")
            except Exception as exc:
                if adapter.classify_error(exc) == "duplicate":
                    print("duplicate submit (idempotent ignore)")
                    save_state(pack, state)
                    return
                raise
            entry["wrong_submissions"] = entry.get("wrong_submissions", 0) + (0 if result["correct"] else 1)
            entry.update(correct_flags=result["correct_flag_count"], total_flags=result["total_flag_count"])
            save_state(pack, state)
            append_jsonl(run_dir(pack) / "submissions.jsonl",
                         {"task_id": task_id, "correct": result["correct"], "awarded": result["awarded"],
                          "progress": f"{result['correct_flag_count']}/{result['total_flag_count']}", "at": now_iso()})
            print(f"correct={result['correct']} awarded={result['awarded']} "
                  f"progress={result['correct_flag_count']}/{result['total_flag_count']}")
        elif action == "hint":
            if not config.get("run", {}).get("allow_hint", False):
                sys.exit("hints disabled in config.local.toml ([run] allow_hint = false)")
            print((await adapter.get_hint(task_id)).get("hint") or "(no hint)")
        elif action == "close":
            result = await adapter.close_task(task_id)
            entry["closed"] = bool(result.get("closed", True))
            save_state(pack, state)
            print(f"closed={entry['closed']}")


# ---------- entrypoint ----------

def main() -> None:
    parser = argparse.ArgumentParser(prog="benchctl", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    for name in ("doctor", "prepare", "status", "stop", "resume", "close-all"):
        p = sub.add_parser(name); p.add_argument("pack")
    run = sub.add_parser("run"); run.add_argument("pack")
    run.add_argument("--mode", default="local", choices=["local", "docker"])
    run.add_argument("--dispatch", default="dispatch.yaml")
    task = sub.add_parser("task"); task.add_argument("action",
        choices=["list", "start", "context", "submit", "hint", "close"])
    task.add_argument("pack")
    task.add_argument("task_id", nargs="?")
    task.add_argument("answer", nargs="?")
    args = parser.parse_args()

    if args.command == "list":
        return cmd_list()
    if args.command == "prepare":
        return cmd_prepare(args.pack)
    if args.command == "status":
        return cmd_status(args.pack)
    if args.command in SDK_COMMANDS:
        reexec_in_pack_env(args.pack, sys.argv[1:])
    if args.command == "doctor":
        return asyncio.run(cmd_doctor(args.pack))
    if args.command == "stop":
        return cmd_stop(args.pack)
    if args.command == "close-all":
        return asyncio.run(cmd_close_all(args.pack))
    if args.command == "run":
        return asyncio.run(cmd_run(args.pack, mode=args.mode, dispatch=args.dispatch))
    if args.command == "resume":
        return asyncio.run(cmd_run(args.pack, resume=True))
    if args.command == "task":
        return asyncio.run(cmd_task(args.pack, args.action, args.task_id, args.answer))


if __name__ == "__main__":
    main()
