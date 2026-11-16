// 訳文側をPDFとして保存(pdf-lib + Noto Sans JP)
// 元PDFの上に白抜き+日本語テキストを描画する

import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const FONT_URL = "https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf";
let fontBytesCache = null;

const NO_START = new Set("、。，．）」』】〕〉》」’”)]｝,.;:!?・ー");
const NO_END = new Set("（「『【〔〈《‘“([{｛");

async function getFontBytes() {
  if (fontBytesCache) return fontBytesCache;
  const res = await fetch(FONT_URL);
  if (!res.ok) throw new Error(`日本語フォントを取得できませんでした (HTTP ${res.status})`);
  fontBytesCache = new Uint8Array(await res.arrayBuffer());
  return fontBytesCache;
}

// 禁則処理付きの折り返し。単位は「英単語」または「1文字」
function tokenize(text) {
  const units = [];
  const re = /[A-Za-z0-9]+(?:[-'./][A-Za-z0-9]+)*|[\s\S]/g;
  let m;
  while ((m = re.exec(text))) units.push(m[0]);
  return units;
}

function wrap(text, font, fs, maxW) {
  const lines = [];
  let line = "";
  let lineW = 0;
  const widthOf = (s) => {
    try { return font.widthOfTextAtSize(s, fs); } catch { return s.length * fs * 0.5; }
  };
  for (const u of tokenize(text)) {
    if (u === "\n") { lines.push(line); line = ""; lineW = 0; continue; }
    const uw = widthOf(u);
    if (lineW + uw > maxW && line) {
      if (NO_START.has(u)) {
        line += u; // 行頭禁則: 少しはみ出しても行末に付ける
        lineW += uw;
        continue;
      }
      let carry = "";
      if (NO_END.has(line[line.length - 1])) {
        carry = line[line.length - 1];
        line = line.slice(0, -1);
      }
      lines.push(line);
      line = carry + u;
      lineW = widthOf(line);
    } else {
      line += u;
      lineW += uw;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function sanitize(s) {
  // 字体に無い可能性が高い補助面の文字などを除去
  return s.replace(/[\u{10000}-\u{10FFFF}\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "");
}

export async function buildTranslatedPdf({ bytes, pages, translations, title, onStatus }) {
  onStatus?.("PDFを準備中…");
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  pdfDoc.registerFontkit(fontkit);
  onStatus?.("日本語フォントを読み込み中…(初回のみ約4.4MB)");
  const fontBytes = await getFontBytes();
  const font = await pdfDoc.embedFont(fontBytes, { subset: false });
  const ink = rgb(0.086, 0.149, 0.227);

  const n = pdfDoc.getPageCount();
  for (let i = 0; i < n && i < pages.length; i++) {
    const page = pdfDoc.getPage(i);
    const { width, height } = page.getSize();
    const rotated = page.getRotation().angle % 360 !== 0;
    if (rotated) continue; // 回転ページはv1では訳文描画をスキップ
    for (const b of pages[i].blocks) {
      const ja = translations[b.id];
      if (ja == null || b.skip || ja === b.text) continue;
      const text = sanitize(ja);
      if (!text.trim()) continue;
      const x = b.x - 1;
      const yTop = b.y - 1;
      const w = b.w + 2;
      const h = b.h + 2;
      page.drawRectangle({ x, y: height - yTop - h, width: w, height: h, color: rgb(1, 1, 1) });
      let fs = Math.min(b.size, 24);
      let lines = wrap(text, font, fs, w - 1);
      let lh = fs * 1.3;
      let guard = 0;
      while (lines.length * lh > h && fs > 5 && guard++ < 60) {
        fs -= 0.5;
        lh = fs * 1.3;
        lines = wrap(text, font, fs, w - 1);
      }
      for (let li = 0; li < lines.length; li++) {
        const baselineTop = yTop + fs * 0.88 + li * lh;
        try {
          page.drawText(lines[li], { x: x + 0.5, y: height - baselineTop, size: fs, font, color: ink });
        } catch {
          try {
            page.drawText(sanitize(lines[li].replace(/[^\u0020-\u007E\u3000-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]/g, "")), {
              x: x + 0.5, y: height - baselineTop, size: fs, font, color: ink,
            });
          } catch { /* 描画不能文字は諦める */ }
        }
      }
    }
    if (i % 5 === 4) onStatus?.(`PDF生成中… ${i + 1}/${n}ページ`);
  }

  pdfDoc.setTitle(`${title} (日本語訳)`);
  pdfDoc.setProducer("eiyaku");
  onStatus?.("PDFを書き出し中…");
  return await pdfDoc.save();
}

export function downloadPdf(bytes, title) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}-ja.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
