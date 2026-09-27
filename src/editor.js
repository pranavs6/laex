import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment, EditorSelection } from "@codemirror/state";
import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { indentWithTab } from "@codemirror/commands";
import { snippetCompletion } from "@codemirror/autocomplete";
import { setDiagnostics, lintGutter } from "@codemirror/lint";
import { unifiedMergeView, getChunks, getOriginalDoc } from "@codemirror/merge";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags as t } from "@lezer/highlight";

// Colours come from CSS variables so the editor follows the light and dark
// themes without rebuilding its extensions.
export const theme = EditorView.theme({
  "&": { color: "var(--code-text)", backgroundColor: "var(--code-bg)", height: "100%" },
  ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "var(--editor-size, 14px)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--caret)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--caret)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--code-selection)" },
  ".cm-gutters": { backgroundColor: "var(--code-bg)", color: "var(--code-gutter)", borderRight: "1px solid var(--border-soft)" },
  ".cm-activeLine": { backgroundColor: "var(--code-active)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--code-active)", color: "var(--code-text)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "rgba(29,112,184,.33)", outline: "1px solid var(--link)" },
  ".cm-searchMatch": { backgroundColor: "rgba(255,221,0,.2)", outline: "1px solid rgba(255,221,0,.55)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(255,221,0,.45)" },
  ".cm-selectionMatch": { backgroundColor: "var(--code-match)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--card-head)", border: "1px solid var(--border)", color: "var(--text-2)" },
  ".cm-panels": { backgroundColor: "var(--card-head)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panels input, .cm-panels button, .cm-panels label": { fontFamily: "var(--font)" },
  ".cm-textfield": { backgroundColor: "var(--code-bg)", border: "2px solid var(--text)", color: "var(--text)", borderRadius: "0" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "#f3f2f1", color: "#0b0c0c", borderRadius: "0", border: "0" },
  ".cm-tooltip": { backgroundColor: "var(--card-head)", border: "1px solid var(--border)", color: "var(--text)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--blue)", color: "#fff" },
  ".cm-diagnostic": { fontFamily: "var(--font)", padding: "6px 10px" },
  ".cm-diagnostic-error": { borderLeft: "5px solid var(--red)" },
  ".cm-diagnostic-warning": { borderLeft: "5px solid var(--orange)" },
  ".cm-diagnostic-info": { borderLeft: "5px solid var(--blue)" },
  ".cm-diagnosticAction": { backgroundColor: "var(--blue)", borderRadius: "0", padding: "2px 8px", font: "inherit" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--red)", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--orange)", textUnderlineOffset: "3px" },
  ".cm-lintRange-info": { backgroundImage: "none", textDecoration: "underline dotted var(--link)", textDecorationThickness: "2px", textUnderlineOffset: "3px" },
  ".cm-changedLine": { backgroundColor: "var(--diff-ins-line) !important" },
  ".cm-changedText": { background: "var(--diff-ins-text) !important" },
  ".cm-deletedChunk": { backgroundColor: "var(--diff-del-line)", paddingLeft: "6px" },
  ".cm-deletedChunk .cm-deletedText": { background: "var(--diff-del-text)" },
  ".cm-insertedLine, .cm-deletedLine": { textDecoration: "none" },
  ".cm-chunkButtons button": { fontFamily: "var(--font)", border: "0", padding: "2px 8px", marginRight: "6px", cursor: "pointer", borderRadius: "0" },
  ".cm-chunkButtons button[name=accept]": { background: "var(--green)", color: "#fff" },
  ".cm-chunkButtons button[name=reject]": { background: "var(--red)", color: "#fff" },
  ".cm-changeGutter": { width: "4px" },
  ".cm-changedLineGutter": { background: "var(--green-bright)" },
  ".cm-deletedLineGutter": { background: "var(--red)" },
}, { dark: true });

