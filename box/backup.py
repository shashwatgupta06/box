"""Daily backup of Box data to Google Drive (or any rclone remote).

What gets backed up:
  - data/backups/box-YYYY-MM-DD.db    consistent SQLite snapshot (VACUUM INTO)
  - data/backups/box-YYYY-MM-DD.json  portable JSON export (readable without Box)
  - data/media/                       downloaded photos, files, link previews
  - config.json
The Telegram login session (box_session*) is deliberately NOT uploaded —
it grants access to the Telegram account and can simply be recreated by
logging in again after a restore.
"""
import asyncio
import json
import logging
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import db
from .config import ROOT, DATA_DIR

log = logging.getLogger("box.backup")

BACKUPS_DIR = DATA_DIR / "backups"
RCLONE = ROOT / ".venv" / "bin" / "rclone"

BACKUP_DEFAULTS = {
    "enabled": True,
    "remote": "gdrive",        # rclone remote name (rclone config)
    "folder": "Box-Backup",    # folder created in the root of your Drive
    "interval_hours": 24,
    "keep_snapshots": 14,      # daily snapshots kept (locally and on Drive)
}


def backup_cfg(cfg):
    out = dict(BACKUP_DEFAULTS)
    out.update(cfg.get("backup") or {})
    return out


def rclone_bin():
    if RCLONE.exists():
        return str(RCLONE)
    return "rclone"  # fall back to a system-wide install


def _snapshot_sqlite(dest: Path):
    if dest.exists():
        dest.unlink()
    con = sqlite3.connect(db.DB_PATH)
    try:
        con.execute(f"VACUUM INTO '{dest.as_posix()}'")
    finally:
        con.close()


def _export_json(dest: Path):
    dest.write_text(json.dumps(db.export_data(), ensure_ascii=False, indent=1))


def _prune_snapshots(keep):
    for pattern in ("box-*.db", "box-*.json"):
        files = sorted(BACKUPS_DIR.glob(pattern))
        for f in files[:-keep] if keep > 0 else []:
            f.unlink()


async def _rclone(*args):
    proc = await asyncio.create_subprocess_exec(
        rclone_bin(), *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace")


async def remote_configured(remote):
    code, out, _ = await _rclone("listremotes")
    return code == 0 and f"{remote}:" in out.split()


async def run_backup(cfg):
    """Returns (ok, detail)."""
    bc = backup_cfg(cfg)
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)

    # 1. local dated snapshot (always made, even if the upload then fails)
    day = time.strftime("%Y-%m-%d")
    _snapshot_sqlite(BACKUPS_DIR / f"box-{day}.db")
    _export_json(BACKUPS_DIR / f"box-{day}.json")
    _prune_snapshots(int(bc["keep_snapshots"]))

    # 2. upload
    if not await remote_configured(bc["remote"]):
        return False, (f'rclone remote "{bc["remote"]}" is not set up. '
                       f'Run: .venv/bin/rclone config  (see README)')
    dest = f'{bc["remote"]}:{bc["folder"]}'
    code, _, err = await _rclone(
        "sync", str(DATA_DIR), f"{dest}/data",
        "--exclude", "box_session*",       # never upload the Telegram session
        "--exclude", "box.db",             # live DB may be mid-write; snapshots cover it
        "--exclude", "box.db-*",
        "--fast-list", "--transfers", "4")
    if code != 0:
        return False, f"rclone sync failed: {err.strip().splitlines()[-1] if err.strip() else code}"
    code, _, err = await _rclone("copyto", str(ROOT / "config.json"), f"{dest}/config.json")
    if code != 0:
        return False, f"config upload failed: {err.strip().splitlines()[-1] if err.strip() else code}"
    return True, f"backed up to Drive ({dest})"


class BackupEngine:
    def __init__(self, cfg):
        self.cfg = cfg
        self.status = {"state": "idle", "detail": "", "last_backup": db.get_meta("last_backup")}

    async def run_loop(self):
        bc = backup_cfg(self.cfg)
        if not bc["enabled"]:
            self.status.update(state="disabled", detail="backup disabled in config.json")
            return
        while True:
            try:
                last = db.get_meta("last_backup")
                due = True
                if last:
                    age = datetime.now().astimezone() - datetime.fromisoformat(last)
                    due = age > timedelta(hours=float(bc["interval_hours"]))
                if due:
                    await self.backup_now()
            except Exception as e:
                log.exception("backup loop error")
                self.status.update(state="error", detail=str(e))
            await asyncio.sleep(30 * 60)  # re-check every 30 minutes

    async def backup_now(self):
        self.status.update(state="running", detail="backing up…")
        ok, detail = await run_backup(self.cfg)
        if ok:
            now = datetime.now().astimezone().isoformat(timespec="seconds")
            db.set_meta("last_backup", now)
            self.status.update(state="ok", detail=detail, last_backup=now)
            log.info("backup complete: %s", detail)
        else:
            self.status.update(state="error", detail=detail)
            log.warning("backup failed: %s", detail)
        return ok, detail


def main():
    """CLI: .venv/bin/python -m box backup"""
    from .config import load_config, ensure_dirs
    ensure_dirs()
    db.init_db()
    ok, detail = asyncio.run(run_backup(load_config()))
    print(("OK: " if ok else "FAILED: ") + detail)
    if ok:
        db.set_meta("last_backup", datetime.now().astimezone().isoformat(timespec="seconds"))
    raise SystemExit(0 if ok else 1)
