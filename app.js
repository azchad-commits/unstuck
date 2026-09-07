/* Dayfall — countdown planner for ADHD + time blindness.
   Local-first: everything lives in localStorage. If config.js has Supabase keys, plans also sync
   (magic-link sign-in; per-task merge with tombstones; server clamps clock skew). */
(() => {
"use strict";

// ---------- storage (device-local, always on) ----------
const KEY = "unstuck-v1", TKEY = "unstuck-timer", MINS = [5, 10, 15, 30, 45, 60, 90];
let db = { plans: [], current: null, stats: {} };
let view = "day", openDay = null, monthCursor = null, weekStart = null, editDays = new Set(), lastDayIso = null;
const $ = id => document.getElementById(id);

function normalize(p) {
  return { updated_at: new Date(0).toISOString(), deleted: false, archived: false, tombstones: [], daily: [], tasks: {}, ...p };
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
      db = { plans: [], current: null, stats: {} };
      setTimeout(() => banner("Your saved plans couldn't be read. A backup was kept on this device.", true), 0);
    }
  }
  db.plans = (db.plans || []).map(normalize);
  db.stats = db.stats || {}; // { "2026-09-06": seconds spent on timers that day } — device-local
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
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmt = d => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const livePlans = () => db.plans.filter(x => !x.deleted && !x.archived);
const plan = () => db.plans.find(p => p.id === db.current && !p.deleted && !p.archived);
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
  const t = $("toast"); $("toastTxt").textContent = text; t.classList.add("on"); undoFn = onUndo || null;
  $("undo").hidden = !onUndo;
  clearTimeout(undoT); undoT = setTimeout(() => { t.classList.remove("on"); undoFn = null; }, 7000);
}
$("undo").onclick = () => { if (undoFn) undoFn(); undoFn = null; $("toast").classList.remove("on"); };

// ---------- shared merge (used by sync and by backup import) ----------
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
const samePlan = (x, y) => JSON.stringify([x.name, x.start, x.end, x.deleted, x.archived, x.tasks, x.tombstones, x.daily]) === JSON.stringify([y.name, y.start, y.end, y.deleted, y.archived, y.tasks, y.tombstones, y.daily]);

// ---------- daily repeats ----------
// Materialize a plan's daily tasks for a visible day (today..deadline). Instance ids are
// deterministic (dailyId@date) so two devices materializing independently merge cleanly.
function ensureDaily(p, ds) {
  if (!p.daily || !p.daily.length) return;
  const d = pd(ds), T = today();
  if (d < T || d > pd(p.end) || d < pd(p.start)) return;
  const dead = new Set(p.tombstones || []);
  let added = false;
  for (const r of p.daily) {
    const id = r.id + "@" + ds;
    if (dead.has(id)) continue;
    const list = (p.tasks[ds] = p.tasks[ds] || []);
    if (!list.some(t => t.id === id || t.dailyId === r.id)) { list.push({ id, dailyId: r.id, title: r.title, min: r.min, done: false, star: false }); added = true; }
  }
  if (added) save(p);
}
const isDailyTask = (p, t) => (p.daily || []).some(r => r.id === t.dailyId || t.id.startsWith(r.id + "@"));
function toggleDaily(p, t) {
  const dailyId = t.dailyId || (t.id.includes("@") ? t.id.split("@")[0] : null);
  if (dailyId && (p.daily || []).some(r => r.id === dailyId)) {
    p.daily = p.daily.filter(r => r.id !== dailyId); delete t.dailyId;
    toast(`"${t.title}" won't repeat anymore`, null);
  } else {
    const r = { id: uid(), title: t.title, min: t.min };
    p.daily = (p.daily || []).concat(r); t.dailyId = r.id;
    toast(`"${t.title}" will repeat every day`, null);
  }
  save(p); render();
}

// ---------- moving tasks (carry-over, snooze) ----------
// Moving = tombstone the old id + insert a fresh copy, so sync's union-by-id can't resurrect
// the task on its old day from another device.
function moveTaskCore(p, fromDs, t, toDs) {
  p.tasks[fromDs] = (p.tasks[fromDs] || []).filter(x => x.id !== t.id);
  if (!p.tasks[fromDs].length) delete p.tasks[fromDs];
  p.tombstones = (p.tombstones || []).concat(t.id).slice(-500);
  const list = (p.tasks[toDs] = p.tasks[toDs] || []);
  const nt = { ...t, id: uid(), done: false }; delete nt.dailyId;
  if (nt.star && list.some(x => x.star)) nt.star = false;
  list.push(nt);
  return nt;
}
// Reverse a move: remove the copy, un-tombstone the original, tombstone the copy, restore.
function undoMove(e) {
  e.p.tasks[e.toDs] = (e.p.tasks[e.toDs] || []).filter(x => x.id !== e.nt.id);
  if (!e.p.tasks[e.toDs].length) delete e.p.tasks[e.toDs];
  e.p.tombstones = (e.p.tombstones || []).filter(id => id !== e.t.id).concat(e.nt.id).slice(-500);
  (e.p.tasks[e.fromDs] = e.p.tasks[e.fromDs] || []).push(e.t);
  save(e.p);
}
// Estimate calibration: median of actual/planned across finished timed tasks. Only speaks up
// with 5+ samples and a real pattern (≥30% over) — a nudge toward honest estimates, never a grade.
function overrunFactor() {
  const ratios = [];
  for (const p of db.plans) if (!p.deleted) for (const list of Object.values(p.tasks || {})) for (const t of list)
    if (t.done && t.min && (t.spent || 0) >= 60) ratios.push(t.spent / (t.min * 60));
  if (ratios.length < 5) return null;
  ratios.sort((a, b) => a - b);
  const med = ratios[Math.floor(ratios.length / 2)];
  return med >= 1.3 ? med : null;
}

// ---------- render ----------
function updateBadge(left) {
  try {
    if (!("setAppBadge" in navigator)) return;
    if (left != null && left > 0) navigator.setAppBadge(left).catch(() => {});
    else navigator.clearAppBadge().catch(() => {});
  } catch (e) {}
}

