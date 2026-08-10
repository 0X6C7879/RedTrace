# RedTrace WebShell Design QA

final result: passed

---

# RedTrace Carbon Ember Blackboard Design QA

## Source and implementation

- Selected concept: `C:/Users/ASUS/.codex/generated_images/019f9eec-9782-7973-a1a5-48c347be5d43/call_y8NCLGBEwP9Oh4nE0t8wk50p.png`.
- Concept dimensions: 1675 x 939.
- Implementation: `redtrace/src/redtrace/server/static/redtrace-theme.css` plus Carbon Ember Cytoscape styles in `redtrace/src/redtrace/server/static/index.html`.
- Font assets: Tektur, JetBrains Mono, and Pixelify Sans copied into `redtrace/src/redtrace/server/static/fonts/` with `fonts/LICENSE-lucy.txt`.
- Combined comparison: `output/design-qa/redtrace-carbon-ember-comparison-final.png`.
- Complete blackboard capture: `output/design-qa/redtrace-carbon-ember-blackboard-full.png`.
- Browser capture viewport: 1424 x 939 (the selected concept remains the 1675 x 939 art-direction source).

## Visual checks

- Preserved the workbench's left navigation, project header, Cytoscape canvas, right inspector, resizer, and blackboard graph layout.
- Restyled node shells and edges only: coral target/goal, green origin/concluded paths, cyan facts, violet resources, and amber in-progress paths now read clearly on the carbon grid.
- Kept node labels, graph relationships, dagre rank direction, spacing, and fit behavior unchanged.
- Applied the same high-contrast system to Skills, MCP, Plugins, Logs, Settings, WebShell, and all C2 pages.
- Reused the existing favicon and inline icon system; no new decorative image assets were introduced.
- Verified light text stays distinct from dark surfaces and status colors remain semantically consistent.

## Functional and responsive checks

- Browser interaction path verified: project list → blackboard → Hints/Log inspector tabs, Skills/MCP/Plugins/Logs/Settings navigation, C2 expansion, Payload navigation, and WebShell terminal/file-manager tabs.
- At 1424 x 939, the complete blackboard inspector remains visible with the original resizable split.
- At 390 x 844, the mobile shell collapses navigation to icon rail while the blackboard intentionally remains a horizontally scrollable canvas to protect graph geometry.
- Added explicit navigation labels so the collapsed mobile icon rail remains accessible.
- Targeted regression suite: 20 passed (`test_capabilities.py`, `test_audit.py`, `test_operations.py`).
- Static asset checks: theme stylesheet and Tektur/JetBrains Mono font files returned HTTP 200.

## QA fixes

- Added Carbon Ember tokens, font faces, responsive shell rules, inspector surfaces, operations/C2 terminal styling, and audit-console styling.
- Added graph semantic selectors so target/resource facts receive the selected coral/violet treatments without changing data or layout.
- Added reduced-motion and increased-contrast fallbacks for the new feedback and glow effects.
- Kept the existing `design-qa.md` reports intact and added this final comparison record.

final result: passed

## Design decision

- Migrated CyberStrikeAI's WebShell information architecture and task flow without copying its dark product skin.
- Kept RedTrace's light navigation, slate typography, indigo selection states, compact desktop density, and restrained motion.
- Kept the terminal dark because it is a work surface, not a page-wide theme.
- Removed AI assistant and memo features from the WebShell workspace.

## Reference and comparison

- RedTrace layout reference: the user-supplied current RedTrace screenshot.
- File manager interaction reference: the user-supplied tree/table/context-menu screenshot.
- Terminal prompt reference: the user-supplied `(user:path) $` prompt crop.
- Browser viewport used for final capture: 1898 × 911.
- Combined comparison: `output/design-qa/webshell-comparison-final.png`.
- Final captures:
  - `output/design-qa/webshell-terminal-final.png`
  - `output/design-qa/webshell-files-final.png`

## Visual checks

