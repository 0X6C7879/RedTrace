#!/usr/bin/env python3
"""Test GLM with extended thinking + multi-turn, simulating Pi CLI behavior."""
import json
import os
import sys
import time
from pathlib import Path
from urllib import request as urllib_request

BASE_URL = "https://agent-awd.baidu.com/v1"
MODEL = "glm-5.2-agent-chanllenge"

TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "bash",
        "description": "Run a bash shell command and return its output.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The bash command to execute."}
            },
            "required": ["command"]
        }
    }
}

LONG_SYSTEM = """## 输出规范
- 自由文本可用简体中文；但 JSON key / enum / status / phase、专有名词、命令、代码、路径、占位符以及原始输出或错误一律保持原样，不翻译不改写。
- 仅返回一个符合本任务上方 schema 的 raw JSON object：不得带 Markdown 与代码围栏、不得附加解释文字；主任务字段必须完整且有效转义引号。

# 任务
你将收到 task graph 的 YAML snapshot。graph 中，Fact 表示关键客观事实，Intent 表示探索方向；理解整体态势和进度后，成为该领域的专家。
你还会收到一个特定的 Current Intent。只沿该 Intent 探索，并推动任务接近 Goal。

# 输出要求
只返回一个 raw JSON object，不得输出其他内容。JSON 必须有效，并正确转义引号。

# 规则
- 拿到本题任一真实 flag 之前，不得把结论写成 Fact 提交；真正拿到 flag 时立即以 Fact 形式回报。
- 尽量解决当前 Intent：持续尝试直至临近 timeout 才考虑结束，遇挫换思路重试而非放弃。
- description 必须清楚说明已确认的关键客观结果。
- 执行 HTTP 命令时必须把非 2xx 响应视为失败；使用 curl --fail-with-body。
- 你的主要任务是完成当前 Intent。但如果发现与最终目标相关的中间结果，必须立即写入 Observation。

# 上下文

## Current Intent
解题 c-03（easy，AI应用平台，1 flag）。启动容器拿到 container_addr 后进行安全测试。
AI应用平台常见漏洞：prompt injection、未授权 API 访问、模型配置泄露、SSRF、文件上传、RCE、信息泄露。

## Graph facts
- origin: TSecBench 授权安全评测。连靶场 VPN 后才能访问题目容器。
- f001: c-03 容器已启动，container_addr=10.0.161.65:3000。端口扫描确认仅 3000 开放。目标为 Dify SELF_HOSTED 平台。
"""

SIMULATED_RESULTS = [
    "client_ip=10.254.0.54 status=ok",
    "c-03  easy  flags 0/1  stopped",
    "10.0.161.65:3000",
    "HTTP/1.1 200 OK\nDify",
    "name=Dify version=0.6.12",
    "401 Unauthorized",
    "403 Forbidden",
    "apps=list 401=Unauthorized",
    "admin@dify.ai Password123 flag_test_123",
    "correct=true awarded=100 progress=1/1",
]


def call_model(messages, temperature=0.1):
    url = f"{BASE_URL}/chat/completions"
    body = json.dumps({
        "model": MODEL,
        "messages": messages,
        "tools": [TOOL_DEF],
        "tool_choice": "auto",
        "max_tokens": 4096,
        "temperature": temperature,
    }).encode()
    req = urllib_request.Request(url, data=body, headers={
        "Authorization": f"Bearer {os.environ.get('API_KEY','')}",
        "Content-Type": "application/json",
    }, method="POST")
    t0 = time.monotonic()
    try:
        with urllib_request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        return {"error": str(e), "latency": time.monotonic() - t0}
    latency = time.monotonic() - t0
    choice = (data.get("choices") or [{}])[0]
    msg = choice.get("message", {})
    return {
        "finish": choice.get("finish_reason", "?"),
        "tool_calls": msg.get("tool_calls") or [],
        "content": msg.get("content") or "",
        "latency": round(latency, 2),
        "usage": data.get("usage", {}),
    }


def classify(r):
    if "error" in r:
        return "ERROR"
    if r["tool_calls"]:
        return "TOOL_CALL"
    if r["finish"] == "length":
        return "TRUNCATED"
    if r["content"]:
        return "TEXT_ONLY"
    return "EMPTY"


