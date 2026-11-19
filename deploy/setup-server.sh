#!/usr/bin/env bash
# One-time setup of a Box server on a fresh Debian/Ubuntu machine with a public IP.
# Run ON the server as a regular user with sudo:
#
#   bash setup-server.sh <hostname> <ui-origin>
#
#   <hostname>   DNS name pointing at this machine, used for the HTTPS certificate. Without a domain,
#                <ip-with-dashes>.sslip.io works, e.g. 203-0-113-7.sslip.io.
#   <ui-origin>  where the web UI is served from, e.g. https://<user>.github.io
#
# Installs Caddy (automatic HTTPS) in front of Box on 127.0.0.1:8750, clones Box into ~/box, creates config.json
# with a fresh access token and the UI origin, and runs Box as the systemd service "box". Ports 80 and 443 must
# be open to the internet. Idempotent: re-running keeps an existing config.json.
set -euo pipefail
HOST="${1:?usage: setup-server.sh <hostname> <ui-origin>}"
ORIGIN="${2:?usage: setup-server.sh <hostname> <ui-origin>}"
REPO="${BOX_REPO:-https://github.com/shashwatgupta06/box.git}"
DIR="$HOME/box"

sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git python3-venv caddy rclone >/dev/null

[ -d "$DIR/.git" ] || git clone -q "$REPO" "$DIR"
cd "$DIR"
git pull -q --ff-only
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

if [ ! -f config.json ]; then
    TOKEN=$(.venv/bin/python -m box token)
    python3 - "$ORIGIN" "$TOKEN" <<'EOF'
import json, sys
cfg = json.load(open("config.example.json"))
cfg.update({"host": "127.0.0.1", "access_token": sys.argv[2], "cors_origins": [sys.argv[1]]})
cfg["backup"]["enabled"] = False   # turn on after `rclone config` (see README)
json.dump(cfg, open("config.json", "w"), indent=2)
EOF
    chmod 600 config.json
    echo "created config.json with a new access token (read it with: grep access_token $DIR/config.json)"
fi

sudo tee /etc/systemd/system/box.service >/dev/null <<EOF
[Unit]
Description=Box
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
ExecStart=$DIR/.venv/bin/python -m box run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$HOST {
    encode gzip
    reverse_proxy 127.0.0.1:8750
}
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now box
sudo systemctl restart box
sudo systemctl reload caddy || sudo systemctl restart caddy
echo "Box is served at https://$HOST"
