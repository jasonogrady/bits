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
     GET  /admin/count           {total} — for an "Admin (42)" button on the landing page
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
     TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SID (or
                    TWILIO_FROM) SMS via Twilio (optional); NOTIFY_SMS_TO default
                    admin-alert number (overridable in dashboard)
     ADMIN_SESSION_DAYS  how long a PIN login lasts (default 30)
     GB_MINIMAL=1   privacy-minimal: store email + time only (no referrer/geo/UA),
                    and notifications carry the running count, never the person

   Own form? Skip /signup and call recordSignup() from your handler:
     import { recordSignup } from "./guestbook/worker.js";
     await recordSignup(request, env, ctx, { email });   // first/last/note/phone optional

   Options (4th argument, all optional) — for sites that already have a
   login, a layout, or a mailer of their own:
     handleGuestbook(request, env, ctx, {
       isAdmin:   async (request, env) => bool,  // host auth replaces the PIN gate
       loginUrl:  "/auth/login?next=%2Fadmin",   // where a signed-out /admin goes (with isAdmin)
       logoutUrl: "/auth/logout",                // dashboard "Log out" target (with isAdmin)
       secret:    env.SESSION_SECRET,            // derives the Sheets export key when there is no PIN
       site:      "Caddy Shack",                 // name used in notifications + dashboard title
       copy:      { title, heading, lede, noteLabel, button, thanksHeading, thanksBody },
       prefill:   { first, last, email },        // signed-in visitor: fill the form for them
       sms:       { sender, frequency, termsUrl, privacyUrl },  // omit = no phone / text opt-in field
       shell:     async ({ kind, title, body }) => string | Response,  // wrap /signup + /thanks in your layout
       css:       ":root{--accent:#2ea043}",     // appended to the standalone pages' CSS
       notifyTo:  "you@example.com",             // default email recipient (else NOTIFY_TO)
       sendEmail: async (env, note, to) => ({ channel: "email", status: 200 }),  // your mailer, not Resend
     })

   Landing-page hook: login also sets a non-HttpOnly `gb_admin=1` cookie,
   a UI hint only, so a static page can show an ADMIN link:
     if (/\bgb_admin=1\b/.test(document.cookie)) adminLink.hidden = false;
   ============================================================ */

const CHANNELS = ["crier", "ntfy", "email", "sms"];
const sessionDays = (env) => Number(env.ADMIN_SESSION_DAYS) || 30;

export async function handleGuestbook(request, env, ctx, opts = {}) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;

  if (p === "/signup" && m === "GET") return publicPage(opts, "signup", signupView(opts, url.searchParams.get("err")));
  if (p === "/signup" && m === "POST") return signupPost(request, env, ctx, opts);
  if (p === "/thanks") return publicPage(opts, "thanks", thanksView(opts));
  if (!opts.isAdmin) {   // the PIN gate; a host with its own auth owns /login and its own sign-in routes
    if (p === "/login") return redirect("/admin");
    if (p === "/admin/login" && m === "POST") return login(request, env);
    if (p === "/admin/logout") return logout();
  }
  if (p !== "/admin" && !p.startsWith("/admin/")) return null;

  // Everything below is admin.
  const authed = opts.isAdmin ? !!(await opts.isAdmin(request, env)) : await isAdmin(request, env);
  if (p === "/admin/signups.csv") {
    const key = await exportKey(env, opts);
    if (!authed && !(key && url.searchParams.get("key") === key)) return text("unauthorized", 401);
    return csv(env);
  }
  if (!authed) {
    if (p !== "/admin") return json({ error: "unauthorized" }, 401);
    return opts.isAdmin ? redirect(opts.loginUrl || "/login") : html(pinPage(url.searchParams.get("err"), url.searchParams.get("next"), opts));
  }
  if (p === "/admin") return html(dashboardPage(opts));
  if (p === "/admin/api") return json(await snapshot(env, opts));
  if (p === "/admin/count") return json({ total: (await env.DB.prepare("SELECT COUNT(*) n FROM gb_signups").first()).n });
  if (p === "/admin/settings" && m === "POST") return saveSettings(request, env);
  if (p === "/admin/test" && m === "POST") {
    const results = await notify(env, {
      source: url.hostname,
      title: `🧪 guestbook test — ${opts.site || url.hostname}`,
      body: `Fired from the admin dashboard at ${new Date().toISOString()}`,
      priority: "high",
      tags: "test_tube",
    }, opts);
    return json({ ok: true, results });
  }
  return null;
}

