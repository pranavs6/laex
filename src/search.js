// Find and replace across the project.

export function initSearch(app) {
  const { $, el, api } = app;
  const q = $("search-q");
  const rep = $("search-r");
  const opts = { caseSensitive: $("search-case"), wholeWord: $("search-word"), regex: $("search-regex") };
  const out = $("search-results");
  const summary = $("search-summary");
  let timer = null;
  let last = null;

  const params = () => ({
    q: q.value, caseSensitive: opts.caseSensitive.checked, wholeWord: opts.wholeWord.checked, regex: opts.regex.checked,
  });

  async function run() {
    const p = params();
    if (!p.q) { out.replaceChildren(); summary.textContent = ""; last = null; return; }
    await app.saveAll();
    try {
      last = await api.post("/api/search", p);
    } catch (e) {
      summary.textContent = e.message;
      out.replaceChildren();
      return;
    }
    const files = last.results.length;
    summary.textContent = last.total
      ? `${last.total}${last.truncated ? "+" : ""} result${last.total === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`
      : "No results";
    render(p);
  }

  function highlightLine(text, col, len) {
    const start = Math.max(0, col - 1 - 30);
    const pre = (start ? "…" : "") + text.slice(start, col - 1);
    return [pre, el("mark", { textContent: text.slice(col - 1, col - 1 + len) }), text.slice(col - 1 + len, col - 1 + len + 80)];
  }

  function render() {
    out.replaceChildren();
    for (const r of last.results) {
      out.append(el("li", { className: "lx-search__file" }, el("span", { textContent: r.file }), el("span", { className: "lx-search__count", textContent: String(r.matches.length) })));
      for (const m of r.matches.slice(0, 200)) {
        const b = el("button", { type: "button", className: "lx-search__hit" },
          el("span", { className: "lx-search__line", textContent: String(m.line) }),
          el("span", { className: "lx-search__text" }, ...highlightLine(m.text, m.col, m.len)));
        b.addEventListener("click", () => app.openFile(r.file, m.line, m.col, m.len));
        out.append(el("li", {}, b));
      }
    }
  }

  async function replaceAll() {
    const p = params();
    if (!p.q || !last?.total) return;
    const ok = await app.ask({
      title: "Replace all", confirm: `Replace ${last.total}`,
      message: `Replace ${last.total} match${last.total === 1 ? "" : "es"} of "${p.q}" with "${rep.value}" in ${last.results.length} file${last.results.length === 1 ? "" : "s"}? Save a version first if you may want to undo it.`,
    });
    if (ok === null) return;
    await app.saveAll();
    const r = await api.post("/api/replace", { ...p, replacement: rep.value });
    for (const c of r.changed) app.onReplaced(c.file, c.text);
    app.setStatus("Replaced", "green", `Replaced ${r.count} match${r.count === 1 ? "" : "es"} in ${r.changed.length} file${r.changed.length === 1 ? "" : "s"}.`);
    run();
  }

  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  Object.values(opts).forEach((c) => c.addEventListener("change", run));
  $("search-form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
  $("search-replace-all").addEventListener("click", replaceAll);

  return {
    focus(text) {
      if (text) q.value = text;
      q.focus();
      q.select();
      run();
    },
  };
}
