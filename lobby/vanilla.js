/* ============================================================
   lobby 🛎️ — the front door before the showroom
   A first-visit landing card centered over the app itself: the
   real UI stays partially visible behind a blur, like a lit shop
   seen through frosted glass. The card carries the brand mark, a
   tiny build line, a short pitch, and three doors: see the demo,
   sign in, or get in touch.

   Pairs naturally with the showroom bit (the app maps
   "lobby:demo" → showroom demo mode and "lobby:login" →
   showroom live + sign-in), but has no hard dependency on it.

   Configure via data-* attributes on the <script> tag:
     data-key           localStorage dismissal key (default "lobby-seen")
     data-auto          "true" (default) auto-opens on load when the
                        key is absent; "false" → app calls
                        window.lobby.open() itself
     data-image         hero image URL (brand mark / mascot)
     data-image-alt     its alt text            (default "")
     data-title         heading under the image (optional — omit when
                        the image already carries the wordmark)
     data-build         tiny mono line, e.g. "v3.1.0 · 2026-08-07"
     data-blurb         pitch copy; "\n\n" splits paragraphs
     data-demo-label    primary button   (default "See the demo")
     data-login-label   secondary button (default "Sign in")
     data-contact-label link label       (default "Contact")
     data-contact-url   link href — link hidden when unset

   Events on document (all mark the lobby as seen):
     "lobby:demo"    demo button, backdrop click, or Escape
     "lobby:login"   sign-in button

   API: window.lobby = { open(), close(), seen() }
   open() works even after dismissal — wire it to an "About" item.

   Skin with custom properties (all optional):
     --lb-backdrop (dim color)  --lb-blur (default 7px)
     --lb-bg --lb-color --lb-border (card)
     --lb-accent --lb-accent-contrast (primary button)
     --lb-muted (build line + contact)
   ============================================================ */
