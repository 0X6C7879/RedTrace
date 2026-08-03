---
name: reverse-skill
description: Provides the complete reverse-skill security routing, case, tool bootstrap and index, specialist modules, CTF orchestration, and direct field-journal experience write-back through RedTrace's shared Skill directory.
license: MIT
metadata:
  source: https://github.com/zhaoxuya520/reverse-skill
  revision: cab837a298fec6fa28a49ef746d0085e0b112cfa
  redtrace-overlay: REDTRACE_RULES.md
---

# reverse-skill in RedTrace

The complete upstream project is pinned under `upstream/`. Read
`REDTRACE_RULES.md` first, then `upstream/RULES.md`; execute
`upstream/skills/SKILL.md` and the matching
specialist module. Its case, scope, timeline, workitems, tool index, bootstrap,
report, and field-journal mechanisms remain available unchanged.

## RedTrace integration

- `upstream/` is the reverse-skill package root. Resolve all upstream relative
  paths from there.
- RedTrace injects this shared Skill into Claude, Codex, and Pi for every Worker.
  This satisfies reverse-skill's global routing injection inside RedTrace; do
  not copy rules into host-user `~/.claude`, `~/.codex`, `~/.pi`, `~/.kiro`, or
  other external client configuration.
- Create reverse-skill `work/<case>` state in the active RedTrace task Workspace,
  not inside an Agent user configuration directory.
- Use the native shared `upstream/skills/tool-index.md` and its refresh/bootstrap
  scripts. Install or start tools only inside the active RedTrace Worker/runtime;
  never mutate host-user Agent configuration.
- RedTrace is non-interactive orchestration. Automatically choose and execute the
  best-supported next step; never pause for an upstream next-step menu.
- At task completion, the same Worker writes the anonymized entry directly to
  `upstream/skills/field-journal/` through
  `redtrace-tools/field-journal/write.py`, which updates `_index.md` under the
  same lock. Do not submit a RedTrace evolution proposal or invoke a separate
  verification Worker.

Load only the primary specialist Skill plus at most one concrete complement;
do not preload the full package.
