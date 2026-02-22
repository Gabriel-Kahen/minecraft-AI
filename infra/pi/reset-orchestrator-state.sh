#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  sudo infra/pi/reset-orchestrator-state.sh [--no-start]

What this does:
  - Stops mc-orchestrator.service
  - Clears orchestrator runtime state (SQLite/data/blueprints)
  - Clears orchestrator logs
  - Recreates directories with service user ownership
  - Restarts service (unless --no-start is set)
EOF
}

NO_START=0
for arg in "$@"; do
  case "$arg" in
    --no-start)
      NO_START=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (use sudo)." >&2
  exit 1
fi

CONFIG_FILE="/etc/mc-orchestrator/config.yaml"
SERVICE_FILE="/etc/systemd/system/mc-orchestrator.service"

DATA_DIR="/var/lib/mc-orchestrator"
BLUEPRINT_DIR="/var/lib/mc-orchestrator/blueprints"
LOG_DIR="/var/log/mc-orchestrator"
SQLITE_FILE="/var/lib/mc-orchestrator/state.sqlite"
SERVICE_USER="pi"
SERVICE_GROUP="pi"

read_yaml_value() {
  local key="$1"
  local default_value="$2"
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "$default_value"
    return
  fi
  local line
  line="$(grep -E "^[[:space:]]*${key}:[[:space:]]*" "$CONFIG_FILE" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    echo "$default_value"
    return
  fi
  local value
  value="$(echo "$line" | sed -E "s/^[[:space:]]*${key}:[[:space:]]*//" | sed -E 's/[[:space:]]+#.*$//' | sed -E 's/^\"(.*)\"$/\1/' | sed -E "s/^'(.*)'$/\1/")"
  if [[ -z "$value" ]]; then
    echo "$default_value"
    return
  fi
  echo "$value"
}

DATA_DIR="$(read_yaml_value DATA_DIR /var/lib/mc-orchestrator)"
BLUEPRINT_DIR="$(read_yaml_value BLUEPRINT_DIR "${DATA_DIR}/blueprints")"
LOG_DIR="$(read_yaml_value LOG_DIR /var/log/mc-orchestrator)"
SQLITE_FILE="$(read_yaml_value SQLITE_FILE "${DATA_DIR}/state.sqlite")"

if [[ -f "$SERVICE_FILE" ]]; then
  USER_LINE="$(grep -E '^User=' "$SERVICE_FILE" || true)"
  GROUP_LINE="$(grep -E '^Group=' "$SERVICE_FILE" || true)"
  if [[ -n "$USER_LINE" ]]; then
    SERVICE_USER="${USER_LINE#User=}"
  fi
  if [[ -n "$GROUP_LINE" ]]; then
    SERVICE_GROUP="${GROUP_LINE#Group=}"
  else
    SERVICE_GROUP="$SERVICE_USER"
  fi
fi

echo "Stopping mc-orchestrator.service"
systemctl stop mc-orchestrator.service || true

pkill -f "dist/apps/orchestrator/src/index.js" || true
pkill -f "npm run --workspace @mc/orchestrator start" || true

echo "Clearing orchestrator state"
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

mkdir -p "$BLUEPRINT_DIR"
rm -rf "${BLUEPRINT_DIR:?}/"*

if [[ -n "$SQLITE_FILE" ]]; then
  rm -f "$SQLITE_FILE"
fi

echo "Clearing orchestrator logs"
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.jsonl "$LOG_DIR"/*.log "$LOG_DIR"/*.err "$LOG_DIR"/*.gz || true

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$DATA_DIR" "$LOG_DIR"

if [[ "$NO_START" -eq 0 ]]; then
  echo "Starting mc-orchestrator.service"
  systemctl start mc-orchestrator.service
  systemctl --no-pager --full status mc-orchestrator.service | sed -n '1,20p'
else
  echo "Skipped service start (--no-start)."
fi

echo "Orchestrator state reset complete."
