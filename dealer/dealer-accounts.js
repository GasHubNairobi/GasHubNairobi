/* Dealer Daily Accounts: the dealer closes the day (GET /api/dealers/accounts/daily?date=YYYY-MM-DD).
   Cash is already with the dealer; online money is held by GasHub and paid out later. This page keeps the two apart. */
document.addEventListener("DOMContentLoaded", function () {
    "use strict";
    var $ = function (id) { return document.getElementById(id); };
    var state = { data: null };

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function kes(v) { return "KSh " + (Number(v) || 0).toLocaleString("en-KE", { maximumFractionDigits: 2 }); }
    function when(v, time) {
        var d = new Date(v);
        if (isNaN(d.getTime())) return "";
        return d.toLocaleString("en-KE", time ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi" } : { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Nairobi" });
    }
    function longDay(key) {
        var d = new Date(key + "T12:00:00Z");
        return d.toLocaleDateString("en-KE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    }
    function shortDay(key) {
        var d = new Date(key + "T12:00:00Z");
        return d.toLocaleDateString("en-KE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    }
    function set(id, text) { var el = $(id); if (el) el.textContent = text; }
    function today() { return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); }
    function shift(key, days) { return new Date(Date.parse(key + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10); }
    function methodLabel(m) { return m === "cash" ? "Cash" : (m === "bank" ? "Bank" : "M-Pesa"); }
    function row(label, sub, amount, cls) {
        return '<div class="acct-row ' + (cls || "") + '"><div class="acct-label">' + label + (sub ? "<small>" + sub + "</small>" : "") + '</div><div class="acct-amount">' + amount + "</div></div>";
    }
    function money(list, f) { return list.reduce(function (t, o) { return t + (Number(f(o)) || 0); }, 0); }

    function moneyState(o) {
        var map = { cash: ["cash", "You hold the cash"], paid: ["paid", "Paid out"], scheduled: ["scheduled", "In a payout"], waiting: ["waiting", "Waiting for payout"], failed: ["failed", "Payout failed"] };
        var m = map[o.payout_state] || map.waiting;
        return '<span class="acct-pill ' + m[0] + '">' + m[1] + "</span>";
    }

    function render(d) {
        state.data = d;
        state.following = d.date >= d.today;      /* looking at "today": move on by itself when midnight passes */
        var s = d.summary, c = d.close;
        $("acctDate").value = d.date;
        $("acctDate").max = d.today;
        $("acctNext").disabled = d.date >= d.today;
        set("acctDayLabel", longDay(d.date) + (d.date === d.today ? " (today)" : ""));
        set("acctRate", "Commission rate: " + d.commission_rate + "% on goods");
        set("acctPrintTitle", longDay(d.date));
        set("acctPrintDealer", (($("dealerHeaderName") && $("dealerHeaderName").textContent) || "").trim());
        set("acctPrintStamp", "Printed " + new Date().toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi" }));

        set("mGoods", kes(s.goods));
        set("mOrders", s.orders + (s.orders === 1 ? " completed order" : " completed orders"));
        set("mCash", kes(s.cash.collected));
        set("mCashN", s.cash.orders + (s.cash.orders === 1 ? " cash order" : " cash orders"));
        set("mOnline", kes(s.online.paid));
        set("mOnlineN", s.online.orders + (s.online.orders === 1 ? " online order" : " online orders"));
        set("mKeep", kes(s.keep));
        set("mKeepNote", "After " + kes(s.commission) + " GasHub commission");

        var onlineOrders = d.orders.filter(function (o) { return o.method !== "cash"; });
        var onlineGoods = money(onlineOrders, function (o) { return o.goods; });
        var onlineDelivery = money(onlineOrders, function (o) { return o.delivery; });
        var html = "";
        html += '<div class="acct-group">Cash on delivery &middot; the cash is already with you</div>';
        html += row("Cash collected from customers", s.cash.orders + " cash order" + (s.cash.orders === 1 ? "" : "s") + ". This is the cash you should have in hand.", kes(c.cash_in_hand));
        html += row("GasHub commission on cash orders", "GasHub takes this from a later payout.", "&minus; " + kes(c.cash_commission_owed), "minus");
        html += row("Cash you keep", "", kes(c.cash_you_keep));
        html += '<div class="acct-group">Paid online &middot; GasHub holds this money for you</div>';
        html += row("Goods sold online", s.online.orders + " order" + (s.online.orders === 1 ? "" : "s") + ". Customers paid GasHub " + kes(s.online.paid) + ".", kes(onlineGoods));
        html += row("GasHub commission", "", "&minus; " + kes(s.online.commission), "minus");
        html += row("Delivery fees (yours)", "", "+ " + kes(onlineDelivery), "plus");
        html += row("GasHub owes you for these orders", c.online_not_yet_paid_out > 0 ? kes(c.online_not_yet_paid_out) + " of it is not paid out yet." : (s.online.orders ? "All of it has been paid out." : ""), kes(c.online_owed_by_gashub));
        html += row("You keep today (cash + online)", "Goods sold, minus commission, plus delivery fees.", kes(s.keep), "total");
        $("acctClose").innerHTML = html;
        updateCount();

        $("acctOrders").innerHTML = d.orders.length ? d.orders.map(function (o) {
            return "<tr><td><strong>#" + esc(o.order_number) + "</strong><span class=\"sales-sub\">" + esc(when(o.completed_at, true)) + "</span></td>" +
                "<td>" + esc(o.customer) + "</td><td>" + esc(o.items) + "</td>" +
                "<td>" + methodLabel(o.method) + "</td><td>" + kes(o.customer_paid) + "</td><td>" + kes(o.commission) + "</td>" +
                "<td><strong>" + kes(o.keep) + "</strong>" + (o.delivery > 0 ? '<span class="sales-sub">incl. delivery ' + kes(o.delivery) + "</span>" : "") + "</td>" +
                "<td>" + moneyState(o) + (o.payout_reference ? '<span class="sales-sub">' + esc(o.payout_reference) + "</span>" : "") + "</td></tr>";
        }).join("") : '<tr><td colspan="8" class="acct-empty">No orders were completed on this day.</td></tr>';

        $("acctPayouts").innerHTML = d.payouts_today.length ? d.payouts_today.map(function (p) {
            return "<tr><td>" + esc(p.reference) + "</td><td><strong>" + kes(p.amount) + "</strong></td><td>" + esc(p.receipt || "-") + "</td><td>" + esc(when(p.paid_at, true)) + "</td></tr>";
        }).join("") + '<tr><td><strong>Total received</strong></td><td colspan="3"><strong>' + kes(d.payouts_today_total) + "</strong></td></tr>"
            : '<tr><td colspan="4" class="acct-empty">GasHub did not send you a payout on this day.</td></tr>';

        $("acctLost").innerHTML = d.cancelled.length ? d.cancelled.map(function (x) {
            var what = x.refund_status === "refunded" ? "Refunded to the customer" : x.refund_status === "pending" ? "Refund pending" : (x.status === "rejected" ? "Rejected" : "Cancelled");
            return "<tr><td>#" + esc(x.order_number) + "</td><td>" + kes(x.amount) + "</td><td>" + methodLabel(x.method) + "</td><td>" + what + "</td></tr>";
        }).join("") : '<tr><td colspan="4" class="acct-empty">No cancelled or refunded orders on this day.</td></tr>';

        $("acctWeek").innerHTML = d.week.map(function (w) {
            return '<tr class="' + (w.day === d.date ? "acct-selected" : "") + '" data-day="' + w.day + '" style="cursor:pointer"><td>' + esc(shortDay(w.day)) + "</td><td>" + w.orders + "</td><td>" + kes(w.goods) + "</td><td>" + kes(w.cash) + "</td><td>" + kes(w.online) + "</td><td>" + kes(w.commission) + "</td><td><strong>" + kes(w.keep) + "</strong></td></tr>";
        }).join("");
    }

    /* ---- the optional cash count ---- */
    function countKey() { return "gh_acct_counted_" + (state.data ? state.data.date : ""); }
    function updateCount() {
        var d = state.data, input = $("acctCounted"), out = $("acctDiff"), pr = $("acctCountPrint");
        if (!d) return;
        var saved = null;
        try { saved = localStorage.getItem(countKey()); } catch (e) { }
        if (document.activeElement !== input) input.value = saved == null ? "" : saved;
        var raw = input.value;
        if (raw === "" || isNaN(Number(raw))) { out.textContent = ""; out.className = ""; pr.textContent = ""; return; }
        var diff = Math.round((Number(raw) - d.close.cash_in_hand) * 100) / 100;
        if (diff === 0) { out.textContent = "Balanced. Your count matches."; out.className = "ok"; }
        else if (diff < 0) { out.textContent = "Short by " + kes(-diff); out.className = "short"; }
        else { out.textContent = "Over by " + kes(diff); out.className = "over"; }
        pr.textContent = "Cash counted: " + kes(raw) + " - " + out.textContent;
    }

    /* ---- CSV ---- */
    function csvCell(v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }
    function downloadCsv() {
        var d = state.data; if (!d) return;
        var lines = [];
        var dealerName = (($("dealerHeaderName") && $("dealerHeaderName").textContent) || "").trim();
        lines.push(["GasHub - Find. Order. Delivered."].map(csvCell).join(","));
        lines.push(["Daily Accounts", d.date].map(csvCell).join(","));
        if (dealerName) lines.push(["Dealer", dealerName].map(csvCell).join(","));
        lines.push("");
        lines.push(["Goods sold", d.summary.goods].map(csvCell).join(","));
        lines.push(["Cash collected", d.summary.cash.collected].map(csvCell).join(","));
        lines.push(["Paid online to GasHub", d.summary.online.paid].map(csvCell).join(","));
        lines.push(["GasHub commission", d.summary.commission].map(csvCell).join(","));
        lines.push(["You keep", d.summary.keep].map(csvCell).join(","));
        lines.push(["GasHub owes you (online), not yet paid out", d.close.online_not_yet_paid_out].map(csvCell).join(","));
        lines.push("");
        lines.push(["Order", "Customer", "Items", "Paid by", "Customer paid", "Goods", "Commission", "Delivery fee", "You keep", "Your money"].map(csvCell).join(","));
        d.orders.forEach(function (o) {
            lines.push([o.order_number, o.customer, o.items, methodLabel(o.method), o.customer_paid, o.goods, o.commission, o.delivery, o.keep, o.payout_state === "cash" ? "cash in hand" : o.payout_state].map(csvCell).join(","));
        });
        var blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "gashub-daily-accounts-" + d.date + ".csv";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }

    /* ---- loading ---- */
    var requestNo = 0;
    async function load(date) {
        var mine = ++requestNo;
        var token = localStorage.getItem("gashub_dealer_token") || localStorage.getItem("dealerToken") || "";
        if (!token) { window.location.href = "dealer-login.html"; return; }
        var err = $("acctError");
        if (err) err.hidden = true;
        try {
            var r = await fetch("/api/dealers/accounts/daily?date=" + encodeURIComponent(date || today()), {
                headers: { Accept: "application/json", Authorization: "Bearer " + token }, cache: "no-store"
            });
            if (r.status === 401) { window.location.href = "dealer-login.html"; return; }
            var data = await r.json();
            if (mine !== requestNo) return;                       /* a newer click already took over */
            if (!r.ok || !data.success) throw new Error(data.message || "Unable to load your daily accounts.");
            render(data);
        } catch (e) {
            if (mine !== requestNo) return;
            if (err) { err.textContent = "Could not open " + longDay(date || today()) + ". " + e.message; err.hidden = false; }
            set("acctDayLabel", longDay(date || today()));
            $("acctOrders").innerHTML = '<tr><td colspan="8" class="acct-empty">Could not load your accounts for this day.</td></tr>';
        } finally {
            if (mine === requestNo) { var root = $("acctRoot"); if (root) root.classList.remove("acct-loading"); }
        }
    }

    /* a click shows the chosen day straight away, so it is obvious something happened, even before the answer arrives */
    function go(date) {
        if (!date) return;
        if (date > today()) date = today();
        $("acctDate").value = date;
        set("acctDayLabel", longDay(date) + (date === today() ? " (today)" : "") + " - loading...");
        var root = $("acctRoot"); if (root) root.classList.add("acct-loading");
        load(date);
    }
    $("acctPrev").addEventListener("click", function () { go(shift($("acctDate").value || today(), -1)); });
    $("acctNext").addEventListener("click", function () { go(shift($("acctDate").value || today(), 1)); });
    $("acctToday").addEventListener("click", function () { go(today()); });
    $("acctDate").addEventListener("change", function () { if ($("acctDate").value) go($("acctDate").value); });
    $("acctWeek").addEventListener("click", function (e) {
        var tr = e.target.closest ? e.target.closest("tr[data-day]") : null;
        if (tr) go(tr.getAttribute("data-day"));
    });
    $("acctCounted").addEventListener("input", function () {
        try { localStorage.setItem(countKey(), $("acctCounted").value); } catch (e) { }
        updateCount();
    });
    $("acctPrint").addEventListener("click", function () {
        var d = state.data;
        set("acctPrintStamp", "Printed " + new Date().toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi" }));
        var dn = (($("dealerHeaderName") && $("dealerHeaderName").textContent) || "").trim();
        if (dn) set("acctPrintDealer", dn);
        var old = document.title;
        if (d) document.title = "GasHub Daily Accounts " + d.date;      /* becomes the saved PDF's file name */
        window.print();
        setTimeout(function () { document.title = old; }, 1500);
    });
    $("acctCsv").addEventListener("click", downloadCsv);

    $("acctDate").value = today();
    $("acctDate").max = today();
    load(today());
    /* "Today" keeps itself fresh as orders complete, and at midnight (Nairobi) it rolls over to the new day with fresh zero totals.
       A past day that the dealer chose to look at does not change, so it stays put. */
    setInterval(function () { if (state.data && state.following && document.activeElement !== $("acctCounted")) load(today()); }, 60000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden && state.data && state.following && state.data.date !== today()) load(today()); });
});
