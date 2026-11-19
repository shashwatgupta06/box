/* Box — frontend. Plain JS, no build step: served by the Box server itself or as a static site. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

const state = {
  view: "all",          // all | unsorted | trash
  collectionId: null,
  kind: "",
  q: "",
  collections: [],      // tree from the server
  byId: new Map(),      // id -> collection node (with .parent)
  counts: { all: 0, unsorted: 0, trash: 0 },
  items: [],
  expanded: new Set(JSON.parse(store.get("box.expanded", "[]"))),
  loaded: false,
};

/* ---------- icons ---------- */
const I = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  folderPlus: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="m14.5 5.5 4 4L8 20H4v-4z"/><path d="m12.5 7.5 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M10 7V5h4v2M6.5 7l1 12.5h9l1-12.5"/></svg>',
  restore: '<svg viewBox="0 0 24 24"><path d="M4.5 11a7.5 7.5 0 1 1 2.2 5.3"/><path d="M4.5 5.5V11H10"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4.5h5.5V10M19.5 4.5 11 13M17.5 13.5v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1h5"/></svg>',
  move: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="m11 11 2.5 2.5L11 16M8 13.5h5.5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" class="chev"><path d="m9.5 6.5 5.5 5.5-5.5 5.5"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M4 13.5 6.3 6a1.5 1.5 0 0 1 1.4-1h8.6a1.5 1.5 0 0 1 1.4 1l2.3 7.5v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><path d="M4 13.5h4.5l1 2h5l1-2H20"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M4 8.2 12 4l8 4.2v7.6L12 20l-8-4.2z"/><path d="m4 8.2 8 4.3 8-4.3M12 12.5V20"/></svg>',
  sync: '<svg viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.5 3.5v3.4h-3.4M6.5 20.5v-3.4h3.4"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M7 18.5a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6-1.3 4.6 4.6 0 0 1 .5 9.3z"/><path d="m9.5 13.5 2.5-2.5 2.5 2.5M12 11v5.5"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/></svg>',
  kind: {
    article: '<svg viewBox="0 0 24 24"><path d="M7 4.5h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M9 8.5h6M9 12h6M9 15.5h4"/></svg>',
    video: '<svg viewBox="0 0 24 24"><path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l9.6-6.2a.8.8 0 0 0 0-1.4L9.2 5.1A.8.8 0 0 0 8 5.8z"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.5"/><path d="m5 17 4.5-4.5 3 3L16 12l3.5 3.5"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M13 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V8.5z"/><path d="M13 3.5v5h5"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M6 4.5h12a1.5 1.5 0 0 1 1.5 1.5v8.5l-5 5H6A1.5 1.5 0 0 1 4.5 18V6A1.5 1.5 0 0 1 6 4.5z"/><path d="M19.5 14.5h-5v5"/></svg>',
  },
};
const KIND_LABEL = { article: "Link", video: "Video", image: "Image", file: "File", note: "Note" };

/* ---------- server connection ----------
 * Served by the Box server itself (python -m box run), the UI talks to its own origin.
 * Served as a static site (e.g. GitHub Pages), it talks to the server saved in this browser. */
const STATIC_HOST = location.hostname.endsWith("github.io") || location.protocol === "file:";
const conn = {
  get server() { return (store.get("box.server", "") || "").replace(/\/+$/, ""); },
  get token() { return store.get("box.token", "") || ""; },
};
const base = () => (STATIC_HOST ? conn.server : "");

// Server-relative media links (/media/…) need the server address and, for <img>/links, the token in the URL.
function mediaUrl(u) {
  if (!u || !u.startsWith("/media/")) return u;
  const t = conn.token ? `?token=${encodeURIComponent(conn.token)}` : "";
  return base() + u + t;
}

