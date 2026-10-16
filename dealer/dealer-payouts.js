/* Dealer payouts page: READ ONLY view of the money GasHub sends to this dealer. */
document.addEventListener("DOMContentLoaded", function () {
    "use strict";
    var $ = function (id) { return document.getElementById(id); };
    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function kes(v) { return "KSh " + (Number(v) || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function when(v) {
        var d = new Date(v);
        return isNaN(d.getTime()) ? "" : d.toLocaleString("en-KE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    }
    var LABEL = { paid: "Paid", scheduled: "Scheduled", on_hold: "On hold", sending: "Sending to M-Pesa", failed: "Delayed" };

    function render(data) {
        var s = data.summary || {};
        $("poTotalPaid").textContent = kes(s.total_paid);
        $("poPaidCount").textContent = (s.paid_count || 0) + ((s.paid_count || 0) === 1 ? " payout" : " payouts");
        if (s.next) {
            $("poNextAmount").textContent = kes(s.next.amount);
            $("poNextWhen").textContent = (s.next.status === "on_hold" || s.next.status === "held" ? "On hold - " : "Due ") + when(s.next.scheduled_for);
        } else {
            $("poNextAmount").textContent = "-";
            $("poNextWhen").textContent = (data.schedule && data.schedule.next_text) ? "Next payout run: " + data.schedule.next_text : (data.schedule && data.schedule.mode !== "off" ? data.schedule.text : "Nothing scheduled");
        }
        var b = data.balance;
        if (b) {
            $("poReady").textContent = kes(b.ready_amount);
            $("poReadyNote").textContent = b.ready_orders + (b.ready_orders === 1 ? " order" : " orders") +
                (Number(b.cash_commission) > 0 ? " - cash commission of " + kes(b.cash_commission) + " already deducted" : "") +
                " (commission " + b.commission_rate + "%)";
            $("poHold").textContent = kes(b.on_hold_amount);
            $("poHoldNote").textContent = b.on_hold_orders + (b.on_hold_orders === 1 ? " order" : " orders") + " released " + b.hold_hours + "h after completion";
        }
        var list = data.payouts || [];
        if (!list.length) { $("poList").innerHTML = '<div class="po-empty">No payouts yet. They appear here once GasHub schedules your earnings.</div>'; return; }
        $("poList").innerHTML = list.map(function (p) {
            var meta = [];
            if (p.status === "paid") meta.push("Paid " + when(p.paid_at));
            else if (p.status === "sending") meta.push("Being sent to your M-Pesa now");
            else if (p.status === "failed") meta.push("GasHub is sorting out this payment. You do not need to do anything.");
            else meta.push("Scheduled for " + when(p.scheduled_for));
            meta.push("Sent to: " + esc(p.destination || "-"));
            if (p.mpesa_receipt) meta.push("M-Pesa receipt: <strong>" + esc(p.mpesa_receipt) + "</strong>");
            var rows = (p.orders || []).map(function (o) {
                var cash = o.kind === "cash";
                return "<tr><td>" + esc(o.order_number || "-") + "</td><td>" + (cash ? "Cash order" : "Online order") + "</td><td>" + kes(o.product_total) +
                    "</td><td>" + kes(o.commission) + "</td><td class=\"" + (cash ? "po-neg" : "") + "\">" + (cash ? "- " + kes(o.commission) : kes(o.net)) + "</td></tr>";
            }).join("");
            return '<div class="po-item"><div class="po-head"><div><div class="po-ref">' + esc(p.reference) + '</div><div class="po-meta">' + meta.join("<br>") +
                '</div><span class="po-pill po-' + esc(p.status) + '">' + esc(LABEL[p.status] || p.status) + '</span></div>' +
                '<div class="po-amount">' + kes(p.amount) + '</div></div>' +
                (rows ? '<details class="po-details"><summary>View ' + p.orders.length + ' orders in this payout</summary><div class="po-table-wrap"><table class="po-table"><thead><tr><th>Order</th><th>Type</th><th>Product price</th><th>GasHub commission</th><th>You receive</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
                    (Number(p.cash_commission) > 0 ? '<div class="po-meta">Commission on cash orders (' + kes(p.cash_commission) + ') was deducted because you already collected that cash.</div>' : "") + '</details>' : "") + "</div>";
        }).join("");
    }

    (async function load() {
        var token = localStorage.getItem("gashub_dealer_token");
        if (!token) { window.location.href = "dealer-login.html"; return; }
        try {
            var r = await fetch("/api/dealers/payouts/mine", { headers: { Accept: "application/json", Authorization: "Bearer " + token } });
            if (r.status === 401) { window.location.href = "dealer-login.html"; return; }
            var data = await r.json();
            if (!r.ok || !data.success) throw new Error(data.message || "Unable to load payouts.");
            render(data);
        } catch (e) {
            $("poList").innerHTML = '<div class="po-empty">' + esc(e.message) + "</div>";
        }
    })();
});