function render() {
  const T = today(); lastDayIso = iso(T);
  if (!plan() && livePlans().length) { db.current = livePlans()[0].id; persist(); }
  const p = plan();
  const live = livePlans();
  $("planBtn").hidden = live.length === 0;
  $("planName").textContent = p ? p.name : "";
  const main = $("main"); main.innerHTML = "";
  document.querySelectorAll(".views button[data-v]").forEach(b => { const on = b.dataset.v === view; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  if (!p) {
    updateBadge(null);
    $("big").hidden = true; $("lbl").innerHTML = "no countdown yet<b>" + fmt(T) + "</b>";
    main.innerHTML = `<div class="empty">Pick a deadline. The app numbers the days backward from it.<br><button id="first">Start a countdown</button></div>`;
    $("first").onclick = () => openNew($("first")); return;
  }
  $("big").hidden = false;
  const left = daysLeft(p, T);
  updateBadge(left);
  const big = $("big"); big.textContent = Math.max(0, left); big.classList.toggle("hot", left >= 0 && left <= 6);
  $("lbl").innerHTML = (left > 0 ? "days left" : left === 0 ? "deadline day" : "done") + "<b>" + fmt(T) + "</b>";
  if (left < 0) main.appendChild(celebration(p));
  if (view === "day") { renderDays(main, p, T, [iso(T)], true); renderOtherToday(main, T, p); renderRecap(main, T); }
  else if (view === "week") {
    // The week window can start on any date (month taps land here); ‹ › page by 7 days.
    const start = weekStart ? pd(weekStart) : T;
    const wlbl = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const nav = document.createElement("div");
    nav.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px";
    nav.innerHTML = `<button class="min" id="wp" aria-label="Earlier week">‹</button><b aria-live="polite">${iso(start) === iso(T) ? "Next 7 days" : wlbl(start) + " – " + wlbl(addDays(start, 6))}</b><button class="min" id="wn" aria-label="Later week">›</button>`;
    main.appendChild(nav);
    nav.querySelector("#wp").onclick = () => { weekStart = iso(addDays(start, -7)); openDay = null; render(); };
    nav.querySelector("#wn").onclick = () => { weekStart = iso(addDays(start, 7)); openDay = null; render(); };
    const dss = []; for (let i = 0; i < 7; i++) dss.push(iso(addDays(start, i)));
    renderDays(main, p, T, dss, false);
  }
  else renderMonth(main, p, T);
  const n = document.createElement("p"); n.className = "note"; n.textContent = "Tap the minutes on a task to start its timer. Tap ☆ to make it the one thing."; main.appendChild(n);
}

// The deadline passed: celebrate the absolute wins, offer to archive or start the next thing.
function celebration(p) {
  const all = Object.values(p.tasks || {}).flat();
  const doneCount = all.filter(t => t.done).length;
  const mins = Math.round(all.reduce((s, t) => s + (t.spent || 0), 0) / 60);
  const el = document.createElement("div"); el.className = "cele";
  el.innerHTML = `<div class="ctitle">You made it.</div><p>${esc(p.name)} ended ${fmt(pd(p.end))}. ${doneCount} task${doneCount === 1 ? "" : "s"} done${mins ? `, ${mins} timer minutes` : ""}. That counts.</p><button class="primary" id="carch">Archive this countdown</button><button class="quiet2" id="cnew">Start a new countdown</button>`;
  el.querySelector("#carch").onclick = () => { p.archived = true; save(p); const l = livePlans(); db.current = l.length ? l[0].id : null; persist(); render(); };
  el.querySelector("#cnew").onclick = e => openNew(e.target);
  return el;
}

function heroHTML(p, ds, star) {
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
  const ramp = !markDone && star.min >= 10 ? `<button class="hbtn2" aria-label="Start 5 minutes: ${esc(star.title)}">Just the first 5</button>` : "";
  return `<div class="hero"><div class="htitle">One thing today</div><div class="hname">${esc(star.title)}</div><button class="hbtn ${cls}"${markDone ? ' data-mark="1"' : ""} aria-label="${label}: ${esc(star.title)}">${label}</button>${ramp}</div>`;
}

function taskRowHTML(p, ds, t, ctx) {
  const daily = isDailyTask(p, t);
  const pull = ctx.isPast || (!ctx.isPast && !ctx.isToday); // past and future both offer "→ Today"
  const mvLabel = !t.done && (pull ? "→ Today" : (ctx.isToday && ctx.canTomorrow ? "→ Tmrw" : null));
  const mins = `<select class="mins" aria-label="Minutes for: ${esc(t.title)}">${MINS.map(m => `<option value="${m}" ${t.min === m ? "selected" : ""}>${m}m</option>`).join("")}<option value="0" ${!t.min ? "selected" : ""}>no timer</option></select>`;
  return `<div class="task ${t.done ? "on" : ""}" data-id="${t.id}"><button class="chk ${t.done ? "on" : ""}" aria-pressed="${t.done}" aria-label="${t.done ? "Mark not done" : "Mark done"}: ${esc(t.title)}"></button><div class="txt">${esc(t.title)}${daily ? '<span class="repmark" aria-hidden="true">↻</span>' : ""}</div><button class="star ${t.star ? "on" : ""}" aria-pressed="${t.star}" aria-label="${t.star ? "This is the one thing" : "Make this the one thing"}: ${esc(t.title)}">${t.star ? "★" : "☆"}</button>${t.min ? `<button class="min" aria-label="Start ${t.min} minute timer: ${esc(t.title)}">${t.min} min</button>` : ""}${mins}${mvLabel ? `<button class="mv" aria-label="Move to ${pull ? "today" : "tomorrow"}: ${esc(t.title)}">${mvLabel}</button>` : ""}<button class="rep" aria-pressed="${daily}" aria-label="${daily ? "Stop repeating daily" : "Repeat every day"}: ${esc(t.title)}">↻</button><button class="del" aria-label="Delete: ${esc(t.title)}">×</button></div>`;
}

function wireTasks(el, p, ds, tasks, ctx) {
  el.querySelectorAll(".task").forEach(row => {
    const t = tasks.find(x => x.id === row.dataset.id); if (!t) return;
    row.querySelector(".chk").onclick = () => {
      t.done = !t.done; save(p);
      if (t.done && t.min && (t.spent || 0) >= 60) toast(`Planned ${t.min}m · spent ${Math.round(t.spent / 60)}m. Done is done.`, null);
      render();
    };
    row.querySelector(".star").onclick = () => { const was = t.star; tasks.forEach(x => x.star = false); t.star = !was; save(p); render(); };
    row.querySelector(".del").onclick = () => {
      const idx = tasks.indexOf(t); p.tasks[ds] = tasks.filter(x => x !== t); p.tombstones = (p.tombstones || []).concat(t.id).slice(-500); save(p); render();
      toast(`Deleted "${t.title}"`, () => { const list = (p.tasks[ds] = p.tasks[ds] || []); list.splice(Math.min(idx, list.length), 0, t); p.tombstones = p.tombstones.filter(id => id !== t.id); save(p); render(); });
    };
    const m = row.querySelector(".min"); if (m) m.onclick = () => startTimer(t.min, t.title, { pid: p.id, ds, tid: t.id });
    const ms = row.querySelector(".mins"); if (ms) ms.onchange = () => { t.min = +ms.value; save(p); render(); };
    const mv = row.querySelector(".mv"); if (mv) mv.onclick = () => {
      const pull = ctx.isPast || (!ctx.isPast && !ctx.isToday);
      const toDs = pull ? iso(today()) : iso(addDays(today(), 1));
      const nt = moveTaskCore(p, ds, t, toDs); save(p); render();
      toast(pull ? `"${t.title}" moved to today` : `"${t.title}" moved to tomorrow`,
        () => { undoMove({ p, fromDs: ds, toDs, t, nt }); render(); });
    };
    const rp = row.querySelector(".rep"); if (rp) rp.onclick = () => toggleDaily(p, t);
  });
}

function renderDays(main, p, T, dates, expandAll) {
  const overrun = overrunFactor();
  dates.forEach(ds => {
    ensureDaily(p, ds);
    const d = pd(ds); const dl = daysLeft(p, d); const tasks = p.tasks[ds] || [];
    const isToday = iso(d) === iso(T); const isPast = d < T;
    const ctx = { isPast, isToday, canTomorrow: iso(addDays(T, 1)) <= p.end };
    const open = expandAll || openDay === ds || (isToday && openDay === null);
    const editing = editDays.has(ds);
    const el = document.createElement("section"); el.className = "day" + (isToday ? " today" : "") + (isPast ? " past" : "") + (open && editing ? " editing" : "");
    const allDone = tasks.length && tasks.every(t => t.done);
    const star = tasks.find(t => t.star);
    const bodyId = "body-" + ds;
    el.innerHTML = `<div class="hd"><button class="hdmain" ${expandAll ? "" : `aria-expanded="${open}" aria-controls="${bodyId}"`}><span class="d">${fmt(d)}<small>${star ? esc(star.title) : (tasks.length ? tasks.length + " tasks" : "nothing planned")}</small></span>${isToday ? '<span class="tag">Today</span>' : ""}<span class="left ${dl >= 0 && dl <= 6 ? "urgent" : ""}">${allDone ? "✓ done" : dl < 0 ? "past" : dl === 0 ? "day 0" : dl + " left"}</span></button>${open && tasks.length ? `<button class="editbtn" aria-pressed="${editing}">${editing ? "Done" : "Edit"}</button>` : ""}</div>
    ${open ? `<div class="body" id="${bodyId}">${heroHTML(p, ds, star)}${tasks.map(t => taskRowHTML(p, ds, t, ctx)).join("")}
    <div class="add"><input placeholder="Add a task…" aria-label="New task for ${fmt(d)}"><select aria-label="Minutes">${MINS.map(m => `<option value="${m}" ${m === 30 ? "selected" : ""}>${m}m</option>`).join("")}<option value="0">no timer</option></select><button>Add</button></div>${isToday && overrun ? `<div class="cal">Timed tasks usually take you ~${Math.round((overrun - 1) * 100)}% longer than planned — the next size up often fits.</div>` : ""}</div>` : ""}`;
    el.querySelector(".hdmain").onclick = () => { if (!expandAll) { openDay = openDay === ds ? "" : ds; render(); } };
    const editBtn = el.querySelector(".editbtn");
    if (editBtn) editBtn.onclick = () => { if (editing) editDays.delete(ds); else editDays.add(ds); render(); };
    if (open) {
      const heroBtn = el.querySelector(".hbtn");
      if (heroBtn && !heroBtn.disabled) heroBtn.onclick = () => {
        if (heroBtn.dataset.mark) {
          star.done = true; save(p);
          if (star.min && (star.spent || 0) >= 60) toast(`Planned ${star.min}m · spent ${Math.round(star.spent / 60)}m. Done is done.`, null);
          render();
        } else startTimer(star.min, star.title, { pid: p.id, ds, tid: star.id });
      };
      const ramp = el.querySelector(".hbtn2");
      if (ramp) ramp.onclick = () => startTimer(5, star.title, { pid: p.id, ds, tid: star.id });
      const inp = el.querySelector(".add input"), selm = el.querySelector(".add select");
      const add = () => { const t = inp.value.trim(); if (!t) return; const list = (p.tasks[ds] = p.tasks[ds] || []); list.push({ id: uid(), title: t, min: +selm.value, done: false, star: list.length === 0 }); save(p); render(); };
      el.querySelector(".add button").onclick = add; inp.onkeydown = e => { if (e.key === "Enter") add(); };
      wireTasks(el, p, ds, tasks, ctx);
    }
    main.appendChild(el);
  });
}

// Merged today: compact cards for the OTHER live countdowns that have tasks today,
// so nothing gets lost just because a different plan is selected.
function renderOtherToday(main, T, cur) {
  const ds = iso(T);
  for (const q of livePlans()) {
    if (q.id === cur.id) continue;
    if (daysLeft(q, T) < 0) continue;
    ensureDaily(q, ds);
    const tasks = q.tasks[ds] || [];
    if (!tasks.length) continue;
    const dl = daysLeft(q, T);
    const ctx = { isPast: false, isToday: true, canTomorrow: iso(addDays(T, 1)) <= q.end };
    const el = document.createElement("section"); el.className = "day other";
    el.innerHTML = `<div class="hd"><button class="hdmain"><span class="d">${esc(q.name)}<small>${tasks.length} task${tasks.length === 1 ? "" : "s"} today — tap to switch</small></span><span class="left ${dl <= 6 ? "urgent" : ""}">${dl === 0 ? "day 0" : dl + " left"}</span></button></div><div class="body">${tasks.map(t => taskRowHTML(q, ds, t, ctx)).join("")}</div>`;
    el.querySelector(".hdmain").onclick = () => { db.current = q.id; persist(); openDay = null; render(); };
    wireTasks(el, q, ds, tasks, ctx);
    main.appendChild(el);
  }
}

// Absolute wins, never streaks: what actually happened today.
function renderRecap(main, T) {
  const ds = iso(T);
  let done = 0, total = 0;
  for (const q of livePlans()) { const l = q.tasks[ds] || []; done += l.filter(t => t.done).length; total += l.length; }
  const mins = Math.round((db.stats[ds] || 0) / 60);
  if (!done && !mins) return;
  const r = document.createElement("p"); r.className = "recap";
  r.textContent = `Today: ${done}${total ? ` of ${total}` : ""} done${mins ? ` · ${mins} timer min` : ""}`;
  main.appendChild(r);
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
    cell.onclick = () => { view = "week"; weekStart = iso(d); openDay = ds; render(); };
    grid.appendChild(cell);
  }
  main.appendChild(grid);
}

// ---------- timer (survives reload / app switch; credits time spent) ----------
let tEnd = 0, tStart = 0, tPlan = 0, tRef = null, tCredited = false, tInt = null, timerTaskName = null, cuesFired = new Set(), wakeLock = null;
const timerEl = $("timer");
function announce(text) { const a = $("announce"); a.textContent = ""; setTimeout(() => { a.textContent = text; }, 50); }
function saveTimer() { try { localStorage.setItem(TKEY, JSON.stringify({ end: tEnd, start: tStart, plan: tPlan, ref: tRef, credited: tCredited, name: timerTaskName })); } catch (e) { console.warn("timer won't survive reload", e); } }

function startTimer(min, name, ref) {
  stopTimer(); // credits any timer that was still running
  tEnd = Date.now() + min * 60000; tStart = Date.now(); tPlan = min * 60; tRef = ref || null; tCredited = false; timerTaskName = name;
  saveTimer();
  ensureAudio(); // unlock the audio channel inside this tap, so the alarm can actually play later (iOS)
  startKeepalive();
  showTimer(name, true); announce(`${min} minute timer started: ${name}`);
  maybeAskAlerts();
  render(); // reflect the running timer on the hero card immediately
  window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
}
function showTimer(name, fresh) {
  clearInterval(tInt); tInt = null; timerTaskName = name;
  $("tn").textContent = name; timerEl.classList.add("on"); timerEl.classList.remove("done"); $("tstop").textContent = "Stop";
  const s = secondsLeft();
  cuesFired = new Set(); for (const c of cueList()) if (s <= c.at) cuesFired.add(c.at); // don't replay cues on resume
  paint(s);
  if (s > 0) { tInt = setInterval(tick, 500); acquireLock(); if (!fresh && !tickSrc) startKeepalive(); }
  else finish(!fresh); // already over when resumed: show "allowed to stop", don't buzz twice
}
// Time-as-space cues: interval nudges so the remaining time stays felt, not just displayed.
function cueList() {
  const cues = [];
  if (tPlan >= 20 * 60) cues.push({ at: Math.round(tPlan / 2), label: "Halfway. Still going — that's the hard part." });
  if (tPlan >= 10 * 60) cues.push({ at: 300, label: "5 minutes left." });
  return cues;
}
const secondsLeft = () => Math.max(0, Math.round((tEnd - Date.now()) / 1000));
function paint(s) {
  const txt = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  $("tt").textContent = txt;
  const bar = $("tbar"); if (bar) bar.style.width = (tPlan > 0 ? Math.max(0, Math.min(100, s / tPlan * 100)) : 0) + "%";
  document.title = timerEl.classList.contains("on") && s > 0 ? txt + " · Dayfall" : "Dayfall";
}
function tick() {
  const s = secondsLeft(); paint(s);
  for (const c of cueList()) if (s > 0 && s <= c.at && !cuesFired.has(c.at)) { cuesFired.add(c.at); if (cuesPref) { announce(c.label); blip(); } }
  if (s === 0) finish(false);
}
// Credit elapsed timer seconds to the task (synced) and to today's stats (device-local). Once per run.
function credit(sec) {
  if (tCredited || !(sec > 0)) return; tCredited = true;
  const ds = iso(today());
  db.stats[ds] = (db.stats[ds] || 0) + sec;
  let saved = false;
  if (tRef) {
    const p = db.plans.find(x => x.id === tRef.pid);
    const t = p && (p.tasks[tRef.ds] || []).find(x => x.id === tRef.tid);
    if (t) { t.spent = (t.spent || 0) + sec; save(p); saved = true; }
  }
  if (!saved) persist();
  saveTimer(); // record credited so a reload can't double-count
}
function finish(quiet) {
  clearInterval(tInt); tInt = null; releaseLock();
  if (tStart && tPlan) credit(Math.min(tPlan, Math.round((Math.min(Date.now(), tEnd) - tStart) / 1000)));
  stopTickSound(); // silence itself is part of the signal
  timerEl.classList.add("done");
  $("tn").textContent = "Time's up. You're allowed to stop."; $("tstop").textContent = "Done";
  document.title = "Dayfall";
  announce("Time's up. You're allowed to stop.");
  if (!quiet) { beep(); flash(); }
  notifyEnd();
  render(); // let the hero card swap to "Mark done"
}
function stopTimer() {
  if (timerEl.classList.contains("on") && !timerEl.classList.contains("done") && tStart && tPlan) {
    credit(Math.max(0, Math.min(tPlan, Math.round((Math.min(Date.now(), tEnd) - tStart) / 1000))));
  }
  clearInterval(tInt); tInt = null; timerTaskName = null; tRef = null; tStart = 0; tPlan = 0; tCredited = false; releaseLock(); stopTickSound();
  timerEl.classList.remove("on", "done"); document.title = "Dayfall";
  try { localStorage.removeItem(TKEY); } catch (e) {}
}
$("tstop").onclick = () => { stopTimer(); render(); };
function resumeTimer() {
  let t = null; try { t = JSON.parse(localStorage.getItem(TKEY) || "null"); } catch (e) {}
  if (!t) { if (timerEl.classList.contains("on")) stopTimer(); return; }
  if (t.end > Date.now() || Date.now() - t.end < 15 * 60000) {
    tEnd = t.end; tStart = t.start || 0; tPlan = t.plan || 0; tRef = t.ref || null; tCredited = !!t.credited;
    showTimer(t.name, false);
  } else stopTimer();
}
// One shared AudioContext, created/resumed inside a user tap (startTimer). A context created at
// finish time is suspended on iOS — the old alarm never played there. This one is already unlocked.
let audioCtx = null, tickSrc = null;
// Sound while a timer runs: "off" (silent), "tick" (soft once-a-second tick), or "hum"
// (a sub-audible 40Hz loop — nothing to hear, but the live audio session lets the finish
// alarm play even in the background). Cues (halfway / 5-min nudges) toggle independently.
// The finish alarm itself is never muted.
const SOUND_MODES = ["off", "tick", "hum"];
const SOUND_LABELS = {
  off: ["🔇", "Timer sound: silent. The alarm still plays while the app is open."],
  tick: ["🔊", "Timer sound: soft tick. Passing time you can hear — and the alarm works even in the background."],
  hum: ["🤫", "Timer sound: silent keep-alive. Nothing to hear, but the alarm works even in the background."]
};
let soundMode = "off", cuesPref = true;
try {
  soundMode = localStorage.getItem("unstuck-sound") || (localStorage.getItem("unstuck-tick") === "1" ? "tick" : "off");
  if (!SOUND_MODES.includes(soundMode)) soundMode = "off";
  cuesPref = localStorage.getItem("unstuck-cues") !== "0";
} catch (e) {}
function saveSoundPrefs() { try { localStorage.setItem("unstuck-sound", soundMode); localStorage.setItem("unstuck-cues", cuesPref ? "1" : "0"); } catch (e) {} }
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
  return audioCtx;
}
// Looped 1s buffers need no JS timers, so background throttling can't kill them.
function tickBuffer(a) {
  const sr = a.sampleRate, buf = a.createBuffer(1, sr, sr), d = buf.getChannelData(0);
  for (let i = 0; i < sr * 0.03; i++) d[i] = Math.sin(i / sr * 2 * Math.PI * 1000) * Math.exp(-i / (sr * 0.006)) * 0.5;
  return buf;
}
function humBuffer(a) {
  const sr = a.sampleRate, buf = a.createBuffer(1, sr, sr), d = buf.getChannelData(0);
  for (let i = 0; i < sr; i++) d[i] = Math.sin(i / sr * 2 * Math.PI * 40); // 40Hz: below what phone speakers reproduce
  return buf;
}
function startKeepalive() {
  stopTickSound();
  if (soundMode === "off") return;
  const a = ensureAudio(); if (!a) return;
  try {
    tickSrc = a.createBufferSource();
    const g = a.createGain();
    if (soundMode === "tick") { tickSrc.buffer = tickBuffer(a); g.gain.value = 0.12; }
    else { tickSrc.buffer = humBuffer(a); g.gain.value = 0.012; }
    tickSrc.loop = true; tickSrc.connect(g); g.connect(a.destination); tickSrc.start();
  } catch (e) { tickSrc = null; }
}
function stopTickSound() { try { if (tickSrc) tickSrc.stop(); } catch (e) {} tickSrc = null; }
function updateSoundUI() {
  const [icon, label] = SOUND_LABELS[soundMode];
  const b = $("tsound"); b.textContent = icon; b.dataset.mode = soundMode; b.setAttribute("aria-label", label);
  document.querySelectorAll("#msound button").forEach(x => x.setAttribute("aria-checked", String(x.dataset.mode === soundMode)));
  $("mcues").checked = cuesPref;
}
function setSoundMode(m) {
  soundMode = m; saveSoundPrefs(); updateSoundUI();
  if (timerEl.classList.contains("on") && !timerEl.classList.contains("done")) startKeepalive();
  toast(SOUND_LABELS[m][1], null); announce(SOUND_LABELS[m][1]);
}
$("tsound").onclick = () => setSoundMode(SOUND_MODES[(SOUND_MODES.indexOf(soundMode) + 1) % SOUND_MODES.length]);
document.querySelectorAll("#msound button").forEach(b => b.onclick = () => setSoundMode(b.dataset.mode));
$("mcues").onchange = e => { cuesPref = e.target.checked; saveSoundPrefs(); announce(cuesPref ? "Halfway and 5-minute nudges on." : "Nudges off. The end alarm still plays."); };
updateSoundUI();
// The alarm: six alternating tones over ~2 seconds, plus a long vibration pattern.
function beep() {
  try {
    if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 800]);
    const a = ensureAudio(); if (!a) return;
    [0, .3, .6, 1.1, 1.4, 1.7].forEach((t, i) => {
      const o = a.createOscillator(), g = a.createGain(); o.frequency.value = i % 2 ? 660 : 880;
      o.connect(g); g.connect(a.destination);
      g.gain.setValueAtTime(.3, a.currentTime + t); g.gain.exponentialRampToValueAtTime(.001, a.currentTime + t + .28);
      o.start(a.currentTime + t); o.stop(a.currentTime + t + .3);
    });
  } catch (e) { console.warn("beep unavailable", e); }
}
// Full-screen green pulse at zero — visible from across the room. Three slow pulses (~1.7Hz,
// far below photosensitivity thresholds); reduced-motion gets one gentle fade instead.
function flash() {
  const f = $("flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
  f.addEventListener("animationend", () => f.classList.remove("go"), { once: true });
  // Hidden tabs pause CSS animations, so animationend may never fire there; clear regardless.
  setTimeout(() => f.classList.remove("go"), 4000);
}
// One soft blip for interval cues — a nudge, not an alarm.
function blip() {
  try {
    if (navigator.vibrate) navigator.vibrate(120);
    const a = ensureAudio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain(); o.frequency.value = 660; o.connect(g); g.connect(a.destination);
    g.gain.setValueAtTime(.12, a.currentTime); g.gain.exponentialRampToValueAtTime(.001, a.currentTime + .2);
    o.start(); o.stop(a.currentTime + .2);
  } catch (e) {}
}
// Keep the screen awake while a timer runs (looking away is the whole failure mode).
async function acquireLock() { try { if (navigator.wakeLock && !document.hidden) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {} }
function releaseLock() { try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {} }
// Timer-end notification so "you're allowed to stop" arrives even if the app is in the background.
function notifyEnd() {
  if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
  try {
    navigator.serviceWorker.getRegistration().then(r => {
      if (r) r.showNotification("You're allowed to stop.", { body: timerTaskName || "Timer done", icon: "icons/icon-192.png", tag: "unstuck-timer" });
    }).catch(() => {});
  } catch (e) {}
}
// Ask for notification permission contextually — first timer, never on load.
function maybeAskAlerts() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  let dismissed = false; try { dismissed = localStorage.getItem("unstuck-alerts-dismissed") === "1"; } catch (e) {}
  if (!dismissed) $("alerts").classList.add("on");
}
$("alertsBtn").onclick = async () => {
  $("alerts").classList.remove("on");
  try { const r = await Notification.requestPermission(); if (r === "granted") announce("Alerts on."); } catch (e) {}
};
$("alertsX").onclick = () => { $("alerts").classList.remove("on"); try { localStorage.setItem("unstuck-alerts-dismissed", "1"); } catch (e) {} };

// Timers drift when a tab is throttled; re-tick and re-acquire the wake lock when we come back.
// Also catch the day rolling over while the app sat open.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (tInt) { tick(); acquireLock(); }
  if (lastDayIso && lastDayIso !== iso(today())) { render(); checkCarry(); }
});

