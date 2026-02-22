#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root"
  exit 1
fi

ROOT_DIR="/opt/mc"
SERVICE_FILE="${ROOT_DIR}/infra/pi/mc-orchestrator.service"
CONFIG_EXAMPLE="${ROOT_DIR}/infra/pi/config.yaml.example"
CONFIG_DIR="/etc/mc-orchestrator"
CONFIG_FILE="${CONFIG_DIR}/config.yaml"
SERVICE_USER="${SUDO_USER:-}"

if [[ -z "$SERVICE_USER" ]]; then
  SERVICE_USER="$(stat -c '%U' "$ROOT_DIR" 2>/dev/null || true)"
fi
if [[ -z "$SERVICE_USER" || "$SERVICE_USER" == "root" ]]; then
  SERVICE_USER="$(logname 2>/dev/null || true)"
fi
if [[ -z "$SERVICE_USER" || "$SERVICE_USER" == "root" ]]; then
  SERVICE_USER="pi"
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Configured service user '$SERVICE_USER' does not exist"
  exit 1
fi

trim_ws() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf "%s" "$value"
}

read_yaml_value() {
  local file="$1"
  local key="$2"
  local line
  line="$(grep -E "^[[:space:]]*${key}:[[:space:]]*" "$file" | head -n 1 || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi

  local value="${line#*:}"
  value="$(trim_ws "$value")"
  value="${value%%#*}"
  value="$(trim_ws "$value")"
  if [[ -z "$value" ]]; then
    return 1
  fi
  printf "%s" "$value"
}

upsert_yaml_value() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -Eq "^[[:space:]]*${key}:[[:space:]]*" "$file"; then
    sed -i -E "s|^[[:space:]]*${key}:[[:space:]]*.*$|${key}: ${value}|" "$file"
  else
    printf "%s: %s\n" "$key" "$value" >> "$file"
  fi
}

sync_missing_keys_from_example() {
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Za-z0-9_]+): ]] || continue
    local key="${BASH_REMATCH[1]}"
    if ! grep -Eq "^[[:space:]]*${key}:[[:space:]]*" "$CONFIG_FILE"; then
      local value
      value="$(read_yaml_value "$CONFIG_EXAMPLE" "$key" || true)"
      if [[ -n "$value" ]]; then
        upsert_yaml_value "$CONFIG_FILE" "$key" "$value"
      fi
    fi
  done < "$CONFIG_EXAMPLE"
}

sync_managed_keys_from_example() {
  local managed_keys=(
    BOT_COUNT
    ORCH_TICK_MS
    SNAPSHOT_REFRESH_MS
    SNAPSHOT_NEARBY_CACHE_MS
    SNAPSHOT_NEARBY_RESCAN_DISTANCE
    BOT_START_STAGGER_MS
    RECONNECT_BASE_DELAY_MS
    RECONNECT_JITTER_MS
    MAX_CONCURRENT_SKILLS
    ALWAYS_ACTIVE_MODE
    ALWAYS_ACTIVE_REQUEUE_MS
    SUBGOAL_EXEC_TIMEOUT_MS
    SUBGOAL_IDLE_STALL_MS
    SUBGOAL_RETRY_LIMIT
    SUBGOAL_RETRY_BASE_DELAY_MS
    SUBGOAL_RETRY_MAX_DELAY_MS
    SUBGOAL_LOOP_GUARD_REPEATS
    SUBGOAL_FAILURE_STREAK_WINDOW_MS
    CHAT_STATUS_ENABLED
    CHAT_STATUS_INTERVAL_MS
    CHAT_TASK_EVENTS_ENABLED
    CHAT_TASK_EVENT_MIN_MS
    CHAT_MIN_INTERVAL_MS
    CHAT_DUPLICATE_WINDOW_MS
    CHAT_INCLUDE_STEPS
    LLM_HISTORY_LIMIT
    PLANNER_TIMEOUT_MS
    PLANNER_MAX_RETRIES
    PLANNER_FEASIBILITY_REPROMPT_ENABLED
    PLANNER_FEASIBILITY_REPROMPT_MAX_ATTEMPTS
    MAX_CONCURRENT_EXPLORERS
    LOCK_LEASE_MS
    LOCK_HEARTBEAT_MS
    PLANNER_COOLDOWN_MS
    PLAN_PREFETCH_ENABLED
    PLAN_PREFETCH_MIN_INTERVAL_MS
    PLAN_PREFETCH_MAX_AGE_MS
    PLAN_PREFETCH_RESERVE_CALLS
  )

  local key
  for key in "${managed_keys[@]}"; do
    local value
    value="$(read_yaml_value "$CONFIG_EXAMPLE" "$key" || true)"
    if [[ -n "$value" ]]; then
      upsert_yaml_value "$CONFIG_FILE" "$key" "$value"
    fi
  done
}

SERVICE_TMP="$(mktemp)"
cp "$SERVICE_FILE" "$SERVICE_TMP"
sed -i -E "s|^User=.*$|User=${SERVICE_USER}|" "$SERVICE_TMP"
install -m 0644 "$SERVICE_TMP" /etc/systemd/system/mc-orchestrator.service
rm -f "$SERVICE_TMP"
mkdir -p "$CONFIG_DIR"
if [[ ! -f "$CONFIG_FILE" ]]; then
  install -m 0644 "$CONFIG_EXAMPLE" "$CONFIG_FILE"
fi
sync_missing_keys_from_example
sync_managed_keys_from_example

mkdir -p /var/log/mc-orchestrator /var/lib/mc-orchestrator
chown -R "${SERVICE_USER}:${SERVICE_USER}" /var/log/mc-orchestrator /var/lib/mc-orchestrator
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$CONFIG_DIR"

systemctl daemon-reload
systemctl enable mc-orchestrator.service
systemctl restart mc-orchestrator.service

echo "mc-orchestrator service installed and restarted (user=${SERVICE_USER})"
