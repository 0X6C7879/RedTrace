# Reporting Templates

## Interim snapshot

```markdown
## Snapshot ? <date/time>

### Objective and scope
- Objective:
- In scope:
- Out of scope / constraints:

### Current phase
- Phase:
- Since last update:

### Evidence
| ID | Type | Source | Summary | Path/URL | Confidence |
|---|---|---|---|---|---|

### Findings
| ID | Title | Severity | Status | Evidence |
|---|---|---|---|---|

### Leads / hypotheses
| ID | Hypothesis | Why it matters | Next test | Risk |
|---|---|---|---|---|

### Next-step menu
1. ...
```

## Vulnerability finding

```markdown
### <ID>: <Title>

- Severity: <Critical/High/Medium/Low/Info>
- Status: <Confirmed/Partially confirmed/Lead>
- Affected assets: <asset/component/version>
- Preconditions: <access, role, network position, feature flag>
- Summary: <one paragraph>
- Impact: <technical and business impact>
- Evidence: <logs, screenshots, commands, hashes, requests, code refs>
- Reproduction: <bounded summary, avoid unnecessary operational detail>
- Root cause: <code/config/design issue>
- Remediation: <specific fix>
- Verification: <how to prove fixed>
- References: <CWE/CVE/vendor/docs>
```

## Final report structure

1. Executive summary
2. Scope and ROE
3. Methodology
4. Findings summary table
5. Detailed findings
6. Reverse-engineering appendix, if applicable
7. Evidence appendix
8. Remediation roadmap
9. Retest checklist
```