// ---------- signup ----------

async function signupPost(request, env, ctx, opts = {}) {
  const f = await request.formData().catch(() => new FormData());
  const s = (k, n) => String(f.get(k) || "").trim().slice(0, n);
  if (s("website", 10)) return redirect("/thanks"); // honeypot: bots fill it, humans can't see it
  const first = s("first", 60), last = s("last", 60), email = s("email", 120).toLowerCase(), note = s("note", 500);
  if (!first || !last || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return redirect("/signup?err=1");
  const optin = !!opts.sms && f.get("sms_optin") === "yes";
  const phone = optin ? e164(s("phone", 30)) : null;
  if (optin && !phone) return redirect("/signup?err=phone");

  await recordSignup(request, env, ctx, { first, last, email, note, phone, optin }, opts);
  return redirect("/thanks");
}

// Store one signup and ring the bell. Exported so a site with its own form (say, email-only + fetch)
// can keep its handler and still land in the same table, dashboard, and fan-out.
export async function recordSignup(request, env, ctx, { first = "", last = "", email, note = "", phone = null, optin = false }, opts = {}) {
  const minimal = env.GB_MINIMAL === "1";
  const cf = minimal ? {} : request.cf || {};
  const hdr = (k) => (minimal ? null : (request.headers.get(k) || "").slice(0, 300) || null);
  await env.DB.prepare(
    `INSERT INTO gb_signups (ts, first, last, email, note, phone, sms_optin, sms_optin_ts, sms_optin_ip, referrer, city, country, ua)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET ts=excluded.ts, first=excluded.first, last=excluded.last, note=excluded.note,
       phone=excluded.phone, sms_optin=excluded.sms_optin, sms_optin_ts=excluded.sms_optin_ts, sms_optin_ip=excluded.sms_optin_ip`
  ).bind(
    Date.now(), first, last, email, note || null,
    phone, optin ? 1 : 0, optin ? Date.now() : null, optin ? request.headers.get("cf-connecting-ip") : null,
    hdr("referer"), cf.city || null, cf.country || null, hdr("user-agent")
  ).run();

  const host = new URL(request.url).hostname, site = opts.site || host;
  const where = [cf.city, cf.country].filter(Boolean).join(", ");
  const total = (await env.DB.prepare("SELECT COUNT(*) n FROM gb_signups").first()).n;
  const who = [first, last].filter(Boolean).join(" ");
  ctx.waitUntil(notify(env, {
    source: host,
    title: `📝 New signup — ${site} (${total})`,
    body: minimal ? `${total} on the list.` : [who ? `${who} <${email}>` : email, phone && `SMS opt-in: ${phone}`, note && `Note: ${note}`, where && `From: ${where}`].filter(Boolean).join("\n"),
    url: `https://${host}/admin`,
    priority: "default",
    tags: "memo",
  }, opts));
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
// Read-only CSV key for Sheets' IMPORTDATA. Derived from the PIN, or from opts.secret on a site with its own auth; null = no key.
const exportKey = (env, opts = {}) => (env.ADMIN_PIN || opts.secret ? sha(`gb:export:${env.ADMIN_PIN || opts.secret}`) : null);
const cookie = (req, name) => (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1];

export async function isAdmin(request, env) {
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
  const next = String(f.get("next") || ""), back = /^\/[^\/\\]/.test(next) ? next : "/admin";   // same-origin paths only
  if (pin !== env.ADMIN_PIN) {
    // ponytail: 5 fails → 15 min lockout per IP; add Turnstile if this ever sees real abuse
    const n = (row?.until > now - 15 * 60_000 ? row.n : 0) + 1;
    const until = n >= 5 ? now + 15 * 60_000 : now;
    await env.DB.prepare("INSERT INTO gb_attempts (ip, n, until) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET n=?, until=?")
      .bind(ip, n, until, n, until).run();
    return redirect(`/admin?err=${n >= 5 ? "locked" : 1}${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  }
  await env.DB.prepare("DELETE FROM gb_attempts WHERE ip=?").bind(ip).run();
  const maxAge = sessionDays(env) * 86400;
  return new Response(null, {
    status: 303,
    headers: [
      ["location", back],
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

async function getSettings(env, opts = {}) {
  const rows = (await env.DB.prepare("SELECT k, v FROM gb_settings").all()).results;
  const s = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  return {
    notify_crier: s.notify_crier ?? "1",
    notify_ntfy: s.notify_ntfy ?? "1",
    notify_email: s.notify_email ?? "1",
    notify_sms: s.notify_sms ?? "0",
    notify_to: s.notify_to ?? opts.notifyTo ?? env.NOTIFY_TO ?? "",
    notify_sms_to: s.notify_sms_to ?? env.NOTIFY_SMS_TO ?? "",
    last_notify: s.last_notify ? JSON.parse(s.last_notify) : null,
  };
}

async function saveSettings(request, env) {
  const b = await request.json().catch(() => ({}));
  const stmt = env.DB.prepare("INSERT INTO gb_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v");
  const batch = CHANNELS.map((c) => stmt.bind(`notify_${c}`, b[`notify_${c}`] ? "1" : "0"));
  batch.push(stmt.bind("notify_to", String(b.notify_to || "").trim().slice(0, 200)));
  batch.push(stmt.bind("notify_sms_to", e164(String(b.notify_sms_to || "")) || ""));
  await env.DB.batch(batch);
  return json({ ok: true });
}

async function snapshot(env, opts = {}) {
  const now = Date.now(), day = 86400_000;
  const [rows, counts, settings] = await Promise.all([
    env.DB.prepare("SELECT id, ts, first, last, email, note, phone, sms_optin, sms_optin_ts, referrer, city, country FROM gb_signups ORDER BY ts DESC LIMIT 2000").all(),
    env.DB.prepare(
      `SELECT COUNT(*) total,
              SUM(ts > ?) today, SUM(ts > ?) week, SUM(ts > ?) month, SUM(sms_optin) sms FROM gb_signups`
    ).bind(now - day, now - 7 * day, now - 30 * day).first(),
    getSettings(env, opts),
  ]);
  return {
    ok: true,
    metrics: { total: counts.total || 0, today: counts.today || 0, week: counts.week || 0, month: counts.month || 0, sms: counts.sms || 0 },
    signups: rows.results,
    settings,
    channels: {
      crier: !!(env.CRIER_URL && env.CRIER_TOKEN),
      ntfy: !!env.NTFY_TOPIC,
      email: !!(opts.sendEmail || (env.RESEND_API_KEY && env.NOTIFY_FROM)),
      sms: smsReady(env),
    },
    export_key: await exportKey(env, opts),
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

export async function notify(env, note, opts = {}) {
  const s = await getSettings(env, opts).catch(() => ({}));
  const on = (c) => s[`notify_${c}`] === "1";
  const results = await Promise.all([
    on("crier") ? sendCrier(env, note) : { channel: "crier", skipped: "off" },
    on("ntfy") ? sendNtfy(env, note) : { channel: "ntfy", skipped: "off" },
    on("email") ? sendEmail(env, note, s.notify_to, opts) : { channel: "email", skipped: "off" },
    on("sms") ? sendSms(env, s.notify_sms_to, `${note.title}\n${note.body || ""}`.slice(0, 1000)) : { channel: "sms", skipped: "off" },
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
    if (note.actions?.length) headers.Actions = note.actions.join("; "); // "http, Label, URL, method=POST, clear=true" per ntfy; up to 3
    if (env.NTFY_AUTH) headers.Authorization = `Bearer ${env.NTFY_AUTH}`;
    const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", headers, body: note.body || "" });
    const out = { channel: "ntfy", status: res.status };
    if (!res.ok) out.error = (await res.text()).slice(0, 200);
    return out;
  } catch (e) {
    return { channel: "ntfy", error: String(e).slice(0, 200) };
  }
}

export async function sendEmail(env, note, to, opts = {}) {
  if (opts.sendEmail) {   // the host site's own mailer
    if (!to) return { channel: "email", skipped: "no recipient (set it in the dashboard)" };
    try {
      return { channel: "email", ...(await opts.sendEmail(env, note, to)) };
    } catch (e) {
      return { channel: "email", error: String(e).slice(0, 200) };
    }
  }
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

const smsReady = (env) => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_MESSAGING_SID || env.TWILIO_FROM));

// Twilio Messages API. Callers check opt-in (gb_signups.sms_optin=1); this just sends.
// STOP/HELP replies are answered by the Messaging Service itself (Advanced Opt-Out). We learn about a STOP the
// next time we text that number (error 21610) and clear the opt-in so the dashboard stops counting it.
// ponytail: no inbound webhook (needs Twilio signature validation); add /sms/inbound when we want to read replies.
export async function sendSms(env, to, body) {
  if (!smsReady(env)) return { channel: "sms", skipped: "no TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_MESSAGING_SID" };
  if (!to) return { channel: "sms", skipped: "no recipient (set it in the dashboard or NOTIFY_SMS_TO)" };
  try {
    const form = new URLSearchParams({ To: to, Body: body });
    form.set(env.TWILIO_MESSAGING_SID ? "MessagingServiceSid" : "From", env.TWILIO_MESSAGING_SID || env.TWILIO_FROM);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` },
      body: form,
    });
    const j = await res.json().catch(() => ({}));
    const out = { channel: "sms", status: res.status };
    if (res.ok) out.sid = j.sid;
    else {
      out.error = `${j.code || ""} ${j.message || ""}`.trim().slice(0, 200);
      if (j.code === 21610) await env.DB.prepare("UPDATE gb_signups SET sms_optin=0 WHERE phone=?").bind(to).run().catch(() => {});
    }
    return out;
  } catch (e) {
    return { channel: "sms", error: String(e).slice(0, 200) };
  }
}

