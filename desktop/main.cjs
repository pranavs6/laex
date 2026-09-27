// laex as a desktop app: starts the laex server with Electron's own Node and
// shows it in a native window with its own Dock icon and menus.

const { app, BrowserWindow, Menu, dialog, shell, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const { fork } = require("node:child_process");

// Where the laex checkout lives. A packaged app records it at build time.
function laexRoot() {
  if (process.env.LAEX_HOME) return process.env.LAEX_HOME;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "laex-root.json"), "utf8")).root; } catch {}
  return path.resolve(__dirname, "..");
}

const ROOT = laexRoot();
const SMOKE = process.env.LAEX_SMOKE; // path to write a screenshot to, then quit
const ICON = path.join(__dirname, "icon.png");
let server = null;
let win = null;
let base = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function waitForServer(url, tries = 100) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(url, (res) => { res.resume(); resolve(); }).on("error", () => {
        if (n <= 0) reject(new Error("laex server did not start"));
        else setTimeout(() => attempt(n - 1), 100);
      });
    };
    attempt(tries);
  });
}

async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}/`;
  const dir = process.argv.slice(1).find((a) => !a.startsWith("-") && a !== "." && fs.existsSync(a) && fs.statSync(a).isDirectory() && path.resolve(a) !== __dirname);
  server = fork(path.join(ROOT, "server.js"), dir ? [path.resolve(dir)] : [], {
    cwd: ROOT,
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LAEX_PORT: String(port) },
    stdio: "inherit",
  });
  server.on("exit", (code) => { if (!app.isQuitting) { dialog.showErrorBox("laex", `The laex server stopped (exit code ${code}).`); app.quit(); } });
  await waitForServer(`${base}api/project`);
}

function openFolder() {
  dialog.showOpenDialog(win, { title: "Open a LaTeX project", properties: ["openDirectory", "createDirectory"] }).then(({ canceled, filePaths }) => {
    if (canceled || !filePaths[0]) return;
    const body = JSON.stringify({ path: filePaths[0] });
    const req = http.request(`${base}api/root`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Origin: base.replace(/\/$/, "") },
    }, (res) => res.resume());
    req.on("error", (e) => dialog.showErrorBox("laex", e.message));
    req.end(body);
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: openFolder },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
      { role: "togglefullscreen" },
    ] },
    { role: "windowMenu" },
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 1000, minHeight: 640,
    title: "LAEX", backgroundColor: "#0e1011", icon: ICON, show: !SMOKE,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Links in the PDF and elsewhere open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(base)) { e.preventDefault(); if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); }
  });
  // The page asks before closing with unsaved edits; Electron needs us to
  // show that question ourselves.
  win.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question", buttons: ["Close without saving", "Cancel"], defaultId: 1, cancelId: 1,
      message: "You have unsaved changes", detail: "laex saves automatically within a second or two. Close anyway?",
    });
    if (choice === 0) e.preventDefault();
  });
  if (SMOKE) {
    win.webContents.once("did-finish-load", () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(SMOKE, img.toPNG());
      app.quit();
    }, 6000));
  }
  win.loadURL(base);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.setName("LAEX");
  app.whenReady().then(async () => {
    if (process.platform === "darwin" && fs.existsSync(ICON)) app.dock?.setIcon(nativeImage.createFromPath(ICON));
    buildMenu();
    try {
      await startServer();
    } catch (e) {
      dialog.showErrorBox("laex", `Could not start: ${e.message}\n\nRun "npm install" in ${ROOT} first.`);
      app.quit();
      return;
    }
    createWindow();
  });
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length && base) createWindow(); });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => { app.isQuitting = true; server?.kill("SIGTERM"); });
}
