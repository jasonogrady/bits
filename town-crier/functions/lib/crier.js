/* ============================================================
   Town Crier core — store + fan out a notification.

   Every notification goes through publish():
     1. persisted to KV (binding CRIER) — the feed the PWA reads
     2. pushed to ntfy.sh (phone), response status RECORDED, never swallowed
     3. pushed via Web Push to every registered subscription (Mac PWA);
        dead subscriptions (404/410) are pruned automatically

   KV layout (all keys sort newest-first via inverted-timestamp):
     note:<invTs>:<id>   notification            (30d TTL)
     evt:<invTs>:<sid>   raw traffic event       (90d TTL)
     sub:<hash>          web-push subscription   (no TTL)
     sys:push:<invTs>    delivery diagnostic     (7d TTL)
   ============================================================ */

import { sendWebPush } from './webpush.js';

const INV_MAX = 99999999999999; // 14-digit ms-timestamp ceiling (year 5138)

export const invTs = (ts) => String(INV_MAX - ts).padStart(14, '0');

export function authed(request, env) {
  if (!env.CRIER_TOKEN) return false;
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const key = bearer || new URL(request.url).searchParams.get('key') || '';
  return key === env.CRIER_TOKEN;
}

export function json(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  });
}

export const isBot = (ua = '') =>
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|lighthouse|pingdom|uptime/i.test(ua);

async function recordDiag(env, entry) {
  if (!env.CRIER) return;
  const ts = Date.now();
  await env.CRIER.put(
    `sys:push:${invTs(ts)}:${Math.random().toString(36).slice(2, 6)}`,
    JSON.stringify({ ts, ...entry }),
    { expirationTtl: 7 * 86400 }
  ).catch(() => {});
}

async function pushNtfy(env, note) {
  if (!env.NTFY_TOPIC) return { channel: 'ntfy', skipped: 'no NTFY_TOPIC' };
  try {
    const headers = {
      Title: note.title,
      Priority: note.priority || 'default',
      Tags: note.tags || 'loudspeaker',
    };
    if (note.url) headers.Click = note.url;
    if (env.NTFY_AUTH) headers.Authorization = `Bearer ${env.NTFY_AUTH}`;
    const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: 'POST', headers, body: note.body || '',
    });
    const out = { channel: 'ntfy', status: res.status };
    if (!res.ok) out.error = (await res.text()).slice(0, 200);
    return out;
  } catch (e) {
    return { channel: 'ntfy', error: String(e).slice(0, 200) };
  }
}

async function pushWebPush(env, note) {
  if (!env.CRIER || !env.VAPID_PRIVATE_JWK) {
    return [{ channel: 'webpush', skipped: 'not configured' }];
  }
  const subs = await env.CRIER.list({ prefix: 'sub:' });
  if (!subs.keys.length) return [{ channel: 'webpush', skipped: 'no subscriptions' }];

  const payload = JSON.stringify({
    title: note.title, body: note.body || '', url: note.url || '/crier/',
    source: note.source, priority: note.priority || 'default', ts: note.ts,
  });
  const urgency = note.priority === 'high' || note.priority === 'urgent' ? 'high' : 'normal';

  return Promise.all(subs.keys.map(async (k) => {
    try {
      const stored = await env.CRIER.get(k.name, 'json');
      if (!stored?.sub?.endpoint) { await env.CRIER.delete(k.name); return { channel: 'webpush', skipped: 'bad record' }; }
      const r = await sendWebPush(env, stored.sub, payload, urgency);
      if (r.gone) await env.CRIER.delete(k.name);
      return { channel: 'webpush', endpoint: stored.sub.endpoint.slice(0, 60), status: r.status };
    } catch (e) {
      return { channel: 'webpush', error: String(e).slice(0, 200) };
    }
  }));
}

/**
 * Store + fan out one notification.
 * note: {source, title, body?, url?, priority? (min|low|default|high|urgent), tags?}
 * Returns delivery results (also recorded to sys:push:* for the health endpoint).
 */
export async function publish(env, note) {
  const ts = Date.now();
  const id = crypto.randomUUID().slice(0, 8);
  const full = { id, ts, ...note };

  if (env.CRIER) {
    await env.CRIER.put(`note:${invTs(ts)}:${id}`, JSON.stringify(full), {
      expirationTtl: 30 * 86400,
    }).catch(() => {});
  }

  const results = (await Promise.all([pushNtfy(env, full), pushWebPush(env, full)])).flat();
  await recordDiag(env, { note: full.title, source: full.source, results });
  return { id, results };
}
