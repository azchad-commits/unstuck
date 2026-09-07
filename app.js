/* Unstuck — countdown planner for ADHD + time blindness.
   Local-first: everything lives in localStorage. If config.js has Supabase keys, plans also sync
   (magic-link sign-in; per-task merge with tombstones; server clamps clock skew). */
(() => {
"use strict";

// ---------- storage (device-local, always on) ----------
const KEY = "unstuck-v1", TKEY = "unstuck-timer", MINS = [5, 10, 15, 30, 45, 60, 90];
let db = { plans: [], current: null };
let view = "day", openDay = null, monthCursor = null, editDays = new Set();
const $ = id => document.getElementById(id);

function normalize(p) {
  return { updated_at: new Date(0).toISOString(), deleted: false, tombstones: [], tasks: {}, ...p };
}
function load() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) { console.warn("localStorage unavailable", e); }
  if (raw) {
    try { db = JSON.parse(raw); }
    catch (e) {
      // Don't silently wipe a corrupted file: keep it, tell the user, start fresh.
      console.error("Saved plans could not be read; backup kept in unstuck-v1-corrupt", e);
      try { localStorage.setItem(KEY + "-corrupt", raw); } catch (x) {}
      db = { plans: [], current: null };
      setTimeout(() => banner("Your saved plans couldn't be read. A backup was kept on this device.", true), 0);
    }
  }
  db.plans = (db.plans || []).map(normalize);
}
let saveFailed = false;
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); if (saveFailed) { saveFailed = false; banner(""); } return true; }
  catch (e) { console.error("persist failed", e); if (!saveFailed) { saveFailed = true; banner("Couldn't save to this device (storage full?). Changes may be lost when you close the app.", true); } return false; }
}
// Every mutation goes through save(plan): stamps updated_at so sync can resolve conflicts.
function save(p) { if (p) { p.updated_at = new Date().toISOString(); sync.markDirty(p.id); } persist(); }
// Another tab/window wrote to storage: reload state so both stay in step.
window.addEventListener("storage", e => { if (e.key === KEY) { load(); render(); } if (e.key === TKEY) { resumeTimer(); render(); } });

// ---------- date helpers ----------
const iso = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const pd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const fmt = d => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const plan = () => db.plans.find(p => p.id === db.current && !p.deleted);
// Count calendar days, immune to DST (compare UTC day numbers of local dates).
const dayNum = d => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
const daysLeft = (p, d) => dayNum(pd(p.end)) - dayNum(d);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- banner + undo toast ----------
function banner(text, err) { const b = $("banner"); b.textContent = text; b.classList.toggle("err", !!err); b.classList.toggle("on", !!text); }
let undoFn = null, undoT = null;
function toast(text, onUndo) {
  const t = $("toast"); $("toastTxt").textContent = text; t.classList.add("on"); undoFn = onUndo;
  clearTimeout(undoT); undoT = setTimeout(() => { t.classList.remove("on"); undoFn = null; }, 7000);
}
$("undo").onclick = () => { if (undoFn) undoFn(); undoFn = null; $("toast").classList.remove("on"); };

