// Cover letters: a word-style editor beside a live PDF of the letter, headed
// with your CV's name and contact line. Letters are stored as plain text with
// light markup (**bold**, *italic*, "- " bullets, [text](https://link)), so
// Copy text gives clean text for application forms. On a phone the preview
// sits under the editor.

import { PdfView } from "./pdf.js";

const when = (at) => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })
  .replace(" am", "am").replace(" pm", "pm");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/;

// ------------------------------------------------------- markup <-> editor
function inlineHtml(text) {
  return text.split(INLINE).map((part) => {
    let m;
    if ((m = part.match(/^\*\*([^*]+)\*\*$/))) return `<b>${escapeHtml(m[1])}</b>`;
    if ((m = part.match(/^\*([^*]+)\*$/))) return `<i>${escapeHtml(m[1])}</i>`;
    if ((m = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/))) return `<a href="${escapeHtml(m[2])}">${escapeHtml(m[1])}</a>`;
    return escapeHtml(part);
  }).join("");
}

// One line of markup per <div>; runs of "- " lines become a list.
function toHtml(markup) {
  const out = [];
  let items = [];
  const flush = () => { if (items.length) out.push(`<ul>${items.join("")}</ul>`); items = []; };
  for (const line of markup.split("\n")) {
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) { items.push(`<li>${inlineHtml(bullet[1]) || "<br>"}</li>`); continue; }
    flush();
    out.push(`<div>${inlineHtml(line) || "<br>"}</div>`);
  }
  flush();
  return out.join("") || "<div><br></div>";
}

