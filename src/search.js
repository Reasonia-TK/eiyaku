// 文書内検索(原文・訳文の両方を対象)

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function snippet(text, q, radius = 50) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text.slice(0, radius * 2));
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + q.length + radius);
  return (start > 0 ? "…" : "") + esc(text.slice(start, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length, end)) + (end < text.length ? "…" : "");
}

export class Search {
  constructor({ input, countEl, listEl, clearBtn, getBlocks, getTranslation, onJump, onHits }) {
    this.input = input;
    this.countEl = countEl;
    this.listEl = listEl;
    this.clearBtn = clearBtn;
    this.getBlocks = getBlocks;
    this.getTranslation = getTranslation;
    this.onJump = onJump;
    this.onHits = onHits;
    this.matches = [];
    this.cur = -1;
    this.timer = 0;

    input.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(input.value.trim()), 180);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.next(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        this.clear();
        input.blur();
      }
    });
    clearBtn.addEventListener("click", () => {
      this.clear();
      input.focus();
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#searchBox")) this.listEl.hidden = true;
    });
    input.addEventListener("focus", () => {
      if (this.matches.length) this.listEl.hidden = false;
    });
  }

  run(q) {
    this.matches = [];
    this.cur = -1;
    this.listEl.innerHTML = "";
    if (!q) {
      this.countEl.textContent = "";
      this.listEl.hidden = true;
      this.onHits?.([]);
      return;
    }
    const lq = q.toLowerCase();
    for (const b of this.getBlocks()) {
      const ja = this.getTranslation(b.id) || "";
      const inEn = b.text.toLowerCase().includes(lq);
      const inJa = ja.toLowerCase().includes(lq);
      if (inEn || inJa) this.matches.push({ block: b, inEn, inJa });
    }
    this.countEl.textContent = `${this.matches.length}件`;
    this.onHits?.(this.matches.map((m) => m.block.id));
    const shown = this.matches.slice(0, 200);
    shown.forEach((m, i) => {
      const item = document.createElement("div");
      item.className = "qitem";
      const text = m.inJa && !m.inEn ? this.getTranslation(m.block.id) : m.block.text;
      item.innerHTML = `<span class="qpage">p.${m.block.page + 1}</span>${snippet(text, q)}`;
      item.onclick = () => this.jump(i);
      this.listEl.appendChild(item);
    });
    this.listEl.hidden = shown.length === 0;
    if (this.matches.length) this.jump(0, false);
  }

  jump(i, scroll = true) {
    if (!this.matches.length) return;
    this.cur = ((i % this.matches.length) + this.matches.length) % this.matches.length;
    const m = this.matches[this.cur];
    [...this.listEl.children].forEach((el, k) => el.classList.toggle("cur", k === this.cur));
    this.listEl.children[this.cur]?.scrollIntoView({ block: "nearest" });
    if (scroll) this.onJump?.(m.block.id);
    this.countEl.textContent = `${this.cur + 1}/${this.matches.length}件`;
  }

  next(dir = 1) {
    if (!this.matches.length) return;
    this.jump(this.cur + dir);
    this.listEl.hidden = false;
  }

  clear() {
    this.input.value = "";
    this.matches = [];
    this.cur = -1;
    this.countEl.textContent = "";
    this.listEl.innerHTML = "";
    this.listEl.hidden = true;
    this.onHits?.([]);
  }

  refresh() {
    if (this.input.value.trim()) this.run(this.input.value.trim());
  }
}
