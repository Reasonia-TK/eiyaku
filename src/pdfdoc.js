// PDFの読み込みとテキスト抽出(pdf.js)
// 抽出結果: pages[{ num, width, height, crop, blocks[] }]
// block: { id, page, idx, x, y, w, h, size, text, skip }  座標はスケール1・左上原点

const CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38";
let pdfjsLib = null;

async function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${CDN}/build/pdf.worker.min.mjs`;
  }
  return pdfjsLib;
}

export async function loadPdf(bytes) {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({
    data: bytes,
    cMapUrl: `${CDN}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${CDN}/standard_fonts/`,
    useSystemFonts: true,
  });
  return await task.promise;
}

export async function getMeta(pdf, fallbackTitle) {
  let title = "";
  try {
    const meta = await pdf.getMetadata();
    title = (meta?.info?.Title || "").trim();
  } catch { /* noop */ }
  return title || fallbackTitle || "無題のPDF";
}

// ---------- テキスト抽出 ----------

function rawItems(textContent, viewport) {
  const items = [];
  const seen = new Set();
  for (const it of textContent.items) {
    if (!it.str || !it.str.trim()) continue;
    const tr = it.transform;
    const size = Math.hypot(tr[2], tr[3]) || it.height || 10;
    if (size < 4.5) continue;
    const [x, yBase] = viewport.convertToViewportPoint(tr[4], tr[5]);
    const w = it.width || 0;
    if (w <= 0 && it.str.trim().length === 0) continue;
    // 完全重複(太字演出などの二重描画)を除去
    const key = `${Math.round(x * 2)},${Math.round(yBase * 2)},${it.str}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      x,
      yBase,
      w: Math.max(w, size * 0.3 * it.str.length * 0.5),
      top: yBase - size * 0.88,
      bottom: yBase + size * 0.22,
      size,
      str: it.str,
    });
  }
  return items;
}

function buildLines(items) {
  const sorted = [...items].sort((a, b) => a.yBase - b.yBase || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    // 同じベースライン近傍でも、横方向に大きく離れていたら別の行(段違い)
    const tol = Math.max(6, (last?.size || 10) * 1.2);
    const yClose = last && Math.abs(it.yBase - last.y) <= Math.max(2.2, last.size * 0.4);
    const xClose = last && it.x <= last.right + tol && it.x >= last.minX - tol;
    if (last && yClose && xClose) {
      last.items.push(it);
      last.size = Math.max(last.size, it.size);
      last.right = Math.max(last.right, it.x + it.w);
      last.minX = Math.min(last.minX, it.x);
    } else {
      lines.push({ y: it.yBase, size: it.size, right: it.x + it.w, minX: it.x, items: [it] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let text = "";
    let prev = null;
    for (const it of line.items) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        const needSpace = gap > prev.size * 0.18 && !/\s$/.test(text) && !/^\s/.test(it.str);
        if (needSpace) text += " ";
      }
      text += it.str;
      prev = it;
    }
    line.text = text.replace(/\s+/g, " ").trim();
    line.x = Math.min(...line.items.map((i) => i.x));
    line.right = Math.max(...line.items.map((i) => i.x + i.w));
    line.top = Math.min(...line.items.map((i) => i.top));
    line.bottom = Math.max(...line.items.map((i) => i.bottom));
    line.w = line.right - line.x;
  }
  return lines.filter((l) => l.text.length > 0);
}

// 左端のクラスタリングで段組みを判定する
function clusterColumns(lines, pageWidth) {
  const xs = [...new Set(lines.map((l) => Math.round(l.x)))].sort((a, b) => a - b);
  const clusters = [];
  const tol = Math.max(14, pageWidth * 0.025);
  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.max <= tol) {
      last.max = x;
      last.sum += x;
      last.n++;
    } else {
      clusters.push({ min: x, max: x, sum: x, n: 1 });
    }
  }
  for (const c of clusters) c.center = c.sum / c.n;
  // 行数の少ないクラスタは最寄りの大きなクラスタへ寄せる(字下げ・中央揃え対策)
  const big = clusters.filter((c) => c.n >= 3);
  if (big.length > 0) {
    for (const c of clusters) {
      if (c.n >= 3) continue;
      let best = big[0];
      for (const b of big) if (Math.abs(b.center - c.center) < Math.abs(best.center - c.center)) best = b;
      if (Math.abs(best.center - c.center) < pageWidth * 0.2) c.mergedInto = best;
    }
  }
  for (const line of lines) {
    let best = null;
    let bestD = Infinity;
    for (const c of clusters) {
      const d = Math.abs(c.center - line.x);
      if (d < bestD) { bestD = d; best = c; }
    }
    line.col = best.mergedInto || best;
  }
  const used = [...new Set(lines.map((l) => l.col))];
  used.sort((a, b) => a.center - b.center);
  return used.map((c) => lines.filter((l) => l.col === c).sort((a, b) => a.top - b.top || a.x - b.x));
}

