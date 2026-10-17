/* GasHub CUSTOMER loading screen.
   Add this as the FIRST script in the <head> of every customer page:

       <script src="customer-loader.js"></script>

   The message changes by itself depending on the page being opened
   (home, products, checkout, payment, orders, tracking, profile ...),
   and when a customer taps a link it shows the message of the page they are going to.

   Options on the script tag (all optional):
       data-manual          keep the loader until you call CustomerLoader.hide()
       data-min="800"       minimum time on screen in ms
       data-logo="..."      logo path (default: Images/logo.png next to this script)
       data-message="..."   force a title for this page
       data-note="..."      force the small line under the title

   Use it in your own code, for example around a payment request:

       CustomerLoader.show("Processing your payment...", "Please don't close or refresh this page");
       ... await fetch(...) ...
       CustomerLoader.hide();

   CustomerLoader.setMessage(title, note) changes the text while it is showing. */
(function () {
    "use strict";
    if (window.CustomerLoader) return;

    var cs = document.currentScript;
    var manual = !!(cs && cs.hasAttribute("data-manual"));
    var minMs = Number(cs && cs.getAttribute("data-min")) || 150;
    var MAX_MS = 2500;   /* never block a page longer than this */
    var PAY_MAX_MS = 45000; /* payments are allowed to take longer */
    var logo = cs && cs.getAttribute("data-logo");
    if (!logo) { try { logo = new URL("Images/logo.png", cs.src).href; } catch (e) { logo = "Images/logo.png"; } }

    /* ---------- what to say for each page (first match wins, so keep specific ones first) ---------- */
    var NOTE_PAY = "Please don't close or refresh this page";
    var MESSAGES = [
        [/(payment|mpesa|m-pesa|pay-|-pay|paybill|stk)/i, "Processing your payment...", NOTE_PAY, true],
        [/(checkout|cart)/i, "Preparing your checkout...", "Getting your order details ready"],
        [/(track)/i, "Tracking your order...", "Getting the latest delivery update"],
        [/(order)/i, "Loading your orders...", "Fetching your order history"],
        [/(dealer-profile|dealer-details|dealer-detail)/i, "Loading dealer details...", "Getting products and reviews"],
        [/(dealer)/i, "Finding dealers near you...", "Checking who delivers to your location"],
        [/(product|shop|gas|cylinder)/i, "Finding gas near you...", "Comparing prices, dealers and delivery time"],
        [/(profile|account|settings)/i, "Loading your profile...", "Getting your account details"],
        [/(login|signin|sign-in)/i, "Getting things ready...", "Taking you to sign in"],
        [/(register|signup|sign-up)/i, "Setting up your account...", "Just a moment"],
        [/(about)/i, "Loading...", "Getting to know GasHub"],
        [/(home|index)/i, "Finding gas near you...", "Loading products and dealers"]
    ];
    function messageFor(path) {
        var name = String(path || "").split("?")[0].split("#")[0].split("/").pop() || "index";
        for (var i = 0; i < MESSAGES.length; i++) {
            if (MESSAGES[i][0].test(name)) return { title: MESSAGES[i][1], note: MESSAGES[i][2], pay: !!MESSAGES[i][3] };
        }
        return { title: "Loading...", note: "Just a moment", pay: false };
    }

    var here = messageFor(location.pathname);
    var title0 = (cs && cs.getAttribute("data-message")) || here.title;
    var note0 = (cs && cs.getAttribute("data-note")) || here.note;

    /* ---------- styles ---------- */
    var root = document.documentElement;
    var css =
        "html.cl-loading{overflow:hidden!important}" +
        ".cl-loader{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;" +
        "background:radial-gradient(circle at 50% 38%,#fff 0%,#eaf0ff 70%,#dbe5ff 100%);transition:opacity .2s ease,visibility .2s ease;" +
        "font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}" +
        ".cl-loader.done{opacity:0;visibility:hidden;pointer-events:none}" +
        ".cl-in{display:flex;flex-direction:column;align-items:center;padding:24px;text-align:center;max-width:320px}" +
        ".cl-logo{position:relative;width:132px;height:132px;display:flex;align-items:center;justify-content:center}" +
        ".cl-logo img{position:relative;z-index:1;width:84px;height:auto;max-height:84px;object-fit:contain;opacity:0;transition:opacity .15s ease;animation:clPulse 1.8s ease-in-out infinite}.cl-logo img.ok{opacity:1}" +
        ".cl-logo b{position:relative;z-index:1;font-size:22px;font-weight:800;color:#0f2a7a}" +
        ".cl-ring{position:absolute;inset:0;border-radius:50%;border:4px solid rgba(31,79,216,.14);border-top-color:#1f4fd8;border-right-color:#ffc20e;animation:clSpin 1.1s linear infinite}" +
        ".cl-bar{width:170px;height:5px;margin-top:26px;border-radius:3px;background:rgba(31,79,216,.14);overflow:hidden}" +
        ".cl-bar i{display:block;width:45%;height:100%;border-radius:3px;background:linear-gradient(90deg,#1f4fd8,#ffc20e);animation:clSlide 1.3s ease-in-out infinite}" +
        ".cl-dots{display:flex;gap:7px;margin-top:16px}" +
        ".cl-dots i{width:8px;height:8px;border-radius:50%;background:#1f4fd8;animation:clBounce 1s ease-in-out infinite}" +
        ".cl-dots i:nth-child(2){background:#ffc20e;animation-delay:.15s}" +
        ".cl-dots i:nth-child(3){background:#e03131;animation-delay:.3s}" +
        ".cl-title{margin:14px 0 0;font-size:15px;font-weight:700;color:#0f2a7a;line-height:1.3}" +
        ".cl-note{margin:4px 0 0;font-size:12px;color:#5f6783;line-height:1.4}" +
        ".cl-loader.pay .cl-note{color:#b02323;font-weight:600}" +
        "@keyframes clSpin{to{transform:rotate(360deg)}}" +
        "@keyframes clPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}" +
        "@keyframes clSlide{0%{transform:translateX(-110%)}100%{transform:translateX(260%)}}" +
        "@keyframes clBounce{0%,80%,100%{transform:translateY(0);opacity:.45}40%{transform:translateY(-8px);opacity:1}}" +
        "@media (prefers-reduced-motion:reduce){.cl-ring,.cl-logo img,.cl-bar i,.cl-dots i{animation:none!important}.cl-bar i{width:100%}}";

    var style = document.createElement("style");
    style.id = "customerLoaderStyle";
    style.textContent = css;

    var el = document.createElement("div");
    el.id = "customerLoader";
    el.className = "cl-loader";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.innerHTML =
        '<div class="cl-in"><div class="cl-logo"><span class="cl-ring"></span><img alt="GasHub"><b hidden>GasHub</b></div>' +
        '<div class="cl-bar" aria-hidden="true"><i></i></div>' +
        '<div class="cl-dots" aria-hidden="true"><i></i><i></i><i></i></div>' +
        '<p class="cl-title"></p><p class="cl-note"></p></div>';
    var img = el.querySelector("img"), fallback = el.querySelector("b");
    var titleEl = el.querySelector(".cl-title"), noteEl = el.querySelector(".cl-note");
    img.onerror = function () { img.hidden = true; fallback.hidden = false; };
    img.onload = function () { img.classList.add("ok"); };
    img.src = logo;

    function setMessage(title, note, pay) {
        titleEl.textContent = title || "Loading...";
        noteEl.textContent = note || "";
        noteEl.hidden = !note;
        el.classList.toggle("pay", !!pay);
    }

    var shownAt = Date.now(), maxTimer = null, hideTimer = null;

    function mount() {
        (document.head || root).appendChild(style);
        root.appendChild(el);
        root.classList.add("cl-loading");
    }
    function hideNow() {
        clearTimeout(maxTimer);
        el.classList.add("done");
        root.classList.remove("cl-loading");
    }
    /* show(title, note): both optional. With no text it keeps the current message. */
    function show(title, note) {
        clearTimeout(hideTimer);
        shownAt = Date.now();
        var pay = false;
        if (title) { pay = /pay/i.test(title); setMessage(title, note, pay); }
        if (!el.parentNode) mount();
        el.classList.remove("done");
        root.classList.add("cl-loading");
        clearTimeout(maxTimer);
        maxTimer = setTimeout(hideNow, pay ? PAY_MAX_MS : MAX_MS);
    }
    function hide() {
        clearTimeout(hideTimer);
        var wait = Math.max(0, minMs - (Date.now() - shownAt));
        hideTimer = setTimeout(hideNow, wait);
    }

    /* show immediately, before the page has even drawn */
    setMessage(title0, note0, here.pay);
    mount();
    maxTimer = setTimeout(hideNow, here.pay ? PAY_MAX_MS : MAX_MS);

    window.CustomerLoader = { show: show, hide: hide, setMessage: setMessage };

    /* automatic mode: hide as soon as the page itself is ready - not after every image and font has downloaded */
    if (!manual) {
        if (document.readyState !== "loading") hide();
        else document.addEventListener("DOMContentLoaded", hide);
    }

    /* back/forward cache: never show a stuck loader on a restored page */
    window.addEventListener("pageshow", function (e) { if (e.persisted) hideNow(); });

    /* tapping an internal link shows the message of the page the customer is going to */
    document.addEventListener("click", function (e) {
        if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var a = e.target.closest && e.target.closest("a[href]");
        if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
        var h = a.getAttribute("href");
        if (!h || h.charAt(0) === "#" || /^(mailto:|tel:|javascript:)/i.test(h)) return;
        if (a.origin !== location.origin) return;
        if (a.pathname === location.pathname && a.search === location.search && a.hash) return;
        var m = messageFor(a.pathname);
        show(m.title, m.note);
        el.classList.toggle("pay", m.pay);
    });
})();