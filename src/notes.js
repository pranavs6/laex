// Notes: a list of titled notes beside an editor that saves as you type.
// A note can point at an application. On a phone the list and the editor
// take turns.

const when = (at) => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })
  .replace(" am", "am").replace(" pm", "pm");

export function initNotes(app) {
  const { $, el, api } = app;
  const root = $("notes");
  let list = [];
  let apps = [];
  let current = null; // id of the open note
  let saveTimer = null;
  let pending = null; // fields waiting to be saved

  const appName = (id) => {
    const a = apps.find((x) => x.id === id);
    return a ? [a.company, a.role].filter(Boolean).join(" — ") : "";
  };

  async function refresh() {
    await flush();
    [list, apps] = await Promise.all([
      api.json("/api/notes").catch(() => []),
      api.json("/api/applications").catch(() => []),
    ]);
    if (current && !list.some((n) => n.id === current)) current = null;
    render();
  }

  function render() {
    const listEl = el("div", { className: "lx-notes__list" });
    const editorEl = el("div", { className: "lx-notes__editor" });
    root.replaceChildren(el("div", { className: `lx-notes${current ? " is-editing" : ""}` }, listEl, editorEl));
    renderList(listEl);
    renderEditor(editorEl);
  }

  function renderList(box = root.querySelector(".lx-notes__list")) {
    const add = el("button", { type: "button", className: "lx-button", textContent: "New note" });
    add.addEventListener("click", () => create());
    const items = el("ul", { className: "lx-notes__items" });
    for (const n of [...list].sort((a, b) => b.updated - a.updated)) {
      const b = el("button", { type: "button", className: "lx-notes__item" },
        el("span", { className: "lx-notes__title", textContent: n.title.trim() || "Untitled note" }),
        el("span", { className: "lx-notes__meta", textContent: [when(n.updated), appName(n.application)].filter(Boolean).join(" · ") }));
      if (n.id === current) b.setAttribute("aria-current", "true");
      b.addEventListener("click", () => open(n.id));
      items.append(el("li", {}, b));
    }
    box.replaceChildren(
      el("h1", { className: "lx-page__title", textContent: "Notes" }),
      el("div", { className: "lx-panel__actions" }, add),
      list.length ? items : el("p", { className: "lx-hint", textContent: "No notes yet. Use them for interview prep, recruiter calls and ideas." }));
  }

  function renderEditor(box) {
    const n = list.find((x) => x.id === current);
    if (!n) {
      box.replaceChildren(el("p", { className: "lx-empty", textContent: list.length ? "Select a note, or start a new one." : "" }));
      return;
    }
    const back = el("button", { type: "button", className: "lx-back lx-notes__back", textContent: "All notes" });
    back.addEventListener("click", async () => { await flush(); current = null; render(); });

    const title = el("input", { className: "lx-input lx-input--full lx-notes__title-input", id: "note-title", value: n.title, placeholder: "Title", autocomplete: "off" });
    title.setAttribute("aria-label", "Title");
    const link = el("select", { className: "lx-select", id: "note-app" });
    link.append(new Option("Not linked to an application", ""));
    for (const a of apps) link.append(new Option([a.company, a.role].filter(Boolean).join(" — "), a.id));
    link.value = n.application && apps.some((a) => a.id === n.application) ? n.application : "";
    const body = el("textarea", { className: "lx-textarea lx-notes__body", id: "note-body", value: n.body, placeholder: "Write anything…" });
    body.setAttribute("aria-label", "Note");
    const status = el("span", { className: "lx-hint lx-notes__status", role: "status", textContent: `Saved ${when(n.updated)}` });

    const changed = (fields) => {
      Object.assign(n, fields);
      pending = { ...pending, ...fields, id: n.id };
      status.textContent = "Saving…";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => flush().then(() => { status.textContent = `Saved ${when(n.updated)}`; }), 600);
    };
    title.addEventListener("input", () => changed({ title: title.value }));
    body.addEventListener("input", () => changed({ body: body.value }));
    link.addEventListener("change", () => { changed({ application: link.value || null }); renderList(); });

    const del = el("button", { type: "button", className: "lx-link", textContent: "Delete note" });
    del.addEventListener("click", () => {
      const yes = el("button", { type: "button", className: "lx-button lx-button--warning", textContent: "Delete note" });
      const no = el("button", { type: "button", className: "lx-link", textContent: "Cancel" });
      const box2 = el("div", { className: "lx-confirm" },
        el("p", { textContent: `Delete "${n.title.trim() || "Untitled note"}"? This cannot be undone.` }),
        el("div", { className: "lx-confirm__actions" }, yes, no));
      del.parentElement.after(box2);
      no.focus();
      no.addEventListener("click", () => box2.remove());
      yes.addEventListener("click", async () => {
        clearTimeout(saveTimer);
        pending = null;
        await api.post("/api/notes/delete", { id: n.id });
        current = null;
        refresh();
      });
    });

    box.replaceChildren(back, title,
      el("div", { className: "lx-notes__bar" }, link, status),
      body,
      el("p", { className: "lx-actions lx-actions--below" }, del));
  }

  // Writes whatever is waiting, and folds the saved note back into the list.
  async function flush() {
    clearTimeout(saveTimer);
    if (!pending) return;
    const fields = pending;
    pending = null;
    const saved = await api.post("/api/notes", fields).catch(() => null);
    if (!saved) return;
    const i = list.findIndex((x) => x.id === saved.id);
    if (i >= 0) list[i] = saved;
    if (root.querySelector(".lx-notes__list")) renderList();
  }

  async function open(id) {
    await flush();
    current = id;
    render();
    root.querySelector("#note-body")?.focus();
  }

  async function create(fields = {}) {
    await flush();
    const n = await api.post("/api/notes", { title: "", body: "", ...fields });
    list.push(n);
    current = n.id;
    render();
    root.querySelector("#note-title")?.focus();
  }

  return { refresh, flush };
}