function mergeBlocks(lines, pageIdx, startIdx) {
  const blocks = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const text = cur.parts.join(" ").replace(/\s+/g, " ").trim();
    if (text.replace(/[\s\d\p{P}\p{S}]/gu, "").length >= 1) {
      blocks.push({
        page: pageIdx,
        x: cur.x - 0.6,
        y: cur.top - 0.6,
        w: cur.right - cur.x + 1.2,
        h: cur.bottom - cur.top + 1.2,
        size: cur.size,
        text,
        skip: !/[A-Za-z]/.test(text),
      });
    }
    cur = null;
  };
  for (const line of lines) {
    if (cur) {
      const gap = line.top - cur.bottom;
      const ratio = line.size / cur.size;
      const overlap = Math.min(line.right, cur.right) - Math.max(line.x, cur.x);
      const minW = Math.min(line.w, cur.right - cur.x);
      const sameLine = Math.abs(line.y - cur.lastY) <= cur.size * 0.4;
      const sameCol = overlap > 0.2 * minW || Math.abs(line.x - cur.x) < cur.size * 2;
      const notTooLong = cur.parts.join(" ").length < 1200;
      if (notTooLong && gap <= cur.size * 0.45 && gap >= -cur.size * 1.2 && ratio >= 0.7 && ratio <= 1.4 && (sameLine || sameCol)) {
        // ハイフン改行の結合
        if (/-$/.test(cur.lastText) && /^[a-z]/.test(line.text)) {
          cur.parts[cur.parts.length - 1] = cur.lastText.slice(0, -1) + line.text;
        } else {
          cur.parts.push(line.text);
        }
        cur.lastText = line.text;
        cur.x = Math.min(cur.x, line.x);
        cur.right = Math.max(cur.right, line.right);
        cur.top = Math.min(cur.top, line.top);
        cur.bottom = Math.max(cur.bottom, line.bottom);
        cur.size = Math.max(cur.size, line.size);
        cur.lastY = line.y;
        continue;
      }
      flush();
    }
    cur = {
      x: line.x, right: line.right, top: line.top, bottom: line.bottom,
      size: line.size, parts: [line.text], lastText: line.text, lastY: line.y,
    };
  }
  flush();
  blocks.forEach((b, i) => {
    b.idx = startIdx + i;
    b.id = `${pageIdx}:${b.idx}`;
  });
  return blocks;
}

export async function extractPages(pdf) {
  const pages = [];
  for (let p = 0; p < pdf.numPages; p++) {
    const page = await pdf.getPage(p + 1);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const lines = buildLines(rawItems(tc, viewport));
    const columns = clusterColumns(lines, viewport.width);
    let blocks = [];
    for (const colLines of columns) {
      blocks = blocks.concat(mergeBlocks(colLines, p, blocks.length));
    }
    blocks.sort((a, b) => a.idx - b.idx);
    // 余白トリム用の領域
    let crop = { x: 0, y: 0, w: viewport.width, h: viewport.height };
    if (blocks.length) {
      const m = 14;
      const x0 = Math.max(0, Math.min(...blocks.map((b) => b.x)) - m);
      const y0 = Math.max(0, Math.min(...blocks.map((b) => b.y)) - m);
      const x1 = Math.min(viewport.width, Math.max(...blocks.map((b) => b.x + b.w)) + m);
      const y1 = Math.min(viewport.height, Math.max(...blocks.map((b) => b.y + b.h)) + m);
      if (x1 - x0 > 50 && y1 - y0 > 50) crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    pages.push({ num: p + 1, width: viewport.width, height: viewport.height, crop, blocks });
    page.cleanup();
  }
  return pages;
}

// ---------- arXiv / URL 取得 ----------

export function normalizePdfUrl(input) {
  const t = input.trim();
  if (!t) return null;
  const m = t.match(/arxiv\.org\/(?:abs|pdf)\/([\w.]+(?:v\d+)?)/i);
  if (m) return { url: `https://arxiv.org/pdf/${m[1]}`, name: `arxiv-${m[1]}.pdf`, arxiv: m[1] };
  if (/^https?:\/\/\S+\.pdf(\?\S*)?$/i.test(t)) {
    return { url: t, name: t.split("/").pop().split("?")[0] || "document.pdf" };
  }
  if (/^https?:\/\/\S+$/i.test(t)) return { url: t, name: "document.pdf" };
  return null;
}

export async function fetchPdf(url, onStatus) {
  const attempts = [
    url,
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      if (i > 0) onStatus?.(`取得中…(迂回 ${i})`);
      const res = await fetch(attempts[i], { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 5 || String.fromCharCode(...buf.slice(0, 5)) !== "%PDF-") {
        throw new Error("PDFではない応答が返されました");
      }
      return buf;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`PDFを取得できませんでした: ${lastErr?.message || lastErr}\nURLを確認するか、PDFファイルを直接ドロップしてください。`);
}
