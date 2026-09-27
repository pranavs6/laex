// Spelling for LaTeX source. Only prose is checked: the preamble, comments,
// maths, command names, URLs and the arguments of technical commands
// (\usepackage{...}, \href{url}, \begin{env}, ...) are masked out first.

// Commands whose brace arguments are not prose. The number is how many
// leading {...} groups to skip; Infinity skips every group that follows.
const SKIP_ARGS = {
  href: 1, url: Infinity, nolinkurl: Infinity, usepackage: Infinity, RequirePackage: Infinity, documentclass: Infinity,
  begin: 1, end: 1, label: Infinity, ref: Infinity, eqref: Infinity, pageref: Infinity, cite: Infinity, citep: Infinity, citet: Infinity,
  input: Infinity, include: Infinity, includegraphics: Infinity, bibliography: Infinity, bibliographystyle: Infinity,
  definecolor: Infinity, colorlet: Infinity, color: 1, textcolor: 1, hypersetup: Infinity, urlstyle: Infinity,
  setlength: Infinity, addtolength: Infinity, vspace: Infinity, hspace: Infinity, rule: Infinity, raisebox: 1, scalebox: 1,
  newcommand: Infinity, renewcommand: Infinity, providecommand: Infinity, newenvironment: Infinity, renewenvironment: Infinity,
  def: Infinity, titleformat: Infinity, titlespacing: Infinity, setlist: Infinity, pagestyle: Infinity, thispagestyle: Infinity,
  fontsize: Infinity, fontfamily: Infinity, geometry: Infinity, pdfbookmark: 1, pgfkeys: Infinity, tikz: Infinity,
  setmainfont: Infinity, setsansfont: Infinity, setmonofont: Infinity, newfontfamily: Infinity, faIcon: Infinity,
};

function skipGroup(text, i, open, close) {
  if (text[i] !== open) return i;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "\\") { j++; continue; }
    if (text[j] === open) depth++;
    else if (text[j] === close && --depth === 0) return j + 1;
  }
  return text.length;
}

export function tokenize(text, { tex = true } = {}) {
  const mask = new Uint8Array(text.length); // 1 = not prose
  const hide = (a, b) => mask.fill(1, a, b);

  if (tex) {
    const start = text.indexOf("\\begin{document}");
    if (start > 0) hide(0, start);
    // Comments
    for (const m of text.matchAll(/(^|[^\\])(%.*)$/gm)) hide(m.index + m[1].length, m.index + m[0].length);
    // Maths
    for (const m of text.matchAll(/\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\\])*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g)) hide(m.index, m.index + m[0].length);
    // Commands and their technical arguments
    for (const m of text.matchAll(/\\([A-Za-z@]+)\*?|\\./g)) {
      let end = m.index + m[0].length;
      hide(m.index, end);
      const n = SKIP_ARGS[m[1]];
      if (!n) continue;
      let groups = 0;
      while (groups < n) {
        while (text[end] === " ") end++;
        if (text[end] === "[") { const e = skipGroup(text, end, "[", "]"); hide(end, e); end = e; continue; }
        if (text[end] !== "{") break;
        const e = skipGroup(text, end, "{", "}");
        hide(end, e);
        end = e;
        groups++;
      }
    }
  }
  // URLs and email addresses
  for (const m of text.matchAll(/\b(?:https?:\/\/|www\.)\S+|\S+@\S+\.\w+/g)) hide(m.index, m.index + m[0].length);

  const words = [];
  for (const m of text.matchAll(/\p{L}[\p{L}'’]*\p{L}|\p{L}/gu)) {
    const from = m.index, to = from + m[0].length;
    if (mask[from] || mask[to - 1]) continue;
    const w = m[0];
    // Skip acronyms, words glued to digits (p99, S3), and pieces of dotted or
    // slashed names (Node.js, CI/CD, en-GB).
    if (w.length < 2 || /^\p{Lu}{2,6}s?$/u.test(w) || /[\d./]/.test(text[from - 1] || "") || /\d|\.\p{L}|\/\p{L}/u.test(text.slice(to, to + 2))) continue;
    words.push({ word: w, from, to });
  }
  return words;
}

export class Spell {
  constructor({ onDiagnostics, addWord }) {
    this.onDiagnostics = onDiagnostics;
    this.addWord = addWord;
    this.worker = null;
    this.ready = null;
    this.ignored = new Set();
    this.seq = 0;
    this.pending = new Map();
    this.suggestions = new Map();
  }

  async init(lang, words) {
    this.worker?.terminate();
    this.worker = new Worker("/build/spell-worker.js", { type: "module" });
    this.worker.onmessage = ({ data }) => this.onMessage(data);
    const dict = await fetch(`/api/dict?lang=${encodeURIComponent(lang)}`).then((r) => r.json());
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    this.worker.postMessage({ type: "init", aff: dict.aff, dic: dict.dic, words });
    return this.ready;
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
  }

  onMessage(data) {
    if (data.type === "ready") return this.resolveReady?.();
    const job = this.pending.get(data.id);
    if (!job) return;
    if (data.type === "checked") {
      job.bad = new Set(data.bad);
      this.emit(job);
    } else if (data.type === "suggestions") {
      for (const [w, s] of Object.entries(data.suggestions)) this.suggestions.set(w, s);
      this.emit(job);
      this.pending.delete(data.id);
    }
  }

  check(path, text) {
    if (!this.worker) return;
    const tokens = tokenize(text, { tex: !/\.(md|txt)$/.test(path) });
    const id = ++this.seq;
    // Drop older jobs for the same file.
    for (const [k, j] of this.pending) if (j.path === path) this.pending.delete(k);
    this.pending.set(id, { path, tokens });
    const words = [...new Set(tokens.map((t) => t.word))].filter((w) => !this.ignored.has(w));
    this.worker.postMessage({ type: "check", id, words });
  }

  emit(job) {
    const list = [];
    for (const t of job.tokens) {
      if (!job.bad?.has(t.word) || this.ignored.has(t.word)) continue;
      const sugg = this.suggestions.get(t.word) || [];
      list.push({
        from: t.from, to: t.to, word: t.word,
        message: sugg.length ? `Possible misspelling. Did you mean ${sugg.map((s) => `"${s}"`).join(", ")}?` : "Possible misspelling.",
        actions: [
          ...sugg.map((s) => ({ name: s, apply: (view, from, to) => view.dispatch({ changes: { from, to, insert: s } }) })),
          { name: "Add to dictionary", apply: () => this.add(t.word) },
          { name: "Ignore", apply: () => this.ignore(t.word) },
        ],
      });
    }
    this.onDiagnostics(job.path, list);
  }

  add(word) {
    this.worker?.postMessage({ type: "add", word });
    this.addWord(word);
    this.ignored.add(word);
    for (const job of this.pending.values()) this.emit(job);
    this.recheck?.();
  }

  ignore(word) {
    this.ignored.add(word);
    this.recheck?.();
  }
}
