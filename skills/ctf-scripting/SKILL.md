---
name: ctf-scripting
description: Thin routing skill for script-oriented CTF challenges and automation. Use when the primary artifact is a script (Python, Bash, Node/JS, Lua, Ruby) or the task depends on executing, instrumenting, jailbreaking, or automating scripts. Prefer domain-specific skills when the challenge is pure crypto, pure reverse engineering, or pure forensics.
license: MIT
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

## Quick Commands (per script type)

### Python (.py)

```bash
python -m py_compile file.py
python - <<'PY'
import ast, sys
print(ast.dump(ast.parse(open('file.py').read())))
PY
grep -R "FLAG_KEYWORD" .
```

### Bash / Shell (.sh)

```bash
bash -n script.sh
grep -R "FLAG_KEYWORD" .
strings script.sh
```

### JavaScript / Node (.js / .node)

```bash
node --check file.js
grep -R "FLAG_KEYWORD" .
strings file.node
```

### Lua (.lua)

```bash
luac -p file.lua
grep -R "FLAG_KEYWORD" .
```

### Ruby (.rb)

```bash
ruby -c file.rb
grep -R "FLAG_KEYWORD" .
```

## Minimal Automation Templates

### Local stdin/stdout script

```python
from pwn import *
p = process(['python', 'file.py'])
p.sendline(b'input')
print(p.recvline().decode())
```

### Remote TCP interaction

```python
from pwn import *
r = remote('host', port)
r.recvuntil(b'> ')
r.sendline(b'input')
print(r.recvline().decode())
```

### HTTP API interaction

```python
import requests
r = requests.post('http://host/api', json={'input':'test'})
print(r.text)
```

### Websocket interaction

```python
import websocket
ws = websocket.create_connection('ws://host/ws')
ws.send('hello')
print(ws.recv())
```

## Jail Recognition Checklist (fast)

- error reveals filter type (`name not allowed`, `unknown function`, `node not allowed`)
- restricted charset only (e.g., `#$\`)
- no string concat / no quotes / no import
- eval context differs (double-quoted vs bare)
- oracle functions available (length/compare/submit)
- sandbox language different from host (Lua/JS/Python)
- output truncated or timing differences (blind/side-channel)
- file read blocked, but env/proc leaks possible
- restricted shell (`rbash`, `rvim`) vs full shell

## Fast Triage Checklist

1. Identify interpreter/runtime required
2. Check network vs local execution
3. Search for flag format strings quickly (`strings`, `grep -R`)
4. Determine if the challenge is solve-by-running vs solve-by-understanding

## References

- [pyjails.md](../ctf-misc/pyjails.md)
- [bashjails.md](../ctf-misc/bashjails.md)
- [games-and-vms.md](../ctf-misc/games-and-vms.md)
- [games-and-vms-2.md](../ctf-misc/games-and-vms-2.md)
- [games-and-vms-3.md](../ctf-misc/games-and-vms-3.md)
- [games-and-vms-4.md](../ctf-misc/games-and-vms-4.md)
- [llm-attacks.md](../ctf-ai-ml/llm-attacks.md)
- [SKILL.md](../ctf-reverse/SKILL.md)
