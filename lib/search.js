// Find and replace across every text file in the project.

import fsp from "node:fs/promises";
import path from "node:path";

const MAX_RESULTS = 2000;

function pattern({ q, regex, caseSensitive, wholeWord }) {
  if (!q) return null;
  let src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wholeWord) src = `\\b${src}\\b`;
  try {
    return new RegExp(src, caseSensitive ? "g" : "gi");
  } catch (e) {
    throw Object.assign(new Error(`Invalid pattern: ${e.message}`), { status: 400 });
  }
}

export async function search(root, files, opts) {
  const re = pattern(opts);
  if (!re) return { results: [], total: 0 };
  const results = [];
  let total = 0;
  for (const rel of files) {
    const text = await fsp.readFile(path.join(root, rel), "utf8").catch(() => null);
    if (text === null) continue;
    const matches = [];
    text.split("\n").forEach((line, i) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) && total < MAX_RESULTS) {
        if (m[0] === "") { re.lastIndex++; continue; }
        matches.push({ line: i + 1, col: m.index + 1, len: m[0].length, text: line.slice(0, 400) });
        total++;
      }
    });
    if (matches.length) results.push({ file: rel, matches });
  }
  return { results, total, truncated: total >= MAX_RESULTS };
}

// Returns the new contents; the caller writes them so the file watcher tells
// any open editor about the change.
export async function replace(root, files, opts) {
  const re = pattern(opts);
  if (!re) return { changed: [], count: 0 };
  const changed = [];
  let count = 0;
  for (const rel of files) {
    const abs = path.join(root, rel);
    const text = await fsp.readFile(abs, "utf8").catch(() => null);
    if (text === null) continue;
    let n = 0;
    const next = text.replace(re, (...args) => {
      n++;
      if (!opts.regex) return opts.replacement;
      // Honour $1-style groups in regex mode.
      const groups = args.slice(1, -2);
      return opts.replacement.replace(/\$(\d)/g, (_, d) => groups[Number(d) - 1] ?? "");
    });
    if (n) {
      await fsp.writeFile(abs, next, "utf8");
      changed.push({ file: rel, count: n, text: next });
      count += n;
    }
  }
  return { changed, count };
}
