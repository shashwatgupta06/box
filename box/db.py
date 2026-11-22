import sqlite3
import threading

from .config import DATA_DIR

DB_PATH = DATA_DIR / "box.db"

_lock = threading.Lock()
_conn = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS collections(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    message_id INTEGER,
    kind TEXT NOT NULL DEFAULT 'article',
    url TEXT,
    title TEXT,
    description TEXT,
    site_name TEXT,
    image_url TEXT,
    image_path TEXT,
    text TEXT,
    file_path TEXT,
    file_name TEXT,
    mime TEXT,
    collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    trashed INTEGER DEFAULT 0,
    custom_title INTEGER DEFAULT 0,
    tg_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS prompts(
    prompt_id INTEGER PRIMARY KEY,          -- the bot's buttons message in the Box chat
    item_id INTEGER NOT NULL,
    awaiting INTEGER DEFAULT 0,             -- 1 while waiting for a typed name after "+ New"
    parent_id INTEGER,                      -- where that new collection goes (NULL = top level)
    updated_at TEXT DEFAULT (datetime('now'))
);
"""


def conn():
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA foreign_keys=ON")
    return _conn


def init_db():
    with _lock:
        conn().executescript(SCHEMA)
        cols = {r[1] for r in conn().execute("PRAGMA table_info(items)")}
        for col, decl in ADDED_COLUMNS:   # databases created before these columns existed
            if col not in cols:
                conn().execute(f"ALTER TABLE items ADD COLUMN {col} {decl}")
        conn().commit()


# Columns added after the first release, with their declarations.
ADDED_COLUMNS = [
    ("custom_title", "INTEGER DEFAULT 0"),   # 1 = the user set this title; never replaced automatically
    ("ai_summary", "TEXT"),                  # short description written by the AI pass
    ("ai_title", "INTEGER DEFAULT 0"),       # 1 = the current title came from the AI pass
    ("original_title", "TEXT"),              # title before the AI pass replaced it (for undo)
    ("ai_done_at", "TEXT"),                  # when the AI pass handled this item; NULL = not yet
    ("ai_status", "TEXT"),                   # done | no_info | error
    ("ai_note", "TEXT"),                     # why the AI pass could not describe it
]


def q(sql, params=()):
    with _lock:
        cur = conn().execute(sql, params)
        conn().commit()
        return cur


def get_meta(key, default=None):
    row = q("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(key, value):
    q("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      (key, str(value)))


# ---------- collections ----------

def find_collection(name, parent_id=None):
    return q("SELECT * FROM collections WHERE lower(name)=lower(?) AND parent_id IS ?",
             (name.strip(), parent_id)).fetchone()


def create_collection(name, parent_id=None):
    cur = q("INSERT INTO collections(name,parent_id) VALUES(?,?)", (name.strip(), parent_id))
    return cur.lastrowid


def find_or_create_collection(name, parent_id=None):
    row = find_collection(name, parent_id)
    return row["id"] if row else create_collection(name, parent_id)


def find_named(name):
    """A collection the user means by a bare name: the top-level one, else the only one at any depth with that
    name (so "Robotics." finds Career / Robotics instead of making a second Robotics); None if absent or
    ambiguous."""
    top = find_collection(name)
    if top:
        return top
    rows = q("SELECT * FROM collections WHERE lower(name)=lower(?)", (name.strip(),)).fetchall()
    return rows[0] if len(rows) == 1 else None


def resolve_spec(col_name, sub_name=None):
    """'To-Buy', 'Kitchen' -> id of To-Buy/Kitchen, creating as needed. A name that exists only as a
    subcategory resolves to it."""
    found = find_named(col_name)
    cid = found["id"] if found else create_collection(col_name)
    if sub_name:
        return find_or_create_collection(sub_name, cid)
    return cid


def collections_tree():
    rows = [dict(r) for r in q("SELECT * FROM collections ORDER BY lower(name)").fetchall()]
    counts = {r["collection_id"]: r["n"] for r in q(
        "SELECT collection_id, COUNT(*) n FROM items WHERE trashed=0 GROUP BY collection_id").fetchall()}
    by_id = {r["id"]: {**r, "count": counts.get(r["id"], 0), "children": []} for r in rows}
    roots = []
    for c in by_id.values():
        if c["parent_id"] and c["parent_id"] in by_id:
            by_id[c["parent_id"]]["children"].append(c)
        else:
            roots.append(c)
    return roots


def collection_descendants(cid):
    ids = [cid]
    frontier = [cid]
    while frontier:
        qs = ",".join("?" * len(frontier))
        rows = q(f"SELECT id FROM collections WHERE parent_id IN ({qs})", frontier).fetchall()
        frontier = [r["id"] for r in rows]
        ids.extend(frontier)
    return ids


def collection_path(cid):
    parts = []
    while cid:
        row = q("SELECT * FROM collections WHERE id=?", (cid,)).fetchone()
        if not row:
            break
        parts.append(row["name"])
        cid = row["parent_id"]
    return " / ".join(reversed(parts))


def rename_collection(cid, name):
    q("UPDATE collections SET name=? WHERE id=?", (name.strip(), cid))


def delete_collection(cid):
    for did in collection_descendants(cid):
        q("UPDATE items SET collection_id=NULL WHERE collection_id=?", (did,))
    q("DELETE FROM collections WHERE id=?", (cid,))


# ---------- items ----------

ITEM_FIELDS = {"chat_id", "message_id", "kind", "url", "title", "custom_title", "description", "site_name",
               "image_url", "image_path", "text", "file_path", "file_name", "mime",
               "collection_id", "trashed", "tg_date",
               "ai_summary", "ai_title", "original_title", "ai_done_at", "ai_status", "ai_note"}


def create_item(fields):
    fields = {k: v for k, v in fields.items() if k in ITEM_FIELDS}
    cols = ",".join(fields)
    ph = ",".join("?" * len(fields))
    cur = q(f"INSERT INTO items({cols}) VALUES({ph})", tuple(fields.values()))
    return cur.lastrowid


def update_item(item_id, **fields):
    fields = {k: v for k, v in fields.items() if k in ITEM_FIELDS}
    if not fields:
        return
    sets = ",".join(f"{k}=?" for k in fields)
    q(f"UPDATE items SET {sets} WHERE id=?", (*fields.values(), item_id))


def get_item(item_id):
    return q("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()


def get_item_by_msg(chat_id, message_id):
    return q("SELECT * FROM items WHERE chat_id=? AND message_id=?", (chat_id, message_id)).fetchone()


def prev_item_before(chat_id, message_id):
    return q("SELECT * FROM items WHERE chat_id=? AND message_id<? ORDER BY message_id DESC LIMIT 1",
             (chat_id, message_id)).fetchone()


def delete_item(item_id):
    q("DELETE FROM items WHERE id=?", (item_id,))


def latest_item_id():
    """Highest item id: lets clients notice new saves with a cheap poll."""
    row = q("SELECT MAX(id) AS m FROM items").fetchone()
    return row["m"] or 0


def counts():
    row = q("""SELECT
        SUM(CASE WHEN trashed=0 THEN 1 ELSE 0 END) AS all_n,
        SUM(CASE WHEN trashed=0 AND collection_id IS NULL THEN 1 ELSE 0 END) AS unsorted_n,
        SUM(CASE WHEN trashed=1 THEN 1 ELSE 0 END) AS trash_n
        FROM items""").fetchone()
    return {"all": row["all_n"] or 0, "unsorted": row["unsorted_n"] or 0, "trash": row["trash_n"] or 0}


AI_PENDING_SQL = "trashed=0 AND url IS NOT NULL AND ai_done_at IS NULL"


def ai_pending_count():
    """Saved links the AI pass has never handled."""
    return q(f"SELECT COUNT(*) AS n FROM items WHERE {AI_PENDING_SQL}").fetchone()["n"]


def ai_pending_items():
    return [dict(r) for r in q(f"SELECT * FROM items WHERE {AI_PENDING_SQL} ORDER BY id").fetchall()]


def list_items(view="all", collection_id=None, kind=None, search=None):
    sql = "SELECT * FROM items WHERE trashed=?"
    params = [1 if view == "trash" else 0]
    if view == "unsorted":
        sql += " AND collection_id IS NULL"
    if collection_id:
        ids = collection_descendants(int(collection_id))
        sql += f" AND collection_id IN ({','.join('?' * len(ids))})"
        params.extend(ids)
    if kind:
        sql += " AND kind=?"
        params.append(kind)
    if search:
        like = f"%{search}%"
        sql += (" AND (title LIKE ? OR text LIKE ? OR url LIKE ? OR site_name LIKE ? OR description LIKE ?"
                " OR ai_summary LIKE ?)")
        params.extend([like] * 6)
    sql += " ORDER BY COALESCE(tg_date, created_at) DESC, id DESC"
    return [dict(r) for r in q(sql, params).fetchall()]


# ---------- Telegram buttons messages ----------

def save_prompt(prompt_id, item_id):
    q("""INSERT INTO prompts(prompt_id, item_id) VALUES(?,?)
         ON CONFLICT(prompt_id) DO UPDATE SET item_id=excluded.item_id, awaiting=0, parent_id=NULL,
         updated_at=datetime('now')""", (prompt_id, item_id))


def await_name(prompt_id, parent_id):
    q("UPDATE prompts SET awaiting=1, parent_id=?, updated_at=datetime('now') WHERE prompt_id=?",
      (parent_id, prompt_id))


def get_prompt(prompt_id):
    return q("SELECT * FROM prompts WHERE prompt_id=?", (prompt_id,)).fetchone()


def prompt_for_item(item_id):
    return q("SELECT * FROM prompts WHERE item_id=? ORDER BY prompt_id DESC LIMIT 1", (item_id,)).fetchone()


def latest_waiting_prompt(max_age_seconds):
    return q("""SELECT * FROM prompts WHERE awaiting=1 AND updated_at >= datetime('now', ?)
                ORDER BY updated_at DESC, prompt_id DESC LIMIT 1""", (f"-{int(max_age_seconds)} seconds",)).fetchone()
