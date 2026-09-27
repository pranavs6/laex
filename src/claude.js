// "Ask Claude" menu on the Source card. Prompts refer to "the selected text"
// or "the line at my cursor"; the context hook tells Claude what those are.

const ACTIONS = [
  { id: "improve", label: "Improve this bullet", needs: "text",
    prompt: "Improve the {target}: stronger verb, specific technical detail, one clear measurable result. Keep every fact as it is; if a number is missing, add a % TODO(metric) comment instead of inventing one. Show before and after, then make the edit." },
  { id: "shorten", label: "Make it shorter", needs: "text",
    prompt: "Shorten the {target} to at most one line in the PDF without losing its result or key technology. Make the edit." },
  { id: "metric", label: "Suggest a metric", needs: "text",
    prompt: "The {target} has no measurable result. Ask me one short question to get a real number for it. Don't invent one." },
  { id: "british", label: "British spelling and tone", needs: null,
    prompt: "Check {scope} for American spellings, inconsistent tense, and clichés. List what you'd change, then make the edits." },
  { id: "errors", label: "Fix the build errors", needs: null,
    prompt: "Fix the LaTeX errors from the last build of the main document. Make the smallest changes that fix them." },
  { id: "onepage", label: "Fit it on one page", needs: null,
    prompt: "The main document should fit on one page. Tighten the wording of the weakest bullets until it does, without shrinking fonts or margins. Tell me what you cut." },
  { id: "review", label: "Review the whole CV", needs: null,
    prompt: "Review the main document as a hiring manager at a top UK tech company would. Give a prioritised list: what gets it rejected in 10 seconds, weak bullets with rewrites, inconsistencies. Don't edit yet." },
];

export function initClaude(app) {
  const { $, el, api } = app;
  const btn = $("ask-claude");
  const menu = $("claude-menu");

  function target() {
    const c = app.editor.path ? app.editor.cursorInfo() : null;
    if (c?.selection) return { target: `selected text (lines ${c.selFrom}-${c.selTo} of ${app.editor.path})`, scope: `the selected text in ${app.editor.path}` };
    if (c) return { target: `line at my cursor (line ${c.line} of ${app.editor.path}) and the bullet it belongs to`, scope: app.settings.main || app.editor.path };
    return { target: "main document", scope: app.settings.main || "the main document" };
  }

  async function send(prompt) {
    close();
    try {
      const r = await api.post("/api/claude/ask", { prompt });
      app.setStatus("Sent", "blue", r.sent === "claude" ? "Sent to Claude in the terminal." : "Started Claude in the terminal with your request.");
      app.focusTerminal();
    } catch (e) {
      app.setStatus("Terminal busy", "yellow", e.message);
    }
  }

  function render() {
    menu.replaceChildren();
    const t = target();
    for (const a of ACTIONS) {
      const b = el("button", { type: "button", className: "lx-menu-item", role: "menuitem", textContent: a.label });
      b.addEventListener("click", () => send(a.prompt.replace("{target}", t.target).replace("{scope}", t.scope)));
      menu.append(b);
    }
    if (app.hasJob()) {
      const b = el("button", { type: "button", className: "lx-menu-item", role: "menuitem", textContent: "Tailor to the job description" });
      b.addEventListener("click", () => send(`Tailor ${app.settings.main} to the job description in .laex/job.md. Reorder and reword existing bullets so the best matching evidence comes first. Don't claim anything I haven't done. Keep it to one page.`));
      menu.append(b);
    }
    const form = el("form", { className: "lx-menu-custom" });
    const input = el("input", { className: "lx-input", placeholder: "Ask something else", "aria-label": "Ask Claude something else" });
    form.append(input, el("button", { type: "submit", className: "lx-button", textContent: "Send" }));
    form.addEventListener("submit", (e) => { e.preventDefault(); if (input.value.trim()) send(input.value.trim()); });
    menu.append(form);
  }

  function open() {
    render();
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    menu.querySelector("button")?.focus();
  }
  function close() {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  }
  btn.addEventListener("click", () => (menu.hidden ? open() : close()));
  document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close(); });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); btn.focus(); }
    const items = [...menu.querySelectorAll(".lx-menu-item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" && i >= 0) { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === "ArrowUp" && i >= 0) { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });

  return { open, send };
}
