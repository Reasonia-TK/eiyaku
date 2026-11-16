// 抽出ロジックの検証: node tools/test_extract.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPages } from "../src/pdfdoc.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const bytes = new Uint8Array(readFileSync(join(root, "data", "demo.pdf")));
const pdf = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise;
const pages = await extractPages(pdf);

let total = 0;
for (const p of pages) {
  console.log(`\n=== page ${p.num} (${p.width.toFixed(0)}x${p.height.toFixed(0)}) crop=${JSON.stringify(p.crop)} blocks=${p.blocks.length} ===`);
  for (const b of p.blocks) {
    total++;
    console.log(`[${b.id}] x=${b.x.toFixed(0)} y=${b.y.toFixed(0)} w=${b.w.toFixed(0)} h=${b.h.toFixed(0)} size=${b.size.toFixed(1)} skip=${b.skip}`);
    console.log(`    ${b.text.slice(0, 110)}${b.text.length > 110 ? "…" : ""}`);
  }
}
console.log(`\nTOTAL BLOCKS: ${total}`);
