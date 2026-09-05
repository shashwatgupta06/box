"""One-time interactive Telegram login (creates data/box_session.session)."""
import sys

from .config import DATA_DIR, load_config, telegram_configured, ensure_dirs


def main():
    cfg = load_config()
    if not telegram_configured(cfg):
        print("config.json is missing your Telegram API credentials.")
        print("1. Visit https://my.telegram.org -> API development tools")
        print("2. Create an app, copy api_id and api_hash into config.json")
        sys.exit(1)
    ensure_dirs()
    from telethon.sync import TelegramClient
    with TelegramClient(str(DATA_DIR / "box_session"),
                        cfg["api_id"], cfg["api_hash"]) as client:
        me = client.get_me()
        name = " ".join(filter(None, [me.first_name, me.last_name])) or me.username
        print(f"\nLogged in as {name}. You can now start the app: ./run.sh")


if __name__ == "__main__":
    main()
