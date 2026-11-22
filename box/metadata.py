"""Fetch link previews (title / description / preview image) for saved URLs.

Order of sources for a link shared through Telegram:
  1. the preview Telegram attached to the message (passed in by the sync engine);
  2. a site's public oEmbed endpoint (YouTube, Vimeo, TikTok, Spotify, SoundCloud, X, Reddit);
  3. the page's own Open Graph / Twitter-card tags.
Each later source only fills fields the earlier ones left empty.
"""
import logging
import re
from html import unescape
from pathlib import Path
from urllib.parse import urljoin, urlparse

import aiohttp
from bs4 import BeautifulSoup

from . import db
from .config import MEDIA_DIR

log = logging.getLogger("box.metadata")

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
# Instagram serves a server only an empty app shell, but gives Meta's own link-preview fetcher the post's
# caption and picture in Open Graph tags (checked from the VM, 2026).
META_PREVIEW_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
META_HOSTS = ("instagram.com",)


def user_agent_for(url):
    return META_PREVIEW_UA if _matches(_host(url), META_HOSTS) else UA

VIDEO_HOSTS = ("youtube.com", "youtu.be", "vimeo.com", "tiktok.com",
               "twitch.tv", "dailymotion.com", "fb.watch")
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif")
FILE_EXT = (".pdf", ".zip", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".epub")

# Display names for common sites, used when a page gives no site name of its own.
SITE_NAMES = {
    "youtube.com": "YouTube", "youtu.be": "YouTube", "instagram.com": "Instagram",
    "linkedin.com": "LinkedIn", "lnkd.in": "LinkedIn", "x.com": "X", "twitter.com": "X",
    "facebook.com": "Facebook", "fb.watch": "Facebook", "reddit.com": "Reddit", "redd.it": "Reddit",
    "tiktok.com": "TikTok", "vimeo.com": "Vimeo", "spotify.com": "Spotify", "soundcloud.com": "SoundCloud",
    "pinterest.com": "Pinterest", "pin.it": "Pinterest", "threads.net": "Threads", "github.com": "GitHub",
    "medium.com": "Medium", "substack.com": "Substack", "amazon.com": "Amazon", "wikipedia.org": "Wikipedia",
}

# Public oEmbed endpoints that need no API key: (host suffixes, endpoint).
OEMBED = [
    (("youtube.com", "youtu.be"), "https://www.youtube.com/oembed"),
    (("vimeo.com",), "https://vimeo.com/api/oembed.json"),
    (("tiktok.com",), "https://www.tiktok.com/oembed"),
    (("spotify.com",), "https://open.spotify.com/oembed"),
    (("soundcloud.com",), "https://soundcloud.com/oembed"),
    (("x.com", "twitter.com"), "https://publish.twitter.com/oembed"),
    (("reddit.com",), "https://www.reddit.com/oembed"),
]

# What login walls and blocked pages call themselves; never worth keeping as a title.
GENERIC_TITLES = {"instagram", "linkedin", "facebook", "x", "twitter", "log in", "login", "sign up",
                  "login • instagram", "instagram • photos and videos", "sign up | linkedin",
                  "linkedin: log in or sign up", "reddit - dive into anything", "just a moment...",
                  "tiktok - make your day", "access denied", "403 forbidden", "attention required!"}


def _host(url):
    return urlparse(url).netloc.lower().removeprefix("www.").removeprefix("m.")


def _matches(host, suffixes):
    return any(host == s or host.endswith("." + s) for s in suffixes)


def site_name_for(url):
    host = _host(url)
    for suffix, name in SITE_NAMES.items():
        if _matches(host, (suffix,)):
            return name
    return host


def fallback_title(url):
    """A readable label for a link nobody would give us a title for, e.g. "Instagram reel"."""
    name = site_name_for(url)
    path = urlparse(url).path.lower()
    for marker, what in (("/reel", "reel"), ("/p/", "post"), ("/posts/", "post"), ("/feed/update", "post"),
                         ("/status/", "post"), ("/comments/", "post"), ("/watch", "video"), ("/videos/", "video"),
                         ("/stories/", "story"), ("/pulse/", "article")):
        if marker in path:
            return f"{name} {what}"
    return name if name != _host(url) else url


def classify_url(url):
    host = _host(url)
    path = urlparse(url).path.lower()
    if _matches(host, VIDEO_HOSTS):
        return "video"
    if "instagram.com" in host and ("/reel" in path or "/tv" in path):
        return "video"
    if "facebook.com" in host and ("/watch" in path or "/videos/" in path or "/reel" in path):
        return "video"
    if path.endswith(IMAGE_EXT):
        return "image"
    if path.endswith(FILE_EXT):
        return "file"
    return "article"


def _clean_title(t):
    t = (t or "").strip()
    return None if not t or t.lower() in GENERIC_TITLES else t


async def _oembed(session, url, host):
    for suffixes, endpoint in OEMBED:
        if not _matches(host, suffixes):
            continue
        params = {"url": url, "format": "json"}
        if endpoint.startswith("https://publish.twitter.com"):
            params = {"url": url, "omit_script": "1"}
        async with session.get(endpoint, params=params) as r:
            if r.status != 200:
                return {}
            j = await r.json(content_type=None)
        title = j.get("title")
        if not title and j.get("html"):
            # X returns the post as an HTML blockquote; its first paragraph is the post text.
            m = re.search(r"<p[^>]*>(.*?)</p>", j["html"], re.S)
            if m:
                title = unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()[:200]
        return {"title": title, "description": j.get("author_name"),
                "site_name": site_name_for(url) if site_name_for(url) != host else (j.get("provider_name") or host),
                "image_url": j.get("thumbnail_url")}
    return {}


