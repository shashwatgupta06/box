"""Telegram sync engine: watches the Box chat and mirrors it into the local DB.

Message convention:
  1. Share anything (link / post / photo / file) into the Box chat.
  2. Name the destination: "Career.Computer Vision." or "To-Buy // Kitchen" (collection, then an optional
     subcategory; both are created if missing). Titles are edited in the web UI, not in labels. The label may be
     - in the same message as the link or photo (a line of its own, or text around the link),
     - a comment typed in the share sheet, which Telegram sends just BEFORE the shared item, or
     - the next message after the item.
  Replying to an earlier shared message with a collection name also works.
  With a bot set up (see picker.py), Box also replies to each new item with one button per collection.
"""
import asyncio
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from telethon import TelegramClient, events
from telethon.tl.types import MessageMediaDocument, MessageMediaPhoto, MessageMediaWebPage, WebPage, WebPagePending

from . import auth, db
from .config import DATA_DIR, MEDIA_DIR
from .metadata import classify_url, enrich_item
from .picker import Picker, is_bot_message

log = logging.getLogger("box.sync")

URL_RE = re.compile(r"https?://\S+")
# "Collection", "Collection.Sub" or "Collection // Sub", each optionally ending in ".".
SPEC_RE = re.compile(r"^\s*([^./\n()]{1,48}?)\s*(?:(?://+|\.)\s*([^./\n()]{1,48}?)\s*)?\.?\s*$")
# A share-sheet comment reaches the chat in the same second as its item, just before it; a label typed after an
# item comes later. So a label is attached to the FOLLOWING item only when that item arrives this close after it;
# otherwise it belongs to the item before it.
LABEL_BEFORE_SECONDS = 1
LOGIN_COMMANDS = {"login", "/login", "log in", "sign in"}
LOGIN_REPLY_MARK = "🔑 Box sign-in"   # Box's own replies start with this; never saved as items
LOGIN_PAIR_RE = re.compile(r"^(?:/?login|log in|sign in)\s+([A-Za-z0-9][A-Za-z0-9 -]{3,14})$", re.I)
LOGIN_MAX_AGE_SECONDS = 180               # older "login" messages (seen on catch-up) get no new link

SESSION_PATH = str(DATA_DIR / "box_session")


