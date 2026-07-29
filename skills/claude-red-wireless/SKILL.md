---
name: claude-red-wireless
description: Authorized wireless assessment across Wi-Fi, Bluetooth, WPA, WPS, LoRaWAN, Zigbee, Thread, Matter, Z-Wave, and related radio workflows. Use for radio reconnaissance, authentication analysis, protocol validation, or controlled wireless attack simulation.
---

# Claude Red: Wireless

Use this Skill to choose a protocol-specific workflow while controlling radio scope and interference.

## Route the task

| Area | Reference |
| --- | --- |
| Wi-Fi discovery | [offensive-wifi-recon.md](references/offensive-wifi-recon.md) |
| WPA2-PSK | [offensive-wpa2-psk.md](references/offensive-wpa2-psk.md) |
| WPA3-SAE | [offensive-wpa3-sae.md](references/offensive-wpa3-sae.md) |
| WPA Enterprise | [offensive-wpa-enterprise.md](references/offensive-wpa-enterprise.md) |
| WPS | [offensive-wps.md](references/offensive-wps.md) |
| Deauthentication/disassociation | [offensive-deauth-disassoc.md](references/offensive-deauth-disassoc.md) |
| Evil twin | [offensive-evil-twin.md](references/offensive-evil-twin.md) |
| KRACK/FragAttacks | [offensive-krack-fragattacks.md](references/offensive-krack-fragattacks.md) |
| Bluetooth Low Energy | [offensive-bluetooth-ble.md](references/offensive-bluetooth-ble.md) |
| Bluetooth Classic | [offensive-bluetooth-classic.md](references/offensive-bluetooth-classic.md) |
| LoRaWAN/sub-GHz | [offensive-lorawan-sub-ghz.md](references/offensive-lorawan-sub-ghz.md) |
| Zigbee/Thread/Matter | [offensive-zigbee-thread-matter.md](references/offensive-zigbee-thread-matter.md) |
| Z-Wave | [offensive-z-wave.md](references/offensive-z-wave.md) |

Load only the references needed for the protocol and objective.

## Workflow

1. Confirm protocol, frequencies/channels, physical area, owned identifiers, permitted active techniques, regulatory constraints, and stop conditions.
2. Establish passive observations and a baseline before transmitting.
3. Select hardware and tooling compatible with the band, chipset, driver, OS, and protocol revision.
4. Validate with the lowest power, shortest duration, and narrowest identifiers that prove the behavior.
5. Correlate captures, timestamps, device state, and protocol-level responses; preserve raw evidence where permitted.
6. Restore modified test infrastructure and document interference risk, false-positive boundaries, and environmental limitations.

## Tool readiness

Check required commands before use. If a tool is missing, follow RedTrace's common missing-tool bootstrap: search official documentation or releases online, choose an OS/architecture-compatible user-local installation, verify its checksum or provenance and run a version/smoke check, then reuse it. Do not guess command syntax, loop on installation, or block the assessment when a bounded fallback exists.

## Validation standard

Require protocol evidence tied to an in-scope device and reproducible state change or security consequence. Signal presence, a vendor identifier, or a generic handshake alone is not a vulnerability.

## Safety boundary

Do not transmit outside the authorized band, area, identifiers, or time window. Avoid uncontrolled jamming, credential capture from third parties, and disruption of safety-critical or neighboring systems.
