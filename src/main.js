import { Editor } from "./editor.js";
import { Term } from "./terminal.js";
import { PdfView } from "./pdf.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

// The Claude system prompt is edited like a file but lives in ~/.config/laex.
const PROMPT = "@prompt";
const API_VERSION = 2;

// ---------------------------------------------------------------- storage
let project;
const store = {
  key: (k) => `laex:${project.root}:${k}`,
  get(k, dflt) {
    const v = localStorage.getItem(store.key(k));
    return v === null ? dflt : JSON.parse(v);
  },
  set(k, v) { localStorage.setItem(store.key(k), JSON.stringify(v)); },
};
const globalStore = {
  get(k, dflt) { const v = localStorage.getItem(`laex:${k}`); return v === null ? dflt : JSON.parse(v); },
  set(k, v) { localStorage.setItem(`laex:${k}`, JSON.stringify(v)); },
};

const api = {
  async json(url, opts) {
    const r = await fetch(url, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  },
  post(url, data) {
    return api.json(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  },
  async read(path) {
    const r = await fetch(path === PROMPT ? "/api/prompt" : `/api/file?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error(`Could not open ${path}`);
    return r.text();
  },
  write(path, text) {
    const url = path === PROMPT ? "/api/prompt" : `/api/file?path=${encodeURIComponent(path)}`;
    return api.json(url, { method: "PUT", body: text });
  },
  compile: (main, engine) => api.post("/api/compile", { main, engine }),
  fs: (op) => api.post("/api/fs", op),
};

// -------------------------------------------------------------- shortcuts
const ACTIONS = {
  compile:  { label: "Recompile", key: "Meta+Enter" },
  save:     { label: "Save and recompile", key: "Meta+S" },
  download: { label: "Download PDF", key: "Meta+D" },
  files:    { label: "Show or hide files", key: "Meta+B" },
  editor:   { label: "Focus editor", key: "Meta+1" },
  terminal: { label: "Focus terminal", key: "Meta+2" },
};
let shortcuts = {};

function comboOf(e) {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
  return [...mods, key].join("+");
}

const MAC = /Mac/.test(navigator.platform);
function showCombo(combo) {
  if (!combo) return "None";
  const sym = MAC ? { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↩", Backspace: "⌫" } : { Meta: "Win" };
  return combo.split("+").map((p) => sym[p] || p).join(MAC ? "" : "+");
}

function renderShortcuts() {
  const dl = $("shortcuts");
  dl.replaceChildren();
  const used = Object.values(shortcuts).filter(Boolean);
  for (const [id, a] of Object.entries(ACTIONS)) {
    const input = el("input", {
      className: "lx-key", readOnly: true, value: showCombo(shortcuts[id]), id: `key-${id}`,
      title: shortcuts[id] || "No shortcut",
    });
    input.dataset.action = id;
    if (shortcuts[id] && used.filter((k) => k === shortcuts[id]).length > 1) input.classList.add("is-conflict");
    input.addEventListener("keydown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Tab") return;
      if (e.key === "Escape") { input.blur(); return; }
      if (e.key === "Backspace" || e.key === "Delete") { setShortcut(id, ""); return; }
      const combo = comboOf(e);
      if (combo) setShortcut(id, combo);
    });
    dl.append(el("dt", {}, el("label", { htmlFor: input.id, textContent: a.label })), el("dd", {}, input));
  }
}

function setShortcut(id, combo) {
  shortcuts[id] = combo;
  globalStore.set("shortcuts", shortcuts);
  renderShortcuts();
  $(`key-${id}`).focus();
  applyShortcutTitles();
}

function applyShortcutTitles() {
  const keys = $("footer-keys");
  keys.replaceChildren();
  for (const id of ["compile", "download", "files", "editor", "terminal"]) {
    if (!shortcuts[id]) continue;
    if (keys.childNodes.length) keys.append("   ");
    keys.append(el("kbd", { textContent: showCombo(shortcuts[id]) }), ` ${ACTIONS[id].label.toLowerCase()}`);
  }
  $("compile").title = `Recompile (${showCombo(shortcuts.compile)})`;
  $("download").title = `Download PDF (${showCombo(shortcuts.download)})`;
}

// ------------------------------------------------------------------ status
function setStatus(text, colour, message) {
  const s = $("status");
  s.textContent = text;
  s.className = `lx-tag lx-tag--${colour}`;
  if (message !== undefined) $("build-msg").textContent = message;
}

// -------------------------------------------------------------------- state
let editor, term, pdf;
let settings;
let needsCompile = false;
let compiling = false;
let queued = false;
let conflict = null; // { path, content }
let tick = null;

function fillSelect(sel, items, value) {
  sel.replaceChildren(...items.map((f) => new Option(f, f)));
  if (value && items.includes(value)) sel.value = value;
}

function label(path) { return path === PROMPT ? "Claude system prompt" : path; }

let lastDirty = "";
function updateDirty() {
  const d = editor.path && editor.isDirty();
  const dirtyKey = editor.dirtyPaths().join("\0");
  if (dirtyKey !== lastDirty) { lastDirty = dirtyKey; renderTree(); }
  $("dirty").textContent = !editor.path ? "" : d ? "Unsaved changes" : "Saved";
  $("current-file").textContent = editor.path ? label(editor.path) : "No file open";
  document.title = `${d ? "• " : ""}${editor.path ? label(editor.path) : project.name} - LAEX`;
  postState();
}

async function openFile(path, line) {
  if (!editor.has(path)) editor.load(path, await api.read(path));
  if (editor.path !== path) editor.open(path);
  if (path !== PROMPT) {
    store.set("open", path);
    revealInTree(path);
  }
  showConflict();
  updateDirty();
  renderTree();
  if (line) editor.goto(line);
}

async function saveAll() {
  for (const p of editor.dirtyPaths()) {
    const text = editor.text(p);
    await api.write(p, text);
    editor.markSaved(p, text);
    if (p !== PROMPT) needsCompile = true;
  }
  updateDirty();
}

// ---------------------------------------------------------- claude context
// Tell the server what's open so the `claude` hook can pass it along.
let stateTimer = null;
function postState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    if (!editor || !settings) return;
    const onFile = editor.path && editor.path !== PROMPT;
    api.post("/api/state", {
      file: onFile ? editor.path : null,
      ...(onFile ? editor.cursorInfo() : {}),
      dirty: onFile ? editor.isDirty() : false,
      main: settings.main,
      prompt: settings.claudePrompt,
    }).catch(() => {});
  }, 250);
}

// ----------------------------------------------------------------- compile
async function compile() {
  if (!settings.main) { setStatus("No document", "yellow", "Create a .tex file with \\documentclass to get started."); return; }
  if (compiling) { queued = true; return; }
  compiling = true;
  setStatus("Building", "blue", `Building ${settings.main}…`);
  $("compile").setAttribute("aria-disabled", "true");
  try {
    await saveAll();
    needsCompile = false;
    const r = await api.compile(settings.main, settings.engine);
    showErrors(r);
    if (r.pdf) await pdf.load(`/api/pdf?main=${encodeURIComponent(settings.main)}&v=${Date.now()}`);
    const bits = [];
    if (r.pages) bits.push(`${r.pages} page${r.pages > 1 ? "s" : ""}`);
    if (r.warnings) bits.push(`${r.warnings} warning${r.warnings > 1 ? "s" : ""}`);
    if (r.overfull) bits.push(`${r.overfull} overfull box${r.overfull > 1 ? "es" : ""}`);
    $("pdf-meta").textContent = bits.join(", ");
    const at = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const time = `${(r.ms / 1000).toFixed(1)} seconds`;
    if (r.errors.length) {
      const n = `${r.errors.length} error${r.errors.length > 1 ? "s" : ""}`;
      setStatus(n, "red", `${settings.main} has ${n}${r.fresh ? ", but the PDF was still built" : ""}. Last build at ${at}.`);
    } else {
      const pages = r.pages ? `, ${r.pages} page${r.pages > 1 ? "s" : ""}` : "";
      if (r.fresh) setStatus("Built", "green", `${settings.main} built in ${time} at ${at}${pages}.`);
      else setStatus("Up to date", "green", `${settings.main} is up to date. Checked at ${at}.`);
    }
    if (!$("log").hidden) loadLog();
    postState();
  } catch (e) {
    setStatus("Failed", "red", `The build could not run: ${e.message}`);
    showErrors({ errors: [{ file: settings.main, line: 1, message: e.message }] });
  } finally {
    compiling = false;
    $("compile").removeAttribute("aria-disabled");
    if (queued) { queued = false; compile(); }
  }
}

function showErrors(r) {
  const box = $("errors");
  const list = $("errors-list");
  list.replaceChildren();
  if (!r.errors?.length) { box.hidden = true; return; }
  $("errors-title").textContent = r.fresh ? "There is a problem (the PDF was still built)" : "There is a problem";
  for (const e of r.errors.slice(0, 20)) {
    const btn = el("button", { type: "button", textContent: `${e.file}:${e.line}: ${e.message}` });
    btn.addEventListener("click", () => openFile(e.file, e.line).catch(() => {}));
    list.append(el("li", {}, btn, e.context ? el("code", { textContent: e.context }) : null));
  }
  box.hidden = false;
}

async function loadLog() {
  const r = await fetch(`/api/log?main=${encodeURIComponent(settings.main)}`);
  const log = $("log");
  log.textContent = await r.text();
  log.scrollTop = log.scrollHeight;
}

function downloadUrl() {
  return settings.main ? `/api/pdf?main=${encodeURIComponent(settings.main)}&download=1` : "#";
}
function download() {
  if (!settings.main) return;
  el("a", { href: downloadUrl(), download: "" }).click();
}

// ------------------------------------------------------------ auto-refresh
function restartTick() {
  clearInterval(tick);
  if (!settings.auto) return;
  tick = setInterval(() => {
    if (editor.dirtyPaths().some((p) => p !== PROMPT)) needsCompile = true;
    if (needsCompile && !compiling) compile();
  }, Math.max(500, settings.interval * 1000));
}

// --------------------------------------------------------- disk changes
function showConflict() {
  const show = conflict && conflict.path === editor.path;
  $("conflict").hidden = !show;
  if (show) $("conflict-text").textContent = `${conflict.path} changed on disk while you had unsaved edits.`;
}

function onDiskChange(path, content) {
  if (!editor.has(path)) { needsCompile = true; return; }
  if (editor.text(path) === content) { editor.markSaved(path, content); updateDirty(); return; }
  if (!editor.isDirty(path)) {
    editor.applyExternal(path, content);
    needsCompile = true;
  } else {
    conflict = { path, content };
    showConflict();
  }
  updateDirty();
}

function applyProjectInfo(info) {
  project.tree = info.tree;
  project.files = info.files;
  project.mains = info.mains;
  if (!project.mains.includes(settings.main)) {
    settings.main = project.mains[0] || null;
    store.set("main", settings.main);
  }
  fillSelect($("main"), project.mains, settings.main);
  $("download").href = downloadUrl();
  showMainName();
  // Don't redraw under someone typing a file name; that input re-renders the
  // tree itself when it finishes.
  if (!document.activeElement?.classList.contains("lx-row__input")) renderTree();
}

function connectEvents() {
  const ws = new WebSocket(`ws://${location.host}/ws/events`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "file") onDiskChange(msg.path, msg.content);
    if (msg.type === "files") applyProjectInfo(msg);
    if (msg.type === "root" && msg.root !== project.root) location.reload();
  };
  ws.onclose = () => setTimeout(connectEvents, 1000);
}

// --------------------------------------------------------------- explorer
let expanded = new Set();
let selectedDir = "";
let treeEdit = null; // { kind: "new-file" | "new-folder" | "rename" | "delete", dir?, path? }
let treeError = "";

const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p) => p.slice(p.lastIndexOf("/") + 1);

function revealInTree(path) {
  let dir = parentOf(path);
  while (dir) { expanded.add(dir); dir = parentOf(dir); }
  store.set("expanded", [...expanded]);
}

function buildTree() {
  const root = { path: "", type: "dir", children: [] };
  const nodes = new Map([["", root]]);
  for (const e of project.tree) {
    const node = { ...e, name: baseOf(e.path), children: [] };
    nodes.set(e.path, node);
    (nodes.get(parentOf(e.path)) || root).children.push(node);
  }
  const sort = (n) => {
    n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

function inputRow(depth, value, onSubmit, placeholder) {
  const input = el("input", { className: "lx-row__input", value, placeholder, spellcheck: false });
  input.setAttribute("aria-label", placeholder || `New name for ${value}`);
  const row = el("div", { className: "lx-row" }, input);
  row.style.paddingLeft = `${12 + depth * 18}px`;
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    if (!commit || !input.value.trim() || input.value.trim() === value) { treeEdit = null; treeError = ""; renderTree(); return; }
    try {
      await onSubmit(input.value.trim());
      treeEdit = null;
      treeError = "";
    } catch (e) {
      treeError = e.message;
      done = false;
    }
    renderTree();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => setTimeout(() => finish(!!input.value.trim() && input.value.trim() !== value), 0));
  queueMicrotask(() => {
    input.focus();
    const dot = value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
  });
  return el("li", { role: "none" }, row);
}

function errorRow() {
  return treeError ? el("li", { className: "lx-list__error", role: "alert", textContent: treeError }) : null;
}

function renderTree() {
  if (!project?.tree) return;
  const ul = $("tree");
  const scroll = ul.scrollTop;
  ul.replaceChildren();
  const root = buildTree();

  const newRow = (dir, depth) => {
    if (!treeEdit || !["new-file", "new-folder"].includes(treeEdit.kind) || treeEdit.dir !== dir) return;
    const folder = treeEdit.kind === "new-folder";
    ul.append(inputRow(depth, "", async (name) => {
      if (!folder && !name.includes(".")) name += ".tex";
      const path = dir ? `${dir}/${name}` : name;
      applyProjectInfo(await api.fs({ op: folder ? "mkdir" : "mkfile", path }));
      if (folder) { expanded.add(path); selectedDir = path; }
      else await openFile(path);
    }, folder ? "Folder name" : "File name, for example cv.tex"));
    const err = errorRow();
    if (err) ul.append(err);
  };

  const walk = (node, depth) => {
    for (const n of node.children) {
      if (treeEdit?.kind === "rename" && treeEdit.path === n.path) {
        ul.append(inputRow(depth, n.name, async (name) => {
          const to = parentOf(n.path) ? `${parentOf(n.path)}/${name}` : name;
          await saveAll();
          const info = await api.fs({ op: "rename", path: n.path, to });
          editor.rename(n.path, to);
          if (settings.main === n.path || settings.main?.startsWith(n.path + "/")) {
            settings.main = to + settings.main.slice(n.path.length);
            store.set("main", settings.main);
          }
          if (expanded.has(n.path)) { expanded.delete(n.path); expanded.add(to); }
          applyProjectInfo(info);
          updateDirty();
        }));
        const err = errorRow();
        if (err) ul.append(err);
      } else {
        ul.append(treeRow(n, depth));
      }
      if (treeEdit?.kind === "delete" && treeEdit.path === n.path) ul.append(confirmRow(n));
      if (n.type === "dir" && expanded.has(n.path)) {
        newRow(n.path, depth + 1);
        walk(n, depth + 1);
      }
    }
  };
  newRow("", 0);
  walk(root, 0);
  if (!root.children.length && !treeEdit) ul.append(el("li", { className: "lx-empty", textContent: "This folder is empty. Select New file to start." }));
  ul.scrollTop = scroll;
}

function treeRow(n, depth) {
  const isDir = n.type === "dir";
  const isOpen = expanded.has(n.path);
  const isMain = n.path === settings.main;
  const isActive = !isDir && n.path === editor.path;
  const row = el("div", {
    className: `lx-row${isDir ? " lx-row--dir" : ""}`, tabIndex: 0, role: "treeitem", title: n.path,
  });
  row.style.paddingLeft = `${12 + depth * 18}px`;
  if (isDir) row.setAttribute("aria-expanded", String(isOpen));
  if (isActive) { row.classList.add("is-active"); row.setAttribute("aria-current", "true"); }
  if (isDir && n.path === selectedDir) row.classList.add("is-selected-dir");
  if (!isDir && !n.text) { row.classList.add("is-disabled"); row.title = `${n.path} cannot be edited here`; }

  if (isDir) row.append(el("span", { className: "lx-row__toggle", ariaHidden: "true" }));
  row.append(el("span", { className: "lx-row__name", textContent: n.name }));
  if (!isDir && editor.has(n.path) && editor.isDirty(n.path)) row.append(el("strong", { className: "lx-tag lx-tag--small lx-tag--yellow", textContent: "Unsaved" }));
  else if (isMain) row.append(el("strong", { className: "lx-tag lx-tag--small lx-tag--green", textContent: "Main" }));

  const actions = el("span", { className: "lx-row__actions" });
  const action = (text, fn, title) => {
    const b = el("button", { type: "button", className: "lx-link", textContent: text, title: title || `${text} ${n.name}` });
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    actions.append(b);
  };
  if (!isDir && !isMain && project.mains.includes(n.path)) {
    action("Main", () => setMain(n.path), `Build ${n.name} as the main document`);
  }
  action("Rename", () => { treeEdit = { kind: "rename", path: n.path }; treeError = ""; renderTree(); });
  action("Delete", () => { treeEdit = { kind: "delete", path: n.path }; treeError = ""; renderTree(); });
  row.append(actions);

  const activate = () => {
    if (isDir) {
      if (isOpen) expanded.delete(n.path); else expanded.add(n.path);
      selectedDir = n.path;
      store.set("expanded", [...expanded]);
      renderTree();
    } else if (n.text) {
      selectedDir = parentOf(n.path);
      openFile(n.path).catch((e) => setStatus("Error", "red", e.message));
    }
  };
  row.addEventListener("click", activate);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
    if (e.key === "F2") { treeEdit = { kind: "rename", path: n.path }; renderTree(); }
    if (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) { treeEdit = { kind: "delete", path: n.path }; renderTree(); }
  });
  return el("li", { role: "none" }, row);
}

function confirmRow(n) {
  const yes = el("button", { type: "button", className: "lx-button lx-button--warning", textContent: "Move to Bin" });
  const no = el("button", { type: "button", className: "lx-link", textContent: "Cancel" });
  const box = el("div", { className: "lx-confirm", role: "alertdialog" },
    el("p", { textContent: `Are you sure you want to delete ${n.name}${n.type === "dir" ? " and everything in it" : ""}?` }),
    el("div", { className: "lx-confirm__actions" }, yes, no));
  yes.addEventListener("click", async () => {
    try {
      const info = await api.fs({ op: "trash", path: n.path });
      editor.drop(n.path);
      if (conflict && (conflict.path === n.path || conflict.path.startsWith(n.path + "/"))) conflict = null;
      treeEdit = null;
      applyProjectInfo(info);
      if (!editor.path) {
        const next = settings.main || project.files[0];
        if (next) await openFile(next); else updateDirty();
      }
    } catch (e) {
      treeError = e.message;
      renderTree();
    }
  });
  no.addEventListener("click", () => { treeEdit = null; renderTree(); });
  queueMicrotask(() => no.focus());
  return el("li", { role: "none" }, box);
}

function newEntry(kind) {
  if (selectedDir) expanded.add(selectedDir);
  treeEdit = { kind, dir: selectedDir };
  treeError = "";
  setFilesVisible(true);
  renderTree();
}

function setFilesVisible(show) {
  settings.files = show;
  store.set("files", show);
  $("files").hidden = !show;
  $("expand-files").hidden = show;
}

function showMainName() {
  $("main-name").textContent = settings.main || "No document";
}

function setMain(path) {
  settings.main = path;
  showMainName();
  store.set("main", path);
  $("main").value = path;
  $("download").href = downloadUrl();
  renderTree();
  compile();
}

// ------------------------------------------------------------ folder picker
let pickerPath = "";

function recentFolders() { return globalStore.get("recent", []); }
function rememberFolder(p) {
  globalStore.set("recent", [p, ...recentFolders().filter((r) => r !== p)].slice(0, 8));
}
const tilde = (p) => (p.startsWith(project.home) ? "~" + p.slice(project.home.length) : p);
const untilde = (p) => p.replace(/^~(?=$|\/)/, project.home);

async function pickerLoad(p) {
  const note = $("picker-note");
  try {
    const d = await api.json(`/api/dirs?path=${encodeURIComponent(untilde(p))}`);
    pickerPath = d.path;
    $("picker-path").value = tilde(d.path);

    const crumbs = $("picker-crumbs");
    crumbs.replaceChildren();
    const parts = d.path.split("/").filter(Boolean);
    const rootBtn = el("button", { type: "button", textContent: "/" });
    rootBtn.addEventListener("click", () => pickerLoad("/"));
    crumbs.append(rootBtn);
    parts.forEach((part, i) => {
      if (i) crumbs.append(el("span", { textContent: "/" }));
      const b = el("button", { type: "button", textContent: part });
      b.addEventListener("click", () => pickerLoad("/" + parts.slice(0, i + 1).join("/")));
      crumbs.append(b);
    });

    note.textContent = d.tex ? `${d.tex} .tex file${d.tex > 1 ? "s" : ""} in this folder` : "No .tex files directly in this folder";
    note.classList.toggle("is-good", d.tex > 0);

    const list = $("picker-list");
    list.replaceChildren();
    const item = (text, target) => {
      const b = el("button", { type: "button" });
      b.innerHTML = '<svg width="16" height="13" viewBox="0 0 18 14" aria-hidden="true"><path d="M1 2h6l2 2h8v9H1z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
      b.append(el("span", { textContent: text }));
      b.addEventListener("click", () => pickerLoad(target));
      b.addEventListener("dblclick", () => openFolder(target));
      list.append(el("li", {}, b));
    };
    if (d.parent) item("..", d.parent);
    for (const name of d.dirs) item(name, `${d.path === "/" ? "" : d.path}/${name}`);
  } catch (e) {
    note.textContent = e.message;
    note.classList.remove("is-good");
  }
}

function openPicker() {
  $("picker").hidden = false;
  const recent = recentFolders().filter((r) => r !== project.root);
  $("picker-recent-wrap").hidden = !recent.length;
  const ul = $("picker-recent");
  ul.replaceChildren(...recent.map((r) => {
    const b = el("button", { type: "button", textContent: tilde(r), title: r });
    b.addEventListener("click", () => openFolder(r));
    return el("li", {}, b);
  }));
  pickerLoad(project.root).then(() => $("picker-path").focus());
}

function closePicker() {
  $("picker").hidden = true;
  $("project").focus();
}

async function openFolder(p) {
  const target = untilde(p || pickerPath);
  if (target === project.root) { closePicker(); return; }
  try {
    await saveAll();
    const r = await api.post("/api/root", { path: target });
    rememberFolder(r.root);
    location.reload();
  } catch (e) {
    $("picker-note").textContent = e.message;
    $("picker-note").classList.remove("is-good");
  }
}

// ---------------------------------------------------------------- splitters
function splitter(gutter, axis, cssVar, container, key, dflt) {
  gutter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add("is-dragging");
    document.body.classList.add("is-dragging");
    const rect = container.getBoundingClientRect();
    const move = (ev) => {
      const pct = axis === "x"
        ? ((ev.clientX - rect.left) / rect.width) * 100
        : ((ev.clientY - rect.top) / rect.height) * 100;
      const v = Math.min(85, Math.max(15, pct));
      document.documentElement.style.setProperty(cssVar, `${v}%`);
      store.set(key, v);
    };
    const up = () => {
      gutter.classList.remove("is-dragging");
      document.body.classList.remove("is-dragging");
      gutter.removeEventListener("pointermove", move);
      gutter.removeEventListener("pointerup", up);
    };
    gutter.addEventListener("pointermove", move);
    gutter.addEventListener("pointerup", up);
  });
  gutter.addEventListener("dblclick", () => {
    document.documentElement.style.setProperty(cssVar, `${dflt}%`);
    store.set(key, dflt);
  });
}

