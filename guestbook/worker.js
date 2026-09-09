/* ============================================================
   guestbook 📝 — "get notified" signup form + PIN-gated admin
   dashboard + notification fan-out, for a Cloudflare Worker with
   a D1 binding (env.DB). See schema.sql. Zero deps.

   Wire it into your Worker's fetch, ahead of static assets:

     import { handleGuestbook } from "./guestbook/worker.js";
     const r = await handleGuestbook(request, env, ctx);
     return r || env.ASSETS.fetch(request);

   Routes it owns:
     GET  /signup                form (first, last, email, note/referral)
     POST /signup                store → notify → 303 /thanks
     GET  /thanks                "we'll be in touch", auto-returns to /
     GET  /admin                 PIN gate, then dashboard
     POST /admin/login           PIN check (5 fails → 15 min lockout per IP)
     GET  /admin/logout
     GET  /admin/api             metrics + signups + settings (JSON)
     POST /admin/settings        notification toggles
     POST /admin/test            fire a test note through every channel
     GET  /admin/signups.csv     CSV (cookie, or ?key=<export key> for Sheets)

   Secrets / vars:
     ADMIN_PIN      required — the dashboard PIN (8+ digits, please)
     CRIER_URL      town-crier 📯 hub notify endpoint (optional)
     CRIER_TOKEN    town-crier bearer (optional)
     NTFY_TOPIC     ntfy.sh topic (optional); NTFY_AUTH paid token (optional)
     RESEND_API_KEY email via Resend (optional); NOTIFY_FROM sender address;
                    NOTIFY_TO default recipient (overridable in dashboard)
     SMS is a stub — channel exists in settings, reports "not wired".

   Landing-page hook: login also sets a non-HttpOnly `gb_admin=1` cookie,
   a UI hint only, so a static page can show an ADMIN link:
     if (/\bgb_admin=1\b/.test(document.cookie)) adminLink.hidden = false;
   ============================================================ */

const CHANNELS = ["crier", "ntfy", "email", "sms"];
const SESSION_DAYS = 30;

export async function handleGuestbook(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;

  if (p === "/signup" && m === "GET") return html(signupPage(url.searchParams.get("err")));
  if (p === "/signup" && m === "POST") return signupPost(request, env, ctx);
  if (p === "/thanks") return html(thanksPage());
  if (p === "/login") return redirect("/admin");
  if (p === "/admin/login" && m === "POST") return login(request, env);
  if (p === "/admin/logout") return logout();
  if (!p.startsWith("/admin")) return null;

  // Everything below is admin.
  const authed = await isAdmin(request, env);
  if (p === "/admin/signups.csv") {
    if (!authed && url.searchParams.get("key") !== (await exportKey(env))) return text("unauthorized", 401);
    return csv(env);
  }
  if (!authed) return p === "/admin" ? html(pinPage(url.searchParams.get("err"))) : json({ error: "unauthorized" }, 401);
  if (p === "/admin") return html(dashboardPage());
  if (p === "/admin/api") return json(await snapshot(env));
  if (p === "/admin/settings" && m === "POST") return saveSettings(request, env);
  if (p === "/admin/test" && m === "POST") {
    const results = await notify(env, {
      source: url.hostname,
      title: `🧪 guestbook test — ${url.hostname}`,
      body: `Fired from the admin dashboard at ${new Date().toISOString()}`,
      priority: "high",
      tags: "test_tube",
    });
    return json({ ok: true, results });
  }
  return null;
}

// ---------- signup ----------

