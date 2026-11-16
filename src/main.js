// eiyaku — PDF対訳リーダー メイン

import {
  loadSettings, saveSettings, DEFAULT_SETTINGS,
  loadGlossary, saveGlossary, glossaryText, parseGlossaryText,
  hashBytes, loadDocRecord, saveDocRecord, listDocRecords, deleteDocRecords,
  estimateSize, fmtSize, fmtDate,
} from "./store.js";
import { loadPdf, getMeta, extractPages, normalizePdfUrl, fetchPdf } from "./pdfdoc.js";
import { Translator } from "./translate.js";
import { View } from "./view.js";
import { Panels } from "./panels.js";
import { Search } from "./search.js";

const $ = (id) => document.getElementById(id);

const S = {
  settings: loadSettings(),
  glossary: loadGlossary(),
  pdf: null,
  pages: [],
  blocks: [],
  blockById: new Map(),
  translations: {},
  docId: null,
  docTitle: "",
  docBytes: null,
  record: null,
  loading: false,
  runId: 0,
  saveTimer: 0,
};

// ---------- 状態表示 ----------

function setStatus(text, opts = {}) {
  const el = $("status");
  el.textContent = text || "";
  if (opts.stop) {
    const b = document.createElement("button");
    b.className = "stop";
    b.textContent = "停止";
    b.onclick = () => translator?.stop();
    el.appendChild(b);
  }
}

function setProgress(ratio, indeterminate = false) {
  const bar = $("progress");
  if (ratio == null && !indeterminate) {
    bar.hidden = true;
    bar.classList.remove("indeterminate");
    return;
  }
  bar.hidden = false;
  bar.classList.toggle("indeterminate", indeterminate);
  if (!indeterminate) bar.firstElementChild.style.width = `${Math.round((ratio || 0) * 100)}%`;
}

function showAlert(text) {
  $("alertText").textContent = text;
  $("alert").hidden = false;
}
$("alertClose").onclick = () => ($("alert").hidden = true);

function showDropError(text) {
  const el = $("dropError");
  el.textContent = text;
  el.hidden = !text;
}

// ---------- 永続化 ----------

function markDirty() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(flushSave, 1500);
}

async function flushSave() {
  if (!S.record) return;
  S.record.translations = S.translations;
  S.record.lastOpened = Date.now();
  try {
    await saveDocRecord(S.record);
  } catch (e) {
    console.warn("cache save failed", e);
  }
}

