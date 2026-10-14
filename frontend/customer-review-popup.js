/* GasHub dealer review popup.
   Add to any customer page (just before </body>):

       <script src="customer-review-popup.js" defer></script>

   When the dealer marks the customer's order as COMPLETED, this popup opens on top of
   whatever page the customer is looking at and asks them to rate the dealer (1-5 stars +
   an optional comment). The review is then visible to that dealer and to the admin.

   It asks the server (GET /api/my/reviews/pending) when the page opens, whenever the
   customer comes back to the tab, and every 30 seconds while the page is visible.
   "Maybe later" tells the server not to ask again about that order. */
(function () {
    "use strict";
    if (window.GasHubReviewPopup) return;

    var API = "/api/my/reviews";
    var POLL_MS = 30000;
    var timer = null, open = false, stopped = false, busy = false;
    var root = null, current = null, rating = 0, csrfValue = "";

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    async function csrf() {
        if (csrfValue) return csrfValue;
        try {
            var r = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
            csrfValue = ((await r.json()) || {}).csrfToken || "";
        } catch (e) { }
        return csrfValue;
    }

    async function post(path, body) {
        var r = await fetch(API + path, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": await csrf() },
            body: JSON.stringify(body)
        });
        var j = {};
        try { j = await r.json(); } catch (e) { }
        return { ok: r.ok, status: r.status, data: j };
    }

    /* ---------- styles ---------- */
    function addStyles() {
        if (document.getElementById("ghReviewCss")) return;
        var st = document.createElement("style");
        st.id = "ghReviewCss";
        st.textContent = [
            ".ghr{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(12,22,16,.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);font-family:inherit;animation:ghrFade .2s ease}",
            ".ghr[hidden]{display:none!important}",
            ".ghr-card{position:relative;width:100%;max-width:420px;max-height:92vh;overflow-y:auto;padding:26px 22px 20px;text-align:center;color:#17251d;background:#fff;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.35);animation:ghrPop .25s ease}",
            ".ghr-icon{display:grid;place-items:center;width:62px;height:62px;margin:0 auto 12px;color:#0d6b3f;background:#e8f4ed;border-radius:50%;font-size:30px;line-height:1}",
            ".ghr-card h2{margin:0 0 6px;font-size:19px;line-height:1.25;color:#10231a}",
            ".ghr-sub{margin:0 0 4px;font-size:13px;line-height:1.5;color:#5b6b62}",
            ".ghr-order{margin:0 0 14px;font-size:11.5px;color:#7b8a82}",
            ".ghr-stars{display:flex;justify-content:center;gap:6px;margin:6px 0 4px}",
            ".ghr-star{width:46px;height:46px;padding:0;border:0;background:none;font-size:38px;line-height:1;color:#d5dbd7;cursor:pointer;transition:transform .12s,color .12s}",
            ".ghr-star:hover{transform:scale(1.12)}",
            ".ghr-star.on{color:#f5a623}",
            ".ghr-star:focus-visible{outline:3px solid rgba(13,107,63,.45);outline-offset:2px;border-radius:8px}",
            ".ghr-word{min-height:18px;margin-bottom:10px;font-size:13px;font-weight:700;color:#0d6b3f}",
            ".ghr-text{box-sizing:border-box;width:100%;min-height:84px;padding:11px 12px;resize:vertical;font:inherit;font-size:14px;color:#17251d;background:#f6f8f7;border:1.5px solid #d9e2dc;border-radius:12px;outline:0}",
            ".ghr-text:focus{border-color:#0d6b3f;box-shadow:0 0 0 3px rgba(13,107,63,.13)}",
            ".ghr-count{margin:4px 2px 0;font-size:11px;text-align:right;color:#8a9890}",
            ".ghr-err{min-height:18px;margin:8px 0 0;font-size:12.5px;color:#c0392b}",
            ".ghr-actions{display:grid;gap:8px;margin-top:10px}",
            ".ghr-btn{min-height:48px;padding:12px 16px;border:0;border-radius:11px;font:inherit;font-size:14.5px;font-weight:800;cursor:pointer}",
            ".ghr-btn.primary{color:#fff;background:#0d6b3f}",
            ".ghr-btn.primary:hover{background:#0a5732}",
            ".ghr-btn.primary:disabled{opacity:.55;cursor:default}",
            ".ghr-btn.ghost{color:#5b6b62;background:transparent;font-weight:700}",
            "body.ghr-open{overflow:hidden}",
            "@keyframes ghrFade{from{opacity:0}to{opacity:1}}",
            "@keyframes ghrPop{from{transform:translateY(18px) scale(.97);opacity:0}to{transform:none;opacity:1}}",
            "@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .ghr-card{color:#e8efe9;background:#16201a}:root:not([data-theme=light]) .ghr-card h2{color:#f1f6f2}:root:not([data-theme=light]) .ghr-sub{color:#a6b5ac}:root:not([data-theme=light]) .ghr-text{color:#e8efe9;background:#0f1713;border-color:#2c3a32}:root:not([data-theme=light]) .ghr-icon{background:#1d3a2a}}",
            ":root[data-theme=dark] .ghr-card{color:#e8efe9;background:#16201a}:root[data-theme=dark] .ghr-card h2{color:#f1f6f2}:root[data-theme=dark] .ghr-sub{color:#a6b5ac}:root[data-theme=dark] .ghr-text{color:#e8efe9;background:#0f1713;border-color:#2c3a32}:root[data-theme=dark] .ghr-icon{background:#1d3a2a}",
            "@media (prefers-reduced-motion:reduce){.ghr,.ghr-card{animation:none}}"
        ].join("\n");
        document.head.appendChild(st);
    }

    var WORDS = ["", "Poor", "Fair", "Good", "Very good", "Excellent"];

    function starsHtml() {
        var h = "";
        for (var i = 1; i <= 5; i++) {
            h += '<button type="button" class="ghr-star" role="radio" aria-checked="false" aria-label="' + i + ' star' + (i > 1 ? "s" : "") + '" data-v="' + i + '">&#9733;</button>';
        }
        return h;
    }

    function paintStars() {
        var btns = root.querySelectorAll(".ghr-star");
        for (var i = 0; i < btns.length; i++) {
            var on = i < rating;
            btns[i].classList.toggle("on", on);
            btns[i].setAttribute("aria-checked", String(i + 1 === rating));
        }
        root.querySelector(".ghr-word").textContent = WORDS[rating] || "";
        root.querySelector(".ghr-send").disabled = rating < 1;
    }

    function setErr(t) { var e = root && root.querySelector(".ghr-err"); if (e) e.textContent = t || ""; }

    function close() {
        open = false;
        if (root) { root.remove(); root = null; }
        document.body.classList.remove("ghr-open");
        document.removeEventListener("keydown", onKey);
    }

    function onKey(e) {
        if (e.key === "Escape") later();
    }

    async function later() {
        var o = current;
        close();
        if (o) { try { await post("/skip", { orderId: o.id }); } catch (e) { } }
    }

    async function send() {
        if (busy || rating < 1 || !current) return;
        busy = true;
        var btn = root.querySelector(".ghr-send");
        btn.disabled = true;
        btn.textContent = "Sending...";
        setErr("");
        try {
            var res = await post("", { orderId: current.id, rating: rating, comment: root.querySelector(".ghr-text").value.trim() });
            if (res.ok || res.status === 409) {
                thanks();
            } else {
                setErr((res.data && res.data.message) || "We couldn't save your review. Please try again.");
                btn.disabled = false;
                btn.textContent = "Submit review";
            }
        } catch (e) {
            setErr("No connection. Please try again.");
            btn.disabled = false;
            btn.textContent = "Submit review";
        }
        busy = false;
    }

    function thanks() {
        var name = current ? current.dealerName : "the dealer";
        root.querySelector(".ghr-card").innerHTML =
            '<div class="ghr-icon" aria-hidden="true">&#10003;</div>' +
            "<h2>Thank you!</h2>" +
            '<p class="ghr-sub">Your review of <strong>' + esc(name) + "</strong> helps other customers and the dealer.</p>" +
            '<div class="ghr-actions"><button type="button" class="ghr-btn primary ghr-done">Close</button></div>';
        root.querySelector(".ghr-done").addEventListener("click", close);
        setTimeout(function () { if (open) close(); }, 3500);
        current = null;
    }

    function show(order) {
        addStyles();
        current = order;
        rating = 0;
        open = true;

        root = document.createElement("div");
        root.className = "ghr";
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-modal", "true");
        root.setAttribute("aria-labelledby", "ghrTitle");
        root.innerHTML =
            '<div class="ghr-card">' +
            '<div class="ghr-icon" aria-hidden="true">&#9733;</div>' +
            '<h2 id="ghrTitle">How was ' + esc(order.dealerName || "your dealer") + "?</h2>" +
            '<p class="ghr-sub">Your order is complete. Tap a star to rate the dealer.</p>' +
            '<p class="ghr-order">' + (order.orderNumber ? "Order " + esc(order.orderNumber) : "") + (order.product ? (order.orderNumber ? " &middot; " : "") + esc(order.product) : "") + "</p>" +
            '<div class="ghr-stars" role="radiogroup" aria-label="Rating">' + starsHtml() + "</div>" +
            '<div class="ghr-word" aria-live="polite"></div>' +
            '<textarea class="ghr-text" maxlength="500" placeholder="Tell others about the service (optional)" aria-label="Your comment"></textarea>' +
            '<div class="ghr-count"><span class="ghr-n">0</span>/500</div>' +
            '<p class="ghr-err" role="alert"></p>' +
            '<div class="ghr-actions">' +
            '<button type="button" class="ghr-btn primary ghr-send" disabled>Submit review</button>' +
            '<button type="button" class="ghr-btn ghost ghr-later">Maybe later</button>' +
            "</div></div>";
        document.body.appendChild(root);
        document.body.classList.add("ghr-open");

        root.querySelector(".ghr-stars").addEventListener("click", function (e) {
            var b = e.target.closest(".ghr-star");
            if (!b) return;
            rating = Number(b.getAttribute("data-v"));
            setErr("");
            paintStars();
        });
        root.querySelector(".ghr-stars").addEventListener("keydown", function (e) {
            if (e.key === "ArrowRight" || e.key === "ArrowUp") { rating = Math.min(5, rating + 1); }
            else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { rating = Math.max(1, rating - 1); }
            else return;
            e.preventDefault();
            paintStars();
            root.querySelectorAll(".ghr-star")[rating - 1].focus();
        });
        var ta = root.querySelector(".ghr-text");
        ta.addEventListener("input", function () { root.querySelector(".ghr-n").textContent = ta.value.length; });
        root.querySelector(".ghr-send").addEventListener("click", send);
        root.querySelector(".ghr-later").addEventListener("click", later);
        document.addEventListener("keydown", onKey);
        paintStars();
        var first = root.querySelector(".ghr-star");
        if (first) first.focus();
    }

    /* ---------- asking the server ---------- */
    /* Only ask the server when this browser thinks a customer is signed in; otherwise it just answers 401. */
    function signedInHint() { try { var f = localStorage.getItem("gasHubLoggedIn"); return !!f && f !== "false" && f !== "0"; } catch (e) { return true; } }

    async function check() {
        if (open || stopped || busy || !signedInHint()) return;
        if (document.hidden) return;
        /* don't interrupt a payment prompt */
        if (document.body && document.body.classList.contains("pay-open")) return;
        try {
            var r = await fetch(API + "/pending", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
            if (r.status === 401 || r.status === 403) { stop(); return; }   /* not signed in as a customer */
            if (!r.ok) return;
            var j = await r.json();
            if (j && j.order && !open) show(j.order);
        } catch (e) { /* offline: try again later */ }
    }

    function stop() {
        stopped = true;
        clearInterval(timer);
    }

    function start() {
        setTimeout(check, 1200);
        timer = setInterval(check, POLL_MS);
        document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
        window.addEventListener("focus", check);
    }

    window.GasHubReviewPopup = { check: check };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();