// GOV.UK palette. Values are CSS variables so light and dark both work.
export const highlight = HighlightStyle.define([
  { tag: t.tagName, color: "var(--hl-command)" },
  { tag: t.keyword, color: "var(--hl-math)" },
  { tag: t.special(t.variableName), color: "var(--hl-env)" },
  { tag: t.variableName, color: "var(--code-text)" },
  { tag: t.atom, color: "var(--hl-atom)" },
  { tag: t.number, color: "var(--hl-number)" },
  { tag: t.bracket, color: "var(--hl-bracket)" },
  { tag: t.string, color: "var(--hl-string)" },
  { tag: t.comment, color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: t.invalid, color: "var(--red-light)" },
]);

export const lang = StreamLanguage.define(stex);

// ----------------------------------------------------------------- snippets
const BUILTIN_SNIPPETS = [
  ["\\begin{itemize}", "\\begin{itemize}\n  \\item ${}\n\\end{itemize}", "list"],
  ["\\begin{enumerate}", "\\begin{enumerate}\n  \\item ${}\n\\end{enumerate}", "numbered list"],
  ["\\begin{env}", "\\begin{${env}}\n  ${}\n\\end{${env}}", "environment"],
  ["\\item", "\\item ${}", "bullet"],
  ["\\textbf", "\\textbf{${}}", "bold"],
  ["\\textit", "\\textit{${}}", "italic"],
  ["\\emph", "\\emph{${}}", "emphasis"],
  ["\\underline", "\\underline{${}}", "underline"],
  ["\\href", "\\href{${url}}{${text}}", "link"],
  ["\\url", "\\url{${}}", "url"],
  ["\\section", "\\section{${}}", "section"],
  ["\\subsection", "\\subsection{${}}", "subsection"],
  ["\\vspace", "\\vspace{${2pt}}", "vertical space"],
  ["\\hspace", "\\hspace{${2pt}}", "horizontal space"],
  ["\\usepackage", "\\usepackage{${}}", "package"],
  ["\\newcommand", "\\newcommand{\\\\${name}}[${1}]{${}}", "macro"],
];

// Macros defined in the document (\newcommand{\role}[2]{...}) become
// snippets with one field per argument.
export function macroSnippets(text) {
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(/\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z]+)\}?\s*(?:\[(\d)\])?/g)) {
    const [, name, n] = m;
    if (seen.has(name)) continue;
    seen.add(name);
    const args = Number(n || 0);
    const fields = Array.from({ length: args }, (_, i) => `{\${${i + 1}}}`).join("");
    out.push(snippetCompletion(`\\${name}${fields}`, { label: `\\${name}`, detail: args ? `${args} argument${args > 1 ? "s" : ""}` : "macro", type: "function", boost: 5 }));
  }
  return out;
}

const builtin = BUILTIN_SNIPPETS.map(([label, tpl, detail]) =>
  snippetCompletion(tpl.replace(/\\\\/g, "\\"), { label, detail, type: "keyword" }));