window.addEventListener("beforeunload", () => { flushSave(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(); });

// ---------- コンポーネント ----------

const view = new View({
  srcEl: $("src"),
  dstEl: $("dst"),
  settings: S.settings,
  onBlockClick: (block, word, side) => {
    panels.setCurrent(block.id);
    panels.show(block, word, side);
  },
  onVisiblePages: () => { /* 翻訳優先度は run 中に動的に参照 */ },
});

const panels = new Panels({
  dictEl: $("dictPanel"),
  infoEl: $("infoPanel"),
  settings: S.settings,
  getTranslation: (id) => S.translations[id] ?? (S.blockById.get(id)?.skip ? S.blockById.get(id).text : null),
  getBlocks: () => S.blocks,
  onJump: (id) => {
    view.scrollToBlock(id);
    view.setActive(id);
    const b = S.blockById.get(id);
    if (b) {
      panels.setCurrent(id);
      panels.show(b, "", "dst");
    }
  },
  onAddGlossary: (word) => openGlossary(word),
});

const search = new Search({
  input: $("q"),
  countEl: $("qCount"),
  listEl: $("qList"),
  clearBtn: $("qClear"),
  getBlocks: () => S.blocks,
  getTranslation: (id) => S.translations[id] ?? null,
  onJump: (id) => {
    view.scrollToBlock(id);
    view.setActive(id);
  },
  onHits: (ids) => view.setHits(ids),
});

let translator = null;

function makeTranslator(run) {
  const alive = () => run === S.runId;
  return new Translator({
    settings: S.settings,
    glossary: S.glossary,
    onResult: (block, ja) => {
      if (!alive()) return;
      S.translations[block.id] = ja;
      view.setTranslation(block, ja);
      panels.updateTranslation(block.id);
      markDirty();
      if ($("q").value.trim()) search.refresh();
    },
    onProgress: (done, total, finished) => {
      if (!alive()) return;
      if (finished) {
        setProgress(null);
        if (translator?.stopped) setStatus(`停止しました(${done}/${total})`);
        else if (done >= total) setStatus("翻訳完了 · 保存済み");
        flushSave();
        $("translate").disabled = !S.pdf;
        $("saveBtn").disabled = !S.pdf;
      } else {
        setProgress(total ? done / total : 0);
        setStatus(`翻訳中 ${done}/${total}`, { stop: true });
      }
    },
    onStatus: (text, opts = {}) => {
      if (!alive()) return;
      setStatus(text);
      if (opts.progress != null || opts.indeterminate) {
        setProgress(opts.progress ?? 0, !!opts.indeterminate);
      }
    },
    onError: (e) => {
      if (!alive()) return;
      console.error(e);
      setProgress(null);
      setStatus("翻訳エラー");
      showAlert(`翻訳中にエラーが発生しました: ${e.message || e}`);
      flushSave();
    },
  });
}

// ---------- 設定適用 ----------

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  const t = S.settings.theme;
  const dark = t === "dark" || (t === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
darkQuery.addEventListener("change", () => { if (S.settings.theme === "system") applyTheme(); });

function applySettings(rebuild = false) {
  const s = S.settings;
  applyTheme();
  document.documentElement.dataset.ui = s.uiScale;
  const body = document.body;
  body.classList.toggle("swap", s.swapPanes);
  body.classList.toggle("darkpages", s.darkPages);
  body.classList.toggle("nodict", !s.showDict);
  body.classList.toggle("noinfo", !s.showInfo);
  body.classList.toggle("panel-top", s.panelPos.startsWith("top"));
  body.classList.toggle("panel-right", s.panelPos.endsWith("right"));
  body.classList.toggle("folded", !!s.folded);
  const footer = document.querySelector("footer");
  footer.style.height = `${s.footerH}px`;
  $("dictCell").style.flex = `1 1 ${s.dictW * 100}%`;
  $("infoCell").style.flex = `1 1 ${(1 - s.dictW) * 100}%`;
  if (rebuild && S.pdf) {
    view.setDocument(S.pdf, S.pages, S.translations);
  }
}

// ---------- PDFを開く ----------

async function openBytes(bytes, name) {
  if (S.loading) return;
  S.loading = true;
  showDropError("");
  $("alert").hidden = true;
  translator?.stop();
  S.runId++;
  setStatus("PDFを読み込み中…");
  setProgress(0, true);
  try {
    const id = await hashBytes(bytes);
    const pdf = await loadPdf(bytes.slice(0));
    const pages = await extractPages(pdf);
    let title = await getMeta(pdf, "");
    if (!title) {
      const base = (name || "").replace(/\.pdf$/i, "");
      title = base && base !== "document" ? base : (pages[0]?.blocks[0]?.text.slice(0, 60) || "無題のPDF");
    }
    const old = S.pdf;
    S.pdf = pdf;
    S.pages = pages;
    S.blocks = pages.flatMap((p) => p.blocks);
    S.blockById = new Map(S.blocks.map((b) => [b.id, b]));
    S.docId = id;
    S.docTitle = title;
    S.docBytes = bytes;

    const rec = await loadDocRecord(id);
    S.translations = rec?.translations || {};
    S.record = {
      id,
      title,
      numPages: pdf.numPages,
      createdAt: rec?.createdAt || Date.now(),
      lastOpened: Date.now(),
      translations: S.translations,
    };

    view.setDocument(pdf, pages, S.translations);
    if (old) old.destroy().catch(() => {});

    document.body.classList.add("hasdoc");
    $("title").textContent = title;
    document.title = `${title} — eiyaku`;
    $("translate").disabled = false;
    $("saveBtn").disabled = false;
    search.clear();
    $("dictPanel").innerHTML = '<div class="hint big">辞書</div><div class="hint">原文・訳文をクリックすると、ここに文が表示されます。単語を選択すると用語集に登録できます。</div>';
    $("infoPanel").innerHTML = '<div class="hint big">関連</div><div class="hint">選んだ単語を含む他の文がここに表示されます。</div>';

    const pending = S.blocks.filter((b) => !b.skip && S.translations[b.id] == null);
    const cached = S.blocks.length - pending.length;
    if (pending.length === 0) {
      setProgress(null);
      setStatus(`翻訳済み(${cached}ブロック)· キャッシュから表示`);
      flushSave();
    } else if (new URLSearchParams(location.search).has("notranslate")) {
      setProgress(null);
      setStatus(`未訳 ${pending.length} ブロック(翻訳は保留中)`);
      flushSave();
    } else {
      setStatus(`${cached ? `キャッシュ ${cached} / ` : ""}未訳 ${pending.length} ブロック`);
      startTranslation(pending);
    }
  } catch (e) {
    console.error(e);
    setProgress(null);
    setStatus("");
    const msg = `PDFを開けませんでした: ${e.message || e}`;
    if (document.body.classList.contains("hasdoc")) showAlert(msg);
    else showDropError(msg);
  } finally {
    S.loading = false;
  }
}

function startTranslation(blocks) {
  const run = S.runId;
  translator = makeTranslator(run);
  $("translate").disabled = true;
  $("saveBtn").disabled = true;
  const priority = (b) => (view.getVisiblePages().has(b.page) ? 0 : 100000) + b.page * 1000 + b.idx;
  translator.run(blocks, priority).finally(() => {
    if (run === S.runId) {
      $("translate").disabled = !S.pdf;
      $("saveBtn").disabled = !S.pdf;
    }
  });
}

function retranslate() {
  if (!S.pdf || S.loading) return;
  translator?.stop();
  S.runId++;
  S.translations = {};
  view.clearTranslations();
  markDirty();
  const pending = S.blocks.filter((b) => !b.skip);
  setStatus("訳し直します…");
  startTranslation(pending);
}

async function openFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.name) && file.type !== "application/pdf") {
    showDropError("PDFファイルを選んでください。");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openBytes(bytes, file.name);
}

