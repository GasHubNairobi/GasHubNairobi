/* GasHub admin: Messengers page.
   Shows every messenger's allocated orders from /api/admin/messengers/deliveries, with the dealer they worked with,
   the payment mode, the time each delivery took, and a CSV download. */
(function () {
    "use strict";

    var $ = function (id) { return document.getElementById(id); };
    var data = { summary: [], deliveries: [] };
    var filtersLoaded = false;

    function esc(v) {
        return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
    }
    function fmtDate(d) {
        if (!d) return "-";
        try { return new Date(d).toLocaleString("en-KE", { timeZone: "Africa/Nairobi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) { return "-"; }
    }
    function fmtMin(m) {
        if (m == null) return "-";
        if (m < 60) return Math.round(m) + " min";
        var h = Math.floor(m / 60), r = Math.round(m % 60);
        return h + " h " + r + " min";
    }
    function payLabel(m) { return m === "cash" ? "Cash" : (m === "mpesa" || m === "m-pesa") ? "M-Pesa" : (m || "-"); }
    function statusPill(s) {
        s = String(s || "");
        var cls = ["delivered", "completed"].indexOf(s) > -1 ? "ok" : ["cancelled", "rejected"].indexOf(s) > -1 ? "bad" : "warn";
        return '<span class="msgr-pill ' + cls + '">' + esc(s.replace(/_/g, " ") || "-") + "</span>";
    }
    function note(msg) { var n = $("msgrMessage"); n.textContent = msg || ""; n.hidden = !msg; n.classList.toggle("show", !!msg); }

    function query() {
        var p = new URLSearchParams();
        if ($("fMessenger").value) p.set("messenger", $("fMessenger").value);
        if ($("fDealer").value) p.set("dealer", $("fDealer").value);
        if ($("fFrom").value) p.set("from", $("fFrom").value);
        if ($("fTo").value) p.set("to", $("fTo").value);
        var s = p.toString();
        return "/api/admin/messengers/deliveries" + (s ? "?" + s : "");
    }

    async function load() {
        note("");
        try {
            var res = await GasHubAdmin.adminApiRequest(query());
            data.summary = res.summary || []; data.deliveries = res.deliveries || [];
            if (!filtersLoaded) {
                $("fMessenger").insertAdjacentHTML("beforeend", (res.messengers || []).map(function (m) {
                    return '<option value="' + esc(m.id) + '">' + esc(m.name) + (m.dealerName ? " (" + esc(m.dealerName) + ")" : "") + "</option>";
                }).join(""));
                $("fDealer").insertAdjacentHTML("beforeend", (res.dealers || []).map(function (d) {
                    return '<option value="' + esc(d.id) + '">' + esc(d.name) + "</option>";
                }).join(""));
                filtersLoaded = true;
            }
            if (res.truncated) note("Showing the latest 2000 orders. Narrow the dates to see older ones.");
            render();
        } catch (e) {
            data = { summary: [], deliveries: [] };
            render();
            note(e.message || "Unable to load the messenger deliveries.");
        }
    }

    function searched() {
        var q = $("fSearch").value.trim().toLowerCase();
        if (!q) return data.deliveries;
        return data.deliveries.filter(function (d) {
            return [d.orderNumber, d.customerName, d.messengerName, d.dealerName, d.destination].join(" ").toLowerCase().indexOf(q) > -1;
        });
    }

    function render() {
        var rows = searched();
        var delivered = rows.filter(function (d) { return d.deliveredAt || ["delivered", "completed"].indexOf(String(d.status)) > -1; }).length;
        var timed = rows.filter(function (d) { return d.minutesTaken != null; });
        var avg = timed.length ? timed.reduce(function (n, d) { return n + d.minutesTaken; }, 0) / timed.length : null;
        $("statMessengers").textContent = data.summary.length;
        $("statOrders").textContent = rows.length;
        $("statDelivered").textContent = delivered;
        $("statAvg").textContent = fmtMin(avg);

        $("summaryBody").innerHTML = data.summary.length ? data.summary.map(function (m) {
            return "<tr><td><strong>" + esc(m.name) + "</strong></td>" +
                '<td><a href="tel:' + esc(m.phone) + '">' + esc(m.phone || "-") + "</a></td>" +
                "<td>" + (m.email ? '<a href="mailto:' + esc(m.email) + '">' + esc(m.email) + "</a>" : "-") + "</td>" +
                "<td>" + esc(m.dealerName || "-") + "</td><td>" + m.orders + "</td><td>" + m.delivered + "</td><td>" + m.open + "</td>" +
                "<td>" + fmtMin(m.avgMinutes) + "</td>" +
                "<td>" + (m.messengerId != null ? '<button type="button" class="btn-link" data-msgr="' + esc(m.messengerId) + '">View orders</button>' : "") + "</td></tr>";
        }).join("") : '<tr><td colspan="9" class="table-empty"><strong>No messengers found</strong><span>No orders have been given to a messenger for this filter.</span></td></tr>';

        $("detailBody").innerHTML = rows.length ? rows.map(function (d) {
            return "<tr><td><strong>" + esc(d.orderNumber) + "</strong></td>" +
                "<td>" + esc(d.messengerName) + '<span class="msgr-sub">' + esc(d.messengerPhone || "") + "</span></td>" +
                "<td>" + esc(d.dealerName || "-") + '<span class="msgr-sub">' + esc(d.dealerPhone || "") + "</span></td>" +
                "<td>" + esc(d.customerName || "-") + '<span class="msgr-sub">' + esc(d.destination) + "</span></td>" +
                "<td>" + esc(payLabel(d.paymentMethod)) + '<span class="msgr-sub">' + esc(d.paymentStatus || "") + " - KSh " + Number(d.totalAmount).toLocaleString("en-KE") + "</span></td>" +
                "<td>" + fmtDate(d.assignedAt) + "</td><td>" + fmtDate(d.startedAt) + "</td><td>" + fmtDate(d.deliveredAt) + "</td>" +
                "<td><strong>" + fmtMin(d.minutesTaken) + "</strong></td><td>" + statusPill(d.status) + "</td></tr>";
        }).join("") : '<tr><td colspan="10" class="table-empty"><strong>No orders</strong><span>Nothing matches this filter.</span></td></tr>';
    }

    function csvCell(v) { v = String(v == null ? "" : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }
    function downloadCsv() {
        var head = ["Order number", "Messenger", "Messenger phone", "Messenger email", "Dealer", "Customer", "Destination", "Payment mode", "Payment status", "Total (KSh)", "Allocated", "Started", "Delivered", "Minutes taken", "Status"];
        var lines = [head.map(csvCell).join(",")].concat(searched().map(function (d) {
            return [d.orderNumber, d.messengerName, d.messengerPhone, d.messengerEmail, d.dealerName, d.customerName, d.destination, payLabel(d.paymentMethod), d.paymentStatus, d.totalAmount,
                d.assignedAt || "", d.startedAt || "", d.deliveredAt || "", d.minutesTaken == null ? "" : d.minutesTaken, d.status].map(csvCell).join(",");
        }));
        var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = "gashub-messenger-deliveries.csv";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }

    document.addEventListener("DOMContentLoaded", function () {
        $("btnApply").addEventListener("click", load);
        $("btnReset").addEventListener("click", function () {
            ["fMessenger", "fDealer", "fFrom", "fTo", "fSearch"].forEach(function (id) { $(id).value = ""; });
            load();
        });
        $("fSearch").addEventListener("input", render);
        $("btnCsv").addEventListener("click", downloadCsv);
        $("summaryBody").addEventListener("click", function (e) {
            var b = e.target.closest("[data-msgr]");
            if (!b) return;
            $("fMessenger").value = b.getAttribute("data-msgr");
            load();
            $("detailBody").scrollIntoView({ behavior: "smooth", block: "start" });
        });
        load();
    });
})();
