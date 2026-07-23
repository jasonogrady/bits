/* ============================================================
   /api/crier/notify — Town Crier ingest + feed.
   The central notification hub: ANY of Jason's apps
   (ogrady.ai, chip-recruiter, manifest, crispy-digitals, …)
   posts here and the note fans out to every channel
   (ntfy phone push, Web Push to the Mac PWA / menu bar app).

   POST  (Bearer CRIER_TOKEN)
     { "source": "chip-recruiter",          // required — app name
       "title":  "New applicant",           // required
       "body":   "Jane Doe applied…",       // optional
       "url":    "https://…/applicant/42",  // optional click-through
       "priority": "high",                  // min|low|default|high|urgent
       "tags":   "golf" }                   // ntfy emoji tags
     → { ok, id, results: [per-channel delivery status] }

   GET   (Bearer CRIER_TOKEN or ?key=)  ?limit=50&since=<ts>
     → { ok, notes: [...] } newest first — feeds the PWA + menu bar app.
   ============================================================ */

import { publish, authed, json } from '../../lib/crier.js';

export async function onRequestPost({ request, env }) {
  if (!authed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const note = await request.json().catch(() => null);
  if (!note?.title || !note?.source) {
    return json({ ok: false, error: 'source and title are required' }, 400);
  }
  const result = await publish(env, {
    source: String(note.source).slice(0, 40),
    title: String(note.title).slice(0, 140),
    body: note.body ? String(note.body).slice(0, 2000) : '',
    url: note.url ? String(note.url).slice(0, 500) : undefined,
    priority: ['min', 'low', 'default', 'high', 'urgent'].includes(note.priority)
      ? note.priority : 'default',
    tags: note.tags ? String(note.tags).slice(0, 60) : undefined,
  });
  return json({ ok: true, ...result });
}

export async function onRequestGet({ request, env }) {
  if (!authed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.CRIER) return json({ ok: false, error: 'KV not bound' }, 500);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const since = parseInt(url.searchParams.get('since') || '0', 10);

  const list = await env.CRIER.list({ prefix: 'note:', limit });
  let notes = (await Promise.all(
    list.keys.map((k) => env.CRIER.get(k.name, 'json'))
  )).filter(Boolean);
  if (since) notes = notes.filter((n) => n.ts > since);
  return json({ ok: true, notes });
}

export function onRequestOptions() {
  return json(null);
}
