---
name: ctf-misc
description: Provides miscellaneous CTF challenge techniques for problems that do not cleanly fit the main categories. Use for encoding puzzles, pyjails, bash jails, pickle deserialization sandbox escapes, RF/SDR, DNS oddities, unicode tricks, esoteric languages, QR or audio puzzles, constraint solving, game theory, unusual sandbox escapes, and hybrid logic puzzles. Prefer a more specific skill first when the challenge is mainly web, pwn, reverse, forensics, malware, OSINT, or crypto. Treat this as the fallback skill for genuine cross-category or edge-case challenges, not the default starting point.
license: MIT
allowed-tools: Bash Read Write Edit Glob Grep Task WebFetch WebSearch Skill
metadata:
  user-invocable: "false"
---

# CTF Miscellaneous

## Trigger conditions

- The challenge does not fall into a single specialised skill (web, pwn, reverse, forensics, crypto, OSINT, AI/ML).
- The challenge involves encoding/decoding puzzles, Python/Bash jails, pickle sandboxes, RF/SDR, DNS, unicode tricks, QR/audio puzzles, constraint solving, game theory, hybrid VMs, or unusual sandbox escapes.
- The problem description or assets suggest cross‑category or edge‑case techniques.

## Applicability and scope

This skill provides reusable, bounded procedures and quick references for the above puzzle classes. It relies on a set of supporting detailed files (listed in *Additional Resources*) that contain full workflows, payloads, and historical context. The skill itself is a decision‑tree that dispatches to the appropriate technique and then executes a compact, deterministic workflow.

**Exclusions:**
- Pure cryptography or number‑theory → `/ctf-crypto`
- Binary exploitation → `/ctf-pwn`
- Reverse engineering of binaries → `/ctf-reverse`
- File/disk/memory forensics → `/ctf-forensics`
- OSINT/social‑media hunting → `/ctf-osint`
- ML/AI attacks or LLM jailbreaking → `/ctf-ai-ml`
- Web‑centric attacks (XSS, SSRF, SQLi) → dedicated web skills

**Environment:** Bash, Python 3 with the packages listed in *Prerequisites*, plus optional system tools (ffmpeg, zbar, sox, tesseract, qrencode). All techniques assume an authorised CTF or pentest engagement.

## Workflow

### 1. Pivot check

Scan the challenge description and supplied files. If the core problem matches one of the exclusions above, switch to the dedicated skill immediately.

### 2. Categorise the challenge

Use the table below to identify the most likely technique group.

| Characteristics | Technique group |
|----------------|----------------|
| Encoded strings, weird charsets, QR codes, audio‑hidden data | Encoding / Unicode |
| Python `eval`/`exec` jail or restricted built‑in environment | Python jail |
| `pickle.loads` with a custom `Unpickler`, banned opcodes, or `find_class` restrictions | Pickle deserialization escape |
| Restricted Bash shell, command‑line length/char limits | Bash jail |
| Invisible Unicode characters, font‑based stego, URL‑embedded tags | Unicode steganography |
| DNS zone transfers, rebinding, tunneling, RF IQ files | DNS / RF‑SDR |
| Custom virtual machine, emulator, game logic, Z3 constraints | Game / VM logic |
| Linux privilege escalation on a CTF box or container | Linux privesc |

### 3. Execute the technique

Follow the compact procedure for the chosen group. Validate the result using the **Validation standard** below. If the primary path fails, consult the technique’s own failure branch and iterate.

---

### Encoding / Unicode quick reference

- **Base64/32/Hex/ROT**: use `base64 -d`, `xxd -r -p`, `tr`, etc.
- **QR**: `zbarimg qr.png`
- **IEEE‑754 float data**: `struct.pack('>f', value)`
- **Unicode Variation Selectors** (U+E0100‑U+E01EF): subtract `0xE0100` and add 16 to get ASCII.
- **Unicode Tags Block** (U+E0000‑U+E007F): subtract `0xE0000` directly.
- **USB mouse PCAP**: track click coordinates, cumsum relative deltas, overlay on OSK image.
- **3D printer video**: track nozzle X/Y in print layer frames → 2D histogram.

Full details in [encodings.md](encodings.md), [encodings-advanced.md](encodings-advanced.md), [dns.md](dns.md), [rf-sdr.md](rf-sdr.md).

---

### Python jail quick reference

- **Oracle pattern**: `L()` gives length, `Q(i,x)` compares char, `S(guess)` submits.
- **Walrus bypass**: `(var := "new_chars")` reassigns constraint variables.
- **Decorator bypass**: `@__import__` + `@func.__class__.__dict__[__name__.__name__].__get__` for no‑call, no‑quotes escape.
- **String join when `+` is blocked**: `open(''.join(['fl','ag.txt'])).read()`
- **Restricted charset number generation**: use repunit sum decomposition (`1+11+111+...`)

