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

install -m 0644 "$SERVICE_FILE" /etc/systemd/system/mc-orchestrator.service
mkdir -p "$CONFIG_DIR"
if [[ ! -f "$CONFIG_FILE" ]]; then
  install -m 0644 "$CONFIG_EXAMPLE" "$CONFIG_FILE"
fi

mkdir -p /var/log/mc-orchestrator /var/lib/mc-orchestrator
chown -R pi:pi /var/log/mc-orchestrator /var/lib/mc-orchestrator
chown -R pi:pi "$CONFIG_DIR"

systemctl daemon-reload
systemctl enable mc-orchestrator.service
systemctl restart mc-orchestrator.service

echo "mc-orchestrator service installed and restarted"
