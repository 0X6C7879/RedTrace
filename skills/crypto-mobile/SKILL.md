---
name: crypto-mobile
description: Security workflow for crypto, encoding, steganography, APK, IPA, and mobile trust-boundary tasks. Use when the user asks to decode a blob, recover a transform chain or key, inspect hidden media payloads, hook an APK or IPA signer, inspect app storage, or replay mobile request-signing logic. Use directly when this Capability matches.
metadata:
  redtrace:
    capabilities: [crypto]
---

# Crypto Mobile

Use this skill directly for the matching security surface and keep conclusions tied to observable evidence.

Use this skill when the active task depends on recovering a transform chain, hidden media payload, mobile signing path, or local trust seam.

Reply in Simplified Chinese unless the user explicitly requests English.

## Quick Start

1. Decide whether the dominant path is crypto, stego, or mobile.
2. Recover transforms in order; do not jump straight to the fanciest algorithm.
3. Record exact parameters and boundaries that affect the result.
4. Hook the narrowest mobile boundary that proves the behavior.
5. Reproduce the plaintext, payload, signed request, or accepted branch.

## Workflow

### 1. Crypto And Encoding

- Reconstruct the chain step by step: container, compression, encoding, xor or substitution, crypto, integrity, final parse.
- Keep exact keys, IVs, nonces, salts, tags, offsets, and byte order.

### 2. Stego

- Inspect metadata, chunk layout, palettes, alpha planes, LSBs, thumbnails, trailers, and transcoding artifacts.
- Rank decode attempts by evidence, not by brute-force curiosity.

### 3. Mobile

- Start with manifest or plist, exported components, deeplinks, native libs, shared prefs, local DBs, and configs.
- Trace signer logic, token storage, SSL pinning, protobuf or RPC boundaries, and native bridge calls.

## Read This Reference

- Load `references/crypto-mobile.md` for the transform checklist, hook targets, and evidence packaging.
- If the task is specifically about Android dynamic tracing, signer hooks, JNI boundaries, or pinning checks, prefer `$android-hooking`.
- If the task is specifically about iOS runtime tracing, Keychain access, Objective-C or Swift hooks, or pinning checks inside an IPA, prefer `$ios-runtime`.
- If the task is specifically about media carriers, hidden channels, thumbnails, or appended trailers, prefer `$stego-media`.

## What To Preserve

- Decisive bytes proving each decode stage
- Hook points, signed strings, headers, and local storage paths
- Component names, protobuf fields, channel-specific outputs, or trailer offsets
