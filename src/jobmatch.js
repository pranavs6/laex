// Job match: which of a job description's skills and keywords appear in the
// CV (as an applicant tracking system reads it), weighted by how often the
// job description mentions them. A skill can be met directly (the CV says
// "NoSQL") or by evidence (the CV lists MongoDB and Redis).

// label: shown to the user. aliases: other ways the same skill is written.
// evidence: tools or practices in a CV that demonstrate it.
const SKILLS = [
  // Architecture and systems
  { label: "distributed systems", aliases: ["distributed system", "distributed computing"], evidence: ["microservices", "distributed"] },
  { label: "microservices", aliases: ["microservice", "service-oriented", "soa"] },
  { label: "system design", aliases: ["systems design", "architecture design"] },
  { label: "cloud-native", aliases: ["cloud native"], evidence: ["kubernetes", "k8s", "docker", "eks", "ecs", "serverless", "lambda", "containers"] },
  { label: "cloud platforms", aliases: ["cloud platform", "cloud computing", "cloud services", "public cloud"], evidence: ["aws", "gcp", "azure", "google cloud"] },
  { label: "scalability", aliases: ["scalable", "at scale", "scaling", "high-scale"] },
  { label: "fault tolerance", aliases: ["fault-tolerant", "fault tolerant", "resilient", "resilience", "high availability", "highly available"], evidence: ["uptime", "failover", "redundancy", "rollback"] },
  { label: "event-driven", aliases: ["event driven", "message queues", "message queue", "pub/sub", "streaming"], evidence: ["kafka", "rabbitmq", "kinesis", "pub/sub", "nats", "sqs"] },
  { label: "real-time", aliases: ["real time", "realtime", "low latency", "low-latency"] },
  { label: "api design", aliases: ["rest apis", "restful apis", "rest api", "restful", "api development", "apis"], evidence: ["rest", "graphql", "grpc", "api"] },
  { label: "data pipelines", aliases: ["data pipeline", "etl", "elt", "data engineering"], evidence: ["kafka", "airflow", "spark", "flink", "pipeline", "pipelines"] },
  { label: "performance optimisation", aliases: ["performance optimization", "performance tuning", "optimising performance", "optimizing performance"], evidence: ["latency", "p95", "p99"] },
  { label: "infrastructure as code", aliases: ["iac"], evidence: ["terraform", "pulumi", "cloudformation", "ansible", "cdk"] },
  { label: "containers", aliases: ["containerisation", "containerization", "containerised", "containerized"], evidence: ["docker", "kubernetes", "podman"] },
  { label: "security", aliases: ["secure coding", "application security", "authentication", "authorisation", "authorization"], evidence: ["oauth", "jwt", "tls", "iam"] },
  // Practices
  { label: "ci/cd", aliases: ["continuous integration", "continuous delivery", "continuous deployment", "ci cd"], evidence: ["jenkins", "github actions", "gitlab ci", "circleci", "argo", "canary", "release pipeline"] },
  { label: "code reviews", aliases: ["code review", "reviewing code"], evidence: ["pull request", "pull requests"] },
  { label: "testing", aliases: ["unit testing", "unit tests", "integration testing", "integration tests", "test-driven", "tdd", "automated testing"], evidence: ["test suite", "jest", "pytest", "junit"] },
  { label: "technical documentation", aliases: ["documentation", "design docs", "design documents"], evidence: ["rfc", "runbook", "runbooks"] },
  { label: "agile", aliases: ["scrum", "kanban", "sprints"], evidence: ["sprint", "jira"] },
  { label: "on-call", aliases: ["on call", "oncall", "operational responsibilities"], evidence: ["incident", "incidents", "sre", "pagerduty", "opsgenie"] },
  { label: "monitoring", aliases: ["observability", "alerting", "operational excellence"], evidence: ["grafana", "prometheus", "datadog", "kibana", "opentelemetry", "cloudwatch", "uptime"] },
  { label: "troubleshooting", aliases: ["debugging", "debug", "production issues", "root cause"], evidence: ["incident", "incidents", "resolved", "resolution"] },
  { label: "sdlc", aliases: ["software development lifecycle", "software development life cycle"] },
  { label: "version control", aliases: ["source control"], evidence: ["git", "github", "gitlab", "bitbucket"] },
  { label: "open source", aliases: ["open-source"], evidence: ["hacktoberfest"] },
  { label: "design patterns", aliases: ["design pattern"] },
  { label: "object-oriented design", aliases: ["object-oriented", "object oriented", "oop", "ood"] },
  { label: "data structures", aliases: ["data structure"], evidence: ["leetcode", "codechef", "codeforces", "competitive programming"] },
  { label: "algorithms", aliases: ["algorithm", "algorithmic"], evidence: ["leetcode", "codechef", "codeforces", "competitive programming"] },
  // Data
  { label: "sql", aliases: ["relational databases", "relational database"], evidence: ["postgresql", "postgres", "mysql", "sqlite", "mariadb", "sql server", "rds", "oracle"] },
  { label: "nosql", aliases: ["no-sql", "non-relational"], evidence: ["mongodb", "redis", "cassandra", "dynamodb", "couchdb", "elasticsearch", "firestore"] },
  { label: "databases", aliases: ["database", "database systems", "data stores", "datastores"], evidence: ["postgresql", "mysql", "mongodb", "redis", "clickhouse", "dynamodb", "cassandra"] },
  { label: "machine learning", aliases: ["ml"], evidence: ["pytorch", "tensorflow", "scikit-learn", "sklearn"] },
  // AI
  { label: "GenAI", aliases: ["generative ai", "gen ai", "genai", "llm", "llms", "large language models", "large language model"], evidence: ["openai", "claude", "dialogflow", "gpt", "rag", "langchain", "vector database", "qdrant"] },
  { label: "AI tools", aliases: ["ai tools", "ai-powered tools", "ai coding", "ai-assisted", "copilot"], evidence: ["claude", "copilot", "cursor", "chatgpt"] },
  // Background
  { label: "internship", aliases: ["internships", "intern"] },
  { label: "computer science", aliases: ["computer engineering", "cs degree"] },
  { label: "bachelor's degree", aliases: ["bachelor's", "bachelors", "bachelor", "undergraduate degree"], evidence: ["bachelor of engineering", "b.e.", "b.tech", "bsc", "b.sc"] },
  // Domains
  { label: "payments", aliases: ["payment"] }, { label: "fintech", aliases: [] }, { label: "e-commerce", aliases: ["ecommerce"] },
  { label: "mobility", aliases: ["transport", "transportation", "transit"] }, { label: "linux", aliases: ["unix"] },
  { label: "mentoring", aliases: ["mentorship", "mentor"] },
];

