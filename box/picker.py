"""Category buttons in Telegram.

When something is shared to the Box chat without a label, Box's bot replies to it with one button per collection.
A collection that has subcategories opens them; one without saves straight away. "＋ New" asks for a name (the only
typing needed); a dotted name such as "Career.Robotics" creates a collection with a subcategory.

Telegram lets only bots post buttons, so this needs a bot (from @BotFather) that is an admin of the Box chat, with
its token in config.json as "bot_token" (set it with: python -m box bot). Without one, nothing here runs.
"""
import asyncio
import logging
import re
from datetime import datetime, timezone

from telethon import Button, TelegramClient, events, utils

from . import db
from .config import DATA_DIR

log = logging.getLogger("box.picker")

BOT_MARK = "📥"                # every bot message starts with this, so the sync never saves one as an item
ASK_DELAY_SECONDS = 2         # lets a share-sheet comment label the item first
LIVE_SECONDS = 120            # only items shared this recently get buttons (not history read on catch-up)
NAME_WAIT_SECONDS = 600       # after "＋ New", the next plain message within this long is the new name
SESSION_PATH = str(DATA_DIR / "box_bot")


def is_bot_message(msg):
    return (msg.message or "").startswith(BOT_MARK)


def split_name(text):
    """'Career.Robotics' or 'Career // Robotics' -> ['Career', 'Robotics']."""
    parts = re.split(r"\s*(?://+|\.)\s*", (text or "").strip().rstrip("."))
    return [p.strip()[:48] for p in parts if p.strip()]


