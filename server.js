#!/usr/bin/env node
// laex: local LaTeX editor. Serves the UI, reads and writes project files,
// runs latexmk, and hosts one persistent shell for the terminal pane.
//
//   node server.js [project-dir] [--open]

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { createVersions } from "./lib/versions.js";
import { createApplications } from "./lib/applications.js";
import { createNotes } from "./lib/notes.js";
import { createLetters, senderFrom, letterTex } from "./lib/letters.js";
import { search, replace } from "./lib/search.js";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
// Optional .env next to this file (LAEX_PORT, LAEX_HOSTS). Variables already
// set in the shell win.
try { process.loadEnvFile(path.join(APP_DIR, ".env")); } catch {}

const args = process.argv.slice(2);
const OPEN = args.includes("--open");
const HOST = "127.0.0.1";
const BASE_PORT = Number(process.env.LAEX_PORT) || 4777;
const PUBLIC = path.join(APP_DIR, "public");
const SHIM_DIR = path.join(APP_DIR, "shim");
const HOME = os.homedir();
// Bumped whenever the API changes, so a page served by a newer build can tell
// the server behind it is stale and needs a restart.
const API_VERSION = 3;

// Build output lives in the user cache, not the project, so the project
// directory only ever holds files you wrote.
const CACHE = process.platform === "darwin"
  ? path.join(HOME, "Library", "Caches", "laex")
  : path.join(process.env.XDG_CACHE_HOME || path.join(HOME, ".cache"), "laex");
const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "laex");
const PROMPT_FILE = path.join(CONFIG, "resume-editor.md");
const DICT_FILE = path.join(CONFIG, "dictionary.txt");
const DICTS = { "en-GB": "dictionary-en-gb", "en-US": "dictionary-en" };
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

const TEXT_EXT = new Set([".tex", ".bib", ".cls", ".sty", ".bst", ".bbx", ".cbx", ".txt", ".md",
  ".json", ".yml", ".yaml", ".csv", ".toml", ".lua", ".py", ".sh", ".js", ".html", ".css"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__"]);
const TEX_PATH = ["/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/texbin"];
const ENV_PATH = [...new Set([...(process.env.PATH || "").split(":"), ...TEX_PATH])].join(":");

// With no folder given, open the workspace that ships inside laex.
const DEFAULT_ROOT = path.join(APP_DIR, "files");
fs.mkdirSync(DEFAULT_ROOT, { recursive: true });
let ROOT = fs.realpathSync(path.resolve(args.find((a) => !a.startsWith("--")) || DEFAULT_ROOT));
let PORT = BASE_PORT;
const outRoot = () => path.join(CACHE, hash(ROOT));

// Seed the editable system prompt from the bundled default on first run.
fs.mkdirSync(CONFIG, { recursive: true });
if (!fs.existsSync(PROMPT_FILE)) fs.copyFileSync(path.join(APP_DIR, "prompts", "resume-editor.md"), PROMPT_FILE);
if (!fs.existsSync(DICT_FILE)) fs.writeFileSync(DICT_FILE, "");

const err = (status, message) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------- security
// A shell over a WebSocket is remote code execution for whoever can reach it.
// Loopback-only bind stops the network; the Host check stops DNS rebinding;
// the Origin check stops any other site open in the browser from connecting.
// LAEX_HOSTS adds tunnel hostnames, comma-separated (e.g. abcd.ngrok-free.app).
const extraHosts = (process.env.LAEX_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean);
const allowedHosts = () => new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...extraHosts]);
const hostOk = (req) => allowedHosts().has(req.headers.host);
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return false;
  try { return allowedHosts().has(new URL(o).host); } catch { return false; }
}

function inRoot(rel) {
  const p = path.resolve(ROOT, String(rel ?? ""));
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw err(400, "path outside project");
  return p;
}
const relOf = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
const isText = (p) => TEXT_EXT.has(path.extname(p).toLowerCase());

function validName(name) {
  if (!name || /[\\/]|^\.\.?$/.test(name) || name.length > 200) throw err(400, "invalid name");
  return name;
}

// ------------------------------------------------------------------- files
// Every file and folder (hidden ones excepted), for the explorer.
async function listTree() {
  const tree = [];
  const walk = async (dir, depth) => {
    if (depth > 6 || tree.length > 4000) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { tree.push({ path: relOf(abs), type: "dir" }); await walk(abs, depth + 1); }
      else if (e.isFile()) tree.push({ path: relOf(abs), type: "file", text: isText(e.name) });
    }
  };
  await walk(ROOT, 0);
  return tree.sort((a, b) => a.path.localeCompare(b.path));
}

async function listMains(tree) {
  const mains = [];
  for (const f of tree.filter((e) => e.type === "file" && e.path.endsWith(".tex"))) {
    try {
      const abs = inRoot(f.path);
      const head = (await fsp.readFile(abs, "utf8")).slice(0, 20000);
      if (/^[^%\n]*\\documentclass/m.test(head)) mains.push({ f: f.path, t: (await fsp.stat(abs)).mtimeMs });
    } catch {}
  }
  // Most recently edited first, so a fresh project opens on the live draft.
  return mains.sort((a, b) => b.t - a.t).map((m) => m.f);
}

