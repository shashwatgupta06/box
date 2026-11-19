"""Signing browsers in without typing a password or token.

Two ways, both confirmed from the user's own Telegram chat (only they can post there):

1. Link, for the device that has Telegram: sending "login" makes Box reply with a link to the web UI carrying a
   short-lived code in the URL fragment (fragments never reach any server, Telegram's link previews included).
   The UI redeems it once at POST /api/login for the access token.

2. Pairing, for a device without Telegram (a laptop): the sign-in screen asks for a pairing (POST /api/pair) and
   shows its short code, e.g. "login KD7 4PX". Sending that message in the chat approves the pairing, and the
   screen, which polls GET /api/pair/<id>, receives the access token.
"""
import secrets
import threading
import time

CODE_TTL_SECONDS = 600
PAIR_TTL_SECONDS = 600
MAX_PENDING_PAIRS = 20          # keeps a flood of pairing requests from matching a code the user types
PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O, 1/I/L
PAIR_CODE_LEN = 6

_codes: dict[str, float] = {}
_pairs: dict[str, dict] = {}    # pair id -> {"code", "exp", "approved"}
_lock = threading.Lock()


def _prune(now):
    for c, exp in list(_codes.items()):
        if exp < now:
            del _codes[c]
    for pid, p in list(_pairs.items()):
        if p["exp"] < now:
            del _pairs[pid]


# ---------- 1. sign-in links ----------

def issue_code() -> str:
    code = secrets.token_urlsafe(24)
    now = time.time()
    with _lock:
        _prune(now)
        _codes[code] = now + CODE_TTL_SECONDS
    return code


def redeem(code: str) -> bool:
    """True once for a valid, unexpired code; the code is consumed."""
    with _lock:
        exp = _codes.pop(code or "", None)
    return exp is not None and exp >= time.time()


# ---------- 2. pairing ----------

def normalize_pair_code(text: str) -> str:
    return "".join(ch for ch in (text or "").upper() if ch.isalnum())


def format_pair_code(code: str) -> str:
    return f"{code[:3]} {code[3:]}"


def start_pairing():
    """New pending pairing -> (pair id, code), or None when too many are pending."""
    now = time.time()
    with _lock:
        _prune(now)
        if sum(1 for p in _pairs.values() if not p["approved"]) >= MAX_PENDING_PAIRS:
            return None
        used = {p["code"] for p in _pairs.values()}
        while True:
            code = "".join(secrets.choice(PAIR_ALPHABET) for _ in range(PAIR_CODE_LEN))
            if code not in used:
                break
        pid = secrets.token_urlsafe(24)
        _pairs[pid] = {"code": code, "exp": now + PAIR_TTL_SECONDS, "approved": False}
    return pid, code


def approve_pairing(text: str) -> bool:
    """Approve the one pending pairing whose code matches; False if none (or, defensively, several) match."""
    code = normalize_pair_code(text)
    now = time.time()
    with _lock:
        _prune(now)
        hits = [p for p in _pairs.values() if p["code"] == code and not p["approved"]]
        if len(hits) != 1:
            return False
        hits[0]["approved"] = True
        hits[0]["exp"] = now + 120      # the waiting screen collects the token within a couple of seconds
    return True


def pairing_status(pid: str) -> str:
    """'approved' (consumes the pairing), 'pending' or 'gone'."""
    now = time.time()
    with _lock:
        p = _pairs.get(pid or "")
        if not p or p["exp"] < now:
            _pairs.pop(pid or "", None)
            return "gone"
        if p["approved"]:
            del _pairs[pid]
            return "approved"
        return "pending"
