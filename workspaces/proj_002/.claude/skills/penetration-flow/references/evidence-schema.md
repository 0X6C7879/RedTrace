# Evidence and State Schema

Recommended JSON state:

```json
{
  "objective": "",
  "scope": "",
  "roe": {
    "authorization_status": "unknown|confirmed|limited",
    "allowed_actions": [],
    "forbidden_actions": [],
    "testing_window": "",
    "rate_limits": "",
    "emergency_contact": ""
  },
  "phase": "analysis|snapshot|deep-pentest|vuln-report|validation|reverse|final",
  "assets": [],
  "artifacts": [],
  "evidence": [],
  "findings": [],
  "hypotheses": [],
  "decisions": []
}
```

Evidence item:

```json
{
  "id": "E-001",
  "type": "log|screenshot|command|source|binary|capture|request|response|note",
  "source": "",
  "summary": "",
  "path_or_url": "",
  "timestamp": "",
  "hash": "",
  "confidence": "low|medium|high"
}
```

Finding item:

```json
{
  "id": "F-001",
  "title": "",
  "severity": "Info|Low|Medium|High|Critical",
  "status": "lead|confirmed|fixed|accepted-risk",
  "affected_assets": [],
  "preconditions": "",
  "impact": "",
  "evidence_ids": [],
  "remediation": "",
  "verification": ""
}
```