// Walks what the browser built while editing and writes markup back.
function toMarkup(root) {
  const inline = (node) => [...node.childNodes].map((n) => {
    if (n.nodeType === 3) return n.textContent.replace(/\u00a0/g, " ");
    if (n.nodeType !== 1) return "";
    const tag = n.tagName;
    if (tag === "BR") return "\n";
    const inner = inline(n);
    if (!inner.trim()) return inner;
    const bold = tag === "B" || tag === "STRONG" || /bold|[6-9]00/.test(n.style?.fontWeight || "");
    const italic = tag === "I" || tag === "EM" || n.style?.fontStyle === "italic";
    if (tag === "A" && /^https?:\/\//.test(n.getAttribute("href") || "")) return `[${inner}](${n.getAttribute("href")})`;
    let s = inner;
    if (italic) s = `*${s}*`;
    if (bold) s = `**${s}**`;
    return s;
  }).join("");
  const lines = [];
  const block = (n) => {
    if (n.nodeType === 3) { if (n.textContent.trim()) lines.push(n.textContent); return; }
    if (n.nodeType !== 1) return;
    if (n.tagName === "UL" || n.tagName === "OL") {
      for (const li of n.children) lines.push(`- ${inline(li).replace(/\n+$/, "").replace(/\n/g, " ")}`);
    } else if (n.tagName === "BR") {
      lines.push("");
    } else if ([...n.children].some((c) => ["DIV", "P", "UL", "OL"].includes(c.tagName))) {
      for (const c of n.childNodes) block(c);
    } else {
      lines.push(...inline(n).replace(/\n$/, "").split("\n"));
    }
  };
  for (const n of root.childNodes) block(n);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// What Copy text gives: the letter with its markup removed.
function toPlain(markup) {
  return markup
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/^[-*•]\s+/gm, "• ")
    .trim();
}
const words = (t) => (toPlain(t).match(/\S+/g) || []).length;

export function initLetters(app) {
  const { $, el, api } = app;
  const root = $("letters");
  let list = [];
  let apps = [];
  let current = null; // id of the open letter
  let saveTimer = null;
  let pending = null; // fields waiting to be saved
  let preview = null; // { view, timer, busy, again }
  let syncTools = null; // updates the toolbar for the open letter

  document.addEventListener("selectionchange", () => syncTools?.());

  const nameOf = (l) => [l.company, l.role].filter(Boolean).join(" — ") || "Untitled letter";

  async function refresh() {
    await flush();
    [list, apps] = await Promise.all([
      api.json("/api/letters").catch(() => []),
      api.json("/api/applications").catch(() => []),
    ]);
    if (current && !list.some((l) => l.id === current)) current = null;
    render();
  }

  function render() {
    preview?.view.clear();
    preview = null;
    if (current) renderDocument(); else renderList();
  }

  // ----------------------------------------------------------------- list
  function renderList() {
    const add = el("button", { type: "button", className: "lx-button", textContent: "New cover letter" });
    add.addEventListener("click", () => create());
    const items = el("ul", { className: "lx-notes__items lx-letters__items" });
    for (const l of [...list].sort((a, b) => b.updated - a.updated)) {
      const b = el("button", { type: "button", className: "lx-notes__item" },
        el("span", { className: "lx-notes__title", textContent: nameOf(l) }),
        el("span", { className: "lx-notes__meta", textContent: `${when(l.updated)} · ${plural(words(l.body), "word")}` }));
      b.addEventListener("click", () => open(l.id));
      items.append(el("li", {}, b));
    }
    root.replaceChildren(el("div", { className: "lx-letters" },
      el("h1", { className: "lx-page__title", textContent: "Cover letters" }),
      el("p", { className: "lx-hint", textContent: "Write in a word-style editor with the PDF beside it. Copy the text into an application form, or download the PDF." }),
      el("div", { className: "lx-panel__actions" }, add),
      list.length ? items : el("p", { className: "lx-hint", textContent: "No cover letters yet." })));
  }

  // ------------------------------------------------------------- document
  function renderDocument() {
    const l = list.find((x) => x.id === current);
    const back = el("button", { type: "button", className: "lx-back", textContent: "All cover letters" });
    back.addEventListener("click", async () => { await flush(); current = null; render(); });

    const field = (id, label, control) => el("div", { className: "lx-form-group" }, el("label", { className: "lx-label", htmlFor: id, textContent: label }), control);
    const company = el("input", { className: "lx-input lx-input--full", id: "letter-company", value: l.company, autocomplete: "off" });
    const role = el("input", { className: "lx-input lx-input--full", id: "letter-role", value: l.role, autocomplete: "off" });
    const link = el("select", { className: "lx-select lx-input--full", id: "letter-app" });
    link.append(new Option("Not linked", ""));
    for (const a of apps) link.append(new Option([a.company, a.role].filter(Boolean).join(" — "), a.id));
    link.value = l.application && apps.some((a) => a.id === l.application) ? l.application : "";

    // The editor: contenteditable, normalised to markup on every change.
    const doc = el("div", { className: "lx-letter__doc", id: "letter-body", contentEditable: "true", spellcheck: true });
    doc.setAttribute("role", "textbox");
    doc.setAttribute("aria-multiline", "true");
    doc.setAttribute("aria-label", "Letter");
    doc.innerHTML = toHtml(l.body);
    document.execCommand("defaultParagraphSeparator", false, "div");

    const tool = (label, title, fn, cmd) => {
      const b = el("button", { type: "button", className: "lx-letter__tool", title, textContent: label });
      if (cmd) b.dataset.cmd = cmd;
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
      b.addEventListener("click", () => { doc.focus(); fn(); edited(); syncTools?.(); });
      return b;
    };
    const toolbar = el("div", { className: "lx-letter__toolbar", role: "toolbar", "aria-label": "Formatting" },
      tool("B", "Bold (⌘B)", () => document.execCommand("bold"), "bold"),
      tool("I", "Italic (⌘I)", () => document.execCommand("italic"), "italic"),
      tool("• List", "Bulleted list", () => document.execCommand("insertUnorderedList"), "insertUnorderedList"),
      tool("Link", "Link selected text", async () => {
        const sel = window.getSelection();
        const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        if (!range || range.collapsed) { status.textContent = "Select some text to link first."; return; }
        const url = await app.ask({ title: "Add a link", label: "Web address", hint: "Starts with https://", value: "https://", confirm: "Add link" });
        if (!url || !/^https?:\/\/\S+$/.test(url)) return;
        doc.focus();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("createLink", false, url);
        edited();
      }),
      tool("Clear", "Remove formatting from the selection", () => { document.execCommand("removeFormat"); document.execCommand("unlink"); }));
    syncTools = () => {
      if (!doc.isConnected || !doc.contains(document.getSelection()?.anchorNode)) return;
      for (const b of toolbar.querySelectorAll("[data-cmd]")) b.setAttribute("aria-pressed", String(document.queryCommandState(b.dataset.cmd)));
    };

    // Paste as plain text, so formatting from elsewhere doesn't come along.
    doc.addEventListener("paste", (e) => {
      e.preventDefault();
      document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
    });

    const count = el("span", { className: "lx-hint lx-letter__count", role: "status" });
    const status = el("span", { className: "lx-hint lx-notes__status", textContent: `Saved ${when(l.updated)}` });
    const showCount = () => {
      const plain = toPlain(l.body);
      count.textContent = `${plural(words(l.body), "word")} · ${plural(plain.length, "character")}`;
    };
    showCount();

    const changed = (fields) => {
      Object.assign(l, fields);
      pending = { ...pending, ...fields, id: l.id };
      status.textContent = "Saving…";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => flush().then(() => { status.textContent = `Saved ${when(l.updated)}`; schedulePreview(0); }), 600);
    };
    const edited = () => { changed({ body: toMarkup(doc) }); showCount(); };
    doc.addEventListener("input", edited);
    company.addEventListener("input", () => changed({ company: company.value }));
    role.addEventListener("input", () => changed({ role: role.value }));
    // Linking an application fills in its company and role if they're empty.
    link.addEventListener("change", () => {
      const a = apps.find((x) => x.id === link.value);
      const fields = { application: link.value || null };
      if (a && !company.value.trim()) company.value = fields.company = a.company || "";
      if (a && !role.value.trim()) role.value = fields.role = a.role || "";
      changed(fields);
    });

    const copy = el("button", { type: "button", className: "lx-button lx-button--secondary", textContent: "Copy text" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(toPlain(l.body));
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Copy failed";
      }
      setTimeout(() => { copy.textContent = "Copy text"; }, 1500);
    });
    const pdf = el("button", { type: "button", className: "lx-button lx-button--secondary", textContent: "Download PDF" });
    const pdfError = el("p", { className: "lx-list__error", role: "alert", hidden: true });
    pdf.addEventListener("click", async () => {
      await flush();
      pdf.setAttribute("aria-disabled", "true");
      pdf.textContent = "Building PDF…";
      pdfError.hidden = true;
      try {
        const r = await fetch(pdfUrl(l.id, true));
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
        const name = r.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "Cover letter.pdf";
        const url = URL.createObjectURL(await r.blob());
        el("a", { href: url, download: name }).click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } catch (e) {
        pdfError.textContent = e.message;
        pdfError.hidden = false;
      } finally {
        pdf.removeAttribute("aria-disabled");
        pdf.textContent = "Download PDF";
      }
    });

    const del = el("button", { type: "button", className: "lx-link", textContent: "Delete cover letter" });
    del.addEventListener("click", () => {
      const yes = el("button", { type: "button", className: "lx-button lx-button--warning", textContent: "Delete cover letter" });
      const no = el("button", { type: "button", className: "lx-link", textContent: "Cancel" });
      const confirm = el("div", { className: "lx-confirm" },
        el("p", { textContent: `Delete the cover letter for ${nameOf(l)}? This cannot be undone.` }),
        el("div", { className: "lx-confirm__actions" }, yes, no));
      del.parentElement.after(confirm);
      no.focus();
      no.addEventListener("click", () => confirm.remove());
      yes.addEventListener("click", async () => {
        clearTimeout(saveTimer);
        pending = null;
        await api.post("/api/letters/delete", { id: l.id });
        current = null;
        refresh();
      });
    });

    // The live preview: rebuilt after each save, one build at a time.
    const previewStatus = el("span", { className: "lx-hint lx-letter__pstatus", role: "status" });
    const pdfBox = el("div", { className: "lx-pdf lx-letter__pdf" });
    const previewCard = el("section", { className: "lx-card lx-letter__preview", "aria-label": "PDF preview" },
      el("div", { className: "lx-card__head" }, el("h2", { className: "lx-card__title", textContent: "PDF preview" }), previewStatus),
      pdfBox);

    const editorCol = el("div", { className: "lx-letter__editor" },
      el("div", { className: "lx-letter__fields" },
        field("letter-company", "Company", company), field("letter-role", "Role", role), field("letter-app", "Application", link)),
      el("div", { className: "lx-letter__paper" }, toolbar, doc),
      el("div", { className: "lx-notes__bar lx-letter__bar" }, count, status),
      el("div", { className: "lx-panel__actions lx-letter__actions" }, copy, pdf),
      pdfError,
      el("p", { className: "lx-actions lx-actions--below" }, del));

    root.replaceChildren(el("div", { className: "lx-letter" },
      back, el("h1", { className: "lx-page__title lx-letter__title", textContent: nameOf(l) }),
      el("div", { className: "lx-letter__grid" }, editorCol, previewCard)));
    company.addEventListener("input", () => { root.querySelector(".lx-letter__title").textContent = nameOf(l); });
    role.addEventListener("input", () => { root.querySelector(".lx-letter__title").textContent = nameOf(l); });

    preview = { view: new PdfView(pdfBox, { onReverseSync: () => {}, onPages: () => {} }), timer: null, busy: false, again: false, status: previewStatus };
    schedulePreview(0);
  }

  const pdfUrl = (id, download) => `/api/letters/pdf?id=${encodeURIComponent(id)}&main=${encodeURIComponent(app.settings.main || "")}${download ? "&download=1" : `&v=${Date.now()}`}`;

  function schedulePreview(delay = 300) {
    if (!preview) return;
    clearTimeout(preview.timer);
    preview.timer = setTimeout(buildPreview, delay);
  }

  async function buildPreview() {
    const p = preview;
    if (!p || !current) return;
    if (p.busy) { p.again = true; return; }
    p.busy = true;
    p.status.textContent = "Updating…";
    try {
      const r = await fetch(pdfUrl(current, false));
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const url = URL.createObjectURL(await r.blob());
      await p.view.load(url);
      URL.revokeObjectURL(url);
      p.status.textContent = "Up to date";
    } catch (e) {
      p.status.textContent = e.message;
    } finally {
      p.busy = false;
      if (p.again && preview === p) { p.again = false; buildPreview(); }
    }
  }

  // Writes whatever is waiting, and folds the saved letter back into the list.
  async function flush() {
    clearTimeout(saveTimer);
    if (!pending) return;
    const fields = pending;
    pending = null;
    const saved = await api.post("/api/letters", fields).catch(() => null);
    if (!saved) return;
    const i = list.findIndex((x) => x.id === saved.id);
    if (i >= 0) list[i] = saved;
  }

  async function open(id) {
    await flush();
    current = id;
    render();
    root.querySelector("#letter-body")?.focus();
  }

  async function create() {
    await flush();
    const l = await api.post("/api/letters", { company: "", role: "", body: "" });
    list.push(l);
    current = l.id;
    render();
    root.querySelector("#letter-company")?.focus();
  }

  return { refresh, flush };
}
