/* ============================================================
   shop-bell 🔔 — visitor pulse client
   The bell over the shop door: rings when someone walks in,
   and the ledger remembers every visit.

   Ships as "pulse.js" beaconing to "/api/pulse" on purpose —
   "analytics"/"track" filenames and endpoints sit on ad-blocker
   filter lists; "pulse" does not. Keep the boring names.

   Drop-in:
     <script defer src="/assets/pulse.js"
             data-endpoint="/api/pulse"
             data-prefix="sb"
             data-goal-paths="/contact"
             data-browse-paths="/services"
             data-browse-links="instagram.com,github.com"></script>

   Funnel:  land → browse (paths or links) → goal path ⇒ qualified
   The server alerts on session_start and qualified_lead; form
   submits are best alerted server-side by the form handler itself
   (works with JS off, never double-fires).

   Owner opt-out: visit /?me=1 once per device (?me=0 undoes it).
   Manual events: window.pulse('event_name', { any: 'props' }).
   Debug: set window.__DEBUG_PULSE = true.
   ============================================================ */

(function () {
  const me = document.currentScript || {};
  const ds = me.dataset || {};
  const PREFIX = ds.prefix || "sb";
  const BEACON_URL = ds.endpoint || "/api/pulse";
  const GOAL_PATHS = (ds.goalPaths || "/contact").split(",").map((s) => s.trim()).filter(Boolean);
  const BROWSE_PATHS = (ds.browsePaths || "").split(",").map((s) => s.trim()).filter(Boolean);
  const BROWSE_LINKS = (ds.browseLinks || "").split(",").map((s) => s.trim()).filter(Boolean);

  const SESSION_KEY = PREFIX + "_session";
  const FUNNEL_KEY = PREFIX + "_funnel";
  const OWNER_KEY = PREFIX + "_owner";

  const startsWithAny = (path, list) => list.some((p) => path.toLowerCase().startsWith(p.toLowerCase()));
  const matchesAny = (href, list) => list.some((h) => href.toLowerCase().includes(h.toLowerCase()));

  // ---------- owner opt-out ----------
  const params = new URLSearchParams(location.search);
  if (params.get("me") === "1") localStorage.setItem(OWNER_KEY, "1");
  if (params.get("me") === "0") localStorage.removeItem(OWNER_KEY);
  const IS_OWNER = localStorage.getItem(OWNER_KEY) === "1";

  // ---------- session ----------
  let session, newSession = false;
  try {
    session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
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
    funnel = JSON.parse(localStorage.getItem(FUNNEL_KEY) || "null");
  } catch (e) { funnel = null; }
  if (!funnel) funnel = { landed: false, browse: false, goal: false, qualified: false };
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
    try {
      const body = JSON.stringify(payload);
      const sent = navigator.sendBeacon &&
        navigator.sendBeacon(BEACON_URL, new Blob([body], { type: "application/json" }));
      if (!sent) {
        fetch(BEACON_URL, {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body,
        }).catch(() => {});
      }
    } catch (e) {}
    if (window.__DEBUG_PULSE) console.log("[pulse]", event, props || "");
  }

  // ---------- public API ----------
  window.pulse = emit;
  window.__funnel = funnel;
  window.__session = session;

  function checkQualified(trigger) {
    if (funnel.goal && funnel.browse && !funnel.qualified) {
      funnel.qualified = true;
      saveFunnel();
      emit("qualified_lead", { trigger });
    }
  }

  // ---------- page view ----------
  funnel.landed = true;
  if (startsWithAny(location.pathname, BROWSE_PATHS)) funnel.browse = true;
  if (startsWithAny(location.pathname, GOAL_PATHS)) funnel.goal = true;
  saveFunnel();
  emit("page_view");
  if (newSession) emit("session_start");
  if (funnel.goal && startsWithAny(location.pathname, GOAL_PATHS)) {
    emit("goal_view");
    checkQualified("goal_view");
  }

  // ---------- click delegation ----------
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    const label = a.getAttribute("data-track") || a.textContent.trim().slice(0, 40);

    let event = null;
    if (matchesAny(href, BROWSE_LINKS)) { event = "browse_click"; funnel.browse = true; }
    else if (startsWithAny(href, GOAL_PATHS)) { event = "goal_click"; funnel.goal = true; }
    else if (startsWithAny(href, BROWSE_PATHS)) { event = "browse_click"; funnel.browse = true; }
    else if (/^https?:/i.test(href)) { event = "outbound_click"; }

    if (event) {
      saveFunnel();
      emit(event, { href, label });
      checkQualified(event);
    }
  }, { capture: true });

  // ---------- scroll depth ----------
  const depths = [25, 50, 75, 90];
  const seen = new Set();
  addEventListener("scroll", () => {
    const pct = (scrollY + innerHeight) / document.body.scrollHeight * 100;
    for (const d of depths) {
      if (pct >= d && !seen.has(d)) { seen.add(d); emit("scroll", { depth: d }); }
    }
  }, { passive: true });

  // ---------- attention (dwell time in buckets, capped) ----------
  let attentionMs = 0;
  let active = !document.hidden;
  let lastTick = Date.now();
  setInterval(() => {
    if (active && !document.hidden) attentionMs += Date.now() - lastTick;
    lastTick = Date.now();
    const buckets = [15000, 30000, 60000, 120000];
    for (const b of buckets) {
      if (attentionMs >= b && !seen.has("dwell_" + b)) {
        seen.add("dwell_" + b);
        emit("dwell", { ms: b });
      }
    }
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    active = !document.hidden;
    lastTick = Date.now();
  });
})();
