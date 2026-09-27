import { Editor, macroSnippets } from "./editor.js";
import { Term } from "./terminal.js";
import { PdfView } from "./pdf.js";
import { Spell } from "./spell.js";
import { initVersions } from "./versions.js";
import { initJobMatch } from "./jobmatch.js";
import { initChecks } from "./checks.js";
import { initOutline } from "./outline.js";
import { initSearch } from "./search.js";
import { initClaude } from "./claude.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("aria-") || k === "role") node.setAttribute(k, v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};

// Files edited like any other but stored outside the project.
const VIRTUAL = {
  "@prompt": { label: "Claude system prompt", url: "/api/prompt" },
  "@dictionary": { label: "Personal dictionary", url: "/api/dict/personal" },
};
const API_VERSION = 3;

// ---------------------------------------------------------------- storage
let project;
const store = {
  key: (k) => `laex:${project.root}:${k}`,
  get(k, dflt) { const v = localStorage.getItem(store.key(k)); return v === null ? dflt : JSON.parse(v); },
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
  async text(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.text();
  },
  post(url, data) {
    return api.json(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  },
  read(path) {
    return api.text(VIRTUAL[path] ? VIRTUAL[path].url : `/api/file?path=${encodeURIComponent(path)}`);
  },
  write(path, text) {
    return api.json(VIRTUAL[path] ? VIRTUAL[path].url : `/api/file?path=${encodeURIComponent(path)}`, { method: "PUT", body: text });
  },
  compile: (main, engine) => api.post("/api/compile", { main, engine }),
  fs: (op) => api.post("/api/fs", op),
};

// -------------------------------------------------------------- shortcuts
const ACTIONS = {
  compile:     { label: "Recompile", key: "Meta+Enter" },
  save:        { label: "Save and recompile", key: "Meta+S" },
  saveVersion: { label: "Save version", key: "Meta+Shift+S" },
  download:    { label: "Download PDF", key: "Meta+D" },
  askClaude:   { label: "Ask Claude", key: "Meta+K" },
  showInPdf:   { label: "Show in PDF", key: "Meta+." },
  search:      { label: "Find in files", key: "Meta+Shift+F" },
  files:       { label: "Show or hide sidebar", key: "Meta+B" },
  editor:      { label: "Focus editor", key: "Meta+1" },
  terminal:    { label: "Focus terminal", key: "Meta+2" },
};
let shortcuts = {};

function comboOf(e) {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (e.code === "Period") key = ".";
  else if (e.code === "Comma") key = ",";
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
    const input = el("input", { className: "lx-key", readOnly: true, value: showCombo(shortcuts[id]), id: `key-${id}`, title: shortcuts[id] || "No shortcut" });
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
  for (const id of ["compile", "saveVersion", "download", "askClaude", "showInPdf", "search"]) {
    if (!shortcuts[id]) continue;
    if (keys.childNodes.length) keys.append("   ");
    keys.append(el("kbd", { textContent: showCombo(shortcuts[id]) }), ` ${ACTIONS[id].label.toLowerCase()}`);
  }
  const title = (id, btn) => { if ($(btn)) $(btn).title = `${ACTIONS[id].label} (${showCombo(shortcuts[id])})`; };
  title("compile", "compile"); title("download", "download"); title("saveVersion", "save-version");
  title("askClaude", "ask-claude"); title("showInPdf", "show-in-pdf");
}

// ------------------------------------------------------------------ status
function setStatus(text, colour, message) {
  const s = $("status");
  s.textContent = text;
  s.className = `lx-tag lx-tag--${colour}`;
  if (message !== undefined) $("build-msg").textContent = message;
}

// ------------------------------------------------------------------ dialog
// GOV.UK-style dialog. Resolves to the entered text (or "" for a plain
// confirmation), or null when cancelled.
function ask({ title, message = "", label = "", hint = "", value = "", confirm = "Continue" }) {
  return new Promise((resolve) => {
    const dlg = $("dialog");
    $("dialog-title").textContent = title;
    $("dialog-message").textContent = message;
    $("dialog-message").hidden = !message;
    $("dialog-field").hidden = !label;
    $("dialog-label").textContent = label;
    $("dialog-hint").textContent = hint;
    $("dialog-hint").hidden = !hint;
    $("dialog-input").value = value;
    $("dialog-ok").textContent = confirm;
    dlg.hidden = false;
    const focusEl = label ? $("dialog-input") : $("dialog-ok");
    setTimeout(() => { focusEl.focus(); if (label) $("dialog-input").select(); }, 0);
    const done = (result) => {
      dlg.hidden = true;
      $("dialog-form").onsubmit = null;
      $("dialog-cancel").onclick = null;
      dlg.onkeydown = null;
      resolve(result);
    };
    $("dialog-form").onsubmit = (e) => { e.preventDefault(); done(label ? $("dialog-input").value.trim() : ""); };
    $("dialog-cancel").onclick = () => done(null);
    dlg.onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
  });
}

// -------------------------------------------------------------------- state
let editor, term, pdf, pdf2, spell, versions, jobmatch, checks, outline, search, claude;
let settings;
let needsCompile = false;
let compiling = false;
let queued = false;
let waiters = [];
let conflict = null; // { path, content }
let tick = null;
let lastBuild = null;
let buildDiagnostics = new Map(); // path -> [{ line, severity, message }]
let spellCounts = new Map();
let techWords = [];

function fillSelect(sel, items, value, empty) {
  const opts = items.map((f) => new Option(f, f));
  if (empty) opts.unshift(new Option(empty, ""));
  sel.replaceChildren(...opts);
  sel.value = value && items.includes(value) ? value : (empty ? "" : items[0] || "");
}

const label = (path) => VIRTUAL[path]?.label || path;

let lastDirty = "";
function updateDirty() {
  const d = editor.path && editor.isDirty();
  const dirtyKey = editor.dirtyPaths().join("\0");
  if (dirtyKey !== lastDirty) { lastDirty = dirtyKey; renderTree(); }
  $("dirty").textContent = !editor.path ? "" : d ? "Unsaved changes" : "Saved";
  $("current-file").textContent = editor.path ? label(editor.path) : "No file open";
  document.title = `${d ? "• " : ""}${editor.path ? label(editor.path) : project.name} - LAEX`;
  showReview();
  postState();
}

async function openFile(path, line, col, len) {
  if (!editor.has(path)) {
    editor.load(path, await api.read(path));
    if (buildDiagnostics.has(path)) editor.setDiagnostics(path, "build", buildDiagnostics.get(path));
  }
  if (editor.path !== path) editor.open(path);
  if (!VIRTUAL[path]) {
    store.set("open", path);
    revealInTree(path);
  }
  showConflict();
  updateDirty();
  renderTree();
  outline?.refresh();
  scheduleSpell(0);
  if (line) editor.goto(line, col, len);
}

async function saveAll() {
  for (const p of editor.dirtyPaths()) {
    const text = editor.text(p);
    await api.write(p, text);
    editor.markSaved(p, text);
    if (!VIRTUAL[p]) needsCompile = true;
    if (p === "@dictionary") initSpell();
  }
  updateDirty();
}

// ---------------------------------------------------------- claude context
let stateTimer = null;
function postState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    if (!editor || !settings) return;
    const onFile = editor.path && !VIRTUAL[editor.path];
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
// Resolves when a build that includes every edit so far has finished.
function compile({ wait = false } = {}) {
  const p = new Promise((resolve) => waiters.push(resolve));
  if (compiling) { queued = true; return wait ? p : undefined; }
  runCompile();
  return wait ? p : undefined;
}

async function runCompile() {
  const mine = waiters;
  waiters = [];
  if (!settings.main) {
    setStatus("No document", "yellow", "Create a .tex file with \\documentclass to get started.");
    mine.forEach((r) => r());
    return;
  }
  compiling = true;
  setStatus("Building", "blue", `Building ${settings.main}…`);
  $("compile").setAttribute("aria-disabled", "true");
  try {
    await saveAll();
    needsCompile = false;
    const r = await api.compile(settings.main, settings.engine);
    lastBuild = r;
    showErrors(r);
    applyBuildDiagnostics(r);
    if (r.pdf) await pdf.load(`/api/pdf?main=${encodeURIComponent(settings.main)}&v=${Date.now()}`);
    if (settings.second && settings.second !== settings.main) {
      const r2 = await api.compile(settings.second, settings.engine);
      if (r2.pdf) await pdf2.load(`/api/pdf?main=${encodeURIComponent(settings.second)}&v=${Date.now()}`);
    }
    const bits = [];
    if (r.pages) bits.push(`${r.pages} page${r.pages > 1 ? "s" : ""}`);
    if (r.warnings) bits.push(`${r.warnings} warning${r.warnings > 1 ? "s" : ""}`);
    if (r.overfull) bits.push(`${r.overfull} overfull box${r.overfull > 1 ? "es" : ""}`);
    $("pdf-meta").textContent = bits.join(", ");
    const at = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (r.errors.length) {
      const n = `${r.errors.length} error${r.errors.length > 1 ? "s" : ""}`;
      setStatus(n, "red", `${settings.main} has ${n}${r.fresh ? ", but the PDF was still built" : ""}. Last build at ${at}.`);
    } else {
      const pages = r.pages ? `, ${r.pages} page${r.pages > 1 ? "s" : ""}` : "";
      if (r.fresh) setStatus("Built", "green", `${settings.main} built in ${(r.ms / 1000).toFixed(1)} seconds at ${at}${pages}.`);
      else setStatus("Up to date", "green", `${settings.main} is up to date. Checked at ${at}.`);
    }
    if (!$("log").hidden) loadLog();
    checks.run(r);
    postState();
  } catch (e) {
    setStatus("Failed", "red", `The build could not run: ${e.message}`);
    showErrors({ errors: [{ file: settings.main, line: 1, message: e.message }] });
  } finally {
    compiling = false;
    $("compile").removeAttribute("aria-disabled");
    mine.forEach((r) => r());
    if (queued) { queued = false; runCompile(); }
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

// Build errors and overfull lines as squiggles in the editor.
function applyBuildDiagnostics(r) {
  const next = new Map();
  const add = (file, d) => { if (!next.has(file)) next.set(file, []); next.get(file).push(d); };
  for (const e of r.errors || []) add(e.file, { line: e.line, severity: "error", message: e.message });
  for (const o of r.overfullLines || []) add(settings.main, { line: o.line, severity: "warning", message: `This line runs ${o.pt.toFixed(1)}pt past the margin.` });
  for (const path of new Set([...buildDiagnostics.keys(), ...next.keys()])) {
    editor.setDiagnostics(path, "build", next.get(path) || []);
  }
  buildDiagnostics = next;
}

async function loadLog() {
  if (!settings.main) return;
  const log = $("log");
  log.textContent = await api.text(`/api/log?main=${encodeURIComponent(settings.main)}`).catch(() => "No log yet.");
  log.scrollTop = log.scrollHeight;
}

// -------------------------------------------------------------- download
function detectName() {
  const src = settings.main && editor.has(settings.main) ? editor.text(settings.main) : "";
  const m = src.match(/pdfauthor\s*=\s*\{([^}]*)\}/) || src.match(/\\author\{([^}]*)\}/);
  return (m?.[1] || "").replace(/\\[A-Za-z]+/g, "").trim();
}

function fileName() {
  if (!settings.main) return "";
  const base = settings.main.split("/").pop().replace(/\.tex$/, "");
  const company = base.includes("_") ? base.split("_").pop().replace(/^\w/, (c) => c.toUpperCase()) : "";
  const vars = { name: settings.yourName || detectName(), company, main: base, date: new Date().toISOString().slice(0, 10) };
  const out = settings.filePattern.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "")
    .replace(/\s+/g, " ").replace(/([_-])\1+/g, "$1").replace(/^[\s_-]+|[\s_-]+$/g, "").replace(/\s+([_-])/g, "$1");
  return out || base;
}

