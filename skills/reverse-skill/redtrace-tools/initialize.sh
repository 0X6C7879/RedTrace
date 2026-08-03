#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REVERSE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
UPSTREAM_ROOT="$REVERSE_ROOT/upstream"
SKILLS_ROOT="$UPSTREAM_ROOT/skills"
OUTPUT_MD="$SKILLS_ROOT/tool-index.md"
OUTPUT_JSON="$SKILLS_ROOT/tool-index.json"
LOCK_FILE="$SKILLS_ROOT/.redtrace-tool-index.lock"
LOCK_DIR="$LOCK_FILE.d"
LOCK_KIND=""
TMP_MD=""
TMP_JSON=""

cleanup() {
  [[ -z "$TMP_MD" ]] || rm -f -- "$TMP_MD"
  [[ -z "$TMP_JSON" ]] || rm -f -- "$TMP_JSON"
  [[ "$LOCK_KIND" != "directory" ]] || rmdir -- "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

for command_name in bash python3 jq; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'reverse-skill dependency is missing: %s\n' "$command_name" >&2
    exit 1
  }
done

chmod +x "$SCRIPT_DIR/field-journal/write.py"

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock 9
  LOCK_KIND="flock"
else
  _attempt=0
  while ((_attempt < 100)); do
    if mkdir -- "$LOCK_DIR" 2>/dev/null; then
      LOCK_KIND="directory"
      break
    fi
    _attempt=$((_attempt + 1))
    sleep 0.1
  done
  [[ "$LOCK_KIND" == "directory" ]] || {
    printf 'timed out waiting for reverse-skill tool-index lock\n' >&2
    exit 1
  }
fi

TMP_MD="$(mktemp "$SKILLS_ROOT/.tool-index.md.XXXXXX")"
TMP_JSON="$(mktemp "$SKILLS_ROOT/.tool-index.json.XXXXXX")"

if [[ -r /etc/os-release ]] && grep -Eq '^ID=("?kali"?)$' /etc/os-release; then
  REFRESH_SCRIPT="$UPSTREAM_ROOT/kali/scripts/refresh-tool-index.sh"
else
  REFRESH_SCRIPT="$SKILLS_ROOT/scripts/refresh-tool-index.sh"
fi

bash "$REFRESH_SCRIPT" "$TMP_MD" "$TMP_JSON"
[[ -s "$TMP_MD" ]] || { printf 'reverse-skill generated an empty tool-index.md\n' >&2; exit 1; }
python3 -m json.tool "$TMP_JSON" >/dev/null

mv -- "$TMP_MD" "$OUTPUT_MD"
TMP_MD=""
mv -- "$TMP_JSON" "$OUTPUT_JSON"
TMP_JSON=""
chmod 644 "$OUTPUT_MD" "$OUTPUT_JSON"

printf 'reverse-skill initialized: %s and %s\n' "$OUTPUT_MD" "$OUTPUT_JSON"