async function projectInfo() {
  const tree = await listTree();
  return { tree, files: tree.filter((e) => e.type === "file" && e.text).map((e) => e.path), mains: await listMains(tree) };
}

// Deleting moves to the Bin rather than unlinking, so a slip is recoverable.
async function moveToTrash(abs) {
  const bin = process.platform === "darwin" ? path.join(HOME, ".Trash") : path.join(HOME, ".local", "share", "Trash", "files");
  await fsp.mkdir(bin, { recursive: true });
  let dest = path.join(bin, path.basename(abs));
  if (fs.existsSync(dest)) {
    const ext = path.extname(abs);
    dest = path.join(bin, `${path.basename(abs, ext)} ${new Date().toISOString().replace(/[:.]/g, "-")}${ext}`);
  }
  await fsp.rename(abs, dest);
}

async function fileOp({ op, path: rel, to }) {
  const abs = inRoot(rel);
  if (op === "mkfile" || op === "mkdir") {
    if (abs === ROOT) throw err(400, "name required");
    validName(path.basename(abs));
    if (fs.existsSync(abs)) throw err(409, `${rel} already exists`);
    await fsp.mkdir(op === "mkdir" ? abs : path.dirname(abs), { recursive: true });
    if (op === "mkfile") await fsp.writeFile(abs, "", { flag: "wx" });
  } else if (op === "rename") {
    const dest = inRoot(to);
    if (abs === ROOT || dest === ROOT) throw err(400, "cannot rename the project folder");
    validName(path.basename(dest));
    if (fs.existsSync(dest)) throw err(409, `${to} already exists`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(abs, dest);
  } else if (op === "copy") {
    const dest = inRoot(to);
    validName(path.basename(dest));
    if (fs.existsSync(dest)) throw err(409, `${to} already exists`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(abs, dest);
  } else if (op === "trash") {
    if (abs === ROOT) throw err(400, "cannot delete the project folder");
    await moveToTrash(abs);
  } else {
    throw err(400, "unknown op");
  }
  return projectInfo();
}

// Subfolders of a directory, for the folder picker.
async function listDirs(dir) {
  const abs = path.resolve(dir || HOME);
  const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => { throw err(404, "cannot read folder"); });
  const dirs = [];
  let tex = 0;
  for (const e of entries) {
    if (e.name.endsWith(".tex") && e.isFile()) tex++;
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    dirs.push(e.name);
  }
  return { path: abs, parent: path.dirname(abs) === abs ? null : path.dirname(abs), home: HOME, dirs: dirs.sort((a, b) => a.localeCompare(b)), tex };
}

// What we last wrote to each file, so our own saves don't echo back to the
// editor as "changed on disk".
const lastWritten = new Map();

// ------------------------------------------------------------ kitty theme
// Reads ~/.config/kitty/kitty.conf (and one level of `include`) so the
// terminal pane uses your kitty font and colours. Defaults are kitty's own.
function kittyTheme() {
  const t = {
    font_family: "Menlo", font_size: 13,
    foreground: "#dddddd", background: "#000000", cursor: "#cccccc", cursor_text_color: "#111111",
    selection_foreground: "#000000", selection_background: "#fffacd",
    color0: "#000000", color8: "#767676", color1: "#cc0403", color9: "#f2201f",
    color2: "#19cb00", color10: "#23fd00", color3: "#cecb00", color11: "#fffd00",
    color4: "#0d73cc", color12: "#1a8fff", color5: "#cb1ed1", color13: "#fd28ff",
    color6: "#0dcdcd", color14: "#14ffff", color7: "#dddddd", color15: "#ffffff",
  };
  const dir = process.env.KITTY_CONFIG_DIRECTORY || path.join(HOME, ".config", "kitty");
  const read = (file, depth) => {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { return; }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(\S+)\s+(.+)$/);
      if (!m) continue;
      const [, key, val] = m;
      if (key === "include" && depth < 2) read(path.resolve(dir, val.replace(/^~/, HOME)), depth + 1);
      else if (key in t) t[key] = key === "font_size" ? Number(val) || t.font_size : val;
    }
  };
  read(path.join(dir, "kitty.conf"), 0);
  if (!t.font_family || t.font_family === "monospace") t.font_family = "Menlo";
  return t;
}

// ----------------------------------------------------------------- compile
const ENGINES = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" };
let compileChain = Promise.resolve();
const lastBuild = new Map(); // `${ROOT}\0${main}` -> result

function outDirFor(mainRel) { return path.join(outRoot(), hash(mainRel)); }
function pdfPathFor(mainRel) { return path.join(outDirFor(mainRel), path.basename(mainRel, ".tex") + ".pdf"); }

