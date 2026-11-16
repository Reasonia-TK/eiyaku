// 翻訳パイプラインの実機テスト: node tools/test_translate.mjs
// モックAPIサーバーを立て、API方式で全ブロック翻訳→キャッシュ復元→検索 を検証する
import http from "node:http";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

let apiCalls = 0;
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    apiCalls++;
    const data = JSON.parse(body);
    const user = data.messages.find((m) => m.role === "user").content;
    const en = user.split("翻訳してください:\n").pop() || "";
    const ja = "これはテスト用の日本語訳文です。グリッパの把持力を適応的に制御します。".repeat(Math.max(1, Math.ceil(en.length / 45)));
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
  localStorage.removeItem("eiyaku.glossary");
});

await page.goto("http://localhost:8080/?demo=1", { waitUntil: "networkidle2", timeout: 90000 });
await page.waitForFunction(() => document.querySelectorAll("#dst .tr.done").length >= 25, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 1000));

const info = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  done: document.querySelectorAll("#dst .tr.done").length,
  sample: document.querySelector("#dst .tr.done")?.textContent.slice(0, 40),
  sampleFontSize: document.querySelector("#dst .tr.done")?.style.fontSize,
}));
console.log("translated:", JSON.stringify(info, null, 2), "apiCalls:", apiCalls);
await page.screenshot({ path: "shot-translated.png" });

// 検索
await page.type("#q", "gripper");
await new Promise((r) => setTimeout(r, 600));
const searchInfo = await page.evaluate(() => ({
  count: document.getElementById("qCount").textContent,
  items: document.querySelectorAll("#qList .qitem").length,
  hits: document.querySelectorAll(".hl.hit").length,
}));
console.log("search:", JSON.stringify(searchInfo));
await page.evaluate(() => document.getElementById("qClear").click());

// リロード → キャッシュから復元(API呼び出しが増えないこと)
const callsBefore = apiCalls;
await page.reload({ waitUntil: "networkidle2" });
await page.waitForSelector("body.hasdoc", { timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll("#dst .tr.done").length >= 25, { timeout: 30000 });
const reloadInfo = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  done: document.querySelectorAll("#dst .tr.done").length,
}));
console.log("reload:", JSON.stringify(reloadInfo), "newApiCalls:", apiCalls - callsBefore);

await browser.close();
server.close();

if (info.done < 25) throw new Error("全ブロックが翻訳されていません");
if (!info.sample.includes("テスト用の日本語訳文")) throw new Error("訳文が反映されていません");
if (!searchInfo.count.includes("件") || searchInfo.items === 0) throw new Error("検索が機能しません");
if (apiCalls - callsBefore !== 0) throw new Error("キャッシュが効いていません(再翻訳された)");
if (!reloadInfo.status.includes("キャッシュ")) throw new Error("キャッシュ復元の状態表示がおかしい");
if (errors.length) { console.error(errors); throw new Error("ページエラーがあります"); }
console.log("TRANSLATE PIPELINE PASS");
