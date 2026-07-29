---
name: claude-red-iot
description: Authorized IoT hardware, firmware, local service, and device-protocol assessment. Use for firmware extraction, embedded filesystems, debug interfaces, boot chains, device APIs, companion services, or hardware-backed security validation.
---

# Claude Red: IoT

Use this Skill to assess an IoT device as a connected system while preserving hardware and evidence.

## Workflow

1. Confirm device ownership, model and revision, firmware version, interfaces, permitted physical access, and recovery method.
2. Read [offensive-iot.md](references/offensive-iot.md) and select the relevant hardware, firmware, service, or protocol sections.
3. Acquire artifacts non-destructively when possible; hash firmware and preserve an untouched copy.
4. Analyze offline first, then validate only the smallest live interaction needed to establish impact.
5. Correlate firmware findings with reachable interfaces and real device state rather than assuming packaged code is active.
6. Record wiring, voltages, versions, checksums, commands, observations, cleanup, and recovery steps.

## Tool readiness

Check required commands before use. If a tool is missing, follow RedTrace's common missing-tool bootstrap: search official documentation or releases online, choose an OS/architecture-compatible user-local installation, verify its checksum or provenance and run a version/smoke check, then reuse it. Do not guess command syntax, loop on installation, or block the assessment when a bounded fallback exists.

## Validation standard

Require a reproducible path from reachable input to device behavior. Firmware strings, dormant components, and generic default-credential lists are leads, not findings.

## Safety boundary

Confirm voltage and pinout before hardware access. Avoid irreversible writes, unsafe radio transmission, bricking risk, or actions that affect neighboring devices.