// --------------------------------------------------------------------- boot
async function boot() {
  project = await api.json("/api/project");
  if (project.api !== API_VERSION) {
    setStatus("Restart server", "red");
    document.body.prepend(el("div", { className: "lx-banner lx-banner--top",
      textContent: "The laex server is older than this page. Stop it (Ctrl+C where it is running) and start it again with bin/laex." }));
    throw new Error("stale server");
  }
  $("project-name").textContent = project.name;
  $("project").title = `${project.root}\nChoose project folder`;
  rememberFolder(project.root);

  shortcuts = { ...Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, a.key])), ...globalStore.get("shortcuts", {}) };

  settings = {
    main: store.get("main", project.mains[0] || null),
    engine: store.get("engine", "pdflatex"),
    auto: store.get("auto", true),
    interval: store.get("interval", 1),
    invert: store.get("invert", false),
    swipe: globalStore.get("swipe", "zoom"),
    files: store.get("files", true),
    editorSize: store.get("editor-size", 14),
    termSize: store.get("term-size", Math.round(project.kitty.font_size) || 13),
    claudePrompt: globalStore.get("claude-prompt", true),
  };
  if (!project.mains.includes(settings.main)) settings.main = project.mains[0] || null;
  expanded = new Set(store.get("expanded", []));

  const root = document.documentElement.style;
  root.setProperty("--left", `${store.get("split-left", 50)}%`);
  root.setProperty("--top", `${store.get("split-top", 60)}%`);
  root.setProperty("--editor-size", `${settings.editorSize}px`);
  root.setProperty("--mono", `"${project.kitty.font_family}", Menlo, "SF Mono", monospace`);

  editor = new Editor($("editor"), {
    onChange: () => updateDirty(),
    onCursor: () => postState(),
  });

  pdf = new PdfView($("pdf"), {
    onPages: (n, scale) => {
      const zoom = pdf.zoom === null ? "fit" : `${Math.round(scale * 100)}%`;
      $("zoom-fit").setAttribute("aria-pressed", String(pdf.zoom === null));
      $("zoom-fit").title = `Fit width (${zoom})`;
    },
    onReverseSync: async (page, x, y) => {
      const r = await api.json(`/api/synctex?main=${encodeURIComponent(settings.main)}&page=${page}&x=${x}&y=${y}`);
      if (r.file) openFile(r.file, r.line).catch(() => {});
    },
  });
  $("pdf").classList.toggle("is-inverted", settings.invert);
  pdf.swipe = settings.swipe;

  term = new Term($("terminal"), project.kitty, {
    fontSize: settings.termSize,
    onStatus: (s) => { $("term-meta").textContent = s === "connected" ? tilde(project.root) : "Reconnecting"; },
  });

  // Controls
  fillSelect($("main"), project.mains, settings.main);
  $("engine").value = settings.engine;
  $("auto").checked = settings.auto;
  $("interval").value = settings.interval;
  $("invert").checked = settings.invert;
  $("swipe").value = settings.swipe;
  $("editor-size").value = settings.editorSize;
  $("term-size").value = settings.termSize;
  $("claude-prompt").checked = settings.claudePrompt;
  $("download").href = downloadUrl();
  showMainName();
  setFilesVisible(settings.files);
  renderShortcuts();
  applyShortcutTitles();

  $("main").addEventListener("change", (e) => setMain(e.target.value));
  $("engine").addEventListener("change", (e) => { settings.engine = e.target.value; store.set("engine", settings.engine); compile(); });
  $("auto").addEventListener("change", (e) => {
    settings.auto = e.target.checked; store.set("auto", settings.auto); restartTick();
    if (settings.auto) compile();
  });
  $("interval").addEventListener("change", (e) => {
    settings.interval = Math.min(30, Math.max(0.5, Number(e.target.value) || 1));
    e.target.value = settings.interval; store.set("interval", settings.interval); restartTick();
  });
  $("swipe").addEventListener("change", (e) => {
    settings.swipe = e.target.value; globalStore.set("swipe", settings.swipe); pdf.swipe = settings.swipe;
  });
  $("invert").addEventListener("change", (e) => {
    settings.invert = e.target.checked; store.set("invert", settings.invert);
    $("pdf").classList.toggle("is-inverted", settings.invert);
  });
  $("editor-size").addEventListener("change", (e) => {
    settings.editorSize = Number(e.target.value) || 14; store.set("editor-size", settings.editorSize);
    root.setProperty("--editor-size", `${settings.editorSize}px`); editor.view.requestMeasure();
  });
  $("term-size").addEventListener("change", (e) => {
    settings.termSize = Number(e.target.value) || 13; store.set("term-size", settings.termSize);
    term.setFontSize(settings.termSize);
  });
  $("claude-prompt").addEventListener("change", (e) => {
    settings.claudePrompt = e.target.checked; globalStore.set("claude-prompt", settings.claudePrompt); postState();
  });
  $("edit-prompt").addEventListener("click", () => { setMenu(false); openFile(PROMPT); });
  $("reset-prompt").addEventListener("click", async () => {
    await api.post("/api/prompt/reset", {});
    const text = await api.read(PROMPT);
    if (editor.has(PROMPT)) editor.applyExternal(PROMPT, text);
    $("reset-prompt").textContent = "Reset done";
    setTimeout(() => { $("reset-prompt").textContent = "Reset to default"; }, 1500);
  });
  $("reset-shortcuts").addEventListener("click", () => {
    shortcuts = Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, a.key]));
    globalStore.set("shortcuts", shortcuts);
    renderShortcuts();
    applyShortcutTitles();
  });

  $("compile").addEventListener("click", () => compile());
  $("start-claude").addEventListener("click", () => term.run("claude"));
  $("restart-shell").addEventListener("click", () => term.restart());
  $("zoom-in").addEventListener("click", () => pdf.setZoom(Math.min(4, pdf.currentScale() * 1.15)));
  $("zoom-out").addEventListener("click", () => pdf.setZoom(Math.max(0.3, pdf.currentScale() / 1.15)));
  $("zoom-fit").addEventListener("click", () => pdf.setZoom(null));
  const showTab = (logTab) => {
    $("tab-preview").setAttribute("aria-selected", String(!logTab));
    $("tab-log").setAttribute("aria-selected", String(logTab));
    $("log").hidden = !logTab;
    $("pdf").hidden = logTab;
    if (logTab) loadLog();
  };
  $("tab-preview").addEventListener("click", () => showTab(false));
  $("tab-log").addEventListener("click", () => showTab(true));
  $("conflict-load").addEventListener("click", () => {
    editor.applyExternal(conflict.path, conflict.content);
    conflict = null; showConflict(); updateDirty(); needsCompile = true;
  });
  $("conflict-keep").addEventListener("click", () => {
    editor.markSaved(conflict.path, conflict.content); // next save overwrites disk
    conflict = null; showConflict(); updateDirty();
  });

  // Explorer
  $("new-file").addEventListener("click", () => newEntry("new-file"));
  $("new-folder").addEventListener("click", () => newEntry("new-folder"));
  $("collapse-files").addEventListener("click", () => setFilesVisible(false));
  $("expand-files").addEventListener("click", () => setFilesVisible(true));
  $("tree").addEventListener("click", (e) => {
    if (e.target === $("tree")) { selectedDir = ""; renderTree(); }
  });

  // Folder picker
  $("project").addEventListener("click", openPicker);
  $("picker-form").addEventListener("submit", (e) => { e.preventDefault(); pickerLoad($("picker-path").value); });
  $("picker-open").addEventListener("click", () => openFolder());
  $("picker-cancel").addEventListener("click", closePicker);
  $("picker").addEventListener("pointerdown", (e) => { if (e.target === $("picker")) closePicker(); });

  // Settings menu, GOV.UK style.
  const menuBtn = $("menu-toggle");
  const menu = $("settings");
  function setMenu(open) { menuBtn.setAttribute("aria-expanded", String(open)); menu.hidden = !open; }
  menuBtn.addEventListener("click", () => setMenu(menu.hidden));
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) setMenu(false);
  });

  // Global shortcuts. Capture phase, so they work from the editor and the
  // terminal alike and win over CodeMirror's own bindings.
  const run = {
    compile: () => compile(),
    save: () => compile(),
    download,
    files: () => setFilesVisible(!settings.files),
    editor: () => editor.view.focus(),
    terminal: () => term.term.focus(),
  };
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("picker").hidden) { closePicker(); return; }
      if (!menu.hidden) { setMenu(false); menuBtn.focus(); return; }
    }
    if (e.target.classList?.contains("lx-key")) return;
    const combo = comboOf(e);
    if (!combo) return;
    const action = Object.keys(shortcuts).find((k) => shortcuts[k] === combo);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    run[action]();
  }, true);

  window.addEventListener("beforeunload", (e) => {
    if (editor.dirtyPaths().length) { e.preventDefault(); e.returnValue = ""; }
  });

  splitter($("gutter-main"), "x", "--left", $("work"), "split-left", 50);
  splitter($("gutter-left"), "y", "--top", $("left"), "split-top", 60);

  connectEvents();

  const first = store.get("open", settings.main);
  if (first && project.files.includes(first)) await openFile(first);
  else if (settings.main) await openFile(settings.main);
  else if (project.files[0]) await openFile(project.files[0]);
  else { setStatus("No .tex files", "yellow"); updateDirty(); renderTree(); }

  restartTick();
  if (settings.main) compile();
}

boot().catch((e) => {
  setStatus("Error", "red");
  console.error(e);
});