// ---------- render ----------
function render() {
  const p = plan(); const T = today();
  const live = db.plans.filter(x => !x.deleted);
  $("plansel").innerHTML = live.map(x => `<option value="${x.id}" ${x.id === db.current ? "selected" : ""}>${esc(x.name)}</option>`).join("") + `<option value="__new">+ New countdown</option>`;
  $("plansel").hidden = live.length === 0;
  const main = $("main"); main.innerHTML = "";
  document.querySelectorAll(".views button[data-v]").forEach(b => { const on = b.dataset.v === view; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  if (!p) {
    $("big").hidden = true; $("lbl").innerHTML = "no countdown yet<b>" + fmt(T) + "</b>";
    main.innerHTML = `<div class="empty">Pick a deadline. The app numbers the days backward from it.<br><button id="first">Start a countdown</button></div>`;
    $("first").onclick = () => openNew($("first")); return;
  }
  $("big").hidden = false;
  const left = daysLeft(p, T);
  const big = $("big"); big.textContent = Math.max(0, left); big.classList.toggle("hot", left <= 6);
  $("lbl").innerHTML = (left > 0 ? "days left" : left === 0 ? "deadline day" : "done") + "<b>" + fmt(T) + "</b>";
  if (view === "day") renderDays(main, p, T, [iso(T)], true);
  else if (view === "week") { const ds = []; for (let i = 0; i < 7; i++) { const d = new Date(T); d.setDate(d.getDate() + i); ds.push(iso(d)); } renderDays(main, p, T, ds, false); }
  else renderMonth(main, p, T);
  const n = document.createElement("p"); n.className = "note"; n.textContent = "Tap the minutes on a task to start its timer. Tap ☆ to make it the one thing."; main.appendChild(n);
}

function heroHTML(star) {
  if (!star) return "";
  if (star.done) return `<div class="hero done"><span class="hcheck">✓</span> Done for today — ${esc(star.title)}</div>`;
  const isThisTimer = timerTaskName === star.title && timerEl.classList.contains("on");
  const timerDone = isThisTimer && timerEl.classList.contains("done");
  if (isThisTimer && !timerDone) {
    return `<div class="hero"><div class="htitle">One thing today</div><div class="hname">${esc(star.title)}</div><button class="hbtn quiet" disabled aria-label="Timer running: ${esc(star.title)}">Timer running</button></div>`;
  }
  const markDone = timerDone || !star.min;
  const label = markDone ? "Mark done" : `Start ${star.min} min`;
  const cls = markDone ? "navy" : "amber";
  return `<div class="hero"><div class="htitle">One thing today</div><div class="hname">${esc(star.title)}</div><button class="hbtn ${cls}"${markDone ? ' data-mark="1"' : ""} aria-label="${label}: ${esc(star.title)}">${label}</button></div>`;
}

function renderDays(main, p, T, dates, expandAll) {
  dates.forEach(ds => {
    const d = pd(ds); const dl = daysLeft(p, d); const tasks = p.tasks[ds] || [];
    const isToday = iso(d) === iso(T); const isPast = d < T;
    const open = expandAll || openDay === ds || (isToday && openDay === null);
    const editing = editDays.has(ds);
    const el = document.createElement("section"); el.className = "day" + (isToday ? " today" : "") + (isPast ? " past" : "") + (open && editing ? " editing" : "");
    const allDone = tasks.length && tasks.every(t => t.done);
    const star = tasks.find(t => t.star);
    const bodyId = "body-" + ds;
    el.innerHTML = `<div class="hd"><button class="hdmain" ${expandAll ? "" : `aria-expanded="${open}" aria-controls="${bodyId}"`}><span class="d">${fmt(d)}<small>${star ? esc(star.title) : (tasks.length ? tasks.length + " tasks" : "nothing planned")}</small></span>${isToday ? '<span class="tag">Today</span>' : ""}<span class="left ${dl <= 6 ? "urgent" : ""}">${allDone ? "✓ done" : dl < 0 ? "past" : dl === 0 ? "day 0" : dl + " left"}</span></button>${open && tasks.length ? `<button class="editbtn" aria-pressed="${editing}">${editing ? "Done" : "Edit"}</button>` : ""}</div>
    ${open ? `<div class="body" id="${bodyId}">${heroHTML(star)}${tasks.map(t => `<div class="task ${t.done ? "on" : ""}" data-id="${t.id}"><button class="chk ${t.done ? "on" : ""}" aria-pressed="${t.done}" aria-label="${t.done ? "Mark not done" : "Mark done"}: ${esc(t.title)}"></button><div class="txt">${esc(t.title)}</div><button class="star ${t.star ? "on" : ""}" aria-pressed="${t.star}" aria-label="${t.star ? "This is the one thing" : "Make this the one thing"}: ${esc(t.title)}">${t.star ? "★" : "☆"}</button>${t.min ? `<button class="min" aria-label="Start ${t.min} minute timer: ${esc(t.title)}">${t.min} min</button>` : ""}<button class="del" aria-label="Delete: ${esc(t.title)}">×</button></div>`).join("")}
    <div class="add"><input placeholder="Add a task…" aria-label="New task for ${fmt(d)}"><select aria-label="Minutes">${MINS.map(m => `<option value="${m}" ${m === 30 ? "selected" : ""}>${m}m</option>`).join("")}<option value="0">no timer</option></select><button>Add</button></div></div>` : ""}`;
    el.querySelector(".hdmain").onclick = () => { if (!expandAll) { openDay = openDay === ds ? "" : ds; render(); } };
    const editBtn = el.querySelector(".editbtn");
    if (editBtn) editBtn.onclick = () => { if (editing) editDays.delete(ds); else editDays.add(ds); render(); };
    if (open) {
      const heroBtn = el.querySelector(".hbtn");
      if (heroBtn && !heroBtn.disabled) heroBtn.onclick = () => { if (heroBtn.dataset.mark) { star.done = true; save(p); render(); } else startTimer(star.min, star.title); };
      const inp = el.querySelector(".add input"), selm = el.querySelector(".add select");
      const add = () => { const t = inp.value.trim(); if (!t) return; const list = (p.tasks[ds] = p.tasks[ds] || []); list.push({ id: uid(), title: t, min: +selm.value, done: false, star: list.length === 0 }); save(p); render(); };
      el.querySelector(".add button").onclick = add; inp.onkeydown = e => { if (e.key === "Enter") add(); };
      el.querySelectorAll(".task").forEach(row => {
        const t = tasks.find(x => x.id === row.dataset.id);
        row.querySelector(".chk").onclick = () => { t.done = !t.done; save(p); render(); };
        row.querySelector(".star").onclick = () => { const was = t.star; tasks.forEach(x => x.star = false); t.star = !was; save(p); render(); };
        row.querySelector(".del").onclick = () => {
          const idx = tasks.indexOf(t); p.tasks[ds] = tasks.filter(x => x !== t); p.tombstones = (p.tombstones || []).concat(t.id).slice(-500); save(p); render();
          toast(`Deleted "${t.title}"`, () => { const list = (p.tasks[ds] = p.tasks[ds] || []); list.splice(Math.min(idx, list.length), 0, t); p.tombstones = p.tombstones.filter(id => id !== t.id); save(p); render(); });
        };
        const m = row.querySelector(".min"); if (m) m.onclick = () => startTimer(t.min, t.title);
      });
    }
    main.appendChild(el);
  });
}

function renderMonth(main, p, T) {
  const cur = monthCursor || new Date(T.getFullYear(), T.getMonth(), 1);
  const nav = document.createElement("div"); nav.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px";
  nav.innerHTML = `<button class="min" id="pm" aria-label="Previous month">‹</button><b aria-live="polite">${cur.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</b><button class="min" id="nm" aria-label="Next month">›</button>`;
  main.appendChild(nav);
  nav.querySelector("#pm").onclick = () => { monthCursor = new Date(cur.getFullYear(), cur.getMonth() - 1, 1); render(); };
  nav.querySelector("#nm").onclick = () => { monthCursor = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); render(); };
  const mh = document.createElement("div"); mh.className = "mh"; mh.setAttribute("aria-hidden", "true"); mh.innerHTML = "SMTWTFS".split("").map(x => `<span>${x}</span>`).join(""); main.appendChild(mh);
  const grid = document.createElement("div"); grid.className = "month";
  const first = new Date(cur.getFullYear(), cur.getMonth(), 1); const days = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
  for (let i = 0; i < first.getDay(); i++) { const e = document.createElement("div"); e.className = "cell empty"; grid.appendChild(e); }
  for (let i = 1; i <= days; i++) {
    const d = new Date(cur.getFullYear(), cur.getMonth(), i); const ds = iso(d); const tasks = p.tasks[ds] || []; const dl = daysLeft(p, d);
    const inRange = dl >= 0 && d >= pd(p.start);
    const done = tasks.filter(t => t.done).length; const pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    const cell = document.createElement("button"); cell.type = "button"; cell.className = "cell" + (ds === iso(T) ? " today" : "") + (inRange ? "" : " out");
    cell.setAttribute("aria-label", `${fmt(d)}${inRange ? ", " + dl + " days left" : ""}, ${tasks.length} tasks, ${done} done`);
    cell.innerHTML = `<div class="n">${i}</div><div class="l${inRange && dl <= 6 ? " urgent" : ""}">${inRange ? dl + " left" : ""}</div>${tasks.length ? `<div class="prog"><i style="width:${pct}%"></i></div>` : ""}`;
    cell.onclick = () => { view = "week"; openDay = ds; render(); };
    grid.appendChild(cell);
  }
  main.appendChild(grid);
}

// ---------- timer (survives reload / app switch) ----------
let tEnd = 0, tInt = null, timerTaskName = null; const timerEl = $("timer");
function announce(text) { const a = $("announce"); a.textContent = ""; setTimeout(() => { a.textContent = text; }, 50); }
function startTimer(min, name) {
  stopTimer(); tEnd = Date.now() + min * 60000;
  try { localStorage.setItem(TKEY, JSON.stringify({ end: tEnd, name })); } catch (e) { console.warn("timer won't survive reload", e); }
  showTimer(name, true); announce(`${min} minute timer started: ${name}`);
  render(); // reflect the running timer on the hero card immediately
  window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
}
function showTimer(name, fresh) {
  clearInterval(tInt); tInt = null; timerTaskName = name;
  $("tn").textContent = name; timerEl.classList.add("on"); timerEl.classList.remove("done"); $("tstop").textContent = "Stop";
  const s = secondsLeft(); paint(s);
  if (s > 0) tInt = setInterval(tick, 500);
  else finish(!fresh); // already over when resumed: show "allowed to stop", don't buzz twice
}
const secondsLeft = () => Math.max(0, Math.round((tEnd - Date.now()) / 1000));
function paint(s) { $("tt").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
function tick() { const s = secondsLeft(); paint(s); if (s === 0) finish(false); }
function finish(quiet) {
  clearInterval(tInt); tInt = null; timerEl.classList.add("done");
  $("tn").textContent = "Time's up. You're allowed to stop."; $("tstop").textContent = "Done";
  announce("Time's up. You're allowed to stop."); if (!quiet) beep();
  render(); // let the hero card swap to "Mark done"
}
function stopTimer() { clearInterval(tInt); tInt = null; timerTaskName = null; timerEl.classList.remove("on", "done"); try { localStorage.removeItem(TKEY); } catch (e) {} }
$("tstop").onclick = () => { stopTimer(); render(); };
function resumeTimer() {
  let t = null; try { t = JSON.parse(localStorage.getItem(TKEY) || "null"); } catch (e) {}
  if (!t) { if (timerEl.classList.contains("on")) stopTimer(); return; }
  if (t.end > Date.now() || Date.now() - t.end < 15 * 60000) { tEnd = t.end; showTimer(t.name, false); }
  else stopTimer();
}
function beep() {
  try {
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 600]);
    const a = new (window.AudioContext || window.webkitAudioContext)();
    [0, .35, .7].forEach(t => { const o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; o.connect(g); g.connect(a.destination); g.gain.setValueAtTime(.25, a.currentTime + t); g.gain.exponentialRampToValueAtTime(.001, a.currentTime + t + .3); o.start(a.currentTime + t); o.stop(a.currentTime + t + .3); });
  } catch (e) { console.warn("beep unavailable", e); }
}
// Timers drift when a tab is throttled; re-tick when we come back.
document.addEventListener("visibilitychange", () => { if (!document.hidden && tInt) tick(); });

