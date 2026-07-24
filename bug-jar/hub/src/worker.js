// bug-jar 🫙 hub — ingest, triage API, and the look-in-the-jar dashboard.
// Zero dependencies; one Worker + one D1 database. See ../../README.md.
//
// Auth model (two tokens, both `wrangler secret put`):
//   JAR_TOKEN        may only ADD bugs. Apps hold it server-side and forward
//                    reports — it never ships to a browser.
//   JAR_ADMIN_TOKEN  may read + triage. Pasted once into the dashboard,
//                    kept in localStorage.
// Optional CRIER_URL + CRIER_TOKEN fan every new bug out to town-crier 📯.

const SEVERITIES = ["minor", "normal", "major", "blocker"];
const STATUSES = ["new", "assigned", "fixed", "verified", "wontfix", "dupe"];
const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"];
const OPEN = ["new", "assigned"]; // "open" filter = still needs work

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const bearer = (req) => (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return json({ ok: true });
    if (path === "/" && req.method === "GET")
      return new Response(DASHBOARD, { headers: { "content-type": "text/html;charset=utf-8" } });

    if (path === "/api/bugs" && req.method === "POST") return ingest(req, env, ctx, url);

    // Everything below reads or mutates — admin only.
    if (!env.JAR_ADMIN_TOKEN || bearer(req) !== env.JAR_ADMIN_TOKEN)
      return json({ error: "unauthorized" }, 401);
    if (path === "/api/bugs" && req.method === "GET") return list(env, url);
    if (path === "/api/bugs.csv" && req.method === "GET") return csv(env, url);
    const one = path.match(/^\/api\/bugs\/(\d+)$/);
    if (one && req.method === "PATCH") return patch(req, env, one[1]);
    return json({ error: "not found" }, 404);
  },
};

/* ------------------------------- ingest -------------------------------- */

async function ingest(req, env, ctx, url) {
  if (!env.JAR_TOKEN || bearer(req) !== env.JAR_TOKEN) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return json({ error: "bad json" }, 400);

  const project = typeof b.project === "string" ? b.project.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(project)) return json({ error: "bad project" }, 400);
  const body = typeof b.body === "string" ? b.body.trim().slice(0, 4000) : "";
  if (!body) return json({ error: "empty report" }, 400);
  const title = (typeof b.title === "string" && b.title.trim() ? b.title.trim() : body.split("\n")[0]).slice(0, 120);
  const severity = SEVERITIES.includes(b.severity) ? b.severity : "normal";
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
  const consoleLog = Array.isArray(b.console)
    ? JSON.stringify(b.console.slice(-20).map((l) => String(l).slice(0, 400)))
    : null;
  const extra = b.extra && typeof b.extra === "object" ? JSON.stringify(b.extra).slice(0, 2000) : null;

  const row = await env.DB.prepare(
    `INSERT INTO bugs (project, title, body, severity, reporter, url, ua, viewport, version, console, extra)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id`
  )
    .bind(project, title, body, severity, str(b.reporter, 200), str(b.url, 300), str(b.ua, 300),
          str(b.viewport, 20), str(b.version, 40), consoleLog, extra)
    .first();

  ctx.waitUntil(notifyCrier(env, url.origin, { id: row.id, project, title, severity, reporter: str(b.reporter, 200) }));
  return json({ id: row.id, ok: true }, 201);
}

// New bug → town-crier 📯, severity mapped to notification priority.
// Fire-and-forget: a crier outage must never lose a bug report.
async function notifyCrier(env, origin, bug) {
  if (!env.CRIER_URL || !env.CRIER_TOKEN) return;
  const priority = { blocker: "urgent", major: "high", normal: "default", minor: "low" }[bug.severity];
  try {
    const res = await fetch(new URL("/api/crier/notify", env.CRIER_URL), {
      method: "POST",
      headers: { authorization: `Bearer ${env.CRIER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        source: `bug-jar/${bug.project}`,
        title: `🫙 ${bug.severity} bug in ${bug.project}`,
        body: `${bug.title}${bug.reporter ? ` — ${bug.reporter}` : ""}`,
        url: `${origin}/#bug-${bug.id}`,
        priority,
        tags: "jar",
      }),
    });
    if (!res.ok) console.error(JSON.stringify({ msg: "crier notify failed", status: res.status }));
  } catch (err) {
    console.error(JSON.stringify({ msg: "crier notify error", error: String(err) }));
  }
}

/* ------------------------------ admin API ------------------------------- */

