"""AI titles and descriptions for saved links (Claude API).

Pressing the button in the web UI starts one pass over every saved link the pass has never handled
(`ai_done_at IS NULL`). For each link Box gathers what is known in text — the site's own title and description,
the text sent with the link, and text read from the page (for YouTube, the uploader's description and tags; for
Instagram, the caption) — and asks Claude for a short title and a 3-4 sentence description. Videos are described
from that text only; nothing is inferred from the video itself.

A title the user set in the app is never replaced (the description is still written). The title an item had
before is kept in `original_title`, so the UI can undo the change. Links with too little to go on are marked
`no_info` and are not tried again; a link that failed for a passing reason (network, rate limit) stays pending.
"""
import asyncio
import json
import logging
import re
from datetime import datetime

import aiohttp
from bs4 import BeautifulSoup

from . import db
from .config import load_config
from .metadata import _host, _matches, user_agent_for

log = logging.getLogger("box.ai")

MODEL = "claude-sonnet-5-5"
CONCURRENCY = 3
PAGE_TEXT_CHARS = 4000
MAX_PAGE_BYTES = 3_000_000
URL_RE = re.compile(r"https?://\S+")

SYSTEM = """You name and describe links saved in a personal bookmarks app, so that the owner knows what each \
saved post is about before opening it.

You get what is known about one saved link: its address, the title and description the site gave, any text the \
owner sent along with it, and text read from the page. For videos you get only the uploader's description, tags \
and similar text: describe the video from that text, and never guess what is shown or said in the video itself.

Return:
- title: what the link is about, as briefly as possible, so the subject is clear at a glance. 2 to 8 plain words. \
No site name, no emoji, no hashtags, no quotation marks, no clickbait, no full stop at the end. Keep the names of \
people, products and places.
- description: 3 to 4 sentences on what the post or page contains. Use only facts from the material. Do not \
start with "This post" or "This video", give no opinions, no hashtags and no marketing language.
- search_terms: 15 to 25 short search terms someone might type to find this link later: its topics, broader \
fields (for example "machine learning" for a YOLO tutorial), synonyms and abbreviations, names of people, \
products, places and channels, and what kind of thing it is (tutorial, recipe, news, dance reel). Lowercase, one \
to three words each, no duplicates, no hashtags.
- enough_info: false when the material does not say what the link is about (for example only a site name, a \
login page or an error page); then give an empty title, description and search_terms.

Write the title and description in English, even when the material is in another language. Write the search \
terms in English, and when the material is in another language add the main terms in that language too."""

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "description": {"type": "string"},
        "search_terms": {"type": "array", "items": {"type": "string"}},
        "enough_info": {"type": "boolean"},
    },
    "required": ["title", "description", "search_terms", "enough_info"],
    "additionalProperties": False,
}


class FatalAPIError(Exception):
    """The API refuses every request (bad key, no credit): stop the pass."""


# ---------- gathering what is known about a link ----------

async def _fetch_page(url):
    timeout = aiohttp.ClientTimeout(total=20)
    try:
        async with aiohttp.ClientSession(headers={"User-Agent": user_agent_for(url), "Accept-Language": "en"},
                                         timeout=timeout) as s:
            async with s.get(url, allow_redirects=True) as r:
                if r.status != 200 or "html" not in r.headers.get("content-type", ""):
                    return None
                data = b""
                async for chunk in r.content.iter_chunked(64 * 1024):
                    data += chunk
                    if len(data) >= MAX_PAGE_BYTES:
                        break
                return data.decode(r.charset or "utf-8", errors="ignore")
    except Exception as e:
        log.info("page fetch failed for %s: %s", _host(url), e)
        return None


def _youtube_details(html):
    """Title, channel, upload description and tags from a YouTube watch page."""
    m = re.search(r"ytInitialPlayerResponse\s*=\s*", html)
    if not m:
        return {}
    try:
        data, _ = json.JSONDecoder().raw_decode(html, m.end())
    except ValueError:
        return {}
    vd = data.get("videoDetails") or {}
    out = {
        "Video title": vd.get("title"),
        "Channel": vd.get("author"),
        "Uploader's description": vd.get("shortDescription"),
        "Tags": ", ".join(vd.get("keywords") or []),
    }
    mf = (data.get("microformat") or {}).get("playerMicroformatRenderer") or {}
    out["Category"] = mf.get("category")
    return {k: v for k, v in out.items() if v}


def _html_details(html):
    soup = BeautifulSoup(html, "html.parser")

    def meta(*names):
        for n in names:
            tag = soup.find("meta", property=n) or soup.find("meta", attrs={"name": n})
            if tag and tag.get("content"):
                return tag["content"].strip()
        return None

    out = {
        "Page title": meta("og:title", "twitter:title") or (soup.title.string.strip() if soup.title and soup.title.string else None),
        "Page description": meta("og:description", "twitter:description", "description"),
        "Keywords": meta("keywords"),
    }
    for tag in soup(["script", "style", "noscript", "nav", "header", "footer", "form", "svg", "aside"]):
        tag.decompose()
    body = soup.find("article") or soup.find("main") or soup.body
    if body:
        text = re.sub(r"\s+", " ", body.get_text(" ")).strip()
        if len(text) > 80:
            out["Text from the page"] = text[:PAGE_TEXT_CHARS]
    return {k: v for k, v in out.items() if v}