// Languages, which need exact case (Go, C) or symbols (C++, C#).
const LANGUAGES = ["Java", "Python", "C++", "C#", "Go", "Rust", "TypeScript", "JavaScript", "Kotlin", "Scala", "Swift", "Ruby", "PHP", "Haskell", "Elixir", "Erlang", "Clojure", "OCaml", "Perl", "Lua", "Dart", "R", "C"];
const LANG_ALIASES = { Go: ["golang"], JavaScript: ["js"], TypeScript: ["ts"] };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (t) => t.replace(/-\n(?=\p{Ll})/gu, "").replace(/\s+/g, " ");

// Whole-word matches. Letters, digits, + and # join a word; slashes, hyphens
// and dots don't, so "TypeScript/JavaScript" and "AWS." both count.
function count(text, phrase, { caseSensitive = false } = {}) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}+#])${esc(phrase)}(?![\\p{L}\\p{N}+#])`, caseSensitive ? "gu" : "giu");
  return (text.match(re) || []).length;
}

// Several ways of writing one thing, counted once per place in the text
// (longest first, so "Bachelor's degree" isn't also counted as "Bachelor's").
function countAny(text, terms, opts) {
  const alts = [...new Set(terms)].sort((a, b) => b.length - a.length).map(esc).join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}+#])(?:${alts})(?![\\p{L}\\p{N}+#])`, opts?.caseSensitive ? "gu" : "giu");
  return (text.match(re) || []).length;
}

