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
  latestId: null,       // newest save id the page has seen
  fresh: new Set(),     // ids of saves that just arrived (highlighted)
  ownAdds: new Set(),   // ids saved from this page's Add dialog: no notification for those
  unseen: 0,            // new saves while the tab was hidden (shown in the title)
  ai: null,             // AI titles pass: { state, done, total, pending, ready, detail, ... }
  hasMore: false,       // more saves to load for this view (paging)
  itemsKey: "",         // the loaded items as JSON: skip redrawing when nothing changed
  selecting: false,     // select mode: taps pick saves for bulk actions
  selected: new Set(),
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
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="3.5"/><path d="m10.5 12.5 8-8M16 7l2.5 2.5M14 9l2 2"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5.5 12.5 4 4 9-9"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24"><path d="M11 4.5l1.7 4.8 4.8 1.7-4.8 1.7L11 17.5l-1.7-4.8L4.5 11l4.8-1.7z"/><path d="M18 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg>',
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
 * Served as a static site (GitHub Pages), it talks to the server built into static/config.js at deploy time.
 * Access: the server's token, obtained once per browser through a Telegram sign-in link (#login=<code>). */
const STATIC_HOST = location.hostname.endsWith("github.io") || location.protocol === "file:";
const SERVER = String(window.BOX_SERVER || "").replace(/\/+$/, "");
const base = () => (STATIC_HOST ? SERVER : "");
const token = () => store.get("box.token", "") || "";

// Server-relative media links (/media/…) need the server address and, for <img>/links, the token in the URL.
function mediaUrl(u) {
  if (!u || !u.startsWith("/media/")) return u;
  const t = token() ? `?token=${encodeURIComponent(token())}` : "";
  return base() + u + t;
}

let signedOut = false;
function showSignIn(message) {
  signedOut = true;
  document.documentElement.classList.add("signed-out");
  $("#shelf").innerHTML = "";
  $("#boardLabel").hidden = true;
  $("#heroTitle").textContent = "Box";
  $("#heroMeta").textContent = "Your saves from Telegram";
  $("#crumbs").innerHTML = "";
  $("#signOutBtn").hidden = true;
  const noServer = STATIC_HOST && !SERVER;
  $("#board").innerHTML = `<div class="empty-state signin"><div class="art">${I.key}</div>
    <h3>${noServer ? "No Box server configured" : "Sign in to your Box"}</h3>
    ${message ? `<p class="signin-error">${esc(message)}</p>` : ""}
    ${noServer ? "<p>This copy of the page was published without a server address.</p>" : `
    <p>Send this message in your <b>Box</b> channel on Telegram, from any device:</p>
    <div class="pair-code" id="pairCode"><span class="pair-word">login</span> <span id="pairText">· · ·</span></div>
    <p class="signin-note" id="pairNote">This page signs itself in as soon as Box sees the message.</p>
    <div class="signin-or"><span>or, on the phone with Telegram</span></div>
    <p class="signin-alt">Send just <code>login</code> and tap the link Box replies with.</p>`}</div>`;
  if (!noServer) startPairing();
}

// Pairing: this screen shows a code; "login <code>" sent in the Box chat approves it, and the poll below
// receives the token. A new code is fetched when one expires.
let pairing = null;
async function startPairing() {
  if (pairing) clearTimeout(pairing.timer);
  pairing = { id: null, timer: null };
  const mine = pairing;
  try {
    const r = await fetch(base() + "/api/pair", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || "Could not start signing in.");
    if (mine !== pairing || !signedOut) return;
    mine.id = j.id;
    $("#pairText") && ($("#pairText").textContent = j.code);
    pollPairing(mine);
  } catch (e) {
    if ($("#pairNote")) $("#pairNote").textContent = e.message === "Failed to fetch" ? "Can't reach your Box server right now." : e.message;
    mine.timer = setTimeout(() => { if (mine === pairing && signedOut) startPairing(); }, 15000);
  }
}
function pollPairing(mine) {
  mine.timer = setTimeout(async () => {
    if (mine !== pairing || !signedOut) return;
    try {
      const r = await fetch(`${base()}/api/pair/${encodeURIComponent(mine.id)}`);
      if (r.status === 410) { startPairing(); return; }
      const j = await r.json();
      if (j.status === "approved") {
        store.set("box.token", j.token || "");
        pairing = null;
        signedIn();
        toast("Signed in");
        renderHero();
        refresh();
        return;
      }
    } catch (e) { /* network blip: keep polling */ }
    pollPairing(mine);
  }, document.hidden ? 6000 : 2000);
}

