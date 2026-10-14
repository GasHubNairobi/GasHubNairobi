/* "Your order is confirmed - pay now" pop-up.
   1) On the other customer pages (home, shop, profile ...): when an order has been confirmed by the dealer and is not paid yet,
      a pop-up shows ONCE for that order (remembered in this browser). It has a Pay now button and a Close button.
   2) On the order page (customer-orders.js) the same pop-up shows EVERY time the customer opens that order while it is
      still unpaid. After closing it, the Checkout card on the order page has a "Pay now" button.
   Pay now opens that order's checkout: customer-checkout.html?orderId=<order number>&pay=1
   Pages that must not auto-prompt (the order page, which calls GasHubPayPopup itself) set <body data-no-pay-prompt>. */
(function () {
    "use strict";
    var KEY = "gasHubPayPopupShown";
    function read() {
        try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { }
        try { return JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch (e) { return []; }
    }
    function remember(id) {
        var l = read(); if (l.indexOf(id) === -1) l.push(id); l = l.slice(-100);
        try { localStorage.setItem(KEY, JSON.stringify(l)); return; } catch (e) { }
        try { sessionStorage.setItem(KEY, JSON.stringify(l)); } catch (e) { }
    }
    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function money(n) { return "KSh " + (Number(n) || 0).toLocaleString("en-KE"); }
    function checkoutUrl(orderId) { return "customer-checkout.html?orderId=" + encodeURIComponent(orderId) + "&pay=1"; }

    function css() {
        if (document.getElementById("ghPayPopupCss")) return;
        var s = document.createElement("style"); s.id = "ghPayPopupCss";
        s.textContent =
            ".ghpp{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.55)}" +
            ".ghpp-box{position:relative;width:100%;max-width:380px;background:#fff;color:#1f2937;border-radius:16px;padding:22px 20px 18px;box-shadow:0 20px 50px rgba(0,0,0,.3);font-family:inherit}" +
            ".ghpp-x{position:absolute;top:8px;right:10px;border:0;background:none;font-size:26px;line-height:1;color:#6b7280;cursor:pointer;padding:4px 8px}" +
            ".ghpp-box h3{margin:0 24px 6px 0;font-size:18px}" +
            ".ghpp-box p{margin:0 0 6px;font-size:14px;line-height:1.45}" +
            ".ghpp-amt{display:flex;justify-content:space-between;align-items:center;margin:12px 0;padding:10px 12px;border-radius:10px;background:#f3f4f6;font-size:14px}" +
            ".ghpp-amt b{font-size:17px}" +
            ".ghpp-btns{display:flex;gap:8px;margin-top:14px}" +
            ".ghpp-btns a,.ghpp-btns button{flex:1;min-height:44px;border-radius:10px;font:inherit;font-weight:700;font-size:14px;cursor:pointer;text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center}" +
            ".ghpp-pay{background:#f5b301;color:#1b1b1b;border:0}" +
            ".ghpp-close{background:#fff;color:#374151;border:1px solid #d1d5db}";
        document.head.appendChild(s);
    }

    /* Does this order still need the customer to pay? Uses the FULL order from the server (it includes the payments),
       so a paid order, a payment code that is waiting for GasHub to confirm, a cash order or a cancelled order never gets the pop-up. */
    var PAID = /^(paid|complete|success)/i;
    function needsPayment(x) {
        if (!x) return false;
        var st = String(x.status || "").toLowerCase();
        if (["cancelled", "rejected", "delivered", "completed", "out_for_delivery"].indexOf(st) !== -1) return false;
        if (PAID.test(String(x.paymentStatus || ""))) return false;
        if (!x.canPay) return false;
        var chosen = x.paymentMethodChosen !== false;
        if (chosen && /cash/i.test(String(x.paymentMethod))) return false;
        var pays = Array.isArray(x.payments) ? x.payments : [];
        if (pays.some(function (p) { return PAID.test(String(p.status || "")) || (/pending/i.test(String(p.status || "")) && p.code); })) return false;
        var due = (Number(x.total) || 0) - (Number(x.amountPaid) || 0);
        return due > 0;
    }
    function fetchOrder(ref) {
        return fetch("/api/my/orders/" + encodeURIComponent(ref), { credentials: "same-origin", cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { return j ? (j.order || j.data || j) : null; })
            .catch(function () { return null; });
    }
    function hide() { var w = document.getElementById("ghPayPopup"); if (w && w.parentNode) w.parentNode.removeChild(w); }

    /* ref = order number. Looks the order up again, and only opens the pop-up if it still has to be paid.
       Resolves true if the pop-up was shown. */
    function show(ref) {
        if (!ref || document.getElementById("ghPayPopup")) return Promise.resolve(false);
        return fetchOrder(ref).then(function (o) {
            if (!needsPayment(o) || document.getElementById("ghPayPopup")) return false;
            open({ orderId: o.orderId || ref, total: (Number(o.total) || 0) - (Number(o.amountPaid) || 0), dealerName: o.dealerName });
            return true;
        });
    }

    function open(o) {
        css();
        var wrap = document.createElement("div");
        wrap.className = "ghpp"; wrap.id = "ghPayPopup"; wrap.setAttribute("data-order", o.orderId);
        wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-modal", "true"); wrap.setAttribute("aria-labelledby", "ghppTitle");
        wrap.innerHTML =
            '<div class="ghpp-box"><button type="button" class="ghpp-x" aria-label="Close">&times;</button>' +
            '<h3 id="ghppTitle">Your order is confirmed</h3>' +
            '<p>' + esc(o.dealerName || "Your dealer") + ' confirmed order <b>' + esc(o.orderId) + '</b>. Pay now so it can be sent out.</p>' +
            '<div class="ghpp-amt"><span>Total to pay</span><b>' + esc(money(o.total)) + '</b></div>' +
            '<div class="ghpp-btns"><button type="button" class="ghpp-close">Close</button><a class="ghpp-pay" href="' + esc(checkoutUrl(o.orderId)) + '">Pay now</a></div></div>';
        function close() { hide(); document.removeEventListener("keydown", onKey); }
        function onKey(e) { if (e.key === "Escape") close(); }
        wrap.querySelector(".ghpp-x").addEventListener("click", close);
        wrap.querySelector(".ghpp-close").addEventListener("click", close);
        wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
        document.addEventListener("keydown", onKey);
        document.body.appendChild(wrap);
        try { wrap.querySelector(".ghpp-pay").focus(); } catch (e) { }
    }

    /* the pop-up is open but the order got paid (or the customer comes back to a cached page): take it away */
    function recheck() {
        var w = document.getElementById("ghPayPopup"); if (!w) return;
        fetchOrder(w.getAttribute("data-order")).then(function (o) { if (o && !needsPayment(o)) hide(); });
    }
    window.addEventListener("pageshow", function (e) { if (e.persisted) recheck(); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) recheck(); });

    window.GasHubPayPopup = { show: show, hide: hide, needsPayment: needsPayment, checkoutUrl: checkoutUrl };

    /* automatic, once-per-order prompt on the other pages */
    if (document.body && document.body.hasAttribute("data-no-pay-prompt")) return;
    var signedIn = true;
    try { var f = localStorage.getItem("gasHubLoggedIn"); signedIn = !!f && f !== "false" && f !== "0"; } catch (e) { }
    if (!signedIn) return;                      /* not signed in: the server would only answer 401 */
    fetch("/api/my/orders", { credentials: "same-origin", cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
            var list = (j && j.orders) || [], done = read();
            var o = list.filter(function (x) { return needsPayment(x) && done.indexOf(x.orderId) === -1; })[0];
            if (!o) return;
            show(o.orderId).then(function (shown) { if (shown) remember(o.orderId); });
        }).catch(function () { });
})();
