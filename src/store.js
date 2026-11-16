// 永続化: 設定(localStorage) / 用語集(localStorage) / 訳文キャッシュ(IndexedDB)

const SETTINGS_KEY = "eiyaku.settings";
const GLOSSARY_KEY = "eiyaku.glossary";
const DB_NAME = "eiyaku-db";
const DB_VER = 1;

export const DEFAULT_SETTINGS = {
  theme: "system",
  uiScale: "normal",
  relatedLang: "auto",
  panelPos: "bottom-left",
  darkPages: true,
  trimMargins: false,
  swapPanes: false,
  showDict: true,
  showInfo: true,
  wheelZoom: false,
  footerH: 190,
  dictW: 0.5,
  folded: false,
  engine: {
    mode: "local",
    model: "Qwen3-1.7B-q4f16_1-MLC",
    endpoint: "https://api.openai.com/v1",
    apiModel: "gpt-4o-mini",
    apiKey: "",
  },
};

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { ...DEFAULT_SETTINGS, ...s, engine: { ...DEFAULT_SETTINGS.engine, ...(s.engine || {}) } };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function loadGlossary() {
  try {
    const g = JSON.parse(localStorage.getItem(GLOSSARY_KEY) || "[]");
    return Array.isArray(g) ? g.filter((e) => e && e.en && e.ja) : [];
  } catch {
    return [];
  }
}

export function saveGlossary(g) {
  localStorage.setItem(GLOSSARY_KEY, JSON.stringify(g));
}

export function glossaryText(g) {
  return g.map((e) => `${e.en}: ${e.ja}`).join("\n");
}

export function parseGlossaryText(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    const j = t.indexOf(":", i + 1);
    const sep = i >= 0 ? i : j;
    if (sep < 0) continue;
    const en = t.slice(0, sep).trim();
    const ja = t.slice(sep + 1).trim();
    if (en && ja) out.push({ en, ja });
  }
  return out;
}

// ---------- ハッシュ ----------
export async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------- IndexedDB ----------
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("docs")) {
        db.createObjectStore("docs", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction("docs", mode);
        const store = t.objectStore("docs");
        const out = fn(store);
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export async function loadDocRecord(id) {
  const req = await tx("readonly", (s) => s.get(id));
  return req ?? null;
}

export async function saveDocRecord(rec) {
  await tx("readwrite", (s) => s.put(rec));
}

export async function listDocRecords() {
  const req = await tx("readonly", (s) => s.getAll());
  return req ?? [];
}

export async function deleteDocRecords(ids) {
  await tx("readwrite", (s) => {
    for (const id of ids) s.delete(id);
  });
}

export function estimateSize(obj) {
  try {
    return JSON.stringify(obj).length;
  } catch {
    return 0;
  }
}

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}
