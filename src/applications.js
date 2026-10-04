// Application tracker: where you applied, with which CV, and how each one
// stands. The CV is a saved version or a PDF uploaded here.

const STATUS = {
  applied: { label: "Applied", tag: "blue" },
  interview: { label: "Interview", tag: "yellow" },
  offer: { label: "Offer", tag: "green" },
  rejected: { label: "Rejected", tag: "red" },
  "no-reply": { label: "No reply", tag: "grey" },
};

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
const EVENT_KINDS = ["Online assessment", "Recruiter call", "Phone screen", "Technical interview", "Final round", "Offer", "Rejection"];
const longDate = (d) => new Date(`${d}T00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export function initApplications(app) {
  const { $, el, api } = app;
  const root = $("applications");
  let list = [];
  let versions = [];

  // Still waiting to hear, and the follow-up date has come.
  const due = (a) => a.followUp && a.followUp <= today() && (a.status === "applied" || a.status === "interview");

  async function refresh() {
    [list, versions] = await Promise.all([
      api.json("/api/applications").catch(() => []),
      api.json("/api/versions").catch(() => []),
    ]);
    app.onApplicationCount?.(list.length, list.filter(due).length);
    if (root.dataset.view !== "form") renderList();
  }

  function cvOf(a) {
    if (a.pdfName) {
      return { label: `${a.pdfName} (uploaded)`, name: a.pdfName,
        url: `/api/applications/pdf?id=${encodeURIComponent(a.id)}&download=1&name=${encodeURIComponent(a.pdfName)}` };
    }
    const v = a.version && versions.find((x) => x.id === a.version);
    if (v) {
      return { label: v.label, name: v.label,
        url: v.pdf ? `/api/versions/pdf?id=${encodeURIComponent(v.id)}&download=1&name=${encodeURIComponent(v.label)}` : null };
    }
    return a.version ? { label: "a version that has since been deleted", url: null } : null;
  }

  // ----------------------------------------------------------------- list
  function renderList(notice) {
    root.dataset.view = "list";
    const body = el("div", { className: "lx-panel" });
    if (notice) body.append(el("div", { className: "lx-notice", role: "status" }, el("h3", { className: "lx-notice__title", textContent: notice })));
    body.append(
      el("h2", { className: "lx-panel__title", textContent: "Applications" }),
      el("p", { className: "lx-hint", textContent: "Where you have applied, the CV you sent, and how each one stands." }));
    const add = el("button", { type: "button", className: "lx-button", textContent: "Log application" });
    add.addEventListener("click", () => renderForm());
    body.append(el("div", { className: "lx-panel__actions" }, add));

    if (!list.length) {
      body.append(el("p", { className: "lx-empty", textContent: "No applications yet." }));
      root.replaceChildren(body);
      return;
    }
    const counts = el("p", { className: "lx-app-counts" });
    for (const [s, st] of Object.entries(STATUS)) {
      const n = list.filter((a) => a.status === s).length;
      if (n) counts.append(el("strong", { className: `lx-tag lx-tag--small lx-tag--${st.tag}`, textContent: `${n} ${st.label.toLowerCase()}` }));
    }
    const dueCount = list.filter(due).length;
    if (dueCount) counts.append(el("strong", { className: "lx-tag lx-tag--small lx-tag--red", textContent: `${dueCount} to follow up` }));
    body.append(counts);

    const sorted = [...list].sort((a, b) => (b.applied || "").localeCompare(a.applied || "") || b.created - a.created);
    const dl = el("dl", { className: "lx-summary" });
    for (const a of sorted) dl.append(row(a));
    body.append(dl);
    root.replaceChildren(body);
  }

  function row(a) {
    const cv = cvOf(a);
    const meta = [a.location, a.applied && `Applied ${longDate(a.applied)}`, cv && `CV: ${cv.label}`].filter(Boolean).join(" · ");
    const follow = a.followUp && (a.status === "applied" || a.status === "interview") ? `Follow up ${longDate(a.followUp)}` : "";

    const status = el("select", { className: `lx-select lx-select--bar lx-app-status lx-app-status--${a.status}` });
    status.setAttribute("aria-label", `Status of ${a.company}`);
    for (const [s, st] of Object.entries(STATUS)) status.append(new Option(st.label, s));
    status.value = a.status;
    status.addEventListener("change", async () => {
      await api.post("/api/applications", { id: a.id, status: status.value });
      refresh();
    });

    const actions = el("ul", { className: "lx-summary__actions" });
    const hidden = () => el("span", { className: "lx-visually-hidden", textContent: ` for ${a.company}` });
    const act = (text, fn) => {
      const b = el("button", { type: "button", className: "lx-link", textContent: text }, hidden());
      b.addEventListener("click", fn);
      actions.append(el("li", {}, b));
    };
    const link = (text, props) => actions.append(el("li", {}, el("a", { className: "lx-link", textContent: text, ...props }, hidden())));
    act("Edit", () => renderForm(a));
    if (cv?.url) link("Download CV", { href: cv.url, download: `${cv.name}.pdf` });
    if (/^https?:\/\//i.test(a.link || "")) link("Open posting", { href: a.link, target: "_blank", rel: "noopener noreferrer" });
    act("Delete", () => confirmDelete(a, item));

    const item = el("div", { className: "lx-summary__row" },
      el("dt", { className: "lx-summary__key" },
        el("span", { className: "lx-summary__label", textContent: [a.company, a.role].filter(Boolean).join(" — ") }),
        due(a) ? el("strong", { className: "lx-tag lx-tag--small lx-tag--red", textContent: "Follow up" }) : null,
        el("span", { className: "lx-summary__meta", textContent: meta }),
        follow ? el("span", { className: "lx-summary__meta", textContent: follow }) : null,
        a.notes ? el("span", { className: "lx-summary__meta lx-app-note", textContent: a.notes.split("\n")[0] }) : null,
        timeline(a)),
      el("dd", { className: "lx-summary__value lx-summary__value--app" }, status, el("div", { className: "lx-summary__clip" }, actions)));
    return item;
  }

  // Applied, then each event in date order. Events still to come say so.
  function timeline(a) {
    const events = a.events || [];
    if (!events.length) return null;
    const ol = el("ol", { className: "lx-app-events" });
    for (const e of events) {
      const later = e.date && e.date > today();
      ol.append(el("li", { className: later ? "is-upcoming" : "" },
        el("span", { className: "lx-app-events__date", textContent: e.date ? longDate(e.date) : "No date" }),
        el("span", { className: "lx-app-events__title", textContent: e.title || "Event" }),
        later ? el("strong", { className: "lx-tag lx-tag--small lx-tag--blue", textContent: "Upcoming" }) : null,
        e.note ? el("span", { className: "lx-app-events__note", textContent: e.note }) : null));
    }
    return ol;
  }

  function confirmDelete(a, item) {
    const yes = el("button", { type: "button", className: "lx-button lx-button--warning", textContent: "Delete application" });
    const no = el("button", { type: "button", className: "lx-link", textContent: "Cancel" });
    const box = el("div", { className: "lx-confirm" },
      el("p", { textContent: `Delete the application to ${a.company}? This cannot be undone.` }),
      a.pdfName ? el("p", { className: "lx-hint", textContent: `Its uploaded CV, ${a.pdfName}, is deleted too.` }) : null,
      el("div", { className: "lx-confirm__actions" }, yes, no));
    item.after(box);
    no.focus();
    no.addEventListener("click", () => box.remove());
    yes.addEventListener("click", async () => {
      await api.post("/api/applications/delete", { id: a.id });
      refresh();
    });
  }

  // ----------------------------------------------------------------- form
  function renderForm(a = null) {
    root.dataset.view = "form";
    const editing = !!a;
    a ||= { company: "", role: "", location: "", applied: today(), status: "applied", version: null, pdfName: null, link: "", jd: "", followUp: "", notes: "" };
    const manual = versions.filter((v) => !v.auto);

    const back = el("button", { type: "button", className: "lx-back", textContent: "Back to applications" });
    back.addEventListener("click", () => renderList());
    const form = el("form", { className: "lx-panel lx-app-form", noValidate: true });
    const errors = el("div", { className: "lx-errors lx-errors--form", role: "alert", hidden: true });
    form.append(back, el("h2", { className: "lx-panel__title", textContent: editing ? `Edit ${a.company}` : "Log an application" }), errors);

    const group = (id, label, control, hint) => el("div", { className: "lx-form-group" },
      el("label", { className: "lx-label", htmlFor: id, textContent: label }),
      hint ? el("span", { className: "lx-hint", textContent: hint }) : null, control);
    // type goes first, so a date value isn't set on a text input.
    const input = (id, value, props = {}) => el("input", { ...props, className: "lx-input lx-input--full", id, autocomplete: "off", value: value || "" });

    const company = input("app-company", a.company);
    const role = input("app-role", a.role);
    const location = input("app-location", a.location, { placeholder: "For example, London or Remote" });
    const applied = input("app-applied", a.applied, { type: "date" });
    const status = el("select", { className: "lx-select", id: "app-status" });
    for (const [s, st] of Object.entries(STATUS)) status.append(new Option(st.label, s));
    status.value = a.status;
    form.append(
      group("app-company", "Company", company),
      group("app-role", "Role", role),
      group("app-location", "Location", location),
      el("div", { className: "lx-form-group--row lx-app-row" }, group("app-applied", "Date applied", applied), group("app-status", "Status", status)));

    // The CV: a saved version, an uploaded PDF, or none.
    let mode = a.pdfName ? "upload" : a.version ? "version" : editing ? "none" : manual.length ? "version" : "upload";
    const seg = el("div", { className: "lx-segments", role: "tablist", "aria-label": "CV sent" });
    const panes = {};
    const segBtn = (key, text) => {
      const b = el("button", { type: "button", role: "tab", className: "lx-segments__item", textContent: text });
      b.dataset.mode = key;
      b.addEventListener("click", () => setMode(key));
      seg.append(b);
    };
    segBtn("version", "Saved version");
    segBtn("upload", "Upload a PDF");
    segBtn("none", "None");

    const versionSel = el("select", { className: "lx-select lx-input--full", id: "app-version" });
    for (const v of versions) {
      const when = new Date(v.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      versionSel.append(new Option(`${v.label}${v.auto ? " (automatic)" : ""} · ${when}`, v.id));
    }
    versionSel.value = a.version && versions.some((v) => v.id === a.version) ? a.version : manual[0]?.id || versions[0]?.id || "";
    panes.version = versions.length
      ? group("app-version", "Version", versionSel, "The PDF saved with the version is the one you can download here.")
      : el("p", { className: "lx-hint", textContent: "No saved versions yet. Use Save version first, or upload a PDF." });

    const fileIn = el("input", { type: "file", id: "app-file", accept: "application/pdf,.pdf", className: "lx-file" });
    const pdfName = input("app-pdfname", a.pdfName || "", { placeholder: "For example, PranavSathyaAR_Citadel" });
    fileIn.addEventListener("change", () => {
      const f = fileIn.files[0];
      if (f && !pdfName.value.trim()) pdfName.value = f.name.replace(/\.pdf$/i, "");
    });
    panes.upload = el("div", {},
      group("app-file", a.pdfName ? "Replace the PDF" : "PDF", fileIn, a.pdfName ? `Current file: ${a.pdfName}.pdf. Leave empty to keep it.` : "A CV you made outside laex."),
      group("app-pdfname", "Name", pdfName, "Used as the file name when you download it."));
    panes.none = el("p", { className: "lx-hint", textContent: "No CV is kept with this application." });

    const paneHolder = el("div", { className: "lx-app-cv" });
    function setMode(m) {
      mode = m;
      for (const b of seg.children) b.setAttribute("aria-selected", String(b.dataset.mode === m));
      paneHolder.replaceChildren(panes[m]);
    }
    form.append(el("div", { className: "lx-form-group" }, el("span", { className: "lx-label", textContent: "CV sent" }), seg, paneHolder));
    setMode(mode);

    // Events: one row each, added and removed in place.
    const kinds = el("datalist", { id: "app-event-kinds" }, ...EVENT_KINDS.map((k) => el("option", { value: k })));
    const rows = el("ol", { className: "lx-app-event-rows" });
    const eventRow = (e = {}) => {
      const date = el("input", { type: "date", className: "lx-input", value: e.date || "" });
      const title = el("input", { className: "lx-input", value: e.title || "", placeholder: "What happened", autocomplete: "off" });
      title.setAttribute("list", "app-event-kinds");
      const note = el("input", { className: "lx-input", value: e.note || "", placeholder: "Note (optional)", autocomplete: "off" });
      date.setAttribute("aria-label", "Event date");
      title.setAttribute("aria-label", "Event");
      note.setAttribute("aria-label", "Event note");
      const remove = el("button", { type: "button", className: "lx-link", textContent: "Remove" });
      const li = el("li", { className: "lx-app-event-row" }, date, title, note, remove);
      li.read = () => ({ date: date.value, title: title.value.trim(), note: note.value.trim() });
      remove.addEventListener("click", () => li.remove());
      rows.append(li);
      return title;
    };
    for (const e of a.events || []) eventRow(e);
    const addEvent = el("button", { type: "button", className: "lx-button lx-button--secondary lx-button--small", textContent: "Add event" });
    addEvent.addEventListener("click", () => eventRow({ date: today() }).focus());
    form.append(el("div", { className: "lx-form-group" },
      el("span", { className: "lx-label", textContent: "Events" }),
      el("span", { className: "lx-hint", textContent: "Assessments, calls and interviews. Future ones show as upcoming." }),
      kinds, rows, addEvent));

    const link = input("app-link", a.link, { type: "url", placeholder: "https://" });
    const jd = el("textarea", { className: "lx-textarea", id: "app-jd", rows: 6, value: a.jd || "", spellcheck: false });
    const fromJob = el("button", { type: "button", className: "lx-link", textContent: "Copy from Job match" });
    fromJob.addEventListener("click", async () => {
      const text = await api.text("/api/job").catch(() => "");
      if (text.trim()) jd.value = text;
      else fromJob.textContent = "Job match is empty";
    });
    const followUp = input("app-follow", a.followUp, { type: "date" });
    const notes = el("textarea", { className: "lx-textarea lx-textarea--short", id: "app-notes", rows: 4, value: a.notes || "" });
    form.append(
      group("app-link", "Job posting link", link),
      group("app-jd", "Job description", el("div", {}, jd, el("p", { className: "lx-actions lx-actions--below" }, fromJob))),
      group("app-follow", "Follow-up date", followUp, "When to chase if you have not heard back. It is flagged in the list from that day."),
      group("app-notes", "Notes and contacts", notes, "Recruiter, referral, interview notes."));

    const save = el("button", { type: "submit", className: "lx-button", textContent: editing ? "Save changes" : "Save application" });
    const cancel = el("button", { type: "button", className: "lx-link", textContent: "Cancel" });
    cancel.addEventListener("click", () => renderList());
    form.append(el("div", { className: "lx-modal__actions" }, save, cancel));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = fileIn.files[0];
      const problems = [];
      if (!company.value.trim()) problems.push([company, "Enter the company name"]);
      if (mode === "upload" && !file && !a.pdfName) problems.push([fileIn, "Choose a PDF, or pick Saved version or None"]);
      if (mode === "upload" && file && !/\.pdf$/i.test(file.name) && file.type !== "application/pdf") problems.push([fileIn, "The CV must be a PDF"]);
      if (mode === "version" && !versionSel.value) problems.push([seg, "Pick a saved version, or upload a PDF"]);
      if (showErrors(errors, problems)) return;

      save.setAttribute("aria-disabled", "true");
      try {
        const body = {
          id: a.id, company: company.value.trim(), role: role.value.trim(), location: location.value.trim(), applied: applied.value, status: status.value,
          link: link.value.trim(), jd: jd.value, followUp: followUp.value, notes: notes.value,
          events: [...rows.children].map((li) => li.read()),
          version: mode === "version" ? versionSel.value : null,
          dropPdf: mode !== "upload", pdfName: pdfName.value.trim(),
        };
        const saved = await api.post("/api/applications", body);
        if (mode === "upload" && file) {
          const name = pdfName.value.trim() || file.name.replace(/\.pdf$/i, "");
          await api.json(`/api/applications/pdf?id=${encodeURIComponent(saved.id)}&name=${encodeURIComponent(name)}`, { method: "PUT", body: file });
        }
        root.dataset.view = "list";
        await refresh();
        renderList(editing ? `Saved changes to ${body.company}.` : `Logged your application to ${body.company}.`);
      } catch (err) {
        showErrors(errors, [[save, err.message]]);
      } finally {
        save.removeAttribute("aria-disabled");
      }
    });

    root.replaceChildren(form);
    root.scrollTop = 0;
    company.focus();
  }

  // GOV.UK error summary: each problem links to its field.
  function showErrors(box, problems) {
    box.hidden = !problems.length;
    if (!problems.length) return false;
    const list = el("ul", { className: "lx-errors__list" });
    for (const [field, message] of problems) {
      const b = el("button", { type: "button", textContent: message });
      b.addEventListener("click", () => (field.focus ? field.focus() : field.querySelector("button")?.focus()));
      list.append(el("li", {}, b));
    }
    box.replaceChildren(el("h2", { className: "lx-errors__title", textContent: "There is a problem" }), list);
    root.scrollTop = 0;
    box.tabIndex = -1;
    box.focus({ preventScroll: true });
    return true;
  }

  return { refresh };
}
