#!/usr/bin/env bash
# Usage: ./run-local-test.sh [flagged|clean] [model] [--v1]
set -euo pipefail
cd "$(dirname "$0")"
node local_test.js "${1:-flagged}" "${2:-${OLLAMA_MODEL:-llama3.2:3b}}" "${3:-}"
