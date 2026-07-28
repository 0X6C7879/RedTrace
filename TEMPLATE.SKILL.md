---
name: <skill-name>
description: >-
  <one-paragraph summary of what this skill covers and when to use it>
---

# <Skill Title>

> **AUTHORIZED TESTING ONLY.** Use only on assets you own or have explicit permission to test.

## Overview

- **Goal**: <what this skill helps you detect/exploit>
- **When to use**: <symptoms, indicators, or request patterns>
- **Outcomes**: <what you can prove/report if successful>

## Requirements

- Python 3.9+
- `pip install requests`
- Optional: Burp Suite / browser devtools / <other>

## Usage

### CLI

```bash
python scripts/<main_script>.py --help
python scripts/<main_script>.py -u "<target_url>"
```

### Example

```bash
# minimal reproducible test
python scripts/<main_script>.py -u "http://localhost:8080/vulnerable"
```

## Scope

- In-scope targets: web apps you own or are authorized to test
- Typical entry points: <params/forms/headers/cookies/files>
- Related modules: <cross-links to other exploit-* skills if applicable>

## Detection / Methodology

1. <step 1>
2. <step 2>
3. <step 3>

## Bypass / Advanced Techniques

- <filter/waf bypass 1>
- <framework-specific note>

## Risks & Rules of Engagement

- Avoid destructive actions on production systems
- Keep payloads minimal and reversible
- Document proof with request/response evidence

## References

- references/<file1>.md
- references/<file2>.md
- <external official docs if any>

## Tests

```bash
python -m pytest -q
```