// ---------- pages ----------

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const text = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });
export const redirect = (to) => new Response(null, { status: 303, headers: { location: to } });

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

// Theme-agnostic form styles for a page rendered inside the host's own layout (opts.shell): everything is scoped
// to .gb and inherits the host's colors and fonts.
const SHELL_CSS = `
.gb{max-width:36rem;margin:0 auto}.gb.center{text-align:center}
.gb label{display:block;font-size:.85rem;opacity:.75;margin:1rem 0 .25rem}
.gb input,.gb textarea{width:100%;padding:.7rem .8rem;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:.4rem;background:transparent;color:inherit;font:inherit}
.gb textarea{min-height:5rem;resize:vertical}.gb .actions{margin-top:1.25rem;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.gb .err{color:#f85149;font-weight:600}.gb .row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.gb .hp{position:absolute;left:-9999px;opacity:0;height:0;overflow:hidden}
.gb .consent{display:flex;gap:.6rem;align-items:flex-start;margin-top:1rem;font-size:.85rem}.gb .consent input{width:auto;margin-top:.2rem;flex:none}
`;

// /signup and /thanks: a standalone page by default, or handed to opts.shell to sit inside the host site's layout.
async function publicPage(opts, kind, view) {
  if (opts.shell) {
    const out = await opts.shell({ kind, title: view.title, body: `<style>${SHELL_CSS}</style><div class="gb${kind === "thanks" ? " center" : ""}">${view.body}</div>` });
    return out instanceof Response ? out : html(String(out));
  }
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${kind === "thanks" ? `<meta http-equiv="refresh" content="5;url=/">` : ""}<title>${esc(view.title)}</title><style>${CSS}.actions{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}.actions>*{margin-top:1.25rem}${kind === "thanks" ? "main{text-align:center}.actions{justify-content:center}" : ""}${opts.css || ""}</style></head>
<body><main>${view.body}</main></body></html>`);
}

function signupView(opts, err) {
  const c = opts.copy || {}, pre = opts.prefill || {}, sms = opts.sms;
  const smsBlock = !sms ? "" : `
  <label for="phone">Mobile number <span style="font-weight:400">(optional, for text updates)</span></label><input id="phone" name="phone" type="tel" maxlength="30" autocomplete="tel" placeholder="(555) 555-1234">
  <label class="consent"><input type="checkbox" name="sms_optin" value="yes"><span>Yes, text me. By checking this box, I agree to receive recurring automated text messages from ${esc(sms.sender || opts.site || "us")} at the number provided. Consent is not a condition of joining. Message frequency varies${sms.frequency ? ` (${esc(sms.frequency)})` : ""}. Msg &amp; data rates may apply. Reply STOP to cancel, HELP for help.${sms.termsUrl || sms.privacyUrl ? ` See our ${[sms.termsUrl && `<a href="${esc(sms.termsUrl)}">SMS Terms</a>`, sms.privacyUrl && `<a href="${esc(sms.privacyUrl)}">Privacy Policy</a>`].filter(Boolean).join(" and ")}.` : ""}</span></label>`;
  return {
    title: c.title || c.heading || "Get notified",
    body: `<h1>${esc(c.heading || "Get notified")}</h1>
<p>${esc(c.lede || "Drop your name and email and we'll be in touch.")}</p>
${err === "phone" ? `<p class="err">Enter a valid US mobile number, or uncheck the text-message box.</p>` : err ? `<p class="err">Please fill in first name, last name, and a valid email.</p>` : ""}
<form method="post" action="/signup">
  <div class="row">
    <div><label for="first">First name</label><input id="first" name="first" required maxlength="60" autocomplete="given-name" value="${esc(pre.first)}"></div>
    <div><label for="last">Last name</label><input id="last" name="last" required maxlength="60" autocomplete="family-name" value="${esc(pre.last)}"></div>
  </div>
  <label for="email">Email</label><input id="email" name="email" type="email" required maxlength="120" autocomplete="email" value="${esc(pre.email)}">
  <label for="note">${esc(c.noteLabel || "Note / who sent you?")} <span style="font-weight:400">(optional)</span></label><textarea id="note" name="note" maxlength="500"></textarea>${smsBlock}
  <div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
  <div class="actions"><button class="btn primary" type="submit">${esc(c.button || "Notify me")}</button> <a class="btn ghost" href="/">Back</a></div>
</form>`,
  };
}

function thanksView(opts) {
  const c = opts.copy || {};
  return {
    title: c.thanksHeading || "You're on the list",
    body: `<h1>${esc(c.thanksHeading || "You're on the list.")}</h1><p>${esc(c.thanksBody || "We'll be in touch. Taking you back in a few seconds.")}</p><div class="actions"><a class="btn ghost" href="/">Back now</a></div>${opts.shell ? `<script>setTimeout(function(){location.href="/"},5000)</script>` : ""}`,
  };
}

function pinPage(err, next, opts = {}) {
  const msg = err === "locked" ? "Too many tries. Locked for 15 minutes." : err === "1" ? "Wrong PIN." : err || "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Admin</title><style>${CSS}main{max-width:22rem;text-align:center}${opts.css || ""}</style></head>
<body><main><h1>Admin</h1><p>Enter your PIN.</p>${msg ? `<p class="err">${esc(msg)}</p>` : ""}
<form method="post" action="/admin/login">${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ""}<input name="pin" type="password" autocomplete="current-password" autofocus required aria-label="PIN"><button type="submit">Sign in</button></form>
</main></body></html>`;
}