function downloadUrl() {
  return settings.main ? `/api/pdf?main=${encodeURIComponent(settings.main)}&download=1&name=${encodeURIComponent(fileName())}` : "#";
}
function refreshDownload() {
  $("download").href = downloadUrl();
  $("file-example").textContent = settings.main ? `Example: ${fileName()}.pdf` : "";
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
    if (editor.dirtyPaths().some((p) => !VIRTUAL[p])) needsCompile = true;
    if (needsCompile && !compiling) compile();
  }, Math.max(500, settings.interval * 1000));
}

// --------------------------------------------------------- disk changes
function showConflict() {
  const show = conflict && conflict.path === editor.path;
  $("conflict").hidden = !show;
  if (show) $("conflict-text").textContent = `${conflict.path} changed on disk while you had unsaved edits.`;
}

function showReview() {
  const n = editor.path ? editor.reviewChunks() : 0;
  $("review").hidden = !n;
  if (!n) return;
  $("review-text").textContent = `${n} change${n > 1 ? "s" : ""} from outside the editor. Accept or reject each one in the text, or all at once.`;
  const i = editor.chunkIndex();
  $("review-pos").textContent = i >= 0 ? `${i + 1} of ${n}` : `${n}`;
  $("review-prev").hidden = $("review-next").hidden = n < 2 && i >= 0;
}

