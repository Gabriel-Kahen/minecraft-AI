#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${LOG_DIR:-/var/log/mc-orchestrator}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

find "$LOG_DIR" -name "*.jsonl" -type f -mtime +1 -exec gzip -f {} \;
find "$LOG_DIR" -name "*.gz" -type f -mtime +"$RETENTION_DAYS" -delete
