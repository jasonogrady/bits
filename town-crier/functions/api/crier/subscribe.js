/* ============================================================
   /api/crier/subscribe — Web Push subscription registry.

   GET                      → { vapidPublicKey }   (public, needed
                              by the PWA before it can subscribe)
   POST   (Bearer token)    → { subscription, label? } stores a
                              PushSubscription JSON
   DELETE (Bearer token)    → { endpoint } removes one
   ============================================================ */

import { authed, json } from '../../lib/crier.js';

async function subKey(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return 'sub:' + [...new Uint8Array(digest)].slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function onRequestGet({ env }) {
  return json({ ok: true, vapidPublicKey: env.VAPID_PUBLIC_KEY || null });
}

export async function onRequestPost({ request, env }) {
  if (!authed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.CRIER) return json({ ok: false, error: 'KV not bound' }, 500);
  const body = await request.json().catch(() => null);
  const sub = body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return json({ ok: false, error: 'invalid subscription' }, 400);
  }
  await env.CRIER.put(await subKey(sub.endpoint), JSON.stringify({
    sub, label: (body.label || '').slice(0, 80), added: Date.now(),
  }));
  return json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  if (!authed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  if (!body?.endpoint) return json({ ok: false, error: 'endpoint required' }, 400);
  await env.CRIER.delete(await subKey(body.endpoint));
  return json({ ok: true });
}

export function onRequestOptions() {
  return json(null);
}
