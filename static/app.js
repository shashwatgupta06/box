/* Box — frontend */
const state = {
  view: "all",           // all | unsorted | trash
  collectionId: null,
  kind: "",
  q: "",
  layout: "grid",
  collections: [],
  expanded: new Set(JSON.parse(localStorage.getItem("box.expanded") || "[]")),
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => (s || "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ICONS = {
  article: '<svg viewBox="0 0 24 24"><path d="M7 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
  video: '<svg viewBox="0 0 24 24"><path d="m9.5 8.5 6 3.5-6 3.5v-7Z"/><rect x="3.5" y="5" width="17" height="14" rx="3"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m5 17 4.5-4.5 3 3L16 12l3.5 3.5"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M13 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V8.5L13 3Z"/><path d="M13 3v5.5h5.5"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="m15.5 4.5 4 4L8 20l-4.7.7L4 16 15.5 4.5Z"/></svg>',
};
const ACT = {
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4 11 13M18 13v6H5V6h6"/></svg>',
  move: '<svg viewBox="0 0 24 24"><path d="M4 8V6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"/><path d="M12 11v6m0-6-2.2 2.2M12 11l2.2 2.2"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12"/></svg>',
  restore: '<svg viewBox="0 0 24 24"><path d="M4 10a8 8 0 1 1 2 6"/><path d="M4 4v6h6"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
};

/* ---------- server connection ----------
 * Served by the Box server itself (python -m box run), the UI talks to its own origin.
 * Served as a static site (e.g. GitHub Pages), it talks to the server saved in this browser. */
const STATIC_HOST = location.hostname.endsWith("github.io") || location.protocol === "file:";
const conn = {
  get server() { return (localStorage.getItem("box.server") || "").replace(/\/+$/, ""); },
  get token() { return localStorage.getItem("box.token") || ""; },
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
    localStorage.removeItem("box.server");
    localStorage.removeItem("box.token");
  } else if (v === "ok") {
    localStorage.setItem("box.server", $("#connServer").value.trim());
    localStorage.setItem("box.token", $("#connToken").value.trim());
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

/* ---------- state / sidebar ---------- */

async function loadState() {
  const s = await api("/api/state");
  state.collections = s.collections;
  renderSyncPill(s.status);
  renderBackupPill(s.backup);
  renderSidebar(s.collections, s.counts);
}

function renderSyncPill(status) {
  const pill = $("#syncPill");
  pill.className = "sync-pill " + status.state;
  pill.title = status.detail || "";
  const labels = {
    online: "synced with Telegram",
    connecting: "connecting…",
    starting: "starting…",
    error: "sync error — hover for details",
    unconfigured: "Telegram not set up",
  };
  $("#syncText").textContent = labels[status.state] || status.state;
}

// On a static host the sync pill doubles as the way back to the connection settings.
if (STATIC_HOST) {
  $("#syncPill").style.cursor = "pointer";
  $("#syncPill").addEventListener("click", () => openConnect());
}

function renderBackupPill(b) {
  const pill = $("#backupPill");
  if (!b) { pill.style.display = "none"; return; }
  const cls = { ok: "online", running: "connecting", error: "error",
                disabled: "unconfigured", idle: "" }[b.state] || "";
  pill.className = "sync-pill " + cls;
  let label = "backup";
  if (b.state === "running") label = "backing up…";
  else if (b.state === "error") label = "backup failed";
  else if (b.state === "disabled") label = "backup off";
  else if (b.last_backup) {
    const h = Math.round((Date.now() - new Date(b.last_backup)) / 3600000);
    label = h < 1 ? "backed up just now" : `backed up ${h}h ago`;
  } else label = "no backup yet";
  pill.title = (b.detail || "") + " — click to back up now";
  $("#backupText").textContent = label;
}

$("#backupPill").addEventListener("click", async () => {
  renderBackupPill({ state: "running" });
  try { await api("/api/backup", { method: "POST" }); } catch (e) {}
  loadState();
});

function renderSidebar(cols, counts) {
  document.querySelectorAll(".view-btn").forEach((b) => {
    b.classList.toggle("active", state.collectionId === null && state.view === b.dataset.view);
  });
  const ul = $("#collectionList");
  ul.innerHTML = "";
  const make = (c, sub) => {
    const li = document.createElement("li");
    const row = document.createElement("button");
    row.className = "col-row" + (state.collectionId === c.id ? " active" : "");
    const hasKids = c.children && c.children.length > 0;
    const open = state.expanded.has(c.id);
    row.innerHTML =
      `<svg class="chev ${hasKids ? (open ? "open" : "") : "hidden"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>` +
      `<span class="col-name">${esc(c.name)}</span>` +
      (c.count ? `<span class="col-count">${c.count}</span>` : "") +
      `<span class="col-del" title="Delete collection">✕</span>`;
    row.querySelector(".chev").addEventListener("click", (e) => {
      if (!hasKids) return;
      e.stopPropagation();
      open ? state.expanded.delete(c.id) : state.expanded.add(c.id);
      localStorage.setItem("box.expanded", JSON.stringify([...state.expanded]));
      loadState();
    });
    row.querySelector(".col-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete collection "${c.name}"? Its items move to Unsorted.`)) return;
      await api(`/api/collections/${c.id}`, { method: "DELETE" });
      if (state.collectionId === c.id) state.collectionId = null;
      refresh();
    });
    row.addEventListener("click", () => {
      state.collectionId = c.id;
      state.view = "all";
      refresh();
    });
    li.appendChild(row);
    if (hasKids && open) {
      const kids = document.createElement("ul");
      kids.className = "col-children";
      c.children.forEach((k) => kids.appendChild(make(k, true)));
      li.appendChild(kids);
    }
    return li;
  };
  cols.forEach((c) => ul.appendChild(make(c, false)));
}

/* ---------- items ---------- */

function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((midnight(now) - midnight(d)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

async function loadItems() {
  const p = new URLSearchParams();
  p.set("view", state.view);
  if (state.collectionId) p.set("collection_id", state.collectionId);
  if (state.kind) p.set("kind", state.kind);
  if (state.q) p.set("q", state.q);
  const items = await api("/api/items?" + p);
  renderItems(items);
}

function renderItems(items) {
  const content = $("#content");
  content.classList.toggle("list", state.layout === "list");
  content.innerHTML = "";
  if (!items.length) {
    content.innerHTML = `<div class="empty"><div class="big">📦</div>
      Nothing here yet.<br>Share a post to your <b>Box</b> chat on Telegram and it will
      appear here — or press <b>+</b> to add a link by hand.</div>`;
    return;
  }
  let currentDay = null, grid = null;
  for (const it of items) {
    const label = dayLabel(it.date);
    if (label !== currentDay) {
      currentDay = label;
      const h = document.createElement("div");
      h.className = "day-label";
      h.textContent = label;
      content.appendChild(h);
      grid = document.createElement("div");
      grid.className = "masonry";
      content.appendChild(grid);
    }
    grid.appendChild(card(it));
  }
}

function card(it) {
  const el = document.createElement("article");
  el.className = "card" + (it.image ? "" : " no-image");
  const title = it.title || it.file_name || it.url || "";
  const src = it.site_name || (it.url ? new URL(it.url).hostname.replace(/^www\./, "") : "");
  const colpath = it.collection_path ? `<span class="colpath"> · ${esc(it.collection_path)}</span>` : "";
  let bodyInner;
  if (it.kind === "note") {
    bodyInner = `<div class="note-text">${esc(it.text)}</div><span class="src">Note${colpath}</span>`;
  } else {
    bodyInner = `<h3>${esc(title)}</h3><span class="src">${esc(src)}${colpath}</span>`;
  }
  el.innerHTML =
    (it.image ? `<img class="cover" src="${esc(mediaUrl(it.image))}" loading="lazy" alt="">` : "") +
    `<div class="scrim"></div>` +
    `<div class="body">${bodyInner}</div>` +
    `<div class="type-chip">${ICONS[it.kind] || ICONS.article}</div>` +
    `<div class="actions"></div>`;
  el.querySelector("img.cover")?.addEventListener("error", (e) => {
    e.target.remove();
    el.classList.add("no-image");
  });

  const actions = el.querySelector(".actions");
  const btn = (icon, title, cls, fn) => {
    const b = document.createElement("button");
    b.className = "act " + (cls || "");
    b.title = title;
    b.innerHTML = icon;
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    actions.appendChild(b);
  };
  if (state.view === "trash") {
    btn(ACT.restore, "Restore", "", async () => {
      await api(`/api/items/${it.id}`, patchBody({ trashed: false })); refresh();
    });
    btn(ACT.del, "Delete forever", "danger", async () => {
      if (!confirm("Delete this item permanently?")) return;
      await api(`/api/items/${it.id}`, { method: "DELETE" }); refresh();
    });
  } else {
    if (it.url) btn(ACT.open, "Open link", "", () => window.open(it.url, "_blank"));
    else if (it.file) btn(ACT.open, "Open file", "", () => window.open(mediaUrl(it.file), "_blank"));
    btn(ACT.move, "Move to collection", "", () => openMove(it));
    btn(ACT.trash, "Move to trash", "danger", async () => {
      await api(`/api/items/${it.id}`, patchBody({ trashed: true })); refresh();
    });
  }
  const target = it.url || mediaUrl(it.file);
  if (target) {
    el.style.cursor = "pointer";
    el.addEventListener("click", () => window.open(target, "_blank"));
  }
  return el;
}

const patchBody = (obj) => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

/* ---------- move dialog ---------- */

function flatCollections() {
  const out = [];
  const walk = (list, depth) => list.forEach((c) => {
    out.push({ id: c.id, name: c.name, depth });
    walk(c.children || [], depth + 1);
  });
  walk(state.collections, 0);
  return out;
}

function openMove(it) {
  const dlg = $("#dlgMove");
  const list = $("#moveList");
  list.innerHTML = "";
  const add = (label, id, sub) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (sub) b.className = "sub";
    b.addEventListener("click", async () => {
      await api(`/api/items/${it.id}`, patchBody({ set_collection: true, collection_id: id }));
      dlg.close(); refresh();
    });
    list.appendChild(b);
  };
  add("(Unsorted)", null, false);
  flatCollections().forEach((c) => add(c.name, c.id, c.depth > 0));
  dlg.showModal();
}
$("#moveCancel").addEventListener("click", () => $("#dlgMove").close());

/* ---------- dialogs: new collection / add link ---------- */

function fillParentSelect(sel, emptyLabel) {
  sel.innerHTML = `<option value="">${emptyLabel}</option>`;
  flatCollections().forEach((c) => {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = `${"  ".repeat(c.depth)}${c.name}`;
    sel.appendChild(o);
  });
}

$("#newCollectionBtn").addEventListener("click", () => {
  fillParentSelect($("#colParent"), "(top level)");
  $("#colName").value = "";
  $("#dlgCollection").showModal();
});
$("#dlgCollection").addEventListener("close", async () => {
  if ($("#dlgCollection").returnValue !== "ok") return;
  const name = $("#colName").value.trim();
  if (!name) return;
  await api("/api/collections", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parent_id: $("#colParent").value ? +$("#colParent").value : null }),
  });
  refresh();
});