function signedIn() {
  if (pairing) { clearTimeout(pairing.timer); pairing = null; }
  if (!signedOut) return;
  signedOut = false;
  document.documentElement.classList.remove("signed-out");
}

// "Not signed in" is shown by the sign-in screen; keep it out of the console.
window.addEventListener("unhandledrejection", (e) => {
  if (["not signed in", "unauthorized"].includes(e.reason?.message)) e.preventDefault();
});

async function api(path, opts = {}) {
  if (STATIC_HOST && (!SERVER || !token())) {
    showSignIn();
    throw new Error("not signed in");
  }
  const headers = { ...(opts.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  let r;
  try {
    r = await fetch(base() + path, { ...opts, headers });
  } catch (e) {
    if (!opts.quiet) toast("Can't reach your Box server");   // background polls stay quiet while offline
    throw e;
  }
  if (r.status === 401) {
    const had = !!token();
    store.del("box.token");
    showSignIn(had ? "Your sign-in is no longer valid. Send login again." : "");
    throw new Error("unauthorized");
  }
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).detail; } catch (e) {}
    const msg = typeof detail === "string" && detail ? detail : `Something went wrong (${r.status})`;
    if (!opts.quiet) toast(msg, { ms: 5000 });
    const err = new Error(msg);
    err.status = r.status;
    err.shown = !opts.quiet;
    throw err;
  }
  signedIn();
  return r.json();
}
// Errors are already shown as a toast by api(); keep them out of the console.
window.addEventListener("unhandledrejection", (e) => { if (e.reason?.shown) e.preventDefault(); });

// A Telegram sign-in link opens the page at #login=<code>: swap the code for the token once.
async function redeemLoginLink() {
  const m = location.hash.match(/^#login=([\w-]+)/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);   // never leave the code in the URL
  try {
    const r = await fetch(base() + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: m[1] }) });
    if (!r.ok) {
      let detail = "This sign-in link has expired or was already used.";
      try { detail = (await r.json()).detail || detail; } catch (e) {}
      store.del("box.token");
      showSignIn(detail);
      return false;
    }
    store.set("box.token", (await r.json()).token || "");
    toast("Signed in");
  } catch (e) {
    showSignIn("Couldn't reach your Box server to sign in. Try the link again.");
    return false;
  }
  return true;
}

const jsonBody = (method, obj) => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj),
});

/* ---------- helpers ---------- */
let toastTimer;
function toast(msg, { image = null, sub = "", action = null, onAction = null, ms = 2200 } = {}) {
  const t = $("#toast");
  t.classList.toggle("rich", !!(image || sub || action));
  t.innerHTML =
    (image ? `<span class="toast-img" style="background-image:url('${esc(image)}')"></span>` : "") +
    `<span class="toast-text"><span class="toast-msg">${esc(msg)}</span>${sub ? `<span class="toast-sub">${esc(sub)}</span>` : ""}</span>` +
    (action ? `<button class="toast-act">${esc(action)}</button>` : "");
  t.querySelector(".toast-act")?.addEventListener("click", () => { t.classList.remove("show"); onAction?.(); });
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
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
  const s = await api("/api/state", { quiet: true });
  state.collections = s.collections;
  state.counts = s.counts;
  updateAi(s.ai);
  indexCollections(s.collections);
  if (state.collectionId && !state.byId.has(state.collectionId)) state.collectionId = null;
  renderStatus(s.status, s.backup);
  $("#signOutBtn").hidden = !token();
  renderDrawer();
  renderHero();
  if (state.loaded) renderShelf();   // the items may have arrived before the collections
  const latest = s.latest || 0;
  if (state.latestId === null) state.latestId = latest;
  else if (latest > state.latestId) {
    const since = state.latestId;
    state.latestId = latest;
    announceNewSaves(since);
  }
}

