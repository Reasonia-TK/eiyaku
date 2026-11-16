// 2ペイン表示: 原文キャンバス + 訳文オーバーレイ(レイアウト維持)
// ズーム・同期スクロール・遅延描画・クリック対応

export class View {
  constructor({ srcEl, dstEl, settings, onBlockClick, onVisiblePages }) {
    this.srcEl = srcEl;
    this.dstEl = dstEl;
    this.settings = settings;
    this.onBlockClick = onBlockClick;
    this.onVisiblePages = onVisiblePages;
    this.pdf = null;
    this.pages = [];
    this.pageEls = []; // [{src, dst, ovlSrc, ovlDst, canvasSrc, canvasDst, trs:Map, covers:Map}]
    this.translations = new Map();
    this.zoom = 1;
    this.visible = new Set();
    this.rendered = new Map(); // pageIdx -> scale
    this.renderQueue = [];
    this.rendering = 0;
    this.syncing = false;
    this.activeId = null;
    this.hitEls = [];
    this.srcHl = null;
    this.disposed = false;

    this._onScrollSrc = () => this._syncScroll(this.srcEl, this.dstEl);
    this._onScrollDst = () => this._syncScroll(this.dstEl, this.srcEl);
    srcEl.addEventListener("scroll", this._onScrollSrc, { passive: true });
    dstEl.addEventListener("scroll", this._onScrollDst, { passive: true });

    this._onWheel = (e) => {
      if ((e.ctrlKey || this.settings.wheelZoom) && !e.shiftKey) {
        e.preventDefault();
        this.zoomBy(Math.exp(-e.deltaY * 0.0012));
      }
    };
    srcEl.addEventListener("wheel", this._onWheel, { passive: false });
    dstEl.addEventListener("wheel", this._onWheel, { passive: false });

    this._onClickSrc = (e) => this._handleClick(e, "src");
    this._onClickDst = (e) => this._handleClick(e, "dst");
    srcEl.addEventListener("click", this._onClickSrc);
    dstEl.addEventListener("click", this._onClickDst);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const i = Number(en.target.dataset.page);
          if (en.isIntersecting) this.visible.add(i);
          else this.visible.delete(i);
        }
        this.onVisiblePages?.(this.visible);
        this._scheduleRender();
        this._releaseFar();
        this._fitVisible();
      },
      { root: srcEl, rootMargin: "120% 0px" }
    );

    this.resizeObs = new ResizeObserver(() => this._debouncedLayout());
    this.resizeObs.observe(srcEl);
    this.resizeObs.observe(dstEl);
    this._layoutTimer = 0;
  }

  cropOf(page) {
    return this.settings.trimMargins ? page.crop : { x: 0, y: 0, w: page.width, h: page.height };
  }

  setDocument(pdf, pages, translations) {
    this.pdf = pdf;
    this.pages = pages;
    this.translations = new Map(Object.entries(translations || {}));
    this.visible.clear();
    this.rendered.clear();
    this.renderQueue = [];
    this.activeId = null;
    this.hitEls = [];
    this.srcHl = null;
    this.observer.disconnect();
    this.srcEl.innerHTML = "";
    this.dstEl.innerHTML = "";
    this.pageEls = [];

    pages.forEach((page, i) => {
      const crop = this.cropOf(page);
      const mk = (pane, isDst) => {
        const el = document.createElement("div");
        el.className = "page";
        el.dataset.page = i;
        el.style.aspectRatio = `${crop.w} / ${crop.h}`;
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const ovl = document.createElement("div");
        ovl.className = "ovl";
        const pnum = document.createElement("div");
        pnum.className = "pnum";
        pnum.textContent = page.num;
        el.append(canvas, ovl, pnum);
        pane.appendChild(el);
        return { el, canvas, ovl };
      };
      const s = mk(this.srcEl, false);
      const d = mk(this.dstEl, true);
      const trs = new Map();
      const covers = new Map();
      for (const b of page.blocks) {
        const pos = this._blockPos(b, crop);
        const cover = document.createElement("div");
        cover.className = "cover";
        Object.assign(cover.style, pos);
        const tr = document.createElement("div");
        tr.className = "tr";
        tr.dataset.id = b.id;
        Object.assign(tr.style, pos);
        const ja = this.translations.get(b.id);
        if (ja != null) {
          tr.textContent = ja;
          tr.classList.add("done");
          cover.classList.add("done");
        }
        d.ovl.append(cover, tr);
        trs.set(b.id, tr);
        covers.set(b.id, cover);
      }
      this.pageEls.push({ src: s.el, dst: d.el, ovlSrc: s.ovl, ovlDst: d.ovl, canvasSrc: s.canvas, canvasDst: d.canvas, trs, covers });
      this.observer.observe(s.el);
    });

    // 最初のページをすぐ描画
    this.visible.add(0);
    if (pages.length > 1) this.visible.add(1);
    this.applyZoom();
    this._scheduleRender();
  }

  _blockPos(b, crop) {
    return {
      left: `${((b.x - crop.x) / crop.w) * 100}%`,
      top: `${((b.y - crop.y) / crop.h) * 100}%`,
      width: `${(b.w / crop.w) * 100}%`,
      height: `${(b.h / crop.h) * 100}%`,
    };
  }

  setTranslation(block, ja) {
    this.translations.set(block.id, ja);
    const pe = this.pageEls[block.page];
    if (!pe) return;
    const tr = pe.trs.get(block.id);
    const cover = pe.covers.get(block.id);
    if (!tr) return;
    tr.textContent = ja;
    tr.classList.add("done");
    cover?.classList.add("done");
    this._fitOne(block);
  }

  clearTranslations() {
    this.translations.clear();
    for (const pe of this.pageEls) {
      for (const tr of pe.trs.values()) {
        tr.textContent = "";
        tr.classList.remove("done");
      }
      for (const c of pe.covers.values()) c.classList.remove("done");
    }
  }

  // ---------- 寸法・ズーム ----------

  fitScale() {
    const paneW = this.srcEl.clientWidth - 26;
    const first = this.pages[0];
    if (!first || paneW <= 0) return 1;
    const crop = this.cropOf(first);
    return Math.max(0.1, paneW / crop.w);
  }

  applyZoom() {
    const fs = this.fitScale();
    for (let i = 0; i < this.pages.length; i++) {
      const crop = this.cropOf(this.pages[i]);
      const w = crop.w * fs * this.zoom;
      this.pageEls[i].src.style.width = `${w}px`;
      this.pageEls[i].dst.style.width = `${w}px`;
    }
    this._fitVisible();
    this._debouncedRender();
  }

  zoomBy(factor) {
    const z = Math.min(3, Math.max(0.4, this.zoom * factor));
    if (Math.abs(z - this.zoom) < 0.001) return;
    this.zoom = z;
    this.applyZoom();
  }

  _debouncedLayout() {
    clearTimeout(this._layoutTimer);
    this._layoutTimer = setTimeout(() => this.applyZoom(), 120);
  }

  _debouncedRender() {
    clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => this._scheduleRender(), 180);
  }

  // ---------- テキストフィット ----------

  _fitOne(block) {
    const pe = this.pageEls[block.page];
    if (!pe) return;
    const tr = pe.trs.get(block.id);
    if (!tr || !tr.classList.contains("done")) return;
    const crop = this.cropOf(this.pages[block.page]);
    const dispW = parseFloat(pe.dst.style.width) || crop.w;
    let fs = block.size * (dispW / crop.w);
    fs = Math.max(5, Math.min(fs, 40));
    tr.style.fontSize = `${fs}px`;
    let guard = 0;
    while (tr.scrollHeight > tr.clientHeight + 1 && fs > 5 && guard++ < 60) {
      fs -= 0.5;
      tr.style.fontSize = `${fs}px`;
    }
  }

  _fitVisible() {
    requestAnimationFrame(() => {
      if (this.disposed) return;
      const want = new Set();
      for (const i of this.visible) for (let k = i - 1; k <= i + 1; k++) want.add(k);
      if (want.size === 0) want.add(0);
      for (const i of want) {
        const page = this.pages[i];
        if (!page) continue;
        for (const b of page.blocks) {
          if (this.translations.has(b.id)) this._fitOne(b);
        }
      }
    });
  }

  // ---------- 描画 ----------

  _scheduleRender() {
    if (!this.pdf || this.disposed) return;
    const want = new Set();
    for (const i of this.visible) {
      for (let k = i - 1; k <= i + 1; k++) if (k >= 0 && k < this.pages.length) want.add(k);
    }
    if (want.size === 0) want.add(0);
    const fs = this.fitScale();
    const dpr = window.devicePixelRatio || 1;
    const target = Math.min(3, Math.max(0.75, fs * this.zoom * dpr));
    for (const i of want) {
      const last = this.rendered.get(i) || 0;
      if (!last || Math.abs(target - last) / last > 0.2) {
        if (!this.renderQueue.includes(i)) this.renderQueue.push(i);
      }
    }
    this._pump();
  }

  async _pump() {
    while (this.rendering < 2 && this.renderQueue.length && !this.disposed) {
      const i = this.renderQueue.shift();
      this.rendering++;
      try {
        await this._renderPage(i);
      } catch (e) {
        console.warn("page render failed", i, e);
      } finally {
        this.rendering--;
      }
    }
  }

  async _renderPage(i) {
    const page = this.pages[i];
    const pe = this.pageEls[i];
    if (!page || !pe || !this.pdf) return;
    const crop = this.cropOf(page);
    const fs = this.fitScale();
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(3, Math.max(0.75, fs * this.zoom * dpr));
    const pdfPage = await this.pdf.getPage(page.num);
    if (this.disposed) return;
    const viewport = pdfPage.getViewport({
      scale,
      offsetX: -crop.x * scale,
      offsetY: -crop.y * scale,
    });
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.floor(crop.w * scale));
    off.height = Math.max(1, Math.floor(crop.h * scale));
    const ctx = off.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, off.width, off.height);
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    if (this.disposed) return;
    for (const cv of [pe.canvasSrc, pe.canvasDst]) {
      cv.width = off.width;
      cv.height = off.height;
      cv.getContext("2d").drawImage(off, 0, 0);
    }
    this.rendered.set(i, scale);
  }

  _releaseFar() {
    const keep = new Set();
    for (const i of this.visible) for (let k = i - 2; k <= i + 2; k++) keep.add(k);
    for (const [i] of this.rendered) {
      if (!keep.has(i)) {
        const pe = this.pageEls[i];
        for (const cv of [pe.canvasSrc, pe.canvasDst]) {
          cv.width = 1;
          cv.height = 1;
        }
        this.rendered.delete(i);
      }
    }
  }

  // ---------- スクロール ----------

  _syncScroll(from, to) {
    if (this.syncing) return;
    this.syncing = true;
    const max = from.scrollHeight - from.clientHeight;
    const ratio = max > 0 ? from.scrollTop / max : 0;
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => { this.syncing = false; });
  }

  scrollToBlock(id, both = true) {
    const b = this.findBlock(id);
    if (!b) return;
    const crop = this.cropOf(this.pages[b.page]);
    const panes = both ? [this.srcEl, this.dstEl] : [this.dstEl];
    this.syncing = true;
    for (const pane of panes) {
      const pe = pane === this.srcEl ? this.pageEls[b.page].src : this.pageEls[b.page].dst;
      const y = pe.offsetTop + ((b.y - crop.y) / crop.h) * pe.offsetHeight - pane.clientHeight * 0.3;
      pane.scrollTop = Math.max(0, y);
    }
    requestAnimationFrame(() => { this.syncing = false; });
  }

  findBlock(id) {
    const [p, idx] = id.split(":").map(Number);
    return this.pages[p]?.blocks.find((b) => b.idx === idx) || null;
  }

  // ---------- クリック・ハイライト ----------

  _handleClick(e, side) {
    const pageEl = e.target.closest(".page");
    if (!pageEl) return;
    const i = Number(pageEl.dataset.page);
    const page = this.pages[i];
    if (!page) return;
    let block = null;
    let word = "";
    if (side === "dst") {
      const tr = e.target.closest(".tr");
      if (tr) block = this.findBlock(tr.dataset.id);
      const sel = window.getSelection();
      const s = sel ? sel.toString().trim() : "";
      if (s && s.length <= 60 && !/\n/.test(s)) word = s;
    }
    if (!block) {
      const crop = this.cropOf(page);
      const rect = pageEl.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * crop.w + crop.x;
      const py = ((e.clientY - rect.top) / rect.height) * crop.h + crop.y;
      let bestArea = Infinity;
      for (const b of page.blocks) {
        if (px >= b.x - 3 && px <= b.x + b.w + 3 && py >= b.y - 3 && py <= b.y + b.h + 3) {
          const area = b.w * b.h;
          if (area < bestArea) { bestArea = area; block = b; }
        }
      }
    }
    if (block) {
      this.setActive(block.id);
      this.onBlockClick?.(block, word, side);
    }
  }

  setActive(id) {
    if (this.activeId) {
      const prev = this.findBlock(this.activeId);
      if (prev) this.pageEls[prev.page]?.trs.get(prev.id)?.classList.remove("active");
    }
    this.srcHl?.remove();
    this.srcHl = null;
    this.activeId = id;
    if (!id) return;
    const b = this.findBlock(id);
    if (!b) return;
    const pe = this.pageEls[b.page];
    pe.trs.get(id)?.classList.add("active");
    const crop = this.cropOf(this.pages[b.page]);
    const hl = document.createElement("div");
    hl.className = "hl";
    Object.assign(hl.style, this._blockPos(b, crop));
    pe.ovlSrc.appendChild(hl);
    this.srcHl = hl;
  }

  setHits(ids) {
    for (const el of this.hitEls) el.remove();
    this.hitEls = [];
    for (const id of ids) {
      const b = this.findBlock(id);
      if (!b) continue;
      const crop = this.cropOf(this.pages[b.page]);
      const pe = this.pageEls[b.page];
      for (const ovl of [pe.ovlSrc, pe.ovlDst]) {
        const hl = document.createElement("div");
        hl.className = "hl hit";
        Object.assign(hl.style, this._blockPos(b, crop));
        ovl.appendChild(hl);
        this.hitEls.push(hl);
      }
    }
  }

  getVisiblePages() {
    return this.visible;
  }

  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    this.resizeObs.disconnect();
    this.srcEl.removeEventListener("scroll", this._onScrollSrc);
    this.dstEl.removeEventListener("scroll", this._onScrollDst);
    this.srcEl.removeEventListener("wheel", this._onWheel);
    this.dstEl.removeEventListener("wheel", this._onWheel);
    this.srcEl.removeEventListener("click", this._onClickSrc);
    this.dstEl.removeEventListener("click", this._onClickDst);
    this.srcEl.innerHTML = "";
    this.dstEl.innerHTML = "";
  }
}
