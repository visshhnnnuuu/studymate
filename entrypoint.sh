#!/usr/bin/env sh
set -eu
python3 /app/rag_service.py &
RAG_PID=$!
trap 'kill "$RAG_PID" 2>/dev/null || true' EXIT
exec node /app/server.mjs