let connectOpen = false;
function openConnect(message) {
  if (connectOpen) return;
  connectOpen = true;
  $("#connServer").value = conn.server;
  $("#connToken").value = conn.token;
  $("#connectError").textContent = message || "";
  $("#dlgConnect").showModal();
}
$("#dlgConnect").addEventListener("close", () => {
  connectOpen = false;
  const v = $("#dlgConnect").returnValue;
  if (v === "forget") {
    store.del("box.server");
    store.del("box.token");
  } else if (v === "ok") {
    store.set("box.server", $("#connServer").value.trim());
    store.set("box.token", $("#connToken").value.trim());
  } else return;
  refresh();
});

// "Not connected" and "unauthorized" are handled by the connect dialog; keep them out of the console.
window.addEventListener("unhandledrejection", (e) => {
  if (["not connected", "unauthorized"].includes(e.reason?.message)) e.preventDefault();
});

async function api(path, opts = {}) {
  if (STATIC_HOST && !conn.server) {
    openConnect();
    throw new Error("not connected");
  }
  const headers = { ...(opts.headers || {}) };
  if (conn.token) headers.Authorization = `Bearer ${conn.token}`;
  let r;
  try {
    r = await fetch(base() + path, { ...opts, headers });
  } catch (e) {
    if (STATIC_HOST) openConnect(`Could not reach ${conn.server}.`);
    throw e;
  }
  if (r.status === 401) {
    openConnect("The server refused the access token.");
    throw new Error("unauthorized");
  }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
const jsonBody = (method, obj) => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj),
});

