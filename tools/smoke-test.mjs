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

  await page.goto("http://127.0.0.1:8765/", { waitUntil: "networkidle" });
  const manifest = await page.evaluate(() => fetch(document.querySelector('link[rel=manifest]').href).then(r => r.json()));
  check(manifest.name === "Unstuck" && manifest.display === "standalone" && manifest.icons.length === 4, "manifest loads with 4 icons + standalone");
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
  await page.click(".day .editbtn"); // leave edit mode (min chips are hidden while editing)
  await page.click(".task .min");
  check(await page.locator("#timer.on").isVisible(), "tapping chip starts timer");
  check(/^4[45]:\d\d$/.test(await page.textContent("#tt")), "timer counts from 45:00");
  check(((await page.getAttribute("#tbar", "style")) || "").includes("width"), "timer paints the time-as-space bar");
  check((await page.title()).includes("· Unstuck"), "tab title shows the countdown");

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

  // Second countdown via the Enter key; merged today shows the other plan's tasks
  await page.selectOption("#plansel", "__new");
  await page.fill("#pname", "Second thing");
  await page.press("#pname", "Enter");
  check(await page.locator("#newplan.on").count() === 0, "Enter submits the new-countdown sheet");
  check(await page.locator(".day.other").count() === 1 && (await page.locator(".day.other").textContent()).includes("Move out"), "today view shows the other countdown's tasks");

  // Menu: export downloads a backup file
  await page.click("#menuBtn");
  check(await page.locator("#menuSheet.on").isVisible(), "menu sheet opens");
  const dlPromise = page.waitForEvent("download");
  await page.click("#mexport");
  check((await dlPromise).suggestedFilename().startsWith("unstuck-backup-"), "export downloads a backup file");
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
  check((await page.locator("#plansel option").allTextContents()).some(t => t.includes("Issac list")), "?import= loads a hosted list");
  check(!page.url().includes("import="), "?import= cleans itself out of the URL");

  // Offline: shell served from SW cache
  await ctx.setOffline(true);
  await page.reload();
  check((await page.textContent("#big")).trim() !== "", "app loads offline from service worker");
  await ctx.setOffline(false);

  // Sync button appears when config has keys (no network call is made until sign-in)
  await page.addInitScript(() => { window.addEventListener("DOMContentLoaded", () => {}); });
  await page.route("**/config.js", r => r.fulfill({ contentType: "application/javascript", body: 'window.UNSTUCK_CONFIG={supabaseUrl:"https://example.supabase.co",supabaseAnonKey:"anon"};' }));
  await page.evaluate(async () => { const rs = await navigator.serviceWorker.getRegistrations(); for (const r of rs) await r.unregister(); const ks = await caches.keys(); for (const k of ks) await caches.delete(k); });
  await page.reload({ waitUntil: "networkidle" });
  check(await page.locator("#syncBtn").isVisible(), "sync button shows when config has keys");
  await page.click("#syncBtn"); check(await page.locator("#syncSheet.on").isVisible(), "sync sheet opens with email form");

  check(errors.length === 0, "no console/page errors" + (errors.length ? " → " + errors.join(" | ") : ""));
  await page.screenshot({ path: path.join(root, "..", "unstuck-screenshot.png") });
  await browser.close();
} finally { server.kill(); }
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
