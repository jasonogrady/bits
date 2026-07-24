/* ============================================================
   shop-bell 🔔 — /api/pulse endpoint for a Cloudflare Worker
   with a D1 binding (env.DB). See schema.sql for the table.

   Wire it into your Worker's fetch:

     import { handlePulse } from "./worker.js";
     if (url.pathname === "/api/pulse") return handlePulse(request, env, ctx);

   POST  — receives events from pulse.js. Every event lands in D1.
           session_start / qualified_lead fan out as alerts through
           every configured channel, in parallel:
             • a town-crier 📯 hub  (env.CRIER_URL + env.CRIER_TOKEN)
             • ntfy direct          (env.NTFY_TOPIC, optional env.NTFY_AUTH)
           Channels missing their secrets are skipped, and every
           delivery status is reported by the selftest — never
           silently swallowed.

   GET ?key=<CRIER_TOKEN>              — health + recent events JSON
   GET ?key=<CRIER_TOKEN>&selftest=1   — fires a real alert through
           every channel and returns per-channel results.

   Secrets / vars:
     CRIER_TOKEN  — auths the health endpoint and the hub POST
     CRIER_URL    — your town-crier hub's /api/crier/notify (optional)
     NTFY_TOPIC   — ntfy.sh topic for the direct channel (optional)
     NTFY_AUTH    — ntfy access token, paid account (optional)

   Alerts to your own form endpoint (contact, signup, order) are
   best sent by that handler directly — import { notify } and call
   it after the write, inside ctx.waitUntil(). Server-side alerting
   works with JS off and never double-fires from the beacon.
   ============================================================ */

const NOTIFY_EVENTS = ["session_start", "qualified_lead"];

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

  if (!ev.owner && !bot && NOTIFY_EVENTS.includes(ev.event)) {
    ctx.waitUntil(notifyVisit(ev, cf, env, request));
  }
  return json({ ok: true });
}

async function pulseGet(request, env) {
  if (!authed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  const url = new URL(request.url);

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
      .bind(Date.now() - 7 * 86400_000)
      .all(),
  ]);
  return json({
    ok: true,
    crier_set: !!(env.CRIER_URL && env.CRIER_TOKEN),
    ntfy_topic_set: !!env.NTFY_TOPIC,
    ntfy_auth_set: !!env.NTFY_AUTH,
    last_7d: counts.results,
    recent_events: events.results,
  });
}

function authed(request, env) {
  if (!env.CRIER_TOKEN) return false;
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const key = bearer || new URL(request.url).searchParams.get("key") || "";
  return key === env.CRIER_TOKEN;
}

// ----- alert composition -----

async function notifyVisit(ev, cf, env, request) {
  const s = ev.session || {};
  const host = new URL(request.url).hostname;
  const where = [cf.city, cf.region, cf.country].filter(Boolean).join(", ");
  const lines = [];
  if (cf.asOrganization) lines.push(`Org: ${cf.asOrganization}`);
  if (where) lines.push(`From: ${where}`);
  if (s.referrer) lines.push(`Ref: ${s.referrer}`);
  if (s.utm && Object.keys(s.utm).length) lines.push(`UTM: ${new URLSearchParams(s.utm)}`);
  lines.push(`UA: ${(s.ua || "").slice(0, 90)}`);

  const lead = ev.event === "qualified_lead";
  await notify(env, {
    source: host,
    title: lead ? `🔔 Qualified lead on ${host}` : `👀 Visit — ${host}`,
    body: lines.join("\n"),
    priority: lead ? "high" : "default",
    tags: lead ? "bell" : "eyes",
  });
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
  try {
    const headers = {
      Title: note.title,
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