/* ---------- AI titles pass ---------- */
let aiTimer = null;
function updateAi(ai) {
  const was = state.ai?.state;
  state.ai = ai || null;
  if (!ai) return;
  if (was === "running" && ai.state !== "running") {
    const parts = [];
    if (ai.described) parts.push(`${plural(ai.described, "save")} described`);
    if (ai.no_info) parts.push(`${ai.no_info} with too little to go on`);
    if (ai.state === "error") toast(ai.detail || "AI titles stopped", { sub: parts.join(" · "), ms: 8000 });
    else toast("AI titles done", { sub: parts.join(" · ") || "Nothing needed changing", ms: 6000 });
    loadItems();
  } else if (ai.state === "running" && ai.done > (state.aiShown || 0)) {
    loadItems();   // show titles as they arrive
  }
  state.aiShown = ai.state === "running" ? ai.done : 0;
  clearTimeout(aiTimer);
  if (ai.state === "running") aiTimer = setTimeout(() => loadState().catch(() => {}), 2500);
}

async function runAi() {
  const ai = state.ai;
  if (ai?.state === "running") { toast(`Working… ${ai.done} of ${ai.total} done`); return; }
  if (ai && !ai.ready) {
    toast("AI titles aren't set up on the server yet", { sub: "On the server run: python -m box ai-key", ms: 7000 });
    return;
  }
  if (ai && !ai.pending) { toast("Every link already has an AI title"); return; }
  const s = await api("/api/ai/run", { method: "POST" });
  updateAi(s);
  renderHero();
  toast(`Writing titles for ${plural(s.total || s.pending, "save")}…`);
}

/* ---------- new-save notifications ---------- */
async function announceNewSaves(sinceId) {
  let recent = [];
  try { recent = await api("/api/items?view=all&limit=30", { quiet: true }); } catch (e) { return; }
  const added = recent.filter((it) => it.id > sinceId && !state.ownAdds.has(it.id));
  if (!added.length) return;
  added.forEach((it) => state.fresh.add(it.id));
  setTimeout(() => { added.forEach((it) => state.fresh.delete(it.id)); $$(".tile.fresh").forEach((el) => el.classList.remove("fresh")); }, 9000);
  if (document.hidden) {
    state.unseen += added.length;
    document.title = `(${state.unseen}) ${document.title.replace(/^\(\d+\) /, "")}`;
  }
  const first = added[0];
  const label = (it) => it.title || (it.kind === "note" ? (it.text || "").slice(0, 60) : "") || it.site_name || hostOf(it.url) || "New save";
  const where = (it) => it.collection_path ? `in ${it.collection_path}` : "in Unsorted";
  if (added.length === 1) {
    toast("New save", { image: first.image ? mediaUrl(first.image) : null, sub: `${label(first)} · ${where(first)}`,
                        action: "View", onAction: () => openItem(first), ms: 7000 });
  } else {
    toast(`${added.length} new saves`, { image: first.image ? mediaUrl(first.image) : null,
                                         sub: added.slice(0, 2).map(label).join(", ") + (added.length > 2 ? "…" : ""),
                                         action: "View", onAction: () => go({ view: "all", collectionId: null }), ms: 7000 });
  }
  loadItems();
  // Link previews (title, picture) usually land a few seconds after the message: refresh once more.
  setTimeout(() => { if (!signedOut) loadItems(); }, 8000);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.unseen) {
    state.unseen = 0;
    document.title = document.title.replace(/^\(\d+\) /, "");
  }
});

/* Saves load a page at a time; scrolling near the end loads the next page. A reload keeps as many as are
 * showing, and the board is only redrawn when something actually changed. */
const PAGE = 60;
let itemsReq = 0;
function itemsQuery(limit, offset = 0) {
  const p = new URLSearchParams({ view: state.view, limit, offset });
  if (state.collectionId) p.set("collection_id", state.collectionId);
  if (state.kind) p.set("kind", state.kind);
  if (state.q) p.set("q", state.q);
  return "/api/items?" + p;
}
async function loadItems({ quiet = false } = {}) {
  const req = ++itemsReq;
  const want = state.loaded ? Math.max(PAGE, state.items.length) : PAGE;
  const items = await api(itemsQuery(want), { quiet });
  if (req !== itemsReq) return;       // a newer request superseded this one
  const key = JSON.stringify(items);
  const changed = !state.loaded || key !== state.itemsKey;
  state.items = items;
  state.itemsKey = key;
  state.hasMore = items.length === want;
  if (state.selecting) {   // drop selections that are no longer in view
    const ids = new Set(items.map((it) => it.id));
    [...state.selected].forEach((id) => ids.has(id) || state.selected.delete(id));
    renderSelectBar();
  }
  state.loaded = true;
  if (changed) {
    renderShelf();
    renderBoard();
  }
  renderHero();
  updateMore();
}

