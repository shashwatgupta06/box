"""Save the Telegram bot token used for category buttons: python -m box bot

The token is typed here (hidden) and written to config.json only; restart Box afterwards."""
import getpass
import json
import os
import re
import sys

from .config import CONFIG_PATH, DATA_DIR, ensure_dirs, load_config, telegram_configured

TOKEN_RE = re.compile(r"^\d{5,}:[A-Za-z0-9_-]{30,}$")


def main():
    cfg = load_config()
    if not telegram_configured(cfg):
        print("Set up Telegram first (api_id/api_hash in config.json, then: python -m box login).")
        sys.exit(1)
    print("Paste the bot token from @BotFather (input is hidden):")
    token = getpass.getpass("Bot token: ").strip()
    if not TOKEN_RE.match(token):
        print("That does not look like a bot token (it should look like 123456789:AA…). Nothing saved.")
        sys.exit(1)

    ensure_dirs()
    from telethon.sync import TelegramClient
    session = DATA_DIR / "box_bot.session"
    if session.exists():
        session.unlink()          # a session from an older bot would keep signing in as that bot
    bot = TelegramClient(str(DATA_DIR / "box_bot"), cfg["api_id"], cfg["api_hash"])
    try:
        bot.start(bot_token=token)        # not "with bot:", which would ask for a phone number
        username = bot.get_me().username
        bot.disconnect()
    except Exception as e:
        print(f"Telegram did not accept that token: {e}. Nothing saved.")
        sys.exit(1)

    raw = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
    raw["bot_token"] = token
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(raw, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(CONFIG_PATH)
    print(f"Saved. The bot is @{username}.")
    print("Next: in Telegram, add it as an admin of your Box channel (it needs to post and edit messages),")
    print("then restart Box: sudo systemctl restart box")


if __name__ == "__main__":
    main()