function filters(url) {
  const where = [];
  const binds = [];
  const project = url.searchParams.get("project");
  if (project) { binds.push(project); where.push(`project = ?${binds.length}`); }
  const status = url.searchParams.get("status");
  if (status === "open") where.push(`status IN ('${OPEN.join("','")}')`);
  else if (status && STATUSES.includes(status)) { binds.push(status); where.push(`status = ?${binds.length}`); }
  const q = url.searchParams.get("q");
  if (q) {
    binds.push(`%${q}%`);
    where.push(`(title LIKE ?${binds.length} OR body LIKE ?${binds.length} OR reporter LIKE ?${binds.length})`);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

async function list(env, url) {
  const { clause, binds } = filters(url);
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM bugs ${clause}
       ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END,
                COALESCE(priority, 'P9'), id DESC
       LIMIT 500`
    ).bind(...binds).all()
  ).results;
  const counts = (
    await env.DB.prepare(
      `SELECT project, SUM(status IN ('${OPEN.join("','")}')) AS open, COUNT(*) AS total
       FROM bugs GROUP BY project ORDER BY project`
    ).all()
  ).results;
  return json({ bugs: rows, counts });
}

async function patch(req, env, id) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return json({ error: "bad json" }, 400);
  const sets = [];
  const binds = [];
  if ("status" in b) {
    if (!STATUSES.includes(b.status)) return json({ error: "bad status" }, 400);
    binds.push(b.status); sets.push(`status = ?${binds.length}`);
  }
  if ("priority" in b) {
    if (b.priority !== null && !PRIORITIES.includes(b.priority)) return json({ error: "bad priority" }, 400);
    binds.push(b.priority); sets.push(`priority = ?${binds.length}`);
  }
  if ("notes" in b) {
    binds.push(String(b.notes).slice(0, 4000)); sets.push(`notes = ?${binds.length}`);
  }
  if (!sets.length) return json({ error: "nothing to update" }, 400);
  binds.push(id);
  const res = await env.DB.prepare(
    `UPDATE bugs SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?${binds.length}`
  ).bind(...binds).run();
  if (!res.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true });
}

async function csv(env, url) {
  const { clause, binds } = filters(url);
  const rows = (
    await env.DB.prepare(`SELECT * FROM bugs ${clause} ORDER BY id DESC LIMIT 5000`).bind(...binds).all()
  ).results;
  const cols = ["id", "project", "title", "severity", "priority", "status", "reporter", "version", "url", "created_at", "updated_at", "body", "notes"];
  const cell = (v) => (v == null ? "" : `"${String(v).replace(/"/g, '""')}"`);
  const out = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
  return new Response(out, {
    headers: {
      "content-type": "text/csv;charset=utf-8",
      "content-disposition": 'attachment; filename="bugs.csv"',
    },
  });
}

/* ------------------------------ dashboard ------------------------------- */
// Single dark page, token pasted once (localStorage). Inline JS deliberately
// avoids template literals so it can live inside this outer one.

