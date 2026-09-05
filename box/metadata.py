"""Fetch link previews (title / description / og:image) for saved URLs."""
import logging
from pathlib import Path
from urllib.parse import urljoin, urlparse

import aiohttp
from bs4 import BeautifulSoup

from . import db
from .config import MEDIA_DIR

log = logging.getLogger("box.metadata")

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

VIDEO_HOSTS = ("youtube.com", "youtu.be", "vimeo.com", "tiktok.com",
               "twitch.tv", "dailymotion.com")
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif")
FILE_EXT = (".pdf", ".zip", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".epub")


def _host(url):
    return urlparse(url).netloc.lower().removeprefix("www.")


def classify_url(url):
    host = _host(url)
    path = urlparse(url).path.lower()
    if any(host == h or host.endswith("." + h) for h in VIDEO_HOSTS):
        return "video"
    if "instagram.com" in host and ("/reel" in path or "/tv" in path):
        return "video"
    if path.endswith(IMAGE_EXT):
        return "image"
    if path.endswith(FILE_EXT):
        return "file"
    return "article"


async def fetch_metadata(url):
    host = _host(url)
    out = {"site_name": host}
    timeout = aiohttp.ClientTimeout(total=15)
    try:
        async with aiohttp.ClientSession(headers={"User-Agent": UA}, timeout=timeout) as s:
            # YouTube blocks scraping; its oEmbed endpoint is reliable.
            if host in ("youtube.com", "youtu.be") or host.endswith(".youtube.com"):
                async with s.get("https://www.youtube.com/oembed",
                                 params={"url": url, "format": "json"}) as r:
                    if r.status == 200:
                        j = await r.json()
                        return {"title": j.get("title"), "site_name": "YouTube",
                                "description": j.get("author_name"),
                                "image_url": j.get("thumbnail_url")}
            async with s.get(url, allow_redirects=True) as r:
                ctype = r.headers.get("content-type", "")
                final_url = str(r.url)
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
        out["title"] = title
        out["description"] = meta("og:description", "twitter:description", "description")
        out["site_name"] = meta("og:site_name") or host
        img = meta("og:image", "og:image:url", "twitter:image")
        if img:
            out["image_url"] = urljoin(final_url, img)
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


async def enrich_item(item_id, url):
    """Fill in title/description/site/preview image for a saved link."""
    meta = await fetch_metadata(url)
    item = db.get_item(item_id)
    if not item:
        return
    fields = {}
    if meta.get("title"):
        fields["title"] = meta["title"]
    if meta.get("description") and not item["description"]:
        fields["description"] = meta["description"]
    if meta.get("site_name"):
        fields["site_name"] = meta["site_name"]
    if meta.get("image_url"):
        fields["image_url"] = meta["image_url"]
        if not item["image_path"]:
            fname = await download_image(meta["image_url"], f"og_{item_id}")
            if fname:
                fields["image_path"] = fname
    if fields:
        db.update_item(item_id, **fields)
