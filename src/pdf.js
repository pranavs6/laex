import * as pdfjs from "pdfjs-dist";

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
      if (this.zoom === null && this.doc && Math.abs(w - this.lastWidth) > 4) {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => this.render(), 120);
      }
    }).observe(this.el);
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
        const r = canvas.getBoundingClientRect();
        this.onReverseSync(n, (e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
        const flash = document.createElement("div");
        flash.className = "lx-pdf__flash";
        flash.style.top = `${e.clientY - r.top - 9}px`;
        box.appendChild(flash);
        setTimeout(() => flash.remove(), 1300);
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
