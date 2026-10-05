// node test.js — no Wrangler needed: D1 is shimmed with node:sqlite (Node 22.5+).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleGuestbook, sendSms } from "./worker.js";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); } };
}
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const B = "https://example.test";
const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });
const call = (env, opts, path, init) => handleGuestbook(new Request(B + path, init), env, ctx, opts);
const cookies = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
globalThis.fetch = async () => new Response("{}", { status: 200 });

// ---- PIN mode (the default) ----
{
  const env = { DB: d1(), ADMIN_PIN: "12345678" };
  assert.equal((await call(env, {}, "/signup")).status, 200);
  assert.doesNotMatch(await (await call(env, {}, "/signup")).text(), /sms_optin/, "no SMS field unless opts.sms");
  assert.match(await (await call(env, { sms: { sender: "example.test" } }, "/signup")).text(), /sms_optin/);
  assert.equal((await call(env, {}, "/signup", form({ first: "Test", last: "User", email: "Test@Example.com", note: "via test" }))).headers.get("location"), "/thanks");
  assert.equal((await call(env, {}, "/signup", form({ first: "", last: "", email: "nope" }))).headers.get("location"), "/signup?err=1");
  await call(env, {}, "/signup", form({ first: "Bot", last: "Bot", email: "bot@x.com", website: "spam" }));
  await call(env, { sms: {} }, "/signup", form({ first: "Sms", last: "User", email: "sms@example.com", phone: "(555) 555-1234", sms_optin: "yes" }));
  assert.match((await call(env, { sms: {} }, "/signup", form({ first: "Bad", last: "Phone", email: "bad@example.com", phone: "12", sms_optin: "yes" }))).headers.get("location"), /err=phone/);
  assert.equal(await call(env, {}, "/elsewhere"), null);
  assert.equal(await call(env, {}, "/administrator"), null, "only /admin and /admin/* are ours");
  assert.equal((await call(env, {}, "/admin/api")).status, 401);
  assert.match(await (await call(env, {}, "/admin")).text(), /Enter your PIN/);
  assert.match((await call(env, {}, "/admin/login", form({ pin: "wrong" }))).headers.get("location"), /err=1/);
  const login = await call(env, {}, "/admin/login", form({ pin: "12345678", next: "/admin/api" }));
  assert.equal(login.headers.get("location"), "/admin/api");
  assert.equal((await call(env, {}, "/admin/login", form({ pin: "12345678", next: "//evil.test" }))).headers.get("location"), "/admin");
  const auth = { headers: { cookie: cookies(login) } };
  const api = await (await call(env, {}, "/admin/api", auth)).json();
  assert.deepEqual(api.signups.map((r) => r.email).sort(), ["sms@example.com", "test@example.com"]);
  assert.equal(api.signups.find((r) => r.sms_optin).phone, "+15555551234");
  assert.equal(api.metrics.total, 2);
  assert.equal((await (await call(env, {}, "/admin/count", auth)).json()).total, 2);
  assert.match(await (await call(env, {}, "/admin/signups.csv", auth)).text(), /^when,first/);
  assert.match(await (await call(env, {}, `/admin/signups.csv?key=${api.export_key}`)).text(), /test@example\.com/);
  assert.equal((await call(env, {}, "/admin/signups.csv?key=bad")).status, 401);
  await call(env, {}, "/admin/settings", { method: "POST", headers: auth.headers, body: JSON.stringify({ notify_crier: false, notify_to: "me@x.com", notify_sms_to: "555 555 0100" }) });
  const s2 = (await (await call(env, {}, "/admin/api", auth)).json()).settings;
  assert.equal(s2.notify_crier, "0"); assert.equal(s2.notify_to, "me@x.com"); assert.equal(s2.notify_sms_to, "+15555550100");
  const t = await (await call(env, {}, "/admin/test", { method: "POST", headers: auth.headers })).json();
  assert.deepEqual(t.results.find((r) => r.channel === "crier"), { channel: "crier", skipped: "off" });
}