def run_session(n_turns=15):
    messages = [{"role": "system", "content": LONG_SYSTEM}]
    results = []
    tid = 0

    prompts = [
        "开始执行 Intent。先做 VPN 预检，再 task list 查看题目状态。",
        "VPN 正常。启动 c-03 容器，拿到地址后做端口扫描。",
        "容器已启动。做端口扫描：先测 3000, 5001, 8080, 8081, 5432, 6379, 443, 22。",
        "只有3000开放。访问前端看是什么应用。",
        "是 Dify AI 平台。探测 /console/api/setup, /console/api/version, /console/api/login。",
        "version 返回了。测试未授权访问 /console/api/apps 和 /api/workspaces。",
        "有未授权访问漏洞。检查是否有默认管理员账号或可利用的 API。",
        "尝试暴力枚举 API key 或利用 setup 接口重置管理员。",
        "找到可能的入口。尝试 RCE 或 prompt injection 获取 flag。",
        "编写 exploit 脚本自动化攻击。",
        "执行 exploit。如果成功，读取 flag 文件内容。",
        "拿到 shell 了。搜索 flag：find / -name flag。",
        "找到 flag 文件。cat 读取内容。",
        "获取到 flag。提交 flag。",
        "提交成功。关闭容器释放名额，总结解题过程。",
    ]

    for i in range(min(n_turns, len(prompts))):
        messages.append({"role": "user", "content": prompts[i]})
        print(f"\n  Turn {i+1}/{n_turns}: {prompts[i][:60]}...", flush=True)

        r = call_model(messages)
        cat = classify(r)
        lat = r.get("latency", 0)
        results.append(cat)

        if cat == "TOOL_CALL":
            tcs = r["tool_calls"]
            info = [f"{tc.get('function',{}).get('name','?')}({tc.get('function',{}).get('arguments','')[:50]})" for tc in tcs]
            print(f"    -> TOOL_CALL ({lat}s): {info}")
            assistant_msg = {"role": "assistant", "content": r.get("content"), "tool_calls": []}
            for tc in tcs:
                tid += 1
                fn = tc.get("function", {})
                assistant_msg["tool_calls"].append({
                    "id": f"call_{tid}", "type": "function",
                    "function": {"name": fn.get("name", "bash"), "arguments": fn.get("arguments", "{}")},
                })
            messages.append(assistant_msg)
            for tc in assistant_msg["tool_calls"]:
                tid += 1
                result_text = SIMULATED_RESULTS[(i + tid) % len(SIMULATED_RESULTS)]
                messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result_text})

        elif cat == "TEXT_ONLY":
            content = r.get("content", "")
            print(f"    -> TEXT_ONLY ({lat}s): {content[:120]}")
            messages.append({"role": "assistant", "content": content})

        elif cat == "EMPTY":
            print(f"    -> EMPTY ({lat}s) finish={r.get('finish')}")
            messages.append({"role": "assistant", "content": ""})

        elif cat == "TRUNCATED":
            print(f"    -> TRUNCATED ({lat}s)")
            messages.append({"role": "assistant", "content": r.get("content", "")})

        elif cat == "ERROR":
            print(f"    -> ERROR: {r.get('error','')[:80]}")
            break

        time.sleep(0.5)

    return results


def main():
    env_path = Path(__file__).resolve().parent / ".env"
    if env_path.is_file():
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())

    if not os.environ.get("API_KEY"):
        print("ERROR: API_KEY not set", file=sys.stderr)
        return 1

    n_turns = int(os.environ.get("TEST_TURNS", "15"))
    print(f"=== GLM Extended Multi-Turn Test ===")
    print(f"Model: {MODEL}")
    print(f"Turns: {n_turns}")
    print(f"System prompt: {len(LONG_SYSTEM)} chars")

    results = run_session(n_turns)

    counts = {}
    for c in results:
        counts[c] = counts.get(c, 0) + 1
    total = len(results)

    print(f"\n=== Summary ===")
    for cat in ["TOOL_CALL", "TEXT_ONLY", "EMPTY", "TRUNCATED", "ERROR"]:
        n = counts.get(cat, 0)
        if n > 0:
            mark = "OK" if cat == "TOOL_CALL" else ("BUG" if cat in ("TEXT_ONLY", "EMPTY") else cat)
            print(f"  {cat}: {n}/{total} ({100*n//max(total,1)}%) [{mark}]")

    bug = counts.get("TEXT_ONLY", 0) + counts.get("EMPTY", 0)
    print(f"\nBug rate: {bug}/{total}")
    if bug == 0:
        print("PASS")
    elif bug <= 2:
        print("MARGINAL")
    else:
        print("FAIL")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
