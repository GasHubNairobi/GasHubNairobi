/* Dealer reviews page: shows the ratings customers left about THIS dealer. */
document.addEventListener("DOMContentLoaded", function () {
    "use strict";

    var state = { reviews: [], summary: null };
    var $ = function (id) { return document.getElementById(id); };

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function stars(n) {
        n = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
        return "★".repeat(n) + '<span class="off">' + "★".repeat(5 - n) + "</span>";
    }

    function date(v) {
        var d = new Date(v);
        return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
    }

    function renderSummary() {
        var s = state.summary || { count: 0, average: 0, counts: {} };
        $("rvAverage").textContent = (Number(s.average) || 0).toFixed(1);
        $("rvAverageStars").innerHTML = stars(s.average);
        $("rvCount").textContent = s.count + (s.count === 1 ? " review" : " reviews");
        var html = "";
        for (var i = 5; i >= 1; i--) {
            var n = Number((s.counts || {})[i]) || 0;
            var pct = s.count ? Math.round((n / s.count) * 100) : 0;
            html += '<div class="rv-bar"><span>' + i + ' ★</span><span class="track"><span class="fill" style="width:' + pct + '%"></span></span><span class="n">' + n + "</span></div>";
        }
        $("rvBars").innerHTML = html;
    }

    function renderList() {
        var f = $("rvFilter").value;
        var list = state.reviews.filter(function (r) { return !f || String(Math.round(Number(r.rating))) === f; });
        if (!list.length) {
            $("rvList").innerHTML = '<div class="rv-empty">' + (state.reviews.length ? "No reviews with that rating." : "No reviews yet. They appear here after customers rate a completed order.") + "</div>";
            return;
        }
        $("rvList").innerHTML = list.map(function (r) {
            return '<article class="rv-item">' +
                '<div class="rv-head"><div><div class="rv-who">' + esc(r.customer_name || "Customer") + "</div>" +
                '<div class="rv-meta">' + esc(date(r.created_at)) + (r.order_number ? " · Order " + esc(r.order_number) : "") + "</div></div>" +
                '<div class="rv-stars" aria-label="' + esc(r.rating) + ' out of 5">' + stars(r.rating) + "</div></div>" +
                (r.comment ? '<p class="rv-text">' + esc(r.comment) + "</p>" : '<p class="rv-text none">No comment left.</p>') +
                "</article>";
        }).join("");
    }

    async function load() {
        var token = localStorage.getItem("gashub_dealer_token");
        if (!token) { window.location.href = "dealer-login.html"; return; }
        try {
            var r = await fetch("/api/dealers/reviews/mine", {
                headers: { Accept: "application/json", Authorization: "Bearer " + token },
                cache: "no-store"
            });
            if (r.status === 401) { window.location.href = "dealer-login.html"; return; }
            var j = await r.json();
            if (!r.ok || !j.success) throw new Error(j.message || "Unable to load your reviews.");
            state.reviews = j.reviews || [];
            state.summary = j.summary;
            renderSummary();
            renderList();
        } catch (e) {
            $("rvList").innerHTML = '<div class="rv-empty">' + esc(e.message || "Unable to load your reviews.") + "</div>";
        }
    }

    $("rvFilter").addEventListener("change", renderList);
    load();
});
