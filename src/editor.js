import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment, EditorSelection } from "@codemirror/state";
import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { indentWithTab } from "@codemirror/commands";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags as t } from "@lezer/highlight";

const theme = EditorView.theme({
  "&": { color: "#f3f2f1", backgroundColor: "#0b0c0c", height: "100%" },
  ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "var(--editor-size, 14px)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "#ffdd00", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#ffdd00", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "#14406a" },
  ".cm-gutters": { backgroundColor: "#0b0c0c", color: "#6f777b", borderRight: "1px solid #25292b" },
  ".cm-activeLine": { backgroundColor: "#131617" },
  ".cm-activeLineGutter": { backgroundColor: "#131617", color: "#f3f2f1" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "#1d70b855", outline: "1px solid #5694ca" },
  ".cm-searchMatch": { backgroundColor: "#ffdd0033", outline: "1px solid #ffdd0088" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#ffdd0066" },
  ".cm-selectionMatch": { backgroundColor: "#ffffff14" },
  ".cm-foldPlaceholder": { backgroundColor: "#1d2022", border: "1px solid #383f43", color: "#b1b4b6" },
  ".cm-panels": { backgroundColor: "#1d2022", color: "#f3f2f1", borderColor: "#383f43" },
  ".cm-panels input, .cm-panels button": { fontFamily: "var(--font)" },
  ".cm-textfield": { backgroundColor: "#0b0c0c", border: "2px solid #f3f2f1", color: "#f3f2f1", borderRadius: "0" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "#f3f2f1", color: "#0b0c0c", borderRadius: "0", border: "0" },
  ".cm-tooltip": { backgroundColor: "#1d2022", border: "1px solid #383f43", color: "#f3f2f1" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#1d70b8", color: "#fff" },
  ".lx-jump": { backgroundColor: "#ffdd0040" },
}, { dark: true });

// GOV.UK palette, brightened for a dark ground.
const highlight = HighlightStyle.define([
  { tag: t.tagName, color: "#5694ca" },                        // \commands
  { tag: t.keyword, color: "#ffdd00" },                        // math
  { tag: t.special(t.variableName), color: "#28a197" },        // environment names
  { tag: t.variableName, color: "#f3f2f1" },
  { tag: t.atom, color: "#f499be" },
  { tag: t.number, color: "#f47738" },
  { tag: t.bracket, color: "#b1b4b6" },
  { tag: t.string, color: "#85994b" },
  { tag: t.comment, color: "#6f777b", fontStyle: "italic" },
  { tag: t.invalid, color: "#ff8a78" },
]);

const lang = StreamLanguage.define(stex);

export class Editor {
  constructor(parent, { onChange, onCursor }) {
    this.onChange = onChange;
    this.docs = new Map(); // path -> { state, saved }
    this.path = null;
    this.readOnly = new Compartment();
    this.extensions = [
      basicSetup,
      lang,
      syntaxHighlighting(highlight),
      theme,
      indentUnit.of("  "),
      EditorView.lineWrapping,
      keymap.of([indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) this.onChange(this.path);
        if (u.docChanged || u.selectionSet) onCursor();
      }),
    ];
    this.view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions: this.extensions }) });
  }

  has(path) { return this.docs.has(path); }

  text(path = this.path) {
    if (path === this.path) return this.view.state.doc.toString();
    return this.docs.get(path)?.state.doc.toString() ?? null;
  }

  isDirty(path = this.path) {
    const d = this.docs.get(path);
    return !!d && this.text(path) !== d.saved;
  }

  dirtyPaths() { return [...this.docs.keys()].filter((p) => this.isDirty(p)); }

  markSaved(path, text) { const d = this.docs.get(path); if (d) d.saved = text; }

  load(path, text) {
    this.docs.set(path, { state: EditorState.create({ doc: text, extensions: this.extensions }), saved: text });
  }

  open(path) {
    if (this.path && this.docs.has(this.path)) this.docs.get(this.path).state = this.view.state;
    this.path = path;
    this.view.setState(this.docs.get(path).state);
    this.view.focus();
  }

  // Apply an on-disk change as the smallest edit, so the cursor and scroll
  // position survive when Claude rewrites a few lines elsewhere in the file.
  applyExternal(path, next) {
    const cur = this.text(path);
    let s = 0;
    const max = Math.min(cur.length, next.length);
    while (s < max && cur.charCodeAt(s) === next.charCodeAt(s)) s++;
    let e = 0;
    while (e < max - s && cur.charCodeAt(cur.length - 1 - e) === next.charCodeAt(next.length - 1 - e)) e++;
    const change = { from: s, to: cur.length - e, insert: next.slice(s, next.length - e) };
    if (path === this.path) {
      this.view.dispatch({ changes: change });
    } else {
      const d = this.docs.get(path);
      d.state = d.state.update({ changes: change }).state;
    }
    this.markSaved(path, next);
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

  goto(line) {
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    this.view.dispatch({
      selection: EditorSelection.cursor(l.from),
      effects: EditorView.scrollIntoView(l.from, { y: "center" }),
    });
    this.view.focus();
  }
}