// ---------- sheets (accessible bottom-sheet dialogs) ----------
let sheetOpener = null;
function openSheet(id, opener) {
  const s = $(id); s.classList.add("on"); sheetOpener = opener || document.activeElement;
  const f = s.querySelector("input:not([hidden]), button:not([hidden])"); if (f) setTimeout(() => f.focus(), 30);
}
function closeSheet(s) { s.classList.remove("on"); if (sheetOpener && sheetOpener.focus) sheetOpener.focus(); sheetOpener = null; }
document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => closeSheet(b.closest(".sheet")));
document.addEventListener("keydown", e => { if (e.key === "Escape") { const s = document.querySelector(".sheet.on"); if (s) closeSheet(s); } });
document.querySelectorAll(".sheet").forEach(s => {
  s.onclick = e => { if (e.target === s) closeSheet(s); };
  s.addEventListener("keydown", e => {
    if (e.key !== "Tab") return; // trap focus inside the sheet
    const items = [...s.querySelectorAll("input, select, button")].filter(x => !x.hidden && x.offsetParent !== null);
    if (!items.length) return; const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
});
$("stuckBtn").onclick = () => openSheet("stuck", $("stuckBtn"));
$("ten").onclick = () => { closeSheet($("stuck")); startTimer(10, "Smallest thing you can see"); };
function openNew(opener) {
  const T = today(); $("pstart").value = iso(T); const e = new Date(T); e.setDate(e.getDate() + 21); $("pend").value = iso(e); $("pname").value = ""; $("pmsg").textContent = "";
  openSheet("newplan", opener);
}
$("pcreate").onclick = () => {
  const name = $("pname").value.trim() || "Countdown";
  if (!$("pstart").value || !$("pend").value) { $("pmsg").textContent = "Pick a start and end date."; return; }
  const p = normalize({ id: uid(), name, start: $("pstart").value, end: $("pend").value });
  db.plans.push(p); db.current = p.id; save(p); closeSheet($("newplan")); view = "day"; render();
};
$("plansel").onchange = e => { if (e.target.value === "__new") { openNew($("plansel")); render(); } else { db.current = e.target.value; persist(); openDay = null; render(); } };
document.querySelectorAll(".views button[data-v]").forEach(b => b.onclick = () => { view = b.dataset.v; openDay = null; render(); });

// ---------- PWA: service worker + install prompt ----------
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(e => console.warn("service worker failed", e)));
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault(); deferredInstall = e;
  let dismissed = false; try { dismissed = localStorage.getItem("unstuck-install-dismissed") === "1"; } catch (x) {}
  if (!dismissed) $("install").classList.add("on");
});
$("installBtn").onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $("install").classList.remove("on"); };
$("installX").onclick = () => { $("install").classList.remove("on"); try { localStorage.setItem("unstuck-install-dismissed", "1"); } catch (e) {} };
window.addEventListener("appinstalled", () => $("install").classList.remove("on"));