async function openUrl(input) {
  const norm = normalizePdfUrl(input);
  if (!norm) {
    showDropError("arXivのURL(arxiv.org/abs/... または /pdf/...)か、PDFのURLを入力してください。");
    return;
  }
  showDropError("");
  setStatus("PDFを取得中…");
  setProgress(0, true);
  try {
    const bytes = await fetchPdf(norm.url, (t) => setStatus(t));
    await openBytes(bytes, norm.name);
  } catch (e) {
    setProgress(null);
    setStatus("");
    showDropError(e.message || String(e));
  }
}

// ---------- ファイル入力 / D&D / arXiv ----------

$("file").addEventListener("change", (e) => {
  openFile(e.target.files[0]);
  e.target.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const file = e.dataTransfer?.files?.[0];
  if (file) openFile(file);
});

$("arxivUrl").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    openUrl(e.target.value);
  }
});
$("arxivUrl").addEventListener("paste", () => {
  setTimeout(() => openUrl($("arxivUrl").value), 50);
});

$("demoBtn").onclick = async () => {
  try {
    setStatus("見本を読み込み中…");
    const res = await fetch("data/demo.pdf");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await openBytes(new Uint8Array(await res.arrayBuffer()), "demo-paper");
  } catch (e) {
    showDropError(`見本を開けませんでした: ${e.message || e}`);
  }
};

$("translate").onclick = retranslate;

