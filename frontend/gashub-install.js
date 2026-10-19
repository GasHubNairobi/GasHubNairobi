/* Install GasHub on the phone ("Add to Home Screen").

   - Android / Chrome / Edge / desktop: when the browser says GasHub can be installed, a small card slides up with an Install button.
   - iPhone (Safari): the browser has no install button, so the card shows the two steps (Share, then Add to Home Screen).
   - Never shown inside the installed app, never right after the person closes it (it stays away for 14 days), never on the
     checkout / login / payment pages where it would get in the way.

   It also makes sure the page links the install manifest and that the service worker is registered, because the browser needs
   both before it will offer installation. (The service worker stores no pages, so the site is always fresh.)

   Include on the pages where the card may appear:   <script src="/gashub-install.js" defer></script> */
(function () {
    "use strict";
    if (window.__ghInstall) return;
    window.__ghInstall = true;

    var HIDE_KEY = "gashub_install_hidden_until";
    var HIDE_DAYS = 14;
    var isDealer = location.pathname.indexOf("/dealer/") === 0 || /(^|\/)dealer-/.test(location.pathname);
    var NAME = isDealer ? "GasHub Dealer" : "GasHub";

    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
    function standalone() {
        try {
            return window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: fullscreen)").matches || window.navigator.standalone === true;
        } catch (e) { return false; }
    }
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    var iosSafari = ios && /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent);

    if (standalone()) return;                                   /* already installed */
    if (Number(get(HIDE_KEY)) > Date.now()) return;           /* closed recently */

    /* ---- the browser needs a manifest link and a service worker before it will offer installation ---- */
    function ensureInstallable() {
        if (!document.querySelector('link[rel="manifest"]')) {
            var l = document.createElement("link");
            l.rel = "manifest";
            l.href = isDealer ? "/manifest-dealer.webmanifest" : "/manifest.webmanifest";
            document.head.appendChild(l);
        }
        if (!document.querySelector('link[rel="apple-touch-icon"]')) {
            var a = document.createElement("link");
            a.rel = "apple-touch-icon";
            a.href = "/Images/icons/icon-192.png";
            document.head.appendChild(a);
        }
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () { /* not allowed here: fine */ });
        }
    }

    /* pages where the card must not appear: the person is in the middle of something important */
    function allowedHere() {
        return !/(checkout|login|register|payment|pay|track|application|privacy|terms|refund|delivery)/i.test(location.pathname);
    }

    var deferred = null, card = null;

    function style() {
        if (document.getElementById("gh-install-style")) return;
        var s = document.createElement("style");
        s.id = "gh-install-style";
        s.textContent =
            ".gh-install{position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 78px);z-index:2147482000;max-width:460px;margin:0 auto;" +
            "background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.22);padding:14px 14px 14px 16px;" +
            "display:flex;align-items:center;gap:12px;font:500 14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
            "transform:translateY(140%);opacity:0;transition:transform .3s ease,opacity .3s ease}" +
            ".gh-install.gh-show{transform:translateY(0);opacity:1}" +
            ".gh-install img{width:44px;height:44px;border-radius:11px;flex:none}" +
            ".gh-install .gh-i-text{flex:1;min-width:0}" +
            ".gh-install strong{display:block;font-size:15px;margin-bottom:2px}" +
            ".gh-install span.gh-i-sub{color:#475569;font-size:13px}" +
            ".gh-install button{font:inherit;border:0;cursor:pointer;border-radius:10px}" +
            ".gh-install .gh-i-go{background:#1f4fd8;color:#fff;font-weight:700;padding:10px 16px;flex:none}" +
            ".gh-install .gh-i-x{background:transparent;color:#64748b;font-size:22px;line-height:1;padding:4px 8px;flex:none}" +
            "@media (prefers-reduced-motion:reduce){.gh-install{transition:none}}" +
            "@media print{.gh-install{display:none!important}}";
        document.head.appendChild(s);
    }

    function hide(forDays) {
        if (card) card.classList.remove("gh-show");
        if (forDays) set(HIDE_KEY, String(Date.now() + forDays * 86400000));
        setTimeout(function () { if (card && card.parentNode) card.parentNode.removeChild(card); card = null; }, 350);
    }

    function show(mode) {
        if (card || !document.body || !allowedHere()) return;
        style();
        card = document.createElement("div");
        card.className = "gh-install";
        card.setAttribute("role", "dialog");
        card.setAttribute("aria-label", "Install " + NAME);
        var sub = mode === "ios"
            ? "Tap the Share button, then \u201CAdd to Home Screen\u201D."
            : "Order gas faster from your home screen.";
        card.innerHTML =
            '<img src="/Images/icons/icon-192.png" alt="" width="44" height="44">' +
            '<div class="gh-i-text"><strong>Install ' + NAME + '</strong><span class="gh-i-sub">' + sub + "</span></div>" +
            (mode === "ios" ? "" : '<button type="button" class="gh-i-go">Install</button>') +
            '<button type="button" class="gh-i-x" aria-label="Not now">\u00D7</button>';
        document.body.appendChild(card);
        void card.offsetHeight;
        card.classList.add("gh-show");

        var go = card.querySelector(".gh-i-go");
        if (go) go.addEventListener("click", function () {
            if (!deferred) return hide(HIDE_DAYS);
            var ev = deferred; deferred = null;
            try {
                ev.prompt();
                ev.userChoice.then(function (c) { hide(c && c.outcome === "accepted" ? 365 : HIDE_DAYS); }).catch(function () { hide(HIDE_DAYS); });
            } catch (e) { hide(HIDE_DAYS); }
        });
        card.querySelector(".gh-i-x").addEventListener("click", function () { hide(HIDE_DAYS); });
    }

    function whenReady(fn) {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn); else fn();
    }

    ensureInstallable();

    /* Chrome / Edge / Android: the browser tells us when GasHub can be installed */
    window.addEventListener("beforeinstallprompt", function (e) {
        e.preventDefault();
        deferred = e;
        whenReady(function () { setTimeout(function () { if (deferred) show("prompt"); }, 6000); });
    });
    window.addEventListener("appinstalled", function () { deferred = null; set(HIDE_KEY, String(Date.now() + 365 * 86400000)); hide(0); });

    /* iPhone Safari: no install event exists, so explain the steps once in a while */
    if (iosSafari) whenReady(function () { setTimeout(function () { show("ios"); }, 12000); });
})();
