import * as pdfjs from "pdfjs-dist";

export { pdfjs };

pdfjs.GlobalWorkerOptions.workerSrc = "/build/pdf.worker.min.mjs";

// Renders every page to canvas. A reload renders off-screen and swaps in one
// go, keeping the scroll position, so the preview never flashes blank.
export class PdfView {
  constructor(container, { onReverseSync, onPages }) {
    this.el = container;
    this.onReverseSync = onReverseSync;
    this.onPages = onPages;
    this.doc = null;
    this.zoom = null; // null = fit width
    this.gen = 0;
    this.pageScale = [];
    this.lastWidth = 0;
    new ResizeObserver(() => {
      const w = this.el.clientWidth;
      // w is 0 while another page is showing; nothing to fit to then.
      if (w && this.zoom === null && this.doc && Math.abs(w - this.lastWidth) > 4) {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => this.render(), 120);
      }
    }).observe(this.el);
    this.swipe = "zoom";
    this.el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.enablePan();
    this.enableTouch();
  }

  // Zoom gestures. Trackpad pinch arrives as a wheel event with ctrlKey set.
  // With `swipe` set to "zoom", a plain vertical two-finger swipe zooms too
  // (fingers up = out, down = in); Cmd+swipe and click-drag still move the
  // page. Pages are scaled with CSS at once, anchored under the pointer, and
  // re-rendered crisply once the gesture settles.
  onWheel(e) {
    if (!this.doc) return;
    const pinch = e.ctrlKey;
    const swipe = this.swipe === "zoom" && !e.metaKey && Math.abs(e.deltaY) > Math.abs(e.deltaX);
    if (!pinch && !swipe) return;
    e.preventDefault();
    const delta = Math.max(-60, Math.min(60, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
    this.zoomBy(Math.exp(-delta * (pinch ? 0.01 : 0.0012)), e.clientX, e.clientY);
  }

  zoomBy(factor, clientX, clientY) {
    const wrap = this.el.querySelector(".lx-pdf__pages");
    const rendered = this.currentScale();
    const prev = this.liveScale ?? rendered;
    const target = Math.min(4, Math.max(0.3, prev * factor));
    if (target === prev) return;
    this.liveScale = target;

    const box = this.el.getBoundingClientRect();
    const px = clientX - box.left;
    const py = clientY - box.top;
    const r = target / prev;
    const x = (this.el.scrollLeft + px) * r - px;
    const y = (this.el.scrollTop + py) * r - py;
    if (wrap) wrap.style.zoom = String(target / rendered);
    this.el.scrollLeft = x;
    this.el.scrollTop = y;

    clearTimeout(this.pinchTimer);
    this.pinchTimer = setTimeout(() => {
      this.liveScale = null;
      this.setZoom(target);
    }, 180);
  }

  // Click-and-drag pans, since the swipe is busy zooming. A small threshold
  // keeps clicks on links and double-click-to-source working.
  enablePan() {
    let start = null;
    this.el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch" || e.button !== 0 || e.target.closest(".lx-pdf__link")) return;
      start = { x: e.clientX, y: e.clientY, left: this.el.scrollLeft, top: this.el.scrollTop, id: e.pointerId, moved: false };
    });
    this.el.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 5) return;
      if (!start.moved) { start.moved = true; this.el.setPointerCapture(e.pointerId); this.el.classList.add("is-panning"); }
      this.el.scrollLeft = start.left - dx;
      this.el.scrollTop = start.top - dy;
    });
    const end = () => { start = null; this.el.classList.remove("is-panning"); };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
  }

  // Touch: one finger scrolls natively, two fingers pinch through the same
  // path as the trackpad, and a double tap jumps to the source.
  enableTouch() {
    const pts = new Map();
    let spread = 0, down = null, lastTap = null;
    const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    this.el.addEventListener("gesturestart", (e) => e.preventDefault());
    this.el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = pts.size === 1 ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
      if (pts.size === 2) spread = dist();
    });
    this.el.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size !== 2 || !this.doc) return;
      const d = dist();
      const [a, b] = [...pts.values()];
      if (spread) this.zoomBy(d / spread, (a.x + b.x) / 2, (a.y + b.y) / 2);
      spread = d;
    });
    this.el.addEventListener("pointerup", (e) => {
      if (!pts.delete(e.pointerId)) return;
      spread = 0;
      if (pts.size || !down || e.timeStamp - down.t > 300 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) return;
      const box = e.target.closest?.(".lx-pdf__page");
      if (box && !e.target.closest(".lx-pdf__link") && lastTap && e.timeStamp - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap = null;
        this.touchSyncAt = Date.now();
        this.syncAt(box, e.clientX, e.clientY);
      } else {
        lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      }
    });
    this.el.addEventListener("pointercancel", (e) => { pts.delete(e.pointerId); spread = 0; down = null; });
  }

  // Reverse SyncTeX from a point on a page, with a flash where it landed.
  syncAt(box, clientX, clientY) {
    const n = Number(box.dataset.page);
    const scale = this.pageScale[n - 1];
    if (!scale) return;
    const r = box.querySelector("canvas").getBoundingClientRect();
    this.onReverseSync(n, (clientX - r.left) / scale, (clientY - r.top) / scale);
    const flash = document.createElement("div");
    flash.className = "lx-pdf__flash";
    flash.style.top = `${clientY - r.top - 9}px`;
    box.appendChild(flash);
    setTimeout(() => flash.remove(), 1300);
  }

  async load(url) {
    const doc = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
    const old = this.doc;
    this.doc = doc;
    await this.render();
    old?.destroy();
  }

  // pdf.js paints the page as pixels, so hyperlinks need real <a> overlays:
  // external URLs open in the browser, internal ones scroll to their page.
  async addLinks(page, vp, box) {
    let annots = [];
    try { annots = await page.getAnnotations({ intent: "display" }); } catch { return; }
    for (const a of annots) {
      if (a.subtype !== "Link" || (!a.url && !a.dest)) continue;
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
      const link = document.createElement("a");
      link.className = "lx-pdf__link";
      Object.assign(link.style, {
        left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`,
        width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px`,
      });
      if (a.url) {
        link.href = a.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = a.url.replace(/^mailto:/, "");
      } else {
        link.href = "#";
        link.title = "Go to destination";
        link.addEventListener("click", (e) => { e.preventDefault(); this.goToDest(a.dest); });
      }
      link.addEventListener("dblclick", (e) => e.stopPropagation());
      box.appendChild(link);
    }
  }

  async goToDest(dest) {
    try {
      const explicit = typeof dest === "string" ? await this.doc.getDestination(dest) : dest;
      if (!explicit) return;
      const index = typeof explicit[0] === "number" ? explicit[0] : await this.doc.getPageIndex(explicit[0]);
      const pageBox = this.el.querySelector(`.lx-pdf__page[data-page="${index + 1}"]`);
      if (!pageBox) return;
      let offset = 0;
      const top = explicit[1]?.name === "XYZ" ? explicit[3] : null;
      if (typeof top === "number") {
        const page = await this.doc.getPage(index + 1);
        const vp = page.getViewport({ scale: this.pageScale[index] || 1 });
        offset = vp.convertToViewportPoint(0, top)[1];
      }
      this.el.scrollTo({ top: pageBox.offsetTop + offset - 10, behavior: "smooth" });
    } catch {}
  }

  // Forward SyncTeX: scroll to a box given in PDF points (top-left origin)
  // and flash it.
  reveal({ page, x, y, w, h }) {
    const box = this.el.querySelector(`.lx-pdf__page[data-page="${page}"]`);
    const scale = this.pageScale[page - 1];
    if (!box || !scale) return;
    const top = (y - h) * scale, left = x * scale;
    const mark = document.createElement("div");
    mark.className = "lx-pdf__reveal";
    Object.assign(mark.style, { top: `${top - 3}px`, left: `${left - 4}px`, width: `${Math.max(w * scale, 40) + 8}px`, height: `${Math.max(h * scale, 12) + 6}px` });
    box.appendChild(mark);
    setTimeout(() => mark.remove(), 1800);
    this.el.scrollTo({ top: box.offsetTop + top - this.el.clientHeight / 3, behavior: "smooth" });
  }

  clear() {
    this.doc?.destroy();
    this.doc = null;
    this.el.querySelector(".lx-pdf__pages")?.remove();
  }

  setZoom(z) {
    this.zoom = z;
    this.render();
  }

  currentScale() {
    return this.pageScale[0] || 1;
  }

  async render() {
    if (!this.doc) return;
    const gen = ++this.gen;
    const doc = this.doc;
    const dpr = window.devicePixelRatio || 1;
    this.lastWidth = this.el.clientWidth;
    const avail = Math.max(200, this.el.clientWidth - 28);
    const wrap = document.createElement("div");
    wrap.className = "lx-pdf__pages";
    const scales = [];

    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (gen !== this.gen) return;
      const base = page.getViewport({ scale: 1 });
      const scale = this.zoom ?? avail / base.width;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      await page.render({
        canvas, canvasContext: canvas.getContext("2d"), viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;
      if (gen !== this.gen) return;
      const box = document.createElement("div");
      box.className = "lx-pdf__page";
      box.dataset.page = String(n);
      box.appendChild(canvas);
      box.addEventListener("dblclick", (e) => {
        if (Date.now() - (this.touchSyncAt || 0) < 600) return; // already handled as a double tap
        this.syncAt(box, e.clientX, e.clientY);
      });
      await this.addLinks(page, vp, box);
      wrap.appendChild(box);
      scales.push(scale);
    }

    const { scrollTop, scrollLeft } = this.el;
    this.el.querySelector(".lx-pdf__pages")?.remove();
    this.el.querySelector(".lx-empty")?.remove();
    this.el.appendChild(wrap);
    this.el.scrollTop = scrollTop;
    this.el.scrollLeft = scrollLeft;
    this.pageScale = scales;
    this.onPages(doc.numPages, scales[0]);
  }
}