// ---------- Supabase sync (only if config.js has keys) ----------
const sync = (() => {
  const cfg = window.UNSTUCK_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  // Pinned version + Subresource Integrity: a tampered CDN file will refuse to run instead of running with your session.
  const LIB = { src: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.115.0/dist/umd/supabase.js", integrity: "sha384-CLZeq1dk8+Uzrs7TVvBUdlFoV5F0DMqgRoeHa8g5wJcuPe5SkVfEvdxB0ZuzlnBQ" };
  let sb = null, user = null, dirty = new Set(), pushTimer = null, channel = null, loading = null, lastPull = null;
  const dot = $("syncDot"), txt = $("syncTxt");
  function status(state, label) { dot.className = state; txt.textContent = label; }
  function msg(text, err) { const m = $("syncIn").hidden ? $("smsg") : $("smsg2"); m.textContent = text || ""; m.classList.toggle("err", !!err); }
  function saveDirty() { try { localStorage.setItem("unstuck-dirty", JSON.stringify([...dirty])); } catch (e) {} }

  function markDirty(id) { if (!enabled) return; dirty.add(id); saveDirty(); if (user) schedulePush(); }
  function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(() => push().catch(fail), 800); }
  function fail(e) { console.warn("sync error", e); status("err", "Retry"); msg((e && e.message) || "Sync failed. Try again.", true); }

  const toRow = p => ({ id: p.id, user_id: user.id, name: p.name, start_date: p.start, end_date: p.end, tasks: p.tasks || {}, tombstones: p.tombstones || [], updated_at: p.updated_at, deleted: !!p.deleted });
  const fromRow = r => normalize({ id: r.id, name: r.name, start: r.start_date, end: r.end_date, tasks: r.tasks || {}, tombstones: r.tombstones || [], updated_at: r.updated_at, deleted: !!r.deleted });

  // Merge two versions of the same plan. Tasks are unioned by id (so edits made on two devices both survive);
  // a task deleted anywhere stays deleted (tombstones); same task edited on both sides → the newer plan wins.
  function mergePlans(a, b) {
    const newer = new Date(a.updated_at) >= new Date(b.updated_at) ? a : b, older = newer === a ? b : a;
    const dead = new Set([...(a.tombstones || []), ...(b.tombstones || [])]);
    const tasks = {};
    for (const src of [older, newer]) for (const ds of Object.keys(src.tasks || {})) {
      const list = (tasks[ds] = tasks[ds] || []);
      for (const t of src.tasks[ds]) { if (dead.has(t.id)) continue; const i = list.findIndex(x => x.id === t.id); if (i < 0) list.push({ ...t }); else list[i] = { ...t }; }
    }
    for (const ds of Object.keys(tasks)) { if (!tasks[ds].length) delete tasks[ds]; else { const s = tasks[ds].filter(t => t.star); if (s.length > 1) { const keep = s.find(t => (newer.tasks[ds] || []).some(x => x.id === t.id && x.star)) || s[0]; tasks[ds].forEach(t => t.star = t === keep); } } }
    return normalize({ ...newer, tasks, tombstones: [...dead].slice(-500), updated_at: newer.updated_at });
  }
  const same = (x, y) => JSON.stringify([x.name, x.start, x.end, x.deleted, x.tasks, x.tombstones]) === JSON.stringify([y.name, y.start, y.end, y.deleted, y.tasks, y.tombstones]);

  // Merge a remote row into local state. Returns true if local changed; marks dirty if the merge produced something the server doesn't have.
  function mergeRow(r) {
    const remote = fromRow(r); const i = db.plans.findIndex(p => p.id === remote.id);
    if (i < 0) { db.plans.push(remote); return true; }
    const local = db.plans[i]; if (same(local, remote)) { local.updated_at = remote.updated_at; return false; }
    const merged = mergePlans(local, remote);
    if (!same(merged, remote)) { merged.updated_at = new Date().toISOString(); dirty.add(merged.id); saveDirty(); }
    db.plans[i] = merged; return true;
  }

  async function push() {
    if (!user || !navigator.onLine || dirty.size === 0) return;
    const ids = [...dirty]; const rows = db.plans.filter(p => ids.includes(p.id)).map(toRow);
    if (!rows.length) { dirty.clear(); saveDirty(); return; }
    status("busy", "Saving…");
    const { error } = await sb.from("plans").upsert(rows, { onConflict: "id" });
    if (error) { fail(error); return; }
    ids.forEach(id => dirty.delete(id)); saveDirty();
    status("ok", "Synced"); msg("");
  }

  async function pull() {
    if (!user || !navigator.onLine) return;
    status("busy", "Syncing…");
    // Incremental after the first pull (5-minute overlap absorbs clock differences).
    let q = sb.from("plans").select("*");
    if (lastPull) q = q.gt("updated_at", new Date(new Date(lastPull).getTime() - 5 * 60000).toISOString());
    const { data, error } = await q;
    if (error) { fail(error); return; }
    let changed = false; const seen = new Set();
    (data || []).forEach(r => { seen.add(r.id); if (mergeRow(r)) changed = true; });
    if (!lastPull) db.plans.forEach(p => { if (!seen.has(p.id)) { dirty.add(p.id); } }); // first sync on a device with existing plans
    lastPull = new Date().toISOString(); try { localStorage.setItem("unstuck-lastpull-" + user.id, lastPull); } catch (e) {}
    if (!plan()) { const first = db.plans.find(p => !p.deleted); db.current = first ? first.id : null; changed = true; }
    if (changed) { persist(); render(); }
    saveDirty(); await push();
    if (dirty.size === 0) status("ok", "Synced");
  }

  function subscribe() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    channel = sb.channel("plans-" + user.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "plans", filter: "user_id=eq." + user.id }, payload => {
        if (payload.new && payload.new.id && mergeRow(payload.new)) { persist(); render(); if (dirty.size) schedulePush(); }
      }).subscribe();
  }

  function setUser(u) {
    user = u;
    $("syncOut").hidden = !!u; $("syncIn").hidden = !u;
    if (u) { $("swho").textContent = u.email || ""; try { lastPull = localStorage.getItem("unstuck-lastpull-" + u.id); } catch (e) {} status("ok", "Synced"); subscribe(); pull().catch(fail); }
    else { lastPull = null; if (channel) { sb.removeChannel(channel); channel = null; } status("", "Sync"); }
  }

  function loadLib() {
    if (window.supabase) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = LIB.src; s.integrity = LIB.integrity; s.crossOrigin = "anonymous";
      s.onload = res; s.onerror = () => { s.remove(); rej(new Error("Couldn't load the sync library (offline, blocked, or failed integrity check).")); };
      document.head.appendChild(s);
    }).finally(() => { loading = null; });
    return loading;
  }

  async function connect() {
    if (sb) return true;
    try { await loadLib(); } catch (e) { status("err", "Offline"); msg(e.message, true); return false; }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    sb.auth.onAuthStateChange((event, session) => {
      setUser(session ? session.user : null);
      // Clean magic-link tokens or errors out of the URL/history regardless of outcome.
      if (/access_token|refresh_token|error|code=/.test(location.hash + location.search)) history.replaceState(null, "", location.pathname);
    });
    try { const { data } = await sb.auth.getSession(); setUser(data.session ? data.session.user : null); } catch (e) { fail(e); }
    return true;
  }

  async function init() {
    if (!enabled) return;
    $("syncBtn").hidden = false; status("", "Sync");
    try { dirty = new Set(JSON.parse(localStorage.getItem("unstuck-dirty") || "[]")); } catch (e) {}

    // Handlers are wired up front so the sheet works (and can retry) even if the library failed to load.
    $("syncBtn").onclick = async () => { msg(""); openSheet("syncSheet", $("syncBtn")); if (!sb) await connect(); };
    $("ssend").onclick = async () => {
      const email = $("semail").value.trim(); if (!email) { msg("Enter your email first.", true); return; }
      if (!sb && !(await connect())) return;
      $("ssend").disabled = true; msg("Sending…");
      try {
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) msg(error.message, true); else msg("Check your email and tap the link. It opens Unstuck signed in.");
      } catch (e) { msg(e.message || "Couldn't send the link.", true); }
      $("ssend").disabled = false;
    };
    $("ssyncnow").onclick = async () => { msg("Syncing…"); try { await pull(); msg(dirty.size ? "Some changes still waiting — are you online?" : "Up to date."); } catch (e) { fail(e); } };
    $("sout").onclick = async () => { try { await sb.auth.signOut(); } catch (e) {} closeSheet($("syncSheet")); };
    window.addEventListener("online", async () => { if (!sb) await connect(); if (user) pull().catch(fail); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && user) pull().catch(fail); });

    await connect();
  }
  return { markDirty, init };
})();

// ---------- boot ----------
load(); resumeTimer(); render(); sync.init().catch(e => console.warn("sync init failed", e));
if (new URLSearchParams(location.search).get("stuck") === "1") { openSheet("stuck", $("stuckBtn")); history.replaceState(null, "", location.pathname); }
})();