let loadingMore = false;
async function loadMore() {
  if (loadingMore || !state.hasMore || !state.loaded) return;
  loadingMore = true;
  const req = itemsReq;
  try {
    const page = await api(itemsQuery(PAGE, state.items.length), { quiet: true });
    if (req !== itemsReq) return;     // the view changed meanwhile
    const known = new Set(state.items.map((it) => it.id));
    const fresh = page.filter((it) => !known.has(it.id));
    const start = state.items.length;
    state.items = state.items.concat(fresh);
    state.itemsKey = JSON.stringify(state.items);
    state.hasMore = page.length === PAGE;
    const cols = $$("#board .board-col");
    if (cols.length) fresh.forEach((it, i) => cols[(start + i) % cols.length].appendChild(tile(it)));
    else renderBoard();
    renderHero();
  } catch (e) { /* try again on the next scroll */ }
  finally {
    loadingMore = false;
    updateMore();
    // The observer only fires on a change: if the end of the list is still in sight, keep going.
    if (state.hasMore && $("#more").getBoundingClientRect().top < innerHeight + 600) setTimeout(loadMore, 50);
  }
}
function updateMore() {
  $("#more").hidden = !(state.loaded && state.hasMore && state.items.length);
}
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) loadMore();
}, { rootMargin: "600px" }).observe($("#more"));
// Also on scroll, for browsers that deliver intersection changes late.
window.addEventListener("scroll", () => {
  if (state.hasMore && !$("#more").hidden && $("#more").getBoundingClientRect().top < innerHeight + 600) loadMore();
}, { passive: true });

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
  if (signedOut) return;
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
  if (state.q) meta = `${state.items.length}${state.hasMore ? "+" : ""} result${state.items.length === 1 && !state.hasMore ? "" : "s"} for “${state.q}”`;
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
  const canSelect = state.items.length > 0;
  if (state.view === "trash") {
    tools.push(["all", I.grid, "All saves"]);
    if (canSelect) tools.push(["select", I.check, "Select", state.selecting ? "on" : ""]);
    if (state.counts.trash) tools.push(["emptytrash", I.x, "Empty trash", "danger"]);
  } else {
    tools.push(["add", I.plus, "Add"]);
    tools.push(["newcol", I.folderPlus, c ? "Subcategory" : "Collection"]);
    if (canSelect) tools.push(["select", I.check, "Select", state.selecting ? "on" : ""]);
    if (c) {
      tools.push(["rename", I.pencil, "Edit"]);
      tools.push(["delcol", I.trash, "Delete", "danger"]);
    } else {
      tools.push(["sync", I.sync, "Refresh"]);
      tools.push(["menu", I.inbox, "Browse"]);
      const ai = state.ai;
      if (ai && (ai.pending || ai.state === "running")) {
        tools.push(ai.state === "running"
          ? ["ai", I.sparkle, `Titling ${ai.done}/${ai.total}`, "busy"]
          : ["ai", I.sparkle, `AI titles <span class="count">${ai.pending}</span>`]);
      }
    }
  }
  // labels are fixed strings or numbers; the AI one carries a count badge
  $("#tools").innerHTML = tools.map(([act, icon, label, cls]) =>
    `<button class="tool ${cls || ""}" data-act="${act}"><i>${icon}</i><span>${label}</span></button>`).join("");
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
      if (!await askConfirm({ title: `Delete “${c.name}”?`, ok: "Delete", danger: true,
                              body: "Its saves and subcategories' saves move to Unsorted. The saves themselves are kept." })) return;
      await api(`/api/collections/${c.id}`, { method: "DELETE" });
      toast(`Deleted ${c.name}`);
      go({ view: "all", collectionId: c.parent ? c.parent.id : null });
      break;
    case "select": setSelecting(!state.selecting); break;
    case "emptytrash": {
      const n = state.counts.trash;
      if (!await askConfirm({ title: "Empty the trash?", ok: `Delete ${plural(n, "item")}`, danger: true,
                              body: "Everything in the trash is deleted for good, with its pictures and files. This can't be undone." })) return;
      const r = await api("/api/trash", { method: "DELETE" });
      setSelecting(false);
      toast(`Deleted ${plural(r.count, "item")}`);
      refresh();
      break;
    }
    case "sync": await refresh(); toast("Up to date"); break;
    case "ai": await runAi(); break;
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
  if (signedOut) return;
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
  if (signedOut) return;
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
  let h = "Nothing here yet", p = "Share a post to your <b>Box</b> chat on Telegram, or press <b>Add</b> to save a link or a note.";
  if (state.q) { h = "No matches"; p = `Nothing in this view matches “${esc(state.q)}”.`; }
  else if (state.kind) { h = `No ${KIND_LABEL[state.kind].toLowerCase()}s here`; p = "Try another filter."; }
  else if (state.view === "trash") { h = "Trash is empty"; p = "Deleted saves wait here until you remove them for good."; }
  else if (state.view === "unsorted") { h = "All sorted"; p = "Everything has a collection. Label a share like <code>Career.Reading.</code> to file it."; }
  else if (current()) { h = "This collection is empty"; p = `Label a share <code>${esc(pathOf(current()).map((x) => x.name).join("."))}.</code> to save it here.`; }
  return `<div class="empty-state"><div class="art">${state.q ? I.search : I.box}</div><h3>${h}</h3><p>${p}</p></div>`;
}

