# MISC Competition Checklist

Use this as a fast triage path for mixed-category MISC challenges.

## First-pass triage (60s)

- file type (`file`, `xxd`, `binwalk`)
- obvious encodings (base64/base32/hex/url)
- archive signals (zip/7z/gz/bz2/xz)
- text artifacts (flag format string, hints, comments)

## Second-pass (5min)

- decoding chain attempts (multiple layers)
- nested archive extraction loop
- image/audio quick checks (strings/exif/spectro)
- qr/barcode decode attempts

## Third-pass (pattern switch)

- protocol/traffic hints (pcap artifacts)
- structured data puzzles (tables, grids, constraints)
- misc crypto linkage (encoding + weak crypto combination)

## Submission discipline

- validate flag format before submit
- avoid noisy submits; deduplicate evidence
- keep minimal proof snapshot (command + output snippet)