$("saveBtn").onclick = async () => {
  if (!S.pdf || !S.docBytes) return;
  $("saveBtn").disabled = true;
  try {
    const { buildTranslatedPdf, downloadPdf } = await import("./export.js");
    const out = await buildTranslatedPdf({
      bytes: S.docBytes.slice(0),
      pages: S.pages,
      translations: S.translations,
      title: S.docTitle,
      onStatus: (t) => setStatus(t),
    });
    downloadPdf(out, S.docTitle);
    setStatus("PDFを保存しました");
  } catch (e) {
    console.error(e);
    showAlert(`PDF保存に失敗しました: ${e.message || e}`);
    setStatus("");
  } finally {
    $("saveBtn").disabled = false;
  }
};

// ---------- キーボード ----------

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    $("file").click();
  } else if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!$("saveBtn").disabled) $("saveBtn").click();
  } else if (mod && e.key.toLowerCase() === "f") {
    e.preventDefault();
    $("q").focus();
    $("q").select();
  }
});

// ---------- 設定ダイアログ ----------

const settingFields = ["theme", "uiScale", "relatedLang", "panelPos", "darkPages", "trimMargins", "swapPanes", "showDict", "showInfo", "wheelZoom"];

function fillSettings() {
  for (const k of settingFields) {
    const el = $(k);
    if (el.type === "checkbox") el.checked = !!S.settings[k];
    else el.value = S.settings[k];
  }
  $("engineMode").value = S.settings.engine.mode;
  $("localModel").value = S.settings.engine.model;
  $("apiEndpoint").value = S.settings.engine.endpoint;
  $("apiModel").value = S.settings.engine.apiModel;
  $("apiKey").value = S.settings.engine.apiKey;
  toggleEngineOpts();
}

function toggleEngineOpts() {
  const api = $("engineMode").value === "api";
  $("localOpts").hidden = api;
  $("apiOpts").hidden = !api;
}

$("settingsBtn").onclick = () => {
  fillSettings();
  $("settings").showModal();
};

for (const k of settingFields) {
  $(k).addEventListener("change", (e) => {
    const el = e.target;
    const old = S.settings[k];
    S.settings[k] = el.type === "checkbox" ? el.checked : el.value;
    saveSettings(S.settings);
    applySettings(k === "trimMargins" && old !== S.settings[k]);
  });
}

$("engineMode").addEventListener("change", (e) => {
  S.settings.engine.mode = e.target.value;
  saveSettings(S.settings);
  toggleEngineOpts();
});
$("localModel").addEventListener("change", (e) => {
  S.settings.engine.model = e.target.value;
  saveSettings(S.settings);
});
for (const [id, key] of [["apiEndpoint", "endpoint"], ["apiModel", "apiModel"], ["apiKey", "apiKey"]]) {
  $(id).addEventListener("change", (e) => {
    S.settings.engine[key] = e.target.value.trim();
    saveSettings(S.settings);
  });
}

$("resetSettings").onclick = () => {
  const fresh = structuredClone(DEFAULT_SETTINGS);
  fresh.engine = S.settings.engine; // エンジン設定は維持
  Object.assign(S.settings, fresh); // 参照を保ったまま上書き(view/panelsと共有)
  saveSettings(S.settings);
  applySettings(true);
  fillSettings();
  $("resetNote").textContent = "初期値に戻しました";
  setTimeout(() => ($("resetNote").textContent = ""), 2000);
};

// ---------- スプリッター ----------

function dragSplit(el, onMove, onEnd) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("drag");
    const move = (ev) => onMove(ev);
    const up = () => {
      el.classList.remove("drag");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      onEnd?.();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });
}

dragSplit(
  $("splitter"),
  (e) => {
    const top = S.settings.panelPos.startsWith("top");
    const headerH = document.querySelector("header").offsetHeight;
    const h = top ? e.clientY - headerH : window.innerHeight - e.clientY;
    S.settings.footerH = Math.min(500, Math.max(60, h));
    document.querySelector("footer").style.height = `${S.settings.footerH}px`;
    document.body.classList.remove("folded");
    S.settings.folded = false;
  },
  () => saveSettings(S.settings)
);
$("splitter").addEventListener("dblclick", () => {
  S.settings.folded = !S.settings.folded;
  saveSettings(S.settings);
  applySettings();
});

