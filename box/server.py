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

from . import auth, db
from .config import ROOT, MEDIA_DIR, load_config, ensure_dirs, telegram_configured
from .metadata import classify_url, enrich_item, refresh_preview
from .sync import SyncEngine
from .backup import BackupEngine
from .ai import AiPass

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

ai_pass = AiPass()
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
    public = path == "/api/login" or path == "/api/pair" or path.startswith("/api/pair/")
    if _TOKEN and request.method != "OPTIONS" and path.startswith(("/api/", "/media/")) and not public:
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


@app.get("/sw.js")
def service_worker():
    """At the site root so it may cover the whole app (needed to install it as an app)."""
    return FileResponse(ROOT / "static" / "sw.js", media_type="text/javascript")


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
        "summary": item["ai_summary"],
        "ai_title": bool(item["ai_title"]),
        "can_undo_title": bool(item["ai_title"]) and item["original_title"] is not None,
        "ai_status": item["ai_status"],
        "ai_note": item["ai_note"],
    }


class Login(BaseModel):
    code: str


@app.post("/api/login")
def login(body: Login):
    """Swap a one-time code from a Telegram sign-in link for the access token."""
    if not auth.redeem(body.code.strip()):
        raise HTTPException(401, "This sign-in link has expired or was already used. Send login again.")
    return {"token": _TOKEN}


@app.post("/api/pair")
def pair_start():
    """Start signing in a device without Telegram: returns a code to send in the Box chat."""
    started = auth.start_pairing()
    if not started:
        raise HTTPException(429, "Too many sign-in requests are waiting. Try again in a few minutes.")
    pid, code = started
    return {"id": pid, "code": auth.format_pair_code(code), "expires_in": auth.PAIR_TTL_SECONDS}


@app.get("/api/pair/{pid}")
def pair_status(pid: str):
    status = auth.pairing_status(pid)
    if status == "approved":
        return {"status": "approved", "token": _TOKEN}
    if status == "gone":
        raise HTTPException(410, "This sign-in code expired.")
    return {"status": "pending"}


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
    buttons = engine.picker.status if engine else {"state": "off", "detail": ""}
    return {"status": status, "backup": backup, "buttons": buttons, "ai": ai_pass.public_status(),
            "collections": db.collections_tree(), "counts": db.counts(),
            "latest": db.latest_item_id()}


@app.post("/api/ai/run")
async def ai_run():   # async: the pass is started as a task on the server's event loop
    """Start the AI title + description pass over links it has never handled."""
    if not ai_pass.key():
        raise HTTPException(409, "No Claude API key on the server yet. On the server run: python -m box ai-key")
    ai_pass.start()
    return ai_pass.public_status()


@app.get("/api/items")
def items(view: str = "all", collection_id: int | None = None,
          kind: str | None = None, q: str | None = None, limit: int | None = None, offset: int = 0):
    limit = min(limit, 500) if limit else None
    rows = db.list_items(view=view, collection_id=collection_id, kind=kind, search=q, limit=limit, offset=offset)
    return [_serialize(r) for r in rows]


class NewItem(BaseModel):
    url: str | None = None          # a link to save ...
    text: str | None = None         # ... or a note
    collection_id: int | None = None


@app.post("/api/items")
async def add_item(body: NewItem):
    url = (body.url or "").strip()
    text = (body.text or "").strip()
    if url:
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
        item_id = db.create_item({"url": url, "kind": classify_url(url),
                                  "collection_id": body.collection_id, "tg_date": None})
        await enrich_item(item_id, url)
    elif text:
        item_id = db.create_item({"kind": "note", "text": text[:20000], "title": " ".join(text.split())[:120],
                                  "collection_id": body.collection_id, "tg_date": None})
    else:
        raise HTTPException(400, "Nothing to save: add a link or some text.")
    return _serialize(db.get_item(item_id))


@app.get("/api/export")
def export():
    """Everything in Box as one JSON file (the pictures and files themselves are not included)."""
    return JSONResponse(db.export_data(),
                        headers={"Content-Disposition": 'attachment; filename="box-export.json"'})


class Bulk(BaseModel):
    ids: list[int]
    action: str                     # move | trash | restore | delete
    collection_id: int | None = None


@app.post("/api/items/bulk")
def bulk(body: Bulk):
    ids = [i for i in body.ids[:1000] if db.get_item(i)]
    if body.action == "move":
        if body.collection_id is not None and not db.get_collection(body.collection_id):
            raise HTTPException(404, "That collection no longer exists.")
        for i in ids:
            db.update_item(i, collection_id=body.collection_id)
    elif body.action in ("trash", "restore"):
        for i in ids:
            db.update_item(i, trashed=1 if body.action == "trash" else 0)
    elif body.action == "delete":
        for i in ids:
            db.delete_item(i)
    else:
        raise HTTPException(400, "Unknown action.")
    return {"ok": True, "count": len(ids)}


@app.delete("/api/trash")
def empty_trash():
    return {"ok": True, "count": db.empty_trash()}


@app.post("/api/items/{item_id}/refresh")
async def refresh_item_preview(item_id: int):
    """Fetch the link's preview (description, picture) again."""
    if not db.get_item(item_id):
        raise HTTPException(404)
    if not await refresh_preview(item_id):
        raise HTTPException(502, "The site gave nothing new for this link.")
    return _serialize(db.get_item(item_id))


@app.post("/api/items/{item_id}/redo-ai")
async def redo_ai(item_id: int):
    """Write this save's AI title and description again."""
    if not db.get_item(item_id):
        raise HTTPException(404)
    err = await ai_pass.redo_one(item_id)
    if err:
        raise HTTPException(409, err)
    return _serialize(db.get_item(item_id))


class ItemPatch(BaseModel):
    collection_id: int | None = None
    set_collection: bool = False   # distinguishes "move to Unsorted" from "no change"
    trashed: bool | None = None
    title: str | None = None       # a title typed in the app; kept from then on


@app.patch("/api/items/{item_id}")
def patch_item(item_id: int, body: ItemPatch):
    if not db.get_item(item_id):
        raise HTTPException(404)
    if body.set_collection:
        db.update_item(item_id, collection_id=body.collection_id)
    if body.trashed is not None:
        db.update_item(item_id, trashed=1 if body.trashed else 0)
    if body.title is not None:
        title = " ".join(body.title.split())[:200]
        if not title:
            raise HTTPException(400, "The title can't be empty.")
        db.update_item(item_id, title=title, custom_title=1, ai_title=0)
    return _serialize(db.get_item(item_id))


@app.post("/api/items/{item_id}/undo-title")
def undo_ai_title(item_id: int):
    """Put back the title an item had before the AI pass renamed it."""
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(404)
    if not (item["ai_title"] and item["original_title"] is not None):
        raise HTTPException(409, "This title was not set by the AI.")
    db.update_item(item_id, title=item["original_title"], ai_title=0)
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
    name: str | None = None
    parent_id: int | None = None
    set_parent: bool = False        # distinguishes "move to the top level" from "no change"


@app.patch("/api/collections/{cid}")
def patch_collection(cid: int, body: CollectionPatch):
    if not db.get_collection(cid):
        raise HTTPException(404)
    if body.set_parent:
        err = db.move_collection(cid, body.parent_id)
        if err:
            raise HTTPException(409, err)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "The name can't be empty.")
        col = db.get_collection(cid)
        clash = db.find_collection(name, col["parent_id"])
        if clash and clash["id"] != cid:
            raise HTTPException(409, f"There is already a collection called {name} there.")
        db.rename_collection(cid, name)
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
