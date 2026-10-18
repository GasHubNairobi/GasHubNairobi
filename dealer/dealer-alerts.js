/* Dealer alerts - loaded on every dealer page.
   1) Keeps the sidebar badges and the bell showing the REAL numbers (from GET /api/dealers/alerts):
        Orders badge   = orders waiting for the dealer to confirm (status "pending")
        Messages badge = conversations where the customer wrote last and the dealer has not replied
   2) Every minute, while something is still unattended, shows a reminder you can tap to go straight to it
      (and a phone/desktop notification if the dealer allowed them).
   Refresh by hand after you change an order or reply:  window.GasHubDealerAlerts.refresh() */
(function () {
    "use strict";
    if (window.GasHubDealerAlerts) return;

    var EVERY_MS = 60 * 1000;
    var token = function () { return localStorage.getItem("gashub_dealer_token") || localStorage.getItem("dealerToken") || ""; };
    var page = (location.pathname.split("/").pop() || "").toLowerCase();
    var onOrders = page === "dealer-orders.html" || page === "dealer-order-details.html";
    var onMessages = page.indexOf("dealer-messages") === 0;
    var lastToast = 0, timer = null, stopped = false, state = { orders: 0, messages: 0, oldest: null };

    function $(id) { return document.getElementById(id); }
    function setBadge(el, n) {
        if (!el) return;
        el.textContent = String(n);
        el.hidden = n <= 0;
        el.style.display = n <= 0 ? "none" : "";
    }
    function paintBadges() {
        setBadge($("sidebarOrdersBadge"), state.orders);
        setBadge($("sidebarMessagesBadge"), state.messages);
        var low = $("sidebarLowStockBadge");
        var lowN = low && !low.hidden ? (parseInt(low.textContent, 10) || 0) : 0;
        setBadge($("notificationBadge"), state.orders + state.messages + lowN);
        /* the "pending" counters on the pages themselves */
        document.querySelectorAll("[data-live-pending-orders]").forEach(function (e) { e.textContent = String(state.orders); });
        document.querySelectorAll("[data-live-unreplied-messages]").forEach(function (e) { e.textContent = String(state.messages); });
    }

    /* ---------- the reminder ---------- */
    function css() {
        if ($("ghAlertCss")) return;
        var s = document.createElement("style"); s.id = "ghAlertCss";
        s.textContent =
            ".gha{position:fixed;right:16px;top:16px;z-index:99999;width:calc(100vw - 32px);max-width:360px;background:#fff;color:#0f172a;border:1px solid #fde68a;border-left:5px solid #f59e0b;border-radius:12px;box-shadow:0 12px 34px rgba(15,23,42,.25);font:13px/1.4 system-ui,sans-serif;padding:12px 34px 12px 14px}" +
            ".gha strong{display:block;font-size:14px;margin-bottom:4px}" +
            ".gha a.gha-row{display:flex;gap:8px;align-items:center;justify-content:space-between;text-decoration:none;color:#0f172a;padding:7px 9px;margin-top:6px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a}" +
            ".gha a.gha-row.msg{background:#eff6ff;border-color:#bfdbfe}" +
            ".gha a.gha-row b{background:#dc2626;color:#fff;border-radius:999px;padding:1px 8px;font-size:12px}" +
            ".gha-x{position:absolute;top:6px;right:8px;border:0;background:none;font-size:20px;line-height:1;color:#64748b;cursor:pointer}" +
            ".gha-en{margin-top:8px;border:0;background:none;color:#2563eb;font-size:12px;cursor:pointer;padding:0;text-decoration:underline}";
        document.head.appendChild(s);
    }
    function waited(iso) {
        if (!iso) return "";
        var m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
        if (m < 1) return "just now";
        if (m < 60) return m + " min";
        var h = Math.floor(m / 60);
        return h < 24 ? h + " hr" : Math.floor(h / 24) + " day" + (h >= 48 ? "s" : "");
    }
    function beep() {
        try {
            var C = window.AudioContext || window.webkitAudioContext; if (!C) return;
            var c = new C(), o = c.createOscillator(), g = c.createGain();
            o.frequency.value = 880; g.gain.value = 0.06; o.connect(g); g.connect(c.destination);
            o.start(); setTimeout(function () { o.stop(); c.close(); }, 180);
        } catch (e) { }
    }
    function toast() {
        var showOrders = state.orders > 0;
        var showMsgs = state.messages > 0 && !onMessages;
        var old = $("ghAlertToast"); if (old) old.remove();
        if (!showOrders && !showMsgs) return;
        css();
        var el = document.createElement("div");
        el.id = "ghAlertToast"; el.className = "gha"; el.setAttribute("role", "status");
        var html = "<strong>Needs your attention</strong>";
        if (showOrders) html += '<a class="gha-row" href="dealer-orders.html"><span>' + state.orders + " order" + (state.orders === 1 ? "" : "s") + " waiting for you" + (state.oldest ? " · oldest " + waited(state.oldest) : "") + "</span><b>" + state.orders + "</b></a>";
        if (showMsgs) html += '<a class="gha-row msg" href="dealer-messages.html"><span>' + state.messages + " customer" + (state.messages === 1 ? "" : "s") + " waiting for a reply</span><b>" + state.messages + "</b></a>";
        if ("Notification" in window && Notification.permission === "default") html += '<button type="button" class="gha-en">Also alert me when this tab is in the background</button>';
        html += '<button type="button" class="gha-x" aria-label="Dismiss">&times;</button>';
        el.innerHTML = html;
        el.querySelector(".gha-x").addEventListener("click", function () { el.remove(); });
        var en = el.querySelector(".gha-en");
        if (en) en.addEventListener("click", function () { try { Notification.requestPermission(); } catch (e) { } en.remove(); });
        document.body.appendChild(el);
        setTimeout(function () { if (el.parentNode) el.remove(); }, 20000);
        beep();
    }
    function systemNotice() {
        try {
            if (!("Notification" in window) || Notification.permission !== "granted") return;
            var parts = [];
            if (state.orders) parts.push(state.orders + " order" + (state.orders === 1 ? "" : "s") + " waiting");
            if (state.messages) parts.push(state.messages + " unanswered message" + (state.messages === 1 ? "" : "s"));
            var n = new Notification("GasHub: needs your attention", { body: parts.join(" · "), tag: "gashub-dealer-alert" });
            n.onclick = function () { window.focus(); location.href = state.orders ? "dealer-orders.html" : "dealer-messages.html"; n.close(); };
        } catch (e) { }
    }

    /* ---------- polling ---------- */
    async function refresh(remind) {
        if (stopped || !token()) return;
        try {
            var r = await fetch("/api/dealers/alerts", { cache: "no-store", headers: { Accept: "application/json", Authorization: "Bearer " + token() } });
            if (r.status === 401 || r.status === 403) { stopped = true; clearInterval(timer); return; }
            if (!r.ok) return;
            var j = await r.json();
            if (!j.success) return;
            state = { orders: j.pending_orders || 0, messages: j.unreplied_messages || 0, oldest: j.oldest_pending_at || null };
            paintBadges();
            if (remind && (state.orders || state.messages) && Date.now() - lastToast >= EVERY_MS - 2000) {
                lastToast = Date.now();
                if (document.hidden) systemNotice(); else toast();
            } else if (!state.orders && !state.messages) { var t = $("ghAlertToast"); if (t) t.remove(); }
        } catch (e) { /* try again next minute */ }
    }

    window.GasHubDealerAlerts = { refresh: function () { return refresh(false); }, state: function () { return state; } };

    function start() {
        refresh(true);
        timer = setInterval(function () { refresh(true); }, EVERY_MS);
        document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(false); });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