class Picker:
    def __init__(self, cfg):
        self.cfg = cfg
        self.bot = None
        self.peer = None
        self.status = {"state": "off", "detail": "No bot_token in config.json"}

    @property
    def ready(self):
        return self.bot is not None and self.peer is not None

    async def start(self, chat_entity):
        token = (self.cfg.get("bot_token") or "").strip()
        if not token:
            return
        if not hasattr(chat_entity, "title"):
            self.status = {"state": "off", "detail": "Buttons need a channel or group as the Box chat"}
            return
        try:
            bot = TelegramClient(SESSION_PATH, self.cfg["api_id"], self.cfg["api_hash"])
            await bot.start(bot_token=token)
            me = await bot.get_me()
        except Exception as e:
            log.exception("bot sign-in failed")
            self.status = {"state": "error", "detail": f"Bot could not sign in (check bot_token): {e}"}
            return
        bot.add_event_handler(self._on_button, events.CallbackQuery())
        self.bot = bot
        asyncio.create_task(self._join(chat_entity, me.username))

    async def _join(self, chat_entity, username):
        """Reach the Box chat; until the bot is made an admin there, look again every minute."""
        while self.peer is None:
            try:
                # A bot can reach a chat it belongs to by id alone.
                peer = await self.bot.get_input_entity(utils.get_peer(utils.get_peer_id(chat_entity)))
                await self.bot.get_entity(peer)
                self.peer = peer
                self.status = {"state": "online", "detail": f"@{username}"}
                log.info("category buttons on via @%s", username)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.status = {"state": "error",
                               "detail": f"@{username} cannot reach the Box chat yet — add it as an admin "
                                         f"(checked every minute): {e}"}
                await asyncio.sleep(60)

    async def stop(self):
        if self.bot:
            try:
                await self.bot.disconnect()
            except Exception:       # e.g. its session file already closed; never block shutdown
                log.exception("bot disconnect failed")

    # ---------- asking ----------

    def item_saved(self, item_id, msg):
        """Called by the sync for each new shared item; asks after a short wait if it is still unsorted."""
        if not self.ready or not msg.date:
            return
        if (datetime.now(timezone.utc) - msg.date).total_seconds() > LIVE_SECONDS:
            return
        asyncio.create_task(self._ask_later(item_id, msg.id))

    async def _ask_later(self, item_id, msg_id):
        await asyncio.sleep(ASK_DELAY_SECONDS)
        item = db.get_item(item_id)
        try:
            if item and not item["trashed"]:
                if item["collection_id"] is None:
                    text, buttons = self._level(item_id, None)
                else:
                    text, buttons = self._saved_view(item_id)
                sent = await self.bot.send_message(self.peer, text, reply_to=msg_id, buttons=buttons,
                                                   link_preview=False)
                db.save_prompt(sent.id, item_id)
        except Exception:
            log.exception("could not send category buttons")

    async def item_labelled(self, item_id):
        """A typed label filed the item: show that on its buttons message, if it has one."""
        if not self.ready:
            return
        prompt = db.prompt_for_item(item_id)
        if prompt:
            await self._edit(prompt["prompt_id"], *self._saved_view(item_id))

    # ---------- views ----------

    def _level(self, item_id, cid):
        """Buttons for the collections inside `cid` (None = top level)."""
        tree = db.collections_tree()
        if cid is None:
            kids, here = tree, None
        else:
            here = _find(tree, cid)
            kids = here["children"] if here else []
        rows, row = [], []
        for c in kids:
            act = "o" if c["children"] else "s"
            label = c["name"] + (" ›" if c["children"] else "")
            row.append(Button.inline(label[:60], f"{act}:{item_id}:{c['id']}".encode()))
            if len(row) == 2:
                rows.append(row)
                row = []
        if row:
            rows.append(row)
        if here:
            rows.insert(0, [Button.inline(f"✓ Save in {here['name']}"[:60], f"s:{item_id}:{cid}".encode())])
            rows.append([Button.inline("‹ Back", f"o:{item_id}:{here['parent_id'] or 0}".encode()),
                         Button.inline("＋ New subcategory", f"n:{item_id}:{cid}".encode())])
            text = f"{BOT_MARK} {db.collection_path(cid)} — pick a subcategory, or save here"
        else:
            rows.append([Button.inline("＋ New", f"n:{item_id}:0".encode()),
                         Button.inline("Unsorted", f"x:{item_id}:0".encode())])
            text = f"{BOT_MARK} Where should this go?"
        return text, rows

    def _saved_view(self, item_id):
        item = db.get_item(item_id)
        cid = item["collection_id"] if item else None
        if item and item["trashed"]:
            return f"{BOT_MARK} In Trash", None
        if cid is None:
            return f"{BOT_MARK} Left in Unsorted", [[Button.inline("↩ Choose a category", f"o:{item_id}:0".encode())]]
        return (f"{BOT_MARK} Saved to {db.collection_path(cid)}",
                [[Button.inline("↩ Change", f"o:{item_id}:0".encode()),
                  Button.inline("＋ Subcategory", f"n:{item_id}:{cid}".encode())]])

    # ---------- taps ----------

    async def _on_button(self, event):
        try:
            if utils.get_peer_id(self.peer) != event.chat_id:
                return await event.answer()
            act, item_id, cid = event.data.decode().split(":")
            item_id, cid = int(item_id), int(cid) or None
            if not db.get_item(item_id):
                await event.answer("This save was deleted.")
                return await event.edit(f"{BOT_MARK} Deleted", buttons=None)
            db.save_prompt(event.message_id, item_id)     # a tap ends any wait for a typed name
            if act == "o":
                await event.answer()
                t, b = self._level(item_id, cid)
                await event.edit(t, buttons=b)
            elif act == "s":
                db.update_item(item_id, collection_id=cid)
                await event.answer("Saved")
                t, b = self._saved_view(item_id)
                await event.edit(t, buttons=b)
            elif act == "x":
                db.update_item(item_id, collection_id=None)
                await event.answer()
                t, b = self._saved_view(item_id)
                await event.edit(t, buttons=b)
            elif act == "n":
                db.await_name(event.message_id, cid)
                where = f" inside {db.collection_path(cid)}" if cid else ""
                tip = "" if cid else " Use Career.Robotics to make a category with a subcategory."
                await event.answer()
                await event.edit(f"{BOT_MARK} Send the name for the new category{where}.{tip}",
                                 buttons=[[Button.inline("Cancel", f"o:{item_id}:{cid or 0}".encode())]])
        except Exception:
            log.exception("button tap failed")
            try:
                await event.answer("Something went wrong")
            except Exception:
                pass

    def take_name(self, msg, text):
        """If Box is waiting for a new category name, use this message as it: create the collection(s), file
        the item, and return True. A reply to the buttons message always counts; otherwise the newest wait
        within NAME_WAIT_SECONDS takes a short single-line message."""
        reply_id = getattr(getattr(msg, "reply_to", None), "reply_to_msg_id", None)
        prompt = db.get_prompt(reply_id) if reply_id else None
        if prompt is None and not reply_id and "\n" not in text and len(text) <= 100 and "://" not in text:
            prompt = db.latest_waiting_prompt(NAME_WAIT_SECONDS)
        if prompt is None or not prompt["awaiting"]:
            return False
        parts = split_name(text)
        if not parts:
            return False
        cid = prompt["parent_id"]
        for name in parts:
            cid = db.find_or_create_collection(name, cid)
        db.update_item(prompt["item_id"], collection_id=cid)
        db.save_prompt(prompt["prompt_id"], prompt["item_id"])
        if self.ready:
            asyncio.create_task(self._edit(prompt["prompt_id"], *self._saved_view(prompt["item_id"])))
        return True

    async def _edit(self, prompt_id, text, buttons):
        try:
            await self.bot.edit_message(self.peer, prompt_id, text, buttons=buttons, link_preview=False)
        except Exception as e:
            if "not modified" not in str(e).lower():
                log.exception("could not update category buttons")


def _find(tree, cid):
    for c in tree:
        if c["id"] == cid:
            return c
        hit = _find(c["children"], cid)
        if hit:
            return hit
    return None