async def gather(item):
    """Everything known about a saved link, as labelled text fields."""
    url = item["url"]
    fields = {
        "Address": url,
        "Site": item["site_name"],
        "Kind": item["kind"],
        "Title the site gave": item["original_title"] if item["ai_title"] else item["title"],
        "Description the site gave": item["description"],
    }
    sent = URL_RE.sub(" ", item["text"] or "").strip()
    if sent:
        fields["Text the owner sent with the link"] = sent
    html = await _fetch_page(url)
    if html:
        if _matches(_host(url), ("youtube.com", "youtu.be")):
            fields.update(_youtube_details(html))
        else:
            fields.update(_html_details(html))
    return {k: v for k, v in fields.items() if v}


def material_text(fields):
    return "\n\n".join(f"{k}:\n{v}" for k, v in fields.items())


# ---------- asking Claude ----------

async def describe(client, fields):
    """-> dict(title, description, enough_info). Raises FatalAPIError when no request can succeed."""
    import anthropic
    try:
        resp = await client.beta.messages.create(
            model=MODEL,
            max_tokens=4000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
            system=SYSTEM,
            messages=[{"role": "user", "content": material_text(fields)}],
        )
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as e:
        raise FatalAPIError("The Claude API key was not accepted. Set it again: python -m box ai-key") from e
    except anthropic.BadRequestError as e:
        if "credit balance" in str(e).lower():
            raise FatalAPIError("Out of Claude API credit for now. It renews with your plan's billing cycle.") from e
        raise
    if resp.stop_reason == "refusal":
        return {"title": "", "description": "", "enough_info": False}
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("the answer was cut off")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    out = json.loads(text)
    out["title"] = re.sub(r"\s+", " ", out.get("title") or "").strip().strip('"“”').rstrip(".")[:90]
    out["description"] = (out.get("description") or "").strip()[:900]
    terms = []
    for t in out.get("search_terms") or []:
        t = re.sub(r"\s+", " ", str(t)).strip().lstrip("#").lower()[:40]
        if t and t not in terms:
            terms.append(t)
    out["search_terms"] = terms[:30]
    if not out["title"] or not out["description"]:
        out["enough_info"] = False
    return out


def apply_result(item_id, result):
    item = db.get_item(item_id)
    if not item:
        return "gone"
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    if not result["enough_info"]:
        db.update_item(item_id, ai_done_at=now, ai_status="no_info",
                       ai_note="Not enough information about this link to describe it.")
        return "no_info"
    fields = {"ai_summary": result["description"], "ai_terms": ", ".join(result.get("search_terms") or []),
              "ai_done_at": now, "ai_status": "done", "ai_note": None}
    if not item["custom_title"]:
        if not item["ai_title"]:
            fields["original_title"] = item["title"]
        fields["title"] = result["title"]
        fields["ai_title"] = 1
    db.update_item(item_id, **fields)
    return "done"


# ---------- the pass started from the UI ----------

class AiPass:
    def __init__(self):
        self.status = {"state": "idle", "done": 0, "total": 0, "described": 0, "no_info": 0, "failed": 0,
                       "detail": ""}
        self._task = None

    @staticmethod
    def key():
        return (load_config().get("anthropic_api_key") or "").strip()

    def public_status(self):
        s = dict(self.status)
        s["pending"] = db.ai_pending_count()
        s["ready"] = bool(self.key())
        return s

    def start(self):
        if self._task and not self._task.done():
            return False
        items = db.ai_pending_items()
        # Set before returning, so the caller already sees "running".
        self.status = {"state": "running", "done": 0, "total": len(items), "described": 0, "no_info": 0,
                       "failed": 0, "detail": ""}
        self._task = asyncio.create_task(self.run(items))
        return True

    async def redo_one(self, item_id):
        """Write the title and description of one save again (the pass's rules apply). Returns an error message
        or None."""
        import anthropic
        if not self.key():
            return "No Claude API key on the server yet. On the server run: python -m box ai-key"
        item = db.get_item(item_id)
        if not item or not item["url"]:
            return "Only saved links can be described."
        client = anthropic.AsyncAnthropic(api_key=self.key(), max_retries=3, timeout=120)
        try:
            result = await describe(client, await gather(dict(item)))
        except FatalAPIError as e:
            return str(e)
        except Exception as e:
            log.warning("redo failed for item %s: %s", item_id, e)
            return "Couldn't describe it right now. Try again in a minute."
        finally:
            await client.close()
        apply_result(item_id, result)
        return None

    async def run(self, items):
        import anthropic
        if not items:
            self.status.update(state="done", detail="Every link already has an AI title.")
            return
        client = anthropic.AsyncAnthropic(api_key=self.key(), max_retries=3, timeout=120)
        sem = asyncio.Semaphore(CONCURRENCY)
        fatal = []

        async def one(item):
            async with sem:
                if fatal:
                    return
                try:
                    fields = await gather(item)
                    result = await describe(client, fields)
                    outcome = apply_result(item["id"], result)
                    if outcome == "done":
                        self.status["described"] += 1
                    elif outcome == "no_info":
                        self.status["no_info"] += 1
                except FatalAPIError as e:
                    fatal.append(str(e))
                    return
                except Exception as e:
                    # Passing failures (network, rate limit, a malformed answer): the link stays pending.
                    log.warning("AI pass failed for item %s: %s", item["id"], e)
                    self.status["failed"] += 1
                self.status["done"] += 1

        try:
            await asyncio.gather(*(one(it) for it in items))
        finally:
            await client.close()
        if fatal:
            self.status.update(state="error", detail=fatal[0])
        elif self.status["failed"]:
            self.status.update(state="error", detail=f"{self.status['failed']} could not be done this time; "
                                                     "press again to retry them.")
        else:
            self.status.update(state="done", detail="")
