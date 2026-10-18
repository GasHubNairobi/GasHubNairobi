/* One banner that says the same thing on every page: when the money is sent, when the next run is, what the last run did.
   The text comes from the server (payout-planner-controller.summary), so the Payout Planner, Point Withdrawals and the dealer page can never disagree.
   Usage: GasHubPlannerBanner.render(element, summary)   */
(function () {
    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function render(el, s) {
        if (!el) return;
        if (!s) { el.innerHTML = ""; return; }
        var off = s.mode === "off";
        el.innerHTML =
            '<div class="ppb ' + (off ? "ppb-off" : "ppb-on") + '">' +
            '<div><strong>' + (off ? "Automatic sending is OFF" : "Automatic sending is ON") + '</strong> &middot; ' + esc(s.text) + '</div>' +
            (s.next_text ? '<div>Next run: <strong>' + esc(s.next_text) + '</strong></div>' : "") +
            (s.last_result ? '<div class="ppb-muted">Last run' + (s.last_run_text ? " (" + esc(s.last_run_text) + ")" : "") + ": " + esc(s.last_result) + '</div>' : "") +
            (s.b2c_ready ? "" : '<div class="ppb-warn">The Paybill (MPESA_B2C_*) is not set up, so nothing can be sent automatically.</div>') +
            '<div><a href="' + esc(s.planner_url) + '">Change the schedule in Payout Planner &rarr;</a></div></div>';
    }
    if (!document.getElementById("ppbStyle")) {
        var st = document.createElement("style"); st.id = "ppbStyle";
        st.textContent = ".ppb{display:grid;gap:4px;padding:12px 16px;border-radius:10px;font-size:13px;line-height:1.45;margin:0 20px 16px}.ppb-on{background:#e3f6ec;color:#0f5132}.ppb-off{background:#f1f5f9;color:#334155}.ppb-muted{opacity:.85}.ppb-warn{color:#b42318;font-weight:600}.ppb a{font-weight:700;color:inherit}";
        document.head.appendChild(st);
    }
    window.GasHubPlannerBanner = { render: render };
})();
