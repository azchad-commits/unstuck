// Re-capture the three screenshots embedded in landing.html from the live app code.
// Run after UI changes so the marketing page shows the real thing: node tools/update-landing-shots.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const landing = path.join(root, "landing.html");
const server = spawn("python3", ["-m", "http.server", "8767", "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await new Promise(r => setTimeout(r, 800));
const shots = [];
try {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const shot = async () => shots.push(await page.screenshot({ type: "jpeg", quality: 80 }));

  await page.goto("http://127.0.0.1:8767/", { waitUntil: "networkidle" });
  await page.click("#first");
  await page.fill("#pname", "Move out");
  await page.click("#pcreate");
  const add = async (t, m) => { await page.fill(".add input", t); await page.selectOption(".add select", String(m)); await page.click(".add button"); };
  await add("Pack kitchen", 45); await add("Call movers about Saturday", 10); await add("Label boxes", 15); await add("Cancel internet", 5);
  await page.locator(".task").nth(1).locator(".chk").click();
  await shot(); // 1: today view — hero with Start 45 min + Just the first 5

  // 2: finished timer (green "You're allowed to stop") — inject an ended, already-credited run
  await page.evaluate(() => {
    localStorage.setItem("unstuck-timer", JSON.stringify({ end: Date.now() - 1000, start: Date.now() - 2701000, plan: 2700, name: "Pack kitchen", credited: true }));
  });
  await page.reload({ waitUntil: "networkidle" });
  await shot();
  await page.click("#tstop");

  // 3: the I'm stuck sheet, now targeting the starred task
  await page.click("#stuckBtn");
  await page.waitForTimeout(250);
  await shot();
  await browser.close();
} finally { server.kill(); }

let html = fs.readFileSync(landing, "utf8");
let i = 0;
html = html.replace(/src="data:image\/jpeg;base64,[^"]+"/g, m => i < shots.length ? `src="data:image/jpeg;base64,${shots[i++].toString("base64")}"` : m);
if (i !== 3) { console.error(`expected to replace 3 screenshots, replaced ${i} — landing.html left unchanged`); process.exit(1); }
html = html.replace("a 'One thing today' card with a Start 45 min button", "a 'One thing today' card with Start 45 min and Just the first 5 buttons");
html = html.replace("Three steps and a Start 10 minutes button", "Three steps and a Start 10 minutes on: Pack kitchen button");
fs.writeFileSync(landing, html);
console.log(`replaced ${i} screenshots (${shots.map(s => Math.round(s.length / 1024) + "KB").join(", ")})`);
