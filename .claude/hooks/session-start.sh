#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
pip install -q -r requirements.txt
(cd frontend && npm install --no-audit --no-fund)
echo 'export PYTHONPATH="."' >> "$CLAUDE_ENV_FILE"