// ---------- sheets (accessible bottom-sheet dialogs) ----------
let sheetOpener = null;
function openSheet(id, opener) {
  const s = $(id); s.classList.add("on"); sheetOpener = opener || document.activeElement;
  // Skip checkboxes: focusing one draws a heavy ring on the first carry row.
  const f = s.querySelector('input:not([type="checkbox"]):not([hidden]), button:not([hidden])'); if (f) setTimeout(() => f.focus(), 30);
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

// ---------- I'm stuck (targets today's one thing when there is one) ----------
let stuckRef = null, stuckName = "Smallest thing you can see";
function prepStuck() {
  const p = plan(); stuckRef = null; stuckName = "Smallest thing you can see";
  if (p) {
    // Prefer today's one thing; if it's done, fall back to the next unfinished task today.
    const list = p.tasks[iso(today())] || [];
    const t = list.find(x => x.star && !x.done) || list.find(x => !x.done);
    if (t) { stuckRef = { pid: p.id, ds: iso(today()), tid: t.id }; stuckName = t.title; $("ten").textContent = `Start 10 minutes on: ${t.title}`; return; }
  }
  $("ten").textContent = "Start 10 minutes";
}
$("stuckBtn").onclick = () => { prepStuck(); openSheet("stuck", $("stuckBtn")); };
$("ten").onclick = () => { closeSheet($("stuck")); startTimer(10, stuckName, stuckRef); };

// ---------- new countdown ----------
function openNew(opener) {
  const T = today(); $("pstart").value = iso(T); $("pend").value = iso(addDays(T, 21)); $("pname").value = ""; $("pmsg").textContent = "";
  openSheet("newplan", opener);
}
$("pcreate").onclick = () => {
  const name = $("pname").value.trim() || "Countdown";
  if (!$("pstart").value || !$("pend").value) { $("pmsg").textContent = "Pick a start and end date."; return; }
  if ($("pend").value < $("pstart").value) { $("pmsg").textContent = "The deadline needs to be on or after the start."; return; }
  const p = normalize({ id: uid(), name, start: $("pstart").value, end: $("pend").value });
  db.plans.push(p); db.current = p.id; save(p); closeSheet($("newplan")); view = "day"; weekStart = null; render();
};
// Enter anywhere in the sheet creates the countdown (matches the task-add input).
["pname", "pstart", "pend"].forEach(id => $(id).addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("pcreate").click(); } }));
// Countdown switcher: big tappable rows instead of a cramped dropdown.
function renderPlanSheet() {
  const T = today(); const ds = iso(T);
  $("planList").innerHTML = livePlans().map(q => {
    const l = q.tasks[ds] || []; const done = l.filter(t => t.done).length;
    const dl = daysLeft(q, T);
    const bits = [dl < 0 ? "done" : dl === 0 ? "day 0" : dl + " left"];
    if (l.length) bits.push(done + "/" + l.length + " today");
    return `<button class="prow ${q.id === db.current ? "on" : ""}" data-id="${q.id}"${q.id === db.current ? ' aria-current="true"' : ""}><span class="pn">${esc(q.name)}</span><span class="pd">${bits.join(" · ")}</span></button>`;
  }).join("");
  $("planList").querySelectorAll(".prow").forEach(b => b.onclick = () => {
    db.current = b.dataset.id; persist(); openDay = null; weekStart = null;
    closeSheet($("plansSheet")); render();
  });
}
$("planBtn").onclick = () => { renderPlanSheet(); openSheet("plansSheet", $("planBtn")); };
$("pnew").onclick = () => { closeSheet($("plansSheet")); openNew($("planBtn")); };
document.querySelectorAll(".views button[data-v]").forEach(b => b.onclick = () => { view = b.dataset.v; openDay = null; weekStart = null; render(); });