function parseLog(log, cwd) {
  const errors = [];
  const seen = new Set();
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(.*?\.(?:tex|cls|sty|bib)):(\d+): (.*)$/);
    if (!m) continue;
    let file = m[1];
    try { file = relOf(path.resolve(cwd, file)); } catch {}
    // The offending source follows a few lines later as "l.<n> ...".
    let context = "";
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const lm = lines[j].match(/^l\.\d+\s?(.*)$/);
      if (lm) { context = lm[1].trim(); break; }
    }
    const key = `${file}:${m[2]}:${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push({ file, line: Number(m[2]), message: m[3].trim(), context });
  }
  const warnings = (log.match(/^(LaTeX|Package \S+) Warning/gm) || []).length;
  const overfullLines = [];
  for (const m of log.matchAll(/^Overfull \\hbox \(([\d.]+)pt too wide\) (?:in paragraph|in alignment|detected) at lines? (\d+)/gm)) {
    overfullLines.push({ line: Number(m[2]), pt: Number(m[1]) });
  }
  const overfull = (log.match(/^Overfull \\hbox/gm) || []).length;
  const pages = Number((log.match(/Output written on [\s\S]*?\((\d+) pages?/) || [])[1]) || null;
  return { errors, warnings, overfull, overfullLines, pages };
}

function runLatexmk(mainRel, engine) {
  return new Promise(async (resolve) => {
    const mainAbs = inRoot(mainRel);
    const cwd = path.dirname(mainAbs);
    const out = outDirFor(mainRel);
    await fsp.mkdir(out, { recursive: true });
    const started = Date.now();
    const argv = [ENGINES[engine] || "-pdf", "-f", "-interaction=nonstopmode", "-file-line-error",
      "-synctex=1", `-outdir=${out}`, path.basename(mainAbs)];
    const child = spawn("latexmk", argv, { cwd, env: { ...process.env, PATH: ENV_PATH } });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, errors: [{ file: mainRel, line: 1, message: `Could not run latexmk: ${e.message}` }], ms: 0 });
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      const logFile = path.join(out, path.basename(mainAbs, ".tex") + ".log");
      const log = await fsp.readFile(logFile, "utf8").catch(() => output);
      const parsed = parseLog(log, cwd);
      // `pdf`: there is a PDF to show. `fresh`: this run wrote it. latexmk
      // skips the build when nothing changed, which still leaves a PDF.
      let pdf = false, fresh = false;
      try {
        const st = await fsp.stat(pdfPathFor(mainRel));
        pdf = true;
        fresh = st.mtimeMs >= started - 1000;
      } catch {}
      resolve({ ok: code === 0 && parsed.errors.length === 0, code, pdf, fresh, ms: Date.now() - started, ...parsed });
    });
  });
}

function compile(mainRel, engine) {
  const root = ROOT;
  const run = compileChain.then(() => runLatexmk(mainRel, engine)).then((r) => {
    lastBuild.set(`${root}\0${mainRel}`, { ...r, at: Date.now() });
    return r;
  });
  compileChain = run.catch(() => {});
  return run;
}

function synctexEdit(mainRel, page, x, y) {
  return new Promise((resolve) => {
    execFile("synctex", ["edit", "-o", `${page}:${x}:${y}:${pdfPathFor(mainRel)}`],
      { env: { ...process.env, PATH: ENV_PATH } }, (e, stdout) => {
        if (e) return resolve(null);
        const input = stdout.match(/^Input:(.*)$/m);
        const line = stdout.match(/^Line:(\d+)$/m);
        if (!input || !line) return resolve(null);
        let file;
        try { file = relOf(inRoot(path.resolve(path.dirname(inRoot(mainRel)), input[1].trim()))); } catch { return resolve(null); }
        resolve({ file, line: Number(line[1]) });
      });
  });
}

// Source position -> PDF position, for "Show in PDF".
function synctexView(mainRel, fileRel, line, col) {
  return new Promise((resolve) => {
    execFile("synctex", ["view", "-i", `${line}:${col}:${inRoot(fileRel)}`, "-o", pdfPathFor(mainRel)],
      { env: { ...process.env, PATH: ENV_PATH } }, (e, stdout) => {
        if (e) return resolve(null);
        const num = (k) => Number((stdout.match(new RegExp(`^${k}:([\\d.-]+)$`, "m")) || [])[1]);
        const page = num("Page");
        if (!page) return resolve(null);
        resolve({ page, x: num("h"), y: num("v"), w: num("W"), h: num("H") });
      });
  });
}

// PDF -> plain text, the way an applicant tracking system would read it.
function pdfText(mainRel) {
  return new Promise((resolve) => {
    execFile("pdftotext", ["-enc", "UTF-8", pdfPathFor(mainRel), "-"], { env: { ...process.env, PATH: ENV_PATH }, maxBuffer: 8 << 20 },
      (e, stdout) => resolve(e ? null : stdout));
  });
}

// ------------------------------------------------------------ claude context
// The browser reports what you're looking at; the UserPromptSubmit hook that
// shim/claude installs fetches /api/context before every prompt, so Claude
// always knows the open file, cursor, selection and last build result.
let editorState = { file: null, line: 1, col: 1, selection: "", selFrom: 0, selTo: 0, dirty: false, main: null, prompt: true, at: 0 };

function contextText() {
  const s = editorState;
  if (!s.file || !s.at) return "";
  const out = [];
  out.push("<laex-editor-context>");
  out.push("The user is working in laex, a LaTeX editor whose terminal pane you are running in. This is what they have open right now; use it to resolve words like \"this\", \"here\", \"this bullet\", \"this section\".");
  out.push(`Project folder: ${ROOT}`);
  out.push(`Open file: ${s.file} (cursor at line ${s.line}, column ${s.col})`);
  if (s.main) out.push(`Main document (the one that gets compiled): ${s.main}`);
  if (s.selection) {
    out.push(`Selected text (lines ${s.selFrom}-${s.selTo}):`);
    out.push("```latex", s.selection, "```");
  }
  try {
    const lines = fs.readFileSync(inRoot(s.file), "utf8").split("\n");
    const from = Math.max(1, s.line - 6), to = Math.min(lines.length, s.line + 6);
    out.push(`Lines ${from}-${to} around the cursor (> marks the cursor line):`);
    out.push("```latex");
    for (let i = from; i <= to; i++) out.push(`${i === s.line ? ">" : " "}${String(i).padStart(4)}  ${lines[i - 1]}`);
    out.push("```");
  } catch {}
  if (s.dirty) out.push("Note: the editor has unsaved changes; laex autosaves within a second or two, so re-read the file before editing it.");
  const b = s.main && lastBuild.get(`${ROOT}\0${s.main}`);
  if (b) {
    const status = b.errors?.length ? `${b.errors.length} error(s)` : "compiled cleanly";
    out.push(`Last build of ${s.main}: ${status}${b.pages ? `, ${b.pages} page(s)` : ""}${b.overfull ? `, ${b.overfull} overfull box(es)` : ""}.`);
    for (const e of (b.errors || []).slice(0, 5)) out.push(`  ${e.file}:${e.line}: ${e.message}${e.context ? `  [${e.context}]` : ""}`);
  }
  out.push("laex rebuilds the PDF automatically after you save a file; the user sees the result live.");
  out.push("</laex-editor-context>");
  return out.join("\n");
}

