/* Dealer Sales page: real, completed sales for the signed-in dealer (GET /api/dealers/sales/mine). */
document.addEventListener("DOMContentLoaded", function () {
    "use strict";
    var $ = function (id) { return document.getElementById(id); };
    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function kes(v) { return "KSh " + (Number(v) || 0).toLocaleString("en-KE", { maximumFractionDigits: 2 }); }
    function when(v) {
        var d = new Date(v);
        return isNaN(d.getTime()) ? "" : d.toLocaleString("en-KE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi" });
    }
    function change(pct, empty) {
        if (pct === null || pct === undefined) return empty;
        return (pct > 0 ? "+" : "") + pct + "% vs yesterday";
    }
    function set(id, text) { var el = $(id); if (el) el.textContent = text; }

    function render(d) {
        var t = d.totals || {};
        set("salesToday", kes(d.today.revenue));
        var tc = d.today.change_pct;
        var note = $("salesTodayChange");
        if (note) {
            note.textContent = d.today.yesterday_revenue > 0 || d.today.revenue > 0 ? change(tc, "New vs yesterday") : "No sales today yet";
            note.className = "metric-subtext " + (tc !== null && tc < 0 ? "text-danger" : "text-success");
        }
        set("salesRefills", (t.refills_sold || 0) + (t.refills_sold === 1 ? " Cylinder" : " Cylinders"));
        set("salesNew", (t.new_cylinders_sold || 0) + (t.new_cylinders_sold === 1 ? " Unit" : " Units"));
        set("salesEmpty", (t.empty_cylinders_sold || 0) + (t.empty_cylinders_sold === 1 ? " Unit" : " Units"));
        set("salesAccessories", (t.accessories_sold || 0) + (t.accessories_sold === 1 ? " Item" : " Items"));
        set("salesCommercial", (t.commercial_sold || 0) + (t.commercial_sold === 1 ? " Unit" : " Units"));
        set("salesMargin", kes(t.net_margin));
        set("salesMarginPct", (t.margin_pct || 0) + "% after GasHub commission (" + (d.commission_rate || 0) + "%)");
        set("salesGross", kes(t.gross_sales));
        set("salesCommission", kes(t.commission));
        set("salesDelivery", kes(t.delivery_fees));
        set("salesOrders", String((d.period_summary || {}).orders || 0));

        var body = $("salesTableBody");
        var rows = d.transactions || [];
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px 16px;color:#64748b;"><i class="fa-solid fa-receipt fa-2x" style="opacity:.35;margin-bottom:8px;display:block;"></i><span>No sales completed in this period. Completed, paid orders appear here.</span></td></tr>';
            return;
        }
        body.innerHTML = rows.map(function (o) {
            var cash = String(o.payment_method || "").toLowerCase() === "cash";
            var items = (o.items || []).map(function (i) { return (i.qty || 1) + " x " + esc(i.name || "Gas") + (i.size ? " " + esc(i.size) : ""); }).join(", ") || "-";
            return "<tr><td><strong>#" + esc(o.order_number || o.id) + "</strong></td>" +
                "<td>" + esc(o.customer_name) + "</td>" +
                "<td>" + items + "</td>" +
                "<td>" + kes(o.goods) + "</td>" +
                "<td>" + kes(o.commission) + "</td>" +
                "<td><strong>" + kes(o.earned) + "</strong>" + (Number(o.delivery_fee) > 0 ? '<span class="sales-sub">incl. delivery ' + kes(o.delivery_fee) + "</span>" : "") + "</td>" +
                '<td class="' + (cash ? "sales-pay-cash" : "") + '">' + (cash ? "Cash" : esc(String(o.payment_method || "M-Pesa").toUpperCase() === "MPESA" ? "M-Pesa" : o.payment_method || "M-Pesa")) +
                (cash ? '<span class="sales-sub">you hold the cash</span>' : "") + "</td>" +
                "<td>" + esc(when(o.completed_at)) + "</td></tr>";
        }).join("");
    }

    async function load() {
        var token = localStorage.getItem("gashub_dealer_token") || localStorage.getItem("dealerToken") || "";
        if (!token) { window.location.href = "dealer-login.html"; return; }
        var err = $("salesError");
        if (err) err.hidden = true;
        try {
            var r = await fetch("/api/dealers/sales/mine?period=" + encodeURIComponent($("salesPeriodSelect").value), {
                headers: { Accept: "application/json", Authorization: "Bearer " + token }, cache: "no-store"
            });
            if (r.status === 401) { window.location.href = "dealer-login.html"; return; }
            var data = await r.json();
            if (!r.ok || !data.success) throw new Error(data.message || "Unable to load your sales.");
            render(data);
        } catch (e) {
            if (err) { err.textContent = e.message; err.hidden = false; }
            $("salesTableBody").innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:#64748b;">Could not load sales.</td></tr>';
        }
    }

    $("salesPeriodSelect").addEventListener("change", load);
    load();
    setInterval(load, 60000);   /* new completed orders show up without reloading */
});
