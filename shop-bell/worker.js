/* ============================================================
   shop-bell 🔔 — /api/pulse endpoint for a Cloudflare Worker
   with a D1 binding (env.DB). See schema.sql for the table.

   Wire it into your Worker's fetch:

     import { handlePulse } from "./worker.js";
     if (url.pathname === "/api/pulse") return handlePulse(request, env, ctx);

   POST  — receives events from pulse.js. Every event lands in D1.
           Events listed in PULSE_NOTIFY (default
           "session_start,qualified_lead") fan out as alerts through
           every configured channel, in parallel:
             • a town-crier 📯 hub  (env.CRIER_URL + env.CRIER_TOKEN)
             • ntfy direct          (env.NTFY_TOPIC, optional env.NTFY_AUTH)
           Channels missing their secrets are skipped, and every
           delivery status is reported by the selftest — never
           silently swallowed. Quiet notes (priority low/min) ride
           the hub only; direct ntfy is the ring-the-phone path.

   GET ?key=<CRIER_TOKEN>              — health + recent events JSON
   GET ?key=<CRIER_TOKEN>&selftest=1   — fires a real alert through
           every channel and returns per-channel results.
   GET ?key=<CRIER_TOKEN>&view=1       — the traffic page (HTML):
           on-site-now, today / 7d / 30d, daily table, top pages,
           referrers, countries, recent sessions. Or route it
           yourself behind your own admin auth: trafficPage(env, …).

   Daily digest: export a scheduled() handler that calls
   pulseDigest(env, { host }) — yesterday's numbers as one note.

   Secrets / vars:
     CRIER_TOKEN   — auths the health endpoint and the hub POST
     CRIER_URL     — your town-crier hub's /api/crier/notify (optional)
     NTFY_TOPIC    — ntfy.sh topic for the direct channel (optional)
     NTFY_AUTH     — ntfy access token, paid account (optional)
     PULSE_NOTIFY  — events that alert, comma-separated (optional).
                     "page_view,qualified_lead" rings on every page:
                     the first view of a session is a 👀 Visit at
                     default priority, later views are 📄 at low.
                     (page_view already covers session_start —
                     listing both rings twice per new visitor.)
     PULSE_TZ      — IANA zone for the traffic page + digest
                     (default UTC)

   Alerts to your own form endpoint (contact, signup, order) are
   best sent by that handler directly — import { notify } and call
   it after the write, inside ctx.waitUntil(). Server-side alerting
   works with JS off and never double-fires from the beacon.
   ============================================================ */

const DEFAULT_NOTIFY = "session_start,qualified_lead";
const DAY = 86400_000;

export const isBot = (ua = "") =>
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|lighthouse|pingdom|uptime/i.test(ua);

export function json(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
  });
}

export async function handlePulse(request, env, ctx) {
  if (request.method === "OPTIONS") return json(null);
  if (request.method === "POST") return pulsePost(request, env, ctx);
  if (request.method === "GET") return pulseGet(request, env);
  return json({ error: "Method not allowed" }, 405);
}

async function pulsePost(request, env, ctx) {
  const ev = await request.json().catch(() => ({}));
  if (!ev.event) return json({ ok: false, error: "no event" }, 400);

  const cf = request.cf || {};
  const ua = ev.session?.ua || request.headers.get("user-agent") || "";
  const bot = isBot(ua);

  // Store everything, including owner + bot traffic, flagged.
  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO pulse_events
         (ts, event, session_id, path, props, funnel, owner, bot,
          city, region, country, org, referrer, ua)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        Date.now(),
        String(ev.event).slice(0, 60),
        (ev.session?.id || "anon").slice(0, 40),
        (ev.path || "").slice(0, 200),
        JSON.stringify(ev.props || {}).slice(0, 2000),
        JSON.stringify(ev.funnel || {}).slice(0, 500),
        ev.owner ? 1 : 0,
        bot ? 1 : 0,
        cf.city || null,
        cf.region || null,
        cf.country || null,
        cf.asOrganization || null,
        (ev.session?.referrer || "").slice(0, 500) || null,
        ua.slice(0, 500)
      )
      .run()
      .catch(() => {})
  );

  const notifyOn = (env.PULSE_NOTIFY || DEFAULT_NOTIFY).split(",").map((s) => s.trim());
  if (!ev.owner && !bot && notifyOn.includes(ev.event)) {
    // Logged so `wrangler tail` shows every delivery status, token or no token.
    ctx.waitUntil(notify(env, visitNote(ev, cf, new URL(request.url).hostname)).then((r) => console.log("pulse", ev.event, JSON.stringify(r))));
  }
  return json({ ok: true });
}

