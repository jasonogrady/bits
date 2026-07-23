/* ============================================================
   Cloudflare Pages Function — /api/pulse
   Beacon endpoint for deploy/pulse.js (renamed from /api/track —
   "track"/"analytics" URLs are on ad-blocker lists; "pulse" is not).

   POST  — receives events. Every event is stored in KV (90d).
           session_start / qualified_lead / contact_submit fan out
           through Town Crier (ntfy + Web Push), with delivery
           status RECORDED — nothing is silently swallowed anymore.

   GET ?key=<CRIER_TOKEN>              — health + diagnostics JSON
   GET ?key=<CRIER_TOKEN>&selftest=1   — fires a real notification
           through the full pipeline and returns per-channel results.
           THIS is how you test the system end to end.
   ============================================================ */

import { publish, authed, json, isBot, invTs } from '../lib/crier.js';

const WATCHLIST = [
  'anthropic', 'openai', 'apple', 'nvidia', 'waymo', 'deepmind',
  'meta', 'microsoft', 'amazon', 'stripe', 'vercel', 'cloudflare',
  'cursor', 'anysphere', 'perplexity', 'mistral', 'hugging face',
  'databricks', 'scale', 'xai', 'cohere', 'figma', 'linear', 'notion',
];

const NOTIFY_EVENTS = ['session_start', 'qualified_lead', 'contact_submit'];

export async function onRequestPost({ request, env, waitUntil }) {
  const ev = await request.json().catch(() => ({}));
  if (!ev.event) return json({ ok: false, error: 'no event' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || '';
  const cf = request.cf || {};
  const ua = ev.session?.ua || request.headers.get('user-agent') || '';
  const bot = isBot(ua);

  // Store everything (including owner + bot traffic, flagged) — the feed
  // in the Crier PWA is how you "monitor traffic" beyond notifications.
  if (env.CRIER) {
    const ts = Date.now();
    const sid = (ev.session?.id || 'anon').slice(0, 8);
    waitUntil(env.CRIER.put(
      `evt:${invTs(ts)}:${sid}`,
      JSON.stringify({
        ts, event: ev.event, props: ev.props, path: ev.path,
        session: ev.session, funnel: ev.funnel,
        owner: !!ev.owner, bot,
        geo: { city: cf.city, region: cf.region, country: cf.country, org: cf.asOrganization },
      }),
      { expirationTtl: 90 * 86400 }
    ).catch(() => {}));
  }

  if (!ev.owner && !bot && NOTIFY_EVENTS.includes(ev.event)) {
    waitUntil(notifyVisit(ev, ip, cf, env));
  }
  return json({ ok: true });
}

export function onRequestOptions() {
  return json(null);
}

export async function onRequestGet({ request, env }) {
  if (!authed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const url = new URL(request.url);

  if (url.searchParams.get('selftest') === '1') {
    const result = await publish(env, {
      source: 'selftest',
      title: '🧪 Town Crier self-test',
      body: `Fired from /api/pulse?selftest=1 at ${new Date().toISOString()}`,
      priority: 'high',
      tags: 'test_tube',
    });
    return json({ ok: true, selftest: result });
  }

  // Health + diagnostics
  const out = {
    ok: true,
    kv: !!env.CRIER,
    ntfy_topic_set: !!env.NTFY_TOPIC,
    ntfy_auth_set: !!env.NTFY_AUTH,
    vapid_set: !!env.VAPID_PRIVATE_JWK,
    ipinfo_set: !!env.IPINFO_TOKEN,
  };
  if (env.CRIER) {
    const [subs, pushes, events] = await Promise.all([
      env.CRIER.list({ prefix: 'sub:' }),
      env.CRIER.list({ prefix: 'sys:push:', limit: 10 }),
      env.CRIER.list({ prefix: 'evt:', limit: parseInt(url.searchParams.get('events') || '25', 10) }),
    ]);
    out.push_subscriptions = subs.keys.length;
    out.recent_deliveries = await Promise.all(
      pushes.keys.map((k) => env.CRIER.get(k.name, 'json'))
    );
    out.recent_events = await Promise.all(
      events.keys.map((k) => env.CRIER.get(k.name, 'json'))
    );
  }
  return json(out);
}

async function notifyVisit(ev, ip, cf, env) {
  const company = await lookupCompany(ip, cf, env);
  const where = [cf.city, cf.region, cf.country].filter(Boolean).join(', ');
  const watch = WATCHLIST.find((c) => (company || '').toLowerCase().includes(c));

  const s = ev.session || {};
  const lines = [];
  if (company) lines.push(`Org: ${company}${watch ? '  ⭐ WATCHLIST' : ''}`);
  if (where) lines.push(`From: ${where}`);
  if (s.referrer) lines.push(`Ref: ${s.referrer}`);
  if (s.utm && Object.keys(s.utm).length)
    lines.push(`UTM: ${new URLSearchParams(s.utm)}`);
  if (ev.event === 'qualified_lead')
    lines.push(`Path: viewed contact → ${ev.props?.href || ev.props?.trigger || '?'}`);
  lines.push(`UA: ${(s.ua || '').slice(0, 90)}`);

  const isLead = ev.event !== 'session_start';
  const title =
    ev.event === 'contact_submit'
      ? `✉️ Contact form submitted${company ? ` — ${company}` : ''}`
      : isLead
        ? `🚨 Qualified lead${watch ? ` — ${company}` : ''}`
        : `👀 Visit${company ? ` — ${company}` : ''}${watch ? ' ⭐' : ''}`;

  await publish(env, {
    source: 'ogrady.ai',
    title,
    body: lines.join('\n'),
    priority: isLead || watch ? 'high' : 'default',
    tags: isLead ? 'rotating_light' : 'eyes',
  });
}

async function lookupCompany(ip, cf, env) {
  let org = cf.asOrganization || null;
  if (!env.IPINFO_TOKEN || !ip) return org;
  try {
    const r = await fetch(`https://ipinfo.io/${ip}?token=${env.IPINFO_TOKEN}`, {
      cf: { cacheTtl: 3600 },
    });
    const j = await r.json();
    return j.company?.name || (j.org || '').replace(/^AS\d+\s+/, '') || org;
  } catch {
    return org;
  }
}
