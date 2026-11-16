// 辞書パネル・関連パネル

const STOPWORDS = new Set(
  "the a an and or but of to in on at for with without by from as is are was were be been being this that these those it its we our you your they their he she his i not no can could may might will would shall should do does did done have has had having which what when where who whom how why than then there here also more most other some such only own same so too very just about into over under between during before after above below up down out off again further once all any both each few many much several own".split(" ")
);

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function wordsOf(text) {
  return (text.match(/[A-Za-z][A-Za-z-]{2,}/g) || []).map((w) => w.toLowerCase()).filter((w) => !STOPWORDS.has(w));
}

function snippet(text, term, radius = 70) {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return esc(text.slice(0, radius * 2));
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + term.length + radius);
  return (start > 0 ? "…" : "") + esc(text.slice(start, i)) + "<mark>" + esc(text.slice(i, i + term.length)) + "</mark>" + esc(text.slice(i + term.length, end)) + (end < text.length ? "…" : "");
}

export class Panels {
  constructor({ dictEl, infoEl, settings, getTranslation, getBlocks, onJump, onAddGlossary }) {
    this.dictEl = dictEl;
    this.infoEl = infoEl;
    this.settings = settings;
    this.getTranslation = getTranslation;
    this.getBlocks = getBlocks;
    this.onJump = onJump;
    this.onAddGlossary = onAddGlossary;
  }

  show(block, word, side) {
    const ja = this.getTranslation(block.id);
    const dict = this.dictEl;
    dict.innerHTML = "";

    const meta = document.createElement("div");
    meta.className = "dict-meta";
    meta.textContent = `ページ ${block.page + 1}`;
    dict.appendChild(meta);

    if (word) {
      const w = document.createElement("div");
      w.className = "dict-word";
      w.textContent = word;
      dict.appendChild(w);
    }

    const en = document.createElement("div");
    en.className = "dict-block dict-en";
    en.textContent = block.text;
    dict.appendChild(en);

    const jaEl = document.createElement("div");
    jaEl.className = "dict-block dict-ja" + (ja == null ? " pending" : "");
    jaEl.textContent = ja != null ? ja : "翻訳中…";
    dict.appendChild(jaEl);

    const actions = document.createElement("div");
    actions.className = "dict-actions";
    const addBtn = document.createElement("button");
    addBtn.className = "btn small-btn";
    addBtn.textContent = "用語集に追加";
    addBtn.onclick = () => this.onAddGlossary?.(word || "", block);
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn small-btn";
    copyBtn.textContent = "訳文をコピー";
    copyBtn.disabled = ja == null;
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(ja || "");
        copyBtn.textContent = "コピーしました";
        setTimeout(() => (copyBtn.textContent = "訳文をコピー"), 1200);
      } catch { /* noop */ }
    };
    actions.append(addBtn, copyBtn);
    dict.appendChild(actions);

    this._showRelated(block, word, side);
  }

  _showRelated(block, word, side) {
    const info = this.infoEl;
    info.innerHTML = "";
    const candidates = wordsOf(block.text);
    let term = word && /[A-Za-z]/.test(word) ? word.toLowerCase() : "";
    if (!term) {
      // 出現頻度の低い語を選ぶ
      const blocks = this.getBlocks();
      const freq = new Map();
      for (const w of new Set(candidates)) {
        let n = 0;
        const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        for (const b of blocks) if (re.test(b.text)) n++;
        freq.set(w, n);
      }
      candidates.sort((a, b) => (freq.get(a) || 0) - (freq.get(b) || 0));
      term = candidates[0] || "";
    }
    if (!term) {
      info.innerHTML = '<div class="hint big">関連</div><div class="hint">関連する文は見つかりませんでした。</div>';
      return;
    }
    const lang = this.settings.relatedLang === "auto" ? (side === "src" ? "en" : "ja") : this.settings.relatedLang;
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const blocks = this.getBlocks().filter((b) => b.id !== block.id && re.test(b.text));
    blocks.sort((a, b) => Math.abs(a.page - block.page) - Math.abs(b.page - block.page));
    const shown = blocks.slice(0, 15);

    const head = document.createElement("div");
    head.className = "rel-head";
    head.innerHTML = `<b>${esc(term)}</b> を含む文 ${blocks.length} 件`;
    info.appendChild(head);

    if (!shown.length) {
      const d = document.createElement("div");
      d.className = "hint";
      d.textContent = "他の箇所には見つかりませんでした。";
      info.appendChild(d);
      return;
    }
    for (const b of shown) {
      const ja = this.getTranslation(b.id);
      let text = b.text;
      let t = term;
      if (lang === "ja" && ja != null) {
        text = ja;
        // 日本語訳に英語.termが含まれない場合はハイライトなし
        if (!ja.toLowerCase().includes(term.toLowerCase())) t = "";
      }
      const item = document.createElement("div");
      item.className = "rel-item";
      const html = t ? snippet(text, t) : esc(text.slice(0, 140)) + (text.length > 140 ? "…" : "");
      item.innerHTML = `<span class="qpage">p.${b.page + 1}</span>${html}`;
      item.onclick = () => this.onJump?.(b.id);
      info.appendChild(item);
    }
  }

  updateTranslation(blockId) {
    // 辞書パネルに表示中の文の訳が更新されたら反映
    const jaEl = this.dictEl.querySelector(".dict-ja");
    if (!jaEl) return;
    const meta = this.dictEl.querySelector(".dict-meta");
    if (!meta) return;
    const ja = this.getTranslation(blockId);
    if (ja == null) return;
    // 現在表示中のブロックIDを data 属性で保持していないため、簡易的に照合
    if (this._currentId === blockId) {
      jaEl.textContent = ja;
      jaEl.classList.remove("pending");
      const copyBtn = this.dictEl.querySelector(".dict-actions .btn:nth-child(2)");
      if (copyBtn) copyBtn.disabled = false;
    }
  }

  setCurrent(id) {
    this._currentId = id;
  }
}