async function pulseGet(request, env) {
  if (!authed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  const url = new URL(request.url);

  if (url.searchParams.get("view") === "1") return trafficPage(env, { host: url.hostname });

  if (url.searchParams.get("selftest") === "1") {
    const results = await notify(env, {
      source: url.hostname,
      title: "🧪 shop-bell self-test",
      body: `Fired from /api/pulse?selftest=1 at ${new Date().toISOString()}`,
      priority: "high",
      tags: "test_tube",
    });
    return json({ ok: true, selftest: results });
  }

  const limit = Math.min(parseInt(url.searchParams.get("events") || "25", 10) || 25, 200);
  const [events, counts] = await Promise.all([
    env.DB.prepare("SELECT * FROM pulse_events ORDER BY ts DESC LIMIT ?").bind(limit).all(),
    env.DB.prepare(
      "SELECT event, COUNT(*) n FROM pulse_events WHERE ts > ? GROUP BY event ORDER BY n DESC"
    )
      .bind(Date.now() - 7 * DAY)
      .all(),
  ]);
  return json({
    ok: true,
    crier_set: !!(env.CRIER_URL && env.CRIER_TOKEN),
    ntfy_topic_set: !!env.NTFY_TOPIC,
    ntfy_auth_set: !!env.NTFY_AUTH,
    notify_on: (env.PULSE_NOTIFY || DEFAULT_NOTIFY).split(","),
    last_7d: counts.results,
    recent_events: events.results,
  });
}

export function authed(request, env) {
  if (!env.CRIER_TOKEN) return false;
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const key = bearer || new URL(request.url).searchParams.get("key") || "";
  return key === env.CRIER_TOKEN;
}

// ----- alert composition -----

// One note per alerted event. Exported so a site can reuse the wording for
// events it alerts on from elsewhere.
export function visitNote(ev, cf, host) {
  const s = ev.session || {};
  const page = `${host}${ev.path || "/"}`;
  const where = [cf.city, cf.region, cf.country].filter(Boolean).join(", ");
  const lines = [];
  if (cf.asOrganization) lines.push(`Org: ${cf.asOrganization}`);
  if (where) lines.push(`From: ${where}`);
  if (s.referrer) lines.push(`Ref: ${s.referrer}`);
  if (s.utm && Object.keys(s.utm).length) lines.push(`UTM: ${new URLSearchParams(s.utm)}`);
  const props = Object.entries(ev.props || {}).filter(([k]) => k !== "new").map(([k, v]) => `${k}: ${v}`).join(" · ");
  if (props) lines.push(props);
  lines.push(`UA: ${(s.ua || "").slice(0, 90)}`);

  const note = { source: host, body: lines.join("\n"), url: `https://${page}` };
  const fresh = ev.event === "session_start" || (ev.event === "page_view" && ev.props?.new);
  if (ev.event === "qualified_lead") Object.assign(note, { title: `🔔 Qualified lead on ${host}`, priority: "high", tags: "bell" });
  else if (fresh) Object.assign(note, { title: `👀 Visit — ${page}`, priority: "default", tags: "eyes" });
  else if (ev.event === "page_view") Object.assign(note, { title: `📄 ${page}`, priority: "low", tags: "page_facing_up" });
  else Object.assign(note, { title: `⚡ ${ev.event} — ${page}`, priority: "default", tags: "zap" });
  return note;
}

// ----- fan-out: every configured channel, all statuses reported -----

export async function notify(env, note) {
  return Promise.all([sendCrier(env, note), sendNtfy(env, note)]);
}

async function sendCrier(env, note) {
  if (!env.CRIER_URL || !env.CRIER_TOKEN)
    return { channel: "crier", skipped: "no CRIER_URL/CRIER_TOKEN" };
  try {
    const res = await fetch(env.CRIER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CRIER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(note),
    });
    const out = { channel: "crier", status: res.status };
    if (!res.ok) out.error = (await res.text()).slice(0, 200);
    return out;
  } catch (e) {
    return { channel: "crier", error: String(e).slice(0, 200) };
  }
}

