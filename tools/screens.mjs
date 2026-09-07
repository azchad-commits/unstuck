// Capture the app's key states at phone size into one contact sheet for design review.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "..", "screens"); fs.mkdirSync(out, { recursive: true });
const server = spawn("python3", ["-m", "http.server", "8766", "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await new Promise(r => setTimeout(r, 800));
try {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const shot = n => page.screenshot({ path: path.join(out, n + ".png") });
  await page.goto("http://127.0.0.1:8766/", { waitUntil: "networkidle" });
  await shot("1-empty");
  await page.click("#first"); await shot("2-newplan");
  await page.fill("#pname", "Move out"); await page.click("#pcreate");
  const add = async (t, m) => { await page.fill(".add input", t); await page.selectOption(".add select", String(m)); await page.click(".add button"); };
  await add("Pack kitchen", 45); await add("Call movers about Saturday", 10); await add("Label boxes", 15); await add("Cancel internet", 5);
  await page.locator(".task").nth(1).locator(".chk").click();
  await shot("3-today");
  await page.locator(".task").nth(0).locator(".min").click(); await page.waitForTimeout(300); await shot("4-timer");
  await page.evaluate(() => { localStorage.setItem("unstuck-timer", JSON.stringify({ end: Date.now() - 1000, name: "Pack kitchen" })); });
  await page.reload({ waitUntil: "networkidle" }); await shot("5-timer-done");
  await page.click("#tstop");
  await page.click('.views button[data-v="week"]'); await shot("6-week");
  await page.click('.views button[data-v="month"]'); await shot("7-month");
  await page.click('.views button[data-v="day"]'); await page.click("#stuckBtn"); await shot("8-stuck");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { const d = JSON.parse(localStorage.getItem("unstuck-v1")); d.plans[0].end = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10); localStorage.setItem("unstuck-v1", JSON.stringify(d)); });
  await page.reload({ waitUntil: "networkidle" }); await shot("9-urgent");
  await browser.close();
} finally { server.kill(); }
console.log("done", out);