// ---------------------------------------------------------------- terminal
// One shell per server, kept across page reloads so a running `claude`
// session survives a refresh. Output is buffered and replayed on reconnect.
const SCROLLBACK = 400_000;
let shell = null;
let scrollback = "";
const ptyClients = new Set();
let lastSize = { cols: 100, rows: 30 };

function shellEnv() {
  const env = { ...process.env };
  // If laex was launched from kitty/iTerm/VS Code, don't let programs in
  // this pane think they're in that terminal and use its private protocols.
  for (const k of Object.keys(env)) {
    if (/^(KITTY_|ITERM_|TERM_PROGRAM|TERM_SESSION_ID|VSCODE_|WEZTERM_|ALACRITTY_|GHOSTTY_)/.test(k)) delete env[k];
  }
  return {
    ...env, TERM: "xterm-256color", COLORTERM: "truecolor",
    LAEX: "1", LAEX_URL: `http://127.0.0.1:${PORT}/`, LAEX_SHIM: SHIM_DIR,
    PATH: ENV_PATH,
  };
}

// The shim dir must end up first on PATH, but a login shell's profile
// rebuilds PATH after we set it. zsh gets a ZDOTDIR that runs your own
// startup files and then prepends the shim silently; other shells get the
// export typed in as their first command.
const isZsh = () => path.basename(process.env.SHELL || "/bin/zsh") === "zsh";
function shellStartEnv() {
  if (!isZsh()) return {};
  return { ZDOTDIR: path.join(SHIM_DIR, "zsh"), LAEX_ORIG_ZDOTDIR: process.env.ZDOTDIR || "" };
}

function ptyBroadcast(data) {
  scrollback += data;
  if (scrollback.length > SCROLLBACK) scrollback = scrollback.slice(-SCROLLBACK);
  for (const ws of ptyClients) if (ws.readyState === 1) ws.send(data);
}

function startShell() {
  const sh = process.env.SHELL || "/bin/zsh";
  scrollback = "";
  const s = pty.spawn(sh, ["-l"], { name: "xterm-256color", cols: lastSize.cols, rows: lastSize.rows, cwd: ROOT, env: { ...shellEnv(), ...shellStartEnv() } });
  shell = s;
  s.onData((d) => { if (shell === s) ptyBroadcast(d); });
  s.onExit(() => {
    if (shell !== s) return; // replaced by a restart
    shell = null;
    ptyBroadcast("\r\n\x1b[2m[shell exited. Press any key to start a new one]\x1b[0m\r\n");
  });
  if (!isZsh()) s.write(` export PATH="${SHIM_DIR}:$PATH"; clear\r`);
}

function restartShell() {
  const old = shell;
  shell = null;
  try { old?.kill(); } catch {}
  startShell();
  for (const ws of ptyClients) if (ws.readyState === 1) ws.send("\x1bc");
}

// ------------------------------------------------------------------ watch
let watcher = null;
let knownPaths = new Set();
const pending = new Map();
let treeTimer = null;