function tile(it) {
  const el = document.createElement("article");
  el.className = "tile" + (it.trashed ? " trashed" : "") + (state.fresh.has(it.id) ? " fresh" : "") +
    (state.selected.has(it.id) ? " selected" : "");
  el.dataset.id = it.id;
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
      ((it.summary || it.description) ? `<div class="t-body">${esc(it.summary || it.description)}</div>` : "") +
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
  el.insertAdjacentHTML("afterbegin", `<span class="sel-mark" aria-hidden="true">${I.check}</span>`);
  const activate = () => (state.selecting ? toggleSelected(it.id, el) : openItem(it));
  el.addEventListener("click", activate);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || (e.key === " " && state.selecting)) { e.preventDefault(); activate(); } });
  return el;
}

/* ---------- select mode (bulk actions) ---------- */
function setSelecting(on) {
  state.selecting = on;
  state.selected.clear();
  document.documentElement.classList.toggle("selecting", on);
  $$(".tile.selected").forEach((t) => t.classList.remove("selected"));
  renderSelectBar();
  renderHero();
}
function toggleSelected(id, el) {
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  el.classList.toggle("selected", state.selected.has(id));
  renderSelectBar();
}
function renderSelectBar() {
  const bar = $("#selectBar");
  bar.hidden = !state.selecting;
  if (!state.selecting) return;
  const n = state.selected.size;
  $("#selCount").textContent = n ? `${n} selected` : "Tap saves to select";
  const acts = state.view === "trash"
    ? [["restore", I.restore, "Restore", "outline"], ["delete", I.x, "Delete", "danger"]]
    : [["move", I.move, "Move", "outline"], ["trash", I.trash, "Trash", "danger"]];
  if (state.items.length) acts.unshift(["all", I.check, n === state.items.length ? "None" : "All", "ghost"]);
  $("#selActions").innerHTML = acts.map(([a, icon, label, cls]) =>
    `<button class="btn ${cls}" data-bulk="${a}" ${a !== "all" && !n ? "disabled" : ""} title="${label}">${icon}<span>${label}</span></button>`).join("");
}
$("#selCancel").addEventListener("click", () => setSelecting(false));
$("#selActions").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-bulk]");
  if (!b) return;
  const ids = [...state.selected];
  const n = ids.length;
  switch (b.dataset.bulk) {
    case "all":
      if (n === state.items.length) state.selected.clear();
      else state.items.forEach((it) => state.selected.add(it.id));
      $$(".tile").forEach((t) => t.classList.toggle("selected", state.selected.has(+t.dataset.id)));
      renderSelectBar();
      return;
    case "move":
      openMove({ ids });
      return;
    case "trash":
      await api("/api/items/bulk", jsonBody("POST", { ids, action: "trash" }));
      setSelecting(false);
      toast(`Moved ${plural(n, "save")} to trash`, { action: "Undo", ms: 7000, onAction: async () => {
        await api("/api/items/bulk", jsonBody("POST", { ids, action: "restore" }));
        toast("Restored");
        refresh();
      } });
      break;
    case "restore":
      await api("/api/items/bulk", jsonBody("POST", { ids, action: "restore" }));
      setSelecting(false);
      toast(`Restored ${plural(n, "save")}`);
      break;
    case "delete":
      if (!await askConfirm({ title: `Delete ${plural(n, "item")} for good?`, ok: "Delete", danger: true,
                              body: "Their pictures and files are deleted too. This can't be undone." })) return;
      await api("/api/items/bulk", jsonBody("POST", { ids, action: "delete" }));
      setSelecting(false);
      toast(`Deleted ${plural(n, "item")}`);
      break;
  }
  refresh();
});

