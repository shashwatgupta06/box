"""Save the Claude API key used for AI titles and descriptions: python -m box ai-key

The key is typed here (hidden), checked with Anthropic, and written to config.json only. Box reads it each time
the AI pass starts, so no restart is needed."""
import getpass
import json
import os
import sys

from .config import CONFIG_PATH


def main():
    print("Paste your Claude API key from platform.claude.com (input is hidden):")
    key = getpass.getpass("API key: ").strip()
    if not key.startswith("sk-ant-"):
        print("That does not look like a Claude API key (it starts with sk-ant-). Nothing saved.")
        sys.exit(1)
    import anthropic
    try:
        anthropic.Anthropic(api_key=key, max_retries=1).models.list(limit=1)
    except anthropic.AuthenticationError:
        print("Anthropic did not accept that key. Nothing saved.")
        sys.exit(1)
    except Exception as e:
        print(f"Could not check the key ({e}). Nothing saved.")
        sys.exit(1)

    raw = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
    raw["anthropic_api_key"] = key
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(raw, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(CONFIG_PATH)
    print("Saved. The AI titles button in Box is ready.")


if __name__ == "__main__":
    main()