function scheduleTree() {
  clearTimeout(treeTimer);
  treeTimer = setTimeout(async () => {
    const info = await projectInfo();
    knownPaths = new Set(info.tree.map((e) => e.path));
    emit({ type: "files", ...info });
  }, 150);
}

// Watch the project so edits made in the terminal (say, by Claude) show up
// in the editor and trigger a rebuild, and new or deleted files show in the
// explorer.
function watchRoot() {
  watcher?.close();
  pending.forEach((t) => clearTimeout(t));
  pending.clear();
  try {
    const root = ROOT;
    watcher = fs.watch(root, { recursive: true }, (_ev, filename) => {
      if (!filename || root !== ROOT) return;
      const rel = filename.split(path.sep).join("/");
      if (rel.split("/").some((part) => part.startsWith(".") || SKIP_DIRS.has(part))) return;
      if (!knownPaths.has(rel) || !fs.existsSync(path.join(root, rel))) scheduleTree();
      if (!isText(rel)) return;
      clearTimeout(pending.get(rel));
      pending.set(rel, setTimeout(async () => {
        pending.delete(rel);
        const text = await fsp.readFile(inRoot(rel), "utf8").catch(() => null);
        if (text === null || text === lastWritten.get(rel)) return;
        lastWritten.set(rel, text);
        emit({ type: "file", path: rel, content: text });
      }, 80));
    });
  } catch (e) {
    console.warn("laex: file watching unavailable:", e.message);
  }
}

async function switchRoot(dir) {
  const abs = fs.realpathSync(path.resolve(String(dir || "").replace(/^~(?=$|\/)/, HOME)));
  if (!(await fsp.stat(abs)).isDirectory()) throw err(400, "not a folder");
  ROOT = abs;
  lastWritten.clear();
  editorState = { ...editorState, file: null, main: null, selection: "", at: 0 };
  knownPaths = new Set((await listTree()).map((e) => e.path));
  watchRoot();
  restartShell();
  console.log(`laex  now editing ${ROOT}`);
  emit({ type: "root", root: ROOT });
}

// ---------------------------------------------------------------- versions
const versions = createVersions({
  getRoot: () => ROOT,
  listTextFiles: async () => (await listTree()).filter((e) => e.type === "file" && e.text).map((e) => e.path),
  pdfPathFor,
});
const applications = createApplications({ getRoot: () => ROOT });
const notes = createNotes({ getRoot: () => ROOT });
const letters = createLetters({ getRoot: () => ROOT });

// Typesets a cover letter with the main CV's name and contact line. Built in
// the cache, one folder per letter, with a single pdflatex run; one build at
// a time, since the live preview asks for a new one on every pause in typing.
let letterChain = Promise.resolve();
function letterPdf(id, mainRel) {
  const run = letterChain.then(() => buildLetter(id, mainRel));
  letterChain = run.catch(() => {});
  return run;
}
async function buildLetter(id, mainRel) {
  const letter = await letters.get(id);
  if (!letter) throw err(404, "no such letter");
  const source = mainRel ? await fsp.readFile(inRoot(mainRel), "utf8").catch(() => "") : "";
  const sender = senderFrom(source);
  const dir = path.join(CACHE, "letters", hash(ROOT), id.replace(/[^\w-]/g, ""));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "letter.tex"), letterTex(letter, sender));
  await fsp.rm(path.join(dir, "letter.pdf"), { force: true });
  await new Promise((resolve) => execFile("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "letter.tex"],
    { cwd: dir, env: { ...process.env, PATH: ENV_PATH }, timeout: 30_000 }, () => resolve()));
  const pdf = await fsp.readFile(path.join(dir, "letter.pdf")).catch(() => null);
  if (!pdf) {
    const log = await fsp.readFile(path.join(dir, "letter.log"), "utf8").catch(() => "");
    const why = log.match(/^! (.*)$/m)?.[1] || "pdflatex did not produce a PDF";
    throw err(422, `The PDF could not be built: ${why}`);
  }
  const compact = (s) => String(s || "").replace(/[^\p{L}\p{N}]+/gu, "");
  const name = [compact(sender.name), "CoverLetter", compact(letter.company)].filter(Boolean).join("_");
  return { pdf, name };
}

// ------------------------------------------------------------- ask claude
// "Ask Claude" buttons send a prompt to the terminal. If Claude is already
// running there, the prompt is pasted and submitted. If the terminal is idle
// at a shell prompt, claude is started with the prompt. Anything else (an
// editor, a pager) is left alone.
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "nu"]);
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function terminalState() {
  const proc = shell ? path.basename(shell.process || "") : null;
  return { running: !!shell, process: proc, claude: proc === "claude", idle: !proc || SHELLS.has(proc) };
}