Full workflow in [pyjails.md](pyjails.md).

---

### Pickle deserialization sandbox escape

Use when a challenge provides a pickle jail that overrides `_Unpickler`, restricts opcodes, or implements an attribute‑name blocklist.

**Core primitives (verified, reusable)**

- **DICT opcode bypass**: `DICT` constructs a dict without hitting `SETITEM`'s `'__' in key` filter → build a slotstate dict containing dunder keys like `__getattribute__`.
- **BUILD slotstate via `type.__setattr__`**: `BUILD` applies the slotstate dict through the type’s `__setattr__`, not the instance one, bypassing any instance‑level custom `__setattr__` that blocks dunder names.
- **Object‑inherited dunders not in the banned snapshot**: A common hardening snapshots `Unpickler.__dict__.keys()` to build the banned set. Methods inherited from `object` (`__del__`, `__getattribute__`, `__setattr__`, `__init__`, `__new__`, `__reduce__`, `__reduce_ex__`, `__format__`) are class‑level slots and thus absent from the snapshot. Any of them can be set via BUILD.
- **`__getattribute__` overwrite (complete bypass)**: Setting `__getattribute__` intercepts all attribute lookup on the unpickled object. Redirect it to a tainted namespace dict (also injected via DICT → BUILD) → no banned‑attribute check can block access, because the check itself goes through the now‑controlled `__getattribute__`.

**Python version branch**

| Condition | Behaviour | Exploitation impact |
|-----------|-----------|---------------------|
| Python ≤ 3.11 | `type.__dict__` is a mutable dict | `type.__setattr__` can mutate built‑in type attributes; type‑level gadget injection viable |
| Python ≥ 3.12 | `type.__dict__` is a mappingproxy (immutable) | Type‑level mutation blocked; rely on instance‑level attribute overwrites |

**Workflow (deterministic)**

1. Audit the unpickler: dump `find_class` whitelist/blacklist, the opcode `dispatch` table (note if `BUILD`, `DICT`, `SETITEM`, `INST` are disabled), and the banned attribute name set.
2. Check the BUILD slotstate path: verify `load_build` is enabled and that BUILD applies slotstate through `type.__setattr__`. Confirm whether `'__' in key` filtering exists at `SETITEM` but is absent from direct dict construction.
3. Enumerate the object‑inherited dunders not covered by the snapshot: `__del__`, `__getattribute__`, `__setattr__`, `__init__`, `__new__`, `__reduce__`, `__reduce_ex__`, `__format__`.
4. Craft a minimal pickle that uses `DICT` + `BUILD` with a dunder key. If it succeeds without hitting the SETITEM‑level filter, the DICT bypass is open.
5. Probe the Python version (exception message format, `sys.version_info` if reachable via a whitelisted class).
6. Exploit:
   - If `__getattribute__` is **not** banned: BUILD slotstate to replace it with a function that redirects all lookups to a pre‑seeded dict → full bypass.
   - If banned but Python ≤3.11: use `type.__setattr__` on a whitelisted built‑in type to inject a gadget (e.g., replace `str.__repr__`).
   - Any version: use `__del__` for code execution on garbage collection, or overwrite `__reduce__`/`__reduce_ex__` to hijack future serialization.
   - If `BUILD` is disabled: test the `INST` opcode for old‑style class instantiation.
   - If all dunders are banned: inject through `copyreg.dispatch_table` if a whitelisted class calls `copyreg.pickle` internally.
   - If `find_class` is very strict: enumerate allowed classes for ones with `__call__`, file I/O, or subprocess wrappers; chain through `__subclasshook__` or `__init_subclass__`.
   - Test pickle protocols 0‑5; protocol 0 uses text‑based opcodes and may evade binary‑only filters.

**Validation:** Confirm DICT carries dunder keys without an exception, BUILD applies slotstate through `type.__setattr__`, and `__getattribute__` overwrite intercepts attribute access as intended. The final payload should return a controlled string or execute a harmless command.

**Failure handling:** If the primary `__getattribute__` path is blocked, iterate the alternatives listed above. If the unpickler disables `BUILD` *and* `INST`, the jail is unlikely to be exploitable via pure pickle; look for other entry points (e.g., file reads through a whitelisted class, environment variable injection).

**Safety boundaries:** Use only against authorised pickle jails. Payloads must stop after reading a single file or proving code execution; do not deploy persistence or alter the remote environment. Test locally with the exact Python minor version first.

---