/* ---------- helpers ---------- */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
}
// A letter badge per site (no third-party favicon service, so saved sites are not sent anywhere).
function favicon(url) {
  const h = hostOf(url);
  if (!h) return "";
  let hue = 0;
  for (const ch of h) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="favicon" style="--h:${hue}">${esc(h[0].toUpperCase())}</span>`;
}
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  const o = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
  return d.toLocaleDateString(undefined, o);
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function indexCollections(tree) {
  state.byId.clear();
  const walk = (list, parent) => list.forEach((c) => {
    c.parent = parent;
    c.total = c.count;
    state.byId.set(c.id, c);
    walk(c.children || [], c);
  });
  walk(tree, null);
  // totals include subcategories
  const total = (c) => (c.total = c.count + (c.children || []).reduce((s, k) => s + total(k), 0));
  tree.forEach(total);
}
function descendantIds(c) {
  const out = [c.id];
  (c.children || []).forEach((k) => out.push(...descendantIds(k)));
  return out;
}
function pathOf(c) {
  const out = [];
  for (let x = c; x; x = x.parent) out.unshift(x);
  return out;
}
function flatCollections() {
  const out = [];
  const walk = (list, depth) => list.forEach((c) => {
    out.push({ id: c.id, name: c.name, depth });
    walk(c.children || [], depth + 1);
  });
  walk(state.collections, 0);
  return out;
}
const current = () => (state.collectionId ? state.byId.get(state.collectionId) : null);

/* ---------- loading ---------- */
async function loadState() {
  const s = await api("/api/state");
  state.collections = s.collections;
  state.counts = s.counts;
  indexCollections(s.collections);
  if (state.collectionId && !state.byId.has(state.collectionId)) state.collectionId = null;
  renderStatus(s.status, s.backup);
  renderDrawer();
  renderHero();
  if (state.loaded) renderShelf();   // the items may have arrived before the collections
}

let itemsReq = 0;
async function loadItems() {
  const req = ++itemsReq;
  const p = new URLSearchParams({ view: state.view });
  if (state.collectionId) p.set("collection_id", state.collectionId);
  if (state.kind) p.set("kind", state.kind);
  if (state.q) p.set("q", state.q);
  const items = await api("/api/items?" + p);
  if (req !== itemsReq) return;       // a newer request superseded this one
  state.items = items;
  state.loaded = true;
  renderShelf();
  renderBoard();
  renderHero();
}

async function refresh() {
  await Promise.allSettled([loadState(), loadItems()]);
}

/* ---------- status ---------- */
function renderStatus(status, backup) {
  const cls = { online: "online", connecting: "busy", starting: "busy", error: "error", unconfigured: "" }[status.state] || "";
  const label = {
    online: "Synced with Telegram",
    connecting: "Connecting to Telegram…",
    starting: "Starting…",
    error: status.detail || "Sync error",
    unconfigured: "Telegram not set up",
  }[status.state] || status.state;
  $("#statusDot").className = "dot " + cls;
  $("#statusBtn").title = label + (status.detail && status.state !== "error" ? ` — ${status.detail}` : "");
  $("#syncRow .dot").className = "dot " + cls;
  $("#syncRow .txt").textContent = label;
  $("#syncRow").title = status.detail || label;

  const b = backup || { state: "idle" };
  const bcls = { ok: "online", running: "busy", error: "error" }[b.state] || "";
  let blabel = "Backup";
  if (b.state === "running") blabel = "Backing up…";
  else if (b.state === "error") blabel = "Backup failed";
  else if (b.state === "disabled") blabel = "Backup off";
  else if (b.last_backup) {
    const h = Math.round((Date.now() - new Date(b.last_backup)) / 3600000);
    blabel = h < 1 ? "Backed up just now" : `Backed up ${h}h ago`;
  } else blabel = "No backup yet";
  $("#backupRow .dot").className = "dot " + bcls;
  $("#backupRow .txt").textContent = blabel;
  $("#backupRow").title = (b.detail || "") + (b.state === "disabled" ? "" : " — click to back up now");
}

$("#backupRow").addEventListener("click", async () => {
  $("#backupRow .txt").textContent = "Backing up…";
  $("#backupRow .dot").className = "dot busy";
  try {
    const r = await api("/api/backup", { method: "POST" });
    toast(r.ok ? "Backup done" : (r.detail || "Backup failed"));
  } catch (e) { toast("Backup failed"); }
  loadState();
});
$("#statusBtn").addEventListener("click", () => openDrawer());

/* ---------- hero: title, breadcrumb, tools ---------- */
function renderHero() {
  const c = current();
  const crumbs = $("#crumbs");
  crumbs.innerHTML = "";
  let title, meta;
  if (c) {
    const path = pathOf(c);
    const parts = [`<button data-go="all">All saves</button>`];
    path.slice(0, -1).forEach((p) => parts.push(`<button data-go="${p.id}">${esc(p.name)}</button>`));
    crumbs.innerHTML = parts.join('<span class="sep">/</span>');
    title = c.name;
    const subs = (c.children || []).length;
    meta = plural(c.total, "save") + (subs ? ` · ${plural(subs, "subcategory").replace("subcategorys", "subcategories")}` : "");
  } else if (state.view === "unsorted") {
    title = "Unsorted"; meta = `${plural(state.counts.unsorted, "save")} waiting for a collection`;
  } else if (state.view === "trash") {
    title = "Trash"; meta = `${plural(state.counts.trash, "item")} · kept until you delete them`;
  } else {
    title = "All saves";
    meta = `${plural(state.counts.all, "save")} · ${plural(state.collections.length, "collection")}`;
  }
  if (state.q) meta = `${plural(state.items.length, "result")} for “${state.q}”`;
  $("#heroTitle").textContent = title;
  $("#heroMeta").textContent = meta;

  // search scope chip
  $("#scopeName").textContent = c ? c.name : (state.view === "all" ? "Box" : title);
  const cover = c ? coverImages(c, 1)[0] : null;
  const thumb = $("#scopeThumb");
  thumb.style.backgroundImage = cover ? `url("${cover}")` : "";
  thumb.innerHTML = cover ? "" : (c ? I.folder : I.box);

  // views
  $$("#viewNav button").forEach((b) => b.classList.toggle("active", !c && b.dataset.view === state.view));
  document.title = c ? `${c.name} · Box` : (state.view === "all" ? "Box" : `${title} · Box`);

  // tools
  const tools = [];
  if (state.view === "trash") {
    tools.push(["all", I.grid, "All saves"]);
  } else {
    tools.push(["add", I.plus, "Add"]);
    tools.push(["newcol", I.folderPlus, c ? "Subcategory" : "Collection"]);
    if (c) {
      tools.push(["rename", I.pencil, "Rename"]);
      tools.push(["delcol", I.trash, "Delete", "danger"]);
    } else {
      tools.push(["sync", I.sync, "Refresh"]);
      tools.push(["menu", I.inbox, "Browse"]);
    }
  }
  $("#tools").innerHTML = tools.map(([act, icon, label, cls]) =>
    `<button class="tool ${cls || ""}" data-act="${act}"><i>${icon}</i>${label}</button>`).join("");
}

$("#crumbs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (!b) return;
  b.dataset.go === "all" ? go({ view: "all", collectionId: null }) : go({ view: "all", collectionId: +b.dataset.go });
});

$("#tools").addEventListener("click", async (e) => {
  const b = e.target.closest(".tool");
  if (!b) return;
  const c = current();
  switch (b.dataset.act) {
    case "add": openAdd(); break;
    case "newcol": openCollectionDialog({ parentId: c ? c.id : null }); break;
    case "rename": openCollectionDialog({ rename: c }); break;
    case "delcol":
      if (!confirm(`Delete “${c.name}”? Its saves move to Unsorted.`)) return;
      await api(`/api/collections/${c.id}`, { method: "DELETE" });
      toast(`Deleted ${c.name}`);
      go({ view: "all", collectionId: c.parent ? c.parent.id : null });
      break;
    case "sync": await refresh(); toast("Up to date"); break;
    case "menu": openDrawer(); break;
    case "all": go({ view: "all", collectionId: null }); break;
  }
});

/* ---------- collection shelf (cover cards) ---------- */
function coverImages(c, n = 3) {
  const ids = new Set(descendantIds(c));
  const out = [];
  for (const it of state.items) {
    if (it.image && ids.has(it.collection_id)) {
      out.push(mediaUrl(it.image));
      if (out.length >= n) break;
    }
  }
  return out;
}

function renderShelf() {
  const shelf = $("#shelf");
  shelf.innerHTML = "";
  $("#boardLabel").hidden = true;
  if (state.q || state.kind || state.view !== "all") return;
  const c = current();
  const list = c ? (c.children || []) : state.collections;
  list.forEach((col) => {
    const imgs = coverImages(col, 3);
    const card = document.createElement("button");
    card.className = "col-card";
    card.innerHTML =
      (imgs.length
        ? `<div class="col-cover">${[0, 1, 2].map((i) => `<span style="${imgs[i] ? `background-image:url('${esc(imgs[i])}')` : ""}"></span>`).join("")}</div>`
        : `<div class="col-cover empty">${I.folder}</div>`) +
      `<div class="col-name">${esc(col.name)}</div>` +
      `<div class="col-count">${plural(col.total, "save")}${(col.children || []).length ? ` · ${(col.children || []).length} inside` : ""}</div>`;
    card.addEventListener("click", () => go({ view: "all", collectionId: col.id }));
    shelf.appendChild(card);
  });
  $("#boardLabel").hidden = !list.length || !state.items.length;
}

/* ---------- board (masonry) ---------- */
function columnCount() {
  const w = $("#board").clientWidth || window.innerWidth;
  if (w >= 1240) return 5;
  if (w >= 980) return 4;
  if (w >= 700) return 3;
  return 2;
}

function renderBoard() {
  const board = $("#board");
  board.innerHTML = "";
  if (!state.loaded) return;
  if (!state.items.length) {
    board.innerHTML = emptyState();
    return;
  }
  const n = columnCount();
  const cols = Array.from({ length: n }, () => {
    const d = document.createElement("div");
    d.className = "board-col";
    board.appendChild(d);
    return d;
  });
  // Left to right, so the newest saves fill the top row.
  state.items.forEach((it, i) => cols[i % n].appendChild(tile(it)));
}

function emptyState() {
  let h = "Nothing here yet", p = "Share a post to your <b>Box</b> chat on Telegram, or press <b>Add</b> to save a link.";
  if (state.q) { h = "No matches"; p = `Nothing in this view matches “${esc(state.q)}”.`; }
  else if (state.kind) { h = `No ${KIND_LABEL[state.kind].toLowerCase()}s here`; p = "Try another filter."; }
  else if (state.view === "trash") { h = "Trash is empty"; p = "Deleted saves wait here until you remove them for good."; }
  else if (state.view === "unsorted") { h = "All sorted"; p = "Everything has a collection. Label a share like <code>Career.Reading.</code> to file it."; }
  else if (current()) { h = "This collection is empty"; p = `Label a share <code>${esc(pathOf(current()).map((x) => x.name).join("."))}.</code> to save it here.`; }
  return `<div class="empty-state"><div class="art">${state.q ? I.search : I.box}</div><h3>${h}</h3><p>${p}</p></div>`;
}

function tile(it) {
  const el = document.createElement("article");
  el.className = "tile" + (it.trashed ? " trashed" : "");
  el.tabIndex = 0;
  const host = it.url ? hostOf(it.url) : "";
  const site = it.site_name || host;
  const title = it.title || it.file_name || it.url || "";
  const img = it.image ? mediaUrl(it.image) : null;
  const colName = it.collection_path ? it.collection_path.split(" / ").pop() : "";

  let frame;
  if (img) {
    frame = `<div class="tile-frame"><img src="${esc(img)}" loading="lazy" alt="">` +
      (it.kind === "video" ? `<span class="kind-badge">${I.kind.video}Video</span>` : "") +
      `<div class="tile-actions"></div></div>`;
  } else if (it.kind === "note") {
    frame = `<div class="tile-frame"><div class="tile-text note"><div class="t-body">${esc(it.text || title)}</div></div><div class="tile-actions"></div></div>`;
  } else {
    frame = `<div class="tile-frame"><div class="tile-text">` +
      `<div class="t-site">${it.url ? favicon(it.url) : I.kind[it.kind] || ""}${esc(site || KIND_LABEL[it.kind] || "")}</div>` +
      `<div class="t-title">${esc(title)}</div>` +
      (it.description ? `<div class="t-body">${esc(it.description)}</div>` : "") +
      `</div><div class="tile-actions"></div></div>`;
  }
  const showCap = img || it.kind !== "note";
  el.innerHTML = frame + (showCap && img ? `<div class="tile-cap">
      <div class="c-title">${esc(title)}</div>
      <div class="c-meta">${it.url ? favicon(it.url) : ""}<span>${esc(site || KIND_LABEL[it.kind])}</span>${colName ? `<span>·</span><span class="c-col">${esc(colName)}</span>` : ""}</div>
    </div>` : (colName || it.kind === "note" ? `<div class="tile-cap"><div class="c-meta"><span>${esc(when(it.date))}</span>${colName ? `<span>·</span><span class="c-col">${esc(colName)}</span>` : ""}</div></div>` : ""));

  el.querySelector("img")?.addEventListener("error", (e) => {
    // Preview image gone: fall back to a text tile.
    const f = e.target.closest(".tile-frame");
    e.target.remove();
    f.insertAdjacentHTML("afterbegin", `<div class="tile-text"><div class="t-site">${it.url ? favicon(it.url) : ""}${esc(site)}</div><div class="t-title">${esc(title)}</div></div>`);
    el.querySelector(".tile-cap")?.remove();
  });

  const actions = el.querySelector(".tile-actions");
  const act = (icon, label, fn, cls = "") => {
    const b = document.createElement("button");
    b.className = cls;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = icon;
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    actions.appendChild(b);
  };
  if (it.trashed) {
    act(I.restore, "Restore", () => setTrashed(it, false));
    act(I.x, "Delete forever", () => deleteForever(it), "danger");
  } else {
    const target = it.url || mediaUrl(it.file);
    if (target) act(I.open, "Open", () => window.open(target, "_blank", "noopener"));
    act(I.move, "Move", () => openMove(it));
    act(I.trash, "Move to trash", () => setTrashed(it, true), "danger");
  }
  el.addEventListener("click", () => openItem(it));
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") openItem(it); });
  return el;
}

/* ---------- item actions ---------- */
async function setTrashed(it, trashed) {
  await api(`/api/items/${it.id}`, jsonBody("PATCH", { trashed }));
  toast(trashed ? "Moved to trash" : "Restored");
  closeItem();
  refresh();
}
async function deleteForever(it) {
  if (!confirm("Delete this save permanently? This cannot be undone.")) return;
  await api(`/api/items/${it.id}`, { method: "DELETE" });
  toast("Deleted");
  closeItem();
  refresh();
}

function openItem(it) {
  const dlg = $("#dlgItem");
  const img = it.image ? mediaUrl(it.image) : null;
  const media = $("#itemMedia");
  media.innerHTML = img ? `<img src="${esc(img)}" alt="">` : "";
  dlg.classList.toggle("no-media", !img);

  const site = it.site_name || (it.url ? hostOf(it.url) : KIND_LABEL[it.kind]);
  $("#itemSrc").innerHTML = `${it.url ? favicon(it.url) : I.kind[it.kind] || ""}<span>${esc(site)}</span><span>·</span><span>${esc(when(it.date))}</span>`;
  $("#itemTitle").textContent = it.kind === "note" ? "Note" : (it.title || it.file_name || it.url || "");
  $("#itemDesc").textContent = it.kind === "note" ? (it.text || it.title || "")
    : (it.description || (it.text && it.text !== it.url ? it.text : "") || "");
  $("#itemDesc").classList.toggle("note-text", it.kind === "note");
  const colBtn = $("#itemCol");
  colBtn.innerHTML = `${I.folder}${esc(it.collection_path || "Unsorted")}`;
  colBtn.onclick = () => {
    closeItem();
    it.collection_id ? go({ view: "all", collectionId: it.collection_id }) : go({ view: "unsorted", collectionId: null });
  };

  const acts = $("#itemActions");
  acts.innerHTML = "";
  const btn = (label, icon, cls, fn) => {
    const b = document.createElement("button");
    b.className = "btn " + cls;
    b.innerHTML = icon + label;
    b.addEventListener("click", fn);
    acts.appendChild(b);
  };
  if (it.trashed) {
    btn("Restore", I.restore, "primary", () => setTrashed(it, false));
    btn("Delete forever", I.x, "danger", () => deleteForever(it));
  } else {
    const target = it.url || mediaUrl(it.file);
    if (target) btn(it.url ? "Open link" : "Open file", I.open, "primary", () => window.open(target, "_blank", "noopener"));
    btn("Move", I.move, "outline", () => { closeItem(); openMove(it); });
    btn("Trash", I.trash, "danger", () => setTrashed(it, true));
  }
  dlg.showModal();
}
function closeItem() { if ($("#dlgItem").open) $("#dlgItem").close(); }

/* ---------- dialogs ---------- */
function fillCollectionSelect(sel, emptyLabel, selected) {
  sel.innerHTML = `<option value="">${emptyLabel}</option>` + flatCollections().map((c) =>
    `<option value="${c.id}">${" ".repeat(c.depth)}${esc(c.name)}</option>`).join("");
  sel.value = selected ?? "";
}

function openAdd() {
  fillCollectionSelect($("#addParent"), "Unsorted", state.collectionId);
  $("#addUrl").value = "";
  $("#dlgAdd").showModal();
}
$("#addBtn").addEventListener("click", openAdd);
$("#dlgAdd").addEventListener("close", async () => {
  if ($("#dlgAdd").returnValue !== "ok") return;
  const url = $("#addUrl").value.trim();
  if (!url) return;
  toast("Saving…");
  await api("/api/items", jsonBody("POST", {
    url, collection_id: $("#addParent").value ? +$("#addParent").value : null }));
  toast("Saved");
  refresh();
});

let colDialog = {};
function openCollectionDialog({ parentId = null, rename = null } = {}) {
  colDialog = { rename };
  $("#colDlgTitle").textContent = rename ? "Rename collection" : (parentId ? "New subcategory" : "New collection");
  $("#colOk").textContent = rename ? "Save" : "Create";
  $("#colName").value = rename ? rename.name : "";
  $("#colParentField").hidden = !!rename;
  fillCollectionSelect($("#colParent"), "Top level", parentId);
  $("#dlgCollection").showModal();
  $("#colName").select();
}
$("#dlgCollection").addEventListener("close", async () => {
  if ($("#dlgCollection").returnValue !== "ok") return;
  const name = $("#colName").value.trim();
  if (!name) return;
  if (colDialog.rename) {
    await api(`/api/collections/${colDialog.rename.id}`, jsonBody("PATCH", { name }));
    toast("Renamed");
  } else {
    await api("/api/collections", jsonBody("POST", {
      name, parent_id: $("#colParent").value ? +$("#colParent").value : null }));
    toast(`Created ${name}`);
  }
  refresh();
});

function openMove(it) {
  const list = $("#moveList");
  list.innerHTML = "";
  const add = (label, id, depth) => {
    const b = document.createElement("button");
    b.style.paddingLeft = `${12 + depth * 18}px`;
    b.innerHTML = (id === null ? I.inbox : I.folder) + esc(label);
    if (id === it.collection_id) b.classList.add("current");
    b.addEventListener("click", async () => {
      await api(`/api/items/${it.id}`, jsonBody("PATCH", { set_collection: true, collection_id: id }));
      $("#dlgMove").close();
      toast(id === null ? "Moved to Unsorted" : `Moved to ${label}`);
      refresh();
    });
    list.appendChild(b);
  };
  add("Unsorted", null, 0);
  flatCollections().forEach((c) => add(c.name, c.id, c.depth));
  $("#dlgMove").showModal();
}

// [data-close] buttons and clicks on the backdrop close sheets.
$$("dialog").forEach((d) => {
  d.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) d.close();
    else if (e.target === d && d.id !== "dlgConnect") {
      const r = d.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) d.close();
    }
  });
});

/* ---------- drawer ---------- */
function openDrawer() {
  $("#drawer").classList.add("open");
  $("#scrim").classList.add("open");
}
function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#scrim").classList.remove("open");
}
$("#menuBtn").addEventListener("click", openDrawer);
$("#drawerClose").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
$("#drawerNewCol").addEventListener("click", () => { closeDrawer(); openCollectionDialog({}); });

function renderDrawer() {
  const views = [["all", I.grid, "All saves", state.counts.all], ["unsorted", I.inbox, "Unsorted", state.counts.unsorted],
                 ["trash", I.trash, "Trash", state.counts.trash]];
  $("#drawerViews").innerHTML = views.map(([v, icon, label, n]) =>
    `<button class="row ${!state.collectionId && state.view === v ? "active" : ""}" data-view="${v}">
       <span class="r-ico">${icon}</span><span class="r-name">${label}</span><span class="r-count">${n || ""}</span></button>`).join("");

  const tree = $("#tree");
  tree.innerHTML = "";
  if (!state.collections.length) {
    tree.innerHTML = `<li class="status-row">No collections yet. Label a share like <b>&nbsp;Career.Reading.</b></li>`;
  }
  const make = (c) => {
    const li = document.createElement("li");
    const kids = c.children || [];
    const open = state.expanded.has(c.id) || (state.collectionId && pathOf(current() || {}).some((p) => p.id === c.id));
    li.innerHTML = `<button class="row ${state.collectionId === c.id ? "active" : ""}">
        ${I.chev}<span class="r-name">${esc(c.name)}</span><span class="r-count">${c.total || ""}</span></button>`;
    const chev = li.querySelector(".chev");
    chev.classList.toggle("hidden", !kids.length);
    chev.classList.toggle("open", !!open && kids.length > 0);
    chev.addEventListener("click", (e) => {
      if (!kids.length) return;
      e.stopPropagation();
      state.expanded.has(c.id) ? state.expanded.delete(c.id) : state.expanded.add(c.id);
      store.set("box.expanded", JSON.stringify([...state.expanded]));
      renderDrawer();
    });
    li.querySelector(".row").addEventListener("click", () => { closeDrawer(); go({ view: "all", collectionId: c.id }); });
    if (kids.length && open) {
      const ul = document.createElement("ul");
      kids.forEach((k) => ul.appendChild(make(k)));
      li.appendChild(ul);
    }
    return li;
  };
  state.collections.forEach((c) => tree.appendChild(make(c)));
}
$("#drawerViews").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (!b) return;
  closeDrawer();
  go({ view: b.dataset.view, collectionId: null });
});

/* theme */
function effectiveTheme() {
  return document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function syncThemeUI() {
  const dark = effectiveTheme() === "dark";
  $("#themeBtn").textContent = dark ? "Light mode" : "Dark mode";
  $('meta[name="theme-color"]').content = dark ? "#151112" : "#fbf6f6";
}
$("#themeBtn").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("box.theme", next);
  syncThemeUI();
});
if (STATIC_HOST) {
  $("#connectBtn").hidden = false;
  $("#connectBtn").addEventListener("click", () => { closeDrawer(); openConnect(); });
}

/* ---------- navigation ---------- */
function go({ view, collectionId }) {
  state.view = view;
  state.collectionId = collectionId;
  const hash = collectionId ? `#c/${collectionId}` : (view === "all" ? "" : `#${view}`);
  if (location.hash !== hash) history.pushState(null, "", hash || location.pathname + location.search);
  state.loaded = false;
  showSkeleton();
  renderHero();
  renderDrawer();
  refresh();   // collections too: the previous action may have created, renamed or deleted one
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function fromHash() {
  const h = location.hash.slice(1);
  const m = h.match(/^c\/(\d+)$/);
  if (m) return { view: "all", collectionId: +m[1] };
  if (h === "unsorted" || h === "trash") return { view: h, collectionId: null };
  return { view: "all", collectionId: null };
}
// Back/forward and links that change only the #fragment.
function onLocationChange() {
  const next = fromHash();
  if (next.view === state.view && next.collectionId === state.collectionId) return;
  Object.assign(state, next);
  closeDrawer();
  renderHero();
  renderDrawer();
  loadItems();
}
window.addEventListener("popstate", onLocationChange);
window.addEventListener("hashchange", onLocationChange);

$("#viewNav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (b) go({ view: b.dataset.view, collectionId: null });
});
$("#logoBtn").addEventListener("click", () => go({ view: "all", collectionId: null }));