function askClaude(prompt) {
  if (!shell) startShell();
  const t = terminalState();
  const text = String(prompt || "").replace(/\r/g, "").slice(0, 20000);
  if (!text.trim()) throw err(400, "empty prompt");
  if (t.claude) {
    shell.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => shell?.write("\r"), 80);
    return { sent: "claude" };
  }
  if (t.idle) {
    shell.write(` claude ${shellQuote(text)}\r`);
    return { sent: "shell" };
  }
  throw err(409, `The terminal is busy running ${t.process}. Close it, or start claude, and try again.`);
}

const safeName = (s) => String(s || "").replace(/[^\w .()&+,-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120);

// ------------------------------------------------------------------- http
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".map": "application/json", ".ttf": "font/ttf",
  ".woff2": "font/woff2", ".png": "image/png",
};

const VIEWABLE = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function send(res, status, body, type = "application/json") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(data);
}

async function readRaw(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw err(413, "body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
const readBody = async (req, limit) => (await readRaw(req, limit)).toString("utf8");
const readJson = async (req) => JSON.parse(await readBody(req));

async function handle(req, res) {
  if (!hostOk(req)) return send(res, 403, { error: "bad host" });
  if (req.method !== "GET" && !originOk(req)) return send(res, 403, { error: "bad origin" });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = Object.fromEntries(url.searchParams);
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case "GET /api/project": {
      knownPaths = new Set((await listTree()).map((e) => e.path));
      return send(res, 200, { api: API_VERSION, root: ROOT, name: path.basename(ROOT), home: HOME, ...(await projectInfo()), kitty: kittyTheme(), promptFile: PROMPT_FILE });
    }
    case "GET /api/file": {
      const text = await fsp.readFile(inRoot(q.path), "utf8").catch(() => null);
      return text === null ? send(res, 404, { error: "not found" }) : send(res, 200, text, "text/plain; charset=utf-8");
    }
    case "PUT /api/file": {
      const abs = inRoot(q.path);
      const text = await readBody(req);
      lastWritten.set(relOf(abs), text);
      await fsp.writeFile(abs, text, "utf8");
      return send(res, 200, { ok: true });
    }
    case "POST /api/fs":
      return send(res, 200, await fileOp(await readJson(req)));
    case "GET /api/dirs":
      return send(res, 200, await listDirs(q.path));
    case "POST /api/root":
      await switchRoot((await readJson(req)).path);
      return send(res, 200, { root: ROOT });
    case "POST /api/compile": {
      const { main, engine } = await readJson(req);
      inRoot(main);
      return send(res, 200, await compile(main, engine));
    }
    // PDFs and images in the project, shown as they are (opened from the file tree).
    case "GET /api/raw": {
      const type = VIEWABLE[path.extname(q.path || "").toLowerCase()];
      if (!type) return send(res, 415, { error: "only PDFs and images can be opened" });
      const data = await fsp.readFile(inRoot(q.path)).catch(() => null);
      if (!data) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="${safeName(path.basename(q.path, path.extname(q.path))) || "file"}${path.extname(q.path)}"` });
      return res.end(data);
    }
    case "GET /api/pdf": {
      inRoot(q.main);
      const file = pdfPathFor(q.main);
      const data = await fsp.readFile(file).catch(() => null);
      if (!data) return send(res, 404, { error: "no pdf yet" });
      const headers = { "Content-Type": "application/pdf", "Cache-Control": "no-store" };
      if (q.download) {
      const name = (safeName(q.name) || path.basename(file, ".pdf")) + ".pdf";
      headers["Content-Disposition"] = `attachment; filename="${name}"`;
    }
      res.writeHead(200, headers);
      return res.end(data);
    }
    case "GET /api/log": {
      inRoot(q.main);
      const log = await fsp.readFile(pdfPathFor(q.main).replace(/\.pdf$/, ".log"), "utf8").catch(() => "No log yet.");
      return send(res, 200, log, "text/plain; charset=utf-8");
    }
    case "GET /api/synctex":
      inRoot(q.main);
      return send(res, 200, (await synctexEdit(q.main, Number(q.page), Number(q.x), Number(q.y))) || {});
    case "POST /api/state": {
      const s = await readJson(req);
      editorState = {
        file: typeof s.file === "string" ? s.file : null,
        line: Number(s.line) || 1, col: Number(s.col) || 1,
        selection: String(s.selection || "").slice(0, 4000),
        selFrom: Number(s.selFrom) || 0, selTo: Number(s.selTo) || 0,
        dirty: !!s.dirty, main: typeof s.main === "string" ? s.main : null,
        prompt: s.prompt !== false, at: Date.now(),
      };
      return send(res, 200, { ok: true });
    }
    // Used by shim/claude and its hook. Plain text so they need only curl.
    case "GET /api/context":
      return send(res, 200, contextText(), "text/plain; charset=utf-8");
    case "GET /api/claude-prompt":
      return send(res, 200, editorState.prompt ? PROMPT_FILE : "", "text/plain; charset=utf-8");
    case "GET /api/prompt":
      return send(res, 200, await fsp.readFile(PROMPT_FILE, "utf8"), "text/plain; charset=utf-8");
    case "PUT /api/prompt":
      await fsp.writeFile(PROMPT_FILE, await readBody(req), "utf8");
      return send(res, 200, { ok: true });
    case "POST /api/prompt/reset":
      await fsp.copyFile(path.join(APP_DIR, "prompts", "resume-editor.md"), PROMPT_FILE);
      return send(res, 200, { ok: true });

    case "GET /api/synctex/view":
      inRoot(q.main);
      return send(res, 200, (await synctexView(q.main, q.file, Number(q.line) || 1, Number(q.col) || 0)) || {});
    case "GET /api/text": {
      inRoot(q.main);
      const text = await pdfText(q.main);
      return text === null ? send(res, 501, { error: "pdftotext unavailable" }) : send(res, 200, text, "text/plain; charset=utf-8");
    }

    // Versions
    case "GET /api/versions":
      return send(res, 200, await versions.list());
    case "POST /api/versions": {
      const b = await readJson(req);
      if (b.main) inRoot(b.main);
      return send(res, 200, await versions.save({ label: b.label, main: b.main }));
    }
    case "GET /api/versions/file": {
      const text = await versions.fileAt(q.id, q.path);
      return text === null ? send(res, 404, { error: "not in this version" }) : send(res, 200, text, "text/plain; charset=utf-8");
    }
    case "GET /api/versions/pdf": {
      const data = await fsp.readFile(versions.pdfOf(q.id)).catch(() => null);
      if (!data) return send(res, 404, { error: "no pdf in this version" });
      const headers = { "Content-Type": "application/pdf", "Cache-Control": "no-store" };
      if (q.download) headers["Content-Disposition"] = `attachment; filename="${safeName(q.name) || "version"}.pdf"`;
      res.writeHead(200, headers);
      return res.end(data);
    }
    case "POST /api/versions/restore": {
      const b = await readJson(req);
      return send(res, 200, await versions.restore(b.id, b.main));
    }
    case "POST /api/versions/rename": {
      const b = await readJson(req);
      return send(res, 200, await versions.rename(b.id, b.label));
    }
    // Application tracker
    case "GET /api/applications":
      return send(res, 200, await applications.list());
    case "POST /api/applications":
      return send(res, 200, await applications.save(await readJson(req)));
    case "PUT /api/applications/pdf":
      return send(res, 200, await applications.attachPdf(q.id, await readRaw(req), q.name));
    case "GET /api/applications/pdf": {
      const data = await fsp.readFile(applications.pdfPath(q.id)).catch(() => null);
      if (!data) return send(res, 404, { error: "no CV uploaded for this application" });
      const headers = { "Content-Type": "application/pdf", "Cache-Control": "no-store" };
      if (q.download) headers["Content-Disposition"] = `attachment; filename="${safeName(q.name) || "CV"}.pdf"`;
      res.writeHead(200, headers);
      return res.end(data);
    }
    case "POST /api/applications/delete":
      await applications.remove((await readJson(req)).id);
      return send(res, 200, { ok: true });

    // Cover letters
    case "GET /api/letters":
      return send(res, 200, await letters.list());
    case "POST /api/letters":
      return send(res, 200, await letters.save(await readJson(req)));
    case "POST /api/letters/delete":
      await letters.remove((await readJson(req)).id);
      return send(res, 200, { ok: true });
    case "GET /api/letters/pdf": {
      const { pdf, name } = await letterPdf(q.id, q.main);
      const headers = { "Content-Type": "application/pdf", "Cache-Control": "no-store" };
      if (q.download) {
        headers["Content-Disposition"] = `attachment; filename="${safeName(name) || "Cover letter"}.pdf"`;
        // Keep a copy with the project, where the file tree shows it.
        await fsp.mkdir(inRoot("coverLetters"), { recursive: true });
        await fsp.writeFile(inRoot(`coverLetters/${safeName(name) || "Cover letter"}.pdf`), pdf);
      }
      res.writeHead(200, headers);
      return res.end(pdf);
    }

    // Notes
    case "GET /api/notes":
      return send(res, 200, await notes.list());
    case "POST /api/notes":
      return send(res, 200, await notes.save(await readJson(req)));
    case "POST /api/notes/delete":
      await notes.remove((await readJson(req)).id);
      return send(res, 200, { ok: true });

    case "POST /api/versions/delete":
      await versions.remove((await readJson(req)).id);
      return send(res, 200, { ok: true });

    // Find and replace
    case "POST /api/search": {
      const files = (await projectInfo()).files;
      return send(res, 200, await search(ROOT, files, await readJson(req)));
    }
    case "POST /api/replace": {
      const b = await readJson(req);
      const all = (await projectInfo()).files;
      const files = Array.isArray(b.files) ? b.files.filter((f) => all.includes(f)) : all;
      const r = await replace(ROOT, files, { ...b, replacement: String(b.replacement ?? "") });
      // The editor applies these itself; don't echo them back as outside edits.
      for (const c of r.changed) lastWritten.set(c.file, c.text);
      return send(res, 200, r);
    }

    // Terminal and Claude
    case "GET /api/terminal":
      return send(res, 200, terminalState());
    case "POST /api/claude/ask":
      return send(res, 200, askClaude((await readJson(req)).prompt));

    // Spelling
    case "GET /api/dict": {
      const pkg = DICTS[q.lang] || DICTS["en-GB"];
      const dir = path.join(APP_DIR, "node_modules", pkg);
      const [aff, dic] = await Promise.all([fsp.readFile(path.join(dir, "index.aff"), "utf8"), fsp.readFile(path.join(dir, "index.dic"), "utf8")]);
      return send(res, 200, { aff, dic });
    }
    case "GET /api/dict/words": {
      const tech = await fsp.readFile(path.join(APP_DIR, "dict", "tech-words.txt"), "utf8").catch(() => "");
      const personal = await fsp.readFile(DICT_FILE, "utf8").catch(() => "");
      return send(res, 200, { tech: tech.split(/\s+/).filter(Boolean), personal: personal.split(/\r?\n/).map((w) => w.trim()).filter(Boolean) });
    }
    case "POST /api/dict/add": {
      const word = String((await readJson(req)).word || "").trim();
      if (!/^[\p{L}\p{N}'’.-]{1,60}$/u.test(word)) throw err(400, "not a word");
      const current = (await fsp.readFile(DICT_FILE, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean);
      if (!current.includes(word)) await fsp.writeFile(DICT_FILE, [...current, word].join("\n") + "\n");
      return send(res, 200, { ok: true });
    }
    case "GET /api/dict/personal":
      return send(res, 200, await fsp.readFile(DICT_FILE, "utf8").catch(() => ""), "text/plain; charset=utf-8");
    case "PUT /api/dict/personal":
      await fsp.writeFile(DICT_FILE, await readBody(req), "utf8");
      return send(res, 200, { ok: true });

    // Job description for the job-match tab, kept with the project
    case "GET /api/job":
      return send(res, 200, await fsp.readFile(path.join(ROOT, ".laex", "job.md"), "utf8").catch(() => ""), "text/plain; charset=utf-8");
    case "PUT /api/job": {
      await fsp.mkdir(path.join(ROOT, ".laex"), { recursive: true });
      const ignore = path.join(ROOT, ".laex", ".gitignore");
      if (!fs.existsSync(ignore)) await fsp.writeFile(ignore, "*\n");
      await fsp.writeFile(path.join(ROOT, ".laex", "job.md"), await readBody(req), "utf8");
      return send(res, 200, { ok: true });
    }
  }

  if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const abs = path.resolve(PUBLIC, rel);
    if (!abs.startsWith(PUBLIC + path.sep)) return send(res, 404, "not found", "text/plain");
    const data = await fsp.readFile(abs).catch(() => null);
    if (!data) return send(res, 404, "not found", "text/plain");
    return send(res, 200, data, MIME[path.extname(abs)] || "application/octet-stream");
  }

  send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => send(res, e.status || 500, { error: e.code === "ENOENT" ? "not found" : e.message }));
});

// -------------------------------------------------------------- websockets
const wssPty = new WebSocketServer({ noServer: true });
const wssEvents = new WebSocketServer({ noServer: true });
const eventClients = new Set();

server.on("upgrade", (req, socket, head) => {
  if (!hostOk(req) || !originOk(req)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return socket.destroy(); }
  const { pathname } = new URL(req.url, "http://x");
  const target = pathname === "/ws/pty" ? wssPty : pathname === "/ws/events" ? wssEvents : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

wssPty.on("connection", (ws) => {
  ptyClients.add(ws);
  if (!shell) startShell();
  else if (scrollback) ws.send(scrollback);
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === "in") {
      if (!shell) { startShell(); return; }
      shell.write(msg.d);
    } else if (msg.t === "resize" && msg.cols > 0 && msg.rows > 0) {
      lastSize = { cols: Math.min(msg.cols, 1000), rows: Math.min(msg.rows, 500) };
      shell?.resize(lastSize.cols, lastSize.rows);
    } else if (msg.t === "restart") {
      restartShell();
    }
  });
  ws.on("close", () => ptyClients.delete(ws));
});

wssEvents.on("connection", (ws) => {
  eventClients.add(ws);
  ws.on("close", () => eventClients.delete(ws));
});
const emit = (msg) => { for (const ws of eventClients) if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

// ------------------------------------------------------------------ start
function openApp(url) {
  const chrome = "/Applications/Google Chrome.app";
  if (process.platform === "darwin" && fs.existsSync(chrome)) {
    spawn("open", ["-na", "Google Chrome", "--args", `--app=${url}`], { stdio: "ignore", detached: true }).unref();
  } else {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  }
}

function listen(port, tries = 20) {
  PORT = port;
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && tries > 0) return listen(port + 1, tries - 1);
    console.error(`laex: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, HOST, async () => {
    knownPaths = new Set((await listTree()).map((e) => e.path));
    watchRoot();
    const url = `http://127.0.0.1:${PORT}/`;
    console.log(`laex  ${ROOT}\n      ${url}`);
    if (OPEN) openApp(url);
  });
}

function shutdown() {
  try { shell?.kill(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

listen(BASE_PORT);
