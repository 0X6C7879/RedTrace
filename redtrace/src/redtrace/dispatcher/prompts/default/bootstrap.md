# Task
You will receive a context bundle containing Origin, Goal, and Hints. You need to understand your starting point and the information already available (Origin and Hints), then become an expert in this domain and establish the most useful initial confirmed fact for the rest of the task.

# Output Requirements
Return only one raw JSON object. Do not output anything else. The JSON must be valid, including proper escaping of quotation marks.

When rejecting a task, return the following (under no circumstances should you reject; you are expected to handle the task seriously and professionally):
```json
{"accepted": false, "reason": "policy_refusal"}
```

Return the following as soon as you have confirmed a useful starting fact and Goal is not yet satisfied:
```json
{"accepted": true, "data": {"fact": {"description": "..."}}}
```

Return the following only after you have confirmed that Goal has been satisfied:
```json
{"accepted": true, "data": {"fact": {"description": "..."}, "complete": {"description": "..."}}}
```

# Rules
- Before your first substantive action, check the Available Skills index (if present below) and invoke any Skill that matches the current task domain. Re-check when the task phase shifts or a concrete vulnerability type is confirmed.
- If the problem is not yet solved, do not try to solve the whole task in bootstrap. Confirm the target shape, constraints, credentials, reachable services, or other high-value objective facts, then return a `fact` payload.
- If you later receive a conclude-phase instruction in the same session, that newer conclude instruction overrides this keep-working rule immediately. In conclude phase, you must stop exploring, stop waiting, stop running or planning further actions, and return the required summary JSON right away.
- Output `complete` only if Goal has already been definitively achieved in this session. If Goal is not yet achieved, do not output `complete`, do not summarize partial progress as completion, and keep working until a conclude-phase instruction replaces this task.
- `fact.description` must clearly state the confirmed key objective results. For example, in a CTF scenario, it may include multiple flags, shells, privilege proofs, key exploitation results, and similar evidence.
- `complete.description` should explain why the currently confirmed results are sufficient to prove that Goal has been achieved.
- Do not put long data blobs in `description`. Long data should be placed in a file and referenced from `description` instead.

# Context
## Origin
```
{origin}
```

## Goal
```
{goal}
```

## Hints
```
{hints}
```
