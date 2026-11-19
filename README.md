# 📦 Box

**Save anything from your phone by sharing it to a Telegram chat.** Box runs on
your own computer, syncs those messages — even ones sent while the computer was
off — and organizes them into collections with a visual card UI.

[![CI](https://github.com/shashwatgupta06/box/actions/workflows/ci.yml/badge.svg)](https://github.com/shashwatgupta06/box/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-3776ab.svg)](https://www.python.org/downloads/)

![The Box web UI — sidebar of collections and a grid of saved cards](docs/screenshot.png)

<sub>Fresh install with demo data — the status pills go green once Telegram and
backups are connected.</sub>

## How it works

1. On your phone, share any post / article / video / photo / file to your
   **Box** chat on Telegram.
2. Name the destination in a short message — either as the **comment** in Telegram's share sheet
   (Telegram sends it just before the shared item) or as the **next message** after it:

   ```
   Career.Computer Vision.
   ```

   That's `Collection.Subcategory` (the subcategory is optional; `To-Buy // Kitchen` works too).
   Collections and subcategories are created automatically if they don't exist yet.
   Add a title in parentheses to name the card yourself — `Career.New.(Kitchen appliance)` — or
   send just `(Kitchen appliance)` to set the title only.
   You can also **reply** to any earlier shared message with a collection name.
3. If you don't send a collection message, the item lands in **Unsorted** and
   you can move it from the web UI later.

Because Box logs in as *you* (via Telegram's official API), it can read the
chat's full history — so anything shared while your computer was offline is
picked up the next time Box starts. It also fetches link previews (title,
source, cover image) for everything you save.

Everything stays on your machine: a SQLite database plus downloaded media in
`data/`. No accounts, no server, nothing leaves your computer except the
optional backup to your own Google Drive.

## Setup

**1. Install** (Python 3.11 or newer):

```bash
git clone https://github.com/shashwatgupta06/box.git
cd box
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp config.example.json config.json
```

**2. Get Telegram API keys** (free, takes 2 minutes):
go to <https://my.telegram.org> → *API development tools* → create an app.
Copy the `api_id` and `api_hash` into your `config.json`.

**3. Create the chat**: in Telegram, create a new **private channel** named
`Box` (just you in it — it becomes your personal inbox and is easy to share
to). Alternatively, set `"chat": "me"` in config.json to use your
*Saved Messages* instead.

**4. Log in** (asks for your phone number + the code Telegram sends you):

```bash
.venv/bin/python -m box login
```

## Run it

```bash
./run.sh
```

Then open <http://localhost:8750>. The pill in the top-right shows sync status.
Box re-checks the chat every ~90 seconds and also receives new messages
instantly while online.

## Try it without Telegram

Seed sample data to explore the UI first:

```bash
.venv/bin/python -m box demo
```

(Reset later with `rm data/box.db data/media/demo_*.svg`.)

## Use it from anywhere: UI on GitHub Pages, server on a small VM

The web UI is plain static files, so it is also published to GitHub Pages
(<https://shashwatgupta06.github.io/box/>) by `.github/workflows/pages.yml` on every push to `main`
that touches `static/`. The Pages copy holds no data; the address of your Box server is built in from the
repository variable `BOX_SERVER`.

**Signing in** — no passwords or forms, confirmed from your own Telegram chat:
- *A device without Telegram (laptop):* the sign-in screen shows a code such as `login KD7 4PX`. Send
  that message in your Box chat from your phone; the screen signs itself in within a couple of seconds.
- *The phone with Telegram:* send just `login`; Box replies with a link that works once, for 10 minutes,
  and opens the web UI signed in (the code sits in the URL fragment, so it never reaches any server but
  yours).

To run the server somewhere always on (any small Linux VM with a public IP; an `e2-micro` on Google
Cloud's free tier is enough):

```bash
# on the server
git clone https://github.com/shashwatgupta06/box.git && cd box
bash deploy/setup-server.sh <ip-with-dashes>.sslip.io https://<user>.github.io
```

`setup-server.sh` installs [Caddy](https://caddyserver.com/) for automatic HTTPS, runs Box as a
systemd service on `127.0.0.1:8750` behind it, and writes a `config.json` with a fresh
`access_token`, the Pages origin in `cors_origins` and the UI address in `ui_url` (used in sign-in
links). Open ports 80 and 443 to the server, add your
Telegram `api_id` / `api_hash` to `config.json`, run `.venv/bin/python -m box login` once, and
`sudo systemctl restart box`. Later updates: `bash deploy/update-server.sh` on the server.

With `access_token` set, every `/api` and `/media` request must carry it (as a Bearer header, or
`?token=` for images and file links); browsers get it through the Telegram sign-in link. Generate a new
one with `python -m box token` to sign every device out. Leave it empty only
when Box listens on `127.0.0.1` for your own machine.

## Daily Google Drive backup

Box backs itself up once a day while it's running (and catches up on start if
a day was missed): a dated, consistent snapshot of the database plus a
portable JSON export land in `data/backups/`, and the whole data folder
(snapshots, photos, files, link previews, config) is synced to your Drive
with [rclone](https://rclone.org/install/). The raw Telegram chat itself
already lives on Telegram's cloud, so between the two, a dead computer costs
you nothing.

**One-time setup** (authorizes rclone with your Google account in a browser):

```bash
rclone config
```

Choose: `n` (new remote) → name it `gdrive` → storage type `drive` →
leave client id/secret empty → scope `1` (full access) or `3`
(access to files created by rclone only — enough for Box) → accept defaults →
say **yes** to auto config, and finish the Google login it opens in your
browser.

That's it — the next backup goes to the `Box-Backup` folder in your Drive.
Check the *backup* pill in the top-right of the UI (click it to back up
immediately), or run one manually:

```bash
.venv/bin/python -m box backup
```

Settings live under `"backup"` in config.json: `remote`, `folder`,
`interval_hours`, `keep_snapshots` (dated snapshots retained), `enabled`.
Set `"enabled": false` to turn backups off entirely.

**Restoring on a fresh machine**: clone this project, then download the
`Box-Backup/data` folder from Drive into `data/`, and rename the newest
`data/backups/box-YYYY-MM-DD.db` to `data/box.db`. Run `python -m box login`
again (the Telegram session is intentionally never uploaded) and start Box.

## Project layout

```
box/
  __main__.py    CLI entry point — run | login | demo | backup | token
  server.py      FastAPI app and JSON API
  sync.py        Telegram client: history catch-up + live updates
  metadata.py    link previews (title, source, cover image)
  db.py          SQLite schema and queries
  backup.py      daily snapshot + rclone upload
  login.py       one-time Telegram sign-in
  config.py      config loading and defaults
  demo.py        sample data seeder
static/          single-page UI — plain HTML/CSS/JS, no build step (also published to GitHub Pages)
deploy/          server setup and update scripts (Caddy + systemd)
data/            local state: database, media, backups (never committed)
```

## Notes

- `config.json` options: `chat` (chat title or `"me"`), `host` and `port`,
  `max_file_mb` (largest shared file to download), `access_token`, `cors_origins`, `ui_url`, and
  the `backup` block.
  It's gitignored — `config.example.json` is the template.
- Trash keeps items until you delete them permanently from the Trash view.
- Never share `data/box_session.session` — it grants access to your Telegram
  account. Backups deliberately exclude it.

## License

[MIT](LICENSE) © 2026 Shashwat Gupta
