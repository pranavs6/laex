// Notes for a project: interview prep, recruiter calls, ideas. Each one can
// point at an application. Kept inside the project at .laex/notes.json,
// git-ignored like the rest of .laex.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const fail = (status, message) => Object.assign(new Error(message), { status });

export function createNotes({ getRoot }) {
  const file = () => path.join(getRoot(), ".laex", "notes.json");

  // One change at a time, so autosaves can't overwrite each other.
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  async function list() {
    try { return JSON.parse(await fsp.readFile(file(), "utf8")); } catch { return []; }
  }

  async function write(all) {
    const dir = path.dirname(file());
    await fsp.mkdir(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, ".gitignore"))) await fsp.writeFile(path.join(dir, ".gitignore"), "*\n");
    await fsp.writeFile(file() + ".tmp", JSON.stringify(all, null, 2));
    await fsp.rename(file() + ".tmp", file());
  }

  // Creates a note (no id) or updates one.
  const save = (input) => serial(async () => {
    const all = await list();
    const now = Date.now();
    let n = input.id ? all.find((x) => x.id === input.id) : null;
    if (input.id && !n) throw fail(404, "no such note");
    if (!n) {
      n = { id: `${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`, created: now, title: "", body: "", application: null };
      all.push(n);
    }
    if ("title" in input) n.title = String(input.title ?? "").slice(0, 200);
    if ("body" in input) n.body = String(input.body ?? "").slice(0, 200_000);
    if ("application" in input) n.application = input.application ? String(input.application) : null;
    n.updated = now;
    await write(all);
    return n;
  });

  const remove = (id) => serial(async () => write((await list()).filter((x) => x.id !== id)));

  return { list, save, remove };
}