function texCompletions(getMacros) {
  return (ctx) => {
    const word = ctx.matchBefore(/\\[A-Za-z]*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    return { from: word.from, options: [...getMacros(), ...builtin], validFor: /^\\[A-Za-z]*$/ };
  };
}

// Accept/reject buttons that work with a click or the keyboard (the
// library's default ones only listen for mousedown).
function chunkButton(type, action) {
  const b = document.createElement("button");
  b.type = "button";
  b.name = type;
  b.textContent = type === "accept" ? "Accept" : "Reject";
  b.title = type === "accept" ? "Keep this change" : "Undo this change";
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", action);
  return b;
}

// ------------------------------------------------------------------- editor
export class Editor {
  constructor(parent, { onChange, onCursor, getMacros, onReviewDone, onReviewChange }) {
    this.onChange = onChange;
    this.onReviewDone = onReviewDone;
    this.docs = new Map(); // path -> { state, saved, diagnostics: { build, spell } }
    this.path = null;
    this.review = new Compartment();
    // One source function for the editor's lifetime: the completion system
    // tracks sources by identity, so a new function per lookup never settles.
    const completions = texCompletions(getMacros);
    this.extensions = [
      basicSetup,
      lang,
      syntaxHighlighting(highlight),
      theme,
      indentUnit.of("  "),
      EditorView.lineWrapping,
      lintGutter(),
      EditorState.languageData.of(() => [{ autocomplete: completions }]),
      keymap.of([indentWithTab]),
      this.review.of([]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) this.onChange(this.path);
        if (u.docChanged || u.selectionSet) onCursor();
        // Accepting a chunk changes only the comparison base, not the text,
        // so watch the chunk count rather than doc changes.
        const before = getChunks(u.startState)?.chunks.length ?? 0;
        const after = getChunks(u.state)?.chunks.length ?? 0;
        if (before && after !== before) {
          setTimeout(() => {
            if (!after) this.endReview();
            else { this.gotoChunk(1); onReviewChange?.(); }
          }, 0);
        }
      }),
    ];
    this.view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions: this.extensions }) });
  }

  has(path) { return this.docs.has(path); }

  stateOf(path) {
    return path === this.path ? this.view.state : this.docs.get(path)?.state;
  }

  text(path = this.path) {
    return this.stateOf(path)?.doc.toString() ?? null;
  }

  isDirty(path = this.path) {
    const d = this.docs.get(path);
    return !!d && this.text(path) !== d.saved;
  }

  dirtyPaths() { return [...this.docs.keys()].filter((p) => this.isDirty(p)); }

  markSaved(path, text) { const d = this.docs.get(path); if (d) d.saved = text; }

  load(path, text) {
    this.docs.set(path, {
      state: EditorState.create({ doc: text, extensions: this.extensions }),
      saved: text,
      diagnostics: { build: [], spell: [] },
    });
  }

  open(path) {
    if (this.path && this.docs.has(this.path)) this.docs.get(this.path).state = this.view.state;
    this.path = path;
    this.view.setState(this.docs.get(path).state);
    this.applyDiagnostics(path);
    const first = this.chunkList()[0];
    if (first) this.revealChange(first.fromB);
    this.view.focus();
  }

  // Apply an on-disk change as the smallest edit, so the cursor and scroll
  // position survive. With `review`, the change is shown as a diff against
  // what was there before, with accept/reject on each chunk.
  applyExternal(path, next, { review = false } = {}) {
    const cur = this.text(path);
    let s = 0;
    const max = Math.min(cur.length, next.length);
    while (s < max && cur.charCodeAt(s) === next.charCodeAt(s)) s++;
    let e = 0;
    while (e < max - s && cur.charCodeAt(cur.length - 1 - e) === next.charCodeAt(next.length - 1 - e)) e++;
    const change = { from: s, to: cur.length - e, insert: next.slice(s, next.length - e) };
    const spec = { changes: change };
    // Start a review against the pre-change text, unless one is already
    // running (then the original stays as it was before the first change).
    if (review && !this.reviewing(path)) {
      spec.effects = this.review.reconfigure(unifiedMergeView({
        original: cur, mergeControls: chunkButton, gutter: true, highlightChanges: true, allowInlineDiffs: true, syntaxHighlightDeletions: true,
      }));
    }
    if (path === this.path) {
      this.view.dispatch(spec);
      // Bring the change into view; otherwise an edit further down the
      // file leaves the review banner with nothing visible to review.
      if (review) this.revealChange(s);
    } else {
      const d = this.docs.get(path);
      d.state = d.state.update(spec).state;
    }
    this.markSaved(path, next);
  }

  // Changed chunks in the current file, in document order.
  chunkList() {
    const c = getChunks(this.view.state);
    return c ? [...c.chunks] : [];
  }

  // Which chunk the cursor is in or just before, 0-based, or -1.
  chunkIndex() {
    const head = this.view.state.selection.main.head;
    const list = this.chunkList();
    let idx = -1;
    list.forEach((ch, i) => { if (ch.fromB <= head) idx = i; });
    return idx;
  }

  revealChange(pos) {
    const at = Math.min(pos, this.view.state.doc.length);
    this.view.dispatch({
      selection: EditorSelection.cursor(at),
      effects: EditorView.scrollIntoView(at, { y: "center" }),
    });
  }

  // Move to the next (dir = 1) or previous (dir = -1) changed chunk, wrapping.
  gotoChunk(dir) {
    const list = this.chunkList();
    if (!list.length) return -1;
    const head = this.view.state.selection.main.head;
    let i;
    if (dir > 0) i = list.findIndex((ch) => ch.fromB > head);
    else i = list.map((ch) => ch.fromB < head).lastIndexOf(true);
    if (i < 0) i = dir > 0 ? 0 : list.length - 1;
    this.revealChange(list[i].fromB);
    return i;
  }

  reviewing(path = this.path) {
    const st = this.stateOf(path);
    return !!st && !!getChunks(st);
  }

  reviewChunks(path = this.path) {
    const st = this.stateOf(path);
    return st ? getChunks(st)?.chunks.length || 0 : 0;
  }

  // Keep the current text (accept every chunk).
  acceptAll() { this.endReview(); }

  // Go back to the text before the outside change (reject every chunk).
  rejectAll() {
    if (!this.reviewing()) return;
    const original = getOriginalDoc(this.view.state).toString();
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: original } });
    this.endReview();
  }

  endReview() {
    if (!this.reviewing()) return;
    this.view.dispatch({ effects: this.review.reconfigure([]) });
    this.onReviewDone?.(this.path);
  }

  // Diagnostics: build errors and warnings, and spelling, kept per file and
  // merged when shown.
  setDiagnostics(path, kind, list) {
    const d = this.docs.get(path);
    if (!d) return;
    d.diagnostics[kind] = list;
    if (path === this.path) this.applyDiagnostics(path);
  }

  applyDiagnostics(path) {
    const d = this.docs.get(path);
    if (!d || path !== this.path) return;
    const doc = this.view.state.doc;
    const out = [];
    for (const g of d.diagnostics.build) {
      if (g.line < 1 || g.line > doc.lines) continue;
      const l = doc.line(g.line);
      const from = l.from + (l.text.length - l.text.trimStart().length);
      out.push({ from, to: Math.max(from, l.to), severity: g.severity, message: g.message, source: "build" });
    }
    for (const g of d.diagnostics.spell) {
      if (g.to > doc.length || doc.sliceString(g.from, g.to) !== g.word) continue;
      out.push({ ...g, severity: "info", source: "spelling" });
    }
    this.view.dispatch(setDiagnostics(this.view.state, out));
  }

  // Cursor and selection, 1-based, for Claude's context.
  cursorInfo() {
    const st = this.view.state;
    const sel = st.selection.main;
    const line = st.doc.lineAt(sel.head);
    return {
      line: line.number, col: sel.head - line.from + 1,
      selection: sel.empty ? "" : st.sliceDoc(sel.from, sel.to),
      selFrom: st.doc.lineAt(sel.from).number, selTo: st.doc.lineAt(sel.to).number,
    };
  }

  // Forget a file (deleted) or everything under a folder.
  drop(prefix) {
    for (const p of [...this.docs.keys()]) {
      if (p === prefix || p.startsWith(prefix + "/")) this.docs.delete(p);
    }
    if (this.path && !this.docs.has(this.path)) {
      this.path = null;
      this.view.setState(EditorState.create({ doc: "", extensions: this.extensions }));
    }
  }

  // Follow a rename of a file or folder, keeping undo history.
  rename(from, to) {
    if (this.path && this.docs.has(this.path)) this.docs.get(this.path).state = this.view.state;
    const moved = [];
    for (const [p, d] of [...this.docs]) {
      if (p === from || p.startsWith(from + "/")) {
        this.docs.delete(p);
        const np = to + p.slice(from.length);
        this.docs.set(np, d);
        moved.push([p, np]);
      }
    }
    for (const [p, np] of moved) if (this.path === p) this.path = np;
  }

  goto(line, col = 1, len = 0) {
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const from = Math.min(l.to, l.from + Math.max(0, col - 1));
    this.view.dispatch({
      selection: len ? EditorSelection.range(from, Math.min(l.to, from + len)) : EditorSelection.cursor(from),
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    this.view.focus();
  }
}