class SyncEngine:
    def __init__(self, cfg):
        self.cfg = cfg
        self.client = None
        self.chat = None
        self.chat_key = None
        self.status = {"state": "starting", "detail": "", "last_sync": None}
        self.pending_labels = {}   # message id of a shared item -> (collection, subcategory) sent just before it
        self.picker = Picker(cfg)

    async def run(self):
        try:
            self.client = TelegramClient(SESSION_PATH, self.cfg["api_id"], self.cfg["api_hash"])
            self.status.update(state="connecting", detail="Connecting to Telegram…")
            await self.client.connect()
            if not await self.client.is_user_authorized():
                self.status.update(
                    state="error",
                    detail="Not logged in to Telegram. Run: .venv/bin/python -m box login")
                return
            # Keep looking until the chat exists, so creating it later needs no restart.
            while (chat := await self._resolve_chat()) is None:
                self.status.update(
                    state="error",
                    detail=f'Chat "{self.cfg["chat"]}" not found. Create it in Telegram '
                           '(checked again every minute) or change "chat" in config.json '
                           '(use "me" for Saved Messages).')
                await asyncio.sleep(60)
            self.chat = chat
            self.chat_key = str(getattr(self.chat, "id", "me"))
            await self.picker.start(self.chat)
            self.client.add_event_handler(self._on_new_message,
                                          events.NewMessage(chats=self.chat))
            while True:
                try:
                    await self.catch_up()
                    self.status.update(state="online", detail="Watching Telegram chat",
                                       last_sync=_now_iso())
                except Exception as e:
                    log.exception("catch-up failed")
                    self.status.update(state="error", detail=f"Sync error: {e}")
                await asyncio.sleep(90)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("sync engine crashed")
            self.status.update(state="error", detail=str(e))

    async def stop(self):
        await self.picker.stop()
        if self.client:
            await self.client.disconnect()

    async def _resolve_chat(self):
        name = str(self.cfg.get("chat") or "me").strip()
        if name.lower() in ("me", "saved", "saved messages"):
            return await self.client.get_me()
        try:
            return await self.client.get_entity(name)
        except Exception:
            pass
        async for d in self.client.iter_dialogs():
            if (d.name or "").strip().lower() == name.lower():
                return d.entity
        return None

    async def catch_up(self):
        """Process everything newer than the last message we have seen."""
        last = int(db.get_meta(f"last_id:{self.chat_key}") or 0)
        async for msg in self.client.iter_messages(self.chat, min_id=last, reverse=True):
            await self.process(msg)

    async def _on_new_message(self, event):
        try:
            await self.process(event.message)
            self.status["last_sync"] = _now_iso()
        except Exception:
            log.exception("failed to process live message")

    async def process(self, msg):
        if msg is None or getattr(msg, "action", None):
            self._advance(msg)
            return
        text = (msg.message or "").strip()
        if text.startswith(LOGIN_REPLY_MARK) or is_bot_message(msg):
            self._advance(msg)
            return
        if text.lower() in LOGIN_COMMANDS:
            await self._send_login_link(msg)
            self._advance(msg)
            return
        m = LOGIN_PAIR_RE.match(text)
        if m:
            await self._approve_pairing(msg, m.group(1))
            self._advance(msg)
            return
        url = _first_url(msg)
        if _is_item(msg):
            await self._save_item(msg, url, text)
        elif text:
            await self._handle_text(msg, text)
        self._advance(msg)

    def _advance(self, msg):
        if msg is None:
            return
        last = int(db.get_meta(f"last_id:{self.chat_key}") or 0)
        if msg.id > last:
            db.set_meta(f"last_id:{self.chat_key}", msg.id)

    async def _save_item(self, msg, url, text):
        if db.get_item_by_msg(msg.chat_id, msg.id):
            return  # already synced
        fields = {
            "chat_id": msg.chat_id,
            "message_id": msg.id,
            "url": url,
            "text": text or None,
            "tg_date": msg.date.astimezone().isoformat() if msg.date else None,
        }
        kind = classify_url(url) if url else "note"

        # msg.photo / msg.document also return the picture or video of a link preview; only media the user
        # actually sent counts here (link previews are handled by _telegram_preview).
        if isinstance(msg.media, MessageMediaPhoto):
            path = await self.client.download_media(
                msg, file=str(MEDIA_DIR / f"tg_{msg.chat_id}_{msg.id}.jpg"))
            if path:
                fields["image_path"] = Path(path).name
            if not url:
                kind = "image"
        elif isinstance(msg.media, MessageMediaDocument) and msg.document:
            doc = msg.document
            mime = doc.mime_type or ""
            fields["mime"] = mime
            fname = None
            for attr in doc.attributes:
                fname = getattr(attr, "file_name", None) or fname
            if mime.startswith("video"):
                kind = "video"
            elif mime.startswith("image"):
                kind = "image"
            elif not url:
                kind = "file"
            size_mb = (doc.size or 0) / (1024 * 1024)
            if size_mb <= self.cfg.get("max_file_mb", 50):
                path = await self.client.download_media(
                    msg, file=str(MEDIA_DIR / f"tg_{msg.chat_id}_{msg.id}_{fname or 'file'}"))
                if path:
                    p = Path(path)
                    fields["file_path"] = p.name
                    fields["file_name"] = fname or p.name
                    if kind == "image":
                        fields["image_path"] = p.name
            else:
                fields["file_name"] = fname

        fields["kind"] = kind
        inline, text_rest = _inline_label(text)
        if inline:
            fields["text"] = text_rest or None
            text = text_rest
        if text and not url:
            fields["title"] = text[:120]
        elif fields.get("file_name") and not url:
            fields["title"] = fields["file_name"]
        item_id = db.create_item(fields)
        label = self.pending_labels.pop(msg.id, None)
        if label:
            _apply_label(item_id, label)
        if inline:      # a label inside the message itself wins over a share-sheet comment
            _apply_label(item_id, inline)
        self.picker.item_saved(item_id, msg)
        if url:
            # fetch link preview in the background; don't block the sync loop
            asyncio.create_task(self._enrich(item_id, msg, url))

    async def _enrich(self, item_id, msg, url):
        try:
            preview = await self._telegram_preview(msg)
        except Exception:
            log.exception("reading Telegram's link preview failed")
            preview = None
        await enrich_item(item_id, url, preview=preview)

    async def _telegram_preview(self, msg):
        """The link preview Telegram attached to the message, if any.

        Telegram's servers can fetch previews from sites that refuse ordinary servers (Instagram, LinkedIn,
        Facebook), so this is tried before scraping the page ourselves. A preview still being generated
        (WebPagePending) is re-read a couple of times."""
        for delay in (0, 3, 8):
            if delay:
                await asyncio.sleep(delay)
                msg = await self.client.get_messages(self.chat, ids=msg.id) or msg
            media = getattr(msg, "media", None)
            if not isinstance(media, MessageMediaWebPage):
                return None
            page = media.webpage
            if isinstance(page, WebPage):
                return await self._preview_fields(msg, page)
            if not isinstance(page, WebPagePending):
                return None   # WebPageEmpty / WebPageNotModified: Telegram has nothing for this link
        return None

    async def _preview_fields(self, msg, page):
        out = {"title": page.title or page.author, "description": page.description,
               "site_name": page.site_name}
        if page.type in ("video", "gif") or (page.embed_type or "").startswith("video"):
            out["kind"] = "video"
        if page.photo:
            path = await self.client.download_media(
                page.photo, file=str(MEDIA_DIR / f"tgprev_{msg.chat_id}_{msg.id}.jpg"))
            if path:
                out["image_path"] = Path(path).name
        return {k: v for k, v in out.items() if v}

    async def _handle_text(self, msg, text):
        """A plain text message: a new collection's name asked for by the buttons, a collection label for a
        shared item, or a stand-alone note."""
        if self.picker.take_name(msg, text):
            return
        m = SPEC_RE.match(text)
        spec = m.groups() if (m and len(text) <= 120 and "\n" not in text and not URL_RE.search(text)) else None
        reply_id = getattr(getattr(msg, "reply_to", None), "reply_to_msg_id", None)

        if spec and reply_id:
            target = db.get_item_by_msg(msg.chat_id, reply_id)
            prompt = db.get_prompt(reply_id) if not target else None    # a reply to the buttons message
            if prompt:
                target = db.get_item(prompt["item_id"])
            if target:
                self._label(target["id"], spec)
                return

        if spec and not reply_id:
            # 1. Share-sheet comment: Telegram sends it right before the shared item.
            nxt = await self._next_message(msg)
            if nxt is not None and _is_item(nxt) and \
                    (nxt.date - msg.date).total_seconds() <= LABEL_BEFORE_SECONDS:
                saved = db.get_item_by_msg(msg.chat_id, nxt.id)
                if saved:   # a live update for the item was handled first
                    self._label(saved["id"], spec)
                else:
                    self.pending_labels[nxt.id] = spec
                return
            # 2. A label sent after the item. Assign when the item has no collection yet, or the label is
            #    explicit (names a subcategory) or names a collection that already exists.
            target = db.prev_item_before(msg.chat_id, msg.id)
            if target and (target["collection_id"] is None or spec[1]
                           or (spec[0] and db.find_named(spec[0]))):
                self._label(target["id"], spec)
                return

        # otherwise store it as a note
        db.create_item({
            "chat_id": msg.chat_id, "message_id": msg.id, "kind": "note",
            "text": text, "title": text[:120],
            "tg_date": msg.date.astimezone().isoformat() if msg.date else None,
        })

    def _label(self, item_id, spec):
        _apply_label(item_id, spec)
        asyncio.create_task(self.picker.item_labelled(item_id))

    async def _send_login_link(self, msg):
        """Reply in the chat with a one-time link that signs a browser in to the web UI."""
        age = (datetime.now(timezone.utc) - msg.date).total_seconds() if msg.date else 0
        if age > LOGIN_MAX_AGE_SECONDS:
            return
        ui = (self.cfg.get("ui_url") or "").strip()
        if not ui:
            text = f'{LOGIN_REPLY_MARK} unavailable: set "ui_url" in config.json on the Box server.'
        else:
            code = auth.issue_code()
            minutes = auth.CODE_TTL_SECONDS // 60
            text = (f"{LOGIN_REPLY_MARK} link — tap to open your Box on this device. "
                    f"Works once, for {minutes} minutes:\n{ui.split('#')[0]}#login={code}")
        await self.client.send_message(self.chat, text, link_preview=False)

    async def _approve_pairing(self, msg, code):
        """'login KD7 4PX' approves the device showing that code on its sign-in screen."""
        age = (datetime.now(timezone.utc) - msg.date).total_seconds() if msg.date else 0
        if age > LOGIN_MAX_AGE_SECONDS:
            return
        if auth.approve_pairing(code):
            text = f"{LOGIN_REPLY_MARK}: done — the device showing {code.upper()} is now signed in."
        else:
            text = (f"{LOGIN_REPLY_MARK}: no device is waiting with code {code.upper()}. "
                    "Check the code on its screen (codes last 10 minutes).")
        await self.client.send_message(self.chat, text, link_preview=False)

    async def _next_message(self, msg):
        """The message right after `msg`; waits a few seconds for it when `msg` just arrived live."""
        for delay in (0, 2, 4):
            if delay:
                await asyncio.sleep(delay)
            nxt = await self.client.get_messages(self.chat, ids=msg.id + 1)
            if nxt is not None:
                return nxt
        return None


