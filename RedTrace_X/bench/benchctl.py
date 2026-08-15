#!/usr/bin/env python3
"""benchctl — TSecBench 跑分驱动器 + 供解题 worker 调用的平台命令。

用法：
  python3 bench/benchctl.py run                                        # 完整跑分（单项目，规划交给 reason）
  python3 bench/benchctl.py task list                                  # 列出题目
  python3 bench/benchctl.py task start <code>                          # 启动容器
  python3 bench/benchctl.py task context <code>                        # 查看进度
  python3 bench/benchctl.py task submit <code> 'flag{...}'             # 提交 flag
  python3 bench/benchctl.py task hint <code>                           # 获取提示
  python3 bench/benchctl.py task close <code>                          # 关闭容器
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from string import Template
from urllib import request as urllib_request

from benchmark import (
    BenchmarkClient,
    BenchmarkError,
    DuplicateSubmit,
    InvalidState,
    ResourceUnavailable,
    VpnCheckFailed,
)

ROOT = Path(__file__).resolve().parent.parent
SCOPE_TEMPLATE = Path(__file__).resolve().parent / "prompts" / "scope.md"
FLAG_RE = re.compile(r"^flag\{[^\s\r\n]{1,500}\}$")

_DIFFICULTY_RANK = {"easy": 0, "medium": 1, "hard": 2}
_PROJECT_TITLE = "[tsec] TSecBench 跑分"
# 容器处于这些状态说明已占用平台槽位，需要 close 才能释放
_ALLOCATED = ("available", "stop_pending", "pending")


class CairnError(Exception):
    """Cairn control plane is unavailable."""


GOAL = (
    "在任务时限结束前（题目容器不可访问即说明结束），尽可能多地解出题目、提交 flag，"
    "拿到尽可能高的总分；题目分数随时间衰减，越早解出得分越高。"
)
HINT = "每道题保留通用解题脚本，以便复用。"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _client() -> BenchmarkClient:
    return BenchmarkClient(
        _env("BENCHMARK_BASE_URL", "https://tsecbench.zc.tencent.com"),
        _env("BENCHMARK_TOKEN"),
        timeout=float(_env("HTTP_TIMEOUT", "30") or 30),
    )


def _cairn(method: str, path: str, body: dict | None = None):
    url = _env("CAIRN_BASE_URL", "http://127.0.0.1:8000").rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    req = urllib_request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib_request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib_request.HTTPError:
        raise
    except OSError as exc:
        raise CairnError(f"Cairn unavailable: {exc}") from exc


def _find(client: BenchmarkClient, code: str):
    return next((c for c in client.list_challenges() if c.get("unique_code") == code), None)


def _sort_key(challenge: dict):
    try:
        level = int(challenge.get("level") or 0)
    except (TypeError, ValueError):
        level = 0
    return (level, _DIFFICULTY_RANK.get(str(challenge.get("difficulty", "")).lower(), 9))


def _challenge_list(challenges: list) -> str:
    lines = []
    for c in challenges:
        lines.append(
            f"- {c['unique_code']} | {c.get('difficulty')} | level {c.get('level')} | "
            f"满分 {c.get('total_score')} | flag {c.get('correct_flag_count')}/{c.get('flag_count')}"
        )
    return "\n".join(lines)


def _build_scope(challenges: list) -> str:
    template = Template(SCOPE_TEMPLATE.read_text(encoding="utf-8"))
    return template.safe_substitute(
        challenges=_challenge_list(challenges),
        benchctl=str(Path(__file__).resolve()),
    )


def _create_project(challenges: list) -> str:
    resp = _cairn(
        "POST",
        "/projects",
        {
            "title": _PROJECT_TITLE,
            "origin": _build_scope(challenges),
            "goal": GOAL,
            "hints": [{"content": HINT, "creator": "benchctl"}],
        },
    )
    return resp["project"]["id"]


def _find_or_create_project(challenges: list) -> str:
    """复用上一次尚未结束的跑分项目，避免重启后旧任务与新任务争抢 Worker。"""
    projects = _cairn("GET", "/projects")
    active = [
        p for p in projects
        if p.get("title") == _PROJECT_TITLE and p.get("status") == "active"
    ]
    if not active:
        return _create_project(challenges)
    for stale in active[1:]:
        try:
            _cairn("PUT", f"/projects/{stale['id']}/status", {"status": "stopped"})
        except Exception:  # noqa: BLE001
            pass
    return active[0]["id"]


def _project_status(project_id: str) -> str | None:
    projects = _cairn("GET", "/projects")
    return next((p.get("status") for p in projects if p.get("id") == project_id), None)


def _close_running(client: BenchmarkClient) -> None:
    try:
        challenges = client.list_challenges()
    except BenchmarkError:
        return
    for c in challenges:
        if c.get("container_status") in _ALLOCATED:
            try:
                client.close_challenge(c["unique_code"])
            except Exception:  # noqa: BLE001
                pass


def _open_intent_codes(project_id: str, codes: set[str]) -> set[str]:
    """返回仍被某个未完结 intent 引用的 unique_code 集合。"""
    try:
        detail = _cairn("GET", f"/projects/{project_id}")
    except CairnError:
        return set(codes)  # 控制面不可达时不回收，交给上层中止
    claimed: set[str] = set()
    for intent in detail.get("intents", []):
        if intent.get("concluded_at") is not None:
            continue
        description = (intent.get("description") or "").lower()
        claimed.update(code for code in codes if code.lower() in description)
    return claimed


def _sweep(client: BenchmarkClient, project_id: str, challenges: list) -> None:
    """回收不再被任何 intent 持有的容器：已通关 + worker 崩溃后已放弃的题。"""
    codes = {c["unique_code"] for c in challenges}
    claimed = _open_intent_codes(project_id, codes)
    for c in challenges:
        if c.get("container_status") not in _ALLOCATED:
            continue
        code = c["unique_code"]
        if c.get("is_completed") or code not in claimed:
            try:
                client.close_challenge(code)
            except Exception:  # noqa: BLE001
                pass


# -- run ----------------------------------------------------------------

def cmd_run() -> int:
    client = _client()
    try:
        vpn = client.check_vpn(_env("VPN_CHECK_URL", "http://10.0.100.58"))
    except VpnCheckFailed as exc:
        print(f"VPN检测未通过,请检查靶场VPN网络配置: {exc}", file=sys.stderr)
        return 1
    print(f"[vpn] ok client_ip={vpn.get('client_ip')}")

    try:
        challenges = client.list_challenges()
    except BenchmarkError as exc:
        print(f"[fatal] 获取题目列表失败: {exc}", file=sys.stderr)
        return 1

    pending = [c for c in challenges if not c.get("is_completed")]
    total = len(challenges)
    print(f"[list] 总题目 {total}，待解 {len(pending)}")
    if not pending:
        print(f"[done] 已通关 {total}/{total}，无待解题目")
        return 0

    # 整个评测 = 一个 RedTrace 项目；scope/goal/hint 注入后，规划交给 reason（最多 3 道并行）
    try:
        project_id = _find_or_create_project(challenges)
    except Exception as exc:  # noqa: BLE001
        print(f"[fatal] 创建/恢复 RedTrace 项目失败: {exc}", file=sys.stderr)
        return 1
    print(f"[project] {project_id} 已就绪，reason 规划最优解题路线（分数随时间衰减，最多 3 道并行）...")

    timeout = float(_env("TASK_TIMEOUT_SECONDS", "21600") or 21600)
    poll = float(_env("POLL_INTERVAL_SECONDS", "3") or 3)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(poll)
        try:
            current = client.list_challenges()
        except BenchmarkError as exc:
            print(f"[poll] {exc}", file=sys.stderr)
            continue
        _sweep(client, project_id, current)
        remaining = [c for c in current if not c.get("is_completed")]
        if not remaining:
            break
        try:
            status = _project_status(project_id)
        except CairnError as exc:
            print(f"[fatal] {exc}，终止跑分", file=sys.stderr)
            _close_running(client)
            return 1
        if status in ("completed", "stopped"):
            break

    _close_running(client)

    try:
        final = client.list_challenges()
    except BenchmarkError:
        final = challenges
    for c in sorted(final, key=_sort_key):
        state = "completed" if c.get("is_completed") else c.get("container_status")
        print(f"[{c['unique_code']}] {c.get('correct_flag_count')}/{c.get('flag_count')} {state}")
    solved = sum(1 for c in final if c.get("is_completed"))
    print(f"[done] 已通关 {solved}/{total}")
    return 0


# -- task ---------------------------------------------------------------

def cmd_task(args) -> int:
    client = _client()
    action = args.action
    code = args.task_id
    answer = args.answer

    if action == "list":
        for c in client.list_challenges():
            flags = f"{c.get('correct_flag_count')}/{c.get('flag_count')}"
            state = "completed" if c.get("is_completed") else c.get("container_status")
            addr = ",".join(c.get("container_addr") or [])
            print(f"{c['unique_code']:<24} {c.get('difficulty', ''):<8} flags {flags:<7} {state:<12} {addr}")
        return 0

    if not code:
        print("error: task id required", file=sys.stderr)
        return 1

    if action == "start":
        try:
            r = client.start_challenge(code)
        except InvalidState:
            # 容器已启动（上一任 worker 崩溃后未 close 留下的）：直接复用现有地址继续解，
            # 不要反复 start 触发 invalid_state 死循环。
            info = _find(client, code)
            addr = info.get("container_addr") if info else None
            if addr:
                print("\n".join(addr))
            else:
                print("challenge already started (no address available)")
            return 0
        print("\n".join(r.get("container_addr", [])) or "started (no address yet)")
    elif action == "context":
        info = _find(client, code)
        print(json.dumps(info, ensure_ascii=False, indent=2) if info else "challenge not found")
    elif action == "submit":
        if not answer or not FLAG_RE.fullmatch(answer):
            print("error: answer 不符合 flag 格式 (flag{...})", file=sys.stderr)
            return 1
        try:
            r = client.submit_flag(code, answer)
        except DuplicateSubmit:
            print("duplicate（该 flag 已计入，跳过）")
            return 0
        print(f"correct={r.get('correct')} awarded={r.get('awarded')} "
              f"progress={r.get('correct_flag_count')}/{r.get('total_flag_count')}")
    elif action == "hint":
        r = client.get_hint(code)
        print(r.get("hint") or "(no hint)")
    elif action == "close":
        r = client.close_challenge(code)
        print(f"closed={r.get('closed')}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="benchctl", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run")
    task = sub.add_parser("task")
    task.add_argument("action", choices=["list", "start", "context", "submit", "hint", "close"])
    task.add_argument("task_id", nargs="?")
    task.add_argument("answer", nargs="?")
    args = parser.parse_args()
    if args.command == "run":
        return cmd_run()
    return cmd_task(args)


if __name__ == "__main__":
    raise SystemExit(main())