/* ---------- confirm sheet ---------- */
function askConfirm({ title, body = "", ok = "OK", danger = false }) {
  const d = $("#dlgConfirm");
  $("#confirmTitle").textContent = title;
  $("#confirmBody").textContent = body;
  $("#confirmOk").textContent = ok;
  $("#confirmOk").className = "btn " + (danger ? "danger-solid" : "primary");
  d.returnValue = "";
  d.showModal();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
}

/* ---------- item actions ---------- */
async function setTrashed(it, trashed) {
  await api(`/api/items/${it.id}`, jsonBody("PATCH", { trashed }));
  closeItem();
  refresh();
  if (trashed) {
    toast("Moved to trash", { action: "Undo", ms: 7000, onAction: async () => {
      await api(`/api/items/${it.id}`, jsonBody("PATCH", { trashed: false }));
      toast("Restored");
      refresh();
    } });
  } else toast("Restored");
}
async function deleteForever(it) {
  if (!await askConfirm({ title: "Delete this save for good?", ok: "Delete", danger: true,
                          body: "Its picture or file is deleted too. This can't be undone." })) return;
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
  $("#itemTitleRow").hidden = false;
  $("#itemTitleForm").hidden = true;
  $("#itemEditTitle").hidden = it.kind === "note" || it.trashed;
  // The AI description replaces the site's own; before the AI pass, the site's description is all there is.
  $("#itemDesc").textContent = it.kind === "note" ? (it.text || it.title || "")
    : (it.summary || it.description || (it.text && it.text !== it.url ? it.text : "") || "");
  $("#itemDesc").classList.toggle("note-text", it.kind === "note");
  renderItemAi(it);
  renderItemMore(it);
  openItem.current = it;
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

function renderItemAi(it) {
  const box = $("#itemAi");
  box.innerHTML = "";
  if (it.ai_title) {
    box.innerHTML = `${I.sparkle}<span>Title by AI</span>` + (it.can_undo_title ? `<span>·</span><button type="button">Undo</button>` : "");
    box.querySelector("button")?.addEventListener("click", async () => {
      const saved = await api(`/api/items/${it.id}/undo-title`, { method: "POST" });
      itemChanged(saved);
      toast("Title restored");
    });
  } else if (it.ai_status === "no_info") {
    box.innerHTML = `${I.sparkle}<span>${esc(it.ai_note || "Not enough information to describe this link.")}</span>`;
  }
}

// Secondary actions for a saved link: fetch its preview again, or write its AI title and description again.
function renderItemMore(it) {
  const box = $("#itemMore");
  box.innerHTML = "";
  if (!it.url || it.trashed) return;
  const add = (icon, label, busyLabel, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `${icon}<span>${label}</span>`;
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.querySelector("span").textContent = busyLabel;
      try { await fn(); } catch (e) { /* api() showed the error */ }
      finally { if (b.isConnected) { b.disabled = false; b.querySelector("span").textContent = label; } }
    });
    box.appendChild(b);
  };
  add(I.sync, "Refresh preview", "Refreshing…", async () => {
    const saved = await api(`/api/items/${it.id}/refresh`, { method: "POST" });
    itemChanged(saved);
    toast("Preview refreshed");
  });
  add(I.sparkle, it.summary ? "Describe again" : "Describe with AI", "Describing…", async () => {
    if (state.ai && !state.ai.ready) {
      toast("AI titles aren't set up on the server yet", { sub: "On the server run: python -m box ai-key", ms: 7000 });
      return;
    }
    const saved = await api(`/api/items/${it.id}/redo-ai`, { method: "POST" });
    itemChanged(saved);
    toast(saved.ai_status === "no_info" ? "Not enough information to describe it" : "Described");
  });
}

