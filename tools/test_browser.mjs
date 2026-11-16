// ブラウザ実機スモークテスト: node tools/test_browser.mjs
// (ローカルサーバー http://localhost:8080 が起動していること)
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const candidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error("Chrome/Edge が見つかりません");

const browser = await puppeteer.launch({
  executablePath,
  headless: "new",
  args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1400,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on("console", (m) => {
  if (["error", "warning"].includes(m.type())) errors.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto("http://localhost:8080/?demo=1&notranslate=1", { waitUntil: "networkidle2", timeout: 90000 });
await page.waitForSelector("body.hasdoc", { timeout: 60000 });
await page.waitForFunction(() => [...document.querySelectorAll("#src canvas")].some((c) => c.width > 100), { timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));

const info = await page.evaluate(() => ({
  title: document.getElementById("title").textContent,
  status: document.getElementById("status").textContent,
  srcPages: document.querySelectorAll("#src .page").length,
  dstPages: document.querySelectorAll("#dst .page").length,
  trs: document.querySelectorAll("#dst .tr").length,
  canvases: [...document.querySelectorAll("#src canvas")].map((c) => c.width),
  dropHidden: getComputedStyle(document.getElementById("drop")).display === "none",
}));
console.log(JSON.stringify(info, null, 2));

// 原文クリック → 辞書パネル
const box = await page.evaluate(() => {
  const el = document.querySelector("#src .page");
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height * 0.2 };
});
await page.mouse.click(box.x, box.y);
await new Promise((r) => setTimeout(r, 300));
const dictText = await page.evaluate(() => document.getElementById("dictPanel").textContent);
console.log("dict panel:", dictText.slice(0, 100));

// 設定ダイアログ
await page.click("#settingsBtn");
await new Promise((r) => setTimeout(r, 200));
const settingsOpen = await page.evaluate(() => document.getElementById("settings").open);
console.log("settings open:", settingsOpen);
await page.screenshot({ path: "shot-settings.png" });
await page.evaluate(() => document.getElementById("settings").close());

// 用語集ダイアログ
await page.click("#glossaryBtn");
await new Promise((r) => setTimeout(r, 200));
const glossaryOpen = await page.evaluate(() => document.getElementById("glossaryDlg").open);
console.log("glossary open:", glossaryOpen);
await page.evaluate(() => document.getElementById("glossaryDlg").close());

await page.screenshot({ path: "shot-view.png" });
await browser.close();

console.log("console errors/warnings:", errors.length ? errors : "none");
if (info.srcPages !== 2 || info.dstPages !== 2) throw new Error("ページ数が想定と違います");
if (info.trs < 20) throw new Error("訳文オーバーレイが不足しています");
if (!info.canvases.some((w) => w > 100)) throw new Error("キャンバスが描画されていません");
if (!dictText.includes("ページ")) throw new Error("辞書パネルが反応しません");
if (!settingsOpen || !glossaryOpen) throw new Error("ダイアログが開きません");
console.log("BROWSER PASS");
