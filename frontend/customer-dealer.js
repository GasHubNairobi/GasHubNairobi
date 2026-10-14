/* GasHub customer dealers page.
   - Uses the location the customer pinned on the home page (no second pin)
   - Shared dealer data from customer-dealer-data.js (same dealers as the home page)
   - Same loading animation as the home page (customer-loader.js) */
(function () {
    "use strict";

    var G = window.GasHubDealers;
    var GP = window.GasHubProducts;   /* the shared product card (customer-product-card.js) */
    var API = "/api";
    var $ = function (s, p) { return (p || document).querySelector(s); };
    var $$ = function (s, p) { return Array.prototype.slice.call((p || document).querySelectorAll(s)); };
    var esc = G.esc;
    var safe = function (fn) { try { var r = fn(); return (r && r.catch) ? r.catch(console.error) : r; } catch (e) { console.error(e); } };
    var loader = {
        show: function (t, n) { if (window.CustomerLoader) window.CustomerLoader.show(t, n); },
        hide: function () { if (window.CustomerLoader) window.CustomerLoader.hide(); }
    };

    var state = { all: [], q: "", county: "all", avail: "all", current: null, tab: "products" };

    /* icons */
    var PIN = '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';
    var CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
    var USERS = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/></svg>';
    var BAG = '<svg viewBox="0 0 24 24"><path d="M6 2l-2 4v14h16V6l-2-4H6zM4 6h16M9 10a3 3 0 0 0 6 0"/></svg>';
    var CART = '<svg viewBox="0 0 24 24"><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 7H6"/></svg>';
    var PLUS = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/></svg>';
    var CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

    /* ================= MENU ================= */
    var menu = $("#mobileMenu"), scrim = $("#menuOverlay");
    function openMenu() { menu.classList.add("active"); scrim.classList.add("show"); menu.setAttribute("aria-hidden", "false"); }
    function closeMenu() { menu.classList.remove("active"); scrim.classList.remove("show"); menu.setAttribute("aria-hidden", "true"); }
    $("#menuBtn").addEventListener("click", openMenu);
    $("#closeMenuBtn").addEventListener("click", closeMenu);
    scrim.addEventListener("click", closeMenu);

    /* ================= LOCATION (pinned on the home page) ================= */
    function showLocation() {
        var label = G.locationLabel();
        if (label) $("#customerLocation").textContent = label;
    }

    /* ================= LIST ================= */
    /* the card itself lives in customer-dealer-data.js, so the home page shows exactly the same one */
    function cardHTML(d, km) { return G.cardHTML(d, km); }

    function render() {
        var hasLoc = !!G.getLocation();
        var q = state.q.trim().toLowerCase();
        var rows = state.all.map(function (d) { return { d: d, km: G.distanceKm(d) }; }).filter(function (r) {
            var d = r.d;
            if (q && (d.name + " " + d.location).toLowerCase().indexOf(q) === -1) return false;
            if (state.county !== "all" && d.county !== state.county) return false;
            if (state.avail === "open" && !d.open) return false;
            if (state.avail === "closed" && d.open) return false;
            return true;
        });
        rows.sort(function (a, b) {
            if ((a.km === null) !== (b.km === null)) return a.km === null ? 1 : -1;
            if (a.km !== null && b.km !== null && a.km !== b.km) return a.km - b.km;
            return (b.d.rating || 0) - (a.d.rating || 0) || b.d.followers - a.d.followers;
        });

        $("#locNote").hidden = hasLoc;
        $("#dealerCount").textContent = rows.length + (rows.length === 1 ? " dealer" : " dealers") + (hasLoc ? " · closest first" : "");
        $("#dealerEmpty").hidden = rows.length > 0;
        $("#dealerList").innerHTML = rows.map(function (r) { return cardHTML(r.d, r.km); }).join("");
    }

    function resetFilters() {
        state.q = ""; state.county = "all"; state.avail = "all";
        $("#dealerSearch").value = ""; $("#countyFilter").value = "all"; $("#availabilityFilter").value = "all";
        render();
    }

    $("#dealerSearch").addEventListener("input", function (e) { state.q = e.target.value; render(); });
    $("#countyFilter").addEventListener("change", function (e) { state.county = e.target.value; render(); });
    $("#availabilityFilter").addEventListener("change", function (e) { state.avail = e.target.value; render(); });
    $("#resetFilters").addEventListener("click", resetFilters);
    $("#emptyResetButton").addEventListener("click", resetFilters);

    var list = $("#dealerList");
    list.addEventListener("click", function (e) { var c = e.target.closest(".dcard"); if (c) openModal(c.dataset.id); });
    list.addEventListener("keydown", function (e) { if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("dcard")) { e.preventDefault(); openModal(e.target.dataset.id); } });

    /* ================= DEALER DETAILS ================= */
    var modal = $("#dealerModal"), body = $("#modalBody");
    function find(id) { return state.all.filter(function (d) { return d.id === String(id); })[0]; }

    function stars(r) { var pct = Math.max(0, Math.min(5, Number(r) || 0)) / 5 * 100; return '<span class="stars" style="--r:' + pct + '%" aria-hidden="true">★★★★★</span>'; }

    function followBtnHTML(d) {
        var on = G.isFollowing(d.id);
        return '<button type="button" class="m-follow' + (on ? ' on' : '') + '" id="followBtn" aria-pressed="' + on + '">' + (on ? CHECK : PLUS) +
            (on ? 'Following' : 'Follow') + ' <small>· ' + G.fmtCount(G.followerCount(d)) + ' followers</small></button>';
    }

    function openModal(id, tab) {
        var d = find(id);
        if (!d) return;
        state.current = d; state.tab = tab || "products";
        var km = G.distanceKm(d), hasLoc = !!G.getLocation();
        var deliv;
        if (km != null) deliv = d.open ? '<div class="m-deliv ok">Open now · ' + G.fmtKm(km) + ' from your pinned location · about ' + G.fmtEta(G.etaMin(km)) + ' delivery</div>'
            : '<div class="m-deliv bad">Closed now · ' + G.fmtKm(km) + ' away. You can still chat and order for later.</div>';
        else deliv = '<div class="m-deliv ' + (d.open ? 'ok' : 'bad') + '">' + (d.open ? 'Open now' : 'Closed now') + (hasLoc ? '' : ' · pin your location on the home page to see distance and delivery time') + '</div>';

        body.innerHTML =
            '<div class="m-head"><div class="m-logo">' + (d.logo ? '<img src="' + esc(d.logo) + '" alt="">' : esc(G.initials(d.name))) + '</div>' +
            '<div class="m-title"><h2><span>' + esc(d.name) + '</span>' + G.badge(d).replace('class="vbadge"', 'class="vbadge lg"') + '</h2>' +
            '<div class="m-loc">' + PIN + esc(d.location) + '</div>' +
            '<div class="m-badges">' + (d.rating == null ? '<span class="rate"><small>New dealer</small></span>' :
                '<span class="rate">' + stars(d.rating) + '<b>' + Number(d.rating).toFixed(1) + '</b><small>(' + G.fmtCount(d.reviews) + ' reviews)</small></span>') +
            '<span class="pill ' + (d.open ? 'ok' : 'bad') + '"><i></i>' + (d.open ? 'Open now' : 'Closed') + '</span></div></div></div>' +
            deliv +
            '<div class="m-facts"><div><span>Hours</span><strong>' + esc(d.hours) + '</strong></div>' +
            '<div><span>Orders</span><strong>' + G.fmtCount(d.orders) + '+</strong></div>' +
            '<div><span>Followers</span><strong id="mFollowers">' + G.fmtCount(G.followerCount(d)) + '</strong></div>' +
            '<div><span>Verified</span><strong>' + (d.verified ? 'Yes, by GasHub' : 'Not yet') + '</strong></div></div>' +
            '<div id="followWrap">' + followBtnHTML(d) + '</div>' +
            '<h3 class="m-sub">About</h3><p class="m-about">' + esc(d.about) + '</p>' +
            (d.services.length ? '<div class="m-services">' + d.services.map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') + '</div>' : '') +
            '<p class="m-privacy">Phone numbers stay private. Chat and order inside GasHub.</p>' +
            '<div class="m-tabs" role="tablist"><button type="button" data-tab="products">Products</button><button type="button" data-tab="reviews">Reviews</button><button type="button" data-tab="chat">Chat</button></div>' +
            '<div id="mPanel"></div>';

        modal.hidden = false;
        document.body.classList.add("lock");
        $(".modal-card", modal).scrollTop = 0;
        setTab(state.tab);
    }
    function closeModal() {
        modal.hidden = true; document.body.classList.remove("lock"); state.current = null;
        try { var u = new URL(location.href); if (u.searchParams.has("id")) { u.searchParams.delete("id"); history.replaceState(null, "", u.pathname + u.search); } } catch (e) { }
    }
    $("#modalClose").addEventListener("click", closeModal);
    $("#modalOverlay").addEventListener("click", closeModal);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { if (!modal.hidden) closeModal(); closeMenu(); } });

    body.addEventListener("click", function (e) {
        var t = e.target.closest("[data-tab]");
        if (t) { setTab(t.dataset.tab); return; }
        if (e.target.closest("#followBtn") && state.current) {
            G.toggleFollow(state.current.id);
            $("#followWrap").innerHTML = followBtnHTML(state.current);
            $("#mFollowers").textContent = G.fmtCount(G.followerCount(state.current));
            render();
            return;
        }
        var act = e.target.closest(".gcard [data-act]");
        if (act && state.current) {
            var pid = act.closest(".gcard").dataset.id;
            var prod = (state.current.products || []).filter(function (x) { return x.id === pid; })[0];
            if (!prod) return;
            if (act.dataset.act === "fav") {
                var on = GP.toggleFav(prod.id);
                act.classList.toggle("on", on); act.setAttribute("aria-pressed", on);
            } else if (act.dataset.act === "cart") {
                if (GP.isAvail(prod)) { GP.trackView(prod); location.href = GP.checkoutUrl(prod); }
            } else if (act.dataset.act === "view") { GP.trackView(prod); }   /* the link then opens the product page */
        }
    });

    function setTab(tab) {
        state.tab = tab;
        $$(".m-tabs button", body).forEach(function (b) { b.classList.toggle("on", b.dataset.tab === tab); b.setAttribute("aria-selected", b.dataset.tab === tab); });
        var d = state.current, panel = $("#mPanel");
        if (!d || !panel) return;
        if (tab === "products") productsPanel(d, panel);
        else if (tab === "reviews") reviewsPanel(d, panel);
        else chatPanel(d, panel);
    }

    /* ---------- products ---------- */
    /* same product rules and same card as the home page and the Products page (customer-product-card.js) */
    function normProd(p, i) {
        if (p && p._gp) return p;
        var n = GP.normalize(p, i);
        /* a product shown on this dealer's page belongs to this dealer */
        n.dealer = state.current ? state.current.name : n.dealer;
        n.dealerId = state.current ? String(state.current.id) : n.dealerId;
        if (state.current) n.dealerVerified = !!state.current.verified;
        if (state.current) {
            if (state.current.rating != null) n.rating = state.current.rating;
            if (n.lat == null) n.lat = state.current.lat;
            if (n.lng == null) n.lng = state.current.lng;
        }
        n._gp = true;
        return n;
    }
    async function dealerProducts(d) {
        if (d.products) { d.products = d.products.map(normProd); return d.products; }
        var found = null;
        try {
            var r = await fetch(API + "/dealers/" + encodeURIComponent(d.id) + "/products", { headers: { Accept: "application/json" } });
            if (r.ok) { var j = await r.json(); var l = Array.isArray(j) ? j : j.products || j.data || []; if (l.length) found = l; }
        } catch (e) { }
        if (!found) {
            try {
                var r2 = await fetch(API + "/products", { headers: { Accept: "application/json" } });
                if (r2.ok) {
                    var j2 = await r2.json(); var l2 = Array.isArray(j2) ? j2 : j2.products || j2.data || [];
                    found = l2.filter(function (p) { return String(p.dealerId != null ? p.dealerId : (p.dealer_id != null ? p.dealer_id : (p.dealer && p.dealer.id))) === d.id; });
                }
            } catch (e) { }
        }
        d.products = (found || []).map(normProd);
        return d.products;
    }
    async function productsPanel(d, panel) {
        var needsFetch = !d.products;
        if (needsFetch) loader.show("Loading dealer details...", "Getting products and reviews");
        var items;
        try { items = await dealerProducts(d); } finally { if (needsFetch) loader.hide(); }
        if (state.current !== d || state.tab !== "products") return;
        if (!items.length) { panel.innerHTML = '<div class="m-empty">This dealer has not listed any products yet.</div>'; return; }
        var favs = GP.getFavs();
        panel.innerHTML = '<div class="m-products">' + items.map(function (p) {
            return GP.cardHTML(p, favs, { viewHref: GP.productHref(p) });
        }).join('') + '</div>';
        GP.watchImages(panel);
    }
    /* ---------- safety: no phone numbers in chat or reviews ---------- */
    var PHONE = /(\+?\d[\s\-.]?){9,}/;
    function customerName() {
        var c = null, keys = ["customer", "user", "customerData", "currentUser"];
        for (var i = 0; i < keys.length && !c; i++) c = G.read(keys[i], null);
        if (!c) return "You";
        var n = c.name || c.full_name || c.fullName || ((c.first_name || "") + " " + (c.last_name || "")).trim();
        return n ? n.split(" ")[0] : "You";
    }
    function authHeaders() { var t = G.token(); var h = { "Content-Type": "application/json" }; if (t) h.Authorization = "Bearer " + t; return h; }
    function fmtDate(v) { try { return new Date(v).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return ""; } }

    /* ---------- reviews ---------- */
    function allReviews(d) {
        var mine = G.read("gasHubReviews_" + d.id, []);
        return mine.concat(d.reviewsList.map(function (r) { return { name: r.name || r.customer_name || "Customer", rating: Number(r.rating) || 0, text: r.text || r.comment || r.review || "", date: r.date || r.created_at || "", verified: true }; }));
    }
    function reviewsPanel(d, panel) {
        var rs = allReviews(d), total = rs.length;
        var avg = total ? rs.reduce(function (s, r) { return s + r.rating; }, 0) / total : (d.rating || 0);
        var counts = [0, 0, 0, 0, 0, 0];
        rs.forEach(function (r) { counts[Math.max(1, Math.min(5, Math.round(r.rating)))]++; });
        var bars = [5, 4, 3, 2, 1].map(function (n) { var pc = total ? counts[n] / total * 100 : 0; return '<div><span>' + n + '★</span><i><u style="width:' + pc + '%"></u></i><em>' + counts[n] + '</em></div>'; }).join("");
        panel.innerHTML =
            '<div class="rv-sum"><div class="rv-big"><b>' + (avg ? avg.toFixed(1) : '–') + '</b>' + stars(avg) + '<small>' + (total || d.reviews || 0) + ' reviews</small></div><div class="rv-bars">' + bars + '</div></div>' +
            '<form class="rv-form" id="rvForm"><h3>Rate this dealer</h3><div class="rv-stars" id="rvStars">' +
            [1, 2, 3, 4, 5].map(function (n) { return '<button type="button" data-s="' + n + '" aria-label="' + n + ' star' + (n > 1 ? 's' : '') + '">★</button>'; }).join('') +
            '</div><textarea id="rvText" maxlength="400" placeholder="Share your experience (optional)"></textarea>' +
            '<div id="rvWarn"></div><button type="submit" class="rv-submit">Submit review</button><p class="rv-note">Reviews are public. Do not share phone numbers.</p></form>' +
            '<div id="rvFlash"></div>' +
            '<div class="rv-list">' + (rs.length ? rs.map(function (r) {
                return '<div class="rv"><div class="rv-top"><span class="rv-name">' + esc(r.name) + (r.verified ? '<em>Customer</em>' : '') + '</span><span class="rv-date">' + esc(fmtDate(r.date)) + '</span></div>' + stars(r.rating) +
                    (r.text ? '<p>' + esc(r.text) + '</p>' : '') + '</div>';
            }).join('') : '<div class="m-empty">No reviews yet. Be the first to review this dealer.</div>') + '</div>';

        var chosen = 0;
        $("#rvStars", panel).addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b) return;
            chosen = Number(b.dataset.s);
            $$("#rvStars button", panel).forEach(function (x) { x.classList.toggle("on", Number(x.dataset.s) <= chosen); });
        });
        $("#rvForm", panel).addEventListener("submit", function (e) {
            e.preventDefault();
            var warn = $("#rvWarn", panel), text = $("#rvText", panel).value.trim();
            warn.innerHTML = "";
            if (!chosen) { warn.innerHTML = '<div class="chat-warn">Please choose a star rating.</div>'; return; }
            if (PHONE.test(text)) { warn.innerHTML = '<div class="chat-warn">For your safety, phone numbers cannot be shared in reviews.</div>'; return; }
            var rev = { name: customerName(), rating: chosen, text: text, date: new Date().toISOString(), verified: true };
            var mine = G.read("gasHubReviews_" + d.id, []); mine.unshift(rev); G.write("gasHubReviews_" + d.id, mine.slice(0, 20));
            try { fetch(API + "/dealers/" + encodeURIComponent(d.id) + "/reviews", { method: "POST", headers: authHeaders(), body: JSON.stringify({ rating: chosen, comment: text }) }).catch(function () { }); } catch (x) { }
            reviewsPanel(d, panel);
            $("#rvFlash", panel).innerHTML = '<div class="rv-flash">Thank you! Your review was added.</div>';
        });
    }

    /* ---------- chat ---------- */
    var CHIPS = ["Is 13kg gas available?", "How long is delivery?", "What is the refill price?"];
    function chatPanel(d, panel) {
        var key = "gasHubChat_" + d.id;
        var msgs = [], failed = [];
        function msgsHTML() {
            var h = '<div class="bubble sys">Chat with ' + esc(d.name) + '. ' + (d.open ? 'They are online and will reply here.' : 'They are closed now and will reply when they open.') + '</div>';
            var all = []; for (var i = 0; i <= msgs.length; i++) { failed.forEach(function (f) { if (f.after === i || (i === msgs.length && f.after > msgs.length)) all.push(f); }); if (i < msgs.length) all.push(msgs[i]); }
            return h + all.map(function (m, idx) {
                if (m.failed) {
                    return '<div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;align-self:flex-end;max-width:100%"><button type="button" class="failed-why" data-i="' + m.fid + '" aria-label="Why was this not sent?" title="Not sent. Tap to see why" style="border:0;background:none;padding:0;cursor:pointer;line-height:0;flex:none"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#dc2626"/><path d="M6.5 17.5l11-11" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="12" r="6.2" fill="none" stroke="#fff" stroke-width="2"/></svg></button><div class="bubble me" style="opacity:.75;margin:0">' + esc(m.text) + '<small>Not sent</small></div></div>' +
                        (m.open ? '<div style="align-self:flex-end;max-width:90%;margin:-2px 0 4px;font-size:12px;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:6px 8px">' + esc(m.reason) + '</div>' : '');
                }
                return '<div class="bubble ' + (m.from === "me" ? "me" : "dealer") + '">' + esc(m.text) + '<small>' + esc(new Date(m.t).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })) + '</small></div>';
            }).join("");
        }
        panel.innerHTML =
            '<div class="chat-box"><div class="chat-top"><div class="chat-avatar">' + esc(G.initials(d.name)) + '</div><div class="chat-who"><strong>' + esc(d.name) + '</strong>' +
            '<div class="chat-status ' + (d.open ? 'on' : '') + '"><i></i>' + (d.open ? 'Online' : 'Offline') + '</div></div></div>' +
            '<div class="chat-msgs" id="chatMsgs">' + msgsHTML() + '</div>' +
            '<div class="chat-chips">' + CHIPS.map(function (c) { return '<button type="button">' + esc(c) + '</button>'; }).join('') + '</div>' +
            '<div id="chatWarn"></div>' +
            '<form class="chat-form" id="chatForm"><input id="chatInput" maxlength="300" placeholder="Type a message..." autocomplete="off" aria-label="Message"><button type="submit">Send</button></form>' +
            '</div>';
        var box = $("#chatMsgs", panel); box.scrollTop = box.scrollHeight;
        var thread = API + "/messages?dealer_id=" + encodeURIComponent(d.id) + "&product_id=";
        function csrf() { return fetch(API + "/auth/csrf", { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) { return (j && j.csrfToken) || ""; }); }
        function addFailed(text, reason) { failed.push({ from: "me", text: text, t: new Date().toISOString(), failed: true, after: msgs.length, reason: reason, open: false, fid: failed.length }); box.innerHTML = msgsHTML(); box.scrollTop = box.scrollHeight; }
        box.addEventListener("click", function (e) { var b = e.target.closest(".failed-why"); if (!b) return; var f = failed[Number(b.dataset.i)]; if (f) { f.open = !f.open; box.innerHTML = msgsHTML(); } });
        function warnMsg(html) { $("#chatWarn", panel).innerHTML = '<div class="chat-warn">' + html + '</div>'; }
        /* Loads the saved conversation, including the dealer's replies. */
        function load() {
            fetch(thread, { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.status === 401 ? null : r.json(); }).then(function (j) {
                if (!j || !j.success) return;
                var next = (j.messages || []).map(function (m) { return { from: m.from === "customer" ? "me" : "dealer", text: m.text, t: m.t }; });
                if (next.length !== msgs.length) { msgs = next; box.innerHTML = msgsHTML(); box.scrollTop = box.scrollHeight; }
            }).catch(function () { });
        }
        function send(text) {
            text = text.trim(); if (!text) return;
            $("#chatWarn", panel).innerHTML = "";
            if (PHONE.test(text)) { addFailed(text, "This message appears to go against the user agreement."); return; }
            csrf().then(function (token) {
                return fetch(API + "/messages", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": token }, body: JSON.stringify({ dealer_id: d.id, product_id: "", message: text }) });
            }).then(function (r) {
                if (r.status === 401) { warnMsg('Please <a href="customer-login.html">sign in</a> to message this dealer.'); return null; }
                return r.json().then(function (j) { return { ok: r.ok, j: j }; });
            }).then(function (res) {
                if (!res) return;
                if (res.j.code === "blocked") { addFailed(text, res.j.message); return; }
                if (!res.ok || !res.j.success) { warnMsg(esc(res.j.message || "Your message could not be sent. Please try again.")); return; }
                msgs.push({ from: "me", text: text, t: res.j.message.t || new Date().toISOString() });
                box.innerHTML = msgsHTML(); box.scrollTop = box.scrollHeight;
            }).catch(function () { warnMsg("Your message could not be sent. Check your connection and try again."); });
        }
        $("#chatForm", panel).addEventListener("submit", function (e) { e.preventDefault(); var i = $("#chatInput", panel); var v = i.value; i.value = ""; send(v); });
        $$(".chat-chips button", panel).forEach(function (b) { b.addEventListener("click", function () { send(b.textContent); }); });
        load();
        clearInterval(window.__gasHubDealerChatTimer);
        var timer = window.__gasHubDealerChatTimer = setInterval(function () { if (!document.body.contains(box)) { clearInterval(timer); return; } load(); }, 6000);
    }

    /* ================= PURCHASE HISTORY (from the home extras file) ================= */
    async function purchaseCounts() {
        var counts = {};
        function add(id, name, q) { var k = String(id != null ? id : name); counts[k] = counts[k] || { n: 0, name: name }; counts[k].n += Number(q) || 1; }
        try {
            var r = await fetch(API + "/orders", { headers: G.token() ? { Authorization: "Bearer " + G.token() } : {} });
            if (r.ok) {
                var d = await r.json();
                (Array.isArray(d) ? d : d.orders || d.data || []).forEach(function (o) {
                    (o.items || o.products || []).forEach(function (i) { add(i.product_id != null ? i.product_id : i.id, i.name || i.product_name, i.quantity != null ? i.quantity : i.qty); });
                });
            }
        } catch (e) { /* use local history */ }
        if (!Object.keys(counts).length) (G.read("gasHubPurchases", []) || []).forEach(function (h) { add(h.id, h.name, h.qty); });
        return counts;
    }

    /* ================= START ================= */
    async function start() {
        safe(showLocation);
        var minWait = new Promise(function (r) { setTimeout(r, 1000); });
        try { state.all = await G.load(); } catch (e) { console.error(e); state.all = []; }
        await minWait;
        $("#dealerLoading").hidden = true;
        render();
        var want = new URLSearchParams(location.search).get("id");
        if (want && find(want)) openModal(want);
        loader.hide();
    }
    start().catch(function (e) { console.error(e); $("#dealerLoading").hidden = true; render(); loader.hide(); });
})();