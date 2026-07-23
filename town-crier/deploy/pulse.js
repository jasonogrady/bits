/* ============================================================
   ogrady.ai — recruiter-funnel instrumentation
   (renamed from analytics.js — that filename, and the /api/track
   endpoint, are on ad-blocker lists; pulse.js + /api/pulse are not)

   Beacons to the same-origin Pages Function /api/pulse, which
   stores every event and fans visit / qualified-lead alerts out
   through Town Crier (ntfy phone push + Web Push). Also feeds
   PostHog / GTM / Plausible if their snippets are ever enabled.
   ============================================================ */

(function () {
  const SESSION_KEY = 'og_session';
  const FUNNEL_KEY = 'og_funnel';
  const BEACON_URL = '/api/pulse';

  // ---------- owner opt-out ----------
  // Visit https://ogrady.ai/?me=1 once on each of your devices to stop
  // notifying yourself. ?me=0 to undo.
  const params = new URLSearchParams(location.search);
  if (params.get('me') === '1') localStorage.setItem('og_owner', '1');
  if (params.get('me') === '0') localStorage.removeItem('og_owner');
  const IS_OWNER = localStorage.getItem('og_owner') === '1';

  // ---------- session ----------
  let session, newSession = false;
  try {
    session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch (e) { session = null; }
  if (!session) {
    newSession = true;
    session = {
      id: crypto.randomUUID(),
      started: Date.now(),
      utm: Object.fromEntries(new URLSearchParams(location.search)),
      referrer: document.referrer || null,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ua: navigator.userAgent,
      lang: navigator.language,
      viewport: `${innerWidth}x${innerHeight}`,
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  // ---------- funnel state (persists across pages) ----------
  let funnel;
  try {
    funnel = JSON.parse(localStorage.getItem(FUNNEL_KEY) || 'null');
  } catch (e) { funnel = null; }
  if (!funnel) {
    funnel = { landed: false, contact: false, li: false, gh: false, qualified: false };
  }
  const saveFunnel = () => localStorage.setItem(FUNNEL_KEY, JSON.stringify(funnel));

  // ---------- emit ----------
  function emit(event, props) {
    const payload = {
      event,
      props: props || {},
      session,
      funnel,
      path: location.pathname,
      ts: Date.now(),
      owner: IS_OWNER || undefined,
    };
    // PostHog
    if (window.posthog && typeof posthog.capture === 'function') {
      try { posthog.capture(event, { ...props, $session_id: session.id }); } catch (e) {}
    }
    // GTM dataLayer
    if (window.dataLayer) {
      try { dataLayer.push({ event, ...props }); } catch (e) {}
    }
    // Plausible custom events
    if (typeof window.plausible === 'function') {
      try { window.plausible(event, { props: props || {} }); } catch (e) {}
    }
    // Own beacon — same-origin. sendBeacon survives page unload;
    // fetch keepalive is the fallback.
    try {
      const body = JSON.stringify(payload);
      const sent = navigator.sendBeacon &&
        navigator.sendBeacon(BEACON_URL, new Blob([body], { type: 'application/json' }));
      if (!sent) {
        fetch(BEACON_URL, {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body,
        }).catch(() => {});
      }
    } catch (e) {}
    if (window.__DEBUG_ANALYTICS) console.log('[pulse]', event, props || '');
  }

  // ---------- public API ----------
  window.track = emit;
  window.__funnel = funnel;
  window.__session = session;

  // ---------- page view ----------
  funnel.landed = true;
  saveFunnel();
  emit('page_view', { mode: document.documentElement.getAttribute('data-mode') });
  if (newSession) emit('session_start');
  window.ogTrack = emit; // manual event hook (used by contact.html)

  // mark a /contact visit
  if (/contact/i.test(location.pathname)) {
    funnel.contact = true;
    saveFunnel();
    emit('contact_view');
  }

  // ---------- click delegation ----------
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    const label = a.getAttribute('data-track') || a.textContent.trim().slice(0, 40);

    // External link classification
    let event = null;
    if (/linkedin\.com/i.test(href)) { event = 'linkedin_click'; funnel.li = true; }
    else if (/github\.com/i.test(href)) { event = 'github_click'; funnel.gh = true; }
    else if (/contact/i.test(href)) { event = 'contact_click'; funnel.contact = true; }
    else if (/ap2-protocol|google-agentic-commerce|ap2/i.test(href)) { event = 'ap2_click'; }
    else if (/^https?:/i.test(href)) { event = 'outbound_click'; }

    if (event) {
      saveFunnel();
      emit(event, { href, label });

      // Funnel completion: contact visit + (LI or GH) click = qualified lead
      if (funnel.contact && (funnel.li || funnel.gh) && !funnel.qualified) {
        funnel.qualified = true;
        saveFunnel();
        emit('qualified_lead', { trigger: event, href });
      }
    }
  }, { capture: true });

  // ---------- scroll depth ----------
  const depths = [25, 50, 75, 90];
  const seen = new Set();
  addEventListener('scroll', () => {
    const pct = (scrollY + innerHeight) / document.body.scrollHeight * 100;
    for (const d of depths) {
      if (pct >= d && !seen.has(d)) { seen.add(d); emit('scroll', { depth: d }); }
    }
  }, { passive: true });

  // ---------- attention (dwell time in 15s buckets, capped) ----------
  let attentionMs = 0;
  let active = !document.hidden;
  let lastTick = Date.now();
  setInterval(() => {
    if (active && !document.hidden) attentionMs += Date.now() - lastTick;
    lastTick = Date.now();
    const buckets = [15000, 30000, 60000, 120000];
    for (const b of buckets) {
      if (attentionMs >= b && !seen.has('dwell_' + b)) {
        seen.add('dwell_' + b);
        emit('dwell', { ms: b });
      }
    }
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    active = !document.hidden;
    lastTick = Date.now();
  });

  // ---------- mode change (Tweaks) ----------
  const obs = new MutationObserver(() => {
    emit('mode_change', { mode: document.documentElement.getAttribute('data-mode') });
  });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
})();