function onDiskChange(path, content) {
  if (!editor.has(path)) { needsCompile = true; return; }
  if (editor.text(path) === content) { editor.markSaved(path, content); updateDirty(); return; }
  if (!editor.isDirty(path)) {
    editor.applyExternal(path, content, { review: settings.review && !VIRTUAL[path] });
    needsCompile = true;
    if (path !== editor.path && settings.review) setStatus("Review", "yellow", `${path} was changed outside the editor. Open it to review the changes.`);
  } else {
    conflict = { path, content };
    showConflict();
  }
  updateDirty();
  outline.refresh();
  scheduleSpell();
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
  fillSecond();
  refreshDownload();
  showMainName();
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

// ----------------------------------------------------------------- spelling
let spellTimer = null;
function scheduleSpell(delay = 700) {
  clearTimeout(spellTimer);
  if (!settings?.spellOn || !spell) return;
  spellTimer = setTimeout(() => {
    const p = editor.path;
    if (p && !VIRTUAL[p] && /\.(tex|md|txt)$/.test(p)) spell.check(p, editor.text(p));
  }, delay);
}

async function initSpell() {
  if (!settings.spellOn) {
    spell?.stop();
    for (const p of editor.docs.keys()) editor.setDiagnostics(p, "spell", []);
    spellCounts.clear();
    return;
  }
  const words = await api.json("/api/dict/words").catch(() => ({ tech: [], personal: [] }));
  techWords = words.tech;
  if (!spell) {
    spell = new Spell({
      onDiagnostics: (path, list) => { editor.setDiagnostics(path, "spell", list); spellCounts.set(path, list.length); },
      addWord: (word) => api.post("/api/dict/add", { word }).catch(() => {}),
    });
    spell.recheck = () => scheduleSpell(0);
  }
  await spell.init(settings.spellLang, [...words.tech, ...words.personal]);
  scheduleSpell(0);
}

// --------------------------------------------------------------- explorer
let expanded = new Set();
let selectedDir = "";
let treeEdit = null;
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
  if (!project?.tree || !settings) return;
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
  const row = el("div", { className: `lx-row${isDir ? " lx-row--dir" : ""}`, tabIndex: 0, role: "treeitem", title: n.path });
  row.style.paddingLeft = `${12 + depth * 18}px`;
  if (isDir) row.setAttribute("aria-expanded", String(isOpen));
  if (isActive) { row.classList.add("is-active"); row.setAttribute("aria-current", "true"); }
  if (isDir && n.path === selectedDir) row.classList.add("is-selected-dir");
  if (!isDir && !n.text) { row.classList.add("is-disabled"); row.title = `${n.path} cannot be edited here`; }

  if (isDir) row.append(el("span", { className: "lx-row__toggle", "aria-hidden": "true" }));
  row.append(el("span", { className: "lx-row__name", textContent: n.name }));
  if (!isDir && editor.has(n.path) && editor.reviewChunks(n.path)) row.append(el("strong", { className: "lx-tag lx-tag--small lx-tag--blue", textContent: "Review" }));
  else if (!isDir && editor.has(n.path) && editor.isDirty(n.path)) row.append(el("strong", { className: "lx-tag lx-tag--small lx-tag--yellow", textContent: "Unsaved" }));
  else if (isMain) row.append(el("strong", { className: "lx-tag lx-tag--small lx-tag--green", textContent: "Main" }));

  const actions = el("span", { className: "lx-row__actions" });
  const action = (text, fn, title) => {
    const b = el("button", { type: "button", className: "lx-link", textContent: text, title: title || `${text} ${n.name}` });
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    actions.append(b);
  };
  if (!isDir && !isMain && project.mains.includes(n.path)) action("Main", () => setMain(n.path), `Build ${n.name} as the main document`);
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
  showSide("files");
  renderTree();
}