### Bash jail quick reference

- **HISTFILE trick**: force history expansion to read a file.
- **`bash -v` verbose mode**: leaks lines while checking syntax.
- **`ctypes.sh`**: direct C library calls from Bash.
See [bashjails.md](bashjails.md) for full procedures.

---

### Unicode steganography

- **Variation Selectors** (U+E0100‑U+E01EF): offset from 0xE0100 + 16.
- **Unicode Tags** (U+E0000‑U+E007F): offset from 0xE0000.
See [encodings.md](encodings.md) for code and CyberChef recipes.

---

### DNS / RF‑SDR quick reference

- DNS: ECS spoofing (`dig … +subnet=…`), NSEC walking, IXFR, rebinding, tunneling.
- RF: cf32, cs16, cu8 IQ formats; QAM‑16 demod with carrier/timing recovery; 4‑fold phase ambiguity.
Full details in [dns.md](dns.md) and [rf-sdr.md](rf-sdr.md).

---

### Game / VM logic techniques

Use Z3 for constraint solving (`BitVec`, `Solver`). For custom VMs/emulators:
- ROM swapping preserves CPU state → combine INIT from one ROM with display from another.
- WASM patching through `wasm2wat`/`wat2wasm`, or linear memory manipulation.
- Flask session cookies can be unsigned with `flask-unsign`; WebSocket game state can be modified in the console.
- Brainfuck instrumentation: track tape cells to brute‑force character by character.
- De Bruijn sequence: `B(k,n)` contains all n‑length strings; linearise by appending first n‑1 chars.
See [games-and-vms.md](games-and-vms.md), [games-and-vms-2.md](games-and-vms-2.md), [games-and-vms-3.md](games-and-vms-3.md), [games-and-vms-4.md](games-and-vms-4.md) for complete workflows.

---

### Linux privilege escalation quick checks

```bash
find / -perm -4000 2>/dev/null              # SUID binaries → cross‑reference GTFObins
sudo -l                                     # allowed commands
id | grep -q docker && docker run -v /:/mnt --rm -it alpine chroot /mnt /bin/sh
```

**Common vectors:**
- Docker group membership → mount host filesystem.
- Sudo wildcard injection (fnmatch `*` across argument boundaries).
- Monit process command‑line injection via `pgrep -lfa`.
- PostgreSQL `COPY … TO PROGRAM` RCE, `pg_read_file`.
- Backup cronjob SUID preservation; cron‑copied SUID bash → `bash -p`.
- PaperCut Print Deploy `server-command` abuse.
Detailed exploits in [linux-privesc.md](linux-privesc.md).

---

## Validation standard

- For each technique, confirm the expected outcome: a flag string matching the competition format, a command‑execution confirmation, or access to a previously restricted resource.
- Sandbox escapes are validated when the payload runs without triggering the jail’s error filter and returns controlled output.
- For file‑read paths, verify the content contains known marker strings (e.g., `flag{`).

## Failure handling

- If the chosen technique’s primary path fails, work through its documented alternative primitives.
- When a technique is mis‑judged (e.g., the jail is actually a full binary exploit), pivot to the correct skill.
- If no technique matches and the challenge remains unsolved, enumerate more characteristics, search for write‑ups of similar puzzles, or escalate to the user.

## Safety boundaries

- All techniques must only be used in authorised CTF competitions or penetration tests with explicit permission.
- Never target production services or systems outside the defined scope.
- Stop after retrieving the flag or proving code execution; do not install backdoors, alter configurations, or leave persistent artifacts.
- Report any accidental access to unintended data and immediately inform the engagement lead.

---

## Prerequisites

```bash
pip install z3-solver pwntools Pillow numpy scipy requests dnslib pyzbar pytesseract segno
```

**Linux:** `apt install ffmpeg qrencode zbar-tools sox tesseract-ocr` (adjust for dnf/pacman/zypper).
**macOS:** `brew install ffmpeg qrencode zbar sox tesseract`.

---

## Additional Resources

- [pyjails.md](pyjails.md)
- [bashjails.md](bashjails.md)
- [encodings.md](encodings.md)
- [encodings-advanced.md](encodings-advanced.md)
- [rf-sdr.md](rf-sdr.md)
- [dns.md](dns.md)
- [games-and-vms.md](games-and-vms.md)
- [games-and-vms-2.md](games-and-vms-2.md)
- [games-and-vms-3.md](games-and-vms-3.md)
- [games-and-vms-4.md](games-and-vms-4.md)
- [linux-privesc.md](linux-privesc.md)
- [ctfd-navigation.md](ctfd-navigation.md)
- [platform-workflow.md](platform-workflow.md)