$("#kindTabs").addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  state.kind = t.dataset.kind;
  $$("#kindTabs button").forEach((x) => x.classList.toggle("active", x === t));
  loadItems();
});

let searchTimer;
$("#searchInput").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadItems(); }, 220);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.querySelector("dialog[open]")) {
    e.preventDefault();
    $("#searchInput").focus();
  }
  if (e.key === "Escape" && $("#drawer").classList.contains("open")) closeDrawer();
});

function showSkeleton() {
  const board = $("#board");
  const n = columnCount();
  const hs = [220, 300, 180, 260, 340, 200, 280, 240];
  board.innerHTML = Array.from({ length: n }, (_, c) =>
    `<div class="board-col">${[0, 1].map((r) => `<div class="tile skeleton"><div class="tile-frame" style="height:${hs[(c * 2 + r) % hs.length]}px"></div></div>`).join("")}</div>`).join("");
  $("#shelf").innerHTML = "";
  $("#boardLabel").hidden = true;
}

let lastCols = 0;
window.addEventListener("resize", () => {
  const n = columnCount();
  if (n !== lastCols && state.loaded) { lastCols = n; renderBoard(); }
});

/* ---------- boot ---------- */
(function boot() {
  syncThemeUI();
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", syncThemeUI);
  Object.assign(state, fromHash());
  lastCols = columnCount();
  showSkeleton();
  renderHero();
  refresh();
  setInterval(() => { if (!document.hidden) loadState(); }, 20000);   // status dot + counts
  setInterval(() => { if (!document.hidden && !document.querySelector("dialog[open]")) loadItems(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
