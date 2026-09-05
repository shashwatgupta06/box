#!/usr/bin/env bash
# Start Box. Uses the project virtualenv if present, otherwise the system python.
set -e
cd "$(dirname "$0")"
PY=".venv/bin/python"
[ -x "$PY" ] || PY="python3"
exec "$PY" -m box run
