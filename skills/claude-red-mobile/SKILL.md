---
name: claude-red-mobile
description: Authorized Android and iOS application security testing across packages, local storage, IPC, deep links, transport, authentication, and runtime behavior. Use for mobile apps, APK/AAB/IPA artifacts, emulator or device testing, and app-to-backend trust analysis.
---

# Claude Red: Mobile

Use this Skill to combine static and dynamic mobile evidence without treating client-side observations as confirmed server impact.

## Workflow

1. Confirm application identifiers, versions, platforms, test accounts, devices, backend scope, and permitted instrumentation.
2. Read [offensive-mobile.md](references/offensive-mobile.md), selecting only the Android, iOS, or shared workflow needed.
3. Preserve and hash the original artifact; inspect signing, entitlements/manifest, exported surfaces, storage, networking, and embedded secrets.
4. Form concrete hypotheses from static evidence and validate them at runtime on an isolated device or emulator.
5. Re-test server-side authorization independently of client controls.
6. Capture version-specific evidence, prerequisites, user interaction, impact, cleanup, and limitations caused by device or OS differences.

## Tool readiness

Check required commands before use. If a tool is missing, follow RedTrace's common missing-tool bootstrap: search official documentation or releases online, choose an OS/architecture-compatible user-local installation, verify its checksum or provenance and run a version/smoke check, then reuse it. Do not guess command syntax, loop on installation, or block the assessment when a bounded fallback exists.

## Validation standard

Require reproducible behavior on the named app and platform version. Hardcoded values, local flags, and bypassed client checks are not vulnerabilities unless they enable meaningful unauthorized behavior.

## Safety boundary

Use designated accounts and devices. Do not collect unrelated personal data, bypass platform protections beyond scope, or modify production backends.
