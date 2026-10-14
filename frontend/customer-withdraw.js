/* GasHub: Withdraw Points page.
   Shows the customer's points and what they are worth at the admin's rate, then sends a withdrawal request to the
   admin dashboard. Name and email come from the saved profile (the server reads them itself); the customer only
   types the M-Pesa number and the amount. The server does every check again. */
(function () {
    "use strict";
    var $ = function (id) { return document.getElementById(id); };
    var info = null, csrf = "", cdTimer = null, skew = 0;

    var ksh = function (n) { return "KSh " + (Number(n) || 0).toLocaleString("en-KE", { maximumFractionDigits: 2 }); };
    var num = function (n) { return (Number(n) || 0).toLocaleString("en-KE"); };
    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

    var toastTimer;
    function toast(msg) {
        var t = $("wdToast"); t.textContent = msg; t.classList.add("show");
        clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3200);
    }
    function show(which) {
        ["wdLoading", "wdGuest", "wdError", "wdContent"].forEach(function (id) { $(id).hidden = id !== which; });
    }

    function getCsrf() {
        if (csrf) return Promise.resolve(csrf);
        return fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (d) { csrf = (d && d.csrfToken) || ""; return csrf; });
    }

    function load() {
        if (!info) show("wdLoading");                      /* spinner only the first time; later reloads update in place, no flicker */
        return fetch("/api/customer/withdrawals", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })
            .then(function (r) {
                if (r.status === 401 || r.status === 403) { show("wdGuest"); return null; }
                return r.json().then(function (d) { return { ok: r.ok, d: d }; });
            })
            .then(function (res) {
                if (!res) return;
                if (!res.ok || !res.d || !res.d.success) throw new Error((res.d && res.d.message) || "Please try again.");
                info = res.d;
                skew = info.server_time ? new Date(info.server_time).getTime() - Date.now() : 0;
                render(); show("wdContent");
            })
            .catch(function (e) { info = null; $("wdErrorText").textContent = (e && e.message) || "Please check your connection and try again."; show("wdError"); });
    }

    /* countdown to the time the admin set for withdrawals to open again.
       skew = server clock minus this phone's clock, so a wrong phone clock cannot open it early */
    function stopCountdown() { if (cdTimer) { clearInterval(cdTimer); cdTimer = null; } }
    function tick(target) {
        var left = Math.max(0, target - (Date.now() + skew));
        if (left <= 0) { stopCountdown(); setTimeout(load, 600); return; }          /* time is up: reload, withdrawals are open now */
        var s = Math.floor(left / 1000);
        var two = function (n) { return (n < 10 ? "0" : "") + n; };
        $("wdCdD").textContent = Math.floor(s / 86400);
        $("wdCdH").textContent = two(Math.floor((s % 86400) / 3600));
        $("wdCdM").textContent = two(Math.floor((s % 3600) / 60));
        $("wdCdS").textContent = two(s % 60);
    }
    function startCountdown() {
        stopCountdown();
        var target = info.opens_at ? new Date(info.opens_at).getTime() : 0;
        if (!target) return;
        tick(target);
        cdTimer = setInterval(function () { tick(target); }, 1000);
    }

    function render() {
        $("wdPoints").textContent = num(info.balance);
        $("wdWorth").textContent = ksh(info.worth_ksh);
        $("wdName").textContent = info.name || "Not set";
        $("wdEmail").textContent = info.email || "Not set";

        var notice = "";
        if (info.opens_at) notice = "";                      /* the countdown card says it */
        else if (info.closed_by_admin) notice = "";
        else if (!info.enabled) notice = "";
        else if (info.has_pending) notice = "You have a withdrawal waiting for approval. You can send another once it is processed.";
        else if (info.worth_ksh < info.min_amount_ksh) notice = "The smallest withdrawal is " + ksh(info.min_amount_ksh) + ". Your GasHub Coins are worth " + ksh(info.worth_ksh) + " so far.";
        else if (!info.name || !info.email) notice = "Add your full name and email on your profile before withdrawing.";
        $("wdNotice").textContent = notice;

        /* when the money will be sent (set by the admin) */
        var pay = $("wdPayday");
        pay.textContent = info.payout_at ? "GasHub will send withdrawals to M-Pesa on " + new Date(info.payout_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " (Nairobi time)." : "";
        pay.hidden = !info.payout_at || !info.enabled;

        var blocked = !!notice || !info.enabled;
        $("wdSend").disabled = blocked; $("wdAll").disabled = blocked;
        $("wdAmount").disabled = blocked; $("wdPhone").disabled = blocked;
        $("wdAmount").max = info.max_amount_ksh || "";
        $("wdAmount").placeholder = "At least " + num(info.min_amount_ksh);
        /* closed: show ONLY the countdown (when a reopening time is set) or the "unavailable" card with the notify button */
        var closed = !info.enabled;
        var withTimer = closed && !!info.opens_at;
        ["wdBalanceCard", "wdFormCard", "wdNotice", "wdSub"].forEach(function (id) { $(id).hidden = closed || (id === "wdNotice" && !notice); });
        /* the customer's records always stay visible, also while withdrawals are closed */
        $("wdHistoryCard").hidden = closed && !info.history.length;
        $("wdClosed").hidden = !closed || withTimer;
        $("wdNotify").hidden = !!info.notify_requested;
        $("wdNotifyDone").hidden = !info.notify_requested;
        $("wdCountdown").hidden = !withTimer;
        if (withTimer) startCountdown(); else stopCountdown();
        $("wdMaxHint").textContent = info.max_coins ? "Most per withdrawal: " + num(info.max_coins) + " GasHub Coins." : "";
        $("wdMaxHint").hidden = !info.max_coins;
        renderFees(closed);
        renderHistory();
    }

    /* the charges GasHub takes off a withdrawal */
    function renderFees(closed) {
        var f = info.fees || { ranges: [] };
        var unit = f.unit === "ksh" ? "KSh " : "";
        var suffix = f.unit === "ksh" ? "" : " coins";
        $("wdFeesCard").hidden = closed || !f.ranges.length;
        if (!f.ranges.length) return;
        $("wdFeesIntro").textContent = "A small transaction charge is taken off each withdrawal. What is left is sent to your M-Pesa.";
        $("wdFees").innerHTML = f.ranges.map(function (r) {
            var range = r.to === null || r.to === undefined ? unit + num(r.from) + suffix + " and above" : unit + num(r.from) + " to " + unit + num(r.to) + suffix;
            return '<div class="wd-fee-row"><span>' + esc(range) + '</span><b>' + (r.fee > 0 ? esc(ksh(r.fee)) : "Free") + '</b></div>';
        }).join("");
    }

    /* what the customer will receive: the server works out the charge, so the page never needs the rate */
    var quoteTimer = null, quoteSeq = 0;
    function preview() {
        clearTimeout(quoteTimer);
        var a = Number($("wdAmount").value), box = $("wdPreview");
        if (!info || !(a > 0) || Math.floor(a) !== a) { box.hidden = true; return; }
        var seq = ++quoteSeq;
        quoteTimer = setTimeout(function () {
            getCsrf().then(function (token) {
                return fetch("/api/customer/withdrawals/quote", { method: "POST", credentials: "same-origin", cache: "no-store",
                    headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": token }, body: JSON.stringify({ amount: a }) });
            }).then(function (r) { return r.json(); }).then(function (d) {
                if (seq !== quoteSeq || !d || !d.success) return;
                $("wdPrevFee").textContent = ksh(d.fee_ksh); $("wdPrevNet").textContent = ksh(d.net_ksh);
                box.hidden = false;
            }).catch(function () { });
        }, 250);
    }

    function setErr(field, msg) {
        var wrap = $(field === "phone" ? "wdPhone" : "wdAmount").closest(".wd-field");
        $(field === "phone" ? "wdPhoneErr" : "wdAmountErr").textContent = msg || "";
        wrap.classList.toggle("bad", !!msg);
    }

    function validate() {
        var ok = true, phone = String($("wdPhone").value || "").replace(/[^\d+]/g, "");
        if (phone.charAt(0) === "+") phone = phone.slice(1);
        if (phone.indexOf("00254") === 0) phone = phone.slice(2);
        if (phone.indexOf("254") === 0) { phone = phone.slice(3); if (phone.charAt(0) === "0") phone = phone.slice(1); phone = "0" + phone; }
        else if (/^[17]\d{8}$/.test(phone)) phone = "0" + phone;
        if (!/^(07|01)\d{8}$/.test(phone)) { setErr("phone", "Enter a valid M-Pesa number, like 0712345678."); ok = false; } else setErr("phone", "");
        var a = Number($("wdAmount").value);
        if (!(a > 0) || Math.floor(a) !== a) { setErr("amount", "Enter the amount in whole shillings."); ok = false; }
        else if (a < info.min_amount_ksh) { setErr("amount", "The smallest withdrawal is " + ksh(info.min_amount_ksh) + "."); ok = false; }
        else if (a > info.max_amount_ksh) { setErr("amount", "The most you can withdraw is " + ksh(info.max_amount_ksh) + "."); ok = false; }
        else setErr("amount", "");
        return ok ? { phone: phone, amount: a } : null;
    }

    var STATUS_TEXT = { pending: "Waiting", approved: "Approved", paid: "Paid", rejected: "Rejected" };
    function renderHistory() {
        var box = $("wdHistory");
        if (!info.history.length) { box.innerHTML = '<p class="wd-empty">No withdrawals yet.</p>'; return; }
        box.innerHTML = info.history.map(function (w) {
            var fmt = function (v) { return new Date(v).toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
            var when = "Requested " + fmt(w.created_at);
            var done = w.processed_at ? (STATUS_TEXT[w.status] || w.status) + " " + fmt(w.processed_at) : "";
            return '<div class="wd-item"><div class="wd-row"><b>' + esc(ksh(w.amount_ksh)) + '</b><span class="wd-pill ' + esc(w.sending ? "approved" : w.status) + '">' + esc(w.sending ? "Sending" : (STATUS_TEXT[w.status] || w.status)) + '</span></div>' +
                '<div class="wd-meta">' + esc(w.reference) + ' · ' + esc(num(w.points)) + ' coins · to ' + esc(w.phone) + '</div>' +
                (w.fee_ksh > 0 ? '<div class="wd-meta">' + esc(ksh(w.amount_ksh)) + ' less ' + esc(ksh(w.fee_ksh)) + ' transaction charge</div>' : "") +
                '<div class="wd-meta">' + esc(when) + '</div>' +
                (done ? '<div class="wd-meta">' + esc(done) + '</div>' : "") +
                (w.status === "paid" && w.admin_note ? '<div class="wd-meta">' + esc(w.admin_note) + '</div>' : "") +
                (w.status === "rejected" && w.admin_note ? '<div class="wd-reason">Reason: ' + esc(w.admin_note) + '. Your GasHub Coins were returned.</div>' : "") +
                '</div>';
        }).join("");
    }

    $("wdAmount").addEventListener("input", function () { setErr("amount", ""); preview(); });
    $("wdPhone").addEventListener("input", function () { setErr("phone", ""); });
    $("wdAll").addEventListener("click", function () { $("wdAmount").value = info.max_amount_ksh || ""; setErr("amount", ""); preview(); });
    $("wdRetry").addEventListener("click", load);

    $("wdNotify").addEventListener("click", function () {
        var btn = $("wdNotify"); btn.disabled = true;
        getCsrf().then(function (token) {
            return fetch("/api/customer/withdrawals/notify", { method: "POST", credentials: "same-origin", cache: "no-store",
                headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": token }, body: "{}" });
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
            if (res.ok && res.d.success) { info.notify_requested = true; render(); toast(res.d.message); return; }
            if (res.d && res.d.open) return load();
            if (res.d && res.d.code === "csrf") csrf = "";
            toast((res.d && res.d.message) || "Could not save that. Please try again.");
        })
        .catch(function () { toast("Could not reach GasHub. Check your connection and try again."); })
        .then(function () { btn.disabled = false; });
    });

    $("wdForm").addEventListener("submit", function (e) {
        e.preventDefault();
        if (!info || $("wdSend").disabled) return;
        var v = validate(); if (!v) return;
        var btn = $("wdSend"); btn.disabled = true; btn.textContent = "Sending...";
        getCsrf().then(function (token) {
            return fetch("/api/customer/withdrawals", {
                method: "POST", credentials: "same-origin", cache: "no-store",
                headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": token },
                body: JSON.stringify({ amount: v.amount, phone: v.phone })
            });
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
            if (res.ok && res.d.success) {
                toast("Withdrawal request sent. We emailed and texted you the details.");
                $("wdAmount").value = ""; $("wdPhone").value = ""; $("wdPreview").hidden = true;
                return load();
            }
            if (res.d && res.d.code === "csrf") csrf = "";
            if (res.d && res.d.closed) { toast(res.d.message); return load(); }     /* the admin closed withdrawals meanwhile */
            if (res.d && res.d.field) setErr(res.d.field === "phone" ? "phone" : "amount", res.d.message);
            toast((res.d && res.d.message) || "Could not send your request. Please try again.");
        })
        .catch(function () { toast("Could not reach GasHub. Check your connection and try again."); })
        .then(function () { btn.textContent = "Send withdrawal request"; if (info) render(); });
    });

    /* the delivery place shown in the header, same as the other pages */
    try {
        var loc = JSON.parse(localStorage.getItem("gasHubLocation"));
        if (loc && loc.label) $("customerLocation").textContent = loc.label;
    } catch (e) { }

    load();
})();
