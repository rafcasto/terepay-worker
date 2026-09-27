#!/usr/bin/env bash
# Installs n8n as a system service (reads .env) and makes sure Ollama runs with the performance settings.
# Stop any manually started n8n first (`pkill -f "n8n start"`).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=/home/rafcasto/credit-assessment-agent/.env
[ -f "$ENV_FILE" ] || { echo "Create $ENV_FILE from .env.example first"; exit 1; }
chmod 600 "$ENV_FILE"

# --- Ollama: keep the existing user service if there is one, just add the drop-in; otherwise install system unit
if systemctl --user is-enabled ollama >/dev/null 2>&1; then
  echo "Ollama user service detected - applying performance drop-in"
  mkdir -p ~/.config/systemd/user/ollama.service.d
  cat > ~/.config/systemd/user/ollama.service.d/override.conf <<'OVR'
[Service]
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_KEEP_ALIVE=30m"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Nice=10
OVR
  systemctl --user daemon-reload && systemctl --user restart ollama
  # user services stop at logout unless lingering is enabled
  sudo loginctl enable-linger "$USER"
else
  echo "Installing Ollama system service"
  sudo cp "$HERE/ollama.service" /etc/systemd/system/ollama.service
  sudo systemctl daemon-reload && sudo systemctl enable --now ollama
fi

# --- n8n
sudo cp "$HERE/n8n.service" /etc/systemd/system/n8n.service
sudo systemctl daemon-reload
sudo systemctl enable --now n8n
sleep 5
systemctl --no-pager status n8n | grep -E "Loaded|Active"
curl -s localhost:11434/api/tags >/dev/null && echo "Ollama OK on :11434" || echo "Ollama NOT responding"
