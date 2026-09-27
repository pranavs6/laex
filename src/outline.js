// Outline of the open document: sections, then entries such as roles and
// projects (any command whose name looks like a heading), for quick jumps.

const ENTRY = /^(?:company|role|position|job|employer|project|entry|cventry|resumeSubheading|resumeSingleSubheading|resumeProjectHeading|resumeSubSubheading|subheading|experience|education|school|degree|award)$/i;

export function parseOutline(text) {
  const items = [];
  const lines = text.split("\n");
  const docStart = lines.findIndex((l) => l.includes("\\begin{document}"));
  lines.forEach((line, i) => {
    if (i < docStart) return;
    const code = line.replace(/(^|[^\\])%.*$/, "$1");
    for (const m of code.matchAll(/\\([A-Za-z]+)\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
      const [, cmd, arg] = m;
      let level = 0;
      if (/^(part|chapter|section)$/.test(cmd)) level = 1;
      else if (/^(subsection|subsubsection|paragraph)$/.test(cmd)) level = 2;
      else if (ENTRY.test(cmd)) level = 2;
      if (!level) continue;
      const label = arg.replace(/\\(?:textbf|textit|emph|large|Large|small|normalfont|scshape|bfseries|color)\b(?:\{[^}]*\})?/g, "")
        .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, "$1").replace(/\\[A-Za-z]+/g, "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
      if (!label) continue;
      items.push({ level, label, line: i + 1, cmd });
      break;
    }
  });
  return items;
}

export function initOutline(app) {
  const { $, el } = app;
  const root = $("outline");
  let items = [];
  let current = -1;

  function refresh() {
    const path = app.editor.path;
    items = path && /\.tex$/.test(path) ? parseOutline(app.editor.text()) : [];
    render();
  }

  function render() {
    root.replaceChildren();
    if (!items.length) {
      root.append(el("li", { className: "lx-empty", textContent: app.editor.path ? "No sections found in this file." : "Open a file to see its outline." }));
      return;
    }
    items.forEach((it, idx) => {
      const b = el("button", { type: "button", className: `lx-outline__item lx-outline__item--${it.level}`, title: `Line ${it.line}` },
        el("span", { className: "lx-outline__label", textContent: it.label }),
        el("span", { className: "lx-outline__line", textContent: String(it.line) }));
      if (idx === current) b.setAttribute("aria-current", "true");
      b.addEventListener("click", () => app.editor.goto(it.line));
      root.append(el("li", {}, b));
    });
  }

  // Highlight the section the cursor is in.
  function cursor(line) {
    let idx = -1;
    for (let i = 0; i < items.length; i++) if (items[i].line <= line) idx = i;
    if (idx !== current) { current = idx; render(); }
  }

  return { refresh, cursor };
}
