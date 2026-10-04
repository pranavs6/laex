// Job applications for a project: where you applied, with which CV, and how
// each one stands. Kept inside the project at .laex/applications/ as
// applications.json plus any CVs uploaded as PDFs, git-ignored like the rest
// of .laex. A CV is either a saved version (by id) or an uploaded PDF.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const STATUSES = ["applied", "interview", "offer", "rejected", "no-reply"];
const TEXT = { company: 200, role: 200, location: 200, link: 2000, jd: 50000, notes: 20000 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createApplications({ getRoot }) {
  const dir = () => path.join(getRoot(), ".laex", "applications");
  const file = () => path.join(dir(), "applications.json");
  function pdfPath(id) {
    if (!/^[\w-]+$/.test(String(id))) throw fail(400, "bad application id");
    return path.join(dir(), `${id}.pdf`);
  }

  // One change at a time, so quick status edits can't overwrite each other.
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  async function ensure() {
    await fsp.mkdir(dir(), { recursive: true });
    const ignore = path.join(getRoot(), ".laex", ".gitignore");
    if (!fs.existsSync(ignore)) await fsp.writeFile(ignore, "*\n");
  }

  async function list() {
    try { return JSON.parse(await fsp.readFile(file(), "utf8")); } catch { return []; }
  }

  async function write(all) {
    await ensure();
    await fsp.writeFile(file() + ".tmp", JSON.stringify(all, null, 2));
    await fsp.rename(file() + ".tmp", file());
  }

  // Creates an application (no id) or updates one. Unknown fields are ignored;
  // dropPdf removes an uploaded CV, pdfName renames it.
  const save = (input) => serial(async () => {
    const all = await list();
    const now = Date.now();
    let a = input.id ? all.find((x) => x.id === input.id) : null;
    if (input.id && !a) throw fail(404, "no such application");
    if (!a) {
      a = { id: `${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`, created: now, status: "applied", version: null, pdfName: null };
      all.push(a);
    }
    for (const [k, max] of Object.entries(TEXT)) if (k in input) a[k] = String(input[k] ?? "").slice(0, max);
    for (const k of ["applied", "followUp"]) if (k in input) a[k] = DATE.test(input[k]) ? input[k] : "";
    if ("status" in input) a.status = STATUSES.includes(input.status) ? input.status : "applied";
    if ("version" in input) a.version = input.version ? String(input.version) : null;
    // Extra links: candidate portals, recruiter pages. Web addresses only.
    if (Array.isArray(input.links)) {
      a.links = input.links.slice(0, 20)
        .map((l) => ({ label: String(l?.label ?? "").trim().slice(0, 80), url: String(l?.url ?? "").trim().slice(0, 4000) }))
        .filter((l) => /^https?:\/\/\S+$/i.test(l.url));
    }
    // Events: assessments, calls, interviews. Kept in date order.
    if (Array.isArray(input.events)) {
      a.events = input.events.slice(0, 100)
        .map((e) => ({ date: DATE.test(e?.date) ? e.date : "", title: String(e?.title ?? "").trim().slice(0, 120), note: String(e?.note ?? "").slice(0, 2000) }))
        .filter((e) => e.title || e.note.trim())
        .sort((x, y) => x.date.localeCompare(y.date));
    }
    if (input.dropPdf && a.pdfName) { await fsp.rm(pdfPath(a.id), { force: true }); a.pdfName = null; }
    if (input.pdfName && a.pdfName) a.pdfName = String(input.pdfName).slice(0, 200);
    a.updated = now;
    await write(all);
    return a;
  });

  const attachPdf = (id, data, name) => serial(async () => {
    if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw fail(400, "That file is not a PDF");
    const all = await list();
    const a = all.find((x) => x.id === id);
    if (!a) throw fail(404, "no such application");
    await ensure();
    await fsp.writeFile(pdfPath(id), data);
    a.pdfName = String(name || "CV").slice(0, 200);
    a.version = null;
    a.updated = Date.now();
    await write(all);
    return a;
  });

  const remove = (id) => serial(async () => {
    const pdf = pdfPath(id);
    await write((await list()).filter((x) => x.id !== id));
    await fsp.rm(pdf, { force: true });
  });

  return { list, save, attachPdf, pdfPath, remove };
}
