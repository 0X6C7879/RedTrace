# CTF Misc - Triage FAQ (Packaged MISC Materials)

This FAQ supplements `SKILL.md` with practical answers derived from packaged MISC study sets.

## 1) What to run first on unknown MISC attachments?

Run structural checks before semantic decoding:
- `file`, `xxd`, `binwalk`
- `strings | grep -i "flag\|ctf\|key\|secret"`
- archive detection (zip/7z/gz/bz2/xz)

## 2) How to handle multi-layer encodings?

Iterate decoding until stable:
- base64/base32/hex/url
- watch for mixed layers (hex inside base64 inside url)
- stop when printable ASCII stabilizes and markers appear

## 3) When should I switch to forensics/crypto?

Switch when dominant artifact is:
- pcap/memory/disk/image-only analysis -> forensics
- math/crypto primitives (RSA/AES/hash/MAC) -> crypto

## 4) How to reduce noisy attempts?

Use pattern-first triage:
- identify artifact class
- pick smallest reversible tool
- capture before/after snippets as evidence

## 5) What if only partial flag appears?

Sanitize surrounding noise, validate against known flag format, then submit once.
