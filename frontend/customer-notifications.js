/* Customer notifications - loaded on the signed-in customer pages.
   Checks GET /api/my/notifications every 20 seconds and shows a tappable notification for:
     - "Your order is confirmed"  (the dealer confirmed it)   -> opens that order's checkout so the customer can pay
     - "<Dealer> replied"          (new chat message)          -> opens that exact conversation with that dealer
   Each notification shows once (remembered in this browser); a new dealer reply shows again. Silent if signed out. */
(function () {
    "use strict";
    if (window.__gasHubNotifier) return;
    window.__gasHubNotifier = true;

    var SEEN = "gasHubNotifSeen", EVERY = 20000, timer = null, stopped = false, first = true;
    var esc = function (v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
    var money = function (n) { return "KSh " + (Number(n) || 0).toLocaleString("en-KE"); };
    function seen() { try { return JSON.parse(localStorage.getItem(SEEN) || "{}"); } catch (e) { return {}; } }
    function remember(k) {
        var m = seen(); m[k] = Date.now();
        var keys = Object.keys(m); if (keys.length > 200) { keys.sort(function (a, b) { return m[a] - m[b]; }).slice(0, keys.length - 200).forEach(function (x) { delete m[x]; }); }
        try { localStorage.setItem(SEEN, JSON.stringify(m)); } catch (e) { }
    }
    function payPopupDone(orderNo) { try { return (JSON.parse(localStorage.getItem("gasHubPayPopupShown") || "[]")).indexOf(orderNo) !== -1; } catch (e) { return false; } }
    function signedInHint() { try { var f = localStorage.getItem("gasHubLoggedIn"); return !!f && f !== "false" && f !== "0"; } catch (e) { return true; } }

    function css() {
        if (document.getElementById("ghNotifCss")) return;
        var s = document.createElement("style"); s.id = "ghNotifCss";
        s.textContent =
            "#ghNotifStack{position:fixed;right:12px;bottom:76px;z-index:99998;display:flex;flex-direction:column;gap:8px;width:calc(100vw - 24px);max-width:360px;pointer-events:none}" +
            ".ghn{position:relative;pointer-events:auto;display:flex;gap:10px;align-items:center;background:#fff;color:#0f172a;text-decoration:none;border:1px solid #bfdbfe;border-left:4px solid #1d7af3;border-radius:12px;padding:10px 32px 10px 10px;box-shadow:0 10px 30px rgba(15,23,42,.22);font:13px/1.35 system-ui,sans-serif;animation:ghnIn .25s ease-out}" +
            ".ghn.order{border-color:#fde68a;border-left-color:#f5b301}" +
            ".ghn img{width:44px;height:44px;object-fit:cover;border-radius:8px;flex:none}" +
            ".ghn .ic{width:44px;height:44px;border-radius:10px;background:#fff7d6;color:#b45309;display:flex;align-items:center;justify-content:center;font-size:22px;flex:none}" +
            ".ghn .tx{min-width:0}.ghn strong{display:block}.ghn .sub{display:block;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
            ".ghn .go{font-size:11px;color:#1d7af3;font-weight:700}.ghn.order .go{color:#b45309}" +
            ".ghn button{position:absolute;top:3px;right:6px;border:0;background:none;font-size:18px;line-height:1;color:#64748b;cursor:pointer}" +
            "@keyframes ghnIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}";
        document.head.appendChild(css.s = s);
    }
    function stack() {
        var st = document.getElementById("ghNotifStack");
        if (!st) { css(); st = document.createElement("div"); st.id = "ghNotifStack"; st.setAttribute("aria-live", "polite"); document.body.appendChild(st); }
        return st;
    }
    function push(key, href, html, cls) {
        var st = stack();
        while (st.children.length >= 3) st.removeChild(st.firstChild);
        var el = document.createElement("a");
        el.className = "ghn " + (cls || ""); el.href = href; el.setAttribute("role", "status");
        el.innerHTML = html + '<button type="button" aria-label="Dismiss">&times;</button>';
        el.querySelector("button").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); el.remove(); });
        el.addEventListener("click", function () { remember(key); });
        st.appendChild(el);
        setTimeout(function () { if (el.parentNode) el.remove(); }, 30000);
        try { if (navigator.vibrate) navigator.vibrate(120); } catch (e) { }
    }

    /* the exact chat: the product's page opens with that dealer's conversation ready; no product -> the dealer's page */
    function chatHref(m) {
        return m.product_id
            ? "customer-product.html?id=" + encodeURIComponent(m.product_id) + "&chat=1"
            : "customer-dealer.html?id=" + encodeURIComponent(m.dealer_id) + "&chat=1";
    }
    function checkoutHref(no) { return "customer-checkout.html?orderId=" + encodeURIComponent(no) + "&pay=1"; }

    async function check() {
        if (stopped || document.hidden || !signedInHint()) return;
        try {
            var r = await fetch("/api/my/notifications", { credentials: "same-origin", cache: "no-store" });
            if (r.status === 401) { stopped = true; clearInterval(timer); return; }
            if (!r.ok) return;
            var j = await r.json(); if (!j.success) return;
            var done = seen(), here = location.search;
            (j.orders || []).forEach(function (o) {
                if (done[o.key]) return;
                if (document.getElementById("ghPayPopup") || payPopupDone(o.order_number)) { remember(o.key); return; }   /* the pay pop-up already told them */
                if (here.indexOf(encodeURIComponent(o.order_number)) !== -1 && /customer-checkout/.test(location.pathname)) { remember(o.key); return; }
                push(o.key, checkoutHref(o.order_number),
                    '<div class="ic">&#9989;</div><div class="tx"><strong>Order ' + esc(o.order_number) + ' confirmed</strong>' +
                    '<span class="sub">' + esc(o.dealer_name) + ' accepted it. Total ' + esc(money(o.due)) + '</span><span class="go">Tap to pay &rarr;</span></div>', "order");
            });
            if (!document.querySelector(".chat-box")) {          /* already chatting: that chat updates itself */
                (j.messages || []).forEach(function (m) {
                    if (done[m.key]) return;
                    push(m.key, chatHref(m),
                        (m.product_image ? '<img src="' + esc(m.product_image) + '" alt="">' : '<div class="ic" style="background:#e0efff;color:#1d7af3">&#128172;</div>') +
                        '<div class="tx"><strong>' + esc(m.dealer_name) + ' replied' + (m.unread > 1 ? " (" + m.unread + ")" : "") + '</strong>' +
                        (m.product_name ? '<span class="sub" style="color:#1d7af3">About: ' + esc(m.product_name) + '</span>' : '') +
                        '<span class="sub">' + esc(m.last_text) + '</span><span class="go">Tap to open the chat &rarr;</span></div>');
                });
            }
        } catch (e) { /* try again next time */ }
    }

    function start() {
        /* wait a few seconds the first time so the pay pop-up (customer-pay-prompt.js) can show first and not be doubled */
        setTimeout(function () { check(); timer = setInterval(check, EVERY); }, 4000);
        document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