$("#addBtn").addEventListener("click", () => {
  fillParentSelect($("#addParent"), "(unsorted)");
  if (state.collectionId) $("#addParent").value = state.collectionId;
  $("#addUrl").value = "";
  $("#dlgAdd").showModal();
});
$("#dlgAdd").addEventListener("close", async () => {
  if ($("#dlgAdd").returnValue !== "ok") return;
  const url = $("#addUrl").value.trim();
  if (!url) return;
  await api("/api/items", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, collection_id: $("#addParent").value ? +$("#addParent").value : null }),
  });
  refresh();
});

/* ---------- top-level controls ---------- */

document.querySelectorAll(".view-btn").forEach((b) =>
  b.addEventListener("click", () => {
    state.view = b.dataset.view;
    state.collectionId = null;
    refresh();
  }));

$("#kindTabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (!t) return;
  state.kind = t.dataset.kind;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  loadItems();
});

$("#searchBtn").addEventListener("click", () => {
  const inp = $("#searchInput");
  inp.classList.toggle("open");
  if (inp.classList.contains("open")) inp.focus();
  else { inp.value = ""; state.q = ""; loadItems(); }
});
let searchTimer;
$("#searchInput").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadItems(); }, 250);
});

$("#gridBtn").addEventListener("click", () => setLayout("grid"));
$("#listBtn").addEventListener("click", () => setLayout("list"));
function setLayout(l) {
  state.layout = l;
  localStorage.setItem("box.layout", l);
  $("#gridBtn").classList.toggle("active", l === "grid");
  $("#listBtn").classList.toggle("active", l === "list");
  loadItems();
}

$("#themeToggle").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = cur;
  localStorage.setItem("box.theme", cur);
});

/* ---------- boot ---------- */

function refresh() {
  loadState();
  loadItems();
}

(function boot() {
  const theme = localStorage.getItem("box.theme");
  if (theme) document.documentElement.dataset.theme = theme;
  const layout = localStorage.getItem("box.layout");
  if (layout) setLayout(layout); else loadItems();
  loadState();
  setInterval(loadState, 20000);   // keep the sync pill fresh
  setInterval(loadItems, 30000);   // pick up newly synced items
})();