- Existing RedTrace sidebar width, spacing, background, icon treatment, and active navigation state are preserved.
- WebShell keeps the expected connection-list/workspace split while using RedTrace borders, radii, colors, and hierarchy.
- Terminal prompt matches the supplied compact `(user:path) $` pattern and keeps commands and output visually scannable.
- File management uses a directory tree, a path bar, a sortable-density table layout, and Name/Modified/Size/Permissions columns.
- Toolbars, editor, dialogs, context menu, disabled states, focus states, and reduced-motion behavior are consistent with the existing product.
- No clipped controls, stray menus, incorrect dark page chrome, or visible Alpine initialization artifacts remained in the final captures.

## Functional checks

- Tested the supplied PHP eval-shell pattern `<?php @eval($_POST['cmd']); ?>`.
- Verified connectivity and real `whoami` execution from the terminal, including Enter-key submission and reactive result rendering.
- Verified directory listing, directory traversal, file reading, file editing, file saving, and context-menu opening in the browser.
- Verified backend directory creation, structured listing, file write/read, rename, and approval-gated recursive deletion against the same live PHP eval shell.
- Verified WebShell secret redaction and the shared asynchronous task/result/audit path with automated tests.
- Targeted regression suite: 24 passed.
- Full suite: 114 passed; 12 existing Windows/POSIX runtime tests still fail because they require `python3`, `sh`, and POSIX process-group APIs such as `os.killpg`.

## QA fixes

- Replaced the CyberStrikeAI-like full dark skin with RedTrace-native light application chrome.
- Replaced the primitive path/textarea file controls with the full directory-tree and file-table workflow.
- Fixed WebShell terminal history updates so completed output replaces the pending state reactively.
- Added direct Enter-key command submission.
- Fixed the context-menu style binding so a closed menu cannot appear at the top-left corner.
- Initialized the file manager from the resource's configured working directory.

---

# RedTrace Global Plugin Management Design QA

## Source and implementation

- Source: `C:/Users/ASUS/AppData/Local/Temp/codex-clipboard-fcd3e772-5851-4875-9546-4b3be9bd94d9.png`
- Source dimensions: 1912 × 911.
- Implementation overview: `output/plugin-page-qa/plugins-global-final.png`
- Implementation detail: `output/plugin-page-qa/plugins-detail-final.png`
- Implementation viewport: 1730 × 911; captured bitmap: 1729 × 911.
- State: global plugin page with both migrated plugins enabled; browser plugin selected in the focused detail capture.
- Combined comparison: `output/plugin-page-qa/plugin-comparison-final.png`

## Full comparison

- Preserved the RedTrace sidebar, typography, slate dividers, indigo active navigation, compact header, and restrained status colors.
- Removed the project selector, project-scoped resource counters, task approval counters, and “select a project” gate.
- Replaced the empty project canvas with the Skills/MCP list-detail pattern and a global `RedTrace/plugins` directory label.
- Added visible Claude, Codex, and Pi compatibility badges, a single enabled-count badge, refresh, and add-plugin actions.
- Kept the main work surface quiet until a plugin is selected; the focused state exposes readiness, enablement, registry removal, save, and the complete manifest entry.

## Typography, spacing, color, icons, and copy

- Typography and density match the existing Skills/MCP screens: 53 px header, 288 px list rail, 12 px editor copy, and compact 10 px metadata.
- Spacing is aligned to existing 8/12/16/20 px product increments; no clipped or horizontally scrolling controls remained at the verified viewport.
- Violet is limited to plugin enabled state, while teal, amber, and red retain readiness, warning, and destructive semantics.
- Reused RedTrace’s existing plug, refresh, add, and search icon geometry rather than introducing a new icon language.
- Copy consistently describes global management, the canonical directory, and next-task Worker snapshot behavior.

## Interaction and accessibility checks

- Verified both migrated plugins load from the global registry without selecting a project.
- Verified selecting a plugin opens its full manifest entry.
- Verified enable → disable → enable persists through the API and restores the original state.
- Verified the page exposes unique accessible names for navigation, plugin rows, refresh, add, enablement, save, and removal.
- Verified no browser console errors.

## Iteration history

1. Split Plugins away from the project-scoped operations page.
2. Added the global registry list, compatibility badges, and canonical directory label.
3. Added the focused editor state and adjusted the verification viewport so all header actions remain visible.
4. Re-tested enablement and restored both migrated plugins to enabled.

final result: passed
