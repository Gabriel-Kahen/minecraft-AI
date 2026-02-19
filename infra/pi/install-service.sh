#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root"
  exit 1
fi

ROOT_DIR="/opt/mc"
SERVICE_FILE="${ROOT_DIR}/infra/pi/mc-orchestrator.service"
ENV_EXAMPLE="${ROOT_DIR}/infra/pi/mc-orchestrator.env.example"
ENV_FILE="/etc/mc-orchestrator.env"

install -m 0644 "$SERVICE_FILE" /etc/systemd/system/mc-orchestrator.service
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0644 "$ENV_EXAMPLE" "$ENV_FILE"
fi

mkdir -p /var/log/mc-orchestrator /var/lib/mc-orchestrator
chown -R pi:pi /var/log/mc-orchestrator /var/lib/mc-orchestrator

systemctl daemon-reload
systemctl enable mc-orchestrator.service
systemctl restart mc-orchestrator.service

echo "mc-orchestrator service installed and restarted"
