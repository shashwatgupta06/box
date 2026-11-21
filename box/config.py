import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
MEDIA_DIR = DATA_DIR / "media"
CONFIG_PATH = ROOT / "config.json"

DEFAULTS = {
    "api_id": 0,
    "api_hash": "",
    "chat": "Box",          # chat/channel title to watch, or "me" for Saved Messages
    "host": "127.0.0.1",    # interface to listen on; keep 127.0.0.1 behind a reverse proxy
    "port": 8750,
    "max_file_mb": 50,      # skip downloading shared files bigger than this
    "access_token": "",     # when set, /api and /media require it (needed once Box is reachable remotely)
    "cors_origins": [],     # web origins allowed to call the API, e.g. ["https://<user>.github.io"]
    "bot_token": "",        # Telegram bot that posts category buttons (python -m box bot); empty = no buttons
    "ui_url": "",           # web UI address used in Telegram sign-in links, e.g. "https://<user>.github.io/box/"
}


def load_config():
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text()))
        except Exception:
            pass
    return cfg


def telegram_configured(cfg):
    return bool(cfg.get("api_id") and cfg.get("api_hash"))


def ensure_dirs():
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
