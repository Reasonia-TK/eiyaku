// PDF書き出しの検証: node tools/test_export.mjs
// 疑似訳文を埋め込み、フォント埋め込み・折り返し・縮小フィットが動くか確認する
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPages } from "../src/pdfdoc.js";
import { buildTranslatedPdf } from "../src/export.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const bytes = new Uint8Array(readFileSync(join(root, "data", "demo.pdf")));
const pdf = await pdfjs.getDocument({ data: bytes.slice(0), useSystemFonts: true, isEvalSupported: false }).promise;
const pages = await extractPages(pdf);

// 疑似訳文(原文より長めにしておき、縮小フィットを強制する)
const translations = {};
for (const p of pages) {
  for (const b of p.blocks) {
    if (b.skip) continue;
    const base = "これは検証用の日本語訳文です。ロボットグリッパは、脆弱な物体を損傷しないように把持力を適応的に制御する必要があります。";
    translations[b.id] = base.repeat(Math.max(1, Math.ceil(b.text.length / 60)));
  }
}

const out = await buildTranslatedPdf({
  bytes: bytes.slice(0),
  pages,
  translations,
  title: "demo",
  onStatus: (t) => console.log("status:", t),
});
writeFileSync(join(root, "tools", "out-test.pdf"), out);
console.log(`OK: out-test.pdf ${out.length} bytes`);

// 書き出したPDFを再読み込みしてテキストを検証
const pdf2 = await pdfjs.getDocument({ data: out.slice(0), useSystemFonts: true, isEvalSupported: false }).promise;
const page1 = await pdf2.getPage(1);
const tc = await page1.getTextContent();
const text = tc.items.map((i) => i.str).join("");
console.log("extracted ja sample:", text.slice(0, 120));
if (!text.includes("検証用の日本語訳文")) throw new Error("日本語テキストが書き出されていません");
console.log("PASS");
