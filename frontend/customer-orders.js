/* GasHub customer orders.
   - No order in the address: shows the customer's saved orders (GET /api/my/orders)
   - ?orderId=...: loads that order from /api/my/orders/:id (only the signed-in customer's own order)
   - Shows what was bought, the dealer, how long delivery took, payment and GasHub points
   - Works out when the gas will run out and sets a refill reminder (customer-rewards.js) */
(function () {
    "use strict";

    var R = window.GasHubRewards, loader = window.CustomerLoader;
    var $ = function (id) { return document.getElementById(id); };
    function hideLoader() { if (loader) loader.hide(); }
    if (!R) { $("orderLoading").innerHTML = "<p>Something went wrong loading this page. Please refresh.</p>"; hideLoader(); return; }

    var esc = R.esc, DAY = 86400000, MIN = 60000;
    var STORE_LAST = "gasHubLastOrder", STORE_LIST = "gasHubOrders";
    var params = new URLSearchParams(location.search);
    var wantId = params.get("orderId") || params.get("id");
    var signedOut = false, cfg = R.config(), order = null, source = "local", armTimer = null, msgTimer = null;

    var CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
    var CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    var CYL = '<svg viewBox="0 0 60 90" aria-hidden="true"><rect x="22" y="2" width="16" height="10" rx="3" fill="#444"/><rect x="8" y="14" width="44" height="72" rx="16" fill="#e03131"/><text x="30" y="56" text-anchor="middle" font-family="Arial" font-weight="800" font-size="15" fill="#ffc20e">GAS</text></svg>';
    var VBADGE = '<span class="vb" title="Verified by GasHub"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#1d7af3" d="M12 1.8l2.6 1.9 3.2-.2 1.1 3 2.7 1.8-1 3.1 1 3.1-2.7 1.8-1.1 3-3.2-.2-2.6 1.9-2.6-1.9-3.2.2-1.1-3-2.7-1.8 1-3.1-1-3.1 2.7-1.8 1.1-3 3.2.2z"/><path fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M7.8 12.2l3 3 5.6-6"/></svg></span>';
    /* "Completed" once the dealer has completed the order, "Delivered" while it is only delivered */
    function stageLabel(stage, rawStatus) {
        if (stage === 3 && /^completed$/i.test(String(rawStatus || ""))) return "Completed";
        return STATUS[stage];
    }
    var STATUS = { "-1": "Cancelled", 0: "Pending", 1: "Confirmed", 2: "Out for delivery", 3: "Delivered" };

    /* ================= MENU + LOCATION ================= */
    var menu = $("mobileMenu"), scrim = $("menuOverlay");
    function openMenu() { menu.classList.add("active"); scrim.classList.add("show"); menu.setAttribute("aria-hidden", "false"); }
    function closeMenu() { menu.classList.remove("active"); scrim.classList.remove("show"); menu.setAttribute("aria-hidden", "true"); }
    $("menuBtn").addEventListener("click", openMenu);
    $("closeMenuBtn").addEventListener("click", closeMenu);
    scrim.addEventListener("click", closeMenu);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); });
    (function () { var l = R.read("gasHubLocation", null); if (l && l.label) $("customerLocation").textContent = l.label; })();

    /* ================= HELPERS ================= */
    function money(n) { return "KSh " + (Number(n) || 0).toLocaleString("en-KE"); }
    function toMs(v) {
        if (v == null || v === "") return null;
        if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
        var t = new Date(v).getTime();
        return isNaN(t) ? null : t;
    }
    function fmtDT(ms) { return new Date(ms).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }
    /* exact moment, with seconds - for the "Order times" list */
    function fmtExact(ms) { return new Date(ms).toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }); }
    function fmtD(ms) { return new Date(ms).toLocaleDateString("en-KE", { weekday: "short", day: "numeric", month: "short" }); }
    function fmtT(ms) { return new Date(ms).toLocaleTimeString("en-KE", { hour: "numeric", minute: "2-digit" }); }
    function dur(ms) {
        var m = Math.round(Math.max(0, ms) / MIN);
        if (m < 1) return "under 1 min";
        if (m < 60) return m + " min";
        var h = Math.floor(m / 60), r = m % 60;
        if (h < 24) return h + " hr" + (r ? " " + r + " min" : "");
        var d = Math.floor(h / 24);
        return d + (d === 1 ? " day" : " days");
    }
    function flash(text, err) {
        var el = $("actionMessage");
        el.textContent = text; el.className = "msg" + (err ? " err" : "");
        clearTimeout(msgTimer); msgTimer = setTimeout(function () { el.textContent = ""; }, 4500);
    }
    function copy(text) { return (navigator.clipboard && navigator.clipboard.writeText) ? navigator.clipboard.writeText(text) : Promise.reject(); }
    function rows(list) {
        return list.filter(function (r) { return r && r[1] != null && String(r[1]).trim() !== ""; }).map(function (r) {
            return '<div class="ir' + (r[3] ? " " + r[3] : "") + '"><span>' + esc(r[0]) + '</span><b' + (r[2] ? ' class="' + r[2] + '"' : "") + '>' + esc(r[1]) + '</b></div>';
        }).join("");
    }

    /* ================= LOAD ================= */
    async function fetchApi(id) {
        if (!id) return null;
        try {
            var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 5000);
            var r = await fetch("/api/my/orders/" + encodeURIComponent(id), { headers: R.authHeaders(false), credentials: "same-origin", cache: "no-store", signal: ctl.signal });
            clearTimeout(t);
            if (r.status === 401) signedOut = true;
            if (!r.ok) return null;
            var j = await r.json();
            return j.order || j.data || j;
        } catch (e) { return null; }
    }
    function fromLocal(id) {
        var list = R.read(STORE_LIST, []); if (!Array.isArray(list)) list = [];
        var last = R.read(STORE_LAST, null);
        if (!id) return last;
        return (last ? [last] : []).concat(list).filter(function (o) { return String(o.orderId != null ? o.orderId : o.id) === String(id); })[0] || null;
    }
    async function getOrder() {
        var api = await fetchApi(wantId);
        if (api) { source = "api"; return api; }
        source = "local";
        return fromLocal(wantId);
    }

    /* ================= NORMALIZE ================= */
    function stageOf(status) {
        var s = String(status || "pending").toLowerCase().replace(/[_-]+/g, " ");
        if (/cancel|reject|fail/.test(s)) return -1;
        if (/complete|delivered|done/.test(s)) return 3;
        if (/out for|dispatch|delivery|transit|on the way|shipped/.test(s)) return 2;
        if (/confirm|approve|accept|process|prepar/.test(s)) return 1;
        return 0;
    }
    function normalize(o) {
        var raw = (Array.isArray(o.items) && o.items.length) ? o.items : ((Array.isArray(o.products) && o.products.length) ? o.products : null);
        if (!raw) raw = [{ id: o.productId, name: o.productName || o.product_name || o.name, details: o.details || o.productDetails, image: o.image || o.productImage, quantity: o.quantity, price: o.price }];
        var items = raw.map(function (i) {
            var name = i.name || i.productName || i.product_name || "Gas product";
            var details = i.details || i.size || i.productDetails || i.cylinder_size || "";
            var qty = Number(i.quantity != null ? i.quantity : i.qty) || 1;
            var price = Number(i.price != null ? i.price : (i.unit_price != null ? i.unit_price : i.selling_price)) || 0;
            var given = i.points != null ? i.points : i.pointsAwarded;
            return {
                id: i.id != null ? i.id : (i.productId != null ? i.productId : i.product_id),
                name: String(name), details: String(details), image: String(i.image || i.productImage || i.image_url || ""),
                qty: qty, price: price, kg: R.sizeKg(details) || R.sizeKg(name),
                pts: given != null && isFinite(Number(given)) ? Number(given) : R.pointsFor(price * qty, cfg)
            };
        });
        var dRaw = o.dealer, dObj = (dRaw && typeof dRaw === "object") ? dRaw : {};
        var placedAt = toMs(o.createdAt || o.created_at || o.date || o.orderDate);
        var stage = stageOf(o.status || o.orderStatus || o.order_status);
        var deliveredAt = toMs(o.deliveredAt || o.completedAt || o.delivered_at || o.completed_at);
        if (stage === 3 && !deliveredAt) deliveredAt = toMs(o.updatedAt || o.updated_at) || placedAt;
        var productTotal = Number(o.productTotal) || items.reduce(function (s, i) { return s + i.price * i.qty; }, 0);
        var deliveryFee = Number(o.deliveryFee) || Number(o.deliveryPrice) || Number(o.delivery_fee) || 0;
        var discount = Number(o.discount) || Number(o.pointsDiscount) || 0;
        var etaAt = toMs(o.etaAt || o.estimatedDeliveryAt);
        if (!etaAt && o.etaMinutes && placedAt) etaAt = placedAt + Number(o.etaMinutes) * MIN;
        return {
            id: String(o.orderId != null ? o.orderId : (o.id != null ? o.id : "—")),
            raw: o, items: items, stage: stage,
            placedAt: placedAt, confirmedAt: toMs(o.confirmedAt || o.confirmed_at || o.acceptedAt),
            dispatchedAt: toMs(o.dispatchedAt || o.outForDeliveryAt || o.dispatched_at || o.out_for_delivery_at),
            completedAt: toMs(o.completedAt || o.completed_at),
            deliveredAt: deliveredAt, etaAt: etaAt,
            dealerName: String(dObj.name || (typeof dRaw === "string" ? dRaw : "") || o.dealerName || o.dealer_name || "GasHub Dealer"),
            dealerLogo: String(o.dealerLogo || o.dealer_logo || dObj.logo || ""),
            dealerId: o.dealerId != null ? o.dealerId : (o.dealer_id != null ? o.dealer_id : (dObj.id != null ? dObj.id : null)),
            dealerLoc: String(o.dealerLocation || o.dealer_location || dObj.location || o.location || ""),
            dealerVerified: !!(o.dealerVerified || o.dealer_verified || dObj.verified),
            /* the server sends the full number while the order is open and a masked one 2 days after it ends */
            dealerPhone: String(o.dealerPhone || ""), contactExpired: !!o.contactExpired,
            pickup: /pickup|collect/i.test(String(o.deliveryOption || o.delivery || "")),
            county: o.county || o.deliveryCounty, town: o.town || o.deliveryTown,
            address: o.deliveryAddress || o.address, landmark: o.deliveryLandmark || o.landmark,
            method: String(o.paymentMethod || o.payment_method || "mpesa"),
            methodChosen: o.paymentMethodChosen !== false && o.payment_method_chosen !== false,
            cashAllowed: o.cashAllowed !== false,
            pointsUsed: Number(o.pointsUsed) || 0,
            payStatus: String(o.paymentStatus || o.payment_state || o.payment_status || "pending"),
            receipt: o.mpesaReceipt || o.mpesa_receipt || o.transactionId || o.transaction_id || o.paymentReference || "",
            paidAt: toMs(o.paidAt || o.paid_at),
            productTotal: productTotal, deliveryFee: deliveryFee, discount: discount,
            total: Number(o.total) || (productTotal + deliveryFee - discount),
            pointsAwarded: o.pointsAwarded != null && isFinite(Number(o.pointsAwarded)) ? Number(o.pointsAwarded) : (o.points_awarded != null && isFinite(Number(o.points_awarded)) ? Number(o.points_awarded) : null),
            customerName: o.customerName || o.customer_name || (o.customer && o.customer.name) || "",
            customerPhone: o.customerPhone || o.customer_phone || o.phone || (o.customer && o.customer.phone) || "",
            customerEmail: o.customerEmail || o.customer_email || o.email || (o.customer && o.customer.email) || "",
            notes: String(o.orderNotes || o.notes || "").trim(),
            lat: o.latitude != null ? Number(o.latitude) : null, lng: o.longitude != null ? Number(o.longitude) : null,
            rider: o.rider && typeof o.rider === "object" ? o.rider : null,
            discountNote: String(o.discountNote || ""), amountPaid: Number(o.amountPaid) || 0,
            deliveryPhone: String(o.deliveryPhone || ""),
            refundStatus: String(o.refundStatus || ""), refundAmount: Number(o.refundAmount) || 0, refundPhone: String(o.refundPhone || ""),
            refundReceipt: String(o.refundReceipt || ""), refundedAt: toMs(o.refundedAt)
        };
    }
    function gasItem() { return order.items.filter(function (i) { return i.kg; })[0] || null; }
    /* a paid order earns a fixed number of points (50), added once when the payment is confirmed */
    /* online and cash payments are valued (and switched on or off) separately by GasHub */
    function earnsFor() {
        var cash = order.methodChosen && /cash/i.test(order.method);
        var on = cash ? cfg.cashEnabled !== false : cfg.onlineEnabled !== false;
        var pts = cash ? cfg.cashPoints : cfg.onlinePoints;
        if (pts == null) pts = cfg.pointsPerOrder || 0;
        return on ? (pts || 0) : 0;
    }
    function pointsTotal() { return order.pointsAwarded > 0 ? order.pointsAwarded : earnsFor(); }
    function pointsState() { return order.stage === -1 ? "none" : (order.pointsAwarded > 0 ? "credited" : "pending"); }
    /* what the cancelled-order banner says: plain, and clear about the customer's money */
    function cancelText() {
        var base = "This order was cancelled.";
        if (order.refundStatus === "pending") {
            return base + " Your refund of " + money(order.refundAmount || order.total) + " is on its way. GasHub will send it back to " + (order.refundPhone || "your M-Pesa number") + " and it will show here once it is sent.";
        }
        if (order.refundStatus === "refunded") {
            return base + " " + money(order.refundAmount || order.total) + " was refunded to " + (order.refundPhone || "your M-Pesa number") + (order.refundReceipt ? " (M-Pesa receipt " + order.refundReceipt + ")" : "") + ".";
        }
        return base;
    }
    /* an M-Pesa / bank order that GasHub has already been paid for: cancelling it starts a refund */
    function paidOnline() { return /^paid$/i.test(order.payStatus) && !/cash/i.test(order.method); }
    function payInfo() {
        var s = order.payStatus.toLowerCase();
        if (order.refundStatus === "refunded") return { text: "Refunded", cls: "" };
        if (order.refundStatus === "pending") return { text: "Refund on its way", cls: "unpaid" };
        if (/paid|complete|success/.test(s)) return { text: "Paid", cls: "paid" };
        if (/fail/.test(s)) return { text: "Failed", cls: "unpaid" };
        if (/refund/.test(s) || order.refundStatus === "refunded") return { text: "Refunded", cls: "" };
        if (order.refundStatus === "pending") return { text: "Refund on its way", cls: "unpaid" };
        if (order.stage === 0) return { text: "Pay after the dealer confirms", cls: "unpaid" };
        if (!order.methodChosen) return { text: "Choose how to pay", cls: "unpaid" };
        /* cash is paid to the messenger and confirmed by the dealer; M-Pesa goes to GasHub, which confirms the money */
        if (/cash/i.test(order.method)) return { text: "Payment on delivery", cls: "unpaid" };
        if (pendingPayment()) return { text: "Confirming your payment", cls: "unpaid" };
        return { text: "Waiting for your payment", cls: "unpaid" };
    }
    function methodLabel() {
        if (!order.methodChosen) return "Not chosen yet";
        var m = order.method.toLowerCase().replace(/[_-]+/g, " ");
        if (/mpesa|m pesa/.test(m)) return "M-Pesa";
        if (/cash/.test(m)) return "Cash on delivery";
        if (/bank/.test(m)) return "Bank transfer";
        if (/card/.test(m)) return "Card";
        return order.method || "M-Pesa";
    }

    /* ================= RENDER ================= */
    function render() {
        var o = order;
        $("orderId").textContent = o.id;
        $("orderTitle").textContent = o.items.length > 1 ? o.items[0].name + " + " + (o.items.length - 1) + " more" : o.items[0].name;
        $("placedDate").textContent = o.placedAt ? "Placed " + fmtDT(o.placedAt) : "Order placed";
        $("sumTotal").textContent = money(o.total);
        $("sumPoints").innerHTML = R.chip(pointsTotal(), pointsState());
        var pill = $("orderStatus");
        pill.textContent = stageLabel(o.stage, o.raw.status); pill.className = "pill" + (o.stage === 3 ? " s3" : (o.stage === -1 ? " sx" : ""));
        $("cancelBanner").hidden = o.stage !== -1;
        $("cancelBanner").textContent = cancelText();
        $("cancelBtn").hidden = !(o.stage === 0 || o.stage === 1);
        renderTimeline(); renderTime(); renderItems(); renderDealer(); renderRider(); renderLists(); renderPoints(); renderRefill(); renderPay();
        if (window.GasHubLiveTrack && source === "api") window.GasHubLiveTrack.update(o);   /* live map (delivery) or shop location (pickup) */
        var notes = $("notesCard"); notes.hidden = !o.notes; $("orderNotes").textContent = o.notes;
    }

    function renderTimeline() {
        var o = order, times = [o.placedAt, o.confirmedAt, o.dispatchedAt, o.deliveredAt];
        var defaults = ["Order received", "Waiting for the dealer", "On the way to you", "Order delivered"];
        $("tl").classList.toggle("cancelled", o.stage === -1);
        for (var i = 0; i < 4; i++) {
            var el = $("st" + i), done = o.stage === -1 ? i === 0 : (o.stage === 3 ? true : i < o.stage), now = o.stage !== -1 && o.stage !== 3 && i === o.stage;
            el.className = "st" + (done ? " done" : (now ? " now" : ""));
            el.querySelector(".dot").innerHTML = done ? CHECK : String(i < 2 ? i + 1 : i + 2);
            var t = times[i], prev = i > 0 ? times[i - 1] : null, txt;
            if (t) txt = fmtT(t) + (prev && t >= prev ? " · +" + dur(t - prev) : "");
            else txt = now ? "In progress" : defaults[i];
            $("tm" + i).textContent = txt;
        }
        renderPayStep();
    }

    /* The extra step after "Confirmed": "Paid", or "Payment on delivery" when the customer chose cash */
    function renderPayStep() {
        var o = order, el = $("stPay"), title = $("payStepTitle"), tm = $("tmPay");
        var paid = /^(paid|complete|success)/i.test(o.payStatus);
        var cash = o.methodChosen && /cash/i.test(o.method);
        var active = o.stage >= 1 && !paid;
        title.textContent = cash ? "Payment on delivery" : "Paid";
        el.className = "st" + (paid ? " done" : (o.stage !== -1 && active ? " now" : ""));
        el.querySelector(".dot").innerHTML = paid ? CHECK : "3";
        if (paid) tm.textContent = (cash ? "Cash received" : "Payment confirmed") + (o.paidAt ? " · " + fmtT(o.paidAt) : "");
        else if (o.stage === -1 || o.stage === 0) tm.textContent = "After the dealer confirms";
        else if (!o.methodChosen) tm.textContent = "Choose how to pay";
        else if (cash) tm.textContent = "Pay the messenger when your gas arrives";
        else tm.textContent = pendingPayment() ? "Confirming your payment" : "Waiting for your payment";
    }

    function renderTime() {
        var o = order, el = $("timeTaken"), now = Date.now();
        if (o.stage === -1 || !o.placedAt) { el.hidden = true; return; }
        if (o.stage === 3) {
            if (!o.deliveredAt || o.deliveredAt < o.placedAt) { el.hidden = true; return; }
            el.innerHTML = CLOCK + "<div><b>Delivered in " + esc(dur(o.deliveredAt - o.placedAt)) + "</b><span>Placed " + esc(fmtDT(o.placedAt)) + " · Delivered " + esc(fmtDT(o.deliveredAt)) + "</span></div>";
        } else {
            var eta = o.etaAt ? (o.etaAt > now ? " · Arriving in about " + dur(o.etaAt - now) : " · Should arrive any moment") : "";
            el.innerHTML = CLOCK + "<div><b>Placed " + esc(dur(now - o.placedAt)) + " ago</b><span>" + esc((o.pickup ? "Ready for pickup soon" : "Your dealer is on it") + eta) + "</span></div>";
        }
        el.hidden = false;
    }

    function renderItems() {
        var st = pointsState();
        $("itemsList").innerHTML = order.items.map(function (i) {
            return '<div class="it"><div class="it-ph">' + CYL + (i.image ? '<img src="' + esc(i.image) + '" alt="" loading="lazy" onerror="this.remove()">' : "") + '</div>' +
                '<div class="it-info"><h3>' + (i.id != null && i.id !== "" ? '<a href="customer-product.html?id=' + encodeURIComponent(i.id) + '">' + esc(i.name) + '</a>' : esc(i.name)) + '</h3><p>' + esc(i.details ? i.details + " · " : "") + i.qty + " × " + esc(money(i.price)) + '</p></div>' +
                '<div class="it-end"><b>' + esc(money(i.price * i.qty)) + '</b></div></div>';
        }).join("");
    }

    function renderDealer() {
        var o = order, link = "customer-dealer.html" + (o.dealerId != null ? "?id=" + encodeURIComponent(o.dealerId) : "");
        var ini = o.dealerName.split(" ").map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase() || "G";
        $("dealerBox").innerHTML =
            '<div class="dl"><div class="dl-av"' + (o.dealerLogo ? ' style="padding:0;overflow:hidden"' : '') + '>' + (o.dealerLogo ? '<img src="' + esc(o.dealerLogo) + '" alt="" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.replaceWith(document.createTextNode(\'' + esc(ini) + '\'))">' : esc(ini)) + '</div><div class="dl-info"><h3><a href="' + esc(link) + '" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--blue-dark);text-decoration:underline">' + esc(o.dealerName) + '</a>' + (o.dealerVerified ? VBADGE : "") + '</h3><p>' + esc(o.dealerLoc || "GasHub dealer") + '</p></div></div>' +
            phoneHTML(o.dealerPhone, "Dealer phone", o) +
            '<div class="dl-links"><a class="btn" href="' + esc(link) + '" style="flex:1">' + (o.stage === 3 ? "Rate dealer" : "View dealer") + '</a><a class="btn" href="' + esc(link) + '" style="flex:1">Chat</a></div>';
    }

    /* A phone number line. A full number can be tapped to call. Once the server has masked it
       (2 days after the order ended) it is shown as 0712*****78 and cannot be called. */
    function phoneHTML(phone, label, o) {
        if (!phone) return "";
        var masked = phone.indexOf("*") !== -1;
        var shown = !masked && /^\d{10}$/.test(phone) ? phone.slice(0, 4) + " " + phone.slice(4, 7) + " " + phone.slice(7) : phone;
        if (masked) {
            return '<div class="ir" style="margin-top:8px"><span>' + esc(label) + '</span><b>' + esc(shown) + '</b></div>' +
                '<p class="rf-note" style="margin-top:4px">For your safety the number is hidden 2 days after an order ends. Use Chat to reach them.</p>';
        }
        return '<div class="ir" style="margin-top:8px"><span>' + esc(label) + '</span><b><a href="tel:' + esc(phone.replace(/[^\d+]/g, "")) + '" style="color:var(--blue);text-decoration:underline">' + esc(shown) + '</a></b></div>';
    }

    /* ================= PAY WITH M-PESA (to the GasHub account the admin set) ================= */
    var payAccount, payKey = "";

    /* ================= CHECKOUT PAGE =================
       When the dealer has confirmed the order and the customer still has to pay, they are sent to customer-checkout.html
       (pay mode), which does the payment, shows a success message and brings them back here. */
    var skipCheckout = params.get("view") === "order";
    function needsCheckout(o) {
        if (source !== "api" || o.stage !== 1) return false;
        if (/^(paid|complete|success)/i.test(o.payStatus)) return false;
        if (!o.methodChosen) return true;
        if (/cash/i.test(o.method)) return false;
        return !pendingPayment();
    }
    function paymentsOf(o) { return Array.isArray(o.raw && o.raw.payments) ? o.raw.payments : []; }
    function pendingPayment() { return paymentsOf(order).filter(function (p) { return /pending/i.test(String(p.status)) && p.code; })[0] || null; }
    function rejectedPayment() { return !pendingPayment() && paymentsOf(order).filter(function (p) { return /fail/i.test(String(p.status)); }).length > 0; }
    /* which online methods the super admin switched on (Admin > Settings > Super Admin Area > Online Payment Methods) */
    async function methodsConfig() {
        try { var r = await fetch("/api/settings/payment-methods", { cache: "no-store", credentials: "same-origin" }); var j = await r.json(); return { mpesa: !(j && j.mpesa === false), bank: !(j && j.bank === false) }; }
        catch (e) { return { mpesa: true, bank: true }; }
    }
    /* GasHub's bank details, saved by the super admin (always fresh) */
    async function bankConfig() {
        try { var r = await fetch("/api/payments/bank/config", { cache: "no-store", credentials: "same-origin" }); var j = await r.json(); return j && j.configured ? j : null; } catch (e) { return null; }
    }
    /* The backup Till. The server gives it out only after the phone prompt failed twice (or when the prompt is switched off). */
    async function manualInfo() {
        try {
            var r = await fetch("/api/payments/mpesa/manual?order_id=" + encodeURIComponent(order.id), { cache: "no-store", credentials: "same-origin", headers: R.authHeaders(false) });
            var j = await r.json();
            return j && j.available ? j : null;
        } catch (e) { return null; }
    }
    function manualHTML(m, amount) {
        var how = m.type === "paybill" ? "Lipa na M-Pesa > Pay Bill" : (m.type === "till" ? "Lipa na M-Pesa > Buy Goods and Services" : "Send Money");
        var line = m.type === "paybill" ? [["Paybill number", m.number], ["Account number", m.account_number]]
            : (m.type === "till" ? [["Till number", m.number]] : [["Send Money to", m.number]]);
        return '<div class="banner" style="margin-top:10px"><b>Prompt not reaching your phone?</b> Pay manually: on your phone open M-Pesa, choose <b>' + esc(how) + '</b> and pay the exact amount below. Then type the M-Pesa code from the confirmation message in the box under this.</div>' +
            rows(line.concat([["Name", m.account_name], ["Amount to pay", amount, "", "tot"]]).filter(function (l) { return l[1]; })) +
            (m.instructions ? '<p class="rf-note" style="margin-top:8px">' + esc(m.instructions) + '</p>' : "");
    }
    async function refreshManual() {
        var area = $("manualArea"); if (!area || !/mpesa/i.test(order.method)) return;
        var m = await manualInfo();
        if (m && !area.innerHTML) area.innerHTML = manualHTML(m, money(Math.max(0, order.total - (order.amountPaid || 0))));
    }
    /* ================= GASHUB COINS (used at the payment stage) =================
       After the dealer confirms the order the customer can turn coins into a discount, then pay the smaller amount
       by M-Pesa or Bank. The server (POST /api/my/orders/:id/points) re-checks everything and keeps the balance. */
    var checkoutShown = false;
    /* the order breakdown at the top of the checkout */
    function checkoutSummary(o) {
        var due = Math.max(0, o.total - (o.amountPaid || 0));
        return '<div style="margin-bottom:12px">' + rows([
            ["Products", money(o.productTotal)],
            ["Delivery", o.pickup ? "Pickup (free)" : money(o.deliveryFee)],
            o.discount > 0 ? ["GasHub Coins discount" + (o.pointsUsed > 0 ? " (" + Number(o.pointsUsed).toLocaleString("en-KE") + " coins" + (coins.rate > 0 ? " \u00d7 " + money(coins.rate) : "") + ")" : ""), "\u2212 " + money(o.discount)] : null,
            ["Total to pay", money(due), "", "tot"]
        ]) + '</div>';
    }
    var coins = { loaded: false, at: 0, enabled: false, rate: 0, min: 30, balance: null };
    async function refreshCoins(force) {
        if (!force && coins.loaded && Date.now() - coins.at < 15000) return coins;
        try {
            var r = await fetch("/api/points/config", { cache: "no-store", credentials: "same-origin" });
            var j = r.ok ? await r.json() : null;
            if (j) { coins.enabled = j.enabled !== false; coins.rate = Number(j.pointValueKsh) || 0; coins.min = Number(j.minRedeem) > 0 ? Number(j.minRedeem) : 30; }
        } catch (e) { /* keep the last known values */ }
        coins.balance = await R.balance();
        coins.loaded = true; coins.at = Date.now();
        return coins;
    }
    /* what this order can use: the balance already has the coins used on this order taken off, so add them back */
    function coinState(o) {
        if (!coins.enabled || !(coins.rate > 0) || coins.balance == null) return null;
        var available = coins.balance + (o.pointsUsed || 0);
        var gross = o.productTotal + o.deliveryFee;
        var maxByBill = Math.max(0, Math.floor((Math.ceil(gross) - 1) / coins.rate));      /* keep at least KSh 1 to pay */
        return { available: available, max: Math.min(available, maxByBill), gross: gross };
    }
    /* How many coins to turn into money when the switch goes on: as many as the order allows (always leaving KSh 1 to pay),
       trimmed so no part of a coin is wasted at the admin's exchange rate. */
    function coinsToUse(st) {
        var d = Math.floor(st.max * coins.rate);
        var n = Math.ceil(d / coins.rate - 1e-9);
        if (!(n >= coins.min) || n > st.max) n = st.max;
        return n;
    }
    function coinsHTML(o) {
        var st = coinState(o);
        if (!st) return "";
        var on = o.pointsUsed > 0, can = on || (st.available >= coins.min && st.max >= coins.min);
        return '<div id="coinBox" class="coin-switch-row">' +
            '<span class="csr-label">' + R.chip(st.available, "credited") + '<b>Use my coins</b></span>' +
            '<label class="csr-sw' + (can ? "" : " off") + '" title="' + (can ? "Turn coins into a discount" : "Not enough coins yet") + '">' +
            '<input type="checkbox" id="coinUse"' + (on ? " checked" : "") + (can ? "" : " disabled") + ' aria-label="Use my GasHub Coins"><i></i></label>' +
            '<p class="msg" id="coinMsg" role="status"></p></div>';
    }
    function bindCoins(o) {
        var cb = $("coinUse"), st = coinState(o);
        if (!cb || !st) return;
        cb.addEventListener("change", function () {
            /* on = turn the coins into money and take it off this order; off = give the coins back */
            if (cb.checked) setCoins(coinsToUse(st)); else if (o.pointsUsed > 0) setCoins(0);
        });
    }
    async function setCoins(n) {
        var msg = $("coinMsg"), btn = null, cb = $("coinUse");
        if (cb) cb.disabled = true;
        if (msg) { msg.className = "msg"; msg.textContent = "Saving..."; }
        try {
            var tok = await R.csrf(), hdrs = R.authHeaders(true); if (tok) hdrs["X-CSRF-Token"] = tok;
            var r = await fetch("/api/my/orders/" + encodeURIComponent(order.id) + "/points", { method: "POST", headers: hdrs, credentials: "same-origin", body: JSON.stringify({ points: n }) });
            var j = {}; try { j = await r.json(); } catch (x) { }
            if (!r.ok || j.success === false) {
                if (msg) { msg.className = "msg err"; msg.textContent = j.message || "We could not update your coins. Please try again."; }
                if (btn) btn.disabled = false;
                if (cb) { cb.disabled = false; cb.checked = n === 0; }
                return;
            }
            await refreshCoins(true);
            var fresh = await fetchApi(order.id);
            if (fresh) { order = normalize(fresh); payKey = ""; render(); }
            flash(j.message || "GasHub Coins updated.");
        } catch (e) {
            if (msg) { msg.className = "msg err"; msg.textContent = "No connection. Please try again."; }
            if (btn) btn.disabled = false;
            if (cb) cb.disabled = false;
        }
    }
    var METHOD_BTN = "display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;border:1px solid var(--line);background:#fff;border-radius:12px;padding:11px 13px;margin-top:8px;cursor:pointer;font:inherit";
    async function renderPay() {
        var card = $("payCard"), box = $("payBox"), o = order;
        if (!card) return;
        /* "Pay now" button on the Checkout card: opens this order's checkout page */
        var pn = $("payNowBtn");
        if (pn) { var showPn = needsCheckout(o); pn.hidden = !showPn; pn.style.display = showPn ? "" : "none"; if (showPn) pn.href = "customer-checkout.html?orderId=" + encodeURIComponent(o.id) + "&pay=1"; }
        var unpaid = !/paid|complete|success/i.test(o.payStatus);
        if (source !== "api" || o.stage === -1) { card.hidden = true; payKey = ""; return; }
        if (!unpaid) {
            /* paid: the order carries on. Show a short thank-you until the order is out for delivery. */
            if (o.stage !== 1) { card.hidden = true; payKey = ""; return; }
            if (payKey === "paid") return;
            payKey = "paid";
            card.hidden = false; card.style.borderColor = "var(--green)"; card.style.boxShadow = "";
            $("payCardTitle").textContent = "Payment received";
            $("payBox").innerHTML = '<div style="padding:10px 12px;border-radius:10px;background:#e7f7ee;color:#137a3f;font-size:13px;font-weight:600">Thank you, your payment is confirmed.</div>' +
                '<p class="rf-note" style="margin-top:8px">' + (o.pickup ? "Your dealer is getting your order ready for collection." : "Your dealer is now preparing your order and will send it out with a messenger. You can follow it in the tracker above.") + '</p>';
            return;
        }
        /* confirmed and not paid yet: this is the checkout. It opens right here under the order. */
        $("payCardTitle").textContent = o.stage === 0 ? "Payment" : "Checkout";
        card.hidden = false;
        if (o.stage >= 1) { card.style.borderColor = "var(--blue)"; card.style.boxShadow = "0 0 0 3px rgba(31,79,216,.12)"; }
        else { card.style.borderColor = ""; card.style.boxShadow = ""; }
        if (o.stage >= 1 && !checkoutShown) {                    /* bring the checkout into view once, when it first opens */
            checkoutShown = true;
            setTimeout(function () { try { card.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { } }, 350);
        }
        var amount0 = money(Math.max(0, o.total - (o.amountPaid || 0)));

        /* 1. the dealer has not confirmed yet: nothing to pay */
        if (o.stage === 0) {
            var k0 = "wait";
            if (k0 === payKey) return;
            payKey = k0;
            box.innerHTML = '<p class="rf-note">Your order is waiting for the dealer to confirm it. <b>You do not need to pay yet.</b> We will send you an SMS and an email as soon as it is confirmed, and then you can choose how to pay: Cash on delivery, M-Pesa or Bank.</p>';
            return;
        }

        /* 2. confirmed, but the customer has not chosen how to pay */
        if (!o.methodChosen) {
            await refreshCoins();
            var sw = await methodsConfig();
            var k1 = "choose|" + sw.mpesa + "|" + sw.bank + "|" + o.cashAllowed + "|" + o.total + "|" + o.pointsUsed + "|" + coins.balance + "|" + coins.enabled + "|" + o.discount;
            if (k1 === payKey) return;
            payKey = k1;
            box.innerHTML = checkoutSummary(o) + coinsHTML(o) + '<p class="rf-note">Your dealer confirmed this order. Choose how you want to pay <b>' + esc(amount0) + '</b>:</p>' +
                (o.cashAllowed ? '<button type="button" class="pm" data-m="cash" style="' + METHOD_BTN + '"><b>Cash on delivery</b><span class="rf-note">Pay the messenger when your gas ' + (o.pickup ? "is ready" : "arrives") + '.</span></button>'
                    : '<div class="rf-note" style="margin-top:8px">Cash on delivery is not available because you used GasHub coins on this order. Pay online instead.</div>') +
                (sw.mpesa ? '<button type="button" class="pm" data-m="mpesa" style="' + METHOD_BTN + '"><b>M-Pesa</b><span class="rf-note">Get a prompt on your phone and enter your PIN.</span></button>' : "") +
                (sw.bank ? '<button type="button" class="pm" data-m="bank" style="' + METHOD_BTN + '"><b>Bank</b><span class="rf-note">Pay by bank transfer to GasHub.</span></button>' : "") +
                '<p class="msg" id="pmMsg" role="status"></p>';
            Array.prototype.forEach.call(box.querySelectorAll(".pm"), function (b) { b.addEventListener("click", function () { chooseMethod(b.getAttribute("data-m")); }); });
            bindCoins(o);
            return;
        }

        /* 3. cash: payment on delivery */
        var pendingNow = pendingPayment();
        var changeLink = pendingNow ? "" : '<p class="rf-note" style="margin-top:10px"><a href="#" id="changeMethod" style="color:var(--blue);text-decoration:underline">Change payment method</a></p>';
        function bindChange() { var c = $("changeMethod"); if (c) c.addEventListener("click", function (e) { e.preventDefault(); payKey = ""; order.methodChosen = false; renderPay(); renderPayStep(); }); }
        if (/cash/i.test(o.method)) {
            var k2 = "cash|" + o.total;
            if (k2 === payKey) return;
            payKey = k2;
            box.innerHTML = '<div style="padding:10px 12px;border-radius:10px;background:#e8f0ff;color:#1f4fd8;font-size:13px;font-weight:600">Payment on delivery</div>' +
                '<p class="rf-note" style="margin-top:8px">Pay <b>' + esc(amount0) + '</b> in cash to the messenger when your gas ' + (o.pickup ? "is handed over" : "arrives") + '. Your order shows as paid once the cash is received.</p>' + changeLink;
            bindChange();
            return;
        }

        /* 4. M-Pesa or bank: paid to the GasHub account */
        var isBank = /bank/i.test(o.method);
        $("payCardTitle").textContent = isBank ? "Checkout \u00B7 Pay by bank" : "Checkout \u00B7 Pay with M-Pesa";
        var sw4 = await methodsConfig();
        var pend = pendingPayment(), rej = rejectedPayment();
        if (!pend) await refreshCoins();
        card.hidden = false;
        var amount = money(Math.max(0, o.total - (o.amountPaid || 0)));

        /* the super admin switched this method off: the customer picks another one (unless a payment is already being confirmed) */
        if (!pend && ((isBank && !sw4.bank) || (!isBank && !sw4.mpesa))) {
            var koff = "off|" + o.method + "|" + sw4.mpesa + "|" + sw4.bank;
            if (koff === payKey) return;
            payKey = koff;
            box.innerHTML = '<p class="rf-note"><b>' + (isBank ? "Bank payment" : "M-Pesa payment") + '</b> is not available right now. Please choose another way to pay.</p>' +
                '<p class="rf-note" style="margin-top:10px"><a href="#" id="changeMethod" style="color:var(--blue);text-decoration:underline">Choose another payment method</a></p>';
            bindChange();
            return;
        }

        var bk = isBank ? await bankConfig() : null;
        var stk = !isBank && await stkEnabled();
        var man = !isBank ? await manualInfo() : null;
        var key = ["pay", o.method, bk ? [bk.bank_name, bk.account_number, bk.account_name, bk.branch, bk.paybill, bk.instructions].join("~") : "", stk, man ? "m" : "", pend ? pend.code : "", rej, o.total, o.pointsUsed, pend ? "" : coins.balance].join("|");
        if (key === payKey) return;                 /* nothing changed: keep what the customer is typing */
        payKey = key;

        var html = "";
        if (isBank) {
            html += '<p class="rf-note">Pay <b>' + esc(amount) + '</b> to the GasHub bank account below. Use <b>' + esc(o.id) + '</b> as the payment reference, then type the bank reference you receive.</p>';
            html += bk ? rows([["Bank", bk.bank_name], ["Account name", bk.account_name], ["Account number", bk.account_number], ["Branch", bk.branch], ["Paybill", bk.paybill], ["Amount to pay", amount, "", "tot"]].filter(function (l) { return l[1]; })) + (bk.instructions ? '<p class="rf-note" style="margin-top:8px">' + esc(bk.instructions) + '</p>' : "")
                : '<div class="banner">GasHub\'s bank details are being set up and will show here. Please choose M-Pesa or Cash on delivery if you need to pay now.</div>';
        } else {
            if (stk) {
                html += '<p class="rf-note">Pay <b>' + esc(amount) + '</b> with M-Pesa. We send a prompt to your phone and your order shows as paid as soon as you enter your PIN.</p>' +
                    '<form id="stkForm" autocomplete="off" style="display:flex;gap:8px;margin-top:10px">' +
                    '<input id="stkPhone" type="tel" inputmode="numeric" maxlength="14" placeholder="M-Pesa number, e.g. 0712345678" value="' + esc(String(o.deliveryPhone || "").replace(/[^\d+]/g, "")) + '" style="flex:1;min-width:0;min-height:40px;border:1px solid var(--line);border-radius:10px;padding:0 12px;font-size:13px">' +
                    '<button type="submit" class="btn y" id="stkBtn" style="grid-column:auto">Pay with M-Pesa</button></form>' +
                    '<p class="msg" id="stkMsg" role="status"></p>';
            } else if (!man) {
                html += '<div class="banner">M-Pesa payment is not available right now. Please choose another way to pay.</div>';
            }
            html += '<div id="manualArea">' + (man ? manualHTML(man, amount) : "") + '</div>';
        }
        if (pend) html += '<div style="margin-top:10px;padding:8px 10px;border-radius:9px;background:#e8f0ff;color:#1f4fd8;font-size:12px;font-weight:600">We received your code <b>' + esc(pend.code) + '</b>. GasHub is confirming your payment.</div>';
        if (rej) html += '<div class="banner" style="margin-top:10px">GasHub could not find that payment. Check the ' + (isBank ? "bank reference" : "M-Pesa code") + ' and send it again.</div>';
        html += '<p class="rf-note" style="margin-top:10px"><b>' + (isBank ? "Paid by bank?" : "Already paid?") + '</b> Type your ' + (isBank ? "bank reference" : "M-Pesa code") + ' below. Your order shows as paid once GasHub confirms the money.</p>' +
            '<form id="payCodeForm" autocomplete="off" style="display:flex;gap:8px;margin-top:10px">' +
            '<input id="payCodeInput" type="text" maxlength="' + (isBank ? 30 : 12) + '" placeholder="' + (isBank ? "Bank reference / transaction code" : "M-Pesa code, e.g. QGH7XK2LMN") + '" value="' + esc(pend ? pend.code : "") + '" style="flex:1;min-width:0;min-height:40px;border:1px solid var(--line);border-radius:10px;padding:0 12px;font-size:13px;text-transform:uppercase">' +
            '<button type="submit" class="btn y" id="payCodeBtn" style="grid-column:auto">' + (pend ? "Update code" : "I have paid") + '</button></form>' +
            '<p class="msg" id="payMsg" role="status"></p>';
        html += changeLink;
        box.innerHTML = checkoutSummary(o) + (pend ? "" : coinsHTML(o)) + html;
        bindChange();
        if (!pend) bindCoins(o);
        $("payCodeForm").addEventListener("submit", submitPayCode);
        if (stk && $("stkForm")) $("stkForm").addEventListener("submit", submitStk);
    }

    /* ---- M-Pesa phone prompt (only when the server has Daraja set up) ---- */
    var stkOn;
    async function stkEnabled() {
        if (stkOn !== undefined) return stkOn;
        try { var r = await fetch("/api/payments/mpesa/config", { cache: "no-store", credentials: "same-origin" }); var j = await r.json(); stkOn = !!(j && j.enabled); }
        catch (e) { stkOn = false; }
        return stkOn;
    }
    async function submitStk(ev) {
        ev.preventDefault();
        var btn = $("stkBtn"), msg = $("stkMsg"), phone = $("stkPhone").value.trim();
        msg.className = "msg";
        if (!/^(\+?254|0)?[17]\d{8}$/.test(phone.replace(/\s+/g, ""))) { msg.className = "msg err"; msg.textContent = "Enter a valid Safaricom number, e.g. 0712345678."; return; }
        btn.disabled = true; msg.textContent = "Sending the prompt to your phone...";
        try {
            var tok = await R.csrf(), hdrs = R.authHeaders(true); if (tok) hdrs["X-CSRF-Token"] = tok;
            var r = await fetch("/api/payments/mpesa/stk-push", { method: "POST", headers: hdrs, credentials: "same-origin", body: JSON.stringify({ order_id: order.id, phone: phone }) });
            var j = {}; try { j = await r.json(); } catch (x) { }
            if (!r.ok || !j.checkoutRequestId) { msg.className = "msg err"; msg.textContent = j.message || "We could not send the prompt. Please try again."; btn.disabled = false; refreshManual(); return; }
            msg.textContent = "Check your phone and enter your M-Pesa PIN...";
            var started = Date.now();
            while (Date.now() - started < 130000) {
                await new Promise(function (res) { setTimeout(res, 3000); });
                var s = await fetch("/api/payments/mpesa/status?order_id=" + encodeURIComponent(order.id) + "&checkout_request_id=" + encodeURIComponent(j.checkoutRequestId), { credentials: "same-origin", cache: "no-store" });
                var sj = s.ok ? await s.json().catch(function () { return null; }) : null;
                if (!sj) continue;
                if (sj.status === "paid") {
                    var fresh = await fetchApi(order.id);
                    if (fresh) { order = normalize(fresh); payKey = ""; render(); }
                    flash("Payment received. Thank you!");
                    return;
                }
                if (sj.status && sj.status !== "pending") { msg.className = "msg err"; msg.textContent = sj.message || "The payment did not go through."; btn.disabled = false; refreshManual(); return; }
            }
            msg.className = "msg err"; msg.textContent = "No confirmation yet. If M-Pesa took the money it will show on this order shortly.";
            btn.disabled = false; refreshManual();
        } catch (e) { msg.className = "msg err"; msg.textContent = "No connection. Please try again."; btn.disabled = false; }
    }
    /* the customer picks Cash on delivery / M-Pesa / Bank (only possible after the dealer confirmed the order) */
    async function chooseMethod(method) {
        var msg = $("pmMsg"), btns = document.querySelectorAll("#payBox .pm");
        Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
        if (msg) { msg.className = "msg"; msg.textContent = "Saving..."; }
        try {
            var tok = await R.csrf(), hdrs = R.authHeaders(true); if (tok) hdrs["X-CSRF-Token"] = tok;
            var r = await fetch("/api/my/orders/" + encodeURIComponent(order.id) + "/payment-method", { method: "POST", headers: hdrs, credentials: "same-origin", body: JSON.stringify({ method: method }) });
            var j = {}; try { j = await r.json(); } catch (x) { }
            if (!r.ok || j.success === false) {
                if (msg) { msg.className = "msg err"; msg.textContent = j.message || "We could not save your choice. Please try again."; }
                Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
                return;
            }
            var fresh = await fetchApi(order.id);
            if (fresh) { order = normalize(fresh); payKey = ""; render(); }
            flash(j.message || "Payment method saved.");
        } catch (e) {
            if (msg) { msg.className = "msg err"; msg.textContent = "No connection. Please try again."; }
            Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
        }
    }

    async function submitPayCode(ev) {
        ev.preventDefault();
        var code = $("payCodeInput").value.trim().toUpperCase().replace(/\s+/g, ""), btn = $("payCodeBtn"), msg = $("payMsg");
        msg.className = "msg";
        var isBankPay = /bank/i.test(order.method);
        if (isBankPay ? !/^[A-Z0-9\-]{5,30}$/.test(code) : !/^[A-Z0-9]{8,12}$/.test(code)) { msg.className = "msg err"; msg.textContent = isBankPay ? "Enter the bank reference from your bank confirmation." : "Enter the M-Pesa code from your confirmation message."; return; }
        btn.disabled = true;
        try {
            var tok = await R.csrf(), hdrs = R.authHeaders(true); if (tok) hdrs["X-CSRF-Token"] = tok;
            var r = await fetch("/api/my/orders/" + encodeURIComponent(order.id) + "/payment-code", { method: "POST", headers: hdrs, credentials: "same-origin", body: JSON.stringify({ mpesa_code: code }) });
            var j = {}; try { j = await r.json(); } catch (x) { }
            if (!r.ok || j.success === false) { msg.className = "msg err"; msg.textContent = j.message || "We could not save your code. Please try again."; btn.disabled = false; return; }
            var fresh = await fetchApi(order.id);
            if (fresh) { order = normalize(fresh); payKey = ""; render(); }
            flash(j.message || "We received your M-Pesa code.");
        } catch (e) { msg.className = "msg err"; msg.textContent = "No connection. Please try again."; btn.disabled = false; }
    }

    function renderLists() {
        var o = order, pay = payInfo();
        $("deliveryList").innerHTML = rows([
            ["Option", o.pickup ? "Customer pickup" : "Delivery"],
            ["County", o.county], ["Town", o.town], ["Address", o.address], ["Landmark", o.landmark],
            ["Order placed", o.placedAt ? fmtExact(o.placedAt) : null],
            ["Confirmed", o.confirmedAt ? fmtExact(o.confirmedAt) : null],
            ["Paid", o.paidAt ? fmtExact(o.paidAt) : null],
            ["Delivery started", o.dispatchedAt ? fmtExact(o.dispatchedAt) : null],
            ["Delivered", o.stage === 3 && o.deliveredAt ? fmtExact(o.deliveredAt) : null],
            ["Completed", o.completedAt ? fmtExact(o.completedAt) : null],
            ["Delivery time", o.stage === 3 && o.placedAt && o.deliveredAt && o.deliveredAt >= o.placedAt ? dur(o.deliveredAt - o.placedAt) : null],
            ["Phone for delivery", o.deliveryPhone]
        ]) + mapLink(o);
        $("paymentList").innerHTML = rows([
            ["Method", methodLabel()], ["Status", pay.text, pay.cls],
            ["M-Pesa code", o.receipt],
            ["Products", money(o.productTotal)], ["Delivery fee", money(o.deliveryFee)],
            ["Discount", o.discount > 0 ? "− " + money(o.discount) + (o.discountNote ? " (" + o.discountNote + ")" : "") : null],
            ["Total", money(o.total), "", "tot"],
            ["Amount paid", o.amountPaid > 0 ? money(o.amountPaid) : null]
        ]);
        $("customerList").innerHTML = rows([["Name", o.customerName], ["Phone", o.customerPhone], ["Email", o.customerEmail]]) || '<p class="rf-note">No details saved on this order.</p>';
    }

    function mapLink(o) {
        if (o.lat == null || o.lng == null || !isFinite(o.lat) || !isFinite(o.lng)) return "";
        return '<div class="ir"><span>Pinned location</span><b><a href="https://www.google.com/maps?q=' + encodeURIComponent(o.lat + "," + o.lng) + '" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:underline">Open in Maps</a></b></div>';
    }
    /* The messenger (delivery person) the dealer gave this order to: name, vehicle, last digits of the ID, and phone */
    function renderRider() {
        var card = $("riderCard"), o = order, r = o.rider;
        if (!card) return;
        if (o.pickup || o.stage === -1) { card.hidden = true; return; }
        card.hidden = false;
        if (!r || !r.name) {
            $("riderBox").innerHTML = '<p class="rf-note">' + (o.stage === 3 ? "No messenger was recorded for this order." : "Your dealer has not picked a messenger yet. Their details will show here as soon as they do.") + '</p>';
            return;
        }
        var ini = String(r.name).split(" ").filter(Boolean).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase() || "M";
        $("riderBox").innerHTML =
            '<div class="dl"><div class="dl-av">' + esc(ini) + '</div><div class="dl-info"><h3><span>' + esc(r.name) + '</span></h3><p>' +
            esc(o.stage === 3 ? "Delivered your order" : (o.stage === 2 ? "On the way to you" : "Assigned to deliver your order")) + '</p></div></div>' +
            '<div class="il" style="margin-top:8px">' + rows([["ID number", r.idNumber], ["Vehicle registration", r.vehicle || "Not provided by the dealer"]]) + '</div>' +
            phoneHTML(String(r.phone || ""), "Phone", o);
    }

    var balanceAsked = false;
    function renderPoints() {
        var card = $("pointsCard");
        if (!cfg.enabled || order.stage === -1) { card.hidden = true; return; }
        if (!(order.pointsAwarded > 0) && earnsFor() <= 0) { card.hidden = true; return; }   /* this payment type earns no points right now */
        var n = pointsTotal(), st = pointsState();
        card.hidden = false;
        $("pointsMain").innerHTML = R.chip(n, st, "big");
        $("pointsEq").textContent = "≈ " + money(R.valueOf(n, cfg));
        $("pointsNote").textContent = (st === "credited" ? "Points added to your account. " : "Points are added once your payment is confirmed. ") +
            "You earn " + earnsFor() + " GasHub points every time you pay for an order this way. Each point is worth " + money(cfg.pointValueKsh) + ".";
        if (!balanceAsked) {
            balanceAsked = true;
            R.balance().then(function (b) {
                if (b == null) return;
                var el = $("pointsBal");
                el.innerHTML = R.chip(b, "credited", "big") + '<span class="pt-eq">≈ ' + esc(money(R.valueOf(b, cfg))) + '</span>';
                el.hidden = false;
            });
        }
    }

    /* ---------- refill reminder ---------- */
    function renderRefill() {
        var card = $("refillCard"), body = $("refillBody"), g = gasItem();
        if (!g || order.stage === -1) { card.hidden = true; return; }
        /* nothing to say until the gas is delivered: the countdown starts then */
        if (order.stage < 3) { card.hidden = true; return; }
        card.hidden = false;
        $("refillSize").textContent = g.kg + "kg cylinder";
        card.className = "card refill";
        var start = order.deliveredAt || order.placedAt || Date.now();
        R.recordDelivery({ orderId: order.id, kg: g.kg, deliveredAt: start });
        var s = R.schedule({
            orderId: order.id, productId: g.id, productName: g.name, details: g.details, image: g.image,
            dealer: order.dealerName, dealerId: order.dealerId, price: g.price, quantity: g.qty, kg: g.kg, deliveredAt: start
        });
        var days = s.cycle.days, now = Date.now(), left = (s.dueAt - now) / DAY, used = clamp01((now - start) / (days * DAY));
        var big, unit;
        if (left >= 1) { big = String(Math.ceil(left)); unit = Math.ceil(left) === 1 ? "day left" : "days left"; }
        else if (left > 0) { big = "<1"; unit = "day left"; }
        else { big = String(Math.max(0, Math.floor(-left))); unit = left > -1 ? "due now" : "days over"; }
        card.className = "card refill" + (left <= 0 ? " late" : (left <= s.lead + 1 ? " warn" : ""));
        var src = s.cycle.source === "history" ? "Based on how long your past cylinders lasted" : "Typical for a " + g.kg + "kg cylinder, adjust below";
        var enabled = s.reminder ? s.reminder.enabled !== false : false;
        var html =
            '<div class="rf-top"><div class="rf-days"><b>' + esc(big) + '</b><span>' + unit + '</span></div>' +
            '<div class="rf-info"><div class="bar"><i style="width:' + Math.round(used * 100) + '%"></i></div>' +
            '<div class="rf-line">Refill around <b>' + esc(fmtD(s.dueAt)) + '</b></div><small>' + esc(src) + ' · about ' + days + ' days</small></div></div>';
        if (s.superseded) {
            html += '<p class="rf-alert">You have ordered this size again since, so your newer order sets the reminder.</p>';
        } else {
            html += '<div class="rf-row"><span>Remind me before it runs out</span><label class="sw"><input type="checkbox" id="remToggle"' + (enabled ? " checked" : "") + ' aria-label="Remind me before it runs out"><span></span></label></div>';
            if (enabled) {
                var perm = R.permission();
                if (perm === "default") html += '<button type="button" class="mini" id="allowAlerts">Allow phone alerts</button>';
                else if (perm === "denied") html += '<p class="rf-alert">Phone alerts are blocked in your browser settings. You will still see reminders here in the app.</p>';
            }
        }
        if (s.cycle.source !== "history") {
            var h = R.habit();
            html += '<div class="rf-hab"><span>How much do you cook?</span><select id="habitSel" aria-label="How much do you cook?">' +
                [["light", "Light, 1-2 people"], ["normal", "Normal, family of 3-5"], ["heavy", "Heavy, large family or business"]].map(function (x) { return '<option value="' + x[0] + '"' + (h === x[0] ? " selected" : "") + '>' + x[1] + '</option>'; }).join("") + '</select></div>';
        }
        body.innerHTML = html;
        if (s.reminder) R.checkDue();
    }
    function clamp01(n) { return Math.min(1, Math.max(0, n)); }

    $("refillBody").addEventListener("change", function (e) {
        if (e.target.id === "habitSel") { R.setHabit(e.target.value); renderRefill(); }
        else if (e.target.id === "remToggle") {
            R.setEnabled(order.id, e.target.checked);
            if (e.target.checked && R.permission() === "default") R.askPermission().then(renderRefill); else renderRefill();
        }
    });
    $("refillBody").addEventListener("click", function (e) { if (e.target.id === "allowAlerts") R.askPermission().then(renderRefill); });

    /* ================= ACTIONS ================= */
    function reorderTarget() {
        var g = gasItem() || order.items[0];
        return { productId: g.id, productName: g.name, details: g.details, image: g.image, dealer: order.dealerName, dealerId: order.dealerId, quantity: g.qty, price: g.price };
    }
    $("reorderBtn").addEventListener("click", function () { location.href = R.reorderUrl(reorderTarget()); });

    $("copyId").addEventListener("click", function () {
        copy(order.id).then(function () { flash("Order number copied."); }).catch(function () { flash("Could not copy. Press and hold the number to copy it.", true); });
    });

    function receiptText() {
        var o = order, lines = ["GasHub order " + o.id];
        if (o.placedAt) lines.push("Placed " + fmtDT(o.placedAt));
        o.items.forEach(function (i) { lines.push("• " + i.name + (i.details ? " (" + i.details + ")" : "") + " × " + i.qty + " — " + money(i.price * i.qty)); });
        lines.push("Dealer: " + o.dealerName, "Delivery fee: " + money(o.deliveryFee), "Total: " + money(o.total), "Status: " + stageLabel(o.stage, o.raw.status));
        if (o.stage === 3 && o.placedAt && o.deliveredAt) lines.push("Delivered in " + dur(o.deliveredAt - o.placedAt));
        return lines.join("\n");
    }
    $("shareBtn").addEventListener("click", function () {
        var text = receiptText();
        if (navigator.share) { navigator.share({ title: "GasHub order " + order.id, text: text }).catch(function () { }); return; }
        copy(text).then(function () { flash("Receipt copied. Paste it in any chat."); }).catch(function () { flash("Sharing is not supported on this browser.", true); });
    });

    function persistCancel() {
        var now = new Date().toISOString();
        function patch(o) { if (o && String(o.orderId != null ? o.orderId : o.id) === order.id) { o.status = "Cancelled"; o.cancelledAt = now; return true; } return false; }
        var last = R.read(STORE_LAST, null); if (patch(last)) R.write(STORE_LAST, last);
        var list = R.read(STORE_LIST, []);
        if (Array.isArray(list) && list.some(patch)) R.write(STORE_LIST, list);
    }
    $("cancelBtn").addEventListener("click", async function () {
        var b = this;
        if (!armTimer) {
            b.textContent = paidOnline() ? "Tap again: " + money(order.total) + " will be refunded" : "Tap again to confirm";
            armTimer = setTimeout(function () { armTimer = null; b.textContent = "Cancel order"; }, 4000);
            return;
        }
        clearTimeout(armTimer); armTimer = null;
        var cancelMessage = "";
        b.disabled = true; b.textContent = "Cancelling...";
        try {
            var tok = await R.csrf(), hdrs = R.authHeaders(true); if (tok) hdrs["X-CSRF-Token"] = tok;
            var r = await fetch("/api/my/orders/" + encodeURIComponent(order.id) + "/cancel", { method: "PATCH", headers: hdrs, credentials: "same-origin", body: JSON.stringify({ cancellation_reason: "Cancelled by customer." }) });
            if (!r.ok && r.status !== 404) {
                var msg = "This order can no longer be cancelled.";
                try { var j = await r.json(); if (j && j.message) msg = j.message; } catch (x) { }
                b.disabled = false; b.textContent = "Cancel order"; flash(msg, true); return;
            }
            var done = null; try { done = await r.json(); } catch (x) { }
            if (done && done.refund && done.refund.status === "pending") {
                order.refundStatus = "pending"; order.refundAmount = Number(done.refund.amount) || order.total; order.refundPhone = String(done.refund.phone || "");
            }
            if (done && done.message) cancelMessage = done.message;
        } catch (e) { /* offline or no API: keep the local copy in step */ }
        persistCancel();
        order.stage = -1; order.raw.status = "Cancelled";
        b.disabled = false; b.textContent = "Cancel order";
        render(); flash(cancelMessage || "Your order has been cancelled.");
    });

    /* ================= START ================= */
    function showError() { $("orderLoading").hidden = true; $("orderContent").hidden = true; $("orderError").hidden = false; hideLoader(); }

    /* ---------- the customer's saved orders ---------- */
    var LIST_STATUS = { "-1": "Cancelled", 0: "Pending", 1: "Confirmed", 2: "Out for delivery", 3: "Delivered" };
    async function showList() {
        var box = $("ordersList"), body = $("ordersListBody");
        $("orderLoading").hidden = true; $("orderError").hidden = true; $("orderContent").hidden = true;
        box.hidden = false;
        var r = null, list = null;
        try { r = await fetch("/api/my/orders", { headers: R.authHeaders(false), credentials: "same-origin", cache: "no-store" }); } catch (e) { }
        if (r && r.ok) { var j = await r.json(); list = j.orders || []; }
        if (!list) {
            var signedIn = r && r.status !== 401;
            body.innerHTML = '<div class="state"><h2>' + (signedIn ? "We couldn't load your orders" : "Sign in to see your orders") + '</h2><p>' + (signedIn ? "Please check your connection and try again." : "Your orders are saved to your GasHub account.") + '</p>' +
                '<a class="btn b" href="' + (signedIn ? "customer-orders.html" : "customer-login.html?next=customer-orders.html") + '">' + (signedIn ? "Try again" : "Sign in") + '</a></div>';
        } else if (!list.length) {
            body.innerHTML = '<div class="state"><h2>No orders yet</h2><p>When you order gas, it will show up here.</p><a class="btn y" href="customer-product.html">Shop now</a></div>';
        } else {
            body.innerHTML = list.map(function (o) {
                var st = stageOf(o.status), t = toMs(o.createdAt), more = (o.itemCount || 1) > 1 ? " + " + ((o.itemCount || 1) - 1) + " more" : "";
                return '<a class="card ol" href="customer-orders.html?orderId=' + encodeURIComponent(o.orderId) + '">' +
                    '<div class="ol-top"><b>' + esc(o.orderId) + '</b><span class="pill' + (st === 3 ? " s3" : (st === -1 ? " sx" : "")) + '">' + stageLabel(st, o.status) + '</span></div>' +
                    '<div class="ol-mid">' + esc((o.firstProduct || "Gas order") + more) + '</div>' +
                    '<div class="ol-bot"><span>' + esc(o.dealerName) + (t ? " · " + esc(fmtDT(t)) : "") + '</span><b>' + esc(money(o.total)) + '</b></div></a>';
            }).join("");
        }
        hideLoader();
    }

    async function start() {
        if (!wantId) { showList().catch(function (e) { console.error(e); showError(); }); return; }
        var res = await Promise.all([R.loadConfig().catch(function () { return R.config(); }), getOrder()]);
        cfg = res[0];
        if (!res[1]) { if (signedOut) { location.replace("customer-login.html?next=" + encodeURIComponent("customer-orders.html?orderId=" + wantId + "")); return; } showError(); return; }
        order = normalize(res[1]);
        render();
        $("orderLoading").hidden = true; $("orderError").hidden = true; $("orderContent").hidden = false;
        hideLoader();
        /* every time the customer opens an unpaid, confirmed order the pay pop-up shows (Close or Pay now).
           Not when they have just come back from the checkout (?view=order). */
        if (!skipCheckout && needsCheckout(order) && window.GasHubPayPopup) window.GasHubPayPopup.show(order.id);   /* it re-checks the order itself: never shown once paid */

        /* keep the elapsed / arriving time fresh, and pick up status changes from the server */
        setInterval(function () { if (!document.hidden && order.stage !== 3 && order.stage !== -1) renderTime(); }, 30000);
        setInterval(async function () {
            if (document.hidden || source !== "api" || order.stage === -1 || /^completed$/i.test(String(order.raw.status))) return;
            var fresh = await fetchApi(order.id);
            if (!fresh) return;
            var next = normalize(fresh);
            var sig = function (x) { return JSON.stringify([x.stage, x.raw.status, x.total, x.rider, x.dealerPhone, x.payStatus, x.method, x.methodChosen, x.raw.payments]); };
            if (sig(next) !== sig(order)) { order = next; render(); if (!needsCheckout(order) && window.GasHubPayPopup) window.GasHubPayPopup.hide(); }
        }, 30000);
    }
    start().catch(function (e) { console.error(e); showError(); });
})();