// Replace a save in the list and in the open detail sheet after the server changed it.
function itemChanged(saved) {
  const i = state.items.findIndex((x) => x.id === saved.id);
  if (i >= 0) state.items[i] = saved;
  if ($("#dlgItem").open && openItem.current?.id === saved.id) openItem(saved);
  renderBoard();
}

$("#itemEditTitle").addEventListener("click", () => {
  const it = openItem.current;
  if (!it) return;
  $("#itemTitleInput").value = it.title || "";
  $("#itemTitleRow").hidden = true;
  $("#itemTitleForm").hidden = false;
  $("#itemTitleInput").focus();
  $("#itemTitleInput").select();
});
$("#itemTitleCancel").addEventListener("click", () => {
  $("#itemTitleForm").hidden = true;
  $("#itemTitleRow").hidden = false;
});
$("#itemTitleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const it = openItem.current;
  const title = $("#itemTitleInput").value.trim();
  if (!it || !title) return;
  const saved = await api(`/api/items/${it.id}`, jsonBody("PATCH", { title }));
  itemChanged(saved);
  toast("Title saved");
});
// Escape inside the title box cancels the edit instead of closing the sheet.
$("#itemTitleInput").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); $("#itemTitleCancel").click(); }
});

/* ---------- dialogs ---------- */
function fillCollectionSelect(sel, emptyLabel, selected, exclude = new Set()) {
  sel.innerHTML = `<option value="">${emptyLabel}</option>` + flatCollections().filter((c) => !exclude.has(c.id)).map((c) =>
    `<option value="${c.id}">${" ".repeat(c.depth)}${esc(c.name)}</option>`).join("");
  sel.value = selected ?? "";
}

// One box for both: a single link (with or without https://) is saved as a link, anything else as a note.
const LINK_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i;
function openAdd(prefill = "") {
  fillCollectionSelect($("#addParent"), "Unsorted", state.collectionId);
  $("#addText").value = prefill;
  $("#dlgAdd").showModal();
}
$("#addBtn").addEventListener("click", () => openAdd());
$("#dlgAdd").addEventListener("close", async () => {
  if ($("#dlgAdd").returnValue !== "ok") return;
  const value = $("#addText").value.trim();
  if (!value) return;
  const isLink = LINK_RE.test(value);
  toast("Saving…");
  const saved = await api("/api/items", jsonBody("POST", {
    ...(isLink ? { url: value } : { text: value }),
    collection_id: $("#addParent").value ? +$("#addParent").value : null }));
  if (saved?.id) state.ownAdds.add(saved.id);
  toast(isLink ? "Link saved" : "Note saved");
  refresh();
});
// Enter in the box saves (Shift+Enter for a new line in a note).
$("#addText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if ($("#addText").value.trim()) $("#dlgAdd").close("ok");
  }
});

let colDialog = {};
function openCollectionDialog({ parentId = null, rename = null } = {}) {
  colDialog = { rename };
  $("#colDlgTitle").textContent = rename ? "Edit collection" : (parentId ? "New subcategory" : "New collection");
  $("#colOk").textContent = rename ? "Save" : "Create";
  $("#colName").value = rename ? rename.name : "";
  // Editing: "Inside" moves the collection; it can't go inside itself or its own subcategories.
  const exclude = rename ? new Set(descendantIds(rename)) : new Set();
  fillCollectionSelect($("#colParent"), "Top level", rename ? (rename.parent ? rename.parent.id : null) : parentId, exclude);
  $("#dlgCollection").showModal();
  $("#colName").select();
}
$("#dlgCollection").addEventListener("close", async () => {
  if ($("#dlgCollection").returnValue !== "ok") return;
  const name = $("#colName").value.trim();
  if (!name) return;
  if (colDialog.rename) {
    const c = colDialog.rename;
    const parentId = $("#colParent").value ? +$("#colParent").value : null;
    const moved = parentId !== (c.parent ? c.parent.id : null);
    await api(`/api/collections/${c.id}`, jsonBody("PATCH", { name, set_parent: moved, parent_id: parentId }));
    toast(moved ? `Moved ${name}` : "Saved");
  } else {
    await api("/api/collections", jsonBody("POST", {
      name, parent_id: $("#colParent").value ? +$("#colParent").value : null }));
    toast(`Created ${name}`);
  }
  refresh();
});

