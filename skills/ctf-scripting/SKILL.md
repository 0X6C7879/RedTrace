---
name: ctf-scripting
description: Thin routing skill for script-oriented CTF challenges and automation. Use when the primary artifact is a script (Python, Bash, Node/JS, Lua, Ruby) or the task depends on executing, instrumenting, jailbreaking, or automating scripts. Prefer domain-specific skills when the challenge is pure crypto, pure reverse engineering, or pure forensics.
license: MIT
compatibility: Requires filesystem-based agent with bash and Python 3.
allowed-tools: Bash Read Write Edit Glob Grep Task WebFetch WebSearch Skill
metadata:
  user-invocable: "false"
---

# CTF Scripting (Routing Layer)

This skill is a thin router for script-centric challenges. It provides a fast decision path and points to detailed techniques in existing skills instead of duplicating content.

## When to Use

Use `/ctf-scripting` when:
- Attachment is `.py`, `.sh`, `.js`, `.lua`, `.rb`, or similar script.
- Challenge is stdin/stdout interaction, API-driven scripting, or websocket scripting.
- You need quick triage for jails/sandbox/automation rather than deep reverse engineering.

Avoid `/ctf-scripting` when:
- Challenge is primarily math/crypto without script execution -> `/ctf-crypto`
- Challenge is native binary reversing (ELF/PE/VM) -> `/ctf-reverse`
- Challenge is web app exploitation without script focus -> `/ctf-web`
- Challenge is network/memory/disk forensics artifacts -> `/ctf-forensics`

## Quick Router (by artifact)

- `.py` with restricted execution or sandbox -> `ctf-misc/pyjails.md`
- restricted shell / bash filters -> `ctf-misc/bashjails.md`
- script + game/VM logic -> `ctf-misc/games-and-vms*.md`
- obfuscated script that must be reverse engineered -> `ctf-reverse`
- script triggers web endpoints or APIs -> `ctf-web` (primary), `ctf-scripting` for automation
- script interacts with LLM/tool-use flows -> `ctf-ai-ml/llm-attacks.md`

## Minimal Automation Template

```python
from pwn import *

r = remote('host', port)
# adjust as needed for prompts
r.recvuntil(b'> ')
r.sendline(b'input')
print(r.recvline().decode())
```

## Fast Triage Checklist

1. Identify interpreter/runtime required
2. Check network vs local execution
3. Search for flag format strings quickly (`strings`, `grep -R`)
4. Determine if the challenge is “solve by running” or “solve by understanding”

## References

- [pyjails.md](../ctf-misc/pyjails.md)
- [bashjails.md](../ctf-misc/bashjails.md)
- [games-and-vms.md](../ctf-misc/games-and-vms.md)
- [games-and-vms-2.md](../ctf-misc/games-and-vms-2.md)
- [games-and-vms-3.md](../ctf-misc/games-and-vms-3.md)
- [games-and-vms-4.md](../ctf-misc/games-and-vms-4.md)
- [llm-attacks.md](../ctf-ai-ml/llm-attacks.md)
- [SKILL.md](../ctf-reverse/SKILL.md)
