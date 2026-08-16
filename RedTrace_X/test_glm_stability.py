#!/usr/bin/env python3
"""Test GLM model tool-call stability.

Sends N prompts requiring tool calls and measures:
- % with valid tool_calls in response
- % with text-only (no tool call) = bug
- % with empty response = bug
- % with thinking-only (tool call in thinking) = bug
"""
import json
import os
import sys
import time
from pathlib import Path
from urllib import request as urllib_request

BASE_URL = os.environ.get("PI_BASE_URL", "https://agent-awd.baidu.com/v1")
MODEL = os.environ.get("PI_MODEL", "glm-5.2-agent-chanllenge")
API_KEY = os.environ.get("API_KEY", "")
N = int(os.environ.get("TEST_N", "10"))

TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "bash",
        "description": "Run a bash shell command and return its output.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash command to execute."
                }
            },
            "required": ["command"]
        }
    }
}

SYSTEM_PROMPT = (
    "You are a security testing agent. You have one tool: bash. "
    "When you need to perform any action, ALWAYS call the bash tool. "
    "NEVER output commands as plain text. "
    "After getting results, respond with a brief analysis, then call bash again for the next step."
)

PROMPTS = [
    "Run `date` to check current time, then run `uname -a` to check the OS.",
    "List files in /tmp with `ls -la /tmp`, then check disk usage with `df -h /`.",
    "Check network connectivity: run `ping -c 2 8.8.8.8`, then run `curl -s ifconfig.me`.",
    "Check running processes with `ps aux | head -20`, then check memory with `free -h`.",
    "Create a test file: run `echo hello > /tmp/test.txt`, then read it with `cat /tmp/test.txt`.",
    "Check Python version with `python3 --version`, then check pip list with `pip3 list | head -10`.",
    "Check environment variables with `env | grep -i path`, then check current dir with `pwd`.",
    "Run `id` to check user, then run `hostname` to check hostname.",
    "Check git version with `git --version`, then check node version with `node --version`.",
    "Run `whoami`, then run `cat /etc/os-release | head -5`.",
]


def call_model(user_prompt: str, attempt: int = 0) -> dict:
    """Call GLM model with a tool-use prompt. Returns parsed response."""
    url = f"{BASE_URL}/chat/completions"
    body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "tools": [TOOL_DEF],
        "tool_choice": "auto",
        "max_tokens": 2048,
        "temperature": 0.1,
    }).encode()

    req = urllib_request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    start = time.monotonic()
    try:
        with urllib_request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
    except Exception as exc:
        return {"error": str(exc), "latency_s": time.monotonic() - start}
    latency = time.monotonic() - start

    choice = (data.get("choices") or [{}])[0]
    msg = choice.get("message", {})
    finish = choice.get("finish_reason", "unknown")
    tool_calls = msg.get("tool_calls") or []
    content = msg.get("content") or ""

    return {
        "finish_reason": finish,
        "has_tool_calls": bool(tool_calls),
        "tool_call_count": len(tool_calls),
        "tool_calls": [
            {"name": tc.get("function", {}).get("name", "?"),
             "args_preview": tc.get("function", {}).get("arguments", "")[:80]}
            for tc in tool_calls
        ],
        "has_content": bool(content),
        "content_preview": content[:150] if content else "",
        "content_length": len(content),
        "latency_s": round(latency, 2),
        "usage": data.get("usage", {}),
    }


def classify(result: dict) -> str:
    """Classify response into outcome category."""
    if "error" in result:
        return "ERROR"
    if result["has_tool_calls"]:
        return "TOOL_CALL_OK"
    if result["finish_reason"] == "length":
        return "TRUNCATED"
    if result["has_content"] and not result["has_tool_calls"]:
        return "TEXT_ONLY_NO_TOOL"
    if not result["has_content"] and not result["has_tool_calls"]:
        return "EMPTY_RESPONSE"
    return "UNKNOWN"


