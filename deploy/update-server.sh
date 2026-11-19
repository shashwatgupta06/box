#!/usr/bin/env bash
# Update a Box server set up with setup-server.sh to the latest commit on main. Run ON the server.
set -euo pipefail
cd "$HOME/box"
git pull -q --ff-only
.venv/bin/pip install -q -r requirements.txt
sudo systemctl restart box
sleep 2
systemctl is-active box
git log -1 --format="Box now at %h %s"