dragSplit(
  $("colSplit"),
  (e) => {
    const footer = document.querySelector("footer");
    const rect = footer.getBoundingClientRect();
    let r = (e.clientX - rect.left) / rect.width;
    if (S.settings.panelPos.endsWith("right")) r = 1 - r;
    S.settings.dictW = Math.min(0.8, Math.max(0.2, r));
    $("dictCell").style.flex = `1 1 ${S.settings.dictW * 100}%`;
    $("infoCell").style.flex = `1 1 ${(1 - S.settings.dictW) * 100}%`;
  },
  () => saveSettings(S.settings)
);

// ---------- 用語集ダイアログ ----------

let gTextArea = false;

function gRow(en = "", ja = "") {
  const tr = document.createElement("tr");
  const td1 = document.createElement("td");
  const td2 = document.createElement("td");
  const td3 = document.createElement("td");
  const i1 = document.createElement("input");
  i1.placeholder = "英語";
  i1.value = en;
  const i2 = document.createElement("input");
  i2.placeholder = "訳語";
  i2.value = ja;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "gdel";
  del.textContent = "×";
  del.title = "削除";
  del.onclick = () => tr.remove();
  td1.appendChild(i1);
  td2.appendChild(i2);
  td3.appendChild(del);
  tr.append(td1, td2, td3);
  return tr;
}

function collectGlossaryRows() {
  const out = [];
  for (const tr of $("gtable").querySelector("tbody").rows) {
    const en = tr.cells[0].firstChild.value.trim();
    const ja = tr.cells[1].firstChild.value.trim();
    if (en && ja) out.push({ en, ja });
  }
  return out;
}