export function extractKeywords(jd, techWords = []) {
  const text = norm(jd);
  const out = new Map();
  const add = (key, entry) => { if (!out.has(key) && entry.weight) out.set(key, entry); };

  for (const s of SKILLS) {
    const weight = countAny(text, [s.label, ...s.aliases]);
    add(s.label.toLowerCase(), { label: s.label, terms: [s.label, ...s.aliases], evidence: s.evidence || [], weight });
  }
  for (const l of LANGUAGES) {
    // "Go" and "C" are ordinary words too; only accept them in a list of
    // languages, where they sit next to a comma or "or".
    if ((l === "Go" || l === "C" || l === "R") && !new RegExp(`(?:,|\\bor|\\band|\\bin|\\bwith|\\busing)\\s${esc(l)}(?![\\p{L}+#])|(?<![\\p{L}])${esc(l)}(?:,|\\s(?:and|or)\\b)`, "u").test(text)) continue;
    const weight = count(text, l, { caseSensitive: true }) + (LANG_ALIASES[l] || []).reduce((n, a) => n + count(text, a), 0);
    add(l.toLowerCase(), { label: l, terms: [l, ...(LANG_ALIASES[l] || [])], caseSensitive: l.length <= 2, evidence: [], weight });
  }
  // "Java, Python, C++, Go, or Rust" asks for any one of them, not all.
  let group = 0;
  for (const sentence of text.split(/(?<=[.;:\n])\s|\s-\s/)) {
    const langs = LANGUAGES.filter((l) => out.has(l.toLowerCase()) && count(sentence, l, { caseSensitive: true }));
    if (langs.length >= 3 && /\b(or|any|one of|such as|at least one|e\.g\.)\b/i.test(sentence)) {
      group++;
      for (const l of langs) out.get(l.toLowerCase()).anyOf = group;
    }
  }
  // Named tools and platforms (AWS, Kubernetes, Terraform, ...), as written.
  const known = new Set([...out.values()].flatMap((e) => e.terms.map((t) => t.toLowerCase())));
  for (const w of techWords) {
    if (w.length < 3 || known.has(w.toLowerCase())) continue;
    const weight = count(text, w, { caseSensitive: true });
    add(w.toLowerCase(), { label: w, terms: [w], evidence: [], weight });
  }
  // Product names the lists don't know, recognisable by inner capitals
  // (GitHub, PyTorch, DynamoDB, gRPC).
  for (const m of text.matchAll(/(?<![\p{L}])((?:\p{Ll}+\p{Lu}|\p{Lu}\p{Ll}+\p{Lu}|\p{Lu}{2,}\p{Ll})[\p{L}\p{N}]*)/gu)) {
    const w = m[1];
    if (known.has(w.toLowerCase()) || out.has(w.toLowerCase())) continue;
    add(w.toLowerCase(), { label: w, terms: [w], evidence: [], weight: count(text, w, { caseSensitive: true }) });
  }
  return [...out.values()].sort((a, b) => b.weight - a.weight).slice(0, 60);
}

export function match(keywords, cvText) {
  const text = norm(cvText);
  let rows = keywords.map((k) => {
    const direct = countAny(text, k.terms, { caseSensitive: k.caseSensitive });
    const via = direct ? [] : k.evidence.filter((e) => count(text, e));
    return { ...k, inCv: direct, via };
  });
  // In an "any one of" list, one match is enough; the rest are alternatives.
  const metGroups = new Set(rows.filter((r) => r.anyOf && r.inCv).map((r) => r.anyOf));
  const alternatives = rows.filter((r) => r.anyOf && !r.inCv && metGroups.has(r.anyOf));
  rows = rows.filter((r) => !alternatives.includes(r));
  const total = rows.reduce((s, r) => s + r.weight, 0) || 1;
  const hit = rows.filter((r) => r.inCv || r.via.length).reduce((s, r) => s + r.weight, 0);
  return {
    score: Math.round((hit / total) * 100),
    found: rows.filter((r) => r.inCv),
    shown: rows.filter((r) => !r.inCv && r.via.length),
    missing: rows.filter((r) => !r.inCv && !r.via.length),
    alternatives,
  };
}