function dashboardPage(opts = {}) {
  const logout = opts.isAdmin ? opts.logoutUrl : "/admin/logout";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Signups${opts.site ? ` · ${esc(opts.site)}` : ""}</title><style>${CSS}
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
${opts.css || ""}</style></head>
<body><main>
<header><h1>Signups${opts.site ? ` <span style="color:var(--muted);font-weight:400">· ${esc(opts.site)}</span>` : ""}</h1><a class="btn ghost" href="/" style="margin:0;padding:.5rem 1rem">Site</a>${logout ? `<a class="btn ghost" href="${esc(logout)}" style="margin:0;padding:.5rem 1rem">Log out</a>` : ""}</header>
<div class="tiles">
  <div class="tile"><b id="m-total">–</b><span>Total</span></div>
  <div class="tile"><b id="m-today">–</b><span>Last 24h</span></div>
  <div class="tile"><b id="m-week">–</b><span>Last 7 days</span></div>
  <div class="tile"><b id="m-month">–</b><span>Last 30 days</span></div>
  <div class="tile"><b id="m-sms">–</b><span>SMS opt-ins</span></div>
</div>
<div class="tools">
  <a class="btn" href="/admin/signups.csv">⬇ Export CSV</a>
  <button id="sheets" class="btn ghost" type="button">📊 Open in Sheets</button>
  <button id="refresh" class="btn ghost" type="button">↻ Refresh</button>
</div>
<div class="wrap"><table><thead><tr><th>When</th><th>First</th><th>Last</th><th>Email</th><th>Note / referral</th><th>SMS</th><th>From</th></tr></thead><tbody id="rows"></tbody></table></div>
<details open><summary>🔔 Notifications</summary>
  <div class="ch" id="channels"></div>
  <label for="to">Email recipient</label><input id="to" type="email" placeholder="you@example.com" style="max-width:24rem">
  <label for="smsto">SMS recipient</label><input id="smsto" type="tel" placeholder="+15555551234" style="max-width:24rem">
  <div><button id="save" type="button">Save settings</button> <button id="test" class="btn ghost" type="button">Send test</button></div>
  <p style="margin-top:1rem">Last delivery</p><div class="status" id="last">—</div>
</details>
<div id="toast" hidden></div>
</main>
<script>
var $=function(id){return document.getElementById(id)};var state=null;
var LABELS={crier:"Town Crier 📯",ntfy:"ntfy (phone)",email:"Email",sms:"SMS"};
function toast(m){var t=$("toast");t.textContent=m;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(function(){t.hidden=true},2500)}
function load(){fetch("/admin/api").then(function(r){if(r.status===401)location.href="/admin";return r.json()}).then(render)}
function render(d){state=d;var m=d.metrics;$("m-total").textContent=m.total;$("m-today").textContent=m.today;$("m-week").textContent=m.week;$("m-month").textContent=m.month;$("m-sms").textContent=m.sms;
  var tb=$("rows");tb.textContent="";d.signups.forEach(function(r){var tr=document.createElement("tr");
    [new Date(r.ts).toLocaleString(),r.first,r.last,r.email,r.note||"",r.sms_optin?r.phone+" ✓":"",[r.city,r.country].filter(Boolean).join(", ")].forEach(function(v,i){var td=document.createElement("td");td.textContent=v;if(i===4)td.className="note";tr.appendChild(td)});tb.appendChild(tr)});
  [1,2,4,5,6].forEach(function(i){var empty=d.signups.length&&[].every.call(tb.rows,function(r){return !r.cells[i].textContent});[].forEach.call(document.querySelectorAll("tr"),function(r){if(r.cells[i])r.cells[i].hidden=empty})});
  if(!d.signups.length){var tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=7;td.textContent="No signups yet.";tr.appendChild(td);tb.appendChild(tr)}
  var ch=$("channels");ch.textContent="";Object.keys(LABELS).forEach(function(c){var l=document.createElement("label"),i=document.createElement("input");i.type="checkbox";i.id="n-"+c;i.checked=d.settings["notify_"+c]==="1";
    var pill=document.createElement("span");pill.className="pill"+(d.channels[c]?" ok":"");pill.textContent=d.channels[c]?"configured":"no secrets";l.appendChild(i);l.appendChild(document.createTextNode(LABELS[c]+" "));l.appendChild(pill);ch.appendChild(l)});
  $("to").value=d.settings.notify_to||"";$("smsto").value=d.settings.notify_sms_to||"";$("sheets").hidden=!d.export_key;showLast(d.settings.last_notify)}
function showLast(l){$("last").textContent=l?new Date(l.at).toLocaleString()+"  "+l.title+"\\n"+JSON.stringify(l.results,null,1):"—"}
$("refresh").onclick=load;
$("save").onclick=function(){var b={notify_to:$("to").value,notify_sms_to:$("smsto").value};Object.keys(LABELS).forEach(function(c){b["notify_"+c]=$("n-"+c).checked});
  fetch("/admin/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(function(r){toast(r.ok?"Saved":"Save failed")})};
$("test").onclick=function(){toast("Sending…");fetch("/admin/test",{method:"POST"}).then(function(r){return r.json()}).then(function(d){showLast({at:Date.now(),title:"test",results:d.results});toast("Sent — see results below")})};
$("sheets").onclick=function(){var f='=IMPORTDATA("'+location.origin+'/admin/signups.csv?key='+state.export_key+'")';
  (navigator.clipboard?navigator.clipboard.writeText(f):Promise.reject()).then(function(){toast("Formula copied — paste into A1 of the new sheet")},function(){prompt("Paste this into A1 of a Google Sheet:",f)});window.open("https://sheets.new","_blank")};
load();
</script></body></html>`;
}
