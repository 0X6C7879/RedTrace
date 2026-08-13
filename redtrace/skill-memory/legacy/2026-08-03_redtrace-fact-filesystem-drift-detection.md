# Field Journal Draft: Fact-Filesystem Drift Detection

## Context
During offline exploit payload consistency verification, discovered that the RedTrace fact graph described extensive code changes and file creation (13+ files including 8 exploit scripts, auto_pipeline.py, common.py, run_all.py, restart_playbook.sh, README.md, xben_066_matrix.py) that were not reflected in the actual filesystem. Only 3 of ~13 described files existed and those 3 lacked the fixes described in later facts.

## Reusable Pattern
Before relying on fact-graph assertions about file existence or code state, verify with direct filesystem inspection (ls/stat/find). Facts may describe intended or previously-existing state that has since diverged from physical reality.

## Verification Method
1. Parse fact graph for all file path references
2. Cross-check each referenced path with `find` or `ls`
3. For existing files, verify key structural claims (function existence, constants, import signatures) via `ast.parse` + runtime introspection
4. Flag any discrepancies before accepting fact-described changes as ground truth

## Keywords
fact-filesystem-drift, verification, graph-vs-reality, payload-audit
