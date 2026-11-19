import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db
from .config import ROOT, MEDIA_DIR, load_config, ensure_dirs, telegram_configured
from .metadata import classify_url, enrich_item
from .sync import SyncEngine
from .backup import BackupEngine

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

engine: SyncEngine | None = None
backup_engine: BackupEngine | None = None
_sync_task = None
_backup_task = None


@asynccontextmanager
async def lifespan(app):
    global engine, backup_engine, _sync_task, _backup_task
    ensure_dirs()
    db.init_db()
    cfg = load_config()
    if telegram_configured(cfg):
        engine = SyncEngine(cfg)
        _sync_task = asyncio.create_task(engine.run())
    backup_engine = BackupEngine(cfg)
    _backup_task = asyncio.create_task(backup_engine.run_loop())
    yield
    if _sync_task:
        _sync_task.cancel()
    if _backup_task:
        _backup_task.cancel()
    if engine:
        await engine.stop()


app = FastAPI(title="Box", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

_cfg = load_config()
_TOKEN = _cfg.get("access_token") or ""


@app.middleware("http")
async def require_token(request: Request, call_next):
    """With an access_token configured, /api and /media need it: as a Bearer header, or as ?token= for
    plain links such as <img src>. The UI shell itself stays public; it holds no data."""
    path = request.url.path
    if _TOKEN and request.method != "OPTIONS" and path.startswith(("/api/", "/media/")):
        header = request.headers.get("authorization", "")
        given = header[7:] if header.lower().startswith("bearer ") else request.query_params.get("token", "")
        if not secrets.compare_digest(given.encode(), _TOKEN.encode()):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


# Added after the auth middleware so it runs first: preflight requests are answered here, and 401s still carry
# the CORS headers the browser needs to read them.
if _cfg.get("cors_origins"):
    app.add_middleware(CORSMiddleware, allow_origins=_cfg["cors_origins"], allow_credentials=False,
                       allow_methods=["GET", "POST", "PATCH", "DELETE"],
                       allow_headers=["Authorization", "Content-Type"])


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/media/{name}")
def media(name: str):
    safe = Path(name).name
    path = MEDIA_DIR / safe
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


def _serialize(item):
    image = None
    if item["image_path"]:
        image = f"/media/{item['image_path']}"
    elif item["image_url"]:
        image = item["image_url"]
    return {
        "id": item["id"],
        "kind": item["kind"],
        "url": item["url"],
        "title": item["title"],
        "description": item["description"],
        "site_name": item["site_name"],
        "image": image,
        "text": item["text"],
        "file": f"/media/{item['file_path']}" if item["file_path"] else None,
        "file_name": item["file_name"],
        "collection_id": item["collection_id"],
        "collection_path": db.collection_path(item["collection_id"]) if item["collection_id"] else None,
        "date": item["tg_date"] or item["created_at"],
        "trashed": bool(item["trashed"]),
    }


@app.get("/api/state")
def state():
    if engine:
        status = engine.status
    elif telegram_configured(load_config()):
        status = {"state": "starting", "detail": ""}
    else:
        status = {"state": "unconfigured",
                  "detail": "Telegram is not set up yet — see README.md "
                            "(add api_id/api_hash to config.json, then run: python -m box login)"}
    backup = backup_engine.status if backup_engine else {"state": "idle", "detail": ""}
    return {"status": status, "backup": backup,
            "collections": db.collections_tree(), "counts": db.counts()}


@app.get("/api/items")
def items(view: str = "all", collection_id: int | None = None,
          kind: str | None = None, q: str | None = None):
    rows = db.list_items(view=view, collection_id=collection_id, kind=kind, search=q)
    return [_serialize(r) for r in rows]


class NewItem(BaseModel):
    url: str
    collection_id: int | None = None


@app.post("/api/items")
async def add_item(body: NewItem):
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    item_id = db.create_item({"url": url, "kind": classify_url(url),
                              "collection_id": body.collection_id,
                              "tg_date": None})
    await enrich_item(item_id, url)
    return _serialize(db.get_item(item_id))


class ItemPatch(BaseModel):
    collection_id: int | None = None
    set_collection: bool = False   # distinguishes "move to Unsorted" from "no change"
    trashed: bool | None = None


@app.patch("/api/items/{item_id}")
def patch_item(item_id: int, body: ItemPatch):
    if not db.get_item(item_id):
        raise HTTPException(404)
    if body.set_collection:
        db.update_item(item_id, collection_id=body.collection_id)
    if body.trashed is not None:
        db.update_item(item_id, trashed=1 if body.trashed else 0)
    return _serialize(db.get_item(item_id))


@app.delete("/api/items/{item_id}")
def remove_item(item_id: int):
    db.delete_item(item_id)
    return {"ok": True}


class NewCollection(BaseModel):
    name: str
    parent_id: int | None = None


@app.post("/api/collections")
def add_collection(body: NewCollection):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "empty name")
    return {"id": db.find_or_create_collection(name, body.parent_id)}


class CollectionPatch(BaseModel):
    name: str


@app.patch("/api/collections/{cid}")
def patch_collection(cid: int, body: CollectionPatch):
    db.rename_collection(cid, body.name)
    return {"ok": True}


@app.delete("/api/collections/{cid}")
def remove_collection(cid: int):
    db.delete_collection(cid)
    return {"ok": True}


@app.post("/api/backup")
async def backup_now():
    if not backup_engine:
        raise HTTPException(503, "backup engine not running")
    ok, detail = await backup_engine.backup_now()
    return {"ok": ok, "detail": detail}
