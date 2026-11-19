"""One-time sign-in codes.

Sending "login" in the Box chat makes Box reply with a link to the web UI carrying a short-lived code in the URL
fragment (fragments never reach any server, Telegram's link previews included). The UI redeems the code once at
POST /api/login for the access token and remembers it in that browser.
"""
import secrets
import threading
import time

CODE_TTL_SECONDS = 600
_codes: dict[str, float] = {}
_lock = threading.Lock()


def issue_code() -> str:
    code = secrets.token_urlsafe(24)
    now = time.time()
    with _lock:
        for c, exp in list(_codes.items()):
            if exp < now:
                del _codes[c]
        _codes[code] = now + CODE_TTL_SECONDS
    return code


def redeem(code: str) -> bool:
    """True once for a valid, unexpired code; the code is consumed."""
    with _lock:
        exp = _codes.pop(code or "", None)
    return exp is not None and exp >= time.time()