async function signupPost(request, env, ctx) {
  const f = await request.formData().catch(() => new FormData());
  const s = (k, n) => String(f.get(k) || "").trim().slice(0, n);
  if (s("website", 10)) return redirect("/thanks"); // honeypot: bots fill it, humans can't see it
  const first = s("first", 60), last = s("last", 60), email = s("email", 120).toLowerCase(), note = s("note", 500);
  if (!first || !last || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return redirect("/signup?err=1");
  const optin = f.get("sms_optin") === "yes";
  const phone = optin ? e164(s("phone", 30)) : null;
  if (optin && !phone) return redirect("/signup?err=phone");

  const cf = request.cf || {};
  await env.DB.prepare(
    `INSERT INTO gb_signups (ts, first, last, email, note, phone, sms_optin, sms_optin_ts, sms_optin_ip, referrer, city, country, ua)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET ts=excluded.ts, first=excluded.first, last=excluded.last, note=excluded.note,
       phone=excluded.phone, sms_optin=excluded.sms_optin, sms_optin_ts=excluded.sms_optin_ts, sms_optin_ip=excluded.sms_optin_ip`
  ).bind(
    Date.now(), first, last, email, note || null,
    phone, optin ? 1 : 0, optin ? Date.now() : null, optin ? request.headers.get("cf-connecting-ip") : null,
    (request.headers.get("referer") || "").slice(0, 300) || null,
    cf.city || null, cf.country || null,
    (request.headers.get("user-agent") || "").slice(0, 300)
  ).run();

  const host = new URL(request.url).hostname;
  const where = [cf.city, cf.country].filter(Boolean).join(", ");
  ctx.waitUntil(notify(env, {
    source: host,
    title: `📝 New signup — ${host}`,
    body: [`${first} ${last} <${email}>`, phone && `SMS opt-in: ${phone}`, note && `Note: ${note}`, where && `From: ${where}`].filter(Boolean).join("\n"),
    url: `https://${host}/admin`,
    priority: "default",
    tags: "memo",
  }));
  return redirect("/thanks");
}

// US/CA numbers only for now; returns null if it doesn't look like one.
// ponytail: add country handling when a non-NANP player shows up
function e164(raw) {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === "1") return `+${d}`;
  return null;
}

// ---------- admin auth ----------

const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const sessionKey = (env) => sha(`gb:session:${env.ADMIN_PIN}`);
const exportKey = (env) => sha(`gb:export:${env.ADMIN_PIN}`);
const cookie = (req, name) => (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1];

async function isAdmin(request, env) {
  return !!env.ADMIN_PIN && cookie(request, "gb_s") === (await sessionKey(env));
}

async function login(request, env) {
  if (!env.ADMIN_PIN) return html(pinPage("ADMIN_PIN secret is not set on this Worker."), 500);
  const ip = request.headers.get("cf-connecting-ip") || "?";
  const now = Date.now();
  const row = await env.DB.prepare("SELECT n, until FROM gb_attempts WHERE ip=?").bind(ip).first();
  if (row && row.until > now) return redirect("/admin?err=locked");

  const f = await request.formData().catch(() => new FormData());
  const pin = String(f.get("pin") || "").trim();
  if (pin !== env.ADMIN_PIN) {
    // ponytail: 5 fails → 15 min lockout per IP; add Turnstile if this ever sees real abuse
    const n = (row?.until > now - 15 * 60_000 ? row.n : 0) + 1;
    const until = n >= 5 ? now + 15 * 60_000 : now;
    await env.DB.prepare("INSERT INTO gb_attempts (ip, n, until) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET n=?, until=?")
      .bind(ip, n, until, n, until).run();
    return redirect(n >= 5 ? "/admin?err=locked" : "/admin?err=1");
  }
  await env.DB.prepare("DELETE FROM gb_attempts WHERE ip=?").bind(ip).run();
  const maxAge = SESSION_DAYS * 86400;
  return new Response(null, {
    status: 303,
    headers: [
      ["location", "/admin"],
      ["set-cookie", `gb_s=${await sessionKey(env)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`],
      ["set-cookie", `gb_admin=1; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax`],
    ],
  });
}

function logout() {
  return new Response(null, {
    status: 303,
    headers: [
      ["location", "/"],
      ["set-cookie", "gb_s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"],
      ["set-cookie", "gb_admin=; Path=/; Max-Age=0; Secure; SameSite=Lax"],
    ],
  });
}

// ---------- admin data ----------

