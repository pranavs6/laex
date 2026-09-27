// Saved versions of a project. A version is a copy of every text file plus
// the main document's PDF, taken only when you choose Save version (never on
// an ordinary rebuild). Stored inside the project at .laex/versions/, which
// carries its own .gitignore so it never shows up in the project's git.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const MAX_FILE = 2 * 1024 * 1024;

export function createVersions({ getRoot, listTextFiles, pdfPathFor }) {
  const base = () => path.join(getRoot(), ".laex", "versions");

  async function ensure() {
    const dir = path.join(getRoot(), ".laex");
    await fsp.mkdir(path.join(dir, "versions"), { recursive: true });
    const ignore = path.join(dir, ".gitignore");
    if (!fs.existsSync(ignore)) await fsp.writeFile(ignore, "*\n");
  }

  function dirOf(id) {
    if (!/^[\w-]+$/.test(String(id))) throw Object.assign(new Error("bad version id"), { status: 400 });
    return path.join(base(), id);
  }

  async function list() {
    let ids = [];
    try { ids = await fsp.readdir(base()); } catch { return []; }
    const out = [];
    for (const id of ids) {
      try { out.push(JSON.parse(await fsp.readFile(path.join(base(), id, "meta.json"), "utf8"))); } catch {}
    }
    return out.sort((a, b) => b.at - a.at);
  }

  async function save({ label, main, auto = false }) {
    await ensure();
    const at = Date.now();
    const id = `${at.toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const dir = dirOf(id);
    const files = [];
    let bytes = 0;
    for (const rel of await listTextFiles()) {
      const src = path.join(getRoot(), rel);
      const st = await fsp.stat(src).catch(() => null);
      if (!st || st.size > MAX_FILE) continue;
      const dest = path.join(dir, "files", rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
      files.push(rel);
      bytes += st.size;
    }
    let pdf = false;
    if (main) {
      try { await fsp.copyFile(pdfPathFor(main), path.join(dir, "main.pdf")); pdf = true; } catch {}
    }
    const meta = { id, label: String(label || "").slice(0, 200) || "Untitled version", at, main: main || null, files, pdf, auto, bytes };
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  }

  async function meta(id) {
    return JSON.parse(await fsp.readFile(path.join(dirOf(id), "meta.json"), "utf8"));
  }

  async function fileAt(id, rel) {
    const m = await meta(id);
    if (!m.files.includes(rel)) return null;
    return fsp.readFile(path.join(dirOf(id), "files", rel), "utf8");
  }

  function pdfOf(id) { return path.join(dirOf(id), "main.pdf"); }

  // Restoring first saves the current state, so a restore can be undone.
  async function restore(id, main) {
    const m = await meta(id);
    const backup = await save({ label: `Before restoring "${m.label}"`, main, auto: true });
    for (const rel of m.files) {
      const dest = path.join(getRoot(), rel);
      if (!dest.startsWith(getRoot() + path.sep)) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(dirOf(id), "files", rel), dest);
    }
    return { restored: m, backup };
  }

  async function rename(id, label) {
    const m = await meta(id);
    m.label = String(label || "").slice(0, 200) || m.label;
    await fsp.writeFile(path.join(dirOf(id), "meta.json"), JSON.stringify(m, null, 2));
    return m;
  }

  async function remove(id) {
    await fsp.rm(dirOf(id), { recursive: true, force: true });
  }

  return { list, save, meta, fileAt, pdfOf, restore, rename, remove };
}