// ---------- carry-over: yesterday's unfinished tasks, once per day ----------
// Everything is checked by default so the fast path stays two taps; unchecking a row means
// "decide later" — it stays put and comes back in tomorrow's prompt. The day picker sends
// the checked items to today, tomorrow, or any day this week.
let carryItems = [];
const carryChecked = () => [...$("carryList").querySelectorAll("input:checked")].map(x => carryItems[+x.dataset.i]);
function carryLabels() {
  const n = carryChecked().length;
  const opt = $("carryDest").selectedOptions[0];
  const short = opt ? opt.dataset.short : "today";
  $("carryMove").textContent = n ? `Move ${n} to ${short}` : "Move to " + short;
  $("carryDrop").textContent = n ? `Let ${n} go` : "Let them go";
  $("carryMove").disabled = !n; $("carryDrop").disabled = !n;
}
function checkCarry() {
  const tds = iso(today());
  let mark = null; try { mark = localStorage.getItem("unstuck-carry"); } catch (e) {}
  if (mark === tds) return;
  carryItems = [];
  for (const p of livePlans()) for (const ds of Object.keys(p.tasks || {})) {
    if (ds >= tds) continue;
    for (const t of p.tasks[ds]) if (!t.done && !t.dropped && !t.dailyId && !t.id.includes("@")) carryItems.push({ p, ds, t });
  }
  if (!carryItems.length) return;
  try { localStorage.setItem("unstuck-carry", tds); } catch (e) {}
  $("carryList").innerHTML = carryItems.map((c, i) =>
    `<label class="citem"><input type="checkbox" checked data-i="${i}"><span class="ct">${esc(c.t.title)}<small>${esc(c.p.name)} · ${fmt(pd(c.ds))}</small></span></label>`).join("");
  const T = today();
  $("carryDest").innerHTML = [0, 1, 2, 3, 4, 5, 6].map(n => {
    const d = addDays(T, n);
    const label = n === 0 ? `Today — ${fmt(d)}` : n === 1 ? `Tomorrow — ${fmt(d)}` : fmt(d);
    const short = n === 0 ? "today" : n === 1 ? "tomorrow" : d.toLocaleDateString("en-US", { weekday: "short" });
    return `<option value="${iso(d)}" data-short="${short}">${label}</option>`;
  }).join("");
  $("carryList").querySelectorAll("input").forEach(x => x.onchange = carryLabels);
  $("carryDest").onchange = carryLabels;
  carryLabels();
  openSheet("carry", $("stuckBtn"));
}
$("carryMove").onclick = () => {
  const sel = carryChecked(); if (!sel.length) return;
  const destDs = $("carryDest").value || iso(today());
  const short = ($("carryDest").selectedOptions[0] || {}).dataset ? $("carryDest").selectedOptions[0].dataset.short : "today";
  const touched = new Set(); const moved = [];
  for (const c of sel) { const nt = moveTaskCore(c.p, c.ds, c.t, destDs); moved.push({ p: c.p, fromDs: c.ds, toDs: destDs, t: c.t, nt }); touched.add(c.p); }
  touched.forEach(p => save(p));
  closeSheet($("carry")); render();
  toast(`Moved ${sel.length} to ${short}`, () => { moved.forEach(undoMove); render(); });
  carryItems = [];
};
$("carryDrop").onclick = () => {
  const sel = carryChecked(); if (!sel.length) return;
  const touched = new Set();
  for (const c of sel) { c.t.dropped = true; touched.add(c.p); }
  touched.forEach(p => save(p));
  closeSheet($("carry")); render();
  toast(sel.length === carryItems.length ? "Let go. Clean slate." : `Let ${sel.length} go`,
    () => { for (const c of sel) delete c.t.dropped; touched.forEach(p => save(p)); render(); });
  carryItems = [];
};

