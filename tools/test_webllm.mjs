// WebGPU/WebLLM 経路の検証: node tools/test_webllm.mjs
// SwiftShader で WebGPU アダプタが使える場合、最小モデルで1ブロック翻訳できるか確認する
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const candidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const executablePath = candidates.find((p) => existsSync(p));
const browser = await puppeteer.launch({
  executablePath,
  headless: "new",
  args: [
    "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-swiftshader", "--use-angle=swiftshader",
    "--window-size=1400,900",
  ],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`[console] ${m.text()}`); });

await page.goto("http://localhost:8080/", { waitUntil: "networkidle2", timeout: 60000 });
const gpu = await page.evaluate(async () => {
  if (!navigator.gpu) return "no-navigator.gpu";
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return "no-adapter";
    const device = await adapter.requestDevice();
    return `ok: ${adapter.info?.vendor || "?"} / ${adapter.info?.architecture || "?"}`;
  } catch (e) {
    return `error: ${e.message}`;
  }
});
console.log("WebGPU:", gpu);
if (!gpu.startsWith("ok")) {
  console.log("SKIP: この環境ではWebGPUが使えないため、ローカル翻訳の実機検証はスキップします(API経路は検証済み)");
  await browser.close();
  process.exit(0);
}

// 最小モデルでデモを開き、最初の1ブロックが訳されることを確認
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("eiyaku.settings", JSON.stringify({
    engine: { mode: "local", model: "Llama-3.2-1B-Instruct-q4f16_1-MLC" },
  }));
});
await page.goto("http://localhost:8080/?demo=1", { waitUntil: "networkidle2", timeout: 90000 });
console.log("モデルのダウンロードと翻訳を待機中…(最大8分)");
try {
  await page.waitForFunction(() => document.querySelectorAll("#dst .tr.done").length >= 1, { timeout: 480000, polling: 2000 });
  const info = await page.evaluate(() => ({
    status: document.getElementById("status").textContent,
    done: document.querySelectorAll("#dst .tr.done").length,
    sample: document.querySelector("#dst .tr.done")?.textContent.slice(0, 80),
  }));
  console.log("local translation:", JSON.stringify(info, null, 2));
  await page.screenshot({ path: "shot-local.png" });
  console.log("WEBLLM PASS");
} catch (e) {
  const st = await page.evaluate(() => ({
    status: document.getElementById("status").textContent,
    alert: document.getElementById("alertText").textContent,
  }));
  console.log("timeout/state:", JSON.stringify(st), "errors:", errors);
  throw e;
} finally {
  await browser.close();
}