function setFilesVisible(show) {
  settings.files = show;
  store.set("files", show);
  $("files").hidden = !show;
  $("expand-files").hidden = show;
}

function showSide(name) {
  for (const n of ["files", "outline", "search"]) {
    $(`side-${n}`).setAttribute("aria-selected", String(n === name));
    $(`pane-${n}`).hidden = n !== name;
  }
  store.set("side", name);
  if (name === "outline") outline.refresh();
}

function showMainName() {
  $("main-name").textContent = settings.main || "No document";
}

function setMain(path) {
  settings.main = path;
  showMainName();
  store.set("main", path);
  $("main").value = path;
  fillSecond();
  refreshDownload();
  renderTree();
  pdf.clear();
  compile();
}

// ------------------------------------------------------- second document
function fillSecond() {
  const others = project.mains.filter((m) => m !== settings.main);
  if (!others.includes(settings.second)) settings.second = "";
  fillSelect($("second"), others, settings.second, "One document");
  $("second").hidden = !others.length;
  $("second").previousElementSibling.hidden = !others.length;
  $("pdf2").hidden = !settings.second;
  $("previews").classList.toggle("is-split", !!settings.second);
}

// ----------------------------------------------------------- right tabs
let tabsLoaded = new Set();
function showTab(name) {
  for (const b of document.querySelectorAll("#right-tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
  store.set("tab", name);
  if (name === "log") loadLog();
  if (name === "versions") versions.refresh();
  if (name === "jobmatch" && !tabsLoaded.has(name)) { tabsLoaded.add(name); jobmatch.load(); }
}

function renderCheckTags(c) {
  const box = $("check-tags");
  box.replaceChildren();
  if (c.pages) {
    const over = c.limit && c.pages > c.limit;
    box.append(el("button", {
      type: "button", className: `lx-tag lx-tag--button lx-tag--${over ? "red" : "green"}`,
      textContent: over ? `${c.pages} pages (limit ${c.limit})` : `${c.pages} page${c.pages > 1 ? "s" : ""}`,
      title: "Open ATS text and checks",
    }));
  }
  if (c.fails) box.append(el("button", { type: "button", className: "lx-tag lx-tag--button lx-tag--red", textContent: `${c.fails} to fix` }));
  if (c.warns) box.append(el("button", { type: "button", className: "lx-tag lx-tag--button lx-tag--yellow", textContent: `${c.warns} to check` }));
  for (const b of box.children) b.addEventListener("click", () => showTab("atstext"));
}

// ------------------------------------------------------------ folder picker
let pickerPath = "";
function recentFolders() { return globalStore.get("recent", []); }
function rememberFolder(p) { globalStore.set("recent", [p, ...recentFolders().filter((r) => r !== p)].slice(0, 8)); }
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
  $("picker-recent").replaceChildren(...recent.map((r) => {
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
      const pct = axis === "x" ? ((ev.clientX - rect.left) / rect.width) * 100 : ((ev.clientY - rect.top) / rect.height) * 100;
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

// ------------------------------------------------------------ other actions
async function showInPdf() {
  const p = editor.path;
  if (!p || !/\.tex$/.test(p) || !settings.main) return;
  showTab("preview");
  await saveAll();
  if (needsCompile) await compile({ wait: true });
  const c = editor.cursorInfo();
  const r = await api.json(`/api/synctex/view?main=${encodeURIComponent(settings.main)}&file=${encodeURIComponent(p)}&line=${c.line}&col=${c.col}`);
  if (r.page) pdf.reveal(r);
  else setStatus("Not found", "yellow", "That line has no matching place in the PDF.");
}

async function findInSource(term) {
  const main = settings.main;
  if (!main) return;
  await openFile(main);
  const text = editor.text(main);
  const lower = text.toLowerCase();
  const doc = text.indexOf("\\begin{document}");
  let i = lower.indexOf(term.toLowerCase(), Math.max(0, doc));
  if (i < 0) i = lower.indexOf(term.toLowerCase());
  if (i < 0) return;
  const before = text.slice(0, i);
  const line = before.split("\n").length;
  const col = i - before.lastIndexOf("\n");
  editor.goto(line, col, term.length);
}

// --------------------------------------------------------------------- boot
async function boot() {
  project = await api.json("/api/project");
  if (project.api !== API_VERSION) {
    setStatus("Restart server", "red", "");
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
    second: store.get("second", ""),
    engine: store.get("engine", "pdflatex"),
    auto: store.get("auto", true),
    interval: store.get("interval", 1),
    invert: store.get("invert", false),
    swipe: globalStore.get("swipe", "zoom"),
    files: store.get("files", true),
    editorSize: store.get("editor-size", 14),
    termSize: store.get("term-size", Math.round(project.kitty.font_size) || 13),
    claudePrompt: globalStore.get("claude-prompt", true),
    review: globalStore.get("review", true),
    theme: globalStore.get("theme", "dark"),
    pageLimit: globalStore.get("page-limit", 1),
    yourName: globalStore.get("your-name", ""),
    filePattern: globalStore.get("file-pattern", "{name} CV {company}"),
    spellOn: globalStore.get("spell-on", true),
    spellLang: globalStore.get("spell-lang", "en-GB"),
  };
  if (!project.mains.includes(settings.main)) settings.main = project.mains[0] || null;
  // Pin the default so the main document doesn't drift to whichever file
  // was edited last.
  store.set("main", settings.main);
  expanded = new Set(store.get("expanded", []));

  const root = document.documentElement.style;
  document.documentElement.dataset.theme = settings.theme;
  root.setProperty("--left", `${store.get("split-left", 50)}%`);
  root.setProperty("--top", `${store.get("split-top", 60)}%`);
  root.setProperty("--editor-size", `${settings.editorSize}px`);
  root.setProperty("--mono", `"${project.kitty.font_family}", Menlo, "SF Mono", monospace`);

  editor = new Editor($("editor"), {
    onChange: () => { updateDirty(); scheduleSpell(); scheduleOutline(); },
    onCursor: () => { postState(); if (editor.path) outline?.cursor(editor.cursorInfo().line); if (!$("review").hidden) showReview(); },
    getMacros: () => {
      const src = [settings.main, editor.path].filter((p, i, a) => p && a.indexOf(p) === i && editor.has(p)).map((p) => editor.text(p)).join("\n");
      return macroSnippets(src);
    },
    onReviewDone: () => { showReview(); renderTree(); },
    onReviewChange: () => showReview(),
  });

  const pdfOpts = (which) => ({
    onPages: (n, scale) => {
      if (which !== "main") return;
      $("zoom-fit").setAttribute("aria-pressed", String(pdf.zoom === null));
      $("zoom-fit").title = `Fit width (${pdf.zoom === null ? "fit" : `${Math.round(scale * 100)}%`})`;
    },
    onReverseSync: async (page, x, y) => {
      const main = which === "main" ? settings.main : settings.second;
      const r = await api.json(`/api/synctex?main=${encodeURIComponent(main)}&page=${page}&x=${x}&y=${y}`);
      if (r.file) openFile(r.file, r.line).catch(() => {});
    },
  });
  pdf = new PdfView($("pdf"), pdfOpts("main"));
  pdf2 = new PdfView($("pdf2"), pdfOpts("second"));
  for (const v of [pdf, pdf2]) v.swipe = settings.swipe;
  $("pdf").classList.toggle("is-inverted", settings.invert);
  $("pdf2").classList.toggle("is-inverted", settings.invert);

  term = new Term($("terminal"), project.kitty, {
    fontSize: settings.termSize,
    onStatus: (s) => { $("term-meta").textContent = s === "connected" ? tilde(project.root) : "Reconnecting"; },
  });

  // Feature modules share this.
  const app = {
    $, el, api, ask, setStatus, settings, editor,
    get project() { return project; },
    get pdf() { return pdf; },
    openFile, saveAll, compile, setMain, applyProjectInfo, showTab, findInSource,
    askClaude: (prompt) => claude.send(prompt),
    focusTerminal: () => term.term.focus(),
    hasJob: () => jobmatch.hasJob(),
    techWords: () => techWords,
    cvText: async () => checks.text() || api.text(`/api/text?main=${encodeURIComponent(settings.main)}`).catch(() => ""),
    spellingCount: () => spellCounts.get(settings.main) || 0,
    onChecks: renderCheckTags,
    onVersionCount: (n) => { document.querySelector('[data-tab="versions"]').textContent = n ? `Versions (${n})` : "Versions"; },
    onReplaced: (file, text) => { if (editor.has(file)) { editor.applyExternal(file, text); needsCompile = true; } },
  };
  versions = initVersions(app);
  jobmatch = initJobMatch(app);
  checks = initChecks(app);
  outline = initOutline(app);
  search = initSearch(app);
  claude = initClaude(app);

  // Controls
  fillSelect($("main"), project.mains, settings.main);
  fillSecond();
  $("engine").value = settings.engine;
  $("auto").checked = settings.auto;
  $("interval").value = settings.interval;
  $("invert").checked = settings.invert;
  $("swipe").value = settings.swipe;
  $("editor-size").value = settings.editorSize;
  $("term-size").value = settings.termSize;
  $("claude-prompt").checked = settings.claudePrompt;
  $("review-on").checked = settings.review;
  $("theme").value = settings.theme;
  $("page-limit").value = settings.pageLimit;
  $("your-name").value = settings.yourName;
  $("file-pattern").value = settings.filePattern;
  $("spell-on").checked = settings.spellOn;
  $("spell-lang").value = settings.spellLang;
  showMainName();
  setFilesVisible(settings.files);
  showSide(store.get("side", "files"));
  renderShortcuts();
  applyShortcutTitles();

  const bind = (id, fn, ev = "change") => $(id).addEventListener(ev, fn);
  bind("main", (e) => setMain(e.target.value));
  bind("second", (e) => { settings.second = e.target.value; store.set("second", settings.second); fillSecond(); if (!settings.second) pdf2.clear(); compile(); });
  bind("engine", (e) => { settings.engine = e.target.value; store.set("engine", settings.engine); compile(); });
  bind("auto", (e) => { settings.auto = e.target.checked; store.set("auto", settings.auto); restartTick(); if (settings.auto) compile(); });
  bind("interval", (e) => {
    settings.interval = Math.min(30, Math.max(0.5, Number(e.target.value) || 1));
    e.target.value = settings.interval; store.set("interval", settings.interval); restartTick();
  });
  bind("swipe", (e) => { settings.swipe = e.target.value; globalStore.set("swipe", settings.swipe); pdf.swipe = pdf2.swipe = settings.swipe; });
  bind("invert", (e) => {
    settings.invert = e.target.checked; store.set("invert", settings.invert);
    $("pdf").classList.toggle("is-inverted", settings.invert);
    $("pdf2").classList.toggle("is-inverted", settings.invert);
  });
  bind("editor-size", (e) => {
    settings.editorSize = Number(e.target.value) || 14; store.set("editor-size", settings.editorSize);
    root.setProperty("--editor-size", `${settings.editorSize}px`); editor.view.requestMeasure();
  });
  bind("term-size", (e) => { settings.termSize = Number(e.target.value) || 13; store.set("term-size", settings.termSize); term.setFontSize(settings.termSize); });
  bind("claude-prompt", (e) => { settings.claudePrompt = e.target.checked; globalStore.set("claude-prompt", settings.claudePrompt); postState(); });
  bind("review-on", (e) => { settings.review = e.target.checked; globalStore.set("review", settings.review); });
  bind("theme", (e) => { settings.theme = e.target.value; globalStore.set("theme", settings.theme); document.documentElement.dataset.theme = settings.theme; });
  bind("page-limit", (e) => { settings.pageLimit = Math.max(0, Number(e.target.value) || 0); globalStore.set("page-limit", settings.pageLimit); if (lastBuild) checks.run(lastBuild); });
  bind("your-name", (e) => { settings.yourName = e.target.value.trim(); globalStore.set("your-name", settings.yourName); refreshDownload(); }, "input");
  bind("file-pattern", (e) => { settings.filePattern = e.target.value || "{name} CV {company}"; globalStore.set("file-pattern", settings.filePattern); refreshDownload(); }, "input");
  bind("spell-on", (e) => { settings.spellOn = e.target.checked; globalStore.set("spell-on", settings.spellOn); initSpell(); });
  bind("spell-lang", (e) => { settings.spellLang = e.target.value; globalStore.set("spell-lang", settings.spellLang); initSpell(); });
  bind("edit-dict", () => { setMenu(false); openFile("@dictionary"); }, "click");
  bind("edit-prompt", () => { setMenu(false); openFile("@prompt"); }, "click");
  bind("reset-prompt", async () => {
    await api.post("/api/prompt/reset", {});
    const text = await api.read("@prompt");
    if (editor.has("@prompt")) editor.applyExternal("@prompt", text);
    $("reset-prompt").textContent = "Reset done";
    setTimeout(() => { $("reset-prompt").textContent = "Reset to default"; }, 1500);
  }, "click");
  bind("reset-shortcuts", () => {
    shortcuts = Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, a.key]));
    globalStore.set("shortcuts", shortcuts);
    renderShortcuts();
    applyShortcutTitles();
  }, "click");

  bind("compile", () => compile(), "click");
  bind("save-version", () => versions.saveVersion(), "click");
  bind("show-in-pdf", () => showInPdf(), "click");
  bind("start-claude", () => term.run("claude"), "click");
  bind("restart-shell", () => term.restart(), "click");
  bind("zoom-in", () => pdf.setZoom(Math.min(4, pdf.currentScale() * 1.15)), "click");
  bind("zoom-out", () => pdf.setZoom(Math.max(0.3, pdf.currentScale() / 1.15)), "click");
  bind("zoom-fit", () => pdf.setZoom(null), "click");
  for (const b of document.querySelectorAll("#right-tabs [data-tab]")) b.addEventListener("click", () => showTab(b.dataset.tab));
  for (const n of ["files", "outline", "search"]) bind(`side-${n}`, () => showSide(n), "click");
  bind("review-accept", () => { editor.acceptAll(); updateDirty(); }, "click");
  bind("review-next", () => { editor.gotoChunk(1); showReview(); }, "click");
  bind("review-prev", () => { editor.gotoChunk(-1); showReview(); }, "click");
  bind("review-reject", () => { editor.rejectAll(); updateDirty(); needsCompile = true; }, "click");
  bind("conflict-load", () => {
    editor.applyExternal(conflict.path, conflict.content);
    conflict = null; showConflict(); updateDirty(); needsCompile = true;
  }, "click");
  bind("conflict-keep", () => {
    editor.markSaved(conflict.path, conflict.content); // next save overwrites disk
    conflict = null; showConflict(); updateDirty();
  }, "click");

  // Explorer
  bind("new-file", () => newEntry("new-file"), "click");
  bind("new-folder", () => newEntry("new-folder"), "click");
  bind("collapse-files", () => setFilesVisible(false), "click");
  bind("expand-files", () => setFilesVisible(true), "click");
  bind("tree", (e) => { if (e.target === $("tree")) { selectedDir = ""; renderTree(); } }, "click");

  // Folder picker
  bind("project", openPicker, "click");
  bind("picker-form", (e) => { e.preventDefault(); pickerLoad($("picker-path").value); }, "submit");
  bind("picker-open", () => openFolder(), "click");
  bind("picker-cancel", closePicker, "click");
  bind("picker", (e) => { if (e.target === $("picker")) closePicker(); }, "pointerdown");

  // Settings menu
  const menuBtn = $("menu-toggle");
  const menu = $("settings");
  function setMenu(open) { menuBtn.setAttribute("aria-expanded", String(open)); menu.hidden = !open; }
  menuBtn.addEventListener("click", () => setMenu(menu.hidden));
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) setMenu(false);
  });

  // Global shortcuts, in the capture phase so they work from the editor and
  // the terminal alike and win over CodeMirror's own bindings.
  const run = {
    compile: () => compile(),
    save: () => compile(),
    saveVersion: () => versions.saveVersion(),
    download,
    askClaude: () => claude.open(),
    showInPdf,
    search: () => {
      setFilesVisible(true);
      showSide("search");
      search.focus(editor.path ? editor.cursorInfo().selection.split("\n")[0] : "");
    },
    files: () => setFilesVisible(!settings.files),
    editor: () => editor.view.focus(),
    terminal: () => term.term.focus(),
  };
  window.addEventListener("keydown", (e) => {
    if (!$("dialog").hidden) return;
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
  else { setStatus("No .tex files", "yellow", "Select New file to start."); updateDirty(); renderTree(); }

  refreshDownload();
  showTab(store.get("tab", "preview"));
  restartTick();
  if (settings.main) compile();
  versions.refresh();
  initSpell();
}

let outlineTimer = null;
function scheduleOutline() {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => outline?.refresh(), 300);
}

boot().catch((e) => {
  setStatus("Error", "red", e.message);
  console.error(e);
});