// ---------- menu: backup, import, archived ----------
$("menuBtn").onclick = () => { renderMenu(); openSheet("menuSheet", $("menuBtn")); };
function renderMenu() {
  const arch = db.plans.filter(p => !p.deleted && p.archived);
  $("marchived").innerHTML = arch.length ? "<h3>Archived</h3>" + arch.map(p => `<div class="arow"><span>${esc(p.name)}</span><button data-id="${p.id}">Restore</button></div>`).join("") : "";
  $("marchived").querySelectorAll("button").forEach(b => b.onclick = () => {
    const p = db.plans.find(x => x.id === b.dataset.id);
    if (p) { p.archived = false; save(p); db.current = p.id; persist(); renderMenu(); render(); }
  });
  $("mmsg").textContent = ""; $("mmsg").classList.remove("err");
  updateSoundUI();
}
$("mexport").onclick = () => {
  const blob = new Blob([JSON.stringify({ app: "dayfall", version: 1, exported: new Date().toISOString(), db }, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `dayfall-backup-${iso(today())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  $("mmsg").textContent = "Backup saved. Keep the file somewhere safe.";
};
// Calendar export: one 8:00 AM event per remaining day with an alert — the phone's calendar
// becomes the nag, no push server needed. Re-importing later just updates (stable UIDs).
const icsEscape = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
$("mics").onclick = () => {
  const p = plan();
  if (!p) { $("mmsg").textContent = "Start a countdown first."; $("mmsg").classList.add("err"); return; }
  const T = today();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Dayfall//EN", "CALSCALE:GREGORIAN"];
  for (let d = new Date(Math.max(+T, +pd(p.start))); iso(d) <= p.end; d = addDays(d, 1)) {
    const ds = iso(d); ensureDaily(p, ds);
    const left = daysLeft(p, d);
    const tasks = p.tasks[ds] || []; const star = tasks.find(t => t.star);
    const what = star ? star.title : tasks.length ? tasks.length + " tasks" : "open Dayfall";
    const dt = ds.replace(/-/g, "");
    lines.push("BEGIN:VEVENT", `UID:unstuck-${p.id}-${ds}`, `DTSTAMP:${stamp}`,
      `DTSTART:${dt}T080000`, `DTEND:${dt}T083000`,
      `SUMMARY:${icsEscape(`${left === 0 ? "Day 0" : left + " left"} — ${what}`)}`,
      `DESCRIPTION:${icsEscape(tasks.length ? tasks.map(t => "• " + t.title + (t.min ? ` (${t.min}m)` : "")).join("\n") : "You're allowed to just start.")}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape("Dayfall — " + what)}`, "TRIGGER:PT0S", "END:VALARM",
      "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `dayfall-${(p.name.replace(/[^\w-]+/g, "-").toLowerCase() || "countdown")}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  $("mmsg").textContent = "Calendar file saved. Open it and your calendar takes over the morning reminders."; $("mmsg").classList.remove("err");
};
$("mimport").onclick = () => $("mimportfile").click();
// Merge a backup object ({db:{plans,stats}} or bare {plans}) into local state. Returns how many plans landed.
function importBackup(d) {
  const src = d && d.db && Array.isArray(d.db.plans) ? d.db : (d && Array.isArray(d.plans) ? d : null);
  if (!src) throw new Error("That file doesn't look like a Dayfall backup.");
  let n = 0;
  for (const raw of src.plans) {
    if (!raw || !raw.id || !raw.start || !raw.end) continue;
    const inc = normalize(raw); const i = db.plans.findIndex(x => x.id === inc.id);
    if (i < 0) db.plans.push(inc); else db.plans[i] = mergePlans(db.plans[i], inc);
    sync.markDirty(inc.id); n++;
  }
  for (const [ds, sec] of Object.entries(src.stats || {})) db.stats[ds] = Math.max(db.stats[ds] || 0, +sec || 0);
  persist(); render();
  return n;
}
$("mimportfile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const n = importBackup(JSON.parse(await f.text()));
    $("mmsg").textContent = `Imported ${n} countdown${n === 1 ? "" : "s"}.`; $("mmsg").classList.remove("err");
  } catch (err) {
    $("mmsg").textContent = (err && err.message) || "Couldn't read that file."; $("mmsg").classList.add("err");
  }
};
// ?import=<path> — load a list hosted alongside the app (same origin only) with one tap.
// Merging is idempotent (same plan ids), so opening the link twice can't duplicate anything.
function importFromUrl(imp) {
  let u = null;
  try { u = new URL(imp, location.href); } catch (e) {}
  if (!u || u.origin !== location.origin) { banner("Lists can only be loaded from this app's own site.", true); return; }
  fetch(u).then(r => { if (!r.ok) throw new Error("Couldn't fetch that list (" + r.status + ")."); return r.json(); })
    .then(d => {
      const n = importBackup(d);
      toast(`Added ${n} countdown${n === 1 ? "" : "s"}. It's yours now — it saves on this phone.`, null);
    })
    .catch(e => banner((e && e.message) || "Couldn't load that list.", true));
}

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
// iOS Safari never fires beforeinstallprompt, so iPhone users would never see an install hint —
// yet install is what unlocks notifications and reliable storage there. Show a manual nudge.
(() => {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (!isIOS || standalone) return;
  let dismissed = false; try { dismissed = localStorage.getItem("unstuck-install-dismissed") === "1"; } catch (e) {}
  if (dismissed) return;
  $("installTxt").textContent = "On iPhone: tap Share, then “Add to Home Screen.” That unlocks alerts and keeps your lists safe.";
  $("installBtn").hidden = true;
  $("install").classList.add("on");
})();

// ---------- Supabase sync (only if config.js has keys) ----------
const sync = (() => {
  const cfg = window.UNSTUCK_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  // Pinned version + Subresource Integrity: a tampered CDN file will refuse to run instead of running with your session.
  const LIB = { src: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.115.0/dist/umd/supabase.js", integrity: "sha384-CLZeq1dk8+Uzrs7TVvBUdlFoV5F0DMqgRoeHa8g5wJcuPe5SkVfEvdxB0ZuzlnBQ" };
  let sb = null, user = null, plus = true, dirty = new Set(), pushTimer = null, channel = null, loading = null, lastPull = null;
  const dot = $("syncDot"), txt = $("syncTxt");
  function status(state, label) { dot.className = state; txt.textContent = label; }
  function msg(text, err) { const m = $("syncIn").hidden ? $("smsg") : $("smsg2"); m.textContent = text || ""; m.classList.toggle("err", !!err); }
  function saveDirty() { try { localStorage.setItem("unstuck-dirty", JSON.stringify([...dirty])); } catch (e) {} }

  function markDirty(id) { if (!enabled) return; dirty.add(id); saveDirty(); if (user) schedulePush(); }
  function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(() => push().catch(fail), 800); }
  function fail(e) { console.warn("sync error", e); status("err", "Retry"); msg((e && e.message) || "Sync failed. Try again.", true); }

  const toRow = p => ({ id: p.id, user_id: user.id, name: p.name, start_date: p.start, end_date: p.end, tasks: p.tasks || {}, tombstones: p.tombstones || [], daily: p.daily || [], updated_at: p.updated_at, deleted: !!p.deleted, archived: !!p.archived });
  const fromRow = r => normalize({ id: r.id, name: r.name, start: r.start_date, end: r.end_date, tasks: r.tasks || {}, tombstones: r.tombstones || [], daily: r.daily || [], updated_at: r.updated_at, deleted: !!r.deleted, archived: !!r.archived });

  // Merge a remote row into local state. Returns true if local changed; marks dirty if the merge produced something the server doesn't have.
  function mergeRow(r) {
    const remote = fromRow(r); const i = db.plans.findIndex(p => p.id === remote.id);
    if (i < 0) { db.plans.push(remote); return true; }
    const local = db.plans[i]; if (samePlan(local, remote)) { local.updated_at = remote.updated_at; return false; }
    const merged = mergePlans(local, remote);
    if (!samePlan(merged, remote)) { merged.updated_at = new Date().toISOString(); dirty.add(merged.id); saveDirty(); }
    db.plans[i] = merged; return true;
  }

  // Dayfall Plus: once config.js names a checkout link, sync is a Plus feature. Blank = free
  // for everyone (the pre-launch default). Founding accounts are grandfathered in profiles.plus.
  // Fails open — a network blip must never lock a paying user out of sync.
  async function checkPlus() {
    if (!cfg.plusUrl) { plus = true; updatePlusUI(); return; }
    try {
      const { data } = await sb.from("profiles").select("plus").eq("user_id", user.id).maybeSingle();
      plus = !!(data && data.plus);
    } catch (e) { plus = true; }
    updatePlusUI();
  }
  function updatePlusUI() {
    $("plusBox").hidden = plus;
    $("ssyncnow").hidden = !plus;
    $("syncH2").textContent = plus ? "Synced" : "Signed in";
    if (user && !plus) status("", "Plus");
  }

  async function push() {
    if (!user || !plus || !navigator.onLine || dirty.size === 0) return;
    const ids = [...dirty]; const rows = db.plans.filter(p => ids.includes(p.id)).map(toRow);
    if (!rows.length) { dirty.clear(); saveDirty(); return; }
    status("busy", "Saving…");
    const { error } = await sb.from("plans").upsert(rows, { onConflict: "id" });
    if (error) { fail(error); return; }
    ids.forEach(id => dirty.delete(id)); saveDirty();
    status("ok", "Synced"); msg("");
  }

  async function pull() {
    if (!user || !plus || !navigator.onLine) return;
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
    if (!plan()) { const first = livePlans()[0]; db.current = first ? first.id : null; changed = true; }
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
    if (u) {
      $("swho").textContent = u.email || "";
      try { lastPull = localStorage.getItem("unstuck-lastpull-" + u.id); } catch (e) {}
      checkPlus().then(() => {
        if (plus) { status("ok", "Synced"); subscribe(); pull().catch(fail); }
      });
    } else { plus = true; lastPull = null; if (channel) { sb.removeChannel(channel); channel = null; } status("", "Sync"); updatePlusUI(); }
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
    $("syncBtn").onclick = async () => { msg(""); $("sform").hidden = false; $("ssent").hidden = true; openSheet("syncSheet", $("syncBtn")); if (!sb) await connect(); };
    $("ssend").onclick = async () => {
      const email = $("semail").value.trim(); if (!email) { msg("Enter your email first.", true); return; }
      if (!sb && !(await connect())) return;
      $("ssend").disabled = true; $("ssend").textContent = "Sending…";
      try {
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) {
          msg(/rate limit/i.test(error.message || "") ? "Email limit reached for now — the free tier only sends a few sign-in links per hour. Wait a bit and try once." : error.message, true);
        } else {
          // Swap to an unmissable confirmation instead of a small grey line under the field.
          $("sentTo").textContent = email; $("sform").hidden = true; $("ssent").hidden = false;
        }
      } catch (e) { msg(e.message || "Couldn't send the link.", true); }
      $("ssend").disabled = false; $("ssend").textContent = "Send sign-in link";
    };
    $("semail").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("ssend").click(); } });
    $("ssyncnow").onclick = async () => { msg("Syncing…"); try { await pull(); msg(dirty.size ? "Some changes still waiting — are you online?" : "Up to date."); } catch (e) { fail(e); } };
    $("plusGo").href = cfg.plusUrl || "#";
    $("plusRefresh").onclick = async () => {
      msg("Checking…");
      await checkPlus();
      if (plus) { msg("Plus is active. Syncing…"); status("ok", "Synced"); subscribe(); pull().catch(fail); }
      else msg("Not active yet — payments can take a minute. Make sure you paid with this same email.", true);
    };
    $("sout").onclick = async () => { try { await sb.auth.signOut(); } catch (e) {} closeSheet($("syncSheet")); };
    window.addEventListener("online", async () => { if (!sb) await connect(); if (user) pull().catch(fail); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && user) pull().catch(fail); });

    await connect();
  }
  return { markDirty, init };
})();

// ---------- boot ----------
load(); resumeTimer(); render(); sync.init().catch(e => console.warn("sync init failed", e));
const params = new URLSearchParams(location.search);
if (params.get("import")) {
  history.replaceState(null, "", location.pathname);
  importFromUrl(params.get("import"));
} else if (params.get("stuck") === "1") {
  prepStuck(); openSheet("stuck", $("stuckBtn")); history.replaceState(null, "", location.pathname);
} else checkCarry();
})();