async function sendNtfy(env, note) {
  if (!env.NTFY_TOPIC) return { channel: "ntfy", skipped: "no NTFY_TOPIC" };
  // Direct ntfy is the redundant ring-the-phone path; quiet notes stay on the hub feed.
  if (note.priority === "low" || note.priority === "min") return { channel: "ntfy", skipped: "quiet note" };
  try {
    const headers = {
      Title: rfc2047(note.title),
      Priority: note.priority || "default",
      Tags: note.tags || "bell",
    };
    if (note.url) headers.Click = note.url;
    if (env.NTFY_AUTH) headers.Authorization = `Bearer ${env.NTFY_AUTH}`;
    const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: "POST",
      headers,
      body: note.body || "",
    });
    const out = { channel: "ntfy", status: res.status };
    if (!res.ok) out.error = (await res.text()).slice(0, 200);
    return out;
  } catch (e) {
    return { channel: "ntfy", error: String(e).slice(0, 200) };
  }
}

// ntfy reads RFC 2047 for non-ASCII header values (emoji titles); raw UTF-8 in a header is a Workers quirk.
const rfc2047 = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);

// ----- traffic page + digest -----

const HUMAN = "bot = 0 AND owner = 0";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const refHost = (r) => { try { return new URL(r).hostname.replace(/^www\./, ""); } catch { return r || "(direct)"; } };
// ponytail: one offset for "now"; a day boundary near a DST switch can be off by an hour.
const tzOffset = (tz) => new Date(new Date().toLocaleString("en-US", { timeZone: tz })) - new Date(new Date().toLocaleString("en-US", { timeZone: "UTC" }));
const fmtTime = (ts, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ts);
const fmtDay = (ts, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(ts);

// Totals + top lists for one window. Shared by the page and the digest.
async function stats(env, since) {
  const [tot, paths, refs, countries] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(DISTINCT session_id) visitors, SUM(event = 'page_view') views, SUM(event = 'qualified_lead') leads
                    FROM pulse_events WHERE ${HUMAN} AND ts > ?`).bind(since).first(),
    env.DB.prepare(`SELECT path, COUNT(*) n FROM pulse_events WHERE ${HUMAN} AND event = 'page_view' AND ts > ?
                    GROUP BY path ORDER BY n DESC LIMIT 10`).bind(since).all(),
    env.DB.prepare(`SELECT referrer FROM pulse_events WHERE ${HUMAN} AND event = 'session_start' AND ts > ?`).bind(since).all(),
    env.DB.prepare(`SELECT COALESCE(country, '?') country, COUNT(DISTINCT session_id) n FROM pulse_events WHERE ${HUMAN} AND ts > ?
                    GROUP BY country ORDER BY n DESC LIMIT 10`).bind(since).all(),
  ]);
  const byRef = {};
  for (const r of refs.results) { const h = refHost(r.referrer); byRef[h] = (byRef[h] || 0) + 1; }
  return {
    visitors: tot.visitors || 0, views: tot.views || 0, leads: tot.leads || 0,
    paths: paths.results,
    referrers: Object.entries(byRef).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([r, n]) => ({ r, n })),
    countries: countries.results,
  };
}

export async function trafficPage(env, { host = "", tz = env.PULSE_TZ || "UTC" } = {}) {
  const now = Date.now(), off = tzOffset(tz);
  const [live, day, week, month, days, sessions] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(DISTINCT session_id) n FROM pulse_events WHERE ${HUMAN} AND ts > ?`).bind(now - 5 * 60_000).first(),
    stats(env, now - DAY), stats(env, now - 7 * DAY), stats(env, now - 30 * DAY),
    env.DB.prepare(`SELECT (ts + ?) / ${DAY} d, COUNT(DISTINCT session_id) visitors, SUM(event = 'page_view') views
                    FROM pulse_events WHERE ${HUMAN} AND ts > ? GROUP BY d ORDER BY d DESC`).bind(off, now - 14 * DAY).all(),
    env.DB.prepare(`SELECT session_id, MIN(ts) t0, MAX(ts) t1, SUM(event = 'page_view') views, GROUP_CONCAT(DISTINCT path) paths,
                      MAX(event = 'qualified_lead') lead, MAX(owner) owner, MAX(city) city, MAX(region) region, MAX(country) country,
                      MAX(org) org, MAX(referrer) referrer, MAX(ua) ua
                    FROM pulse_events WHERE bot = 0 AND ts > ? GROUP BY session_id ORDER BY t1 DESC LIMIT 50`).bind(now - 30 * DAY).all(),
  ]);

  const tile = (label, s) => `<div class="tile"><b>${s.visitors}</b><span>${label}</span><small>${s.views} views${s.leads ? ` · ${s.leads} leads` : ""}</small></div>`;
  const list = (title, rows, k) => {
    const max = Math.max(1, ...rows.map((r) => r.n));
    return `<section><h2>${title}</h2><table>${rows.map((r) => `<tr><td>${esc(r[k])}</td><td class="bar"><i style="width:${(r.n / max) * 100}%"></i>${r.n}</td></tr>`).join("") || "<tr><td>—</td></tr>"}</table></section>`;
  };
  const dayRows = days.results.map((r) => `<tr><td>${fmtDay(r.d * DAY - off, tz)}</td><td>${r.visitors}</td><td>${r.views}</td></tr>`).join("");
  const sessRows = sessions.results.map((r) => `<tr class="${r.lead ? "lead" : ""}${r.owner ? " me" : ""}">
    <td>${fmtTime(r.t1, tz)}${r.t1 - r.t0 > 60_000 ? `<br><small>${Math.round((r.t1 - r.t0) / 60_000)} min</small>` : ""}</td>
    <td>${r.views}${r.lead ? " 🔔" : ""}${r.owner ? " <small>you</small>" : ""}</td>
    <td>${esc(r.paths)}</td>
    <td>${esc([r.city, r.region, r.country].filter(Boolean).join(", "))}<br><small>${esc(r.org)}</small></td>
    <td>${esc(refHost(r.referrer))}</td>
    <td><small>${esc((r.ua || "").slice(0, 70))}</small></td></tr>`).join("");

  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(host)} traffic</title>