const DASHBOARD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>🫙 bug jar</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font-family: system-ui, -apple-system, sans-serif; line-height: 1.45; }
  main { max-width: 62rem; margin: 0 auto; padding: 1rem 1.25rem 4rem; }
  header { display: flex; align-items: baseline; gap: .75rem; border-bottom: 1px solid #21262d; padding: .9rem 1.25rem; }
  header .logo { font-weight: 700; font-size: 1.05rem; }
  header .spin { color: #2ea043; font-family: ui-monospace, monospace; }
  a { color: #58a6ff; text-decoration: none; }
  input, select, textarea, button { background: #010409; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: .35rem .55rem; font: inherit; font-size: .88rem; }
  button { background: #21262d; cursor: pointer; }
  button:hover { filter: brightness(1.2); }
  .bar { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: 1rem 0; }
  .bar input[type=search] { flex: 1; min-width: 10rem; }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; margin: .8rem 0; }
  .chip { border: 1px solid #30363d; border-radius: 999px; padding: .15rem .7rem; font-size: .8rem; color: #8b949e; cursor: pointer; }
  .chip b { color: #e6edf3; }
  .chip.active { border-color: #2ea043; color: #2ea043; }
  table { border-collapse: collapse; width: 100%; font-size: .88rem; }
  th, td { text-align: left; padding: .4rem .55rem; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { color: #8b949e; font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; }
  tr.bug { cursor: pointer; }
  tr.bug:hover td { background: #161b22; }
  tr.detail td { background: #010409; cursor: default; }
  .sev { font-family: ui-monospace, monospace; font-size: .78rem; padding: .05rem .45rem; border-radius: 999px; border: 1px solid #30363d; white-space: nowrap; }
  .sev.minor { color: #8b949e; } .sev.normal { color: #58a6ff; border-color: #58a6ff; }
  .sev.major { color: #d29922; border-color: #d29922; } .sev.blocker { color: #f85149; border-color: #f85149; }
  .done td { opacity: .45; }
  .muted { color: #8b949e; font-size: .82rem; }
  pre { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: .6rem .7rem; font-size: .78rem; overflow-x: auto; white-space: pre-wrap; margin: .4rem 0; }
  .detail textarea { width: 100%; min-height: 3.5rem; font-family: ui-monospace, monospace; font-size: .8rem; }
  #gate { max-width: 24rem; margin: 4rem auto; text-align: center; }
  #gate input { width: 100%; margin: .6rem 0; text-align: center; }
  footer { text-align: center; color: #484f58; font-size: .78rem; padding: 1rem; }
</style>
</head>
<body>
<header>
  <span class="logo">🫙 bug jar</span>
  <span id="busy" class="spin"></span>
  <span style="margin-left:auto" class="muted"><a href="#" id="csv">⬇ csv</a> · <a href="#" id="logout">token</a></span>
</header>
<main>
  <div id="gate" hidden>
    <h2>🫙</h2>
    <p class="muted">Paste the admin token to look in the jar.</p>
    <input id="token" type="password" placeholder="JAR_ADMIN_TOKEN" />
    <button id="enter">open the jar</button>
  </div>
  <div id="app" hidden>
    <div class="chips" id="chips"></div>
    <div class="bar">
      <select id="fproject"><option value="">all projects</option></select>
      <select id="fstatus">
        <option value="open" selected>open (new + assigned)</option>
        <option value="">all statuses</option>
        <option>new</option><option>assigned</option><option>fixed</option>
        <option>verified</option><option>wontfix</option><option>dupe</option>
      </select>
      <input id="fq" type="search" placeholder="search title, body, reporter…" />
      <button id="reload">refresh</button>
    </div>
    <table>
      <thead><tr><th>#</th><th>sev</th><th>bug</th><th>project</th><th>reporter</th><th>age</th><th>pri</th><th>status</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <p class="muted" id="count"></p>
  </div>
</main>
<footer>🫙 bug-jar · a <a href="https://github.com/jasonogrady/bits">bit</a></footer>
<script>
(function () {
  "use strict";
  var FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  var PRIORITIES = ["", "P0", "P1", "P2", "P3", "P4"];
  var STATUSES = ["new", "assigned", "fixed", "verified", "wontfix", "dupe"];
  var $ = function (id) { return document.getElementById(id); };
  var token = localStorage.getItem("jar_admin_token") || "";
  var bugs = [], counts = [], busyTimer = null, openDetail = null;

  function busy(on) {
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; $("busy").textContent = ""; }
    if (on) { var i = 0; busyTimer = setInterval(function () { $("busy").textContent = FRAMES[i++ % FRAMES.length]; }, 80); }
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ authorization: "Bearer " + token }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) { gate(); throw new Error("unauthorized"); }
      return res;
    });
  }
  function gate() { $("gate").hidden = false; $("app").hidden = true; $("token").focus(); }

  function query() {
    var p = new URLSearchParams();
    if ($("fproject").value) p.set("project", $("fproject").value);
    if ($("fstatus").value) p.set("status", $("fstatus").value);
    if ($("fq").value.trim()) p.set("q", $("fq").value.trim());
    var s = p.toString();
    return s ? "?" + s : "";
  }

  function load() {
    busy(true);
    api("/api/bugs" + query()).then(function (res) { return res.json(); }).then(function (data) {
      bugs = data.bugs; counts = data.counts;
      $("gate").hidden = true; $("app").hidden = false;
      render();
      busy(false);
      var hash = location.hash.match(/^#bug-(\\d+)$/);
      if (hash) { toggleDetail(Number(hash[1])); location.hash = ""; }
    }).catch(function () { busy(false); });
  }

  // Escapes quotes too — esc() output lands inside HTML attributes (e.g. the
  // reporter-controlled page URL), not just text nodes.
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function age(iso) {
    var s = (Date.now() - new Date(iso + "Z").getTime()) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
    if (s < 86400) return Math.round(s / 3600) + "h";
    return Math.round(s / 86400) + "d";
  }
  function sel(options, value, cls) {
    var h = '<select class="' + cls + '">';
    options.forEach(function (o) {
      h += '<option value="' + o + '"' + (o === (value || "") ? " selected" : "") + ">" + (o || "—") + "</option>";
    });
    return h + "</select>";
  }

  function render() {
    var ch = "";
    counts.forEach(function (c) {
      var active = $("fproject").value === c.project ? " active" : "";
      ch += '<span class="chip' + active + '" data-project="' + esc(c.project) + '"><b>' + c.open + "</b> open · " + esc(c.project) + ' <span class="muted">(' + c.total + ")</span></span>";
    });
    $("chips").innerHTML = ch;
    var pf = $("fproject");
    var keep = pf.value;
    pf.innerHTML = '<option value="">all projects</option>';
    counts.forEach(function (c) { pf.innerHTML += "<option" + (c.project === keep ? " selected" : "") + ">" + esc(c.project) + "</option>"; });

    var h = "";
    bugs.forEach(function (b) {
      var done = b.status !== "new" && b.status !== "assigned";
      h += '<tr class="bug' + (done ? " done" : "") + '" data-id="' + b.id + '">' +
        "<td>" + b.id + "</td>" +
        '<td><span class="sev ' + b.severity + '">' + b.severity + "</span></td>" +
        "<td>" + esc(b.title) + "</td>" +
        "<td>" + esc(b.project) + "</td>" +
        '<td class="muted">' + esc((b.reporter || "").replace(/<.*$/, "").trim() || "?") + "</td>" +
        '<td class="muted">' + age(b.created_at) + "</td>" +
        "<td>" + sel(PRIORITIES, b.priority, "pri") + "</td>" +
        "<td>" + sel(STATUSES, b.status, "status") + "</td>" +
        "</tr>";
    });
    $("rows").innerHTML = h;
    $("count").textContent = bugs.length + " bug" + (bugs.length === 1 ? "" : "s") + " shown";
  }

  function bug(id) { return bugs.find(function (b) { return b.id === id; }); }

  function toggleDetail(id) {
    var row = document.querySelector('tr.bug[data-id="' + id + '"]');
    if (!row) return;
    if (openDetail) { openDetail.remove(); var was = openDetail.dataset.id; openDetail = null; if (Number(was) === id) return; }
    var b = bug(id);
    if (!b) return;
    var tr = document.createElement("tr");
    tr.className = "detail"; tr.dataset.id = id;
    var consoleLog = "";
    try { consoleLog = (JSON.parse(b.console) || []).join("\\n"); } catch (_) {}
    tr.innerHTML = '<td colspan="8" class="detail">' +
      "<pre>" + esc(b.body) + "</pre>" +
      '<p class="muted">' + esc(b.reporter || "?") + " · v" + esc(b.version || "?") + " · " + esc(b.viewport || "?") +
      (b.url ? ' · <a href="' + esc(b.url) + '" target="_blank" rel="noreferrer">page ↗</a>' : "") +
      "<br />" + esc(b.ua || "") + "</p>" +
      (consoleLog ? "<pre>" + esc(consoleLog) + "</pre>" : "") +
      '<textarea class="notes" placeholder="triage notes…">' + esc(b.notes || "") + "</textarea>" +
      "</td>";
    row.after(tr);
    openDetail = tr;
    tr.querySelector(".notes").addEventListener("change", function (e) {
      save(id, { notes: e.target.value });
    });
  }

  function save(id, patchBody) {
    busy(true);
    api("/api/bugs/" + id, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patchBody),
    }).then(function () {
      var b = bug(id);
      Object.keys(patchBody).forEach(function (k) { if (b) b[k] = patchBody[k]; });
      busy(false);
    }).catch(function () { busy(false); });
  }

  $("rows").addEventListener("click", function (e) {
    if (e.target.closest("select, textarea, a")) return;
    var row = e.target.closest("tr.bug");
    if (row) toggleDetail(Number(row.dataset.id));
  });
  $("rows").addEventListener("change", function (e) {
    var row = e.target.closest("tr.bug");
    if (!row) return;
    var id = Number(row.dataset.id);
    if (e.target.classList.contains("pri")) save(id, { priority: e.target.value || null });
    if (e.target.classList.contains("status")) save(id, { status: e.target.value });
  });
  $("chips").addEventListener("click", function (e) {
    var chip = e.target.closest(".chip");
    if (!chip) return;
    $("fproject").value = $("fproject").value === chip.dataset.project ? "" : chip.dataset.project;
    load();
  });
  ["fproject", "fstatus"].forEach(function (id) { $(id).addEventListener("change", load); });
  var qt = null;
  $("fq").addEventListener("input", function () { clearTimeout(qt); qt = setTimeout(load, 300); });
  $("reload").addEventListener("click", load);
  $("csv").addEventListener("click", function (e) {
    e.preventDefault();
    api("/api/bugs.csv" + query()).then(function (res) { return res.blob(); }).then(function (blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "bugs.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  });
  $("logout").addEventListener("click", function (e) { e.preventDefault(); localStorage.removeItem("jar_admin_token"); token = ""; gate(); });
  $("enter").addEventListener("click", function () {
    token = $("token").value.trim();
    if (!token) return;
    localStorage.setItem("jar_admin_token", token);
    load();
  });
  $("token").addEventListener("keydown", function (e) { if (e.key === "Enter") $("enter").click(); });

  if (token) load(); else gate();
})();
</script>
</body>
</html>`;