async def fetch_metadata(url):
    host = _host(url)
    out = {"site_name": site_name_for(url)}
    timeout = aiohttp.ClientTimeout(total=15)
    try:
        async with aiohttp.ClientSession(headers={"User-Agent": user_agent_for(url)}, timeout=timeout) as s:
            try:
                emb = await _oembed(s, url, host)
            except Exception as e:
                log.info("oEmbed failed for %s: %s", url, e)
                emb = {}
            if emb.get("title") and (emb.get("image_url") or _matches(host, ("x.com", "twitter.com", "reddit.com"))):
                return {k: v for k, v in emb.items() if v}
            async with s.get(url, allow_redirects=True) as r:
                ctype = r.headers.get("content-type", "")
                final_url = str(r.url)
                if r.status != 200:   # blocked or gone: keep whatever oEmbed gave, never an error page's title
                    out.update({k: v for k, v in emb.items() if v})
                    return out
                if "html" not in ctype:
                    name = Path(urlparse(url).path).name
                    out["title"] = name or url
                    return out
                html = await r.text(errors="ignore")
        soup = BeautifulSoup(html, "html.parser")

        def meta(*names):
            for n in names:
                tag = (soup.find("meta", property=n)
                       or soup.find("meta", attrs={"name": n}))
                if tag and tag.get("content"):
                    return tag["content"].strip()
            return None

        title = meta("og:title", "twitter:title")
        if not title and soup.title and soup.title.string:
            title = soup.title.string.strip()
        out["title"] = _clean_title(title)
        out["description"] = meta("og:description", "twitter:description", "description")
        out["site_name"] = meta("og:site_name") or out["site_name"]
        img = meta("og:image", "og:image:url", "twitter:image")
        if img:
            out["image_url"] = urljoin(final_url, img)
        for k, v in emb.items():   # oEmbed fields beat a scraped page that came back thin
            if v and not out.get(k):
                out[k] = v
    except Exception as e:
        log.warning("metadata fetch failed for %s: %s", url, e)
    return out


async def download_image(url, dest_name, max_mb=10):
    """Download a preview image into MEDIA_DIR; returns filename or None."""
    timeout = aiohttp.ClientTimeout(total=20)
    try:
        async with aiohttp.ClientSession(headers={"User-Agent": UA}, timeout=timeout) as s:
            async with s.get(url, allow_redirects=True) as r:
                if r.status != 200:
                    return None
                ctype = r.headers.get("content-type", "")
                ext = {"image/png": ".png", "image/gif": ".gif",
                       "image/webp": ".webp", "image/svg+xml": ".svg"}.get(
                           ctype.split(";")[0].strip(), ".jpg")
                data = b""
                async for chunk in r.content.iter_chunked(64 * 1024):
                    data += chunk
                    if len(data) > max_mb * 1024 * 1024:
                        return None
                fname = dest_name + ext
                (MEDIA_DIR / fname).write_bytes(data)
                return fname
    except Exception as e:
        log.warning("image download failed for %s: %s", url, e)
        return None


async def enrich_item(item_id, url, preview=None):
    """Fill in title/description/site/preview image for a saved link.

    `preview` holds what Telegram's own link preview gave (title, description, site_name, image_path, kind);
    the page is only fetched for what is still missing."""
    item = db.get_item(item_id)
    if not item:
        return
    pv = dict(preview or {})
    pv["title"] = _clean_title(pv.get("title"))
    fields = {}
    if pv.get("title"):
        fields["title"] = pv["title"]
    if pv.get("description") and not item["description"]:
        fields["description"] = pv["description"]
    if pv.get("site_name"):
        fields["site_name"] = pv["site_name"]
    if pv.get("image_path") and not item["image_path"]:
        fields["image_path"] = pv["image_path"]
    if pv.get("kind") == "video" and item["kind"] == "article":
        fields["kind"] = "video"

    if not (fields.get("title") and (fields.get("image_path") or item["image_path"])):
        meta = await fetch_metadata(url)
        meta["title"] = _clean_title(meta.get("title"))
        if meta.get("title") and not fields.get("title"):
            fields["title"] = meta["title"]
        if meta.get("description") and not item["description"] and not fields.get("description"):
            fields["description"] = meta["description"]
        if meta.get("site_name") and not fields.get("site_name"):
            fields["site_name"] = meta["site_name"]
        if meta.get("image_url") and not (fields.get("image_path") or item["image_path"]):
            fields["image_url"] = meta["image_url"]
            fname = await download_image(meta["image_url"], f"og_{item_id}")
            if fname:
                fields["image_path"] = fname
    if not fields.get("site_name") and not item["site_name"]:
        fields["site_name"] = site_name_for(url)
    if not fields.get("title") and not item["title"]:
        fields["title"] = fallback_title(url)
    # A title given in a label wins, including one applied while the preview was being fetched.
    current = db.get_item(item_id)
    if current and current["custom_title"]:
        fields.pop("title", None)
    if fields:
        db.update_item(item_id, **fields)