<style>
  :root{color-scheme:light dark}
  body{font:14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;margin:0;padding:20px;max-width:1100px;margin-inline:auto}
  h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:0 0 6px;opacity:.7;text-transform:uppercase;letter-spacing:.04em}
  .live{display:inline-block;padding:2px 10px;border-radius:999px;background:#2a8;color:#fff;font-weight:600;margin-bottom:16px}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px}
  .tile{padding:12px;border:1px solid #8884;border-radius:10px}.tile b{font-size:28px;display:block}.tile small{opacity:.6;display:block}
  .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin-bottom:20px}
  table{border-collapse:collapse;width:100%}td,th{padding:4px 6px;border-bottom:1px solid #8883;text-align:left;vertical-align:top}
  .bar{position:relative;width:45%;white-space:nowrap}.bar i{position:absolute;left:0;top:4px;bottom:4px;background:#2a84;border-radius:3px;z-index:-1}
  .wrap{overflow-x:auto}small{opacity:.6}tr.lead td{background:#2a81}tr.me td{opacity:.5}
</style>
<h1>${esc(host)} traffic</h1>
<span class="live">● ${live.n} on the site now</span>
<div class="tiles">${tile("today", day)}${tile("7 days", week)}${tile("30 days", month)}</div>
<div class="cols">
  <section><h2>By day</h2><table><tr><th>Day</th><th>Visitors</th><th>Views</th></tr>${dayRows || "<tr><td>—</td></tr>"}</table></section>
  ${list("Pages · 7d", week.paths, "path")}
  ${list("Referrers · 7d", week.referrers, "r")}
  ${list("Countries · 7d", week.countries, "country")}
</div>
<section><h2>Recent sessions · 30d</h2><div class="wrap"><table>
<tr><th>Last seen</th><th>Views</th><th>Pages</th><th>Where</th><th>Ref</th><th>Browser</th></tr>${sessRows || "<tr><td>—</td></tr>"}
</table></div></section>
<p><small>Visitors = distinct tab sessions, bots and your own visits excluded. Times in ${esc(tz)}.</small></p>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// Yesterday in one note. Call from a scheduled() handler (cron trigger).
export async function pulseDigest(env, { host, tz = env.PULSE_TZ || "UTC", url } = {}) {
  const s = await stats(env, Date.now() - DAY);
  const top = (rows, k) => rows.slice(0, 3).map((r) => `${r[k]} ${r.n}`).join(", ") || "—";
  return notify(env, {
    source: host,
    title: `📊 ${host} — ${s.visitors} visitors, ${s.views} views${s.leads ? `, ${s.leads} leads` : ""}`,
    body: [`Pages: ${top(s.paths, "path")}`, `From: ${top(s.referrers, "r")}`, `Countries: ${top(s.countries, "country")}`, `Last 24h to ${fmtTime(Date.now(), tz)}`].join("\n"),
    url,
    priority: "default",
    tags: "bar_chart",
  });
}
