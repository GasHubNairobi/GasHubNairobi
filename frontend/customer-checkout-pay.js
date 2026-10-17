/* GASHUB CHECKOUT - PAY MODE
   Opened from the "your order is confirmed" SMS / email (customer-checkout.html?orderId=...&pay=1), or when the customer
   opens the app with a confirmed order they have not paid yet.
   The order already exists, so this page only does the payment:
     1. order total + GasHub Coins
     2. Cash on delivery / M-Pesa / Bank
     3. a success message, then the order page opens and the rest of the steps (messenger, delivery, tracking) continue.
   The server re-checks everything (POST /api/my/orders/:id/payment-method, /points, /payment-code, /api/payments/mpesa/*). */
(function () {
    "use strict";
    var R = window.GasHubRewards;
    var $ = function (id) { return document.getElementById(id); };
    var esc = R ? R.esc : function (v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
    var ref = new URLSearchParams(location.search).get("orderId");
    var ordersUrl = "customer-orders.html?orderId=" + encodeURIComponent(ref) + "&view=order";
    var order = null, finished = false, boxKey = "", account, stkOn;
    var coins = { loaded: false, enabled: false, rate: 0, min: 30, balance: null };

    function money(n) { return "KSh " + (Number(n) || 0).toLocaleString("en-KE"); }
    function paidStatus(s) { return /^(paid|complete|success)/i.test(String(s || "")); }
    function rowsHTML(list) {
        return '<div class="pv-rows">' + list.filter(Boolean).map(function (r) {
            return '<div class="pv-row' + (r[2] ? " " + r[2] : "") + '"><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>';
        }).join("") + "</div>";
    }
    async function headers(json) {
        var h = R ? R.authHeaders(json) : { Accept: "application/json", "Content-Type": "application/json" };
        var t = R ? await R.csrf() : ""; if (t) h["X-CSRF-Token"] = t;
        return h;
    }
    function setMsg(id, text, err) { var el = $(id); if (el) { el.className = "pv-msg" + (err ? " err" : ""); el.textContent = text || ""; } }

    /* ---------- order ---------- */
    function loginAgain() { location.replace("customer-login.html?next=" + encodeURIComponent("customer-checkout.html?orderId=" + ref + "&pay=1")); }
    async function fetchOrder() {
        try {
            var r = await fetch("/api/my/orders/" + encodeURIComponent(ref), { headers: R ? R.authHeaders(false) : {}, credentials: "same-origin", cache: "no-store" });
            if (r.status === 401) { loginAgain(); return null; }
            if (!r.ok) return null;
            var j = await r.json();
            var o = j.order || j.data || j;
            o.pending = (Array.isArray(o.payments) ? o.payments : []).filter(function (p) { return /pending/i.test(String(p.status)) && p.code; })[0] || null;
            o.rejected = !o.pending && (Array.isArray(o.payments) ? o.payments : []).some(function (p) { return /fail/i.test(String(p.status)); });
            o.chosen = o.paymentMethodChosen !== false;
            o.method = String(o.paymentMethod || "mpesa").toLowerCase();
            o.pickup = /pickup|collect/i.test(String(o.deliveryOption || ""));
            o.due = Math.max(0, (Number(o.total) || 0) - (Number(o.amountPaid) || 0));
            return o;
        } catch (e) { return null; }
    }
    async function reload() { var o = await fetchOrder(); if (o) { order = o; boxKey = ""; render(); } }

    /* what the customer still has to do here */
    function stillToPay(o) {
        if (paidStatus(o.paymentStatus)) return false;
        if (!o.chosen) return true;
        if (o.method === "cash") return false;
        return !o.pending;
    }
    function done() {
        if (finished) return;
        finished = true;
        var paid = paidStatus(order.paymentStatus), cash = order.method === "cash";
        $("pvSuccessTitle").textContent = paid ? "Payment successful" : (cash ? "Order confirmed" : "Payment submitted");
        $("pvSuccessText").textContent = paid ? "We received " + money(order.amountPaid || order.total) + ". Thank you!"
            : (cash ? "You will pay " + money(order.total) + " in cash on delivery." : "GasHub is confirming your payment.");
        $("pvSuccess").hidden = false;
        setTimeout(function () { location.href = ordersUrl; }, 2800);
    }

    /* ---------- summary ---------- */
    /* Is the coins option available for this order, and how much discount do the customer's coins allow?
       Checks, in order: the admin has coins switched on with a rate above zero (/api/points/config), the customer's balance
       could be read, they own at least the admin's minimum, and the bill is big enough to use that minimum.
       discount = usable coins x the exchange rate the admin set (usable = balance, capped so KSh 1 is always left to pay). */
    function coinOffer(o) {
        var st = coinState(o);
        if (!st) return { show: false };                                  /* switched off by admin, rate 0, or not signed in */
        var rate = coins.rate, min = coins.min;
        var usable = st.max, allowed = Math.floor(usable * rate);
        var base = { show: true, st: st, rate: rate, min: min, usable: usable, allowed: allowed };
        if (st.available < min) return Object.assign(base, { ok: false, why: "You need " + min.toLocaleString("en-KE") + " coins to spend them. You have " + st.available.toLocaleString("en-KE") + "." });
        if (usable < min) return Object.assign(base, { ok: false, why: "This order is too small to use " + min.toLocaleString("en-KE") + " coins on." });
        return Object.assign(base, { ok: true });
    }

    /* directly below the product price: the discount the customer's coins allow, worked out from the admin's exchange rate */
    function coinsLabel(o) {
        return "GasHub Coins discount" + (o.pointsUsed > 0 ? " (" + Number(o.pointsUsed).toLocaleString("en-KE") + " coins" + (coins.rate > 0 ? " \u00d7 " + money(coins.rate) : "") + ")" : "");
    }
    function discountBlock(o) { return ""; }

    function renderSummary() {
        var o = order, it = (o.items && o.items[0]) || {}, more = (o.items || []).length - 1;
        $("pvSummary").innerHTML =
            '<div class="summary-header"><div><p class="summary-label">ORDER ' + esc(o.orderId) + '</p><h2>Order Summary</h2></div></div>' +
            '<div class="selected-product"><div class="product-image"><img src="' + esc(it.image || "/Images/logo.png") + '" alt="" onerror="this.src=\'/Images/logo.png\'"></div>' +
            '<div class="product-info"><h3>' + esc(it.name || "Gas order") + (more > 0 ? " + " + more + " more" : "") + '</h3><p>' + esc(it.details || "") + '</p>' +
            '<div class="product-price-row"><span>Price</span><strong>' + esc(money(it.price)) + '</strong></div>' +
            discountBlock(o) +
            '<div class="product-price-row"><span>Quantity</span><strong>' + esc(it.quantity || 1) + '</strong></div></div></div>' +
            '<div class="summary-section"><span class="summary-title">Dealer</span><strong>' + esc(o.dealerName) + '</strong></div>' +
            '<div class="summary-breakdown">' +
            '<div class="summary-row"><span>Product</span><strong>' + esc(money(o.productTotal)) + '</strong></div>' +
            '<div class="summary-row"><span>Delivery</span><strong>' + esc(o.pickup ? "Pickup (free)" : money(o.deliveryFee)) + '</strong></div>' +
            (o.discount > 0 ? '<div class="summary-row"><span>' + esc(coinsLabel(o)) + '</span><strong>- ' + esc(money(o.discount)) + '</strong></div>' : "") +
            '<div class="summary-row total-row"><span>Total to pay</span><strong>' + esc(money(o.due)) + '</strong></div></div>';
    }

    /* ---------- GasHub Coins ---------- */
    async function loadCoins(force) {
        if (coins.loaded && !force) return;
        try {
            var r = await fetch("/api/points/config", { cache: "no-store", credentials: "same-origin" });
            var j = r.ok ? await r.json() : null;
            if (j) { coins.enabled = j.enabled !== false; coins.rate = Number(j.pointValueKsh) || 0; coins.min = Number(j.minRedeem) > 0 ? Number(j.minRedeem) : 30; }
        } catch (e) { }
        coins.balance = R ? await R.balance() : null;
        coins.loaded = true;
    }
    function coinState(o) {
        if (!coins.enabled || !(coins.rate > 0) || coins.balance == null) return null;
        var available = coins.balance + (o.pointsUsed || 0), gross = o.productTotal + o.deliveryFee;
        var maxByBill = Math.max(0, Math.floor((Math.ceil(gross) - 1) / coins.rate));
        return { available: available, max: Math.min(available, maxByBill), gross: gross };
    }
    /* as many coins as the order allows (KSh 1 is always left to pay), trimmed so no part of a coin is wasted at the admin's rate */
    function coinsToUse(st) {
        var d = Math.floor(st.max * coins.rate), n = Math.ceil(d / coins.rate - 1e-9);
        if (!(n >= coins.min) || n > st.max) n = st.max;
        return n;
    }
    /* one small on/off switch: on = the coins become money and come off the order pricing */
    function coinsHTML(o) {
        var st = coinState(o); if (!st) return "";
        var on = o.pointsUsed > 0, can = on || (st.available >= coins.min && st.max >= coins.min);
        return '<div class="pv-coins coin-switch-row"><span class="csr-label">' + R.chip(st.available, "credited") + '<b>Use my coins</b></span>' +
            '<label class="csr-sw' + (can ? "" : " off") + '"><input type="checkbox" id="coinUse"' + (on ? " checked" : "") + (can ? "" : " disabled") + ' aria-label="Use my GasHub Coins"><i></i></label>' +
            '<p class="pv-msg" id="coinMsg"></p></div>';
    }
    function bindCoins(o) {
        var cb = $("coinUse"), st = coinState(o);
        if (!cb || !st) return;
        cb.addEventListener("change", function () {
            if (cb.checked) setCoins(coinsToUse(st)); else if (o.pointsUsed > 0) setCoins(0);
        });
    }
    async function setCoins(n) {
        var btn = null, cb = $("coinUse");
        if (cb) cb.disabled = true;
        setMsg("coinMsg", "Saving...");
        try {
            var r = await fetch("/api/my/orders/" + encodeURIComponent(order.id) + "/points", { method: "POST", headers: await headers(true), credentials: "same-origin", body: JSON.stringify({ points: n }) });
            var j = {}; try { j = await r.json(); } catch (x) { }
            if (!r.ok || j.success === false) { setMsg("coinMsg", j.message || "We could not update your coins. Please try again.", true); if (btn) btn.disabled = false; if (cb) { cb.disabled = false; cb.checked = n === 0; } return; }
            await loadCoins(true); await reload();
        } catch (e) { setMsg("coinMsg", "No connection. Please try again.", true); if (btn) btn.disabled = false; if (cb) cb.disabled = false; }
    }

    /* ---------- render the payment box ---------- */
    async function getAccount() {
        if (account !== undefined) return account;
        try { var r = await fetch("/api/settings/payment-account", { cache: "no-store", credentials: "same-origin" }); var j = await r.json(); account = j && j.configured ? j : null; } catch (e) { account = null; }
        return account;
    }
    async function mpesaConfig() {
        if (stkOn !== undefined) return stkOn;
        try { var r = await fetch("/api/payments/mpesa/config", { cache: "no-store", credentials: "same-origin" }); var j = await r.json(); stkOn = { prompt: !!(j && j.enabled), verify: !!(j && j.verifyEnabled) }; } catch (e) { stkOn = { prompt: false, verify: false }; }
        return stkOn;
    }
    var bankInfo;
    async function bankConfig() {
        /* always fresh: the super admin can change the bank details or switch Bank off at any time */
        try { var r = await fetch("/api/payments/bank/config", { cache: "no-store", credentials: "same-origin" }); var j = await r.json(); bankInfo = j && j.configured ? j : null; } catch (e) { bankInfo = null; }
        return bankInfo;
    }
    /* which online methods the super admin has switched on (Admin > Settings > Super Admin Area > Online Payment Methods) */
    async function methodsConfig() {
        try { var r = await fetch("/api/settings/payment-methods", { cache: "no-store", credentials: "same-origin" }); var j = await r.json(); return { mpesa: !(j && j.mpesa === false), bank: !(j && j.bank === false) }; }
        catch (e) { return { mpesa: true, bank: true }; }
    }
    /* the backup Till: the server hands it out only after the phone prompt failed twice (or when the prompt is switched off) */
    async function manualInfo() {
        try {
            var r = await fetch("/api/payments/mpesa/manual?order_id=" + encodeURIComponent(order.id), { cache: "no-store", credentials: "same-origin", headers: R ? R.authHeaders(false) : {} });
            var j = await r.json();
            return j && j.available ? j : null;
        } catch (e) { return null; }
    }
    function manualHTML(m, o) {
        var how = m.type === "paybill" ? "Lipa na M-Pesa > Pay Bill" : (m.type === "till" ? "Lipa na M-Pesa > Buy Goods and Services" : "Send Money");
        var lines = (m.type === "paybill" ? [["Paybill number", m.number], ["Account number", m.account_number]]
            : (m.type === "till" ? [["Till number", m.number]] : [["Send Money to", m.number]]))
            .concat([["Name", m.account_name], ["Amount to pay", money(o.due), "tot"]]).filter(function (l) { return l[1]; });
        return '<div class="pv-banner" style="margin-top:12px"><b>Prompt not reaching your phone?</b> Pay manually: on your phone open M-Pesa, choose <b>' + esc(how) + '</b> and pay the exact amount below. Then type the M-Pesa code from the confirmation message in the box under this.</div>' +
            rowsHTML(lines) + (m.instructions ? '<p class="pv-note">' + esc(m.instructions) + '</p>' : "");
    }
    /* called after a prompt failed or timed out: shows the backup Till if the server now allows it */
    async function refreshManual() {
        var area = $("manualArea"); if (!area || order.method !== "mpesa") return;
        var m = await manualInfo();
        if (m && !area.innerHTML) { area.innerHTML = manualHTML(m, order); revealCode(); }
    }
    async function render() {
        var o = order, box = $("pvBox");
        if (!paidStatus(o.paymentStatus)) await loadCoins();
        $("pvIntro").textContent = o.dealerName + " confirmed your order " + o.orderId + ". Total to pay: " + money(o.due) + ".";
        renderSummary();
        if (/cancel|reject/i.test(String(o.status))) { box.innerHTML = '<p class="pv-note">This order was cancelled. <a href="' + esc(ordersUrl) + '">View order</a></p>'; return; }
        if (!stillToPay(o)) { done(); return; }
        if (!/confirm|process|prepar|out_for|deliver/i.test(String(o.status))) {
            box.innerHTML = '<p class="pv-note">Your dealer has not confirmed this order yet. You do not need to pay yet. We will SMS and email you as soon as it is confirmed.</p>';
            return;
        }

        /* A. choose how to pay */
        if (!o.chosen) {
            var sw = await methodsConfig();
            var k = "choose|" + o.total + "|" + o.pointsUsed + "|" + o.cashAllowed + "|" + coins.balance + "|" + sw.mpesa + "|" + sw.bank;
            if (k === boxKey) return; boxKey = k;
            $("pvTitle").textContent = "Choose how to pay";
            box.innerHTML = rowsHTML([["Total to pay", money(o.due), "tot"]]) +
                coinsHTML(o) +
                (o.cashAllowed !== false ? '<button type="button" class="pv-method" data-m="cash"><b>Cash on delivery</b><span>Pay the messenger when your gas ' + (o.pickup ? "is ready" : "arrives") + '.</span></button>'
                    : '<p class="pv-note">Cash on delivery is not available because you used GasHub coins on this order. Pay online instead.</p>') +
                (sw.mpesa ? '<button type="button" class="pv-method" data-m="mpesa"><b>M-Pesa</b><span>Get a prompt on your phone and enter your PIN.</span></button>' : "") +
                (sw.bank ? '<button type="button" class="pv-method" data-m="bank"><b>Bank</b><span>Pay by bank transfer to GasHub.</span></button>' : "") +
                ((!sw.mpesa && !sw.bank && o.cashAllowed === false) ? '<p class="pv-note">Online payment is not available right now. Please try again later or contact GasHub support.</p>' : "") +
                '<p class="pv-msg" id="pvPm"></p>';
            Array.prototype.forEach.call(box.querySelectorAll(".pv-method"), function (b) { b.addEventListener("click", function () { chooseMethod(b.getAttribute("data-m")); }); });
            bindCoins(o);
            return;
        }

        /* B. M-Pesa or bank: ALWAYS show the phone number / bank details and the code box, even before the payment API is switched on */
        var isBank = o.method === "bank";
        var pend = o.pending;
        if (!pend) await loadCoins();
        var cfg = isBank ? { prompt: false, verify: false } : await mpesaConfig();
        var swB = await methodsConfig();
        var man = (!isBank && swB.mpesa) ? await manualInfo() : null;
        var key = ["pay", o.method, o.total, o.pointsUsed, !!o.rejected, pend ? "p" : "", pend ? "" : coins.balance, swB.mpesa, swB.bank, cfg.prompt, man ? "m" : ""].join("|");
        if (key === boxKey) return; boxKey = key;
        /* the super admin switched this method off: the customer picks another one (unless a payment is already being confirmed) */
        if (!pend && ((isBank && !swB.bank) || (!isBank && !swB.mpesa))) {
            $("pvTitle").textContent = "Choose how to pay";
            box.innerHTML = '<p class="pv-note"><b>' + (isBank ? "Bank payment" : "M-Pesa payment") + '</b> is not available right now. Please choose another way to pay.</p><p class="pv-change"><a href="#" id="changeMethod">Choose another payment method</a></p>';
            $("changeMethod").addEventListener("click", function (e) { e.preventDefault(); order.chosen = false; boxKey = ""; render(); });
            return;
        }
        $("pvTitle").textContent = isBank ? "Pay by bank" : "Pay with M-Pesa";
        var html = rowsHTML([["Total to pay", money(o.due), "tot"]]) + (pend ? "" : coinsHTML(o));

        if (!isBank) {
            html += '<p class="pv-note">Enter the M-Pesa number you want to pay with. We send a prompt to that phone and you enter your M-Pesa PIN.</p>' +
                '<form class="pv-form" id="stkForm" autocomplete="off"><input id="stkPhone" type="tel" inputmode="numeric" maxlength="14" placeholder="M-Pesa number, e.g. 0712345678" value="' + esc(String(o.deliveryPhone || "").replace(/[^\d+]/g, "")) + '"><button type="submit" class="pv-btn" id="stkBtn">Pay ' + esc(money(o.due)) + '</button></form>' +
                '<p class="pv-msg" id="stkMsg"></p>';
            if (!cfg.prompt && !man) html += '<div class="pv-banner">M-Pesa phone payment is not available right now. If you already paid GasHub another way, enter your M-Pesa code below.</div>';
            html += '<div id="manualArea">' + (man ? manualHTML(man, o) : "") + '</div>';
        } else {
            var bk = await bankConfig(), lines = bk ? [["Bank", bk.bank_name], ["Account name", bk.account_name], ["Account number", bk.account_number], ["Branch", bk.branch], ["Paybill", bk.paybill]] : [];
            html += '<p class="pv-note">Pay <b>' + esc(money(o.due)) + '</b> to the GasHub bank account below. Use <b>' + esc(o.orderId) + '</b> as the payment reference, then enter the bank reference you receive.</p>';
            html += bk ? rowsHTML(lines.filter(function (l) { return l[1]; })) + (bk.instructions ? '<p class="pv-note">' + esc(bk.instructions) + '</p>' : "")
                : '<div class="pv-banner">GasHub\'s bank details are being set up and will show here. Choose M-Pesa or Cash on delivery if you need to pay now.</div>';
        }

        /* the code box: for a payment that was slow to confirm, or made another way */
        var showCode = !!pend || !!o.rejected || isBank || (!cfg.prompt) || !!man;
        html += '<div id="codeArea"' + (showCode ? "" : " hidden") + ' class="pv-codearea">' +
            '<p class="pv-note"><b>' + (isBank ? "Paid by bank?" : "Already paid?") + '</b> Enter your ' + (isBank ? "bank reference" : "M-Pesa code") + ' and we will check that the payment was received.</p>' +
            (pend ? '<div class="pv-banner">We received your code <b>' + esc(pend.code) + '</b>. GasHub is confirming your payment.</div>' : "") +
            (o.rejected ? '<p class="pv-msg err">GasHub could not find that payment. Check the code and send it again, or pay again.</p>' : "") +
            '<form class="pv-form" id="payCodeForm" autocomplete="off"><input id="payCodeInput" type="text" maxlength="' + (isBank ? 30 : 12) + '" placeholder="' + (isBank ? "Bank reference / transaction code" : "M-Pesa code, e.g. QGH7XK2LMN") + '"><button type="submit" class="pv-btn" id="payCodeBtn">Check payment</button></form>' +
            '<div id="codeResult"></div></div>';
        if (!showCode) html += '<p class="pv-change"><a href="#" id="showCode">Already paid? Enter your M-Pesa code</a></p>';
        if (!pend) html += '<p class="pv-change"><a href="#" id="changeMethod">Change payment method</a></p>';
        box.innerHTML = html;
        if (!pend) bindCoins(o);
        var ch = $("changeMethod"); if (ch) ch.addEventListener("click", function (e) { e.preventDefault(); order.chosen = false; boxKey = ""; render(); });
        var sc = $("showCode"); if (sc) sc.addEventListener("click", function (e) { e.preventDefault(); revealCode(); });
        $("payCodeForm").addEventListener("submit", submitCode);
        if ($("stkForm")) $("stkForm").addEventListener("submit", submitStk);
    }
    function revealCode() { var c = $("codeArea"); if (c) { c.hidden = false; var l = $("showCode"); if (l) l.parentNode.hidden = true; } }

    /* ---------- actions ---------- */
    async function chooseMethod(method) {
        var btns = document.querySelectorAll(".pv-method");
        Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
        setMsg("pvPm", "Saving...");
        try {
            var r = await fetch("/api/my/orders/" + encodeURIComponent(order.id) + "/payment-method", { method: "POST", headers: await headers(true), credentials: "same-origin", body: JSON.stringify({ method: method }) });
            var j = {}; try { j = await r.json(); } catch (x) { }
            if (!r.ok || j.success === false) { setMsg("pvPm", j.message || "We could not save your choice. Please try again.", true); Array.prototype.forEach.call(btns, function (b) { b.disabled = false; }); return; }
            await reload();
        } catch (e) { setMsg("pvPm", "No connection. Please try again.", true); Array.prototype.forEach.call(btns, function (b) { b.disabled = false; }); }
    }
    /* the customer typed a code: check it. paid -> success. Not found / short / used -> say so and offer to try again or pay again. */
    async function submitCode(ev) {
        ev.preventDefault();
        var bank = order.method === "bank", btn = $("payCodeBtn"), res = $("codeResult");
        var val = $("payCodeInput").value.trim().toUpperCase().replace(/\s+/g, "");
        var okFormat = bank ? /^[A-Z0-9\-]{5,30}$/.test(val) : /^[A-Z0-9]{8,12}$/.test(val);
        if (!okFormat) { res.innerHTML = '<p class="pv-msg err">' + (bank ? "Enter the bank reference from your bank confirmation." : "Enter the M-Pesa code from your confirmation message, e.g. QGH7XK2LMN.") + '</p>'; return; }
        btn.disabled = true; res.innerHTML = '<p class="pv-msg">Checking your payment...</p>';
        try {
            var r = await fetch(bank ? "/api/payments/bank/verify" : "/api/payments/mpesa/verify-code", { method: "POST", headers: await headers(true), credentials: "same-origin",
                body: JSON.stringify(bank ? { order_id: order.id, reference: val } : { order_id: order.id, code: val }) });
            var j = {}; try { j = await r.json(); } catch (x) { }
            if (!r.ok || j.success === false) { res.innerHTML = '<p class="pv-msg err">' + esc(j.message || "We could not check that. Please try again.") + '</p>'; btn.disabled = false; return; }
            if (j.status === "paid") { await reload(); return; }
            if (j.status === "unavailable") {
                /* automatic checking is not switched on yet: GasHub confirms the code by hand, as before */
                var r2 = await fetch("/api/my/orders/" + encodeURIComponent(order.id) + "/payment-code", { method: "POST", headers: await headers(true), credentials: "same-origin", body: JSON.stringify({ mpesa_code: val }) });
                var j2 = {}; try { j2 = await r2.json(); } catch (x) { }
                if (!r2.ok || j2.success === false) { res.innerHTML = '<p class="pv-msg err">' + esc(j2.message || "We could not save your code. Please try again.") + '</p>'; btn.disabled = false; return; }
                await reload(); return;
            }
            /* not_found / short / already_used: the payment is NOT confirmed. Give the customer the next step. */
            res.innerHTML = '<div class="pv-fail"><b>Payment not confirmed</b><p>' + esc(j.message || "We could not find that payment.") + '</p>' +
                '<div class="pv-fail-btns"><button type="button" class="pv-btn" id="retryCode">Check again</button><button type="button" class="pv-btn pv-alt" id="payAgain">' + (bank ? "See bank details again" : "Pay again") + '</button></div></div>';
            btn.disabled = false;
            $("retryCode").addEventListener("click", function () { res.innerHTML = ""; $("payCodeInput").focus(); $("payCodeInput").select(); });
            $("payAgain").addEventListener("click", function () {
                res.innerHTML = ""; $("payCodeInput").value = "";
                var t = $("stkPhone") || $("pvBox"); try { t.scrollIntoView({ behavior: "smooth", block: "center" }); if (t.focus) t.focus(); } catch (e) { }
            });
        } catch (e) { res.innerHTML = '<p class="pv-msg err">No connection. Please try again.</p>'; btn.disabled = false; }
    }
    /* send the M-Pesa prompt to the phone, then wait for the answer */
    async function submitStk(ev) {
        ev.preventDefault();
        var btn = $("stkBtn"), phone = $("stkPhone").value.trim();
        if (!/^(\+?254|0)?[17]\d{8}$/.test(phone.replace(/\s+/g, ""))) { setMsg("stkMsg", "Enter a valid Safaricom number, e.g. 0712345678.", true); return; }
        btn.disabled = true; setMsg("stkMsg", "Sending the prompt to your phone...");
        try {
            var r = await fetch("/api/payments/mpesa/stk-push", { method: "POST", headers: await headers(true), credentials: "same-origin", body: JSON.stringify({ order_id: order.id, phone: phone }) });
            var j = {}; try { j = await r.json(); } catch (x) { }
            if (!r.ok || !j.checkoutRequestId) { setMsg("stkMsg", j.message || "We could not send the prompt. Please try again.", true); btn.disabled = false; revealCode(); refreshManual(); return; }
            setMsg("stkMsg", "Check your phone and enter your M-Pesa PIN...");
            var started = Date.now(), shown = false;
            while (Date.now() - started < 130000) {
                await new Promise(function (res) { setTimeout(res, 3000); });
                if (!shown && Date.now() - started > 25000) { shown = true; revealCode(); setMsg("stkMsg", "Taking long? If you already entered your PIN, enter your M-Pesa code below and we will check it."); }
                var s = await fetch("/api/payments/mpesa/status?order_id=" + encodeURIComponent(order.id) + "&checkout_request_id=" + encodeURIComponent(j.checkoutRequestId), { credentials: "same-origin", cache: "no-store" });
                var sj = s.ok ? await s.json().catch(function () { return null; }) : null;
                if (!sj) continue;
                if (sj.status === "paid") { await reload(); return; }
                if (sj.status && sj.status !== "pending") { setMsg("stkMsg", (sj.message || "The payment did not go through.") + " You can pay again, or enter your M-Pesa code if you already paid.", true); btn.disabled = false; btn.textContent = "Pay again"; revealCode(); refreshManual(); return; }
            }
            setMsg("stkMsg", "No confirmation yet. If M-Pesa took the money, enter your M-Pesa code below. Otherwise pay again.", true);
            btn.disabled = false; btn.textContent = "Pay again"; revealCode(); refreshManual();
        } catch (e) { setMsg("stkMsg", "No connection. Please try again.", true); btn.disabled = false; }
    }

    /* has the super admin switched a method on/off (or the prompt state changed) since this box was drawn? */
    var lastSwitches = "";
    async function switchesChanged() {
        var sw = await methodsConfig(), m = order.method === "mpesa" && !order.pending ? await manualInfo() : null;
        var now = [sw.mpesa, sw.bank, m ? "m" : ""].join("|"), was = lastSwitches; lastSwitches = now;
        return was !== "" && was !== now;
    }

    /* ---------- start ---------- */
    async function start() {
        $("payView").hidden = false;
        document.title = "Pay for your order | GasHub";
        if (!R) { $("pvBox").innerHTML = '<p class="pv-note">Something went wrong loading this page. Please refresh.</p>'; return; }
        try { await R.loadConfig(); } catch (e) { }
        var o = await fetchOrder();
        if (!o) { $("pvBox").innerHTML = '<p class="pv-note">We could not find this order. <a href="customer-orders.html">View my orders</a></p>'; return; }
        order = o; render();
        /* pick up changes (e.g. GasHub confirmed the money) while this page is open */
        setInterval(async function () { if (document.hidden || finished) return; var f = await fetchOrder(); if (f) { var changed = f.paymentStatus !== order.paymentStatus || f.paymentMethod !== order.paymentMethod || !!f.pending !== !!order.pending; order = f; if (!changed && order.chosen) changed = await switchesChanged(); if (changed) { boxKey = ""; render(); } } }, 15000);
    }
    start().catch(function (e) { console.error(e); });
})();