(function () {
  var cfg = (document.currentScript && document.currentScript.dataset) || {};
  var KEY = cfg.key || "lobby-seen";
  var AUTO = cfg.auto !== "false";
  var IMAGE = cfg.image || "";
  var IMAGE_ALT = cfg.imageAlt || "";
  var TITLE = cfg.title || "";
  var BUILD = cfg.build || "";
  var BLURB = cfg.blurb || "";
  var DEMO_LABEL = cfg.demoLabel || "See the demo";
  var LOGIN_LABEL = cfg.loginLabel || "Sign in";
  var CONTACT_LABEL = cfg.contactLabel || "Contact";
  var CONTACT_URL = cfg.contactUrl || "";

  function seen() {
    try { return localStorage.getItem(KEY) != null; } catch (e) { return true; }
  }
  function markSeen() {
    try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
  }

  var CSS =
    ".lobby-gate{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;" +
      "justify-content:center;padding:24px;overflow-y:auto;" +
      "background:var(--lb-backdrop,rgba(10,14,24,.45));" +
      "-webkit-backdrop-filter:blur(var(--lb-blur,7px));backdrop-filter:blur(var(--lb-blur,7px))}" +
    ".lobby-card{max-width:420px;width:100%;padding:28px 28px 24px;border-radius:16px;" +
      "background:var(--lb-bg,#fff);color:var(--lb-color,#111);text-align:center;font:inherit;" +
      "border:1px solid var(--lb-border,rgba(127,127,127,.3));" +
      "box-shadow:0 24px 70px -20px rgba(0,0,0,.5)}" +
    "@media (prefers-color-scheme:dark){.lobby-card{background:var(--lb-bg,#161c28);" +
      "color:var(--lb-color,#eee)}}" +
    "@media (prefers-reduced-motion:no-preference){" +
      ".lobby-card{animation:lobby-in .28s ease}" +
      "@keyframes lobby-in{from{opacity:0;transform:translateY(10px) scale(.98)}" +
        "to{opacity:1;transform:none}}}" +
    ".lobby-card img{max-width:230px;width:70%;height:auto;border-radius:14px}" +
    ".lobby-card h2{margin:10px 0 0;font-size:1.35em;letter-spacing:-.01em}" +
    ".lobby-build{margin:8px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "font-size:.72em;letter-spacing:.04em;color:var(--lb-muted,rgba(127,127,127,.9))}" +
    ".lobby-blurb{margin:14px 0 0;font-size:.94em;line-height:1.55;text-align:left;opacity:.9}" +
    ".lobby-blurb p{margin:0 0 10px}" +
    ".lobby-blurb p:last-child{margin-bottom:0}" +
    ".lobby-doors{display:flex;gap:10px;justify-content:center;align-items:center;" +
      "margin:20px 0 0;flex-wrap:wrap}" +
    ".lobby-doors .lobby-btn{padding:9px 16px;border-radius:10px;cursor:pointer;font:inherit;" +
      "font-weight:600;border:1px solid var(--lb-border,rgba(127,127,127,.35));" +
      "background:transparent;color:inherit}" +
    ".lobby-doors .lobby-primary{background:var(--lb-accent,#3b82f6);border-color:transparent;" +
      "color:var(--lb-accent-contrast,#fff)}" +
    ".lobby-doors .lobby-btn:hover{filter:brightness(1.08)}" +
    ".lobby-contact{margin:16px 0 0;font-size:.85em}" +
    ".lobby-contact a{color:var(--lb-muted,inherit);opacity:.75;text-decoration:underline}" +
    ".lobby-contact a:hover{opacity:1}";

  function injectCSS() {
    if (document.getElementById("lobby-css")) return;
    var style = document.createElement("style");
    style.id = "lobby-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  var gateEl = null;

  function close() {
    if (gateEl) { gateEl.remove(); gateEl = null; }
    document.removeEventListener("keydown", onEsc);
  }
  function leave(eventName) {
    markSeen();
    close();
    document.dispatchEvent(new CustomEvent(eventName));
  }
  function onEsc(e) { if (e.key === "Escape") leave("lobby:demo"); }

  function open() {
    if (gateEl) return;
    injectCSS();
    gateEl = document.createElement("div");
    gateEl.className = "lobby-gate";
    var card = document.createElement("div");
    card.className = "lobby-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", TITLE || IMAGE_ALT || "Welcome");

    if (IMAGE) {
      var img = document.createElement("img");
      img.src = IMAGE;
      img.alt = IMAGE_ALT;
      card.appendChild(img);
    }
    if (TITLE) {
      var h = document.createElement("h2");
      h.textContent = TITLE;
      card.appendChild(h);
    }
    if (BUILD) {
      var build = document.createElement("div");
      build.className = "lobby-build";
      build.textContent = BUILD;
      card.appendChild(build);
    }
    if (BLURB) {
      var blurb = document.createElement("div");
      blurb.className = "lobby-blurb";
      var paras = BLURB.split(/\n\s*\n/);
      for (var i = 0; i < paras.length; i++) {
        var p = document.createElement("p");
        p.textContent = paras[i];
        blurb.appendChild(p);
      }
      card.appendChild(blurb);
    }

    var doors = document.createElement("div");
    doors.className = "lobby-doors";
    var demoBtn = document.createElement("button");
    demoBtn.type = "button";
    demoBtn.className = "lobby-btn lobby-primary";
    demoBtn.textContent = DEMO_LABEL;
    demoBtn.addEventListener("click", function () { leave("lobby:demo"); });
    doors.appendChild(demoBtn);
    var loginBtn = document.createElement("button");
    loginBtn.type = "button";
    loginBtn.className = "lobby-btn";
    loginBtn.textContent = LOGIN_LABEL;
    loginBtn.addEventListener("click", function () { leave("lobby:login"); });
    doors.appendChild(loginBtn);
    card.appendChild(doors);

    if (CONTACT_URL) {
      var contact = document.createElement("p");
      contact.className = "lobby-contact";
      var a = document.createElement("a");
      a.href = CONTACT_URL;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = CONTACT_LABEL;
      a.addEventListener("click", markSeen);
      contact.appendChild(a);
      card.appendChild(contact);
    }

    gateEl.appendChild(card);
    gateEl.addEventListener("click", function (e) {
      if (e.target === gateEl) leave("lobby:demo");
    });
    document.addEventListener("keydown", onEsc);
    document.body.appendChild(gateEl);
    demoBtn.focus();
  }

  function boot() {
    if (AUTO && !seen()) open();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.lobby = { open: open, close: close, seen: seen };
})();
