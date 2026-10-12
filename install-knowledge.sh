#!/usr/bin/env bash
# Offline by default. Online acquisition requires the explicit --online maintenance flag.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DATA="${REDTRACE_DATA_DIR:-$ROOT/.redtrace/data/knowledge}"
RUNTIME="$ROOT/.redtrace/runtime/knowledge"
ONLINE=false
PACKAGE=""
while (($#)); do
  case "$1" in
    --online) ONLINE=true ;;
    --offline) ONLINE=false ;;
    --package) shift; PACKAGE="${1:?--package requires a local archive}" ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$RUNTIME/wheelhouse" "$ROOT/.redtrace/maintenance"
# Reuse an existing environment; recreating it with macOS /usr/bin/python3 can mix interpreter versions.
if [[ ! -x "$RUNTIME/bin/python" ]]; then
  PYTHON="${REDTRACE_KNOWLEDGE_BOOTSTRAP_PYTHON:-python3}"
  "$PYTHON" -c 'import sys; assert sys.version_info >= (3, 12), "Python >=3.12 required; set REDTRACE_KNOWLEDGE_BOOTSTRAP_PYTHON to a matching interpreter"'
  "$PYTHON" -m venv "$RUNTIME"
fi
"$RUNTIME/bin/python" -c 'import sys; assert sys.version_info >= (3, 12), "Existing offline runtime needs Python >=3.12"'
if [[ "$ONLINE" == true ]]; then
  "$RUNTIME/bin/python" -m pip wheel --wheel-dir "$RUNTIME/wheelhouse" -r "$ROOT/tools/knowledge/requirements.txt"
fi
# Never let an offline installer silently reach PyPI or a Go proxy.
"$RUNTIME/bin/python" -m pip install --no-index --find-links "$RUNTIME/wheelhouse" -r "$ROOT/tools/knowledge/requirements.txt"
if [[ -n "$PACKAGE" ]]; then
  "$RUNTIME/bin/python" "$ROOT/tools/knowledge/knowledge.py" import --root "$DATA" --package "$PACKAGE"
elif [[ "$ONLINE" == true ]]; then
  TEMPLATES="${REDTRACE_NUCLEI_TEMPLATES_DIR:-$ROOT/.redtrace/maintenance/nuclei-templates}"
  EXPLOITDB="${REDTRACE_EXPLOITDB_DIR:-$ROOT/.redtrace/maintenance/exploitdb}"
  NVD="${REDTRACE_NVD_DIR:-$ROOT/.redtrace/maintenance/nvd}"
  for entry in "$TEMPLATES|https://github.com/projectdiscovery/nuclei-templates.git" "$EXPLOITDB|https://gitlab.com/exploit-database/exploitdb.git"; do
    directory="${entry%%|*}"; url="${entry#*|}"
    if [[ ! -d "$directory" ]]; then git clone --depth=1 "$url" "$directory"; fi
    [[ -d "$directory/.git" ]] && git -C "$directory" rev-parse HEAD > "$directory/.release"
  done
  years=(); for ((year=2002; year<=$(date +%Y); year++)); do years+=("$year"); done
  "$RUNTIME/bin/python" "$ROOT/tools/knowledge/knowledge.py" fetch --directory "$NVD" --years "${years[@]}"
  "$RUNTIME/bin/python" "$ROOT/tools/knowledge/knowledge.py" build --root "$DATA" --nuclei "$TEMPLATES" --exploitdb "$EXPLOITDB" --nvd "$NVD"
else
  printf 'Offline runtime prepared. Supply --package for data import or run the local build command; no data was downloaded.\n'
fi
