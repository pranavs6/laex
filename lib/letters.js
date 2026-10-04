// Cover letters for a project, kept as plain text so they can be pasted into
// application forms, and typeset as a PDF on demand with the CV's own name
// and contact line. Stored inside the project at .laex/letters.json,
// git-ignored like the rest of .laex.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const fail = (status, message) => Object.assign(new Error(message), { status });

export function createLetters({ getRoot }) {
  const file = () => path.join(getRoot(), ".laex", "letters.json");

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

  // Creates a letter (no id) or updates one.
  const save = (input) => serial(async () => {
    const all = await list();
    const now = Date.now();
    let l = input.id ? all.find((x) => x.id === input.id) : null;
    if (input.id && !l) throw fail(404, "no such letter");
    if (!l) {
      l = { id: `${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`, created: now, company: "", role: "", application: null, body: "" };
      all.push(l);
    }
    for (const [k, max] of [["company", 200], ["role", 200], ["body", 50_000]]) if (k in input) l[k] = String(input[k] ?? "").slice(0, max);
    if ("application" in input) l.application = input.application ? String(input.application) : null;
    l.updated = now;
    await write(all);
    return l;
  });

  const remove = (id) => serial(async () => write((await list()).filter((x) => x.id !== id)));
  const get = async (id) => (await list()).find((x) => x.id === id) || null;

  return { list, save, remove, get };
}

// --------------------------------------------------------------- the PDF

const ESC = { "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", $: "\\$", "&": "\\&", "#": "\\#", "^": "\\textasciicircum{}", _: "\\_", "~": "\\textasciitilde{}", "%": "\\%" };
const tex = (s) => String(s).replace(/[\\{}$&#^_~%]/g, (c) => ESC[c]);

// Name and contact details from the CV's own source: pdfauthor or \author,
// and its tel:, mailto:, LinkedIn and GitHub links.
export function senderFrom(source) {
  const src = String(source || "");
  const name = (src.match(/pdfauthor\s*=\s*\{([^}]*)\}/) || src.match(/\\author\{([^}]*)\}/) || [])[1]?.replace(/\\[A-Za-z]+/g, "").trim() || "";
  const href = (re) => src.match(new RegExp(`\\\\href\\{(${re}[^}]*)\\}`))?.[1] || "";
  const tel = href("tel:");
  const phone = tel ? (src.match(/\\href\{tel:[^}]*\}\{([^}]*)\}/)?.[1] || tel.slice(4)) : "";
  const email = href("mailto:").slice(7);
  const links = [href("https?://(?:www\\.)?linkedin\\.com"), href("https?://(?:www\\.)?github\\.com")].filter(Boolean);
  return { name, phone, email, links };
}

const longDate = (d = new Date()) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

// Paragraphs are separated by blank lines; a single line break inside one
// (a sign-off, say) is kept.
function body(text) {
  return String(text).trim().split(/\n\s*\n/).map(paragraph).filter(Boolean).join("\n\n");
}

// A paragraph's lines: "- " lines become a bulleted list, the rest are
// joined with line breaks.
function paragraph(p) {
  const out = [];
  let items = [];
  const flushList = () => {
    if (items.length) out.push(`\\begin{itemize}[leftmargin=1.2em, itemsep=0.15em, topsep=0.2em]\n${items.map((i) => `\\item ${i}`).join("\n")}\n\\end{itemize}`);
    items = [];
  };
  let lines = [];
  const flushLines = () => { if (lines.length) out.push(lines.join("\\\\\n")); lines = []; };
  for (const raw of p.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) { flushLines(); items.push(inline(bullet[1])); } else { flushList(); lines.push(inline(line)); }
  }
  flushLines();
  flushList();
  return out.join("\n");
}

// **bold**, *italic* and [text](https://link), everything else escaped.
export function inline(s) {
  return String(s).split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/).map((part) => {
    let m;
    if ((m = part.match(/^\*\*([^*]+)\*\*$/))) return `\\textbf{${tex(m[1])}}`;
    if ((m = part.match(/^\*([^*]+)\*$/))) return `\\textit{${tex(m[1])}}`;
    if ((m = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/))) return `\\href{${m[2].replace(/[%#\\{}]/g, (c) => `\\${c}`)}}{\\color{cvblue}${tex(m[1])}}`;
    return tex(part);
  }).join("");
}

export function letterTex(letter, sender) {
  const contact = [
    sender.phone && `\\href{tel:${sender.phone.replace(/[^\d+]/g, "")}}{${tex(sender.phone)}}`,
    sender.email && `\\href{mailto:${sender.email}}{\\color{cvblue}${tex(sender.email)}}`,
    ...sender.links.map((u) => `\\href{${u}}{\\color{cvblue}${tex(u.replace(/^https?:\/\/(www\.)?/, ""))}}`),
  ].filter(Boolean).join(" \\quad ");
  return `\\documentclass[11pt]{article}
\\usepackage[a4paper,top=0.8in,bottom=0.8in,left=0.95in,right=0.95in]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{textcomp}
\\usepackage{charter}
\\usepackage{xcolor}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\definecolor{cvblue}{HTML}{0E5484}
\\hypersetup{pdftitle={${tex(sender.name || "Cover letter")} - Cover letter${letter.company ? ` - ${tex(letter.company)}` : ""}}, pdfauthor={${tex(sender.name)}}}
\\pdfgentounicode=1
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0.85em}
\\pagestyle{empty}
\\frenchspacing
\\begin{document}
\\begin{center}
${sender.name ? `{\\huge ${tex(sender.name)}}\\\\[5pt]\n` : ""}${contact ? `{\\footnotesize ${contact}}\n` : ""}\\end{center}
\\vspace{0.6em}
${tex(longDate())}

${letter.company ? `\\textbf{${tex(letter.company)}}${letter.role ? `\\\\\nApplication for ${tex(letter.role)}` : ""}\n` : ""}
\\vspace{0.4em}
${body(letter.body)}
\\end{document}
`;
}
