// UI機能の実機テスト: node tools/test_ui.mjs
// ダークテーマ / 左右入れ替え / パネル位置 / 用語集→訳し直し / 保存データ管理 / web-llm import
import http from "node:http";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

let apiCalls = 0;
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    apiCalls++;
    const data = JSON.parse(body);
    const user = data.messages.find((m) => m.role === "user").content;
    const hasGlossary = user.includes("グリッパ: グリッパ") || user.includes("gripper: グリッパ");
    const ja = (hasGlossary ? "グリッパの把持力を制御します。" : "テスト訳文です。") + "これは日本語の文章です。".repeat(3);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: ja } }] }));
  });
});
await new Promise((r) => server.listen(8099, r));

const candidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const executablePath = candidates.find((p) => existsSync(p));
const browser = await puppeteer.launch({
  executablePath,
  headless: "new",
  args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1400,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`[console] ${m.text()}`); });

await page.evaluateOnNewDocument(() => {
  localStorage.setItem("eiyaku.settings", JSON.stringify({
    engine: { mode: "api", endpoint: "http://localhost:8099/v1", apiModel: "mock", apiKey: "test" },
  }));
});
await page.goto("http://localhost:8080/?demo=1", { waitUntil: "networkidle2", timeout: 90000 });
await page.waitForFunction(() => document.querySelectorAll("#dst .tr.done").length >= 25, { timeout: 120000 });

// web-llm モジュールがブラウザで読み込めるか(エンジン生成はしない)
const webllmImport = await page.evaluate(async () => {
  try {
    const m = await import("web-llm");
    return typeof m.CreateMLCEngine;
  } catch (e) {
    return `error: ${e.message}`;
  }
});
console.log("web-llm import:", webllmImport);

// ダークテーマ + 左右入れ替え + パネル上配置
await page.click("#settingsBtn");
await page.select("#theme", "dark");
await page.evaluate(() => {
  const set = (id, v) => { const el = document.getElementById(id); el.checked = v; el.dispatchEvent(new Event("change")); };
  set("swapPanes", true);
});
await page.select("#panelPos", "top-left");
await page.evaluate(() => document.getElementById("settings").close());
await new Promise((r) => setTimeout(r, 500));
const layout = await page.evaluate(() => {
  const footer = document.querySelector("footer").getBoundingClientRect();
  const main = document.getElementById("main").getBoundingClientRect();
  const src = document.getElementById("src").getBoundingClientRect();
  const dst = document.getElementById("dst").getBoundingClientRect();
  return {
    theme: document.documentElement.dataset.theme,
    swap: document.body.classList.contains("swap"),
    panelTop: footer.top < main.top,
    srcRightOfDst: src.left > dst.left,
  };
});
console.log("layout:", JSON.stringify(layout));
await page.screenshot({ path: "shot-dark.png" });

// 用語集を追加して保存 → 訳し直しが走る
const callsBefore = apiCalls;
await page.click("#glossaryBtn");
await page.click("#gAdd");
await page.evaluate(() => {
  const rows = document.querySelectorAll("#gtable tbody tr");
  const last = rows[rows.length - 1];
  last.cells[0].firstChild.value = "gripper";
  last.cells[1].firstChild.value = "グリッパ";
});
await page.click("#gSave");
await page.waitForFunction(() => document.getElementById("status").textContent.includes("翻訳完了"), { timeout: 120000 });
const glossaryState = await page.evaluate(() => ({
  stored: JSON.parse(localStorage.getItem("eiyaku.glossary") || "[]"),
  sample: document.querySelector("#dst .tr.done")?.textContent.slice(0, 30),
}));
console.log("glossary:", JSON.stringify(glossaryState), "retranslate calls:", apiCalls - callsBefore);

// 保存データダイアログ
await page.click("#dataBtn");
await new Promise((r) => setTimeout(r, 500));
const dataState = await page.evaluate(() => ({
  rows: document.querySelectorAll("#storeList tbody tr").length,
  total: document.getElementById("storeTotal").textContent,
}));
console.log("data dialog:", JSON.stringify(dataState));
await page.click("#pickAll");
await page.click("#clearPicked");
await new Promise((r) => setTimeout(r, 500));
const afterClear = await page.evaluate(() => document.querySelectorAll("#storeList tbody tr").length);
console.log("rows after clear:", afterClear);
await page.evaluate(() => document.getElementById("dataDlg").close());

await browser.close();
server.close();

if (webllmImport !== "function") throw new Error("web-llm の読み込みに失敗");
if (layout.theme !== "dark" || !layout.swap || !layout.panelTop || !layout.srcRightOfDst) throw new Error("レイアウト設定が反映されていません");
if (apiCalls - callsBefore < 25) throw new Error("用語集保存後の訳し直しが実行されていません");
if (!glossaryState.stored.some((g) => g.en === "gripper" && g.ja === "グリッパ")) throw new Error("用語集が保存されていません");
if (!glossaryState.sample.includes("グリッパ")) throw new Error("用語集の訳語が翻訳プロンプトに渡っていません");
if (dataState.rows !== 1 || afterClear !== 0) throw new Error("保存データ管理が機能しません");
if (errors.length) { console.error(errors); throw new Error("ページエラーがあります"); }
console.log("UI PASS");