function openGlossary(prefillEn = "") {
  const tbody = $("gtable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const g of S.glossary) tbody.appendChild(gRow(g.en, g.ja));
  if (prefillEn) tbody.appendChild(gRow(prefillEn, ""));
  gTextArea = false;
  $("gArea").hidden = true;
  $("gtable").closest(".gtable-wrap").hidden = false;
  $("glossaryDlg").showModal();
  if (prefillEn) tbody.lastChild.cells[1].firstChild.focus();
}

$("glossaryBtn").onclick = () => openGlossary();
$("gAdd").onclick = () => {
  if (gTextArea) return;
  const tbody = $("gtable").querySelector("tbody");
  tbody.appendChild(gRow());
  tbody.lastChild.cells[0].firstChild.focus();
};
$("gText").onclick = () => {
  gTextArea = !gTextArea;
  if (gTextArea) {
    $("gArea").value = glossaryText(collectGlossaryRows());
    $("gArea").hidden = false;
    $("gtable").closest(".gtable-wrap").hidden = true;
    $("gText").textContent = "表で編集";
  } else {
    const rows = parseGlossaryText($("gArea").value);
    const tbody = $("gtable").querySelector("tbody");
    tbody.innerHTML = "";
    for (const g of rows) tbody.appendChild(gRow(g.en, g.ja));
    $("gArea").hidden = true;
    $("gtable").closest(".gtable-wrap").hidden = false;
    $("gText").textContent = "テキストで編集";
  }
};
$("gCancel").onclick = () => $("glossaryDlg").close();
$("gSave").onclick = () => {
  const rows = gTextArea ? parseGlossaryText($("gArea").value) : collectGlossaryRows();
  const map = new Map();
  for (const g of rows) map.set(g.en.toLowerCase(), g);
  const next = [...map.values()];
  const changed = JSON.stringify(next) !== JSON.stringify(S.glossary);
  S.glossary = next;
  saveGlossary(next);
  $("glossaryDlg").close();
  if (changed && S.pdf) retranslate();
};

// ---------- 保存データダイアログ ----------

let dataRows = [];

async function refreshDataDlg() {
  const recs = await listDocRecords();
  recs.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  const table = $("storeList");
  table.innerHTML = "<thead><tr><th></th><th>論文</th><th>ページ</th><th>訳文</th><th>最終利用</th><th>サイズ</th></tr></thead>";
  const tbody = document.createElement("tbody");
  dataRows = [];
  let total = 0;
  for (const rec of recs) {
    const size = estimateSize(rec);
    total += size;
    const tr = document.createElement("tr");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const td0 = document.createElement("td");
    td0.appendChild(cb);
    const td1 = document.createElement("td");
    td1.textContent = rec.title || rec.id;
    if (rec.id === S.docId) td1.classList.add("cur-doc");
    const td2 = document.createElement("td");
    td2.className = "num";
    td2.textContent = rec.numPages ?? "—";
    const td3 = document.createElement("td");
    td3.className = "num";
    td3.textContent = Object.keys(rec.translations || {}).length;
    const td4 = document.createElement("td");
    td4.className = "num";
    td4.textContent = fmtDate(rec.lastOpened);
    const td5 = document.createElement("td");
    td5.className = "num";
    td5.textContent = fmtSize(size);
    tr.append(td0, td1, td2, td3, td4, td5);
    tbody.appendChild(tr);
    dataRows.push({ rec, cb });
  }
  table.appendChild(tbody);
  const gSize = estimateSize(S.glossary);
  const sSize = estimateSize(S.settings);
  $("storeTotal").textContent = `訳文キャッシュ ${recs.length}件 · 合計 ${fmtSize(total)}`;
  $("storeSystem").innerHTML =
    `<tr><td>用語集</td><td class="num">${S.glossary.length}語</td><td class="num">${fmtSize(gSize)}</td></tr>` +
    `<tr><td>設定</td><td class="num"></td><td class="num">${fmtSize(sSize)}</td></tr>`;
  updatePickCount();
}

function updatePickCount() {
  const n = dataRows.filter((r) => r.cb.checked).length;
  $("clearPicked").disabled = n === 0;
  $("dataNote").textContent = n ? `${n}件を選択中` : "";
}

function updateOldLabel() {
  const days = Number($("oldDays").value);
  $("oldLabel").textContent = `${days}日`;
  const cutoff = Date.now() - days * 86400000;
  const n = dataRows.filter((r) => (r.rec.lastOpened || 0) < cutoff).length;
  $("oldCount").textContent = `(${n}件)`;
}

$("dataBtn").onclick = async () => {
  $("dataDlg").showModal();
  await refreshDataDlg();
  updateOldLabel();
};
$("oldDays").addEventListener("input", updateOldLabel);
$("pickOld").onclick = () => {
  const cutoff = Date.now() - Number($("oldDays").value) * 86400000;
  for (const r of dataRows) r.cb.checked = (r.rec.lastOpened || 0) < cutoff;
  updatePickCount();
};
$("pickAll").onclick = () => {
  for (const r of dataRows) r.cb.checked = true;
  updatePickCount();
};
$("pickNone").onclick = () => {
  for (const r of dataRows) r.cb.checked = false;
  updatePickCount();
};
$("storeList").addEventListener("change", updatePickCount);
$("clearPicked").onclick = async () => {
  const ids = dataRows.filter((r) => r.cb.checked).map((r) => r.rec.id);
  if (!ids.length) return;
  await deleteDocRecords(ids);
  if (ids.includes(S.docId)) {
    S.record = null; // 表示中の訳文はメモリ上に残るが、キャッシュは再保存しない
  }
  await refreshDataDlg();
  updateOldLabel();
};

// ---------- 起動 ----------

applySettings();
if (!navigator.gpu && S.settings.engine.mode === "local") {
  const note = $("dropNote");
  const w = document.createElement("div");
  w.style.color = "var(--danger)";
  w.style.marginTop = "6px";
  w.textContent = "このブラウザはWebGPUに対応していません。設定(右上の歯車)で「API方式」に切り替えるか、Chrome / Edge の最新版をお使いください。";
  note.appendChild(w);
}
setStatus("");
document.documentElement.dataset.app = "ready";
if (new URLSearchParams(location.search).has("demo")) $("demoBtn").click();