// ---- host-auth mode: the site's own login decides who is admin; no PIN anywhere ----
{
  const env = { DB: d1() }, mail = [];
  const opts = (admin) => ({
    isAdmin: () => admin, loginUrl: "/auth/login?next=%2Fadmin", logoutUrl: "/auth/logout", secret: "s3cret", site: "Test Site",
    notifyTo: "owner@example.com", sendEmail: async (_env, note, to) => { mail.push({ note, to }); return { status: 200 }; },
    shell: ({ kind, title, body }) => `<html><title>${title}</title><body data-kind="${kind}">${body}</body></html>`,
    copy: { heading: "Sign up for next season", button: "Count me in" }, prefill: { first: "Pre", email: "pre@example.com" },
  });
  const page = await (await call(env, opts(false), "/signup")).text();
  assert.match(page, /data-kind="signup"/); assert.match(page, /Sign up for next season/); assert.match(page, /value="pre@example\.com"/); assert.match(page, /Count me in/);
  assert.match(await (await call(env, opts(false), "/thanks")).text(), /data-kind="thanks"/);
  await call(env, opts(false), "/signup", form({ first: "Host", last: "Mode", email: "host@example.com" }));
  await Promise.all(pending);
  assert.equal(mail.length, 1); assert.equal(mail[0].to, "owner@example.com"); assert.match(mail[0].note.title, /Test Site \(1\)/);
  assert.equal((await call(env, opts(false), "/admin")).headers.get("location"), "/auth/login?next=%2Fadmin");
  assert.equal((await call(env, opts(false), "/admin/api")).status, 401);
  assert.equal((await call(env, opts(false), "/admin/login", form({ pin: "x" }))).status, 401, "PIN routes are off under host auth");
  assert.equal(await call(env, opts(true), "/admin/sync", { method: "POST" }), null, "the host's own /admin/* routes fall through");
  const dash = await (await call(env, opts(true), "/admin")).text();
  assert.match(dash, /Open in Sheets/); assert.match(dash, /href="\/auth\/logout"/);
  const api = await (await call(env, opts(true), "/admin/api")).json();
  assert.equal(api.signups[0].email, "host@example.com"); assert.equal(api.channels.email, true); assert.equal(api.settings.notify_to, "owner@example.com");
  assert.match(await (await call(env, opts(false), `/admin/signups.csv?key=${api.export_key}`)).text(), /host@example\.com/);
  assert.equal((await call({ DB: env.DB }, { isAdmin: () => false }, "/admin/signups.csv?key=null")).status, 401, "no PIN and no secret = no export key");
}

// ---- Twilio ----
{
  const env = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_MESSAGING_SID: "MG1",
    DB: { prepare: (sql) => ({ bind: (...a) => ({ run: async () => { env.ran = [sql, a]; } }) }) } };
  let reply, sent;
  globalThis.fetch = async (url, init) => { sent = { url, body: Object.fromEntries(init.body) }; return new Response(JSON.stringify(reply.body), { status: reply.status }); };
  assert.match((await sendSms({}, "+15555550100", "x")).skipped, /TWILIO/);
  assert.match((await sendSms(env, "", "x")).skipped, /recipient/);
  reply = { status: 201, body: { sid: "SM1" } };
  assert.equal((await sendSms(env, "+15555550100", "hi")).sid, "SM1");
  assert.deepEqual(sent.body, { To: "+15555550100", Body: "hi", MessagingServiceSid: "MG1" });
  assert.match(sent.url, /AC1\/Messages\.json$/);
  assert.equal(env.ran, undefined);
  reply = { status: 400, body: { code: 21610, message: "unsubscribed" } };
  assert.match((await sendSms(env, "+15555550100", "hi")).error, /21610 unsubscribed/);
  assert.match(env.ran[0], /sms_optin=0/);
  assert.deepEqual(env.ran[1], ["+15555550100"]);
}
console.log("ok");