async function getSettings(env) {
  const rows = (await env.DB.prepare("SELECT k, v FROM gb_settings").all()).results;
  const s = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  return {
    notify_crier: s.notify_crier ?? "1",
    notify_ntfy: s.notify_ntfy ?? "1",
    notify_email: s.notify_email ?? "1",
    notify_sms: s.notify_sms ?? "0",
    notify_to: s.notify_to ?? env.NOTIFY_TO ?? "",
    last_notify: s.last_notify ? JSON.parse(s.last_notify) : null,
  };
}

async function saveSettings(request, env) {
  const b = await request.json().catch(() => ({}));
  const stmt = env.DB.prepare("INSERT INTO gb_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v");
  const batch = CHANNELS.map((c) => stmt.bind(`notify_${c}`, b[`notify_${c}`] ? "1" : "0"));
  batch.push(stmt.bind("notify_to", String(b.notify_to || "").trim().slice(0, 200)));
  await env.DB.batch(batch);
  return json({ ok: true });
}

async function snapshot(env) {
  const now = Date.now(), day = 86400_000;
  const [rows, counts, settings] = await Promise.all([
    env.DB.prepare("SELECT id, ts, first, last, email, note, phone, sms_optin, sms_optin_ts, referrer, city, country FROM gb_signups ORDER BY ts DESC LIMIT 2000").all(),
    env.DB.prepare(
      `SELECT COUNT(*) total,
              SUM(ts > ?) today, SUM(ts > ?) week, SUM(ts > ?) month, SUM(sms_optin) sms FROM gb_signups`
    ).bind(now - day, now - 7 * day, now - 30 * day).first(),
    getSettings(env),
  ]);
  return {
    ok: true,
    metrics: { total: counts.total || 0, today: counts.today || 0, week: counts.week || 0, month: counts.month || 0, sms: counts.sms || 0 },
    signups: rows.results,
    settings,
    channels: {
      crier: !!(env.CRIER_URL && env.CRIER_TOKEN),
      ntfy: !!env.NTFY_TOPIC,
      email: !!(env.RESEND_API_KEY && env.NOTIFY_FROM),
      sms: false,
    },
    export_key: await exportKey(env),
  };
}

async function csv(env) {
  const rows = (await env.DB.prepare("SELECT ts, first, last, email, note, phone, sms_optin, sms_optin_ts, sms_optin_ip, referrer, city, country FROM gb_signups ORDER BY ts DESC").all()).results;
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["when,first,last,email,note,phone,sms_optin,sms_optin_at,sms_optin_ip,referrer,city,country"];
  for (const r of rows) lines.push([new Date(r.ts).toISOString(), r.first, r.last, r.email, r.note, r.phone, r.sms_optin ? "yes" : "no",
    r.sms_optin_ts ? new Date(r.sms_optin_ts).toISOString() : "", r.sms_optin_ip, r.referrer, r.city, r.country].map(q).join(","));
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/csv;charset=utf-8", "content-disposition": 'attachment; filename="signups.csv"', "cache-control": "no-store" },
  });
}

// ---------- notification fan-out (every configured + enabled channel; statuses recorded, never swallowed) ----------

