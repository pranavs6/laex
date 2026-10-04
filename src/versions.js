import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { pdfjs } from "./pdf.js";
import { theme, highlight, lang } from "./editor.js";

// Line-level change counts (LCS), for the "+5 −3" summaries.
export function lineStats(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  if (a === b) return { added: 0, removed: 0 };
  // Trim the common head and tail first; CVs change in small places.
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const xs = x.slice(s, x.length - e), ys = y.slice(s, y.length - e);
  const n = xs.length, m = ys.length;
  if (n * m > 4_000_000) return { added: m, removed: n };
  let prev = new Uint16Array(m + 1), cur = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) cur[j] = xs[i - 1] === ys[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  const common = prev[m];
  return { added: m - common, removed: n - common };
}

const when = (at) => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
  .replace(/, /, " at ").replace(" am", "am").replace(" pm", "pm");

export function initVersions(app) {
  const { $, el, api } = app;
  const root = $("versions");
  let list = [];
  let merge = null;

  async function refresh() {
    list = await api.json("/api/versions").catch(() => []);
    if (!root.dataset.view || root.dataset.view === "list") renderList();
  }

  function renderList(notice) {
    root.dataset.view = "list";
    merge?.destroy();
    merge = null;
    const body = el("div", { className: "lx-panel" });
    if (notice) body.append(el("div", { className: "lx-notice", role: "status" }, el("h3", { className: "lx-notice__title", textContent: notice })));
    body.append(
      el("h2", { className: "lx-panel__title", textContent: "Versions" }),
      el("p", { className: "lx-hint", textContent: "A version is saved only when you choose Save version. Rebuilding never creates one. Restoring a version saves your current files first, so it can be undone." }),
    );
    const save = el("button", { type: "button", className: "lx-button", textContent: "Save version" });
    save.addEventListener("click", () => saveVersion());
    body.append(el("div", { className: "lx-panel__actions" }, save));

    if (!list.length) {
      body.append(el("p", { className: "lx-empty", textContent: "No versions yet." }));
    } else {
      const dl = el("dl", { className: "lx-summary" });
      for (const v of list) dl.append(versionRow(v));
      body.append(dl);
    }
    root.replaceChildren(body);
  }

  function versionRow(v) {
    const actions = el("ul", { className: "lx-summary__actions" });
    const act = (text, fn) => {
      const b = el("button", { type: "button", className: "lx-link", textContent: text });
      b.append(el("span", { className: "lx-visually-hidden", textContent: ` ${v.label}` }));
      b.addEventListener("click", fn);
      actions.append(el("li", {}, b));
    };
    act("Compare", () => compare(v));
    if (v.pdf) {
      const a = el("a", { className: "lx-link", textContent: "Download PDF", download: `${v.label}.pdf`,
        href: `/api/versions/pdf?id=${encodeURIComponent(v.id)}&download=1&name=${encodeURIComponent(v.label)}` });
      a.append(el("span", { className: "lx-visually-hidden", textContent: ` of ${v.label}` }));
      actions.append(el("li", {}, a));
    }
    act("Restore", () => confirmRestore(v, row));
    act("Rename", async () => {
      const label = await app.ask({ title: "Rename version", label: "Version name", value: v.label, confirm: "Save name" });
      if (label) { await api.post("/api/versions/rename", { id: v.id, label }); refresh(); }
    });
    act("Delete", () => confirmDelete(v, row));
    const meta = [when(v.at), v.main, `${v.files.length} file${v.files.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
    const row = el("div", { className: "lx-summary__row" },
      el("dt", { className: "lx-summary__key" },
        el("span", { className: "lx-summary__label", textContent: v.label }),
        v.auto ? el("strong", { className: "lx-tag lx-tag--small lx-tag--grey", textContent: "Automatic" }) : null,
        el("span", { className: "lx-summary__meta", textContent: meta })),
      el("dd", { className: "lx-summary__value" }, actions));
    return row;
  }

  function confirmRestore(v, row) {
    const yes = el("button", { type: "button", className: "lx-button lx-button--warning", textContent: "Restore version" });
    const no = el("button", { type: "button", className: "lx-link", textContent: "Cancel" });
    const box = el("div", { className: "lx-confirm" },
      el("p", { textContent: `Restore "${v.label}"?` }),
      el("p", { className: "lx-hint", textContent: "Your files are replaced with this version. Your current files are saved as a version first." }),
      el("div", { className: "lx-confirm__actions" }, yes, no));
    row.after(box);
    no.focus();
    no.addEventListener("click", () => box.remove());
    yes.addEventListener("click", async () => {
      await app.saveAll();
      const r = await api.post("/api/versions/restore", { id: v.id, main: app.settings.main });
      await refresh();
      renderList(`Restored "${r.restored.label}". Your previous files were saved as "${r.backup.label}".`);
      app.compile();
    });
  }

  function confirmDelete(v, row) {
    const yes = el("button", { type: "button", className: "lx-button lx-button--warning", textContent: "Delete version" });
    const no = el("button", { type: "button", className: "lx-link", textContent: "Cancel" });
    const box = el("div", { className: "lx-confirm" },
      el("p", { textContent: `Delete "${v.label}"? This cannot be undone.` }),
      el("div", { className: "lx-confirm__actions" }, yes, no));
    row.after(box);
    no.focus();
    no.addEventListener("click", () => box.remove());
    yes.addEventListener("click", async () => {
      await api.post("/api/versions/delete", { id: v.id });
      refresh();
    });
  }

  async function saveVersion() {
    const label = await app.ask({
      title: "Save a version", label: "Version name", hint: "For example, Sent to Monzo or Before cutting to one page",
      value: "", confirm: "Save version",
    });
    if (label === null) return;
    await app.compile({ wait: true });
    const v = await api.post("/api/versions", { label: label || `Version ${list.filter((x) => !x.auto).length + 1}`, main: app.settings.main });
    await refresh();
    renderList(`Saved "${v.label}".`);
    app.setStatus("Saved", "green", `Version "${v.label}" saved at ${new Date(v.at).toLocaleTimeString("en-GB")}.`);
  }

  // -------------------------------------------------------------- compare
  async function compare(v) {
    root.dataset.view = "compare";
    await app.saveAll();
    const back = el("button", { type: "button", className: "lx-back", textContent: "Back to versions" });
    back.addEventListener("click", () => { renderList(); refresh(); });
    const panel = el("div", { className: "lx-panel lx-panel--compare" });
    panel.append(back, el("span", { className: "lx-caption", textContent: when(v.at) }),
      el("h2", { className: "lx-panel__title", textContent: `"${v.label}" compared with now` }));

    // Which files changed?
    const current = new Set(app.project.files);
    const names = [...new Set([...v.files, ...current])].sort();
    const changes = [];
    for (const f of names) {
      const then = v.files.includes(f) ? await api.text(`/api/versions/file?id=${encodeURIComponent(v.id)}&path=${encodeURIComponent(f)}`) : "";
      const now = current.has(f) ? (app.editor.has(f) ? app.editor.text(f) : await api.read(f).catch(() => "")) : "";
      if (then === now) continue;
      changes.push({ file: f, then, now, stats: lineStats(then, now), added: !v.files.includes(f), removed: !current.has(f) });
    }

    const tabs = el("div", { className: "lx-segments", role: "tablist" });
    const srcTab = el("button", { type: "button", role: "tab", className: "lx-segments__item", textContent: "Source changes" });
    const pdfTab = el("button", { type: "button", role: "tab", className: "lx-segments__item", textContent: "PDF changes" });
    tabs.append(srcTab, pdfTab);
    const view = el("div", { className: "lx-compare" });
    panel.append(tabs, view);
    root.replaceChildren(panel);

    const showSource = () => {
      srcTab.setAttribute("aria-selected", "true");
      pdfTab.setAttribute("aria-selected", "false");
      merge?.destroy();
      merge = null;
      view.replaceChildren();
      if (!changes.length) { view.append(el("p", { className: "lx-empty", textContent: "No source changes since this version." })); return; }
      const summary = el("ul", { className: "lx-changes" });
      const holder = el("div", { className: "lx-merge" });
      const pick = (c, li) => {
        summary.querySelectorAll("li").forEach((x) => x.classList.toggle("is-current", x === li));
        merge?.destroy();
        const ext = [lineNumbers(), lang, syntaxHighlighting(highlight), theme, EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false)];
        merge = new MergeView({
          a: { doc: c.then, extensions: ext },
          b: { doc: c.now, extensions: ext },
          parent: holder, collapseUnchanged: { margin: 3, minSize: 6 }, highlightChanges: true, gutter: true,
        });
      };
      for (const c of changes) {
        const b = el("button", { type: "button", className: "lx-link", textContent: c.file });
        const li = el("li", {}, b,
          el("span", { className: "lx-changes__stat lx-changes__stat--add", textContent: `+${c.stats.added}` }),
          el("span", { className: "lx-changes__stat lx-changes__stat--del", textContent: `−${c.stats.removed}` }),
          c.added ? el("strong", { className: "lx-tag lx-tag--small lx-tag--green", textContent: "New" }) : null,
          c.removed ? el("strong", { className: "lx-tag lx-tag--small lx-tag--red", textContent: "Deleted" }) : null);
        b.addEventListener("click", () => pick(c, li));
        summary.append(li);
      }
      view.append(summary,
        el("div", { className: "lx-merge__labels" }, el("span", { textContent: `Then: ${v.label}` }), el("span", { textContent: "Now" })),
        holder);
      const first = changes.find((c) => c.file === app.settings.main) || changes[0];
      pick(first, summary.children[changes.indexOf(first)]);
    };

    const showPdf = async () => {
      srcTab.setAttribute("aria-selected", "false");
      pdfTab.setAttribute("aria-selected", "true");
      merge?.destroy();
      merge = null;
      view.replaceChildren(el("p", { className: "lx-hint", textContent: "Comparing pages…" }));
      if (!v.pdf) { view.replaceChildren(el("p", { className: "lx-empty", textContent: "This version has no PDF." })); return; }
      if (v.main !== app.settings.main) {
        view.replaceChildren(el("p", { className: "lx-hint", textContent: `This version was saved while ${v.main} was the main document. Now showing ${app.settings.main}.` }));
      }
      await pdfCompare(view, `/api/versions/pdf?id=${encodeURIComponent(v.id)}`, `/api/pdf?main=${encodeURIComponent(app.settings.main)}&v=${Date.now()}`, v.label);
    };

    srcTab.addEventListener("click", showSource);
    pdfTab.addEventListener("click", showPdf);
    showSource();
  }

  // ---------------------------------------------------------- pdf compare
  // Render both PDFs page by page at the same scale, diff the pixels on a
  // grid, and box the changed regions on both sides.
  async function pdfCompare(view, thenUrl, nowUrl, label) {
    let a, b;
    try {
      [a, b] = await Promise.all([pdfjs.getDocument({ url: thenUrl }).promise, pdfjs.getDocument({ url: nowUrl }).promise]);
    } catch {
      view.append(el("p", { className: "lx-empty", textContent: "Could not load both PDFs." }));
      return;
    }
    const grid = el("div", { className: "lx-pdfdiff" });
    grid.append(el("div", { className: "lx-pdfdiff__head", textContent: `Then: ${label}` }), el("div", { className: "lx-pdfdiff__head", textContent: "Now" }));
    const width = Math.max(200, (view.clientWidth - 50) / 2);
    let changedPages = 0;
    const pages = Math.max(a.numPages, b.numPages);
    for (let n = 1; n <= pages; n++) {
      const [ca, cb] = await Promise.all([renderPage(a, n, width), renderPage(b, n, width)]);
      const boxes = ca && cb ? diffCanvases(ca, cb) : [];
      if (!ca || !cb || boxes.length) changedPages++;
      grid.append(pageCell(ca, boxes, "then"), pageCell(cb, boxes, "now"));
    }
    a.destroy();
    b.destroy();
    view.replaceChildren(
      el("p", { className: "lx-hint", textContent: changedPages ? `${changedPages} of ${pages} page${pages > 1 ? "s" : ""} changed. Changed areas are outlined.` : "The PDFs look the same." }),
      grid);
  }

  async function renderPage(doc, n, width) {
    if (n > doc.numPages) return null;
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / base.width });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await page.render({ canvas: c, canvasContext: c.getContext("2d", { willReadFrequently: true }), viewport: vp }).promise;
    return c;
  }

  function diffCanvases(a, b) {
    const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
    const da = a.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const db = b.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const cell = 6;
    const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
    const hot = new Uint8Array(gw * gh);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 90) {
          hot[Math.floor(y / cell) * gw + Math.floor(x / cell)] = 1;
        }
      }
    }
    // Group neighbouring changed cells (allowing small gaps) into boxes.
    const seen = new Uint8Array(gw * gh);
    const boxes = [];
    for (let i = 0; i < hot.length; i++) {
      if (!hot[i] || seen[i]) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const k = stack.pop();
        const cx = k % gw, cy = Math.floor(k / gw);
        x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const j = ny * gw + nx;
          if (hot[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      boxes.push({ x: x0 * cell - 3, y: y0 * cell - 3, w: (x1 - x0 + 1) * cell + 6, h: (y1 - y0 + 1) * cell + 6 });
    }
    return boxes;
  }

  function pageCell(canvas, boxes, side) {
    const cellEl = el("div", { className: "lx-pdfdiff__page" });
    if (!canvas) {
      cellEl.append(el("div", { className: "lx-pdfdiff__missing", textContent: side === "then" ? "Page not in this version" : "Page removed" }));
      return cellEl;
    }
    cellEl.append(canvas);
    for (const bx of boxes) {
      const d = el("div", { className: `lx-pdfdiff__box lx-pdfdiff__box--${side}` });
      Object.assign(d.style, { left: `${bx.x}px`, top: `${bx.y}px`, width: `${bx.w}px`, height: `${bx.h}px` });
      cellEl.append(d);
    }
    return cellEl;
  }

  return { refresh, saveVersion };
}