def _load_env():
    """Load .env file into os.environ."""
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


def main():
    _load_env()
    global API_KEY, BASE_URL, MODEL
    API_KEY = API_KEY or os.environ.get("API_KEY", "")
    BASE_URL = os.environ.get("PI_BASE_URL", BASE_URL)
    MODEL = os.environ.get("PI_MODEL", MODEL)

    if not API_KEY:
        print("ERROR: API_KEY not set", file=sys.stderr)
        return 1

    print(f"=== GLM Tool-Call Stability Test ===")
    print(f"Model: {MODEL}")
    print(f"Endpoint: {BASE_URL}")
    print(f"Rounds: {N}")
    print(f"Temperature: 0.1")
    print()

    results = []
    for i in range(N):
        prompt = PROMPTS[i % len(PROMPTS)]
        print(f"[{i+1}/{N}] Testing: {prompt[:60]}...", end=" ", flush=True)
        result = call_model(prompt)
        cat = classify(result)
        results.append((cat, result))
        latency = result.get("latency_s", 0)
        if cat == "TOOL_CALL_OK":
            tc_names = [tc["name"] for tc in result.get("tool_calls", [])]
            print(f"✅ {cat} ({latency}s) calls={tc_names}")
        elif cat == "TEXT_ONLY_NO_TOOL":
            print(f"❌ {cat} ({latency}s) content={result.get('content_preview', '')[:80]}")
        elif cat == "EMPTY_RESPONSE":
            print(f"❌ {cat} ({latency}s) finish={result.get('finish_reason')}")
        elif cat == "ERROR":
            print(f"💥 {cat}: {result.get('error', '')[:80]}")
        else:
            print(f"⚠️  {cat} ({latency}s) finish={result.get('finish_reason')}")

        # Brief pause to avoid rate limiting
        if i < N - 1:
            time.sleep(1)

    # Summary
    print("\n=== Summary ===")
    counts = {}
    for cat, _ in results:
        counts[cat] = counts.get(cat, 0) + 1

    total = len(results)
    ok = counts.get("TOOL_CALL_OK", 0)
    text_only = counts.get("TEXT_ONLY_NO_TOOL", 0)
    empty = counts.get("EMPTY_RESPONSE", 0)
    errors = counts.get("ERROR", 0)
    truncated = counts.get("TRUNCATED", 0)

    print(f"Total:           {total}")
    print(f"TOOL_CALL_OK:    {ok}/{total} ({100*ok/total:.0f}%) ✅")
    print(f"TEXT_ONLY_NO_TOOL: {text_only}/{total} ({100*text_only/total:.0f}%) {'❌' if text_only else '✅'}")
    print(f"EMPTY_RESPONSE:  {empty}/{total} ({100*empty/total:.0f}%) {'❌' if empty else '✅'}")
    print(f"TRUNCATED:       {truncated}/{total} ({100*truncated/total:.0f}%) {'⚠️' if truncated else '✅'}")
    print(f"ERROR:           {errors}/{total} ({100*errors/total:.0f}%) {'💥' if errors else '✅'}")

    bug_rate = text_only + empty + errors
    print(f"\nBug rate: {bug_rate}/{total} ({100*bug_rate/total:.0f}%)")
    if bug_rate == 0:
        print("✅ Model tool-call stability: PASS")
    elif bug_rate <= total * 0.2:
        print("⚠️  Model tool-call stability: MARGINAL (>80% OK)")
    else:
        print("❌ Model tool-call stability: FAIL (>20% buggy)")

    # Show details of failures
    failures = [(cat, r) for cat, r in results if cat not in ("TOOL_CALL_OK", "TRUNCATED")]
    if failures:
        print(f"\n=== Failure Details ({len(failures)}) ===")
        for cat, r in failures:
            print(f"  [{cat}] finish={r.get('finish_reason')} "
                  f"content_len={r.get('content_length', 0)} "
                  f"preview={r.get('content_preview', '')[:100]}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
