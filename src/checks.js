// CV checks: what an applicant tracking system (ATS) reads from the PDF, and
// the problems that quietly sink CVs (too many pages, text that doesn't
// extract cleanly, links that are only words, missing PDF metadata).

import { pdfjs } from "./pdf.js";

export function initChecks(app) {
  const { $, el, api } = app;
  const root = $("atstext");
  let text = "";
  let issues = [];
  let lastBuild = null;

  async function extract(url) {
    const r = await fetch(`/api/text?main=${encodeURIComponent(app.settings.main)}`);
    if (r.ok) return r.text();
    // No pdftotext: fall back to pdf.js's text layer.
    const doc = await pdfjs.getDocument({ url }).promise;
    let out = "";
    for (let n = 1; n <= doc.numPages; n++) {
      const tc = await (await doc.getPage(n)).getTextContent();
      out += tc.items.map((i) => i.str + (i.hasEOL ? "\n" : "")).join("") + "\n\f";
    }
    doc.destroy();
    return out;
  }

  // Runs after every build.
  async function run(build) {
    lastBuild = build;
    const main = app.settings.main;
    if (!main || !build?.pdf) { issues = []; text = ""; render(); publish(); return; }
    const url = `/api/pdf?main=${encodeURIComponent(main)}&v=${Date.now()}`;
    text = await extract(url).catch(() => "");
    const list = [];
    const limit = Number(app.settings.pageLimit) || 0;

    if (limit && build.pages > limit) {
      list.push({ level: "fail", title: `${build.pages} pages. The limit is ${limit}.`, detail: "Tighten wording or remove the weakest bullets. Shrinking fonts or margins makes it harder to read." });
    }
    if (build.overfullLines?.length) {
      list.push({
        level: "warn", title: `${build.overfullLines.length} line${build.overfullLines.length > 1 ? "s" : ""} run past the margin`,
        detail: "Reword to shorten, or allow a break.",
        links: build.overfullLines.slice(0, 8).map((o) => ({ label: `Line ${o.line} (${o.pt.toFixed(1)}pt too wide)`, file: main, line: o.line })),
      });
    } else if (build.overfull) {
      list.push({ level: "warn", title: `${build.overfull} overfull box${build.overfull > 1 ? "es" : ""}`, detail: "Something runs past the margin. See the build log." });
    }

    const plain = text.replace(/\f/g, "");
    if (plain.replace(/\s/g, "").length < 200) {
      list.push({ level: "fail", title: "Little or no text can be read from the PDF", detail: "An ATS would see an almost empty CV. Avoid putting text in images." });
    }
    const split = [...new Set([...plain.matchAll(/(?<![\p{L}])(\p{Lu}) (\p{Lu}{2,})(?![\p{L}])/gu)].map((m) => m[0]))];
    if (split.length) {
      list.push({ level: "warn", title: `Headings are split when read: ${split.slice(0, 4).map((s) => `"${s}"`).join(", ")}`,
        detail: "Small caps (\\scshape, \\textsc) often extract as a capital letter followed by a space. Use normal capitals or bold for headings." });
    }
    const lig = plain.match(/[ﬀ-ﬆ]/g);
    if (lig) {
      list.push({ level: "warn", title: "Ligatures don't turn back into letters", detail: "Words with fi, fl or ff may be misread. Add \\input{glyphtounicode} and \\pdfgentounicode=1 to the preamble." });
    }
    if (!/[\w.+-]+@[\w-]+\.[\w.]+/.test(plain)) {
      list.push({ level: "fail", title: "No email address found in the text", detail: "Make sure your email is written out, not just a link." });
    }
    if (!/(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){9,}/.test(plain)) {
      list.push({ level: "warn", title: "No phone number found in the text" });
    }
    const odd = [...new Set(plain.match(/[^\x00-\x7F£€–—‘’“”·•…é]/g) || [])];
    if (odd.length) {
      list.push({ level: "info", title: `Unusual characters: ${odd.slice(0, 10).join(" ")}`, detail: "Some ATS drop symbols such as arrows. Prefer plain words where it matters (\"to\" instead of →)." });
    }

    // Links and metadata come from the PDF itself.
    try {
      const doc = await pdfjs.getDocument({ url }).promise;
      const words = [];
      for (let n = 1; n <= doc.numPages; n++) {
        for (const a of await (await doc.getPage(n)).getAnnotations()) {
          if (a.subtype !== "Link" || !a.url || a.url.startsWith("mailto:")) continue;
          const host = a.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
          if (!plain.toLowerCase().includes(host.toLowerCase().slice(0, 18))) words.push(host);
        }
      }
      if (words.length) {
        list.push({ level: "info", title: `${words.length} link${words.length > 1 ? "s show" : " shows"} only a word, not the address`,
          detail: `An ATS keeps the text, not the link. Consider writing the address out, for example ${words[0].slice(0, 40)}.` });
      }
      const { info } = await doc.getMetadata();
      const title = (info?.Title || "").trim();
      if (!title || /^(untitled|resume in latex|document)$/i.test(title) || /\.tex$/i.test(title)) {
        list.push({ level: "warn", title: "The PDF has no proper title", detail: "Recruiters see it in their PDF viewer. Set it with \\hypersetup{pdftitle={Your Name - CV}}." });
      }
      if (!(info?.Author || "").trim()) {
        list.push({ level: "info", title: "The PDF has no author", detail: "Set it with \\hypersetup{pdfauthor={Your Name}}." });
      }
      doc.destroy();
    } catch {}

    const spelling = app.spellingCount?.() || 0;
    if (spelling) list.push({ level: "info", title: `${spelling} possible misspelling${spelling > 1 ? "s" : ""} in ${main}`, detail: "Underlined in the editor. Select one for suggestions." });

    issues = list;
    render();
    publish();
  }

  function publish() {
    const fails = issues.filter((i) => i.level === "fail").length;
    const warns = issues.filter((i) => i.level === "warn").length;
    app.onChecks?.({ fails, warns, total: issues.length, pages: lastBuild?.pages, limit: Number(app.settings.pageLimit) || 0 });
  }

  function render() {
    const panel = el("div", { className: "lx-panel" });
    panel.append(el("h2", { className: "lx-panel__title", textContent: "ATS text and checks" }),
      el("p", { className: "lx-hint", textContent: "This is the text an applicant tracking system gets from your PDF, in the order it reads it." }));
    if (!issues.length && text) {
      panel.append(el("div", { className: "lx-notice", role: "status" }, el("h3", { className: "lx-notice__title", textContent: "No problems found" })));
    }
    if (issues.length) {
      const ul = el("ul", { className: "lx-issues" });
      for (const i of issues) {
        const li = el("li", { className: `lx-issue lx-issue--${i.level}` },
          el("strong", { className: `lx-tag lx-tag--small lx-tag--${i.level === "fail" ? "red" : i.level === "warn" ? "yellow" : "blue"}`, textContent: i.level === "fail" ? "Fix" : i.level === "warn" ? "Check" : "Tip" }),
          el("div", {}, el("p", { className: "lx-issue__title", textContent: i.title }), i.detail ? el("p", { className: "lx-hint", textContent: i.detail }) : null));
        if (i.links?.length) {
          const links = el("p", { className: "lx-issue__links" });
          for (const l of i.links) {
            const b = el("button", { type: "button", className: "lx-link", textContent: l.label });
            b.addEventListener("click", () => app.openFile(l.file, l.line));
            links.append(b);
          }
          li.lastChild.append(links);
        }
        ul.append(li);
      }
      panel.append(ul);
    }
    if (text) {
      const copy = el("button", { type: "button", className: "lx-link", textContent: "Copy text" });
      copy.addEventListener("click", () => navigator.clipboard?.writeText(text));
      panel.append(el("div", { className: "lx-panel__row" }, el("h3", { className: "lx-subtitle", textContent: "Extracted text" }), copy),
        el("pre", { className: "lx-plaintext", textContent: text.replace(/\f/g, "\n— page break —\n") }));
    } else {
      panel.append(el("p", { className: "lx-empty", textContent: "Build the document to see its text." }));
    }
    root.replaceChildren(panel);
  }

  return { run, text: () => text };
}