export function initJobMatch(app) {
  const { $, el, api } = app;
  const root = $("jobmatch");
  let jd = "";
  let saveTimer = null;
  let result = null;

  async function load() {
    jd = await api.text("/api/job").catch(() => "");
    render();
  }

  function render() {
    const panel = el("div", { className: "lx-panel" });
    panel.append(
      el("h2", { className: "lx-panel__title", textContent: "Job match" }),
      el("p", { className: "lx-hint", textContent: "Paste a job description to see which of its skills and keywords your CV covers. The CV is read the way an applicant tracking system reads the PDF." }));

    const ta = el("textarea", { className: "lx-textarea", id: "jd", rows: 8, value: jd, spellcheck: false });
    ta.addEventListener("input", () => {
      jd = ta.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => api.json("/api/job", { method: "PUT", body: jd }).catch(() => {}), 500);
    });
    const check = el("button", { type: "button", className: "lx-button", textContent: "Check match" });
    check.addEventListener("click", () => run());
    panel.append(el("div", { className: "lx-form-group" },
      el("label", { className: "lx-label", htmlFor: "jd", textContent: "Job description" }), ta),
      el("div", { className: "lx-panel__actions" }, check));

    if (result) panel.append(resultView());
    root.replaceChildren(panel);
  }

  async function run() {
    if (!jd.trim()) { result = null; render(); return; }
    const cv = await app.cvText();
    const keywords = extractKeywords(jd, app.techWords());
    result = { ...match(keywords, cv), cv, at: Date.now() };
    render();
  }

  function resultView() {
    const r = result;
    const box = el("div", { className: "lx-result" });
    const tone = r.score >= 75 ? "good" : r.score >= 50 ? "ok" : "low";
    box.append(el("div", { className: `lx-score lx-score--${tone}` },
      el("span", { className: "lx-score__value", textContent: `${r.score}%` }),
      el("span", { className: "lx-score__label", textContent: "keyword coverage, weighted by how often the job description mentions each one" })));

    // Clicking a chip finds it in the source: the skill itself, or the
    // first piece of evidence for it.
    const chip = (k, kind) => {
      const title = kind === "missing" ? `Mentioned ${k.weight}× in the job description`
        : kind === "shown" ? `Not named in your CV, but shown by ${k.via.join(", ")}. Select to find it.`
        : `Mentioned ${k.weight}× in the job, ${k.inCv}× in your CV. Select to find it.`;
      const b = el("button", { type: "button", className: `lx-chip lx-chip--${kind === "missing" ? "missing" : kind === "shown" ? "shown" : "found"}`, title },
        el("span", { textContent: k.label }),
        kind === "shown" ? el("span", { className: "lx-chip__via", textContent: `via ${k.via.slice(0, 2).join(", ")}` }) : null,
        el("span", { className: "lx-chip__count", textContent: `${k.weight}` }));
      if (kind !== "missing") {
        const term = kind === "shown" ? k.via[0] : k.terms.find((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(r.cv)) || k.label;
        b.addEventListener("click", () => app.findInSource(term));
      }
      return b;
    };
    const group = (title, list, kind, empty, note) => {
      box.append(el("h3", { className: "lx-subtitle", textContent: `${title} (${list.length})` }));
      box.append(list.length ? el("div", { className: "lx-chips" }, ...list.map((k) => chip(k, kind))) : el("p", { className: "lx-hint", textContent: empty }));
      if (note && list.length) box.append(el("p", { className: "lx-hint", textContent: note }));
    };
    group("Missing", r.missing, "missing", "Nothing missing.", "Only add a missing keyword if it is true of your experience.");
    group("Shown by related experience", r.shown, "shown", "None.", "Your CV shows these through the tools you list. Naming the skill outright helps with keyword filters.");
    group("In your CV", r.found, "found", "None yet.");
    if (r.alternatives.length) {
      box.append(el("p", { className: "lx-hint", textContent: `Not needed: ${r.alternatives.map((k) => k.label).join(", ")}. The job asks for any one of a list of languages, and your CV already has one.` }));
    }

    const copy = el("button", { type: "button", className: "lx-button lx-button--secondary", textContent: "Make a tailored copy" });
    copy.addEventListener("click", tailoredCopy);
    const ask = el("button", { type: "button", className: "lx-button lx-button--secondary", textContent: "Ask Claude to tailor it" });
    ask.addEventListener("click", () => app.askClaude(
      `Tailor ${app.settings.main} to the job description saved in .laex/job.md. ` +
      `Missing keywords, most mentioned first: ${r.missing.slice(0, 15).map((k) => k.label).join(", ") || "none"}. ` +
      "Reorder and reword existing bullets so the strongest matching evidence comes first. " +
      "Only use a missing keyword where my experience genuinely supports it; list the ones you could not honestly add. Keep it to one page."));
    box.append(el("div", { className: "lx-panel__actions" }, copy, ask));
    return box;
  }

  async function tailoredCopy() {
    const main = app.settings.main;
    if (!main) return;
    const company = await app.ask({ title: "Make a tailored copy", label: "Company name", hint: `Creates a copy of ${main} for this application and makes it the main document`, confirm: "Make copy" });
    if (!company) return;
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
    const base = main.slice(dir.length).replace(/\.tex$/, "").replace(/_[a-z0-9]+$/, "");
    const to = `${dir}${base}_${slug}.tex`;
    try {
      app.applyProjectInfo(await api.fs({ op: "copy", path: main, to }));
      app.setMain(to);
      await app.openFile(to);
      app.setStatus("Copied", "green", `Created ${to} for ${company}. It is now the main document.`);
    } catch (e) {
      app.setStatus("Error", "red", e.message);
    }
  }

  return { load, run, hasJob: () => !!jd.trim() };
}
