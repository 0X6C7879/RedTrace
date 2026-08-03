# Toolbox Guidance

Prefer tools already present in the workspace. Record versions and command outputs as evidence.

## General evidence

- Hashing: `sha256sum`, `Get-FileHash`, Python `hashlib`.
- Metadata: `file`, `exiftool`, `stat`, `sigcheck`, `osslsigncode`.
- Text search: `ripgrep`, `grep`, `Select-String`.

## Application/security review

- Source audit: language-native test runners, dependency scanners, Semgrep-style rules, lockfile review.
- Web/API validation: browser devtools, curl/http clients, OpenAPI schemas, application logs, local test accounts.
- Cloud/container review: provider CLIs in read-only mode, IaC linters, image metadata, Kubernetes manifests.

## Reverse engineering

- Binary triage: `file`, `strings`, `readelf`, `objdump`, `otool`, `dumpbin`, Detect It Easy, PE-bear.
- Decompilation/disassembly: Ghidra, IDA Free/Pro, Binary Ninja, radare2/rizin.
- Dynamic observation: debugger, ProcMon, strace/ltrace, sandbox VM, Wireshark/tcpdump, Frida in a lab.
- Mobile: jadx, apktool, aapt, objection/Frida in a test device, class-dump, codesign tools.
- Firmware: binwalk, unsquashfs, jefferson, firmware-mod-kit, qemu-user/system when appropriate.
- Documents: oledump, oletools, pdfid/pdf-parser, Office sandbox.

## Operating cautions

- Prefer read-only and local-lab commands.
- Save raw outputs under an evidence directory.
- Do not run unknown samples on the host OS; use an isolated VM/container with network controls.
- State the stop condition before any active validation.

## High-star catalog

For curated popular reverse-engineering tools, categories, approximate stars, and selection rules, read `tool-catalog.md`. Use `scripts/tool_audit.py` to check what is available locally before recommending installs.
