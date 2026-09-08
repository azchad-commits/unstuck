// Headless smoke test: serves the folder, loads the app, exercises P0 flows.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = spawn("python3", ["-m", "http.server", "8765", "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await new Promise(r => setTimeout(r, 800));
const fails = [];
const check = (ok, name) => { console.log((ok ? "PASS " : "FAIL ") + name); if (!ok) fails.push(name); };

try {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "allow" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  // Sandbox has no outbound internet: ignore CDN/font fetch failures and the no-gesture vibrate notice.
  page.on("console", m => { const t = m.text(); if (m.type() === "error" && !/net::ERR_|Failed to load resource|navigator\.vibrate|backup kept in unstuck-v1-corrupt/.test(t)) errors.push(t); });

  // The repo's config.js now carries real sync keys; the main run still tests blank-config
  // behavior, so stub it empty here (the sync-specific section re-routes with mock keys later).
  await page.route("**/config.js", r => r.fulfill({ contentType: "application/javascript", body: 'window.UNSTUCK_CONFIG={supabaseUrl:"",supabaseAnonKey:""};' }));
  await page.goto("http://127.0.0.1:8765/", { waitUntil: "networkidle" });
  const manifest = await page.evaluate(() => fetch(document.querySelector('link[rel=manifest]').href).then(r => r.json()));
  check(manifest.name === "Dayfall" && manifest.display === "standalone" && manifest.icons.length === 4, "manifest loads with 4 icons + standalone");
  for (const i of manifest.icons) { const s = await page.evaluate(u => fetch(u).then(r => r.status), i.src); check(s === 200, "icon reachable: " + i.src); }
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; });
  check(sw, "service worker registered and active");
  check(await page.locator("#syncBtn").isHidden(), "sync button hidden when config is blank");
  check(await page.locator("#stuckbar").isVisible(), "stuck bar visible even with no plan (spec: always visible)");

  // Create a plan
  await page.click("#first");
  await page.fill("#pname", "Move out");
  await page.click("#pcreate");
  check(/^\d+$/.test((await page.textContent("#big")).trim()), "days-left counter shows a number");
  check((await page.textContent("#big")).trim() === "21", "default deadline is 21 days out");
  check(await page.locator("#stuckbar").isVisible(), "stuck bar appears once a plan exists");

  // Add a task, check chip, tap chip → timer
  await page.fill(".add input", "Pack kitchen");
  await page.selectOption(".add select", "45");
  await page.click(".add button");
  check(await page.locator(".task .min").textContent() === "45 min", "task renders 45-min chip");
  check((await page.locator(".hero").textContent()).includes("Pack kitchen"), "first task auto-starred as 'one thing' (hero card)");
  await page.fill(".add input", "Label boxes"); await page.click(".add button");
  await page.locator(".task").nth(1).locator(".star").click();
  check((await page.locator(".hero").textContent()).includes("Label boxes") && await page.locator(".star.on").count() === 1, "star button moves the one thing (keyboard-reachable)");
  check(await page.locator(".task .del").first().isHidden(), "delete is hidden until Edit mode is on");
  await page.click(".day .editbtn");
  check(await page.locator(".task .del").first().isVisible(), "Edit toggle reveals delete controls");
  await page.locator(".task").nth(1).locator(".del").click();
  check(await page.locator(".task").count() === 1 && await page.locator("#toast.on").isVisible(), "delete shows undo toast");
  await page.click("#undo"); check(await page.locator(".task").count() === 2, "undo restores the task");
  await page.locator(".task").nth(1).locator(".del").click(); await page.waitForTimeout(100);
  check(await page.locator("#stuck").getAttribute("role") === null && await page.locator('#stuck [role="dialog"]').count() === 1, "sheets are dialogs");
  // Edit mode: change a task's minutes in place
  await page.locator(".task").first().locator(".mins").selectOption("15");
  const newMin = await page.evaluate(() => { const p = JSON.parse(localStorage.getItem("unstuck-v1")).plans[0]; return Object.values(p.tasks)[0][0].min; });
  check(newMin === 15, "edit mode changes a task's minutes in place");
  await page.locator(".task").first().locator(".mins").selectOption("45"); // restore for the timer checks
  await page.click(".day .editbtn"); // leave edit mode (min chips are hidden while editing)
  await page.click(".task .min");
  check(await page.locator("#timer.on").isVisible(), "tapping chip starts timer");
  check(/^4[45]:\d\d$/.test(await page.textContent("#tt")), "timer counts from 45:00");
  check(await page.locator("#tsound").isVisible() && await page.locator("#flash").count() === 1, "sound toggle and flash layer present");
  await page.click("#tsound");
  check((await page.getAttribute("#tsound", "data-mode")) === "tick", "sound toggle cycles to soft tick");
  await page.click("#tsound");
  check((await page.getAttribute("#tsound", "data-mode")) === "hum", "sound toggle cycles to silent keep-alive");
  await page.click("#tsound"); // back to off
  check(((await page.getAttribute("#tbar", "style")) || "").includes("width"), "timer paints the time-as-space bar");
  check((await page.title()).includes("· Dayfall"), "tab title shows the countdown");

  // Timer survives reload
  await page.reload({ waitUntil: "networkidle" });
  check(await page.locator("#timer.on").isVisible(), "timer resumes after reload");
  check((await page.textContent("#tn")) === "Pack kitchen", "resumed timer keeps task name");

  // Check-off persists
  await page.click(".task .chk");
  await page.reload({ waitUntil: "networkidle" });
  check(await page.locator(".task.on").count() === 1, "check-off persists across reload");

  // Views
  await page.click('.views button[data-v="week"]'); check(await page.locator(".day").count() === 7, "week view shows 7 days");
  await page.click('.views button[data-v="month"]'); check(await page.locator(".month .cell:not(.empty)").count() >= 28, "month view renders grid");

  // Month → future date: the week window jumps to the tapped day instead of snapping back
  await page.click('.views button[data-v="month"]');
  const target = new Date(); target.setDate(target.getDate() + 10);
  if (target.getMonth() !== new Date().getMonth()) await page.click("#nm");
  const tlbl = target.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  await page.click(`.month .cell[aria-label^="${tlbl}"]`);
  check((await page.locator(".day").first().textContent()).includes(tlbl), "month tap opens that future day in the week view");
  check(await page.locator("#wn").count() === 1 && await page.locator("#wp").count() === 1, "week view has earlier/later paging");
  await page.click("#wp");
  check(!(await page.locator(".day").first().textContent()).includes(tlbl), "week paging moves the window");
  await page.click('.views button[data-v="day"]');

  // Second countdown via the switcher sheet; Enter submits; merged today shows the other plan
  await page.click("#planBtn");
  check(await page.locator("#plansSheet.on").isVisible() && await page.locator(".prow").count() === 1, "countdown switcher sheet opens");
  await page.click("#pnew");
  await page.fill("#pname", "Second thing");
  await page.press("#pname", "Enter");
  check(await page.locator("#newplan.on").count() === 0, "Enter submits the new-countdown sheet");
  check(await page.locator(".day.other").count() === 1 && (await page.locator(".day.other").textContent()).includes("Move out"), "today view shows the other countdown's tasks");
  await page.click("#planBtn");
  check(await page.locator(".prow").count() === 2 && await page.locator(".prow.on").count() === 1, "switcher lists both countdowns, current highlighted");
  await page.locator(".prow").first().click();
  check((await page.textContent("#planName")) === "Move out", "tapping a row switches countdowns");
  await page.click("#planBtn"); await page.locator(".prow").nth(1).click(); // back to Second thing for the menu tests

  // Menu: export downloads a backup file
  await page.click("#menuBtn");
  check(await page.locator("#menuSheet.on").isVisible(), "menu sheet opens");
  check(await page.locator("#msound button").count() === 3 && await page.locator("#mcues").count() === 1, "menu has timer-sound modes and cues toggle");
  await page.click('#msound button[data-mode="hum"]');
  check((await page.getAttribute("#tsound", "data-mode")) === "hum", "menu radio drives the timer toggle");
  await page.click('#msound button[data-mode="off"]');
  await page.locator("#mcues").uncheck(); await page.locator("#mcues").check();
  const dlPromise = page.waitForEvent("download");
  await page.click("#mexport");
  check((await dlPromise).suggestedFilename().startsWith("dayfall-backup-"), "export downloads a backup file");
  const icsPromise = page.waitForEvent("download");
  await page.click("#mics");
  const icsDl = await icsPromise;
  check(icsDl.suggestedFilename().endsWith(".ics"), "calendar export downloads an .ics file");
  const icsText = (await import("node:fs")).readFileSync(await icsDl.path(), "utf8");
  check(icsText.includes("BEGIN:VCALENDAR") && icsText.includes("BEGIN:VEVENT") && icsText.includes("VALARM") && icsText.includes("DTSTART"), "ics has daily events with alarms");
  await page.keyboard.press("Escape");

  // Corrupted state is backed up, not wiped
  await page.evaluate(() => { localStorage.setItem("unstuck-v1", "{not json"); });
  await page.reload({ waitUntil: "networkidle" });
  check(await page.locator("#banner.on").isVisible() && (await page.evaluate(() => localStorage.getItem("unstuck-v1-corrupt"))) === "{not json", "corrupted state → banner + backup kept");
  await page.evaluate(() => { localStorage.removeItem("unstuck-v1-corrupt"); });
  await page.click("#first"); await page.click("#pcreate"); await page.reload({ waitUntil: "networkidle" });

  // Carry-over: unfinished past tasks prompt once per day, per-item checkboxes + day picker
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("unstuck-v1"));
    const p = raw.plans.find(x => !x.deleted);
    const f = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
    p.tasks[f(1)] = [{ id: "carry1", title: "Old thing", done: false }];
    p.tasks[f(2)] = [{ id: "carry2", title: "Older thing", done: false }];
    localStorage.setItem("unstuck-v1", JSON.stringify(raw));
    localStorage.removeItem("unstuck-carry");
  });
  await page.reload({ waitUntil: "networkidle" });
  check(await page.locator("#carry.on").isVisible() && await page.locator("#carryList input").count() === 2, "carry-over sheet lists past unfinished tasks with checkboxes");
  await page.locator("#carryList input").nth(1).uncheck();
  check((await page.textContent("#carryMove")).includes("1"), "carry buttons show the checked count");
  await page.selectOption("#carryDest", { index: 1 }); // tomorrow
  check((await page.textContent("#carryMove")).includes("tomorrow"), "day picker changes the move destination");
  await page.click("#carryMove");
  const carried = await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem("unstuck-v1")).plans.find(x => !x.deleted);
    const f = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
    return { tomorrow: JSON.stringify(p.tasks[f(1)] || []), all: JSON.stringify(p.tasks) };
  });
  check(carried.tomorrow.includes("Old thing"), "checked task moved to the chosen day");
  check(carried.all.includes("Older thing"), "unchecked task stays put for tomorrow's prompt");

  // Future day → pull a task back to today from edit mode
  await page.click('.views button[data-v="week"]');
  await page.locator(".day").nth(1).locator(".hdmain").click();
  await page.locator(".day").nth(1).locator(".editbtn").click();
  await page.locator(".day").nth(1).locator(".task .mv").click();
  const pulled = await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem("unstuck-v1")).plans.find(x => !x.deleted);
    const d = new Date(); const ds = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    return JSON.stringify(p.tasks[ds] || []);
  });
  check(pulled.includes("Old thing"), "future task pulls back to today");
  await page.click("#undo");
  const undone = await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem("unstuck-v1")).plans.find(x => !x.deleted);
    const d = new Date(); d.setDate(d.getDate() + 1);
    const ds = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    return JSON.stringify(p.tasks[ds] || []);
  });
  check(undone.includes("Old thing"), "undo puts the moved task back");
  await page.click('.views button[data-v="day"]');

  // Estimate calibration: 5 finished timed tasks at 1.5x planned → hint appears
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("unstuck-v1"));
    const p = raw.plans.find(x => !x.deleted);
    const d = new Date(); const ds = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    p.tasks[ds] = (p.tasks[ds] || []).concat([1, 2, 3, 4, 5].map(i => ({ id: "cal" + i, title: "done " + i, min: 10, done: true, spent: 900 })));
    localStorage.setItem("unstuck-v1", JSON.stringify(raw));
  });
  await page.reload({ waitUntil: "networkidle" });
  check(await page.locator(".cal").count() === 1 && (await page.textContent(".cal")).includes("50%"), "estimate calibration hint shows the real overrun");

  // Timer end → permission to stop
  await page.evaluate(() => { localStorage.setItem("unstuck-timer", JSON.stringify({ end: Date.now() + 1200, name: "x" })); });
  await page.reload(); await page.waitForTimeout(2200);
  check((await page.textContent("#tn")).includes("allowed to stop"), "timer end shows 'You're allowed to stop'");
  check((await page.textContent("#announce")).includes("allowed to stop"), "screen-reader announcement on finish");
  // Escape closes a sheet and returns focus
  await page.click("#stuckBtn"); await page.keyboard.press("Escape");
  check(await page.locator("#stuck.on").count() === 0 && (await page.evaluate(() => document.activeElement.id)) === "stuckBtn", "Escape closes sheet, focus returns to opener");

  // Stuck button + shortcut URL
  await page.click("#stuckBtn"); check(await page.locator("#stuck.on").isVisible(), "I'm stuck sheet opens");
  await page.click("#ten"); check(/^(09|10):\d\d$/.test(await page.textContent("#tt")), "stuck sheet starts 10-min timer");
  await page.goto("http://127.0.0.1:8765/?stuck=1"); check(await page.locator("#stuck.on").isVisible(), "?stuck=1 shortcut opens sheet");

  // One-tap hosted list: ?import= fetches a same-origin backup and merges it
  await page.goto("http://127.0.0.1:8765/?import=issac-list.json"); await page.waitForTimeout(600);
  await page.click("#planBtn");
  check((await page.textContent("#planList")).includes("Issac list"), "?import= loads a hosted list");
  await page.keyboard.press("Escape");
  check(!page.url().includes("import="), "?import= cleans itself out of the URL");

  // Plan packs: relative-day template materializes from today
  await page.goto("http://127.0.0.1:8765/?import=packs/reset-week.json"); await page.waitForTimeout(600);
  const packState = await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem("unstuck-v1")).plans.find(x => x.name === "Reset Week");
    if (!p) return null;
    const f = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
    return { startsToday: p.start === f(0), endsDay6: p.end === f(6), todayTasks: (p.tasks[f(0)] || []).length, starred: (p.tasks[f(0)] || []).some(t => t.star) };
  });
  check(!!packState && packState.startsToday && packState.endsDay6 && packState.todayTasks === 3 && packState.starred, "plan pack loads relative to today with starred tasks");

  // Offline: shell served from SW cache
  await ctx.setOffline(true);
  await page.reload();
  check((await page.textContent("#big")).trim() !== "", "app loads offline from service worker");
  await ctx.setOffline(false);

  // Sync button appears when config has keys (no network call is made until sign-in)
  // Stub the sync library (SRI blocks serving a fake from the CDN route) so the send flow runs offline.
  await page.addInitScript(() => {
    window.supabase = { createClient: () => ({
      auth: { signInWithOtp: async () => ({ error: null }), onAuthStateChange: () => {}, getSession: async () => ({ data: { session: null } }) }
    }) };
  });
  await page.route("**/config.js", r => r.fulfill({ contentType: "application/javascript", body: 'window.UNSTUCK_CONFIG={supabaseUrl:"https://example.supabase.co",supabaseAnonKey:"anon"};' }));
  await page.evaluate(async () => { const rs = await navigator.serviceWorker.getRegistrations(); for (const r of rs) await r.unregister(); const ks = await caches.keys(); for (const k of ks) await caches.delete(k); });
  await page.reload({ waitUntil: "networkidle" });
  check(await page.locator("#syncBtn").isVisible(), "sync button shows when config has keys");
  await page.click("#syncBtn"); check(await page.locator("#syncSheet.on").isVisible(), "sync sheet opens with email form");
  await page.fill("#semail", "test@example.com");
  await page.click("#ssend");
  await page.waitForTimeout(400);
  check(await page.locator("#ssent").isVisible() && (await page.textContent("#sentTo")) === "test@example.com" && await page.locator("#sform").isHidden(), "magic-link send swaps to an unmissable confirmation");

  // Dayfall Plus: with a checkout link configured, a signed-in non-Plus account sees the
  // upgrade card instead of sync (stubbed session + profiles row)
  await page.addInitScript(() => {
    window.supabase = { createClient: () => ({
      auth: { signInWithOtp: async () => ({ error: null }), onAuthStateChange: () => {}, getSession: async () => ({ data: { session: { user: { id: "u1", email: "plus@test.dev" } } } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { plus: false } }) }) }) }),
      channel: () => ({ on() { return this; }, subscribe() {} }), removeChannel() {}
    }) };
  });
  await page.route("**/config.js", r => r.fulfill({ contentType: "application/javascript", body: 'window.UNSTUCK_CONFIG={supabaseUrl:"https://example.supabase.co",supabaseAnonKey:"anon",plusUrl:"https://buy.stripe.com/test_dayfall"};' }));
  // The re-registered service worker fetches config.js itself, bypassing page.route — clear it again.
  await page.evaluate(async () => { const rs = await navigator.serviceWorker.getRegistrations(); for (const r of rs) await r.unregister(); const ks = await caches.keys(); for (const k of ks) await caches.delete(k); });
  await page.reload({ waitUntil: "networkidle" });
  await page.click("#syncBtn"); await page.waitForTimeout(500);
  check(await page.locator("#plusBox").isVisible() && (await page.getAttribute("#plusGo", "href")).includes("stripe"), "non-Plus account sees the upgrade card instead of sync");
  check(await page.locator("#ssyncnow").isHidden() && (await page.textContent("#syncTxt")) === "Plus", "sync controls pause while un-upgraded");

  // iOS Safari never fires beforeinstallprompt — the manual add-to-home-screen nudge covers it
  const ios = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  const ipage = await ios.newPage();
  await ipage.goto("http://127.0.0.1:8765/", { waitUntil: "networkidle" });
  check(await ipage.locator("#install.on").isVisible() && (await ipage.textContent("#installTxt")).includes("Home Screen"), "iOS gets the add-to-home-screen nudge");
  await ios.close();

  check(errors.length === 0, "no console/page errors" + (errors.length ? " → " + errors.join(" | ") : ""));
  await page.screenshot({ path: path.join(root, "..", "dayfall-screenshot.png") });
  await browser.close();
} finally { server.kill(); }
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