def _inline_label(text):
    """A label written in the same message as a link or photo -> (spec, text without it), else (None, text).

    Only lines that look like a label count: the dotted or // form, e.g. "Career.AI." or "To-Buy // Kitchen".
    Plain words never do, so an article title shared along with its link is not mistaken for a collection, and a
    lone "Name." counts only if that collection exists."""
    if not text:
        return None, text
    lines = (text or "").splitlines()
    for i, line in enumerate(lines):
        bare = URL_RE.sub(" ", line).strip()
        if not bare or len(bare) > 120:
            continue
        m = SPEC_RE.match(bare)
        if m and ("." in bare or "//" in bare):
            if not m.group(2) and not db.find_named(m.group(1)):
                continue    # "Great read." next to a link: only an existing collection's name counts alone
            rest_line = line.replace(bare, "", 1).strip() if bare in line else URL_RE.findall(line) and " ".join(URL_RE.findall(line))
            rest = lines[:i] + ([rest_line] if rest_line else []) + lines[i + 1:]
            return m.groups(), "\n".join(rest).strip()
    return None, text


def _apply_label(item_id, spec):
    """spec = (collection, subcategory); the subcategory may be None."""
    col, sub = spec
    db.update_item(item_id, collection_id=db.resolve_spec(col, sub))


def _first_url(msg):
    text = msg.message or ""
    urls = URL_RE.findall(text)
    for ent in (msg.entities or []):
        u = getattr(ent, "url", None)
        if u:
            urls.append(u)
    return urls[0] if urls else None


def _is_item(msg):
    if (msg.message or "").startswith(LOGIN_REPLY_MARK) or is_bot_message(msg):
        return False
    return bool(_first_url(msg)) or isinstance(msg.media, (MessageMediaPhoto, MessageMediaDocument))


def _now_iso():
    from datetime import datetime
    return datetime.now().astimezone().isoformat(timespec="seconds")