// it: one save, or { ids: [...] } for the saves picked in select mode.
function openMove(it) {
  const list = $("#moveList");
  list.innerHTML = "";
  const many = Array.isArray(it.ids);
  $("#dlgMove h2").textContent = many ? `Move ${plural(it.ids.length, "save")} to…` : "Move to…";
  const add = (label, id, depth) => {
    const b = document.createElement("button");
    b.style.paddingLeft = `${12 + depth * 18}px`;
    b.innerHTML = (id === null ? I.inbox : I.folder) + esc(label);
    if (!many && id === it.collection_id) b.classList.add("current");
    b.addEventListener("click", async () => {
      if (many) {
        await api("/api/items/bulk", jsonBody("POST", { ids: it.ids, action: "move", collection_id: id }));
        setSelecting(false);
      } else {
        await api(`/api/items/${it.id}`, jsonBody("PATCH", { set_collection: true, collection_id: id }));
      }
      $("#dlgMove").close();
      toast((many ? `Moved ${plural(it.ids.length, "save")} to ` : "Moved to ") + (id === null ? "Unsorted" : label));
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
    else if (e.target === d) {
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
$("#signOutBtn").addEventListener("click", async () => {
  if (!await askConfirm({ title: "Sign out of Box on this device?", ok: "Sign out",
                          body: "You can sign in again with a code from your Telegram chat." })) return;
  store.del("box.token");
  closeDrawer();
  setSelecting(false);
  showSignIn();
});

// Export: everything Box knows (not the pictures and files themselves) as a JSON file.
$("#exportBtn").addEventListener("click", async () => {
  const data = await api("/api/export");
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `box-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Exported ${plural(data.items.length, "item")}`);
});

/* ---------- navigation ---------- */
function go({ view, collectionId }) {
  if (state.selecting) setSelecting(false);
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
  if (state.selecting) setSelecting(false);
  Object.assign(state, next);
  state.loaded = false;
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
  else if (e.key === "Escape" && state.selecting && !document.querySelector("dialog[open]")) setSelecting(false);
});

// Shared from another app through the phone's share menu (Box installed as an app): open Add, filled in.
function takeShared() {
  const p = new URLSearchParams(location.search);
  if (!["share_url", "share_text", "share_title"].some((k) => p.has(k))) return null;
  const url = p.get("share_url") || "";
  const text = p.get("share_text") || "";
  const inText = text.match(/https?:\/\/\S+/);
  history.replaceState(null, "", location.pathname + location.hash);
  return url || (inText ? inText[0] : "") || text || p.get("share_title") || "";
}

if ("serviceWorker" in navigator && location.protocol === "https:") {
  // At the site root (next to index.html) so it covers the whole app; lets the page be installed.
  navigator.serviceWorker.register(new URL("sw.js", location.href.split("#")[0].replace(/[^/]*$/, ""))).catch(() => {});
}

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
  lastCols = columnCount();
  showSkeleton();
  const shared = takeShared();
  redeemLoginLink().then((result) => {
    if (result === false) return;   // the sign-in screen is showing why the link failed
    Object.assign(state, fromHash());
    if (STATIC_HOST && (!SERVER || !token())) {
      showSignIn(shared ? "Sign in first, then share it again." : "");
      return;
    }
    renderHero();
    refresh();
    if (shared) openAdd(shared);
  });
  const pollState = () => {
    if (!signedOut) loadState().catch(() => {});
    setTimeout(pollState, document.hidden ? 30000 : 10000);   // new saves, status dot, counts
  };
  setTimeout(pollState, 10000);
  setInterval(() => { if (!document.hidden && !signedOut && !document.querySelector("dialog[open]")) loadItems({ quiet: true }).catch(() => {}); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !signedOut) refresh(); });
})();