export async function notify(env, note) {
  const s = await getSettings(env).catch(() => ({}));
  const on = (c) => s[`notify_${c}`] === "1";
  const results = await Promise.all([
    on("crier") ? sendCrier(env, note) : { channel: "crier", skipped: "off" },
    on("ntfy") ? sendNtfy(env, note) : { channel: "ntfy", skipped: "off" },
    on("email") ? sendEmail(env, note, s.notify_to) : { channel: "email", skipped: "off" },
    { channel: "sms", skipped: on("sms") ? "not wired yet" : "off" },
  ]);
  await env.DB.prepare("INSERT INTO gb_settings (k, v) VALUES ('last_notify', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(JSON.stringify({ at: Date.now(), title: note.title, results })).run().catch(() => {});
  return results;
}

async function sendCrier(env, note) {
  if (!env.CRIER_URL || !env.CRIER_TOKEN) return { channel: "crier", skipped: "no CRIER_URL/CRIER_TOKEN" };
  try {
    const res = await fetch(env.CRIER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CRIER_TOKEN}`, "Content-Type": "application/json" },
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
    const headers = { Title: note.title, Priority: note.priority || "default", Tags: note.tags || "memo" };
    if (note.url) headers.Click = note.url;
    if (env.NTFY_AUTH) headers.Authorization = `Bearer ${env.NTFY_AUTH}`;
    const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", headers, body: note.body || "" });
    const out = { channel: "ntfy", status: res.status };
    if (!res.ok) out.error = (await res.text()).slice(0, 200);
    return out;
  } catch (e) {
    return { channel: "ntfy", error: String(e).slice(0, 200) };
  }
}

async function sendEmail(env, note, to) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_FROM) return { channel: "email", skipped: "no RESEND_API_KEY/NOTIFY_FROM" };
  if (!to) return { channel: "email", skipped: "no recipient (set it in the dashboard or NOTIFY_TO)" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.NOTIFY_FROM, to: [to], subject: note.title, text: `${note.body || ""}${note.url ? `\n\n${note.url}` : ""}` }),
    });
    const out = { channel: "email", status: res.status };
    if (!res.ok) out.error = (await res.text()).slice(0, 200);
    return out;
  } catch (e) {
    return { channel: "email", error: String(e).slice(0, 200) };
  }
}

// ---------- pages ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const text = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });
const redirect = (to) => new Response(null, { status: 303, headers: { location: to } });

const CSS = `
:root{--bg:#0b0f14;--fg:#f4f6f8;--muted:#8b96a3;--accent:#e8b923;--line:#1f2a36;--card:#121a23}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}main{max-width:36rem;margin:0 auto;padding:3rem 1.25rem}
h1{font-size:2rem;letter-spacing:-.02em;margin:0 0 .5rem}p{color:var(--muted);margin:0 0 1.5rem}
label{display:block;font-size:.85rem;color:var(--muted);margin:1rem 0 .25rem}
input,textarea{width:100%;padding:.7rem .8rem;border:1px solid var(--line);border-radius:.4rem;background:var(--card);color:var(--fg);font:inherit}
textarea{min-height:5rem;resize:vertical}
button,.btn{display:inline-block;margin-top:1.25rem;padding:.8rem 1.5rem;border:2px solid var(--accent);border-radius:.5rem;background:var(--accent);color:#111;font:inherit;font-weight:700;cursor:pointer;text-decoration:none}
.btn.ghost{background:transparent;color:var(--fg)}
.err{color:#ff7b72;font-weight:600}.row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.hp{position:absolute;left:-9999px;opacity:0;height:0;overflow:hidden}
.consent{display:flex;gap:.6rem;align-items:flex-start;margin-top:1rem;font-size:.85rem;color:var(--muted)}.consent input{width:auto;margin-top:.2rem;flex:none}
`;

function signupPage(err) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Get notified</title><style>${CSS}</style></head>
<body><main>
<h1>Get notified</h1>
<p>Drop your name and email and we'll ping you when the pool opens for testing.</p>
${err === "phone" ? `<p class="err">Enter a valid US mobile number, or uncheck the text-message box.</p>` : err ? `<p class="err">Please fill in first name, last name, and a valid email.</p>` : ""}
<form method="post" action="/signup">
  <div class="row">
    <div><label for="first">First name</label><input id="first" name="first" required maxlength="60" autocomplete="given-name"></div>
    <div><label for="last">Last name</label><input id="last" name="last" required maxlength="60" autocomplete="family-name"></div>
  </div>
  <label for="email">Email</label><input id="email" name="email" type="email" required maxlength="120" autocomplete="email">
  <label for="note">Note / who sent you? <span style="font-weight:400">(optional)</span></label><textarea id="note" name="note" maxlength="500"></textarea>
  <label for="phone">Mobile number <span style="font-weight:400">(optional, for text updates)</span></label><input id="phone" name="phone" type="tel" maxlength="30" autocomplete="tel" placeholder="(555) 555-1234">
  <label class="consent"><input type="checkbox" name="sms_optin" value="yes"><span>Yes, text me. By checking this box, I agree to receive recurring automated text messages from ogrady.football at the number provided, including pool invitations, pick reminders, and weekly results. Consent is not a condition of joining. Message frequency varies (about 2 to 4 per week during the NFL season). Msg &amp; data rates may apply. Reply STOP to cancel, HELP for help. See our <a href="/sms-terms">SMS Terms</a> and <a href="/privacy">Privacy Policy</a>.</span></label>
  <div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
  <button type="submit">Notify me</button> <a class="btn ghost" href="/">Back</a>
</form>
</main></body></html>`;
}

function thanksPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="5;url=/"><title>You're on the list</title><style>${CSS}main{text-align:center}</style></head>
<body><main><h1>You're on the list.</h1><p>We'll be in touch when testing opens. Taking you back in a few seconds.</p><a class="btn ghost" href="/">Back now</a></main></body></html>`;
}

function pinPage(err) {
  const msg = err === "locked" ? "Too many tries. Locked for 15 minutes." : err === "1" ? "Wrong PIN." : err || "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Admin</title><style>${CSS}main{max-width:22rem;text-align:center}</style></head>
<body><main><h1>Admin</h1><p>Enter your PIN.</p>${msg ? `<p class="err">${esc(msg)}</p>` : ""}
<form method="post" action="/admin/login"><input name="pin" type="password" autocomplete="current-password" autofocus required aria-label="PIN"><button type="submit">Sign in</button></form>
</main></body></html>`;
}

function dashboardPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Signups</title><style>${CSS}
main{max-width:72rem}header{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}header h1{margin:0;flex:1}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem;margin:1.5rem 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:.6rem;padding:1rem}
.tile b{display:block;font-size:2rem;line-height:1.1;letter-spacing:-.02em}.tile span{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.08em}
.tools{display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1rem}.tools .btn,.tools button{margin:0;padding:.5rem 1rem;font-size:.9rem}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:.6rem}
table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.55rem .75rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;position:sticky;top:0;background:var(--bg)}
td.note{max-width:24rem;white-space:pre-wrap}tr:last-child td{border-bottom:0}
details{margin:1.5rem 0;background:var(--card);border:1px solid var(--line);border-radius:.6rem;padding:.75rem 1rem}summary{cursor:pointer;font-weight:700}
.ch{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:.75rem;margin:1rem 0}.ch label{display:flex;gap:.5rem;align-items:center;margin:0;font-size:1rem;color:var(--fg)}
.ch input[type=checkbox]{width:auto}.pill{font-size:.7rem;padding:.1rem .45rem;border-radius:1rem;border:1px solid var(--line);color:var(--muted)}.pill.ok{color:#7ee787;border-color:#2e5a3a}
.status{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;white-space:pre-wrap;color:var(--muted)}#toast{position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);background:var(--accent);color:#111;padding:.6rem 1rem;border-radius:.5rem;font-weight:700}
</style></head>
<body><main>
<header><h1>Signups</h1><a class="btn ghost" href="/" style="margin:0;padding:.5rem 1rem">Site</a><a class="btn ghost" href="/admin/logout" style="margin:0;padding:.5rem 1rem">Log out</a></header>
<div class="tiles">
  <div class="tile"><b id="m-total">–</b><span>Total</span></div>
  <div class="tile"><b id="m-today">–</b><span>Last 24h</span></div>
  <div class="tile"><b id="m-week">–</b><span>Last 7 days</span></div>
  <div class="tile"><b id="m-month">–</b><span>Last 30 days</span></div>
  <div class="tile"><b id="m-sms">–</b><span>SMS opt-ins</span></div>
</div>
<div class="tools">
  <a class="btn" href="/admin/signups.csv">⬇ Export CSV</a>
  <button id="sheets" class="btn ghost" type="button">📊 Export to Sheets</button>
  <button id="refresh" class="btn ghost" type="button">↻ Refresh</button>
</div>
<div class="wrap"><table><thead><tr><th>When</th><th>First</th><th>Last</th><th>Email</th><th>Note / referral</th><th>SMS</th><th>From</th></tr></thead><tbody id="rows"></tbody></table></div>
<details open><summary>🔔 Notifications</summary>
  <div class="ch" id="channels"></div>
  <label for="to">Email recipient</label><input id="to" type="email" placeholder="you@example.com" style="max-width:24rem">
  <div><button id="save" type="button">Save settings</button> <button id="test" class="btn ghost" type="button">Send test</button></div>
  <p style="margin-top:1rem">Last delivery</p><div class="status" id="last">—</div>
</details>
<div id="toast" hidden></div>
</main>
<script>
var $=function(id){return document.getElementById(id)};var state=null;
var LABELS={crier:"Town Crier 📯",ntfy:"ntfy (phone)",email:"Email",sms:"SMS (later)"};
function toast(m){var t=$("toast");t.textContent=m;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(function(){t.hidden=true},2500)}
function load(){fetch("/admin/api").then(function(r){if(r.status===401)location.href="/admin";return r.json()}).then(render)}
function render(d){state=d;var m=d.metrics;$("m-total").textContent=m.total;$("m-today").textContent=m.today;$("m-week").textContent=m.week;$("m-month").textContent=m.month;$("m-sms").textContent=m.sms;
  var tb=$("rows");tb.textContent="";d.signups.forEach(function(r){var tr=document.createElement("tr");
    [new Date(r.ts).toLocaleString(),r.first,r.last,r.email,r.note||"",r.sms_optin?r.phone+" ✓":"",[r.city,r.country].filter(Boolean).join(", ")].forEach(function(v,i){var td=document.createElement("td");td.textContent=v;if(i===4)td.className="note";tr.appendChild(td)});tb.appendChild(tr)});
  if(!d.signups.length){var tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=7;td.textContent="No signups yet.";tr.appendChild(td);tb.appendChild(tr)}
  var ch=$("channels");ch.textContent="";Object.keys(LABELS).forEach(function(c){var l=document.createElement("label"),i=document.createElement("input");i.type="checkbox";i.id="n-"+c;i.checked=d.settings["notify_"+c]==="1";i.disabled=c==="sms";
    var pill=document.createElement("span");pill.className="pill"+(d.channels[c]?" ok":"");pill.textContent=d.channels[c]?"configured":"no secrets";l.appendChild(i);l.appendChild(document.createTextNode(LABELS[c]+" "));l.appendChild(pill);ch.appendChild(l)});
  $("to").value=d.settings.notify_to||"";showLast(d.settings.last_notify)}
function showLast(l){$("last").textContent=l?new Date(l.at).toLocaleString()+"  "+l.title+"\\n"+JSON.stringify(l.results,null,1):"—"}
$("refresh").onclick=load;
$("save").onclick=function(){var b={notify_to:$("to").value};Object.keys(LABELS).forEach(function(c){b["notify_"+c]=$("n-"+c).checked});
  fetch("/admin/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(function(r){toast(r.ok?"Saved":"Save failed")})};
$("test").onclick=function(){toast("Sending…");fetch("/admin/test",{method:"POST"}).then(function(r){return r.json()}).then(function(d){showLast({at:Date.now(),title:"test",results:d.results});toast("Sent — see results below")})};
$("sheets").onclick=function(){var f='=IMPORTDATA("'+location.origin+'/admin/signups.csv?key='+state.export_key+'")';
  (navigator.clipboard?navigator.clipboard.writeText(f):Promise.reject()).then(function(){toast("Formula copied — paste into A1 of the new sheet")},function(){prompt("Paste this into A1 of a Google Sheet:",f)});window.open("https://sheets.new","_blank")};
load();
</script></body></html>`;
}
