/* GasHub customer profile.
   Everything runs inside one function and each part starts on its own,
   so a problem in one section can never break the others. */
(function () {
    "use strict";

    const API = "/api";

    /* ---- storage keys. Change a name here if another page saves under a different one ---- */
    const K = {
        customer: ["gasHubCustomer", "gasHubCustomerProfile", "customer", "user", "customerData", "currentUser"],
        profile: "gasHubCustomerProfile",
        main: "gasHubCustomer",
        session: "gasHubCustomerSession",
        logged: "gasHubLoggedIn",
        orders: "gasHubOrderHistory",
        last: "gasHubLastOrder",
        photo: "gasHubProfilePhoto",
        points: "gasHubPoints",
        rate: "gasHubRewardSettings",      /* the admin page can write the rate here */
        contact: "gasHubContact",          /* the admin page can write call / WhatsApp numbers here */
        favs: ["gasHubFavourites", "gasHubFavorites", "gasHubFavs", "favourites", "favorites"],
        follows: ["gasHubFollowedDealers", "gasHubFollowing", "gasHubFollowedDealer", "followedDealers"],
        notify: "gasHubNotify",
        del: "gasHubDeletionRequest",
        location: "gasHubLocation"
    };
    const DELETE_DAYS = 7;

    /* ---- small helpers ---- */
    const $ = (s, p = document) => p.querySelector(s);
    const $$ = (s, p = document) => [...p.querySelectorAll(s)];
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const store = {
        get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
    };
    const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
    const safe = fn => { try { const r = fn(); if (r && r.catch) r.catch(console.error); } catch (e) { console.error(e); } };
    const num = v => (v === null || v === undefined || v === "" || isNaN(Number(v))) ? null : Number(v);
    const money = v => "KSh " + (Number(v) || 0).toLocaleString("en-KE", { maximumFractionDigits: 0 });
    const fmtDate = (t, o) => new Date(t).toLocaleDateString("en-KE", o || { day: "numeric", month: "long", year: "numeric" });

    let toastTimer;
    function toast(msg) {
        const t = $("#toast"); if (!t) return;
        t.textContent = msg; t.classList.add("show");
        clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
    }

    /* ---- login state ---- */
    function authToken() {
        return localStorage.getItem("token") || localStorage.getItem("customerToken") || localStorage.getItem("authToken") ||
            sessionStorage.getItem("token") || sessionStorage.getItem("customerToken") || sessionStorage.getItem("authToken") || "";
    }
    function loggedIn() {
        const flag = localStorage.getItem(K.logged);
        return !!(authToken() || store.get(K.session) || (flag && flag !== "false" && flag !== "0"));
    }
    const authHeaders = () => { const t = authToken(); return t ? { Authorization: "Bearer " + t } : {}; };
    async function rawJSON(path) {
        try { const r = await fetch(API + path, { headers: authHeaders() }); return r.ok ? await r.json() : null; } catch (e) { return null; }
    }
    async function getJSON(path) {
        const d = await rawJSON(path);
        return d && !Array.isArray(d) && d.data && typeof d.data === "object" && !Array.isArray(d.data) ? d.data : d;
    }
    async function getList(path, key) {
        const d = await rawJSON(path);
        if (!d) return null;
        const l = Array.isArray(d) ? d : d[key] || d.data || [];
        return Array.isArray(l) ? l : null;
    }

    /* talking to our own server with the signed-in cookie (writes also need the CSRF token) */
    let csrfToken = "";
    async function getCsrf() {
        if (csrfToken) return csrfToken;
        try {
            const r = await fetch(API + "/auth/csrf", { credentials: "same-origin", cache: "no-store" });
            csrfToken = ((await r.json()) || {}).csrfToken || "";
        } catch (e) { }
        return csrfToken;
    }
    async function call(path, opts, retried) {
        opts = opts || {};
        const method = opts.method || "GET", headers = { Accept: "application/json", ...authHeaders() };
        if (opts.body !== undefined) headers["Content-Type"] = "application/json";
        if (method !== "GET") headers["X-CSRF-Token"] = await getCsrf();
        try {
            const res = await fetch(API + path, {
                method, headers, credentials: "same-origin", cache: "no-store",
                body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
            });
            let data = {}; try { data = await res.json(); } catch (e) { }
            if (res.status === 403 && data && data.code === "csrf" && !retried) { csrfToken = ""; return call(path, opts, true); }
            return { ok: res.ok, status: res.status, data: data || {} };
        } catch (e) { return { ok: false, status: 0, data: {}, network: true }; }
    }
    const signInAgain = () => toast("Please sign in again to do that.");

    function customerRecord() {
        for (const k of K.customer) { const v = store.get(k); if (v && typeof v === "object") return v; }
        return null;
    }
    function info() {
        const c = customerRecord() || {};
        return {
            name: c.fullName || c.name || c.full_name || `${c.first_name || ""} ${c.last_name || ""}`.trim(),
            phone: c.phone || c.phoneNumber || c.phone_number || "",
            email: c.email || "",
            address: c.address || c.deliveryAddress || c.delivery_address || "",
            since: c.createdAt || c.created_at || c.joinedAt || c.memberSince || ""
        };
    }
    const initials = name => {
        const w = String(name || "").trim().split(/\s+/).filter(Boolean);
        return !w.length ? "C" : w.length === 1 ? w[0][0].toUpperCase() : (w[0][0] + w[w.length - 1][0]).toUpperCase();
    };

    /* ================= SHEETS (pop-ups) ================= */
    function openSheet(id) {
        const s = $("#" + id); if (!s) return;
        s.classList.add("open"); s.setAttribute("aria-hidden", "false"); document.body.classList.add("lock");
    }
    function closeSheets() {
        $$(".sheet.open").forEach(s => { s.classList.remove("open"); s.setAttribute("aria-hidden", "true"); });
        document.body.classList.remove("lock");
    }
    $$(".sheet").forEach(s => s.addEventListener("click", e => { if (e.target === s || e.target.closest("[data-close]")) closeSheets(); }));

    /* ================= SIDE MENU ================= */
    const menu = $("#mobileMenu"), scrim = $("#menuOverlay");
    function openMenu() { menu.classList.add("active"); scrim.classList.add("show"); menu.setAttribute("aria-hidden", "false"); }
    function closeMenu() { menu.classList.remove("active"); scrim.classList.remove("show"); menu.setAttribute("aria-hidden", "true"); }
    on("#menuBtn", "click", openMenu);
    on("#closeMenuBtn", "click", closeMenu);
    if (scrim) scrim.addEventListener("click", closeMenu);

    /* ================= PROFILE HEADER ================= */
    function renderAvatar() {
        const photo = store.get(K.photo), img = $("#avatarImg"), txt = $("#avatarText");
        if (photo && typeof photo === "string") {
            img.referrerPolicy = "no-referrer";                 /* Google photos only load without a referrer */
            img.onerror = () => { img.hidden = true; img.removeAttribute("src"); txt.hidden = false; txt.textContent = loggedIn() ? initials(info().name) : "C"; };
            img.src = photo; img.hidden = false; txt.hidden = true; $("#btnRemovePhoto").hidden = false;
        } else {
            img.hidden = true; img.removeAttribute("src"); txt.hidden = false;
            txt.textContent = loggedIn() ? initials(info().name) : "C";
            $("#btnRemovePhoto").hidden = true;
        }
    }
    function renderHero() {
        const li = loggedIn(), c = info();
        $("#profileName").textContent = li ? (c.name || "Customer") : "Welcome to GasHub";
        $("#profileSub").textContent = li ? (c.email || c.phone || "Signed in") : "Sign in to see your orders, rewards and favourites.";
        $("#guestCta").hidden = li;
        $("#statsRow").hidden = !li;
        const ms = $("#memberSince"), d = c.since ? new Date(c.since) : null;
        if (li && d && !isNaN(d)) { ms.textContent = "Member since " + fmtDate(d, { month: "short", year: "numeric" }); ms.hidden = false; } else ms.hidden = true;
        $$("[data-auth]").forEach(el => { el.hidden = el.dataset.auth === "in" ? !li : li; });
        renderAvatar();
    }

    /* ---- profile photo: gallery or camera ---- */
    on("#btnGallery", "click", () => $("#galInput").click());
    on("#btnCamera", "click", () => $("#camInput").click());
    on("#btnRemovePhoto", "click", () => { localStorage.removeItem(K.photo); try { localStorage.setItem("gasHubPhotoRemoved", "1"); } catch (e) { } renderAvatar(); if (window.GasHubPhoto) window.GasHubPhoto.paint(); toast("Photo removed"); });
    window.addEventListener("gashub-photo", renderAvatar);
    function handleFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { toast("Please choose an image."); return; }
        if (file.size > 15 * 1024 * 1024) { toast("That photo is too large. Choose one under 15 MB."); return; }
        const url = URL.createObjectURL(file), img = new Image();
        img.onload = () => {
            const S = 320, c = document.createElement("canvas"); c.width = c.height = S;
            const m = Math.min(img.width, img.height);
            c.getContext("2d").drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S);   /* square crop */
            URL.revokeObjectURL(url);
            if (store.set(K.photo, c.toDataURL("image/jpeg", .82))) { try { localStorage.removeItem("gasHubPhotoRemoved"); } catch (e) { } renderAvatar(); if (window.GasHubPhoto) window.GasHubPhoto.paint(); toast("Photo updated"); } else toast("Could not save the photo on this device.");
            if (loggedIn()) c.toBlob(b => {      /* also send it to the server when it is available */
                if (!b) return;
                const fd = new FormData(); fd.append("photo", b, "profile.jpg");
                fetch(API + "/customer/photo", { method: "POST", headers: authHeaders(), body: fd }).catch(() => { });
            }, "image/jpeg", .82);
        };
        img.onerror = () => { URL.revokeObjectURL(url); toast("Could not read that photo."); };
        img.src = url;
    }
    ["#galInput", "#camInput"].forEach(sel => on(sel, "change", e => { handleFile(e.target.files && e.target.files[0]); e.target.value = ""; }));

    /* ---- order numbers ---- */
    function getOrders() {
        let orders = store.get(K.orders);
        if (!Array.isArray(orders)) orders = [];
        const last = store.get(K.last);
        if (last && typeof last === "object") {
            const id = last.orderId || last.id || last.order_id;
            if (!orders.some(o => id && (o.orderId || o.id || o.order_id) === id)) orders.unshift(last);
        }
        return orders;
    }
    /* the real numbers come from the server (counted from the customer's orders in the database);
       this phone's own saved list is only used while offline or signed out */
    function paintStats(total, done, spent) {
        $("#totalOrders").textContent = total;
        $("#completedOrders").textContent = done;
        $("#totalSpent").textContent = money(spent);
    }
    async function loadStats() {
        if (!loggedIn()) return;
        const r = await call("/customer/stats");
        if (r.ok && r.data && r.data.orders) paintStats(r.data.orders.total, r.data.orders.completed, r.data.spent);
    }
    function renderStats() {
        const orders = getOrders();
        let done = 0, spent = 0;
        orders.forEach(o => {
            const s = String(o.status || o.orderStatus || "").trim().toLowerCase().replace(/\s+/g, "");
            if (s === "completed" || s === "complete" || s === "delivered") done++;
            spent += Number(o.total || o.totalAmount || o.amount || o.price || 0);
        });
        paintStats(orders.length, done, spent);
        safe(loadStats);
    }

    /* ================= ACCOUNT DETAILS (closed until Edit is tapped) ================= */
    function loadForm() {
        const c = info();
        $("#fullName").value = c.name; $("#phone").value = c.phone; $("#email").value = c.email;
        $("#address").value = c.address;                      /* shown, but locked: it is the address entered at sign-up */
    }
    function renderSummary() {
        const c = info(), bits = [c.name, c.phone].filter(Boolean);
        $("#acctSummary").textContent = bits.length ? bits.join(" · ") : "Name, phone and email";
    }
    function setEditing(open) {
        const btn = $("#editAccountBtn"), panel = $("#accountPanel");
        btn.setAttribute("aria-expanded", String(open)); panel.hidden = !open;
        btn.querySelector("span").textContent = open ? "Close" : "Edit";
        if (open) { loadForm(); formMsg($("#profileMessage"), "", ""); setTimeout(() => $("#fullName").focus({ preventScroll: true }), 80); }
    }
    on("#editAccountBtn", "click", () => setEditing($("#editAccountBtn").getAttribute("aria-expanded") !== "true"));
    on("#cancelEditBtn", "click", () => setEditing(false));

    function normalizePhone(v) {
        let n = String(v || "").replace(/[^\d+]/g, "");      /* drop spaces, dashes, brackets and hidden characters */
        if (n.startsWith("+")) n = n.slice(1);
        if (n.startsWith("00254")) n = n.slice(2);
        if (n.startsWith("254")) { n = n.slice(3); if (n.startsWith("0")) n = n.slice(1); n = "0" + n; }   /* +254712.. / 254712.. / +2540712.. */
        else if (/^[17]\d{8}$/.test(n)) n = "0" + n;                                                  /* 712345678 */
        return n;
    }
    function formMsg(el, text, type) { el.textContent = text; el.className = text ? `form-message show ${type}` : "form-message"; }

    /* keep this phone's copy of the customer in step with what the server saved */
    function applyCustomer(c) {
        const old = customerRecord() || {};
        const name = c.fullName || c.full_name || c.name || old.fullName || "";
        const rec = {
            ...old, id: c.id ?? old.id, fullName: name, name,
            email: c.email || old.email || "", phone: c.phone || old.phone || "",
            address: c.address ?? old.address ?? "", createdAt: c.createdAt || c.created_at || old.createdAt || ""
        };
        store.set(K.main, rec); store.set("customer", rec);
        if (c.photo && /^https:\/\//.test(c.photo) && !store.get(K.photo) && !localStorage.getItem("gasHubPhotoRemoved")) { store.set(K.photo, c.photo); renderAvatar(); }   /* Google photo when none was chosen here */
        store.set(K.profile, { fullName: rec.fullName, phone: rec.phone, email: rec.email, address: rec.address });
        const session = store.get(K.session);
        if (session && typeof session === "object") store.set(K.session, { ...session, email: rec.email });
    }

    on("#profileForm", "submit", async e => {
        e.preventDefault();
        const msg = $("#profileMessage"), save = $("#saveProfileButton");
        ["fullName", "phone", "email"].forEach(id => { $("#" + id + "Error").textContent = ""; });
        formMsg(msg, "", "");
        const name = $("#fullName").value.trim(), phone = normalizePhone($("#phone").value), email = $("#email").value.trim();
        let ok = true;
        if (name.length < 2) { $("#fullNameError").textContent = "Enter your full name."; ok = false; }
        if (!phone) { $("#phoneError").textContent = "Enter your phone number."; ok = false; }
        else if (!/^(07|01)\d{8}$/.test(phone)) { $("#phoneError").textContent = "Enter a valid Kenyan phone number."; ok = false; }
        if (!email) { $("#emailError").textContent = "Enter your email address."; ok = false; }
        else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $("#emailError").textContent = "Enter a valid email address."; ok = false; }
        if (!ok) { formMsg(msg, "Please correct the highlighted information.", "error"); return; }

        save.disabled = true; save.textContent = "Saving...";
        const res = await call("/customer/profile", { method: "PUT", body: { fullName: name, phone, email } });
        save.disabled = false; save.textContent = "Save changes";

        if (res.ok && res.data.customer) {
            applyCustomer(res.data.customer);
            renderHero(); renderSummary(); loadForm();
            formMsg(msg, "Your details have been saved.", "success");
            toast("Details saved");
            setTimeout(() => setEditing(false), 1100);
            return;
        }
        const field = res.data && res.data.field;
        if (field && $("#" + field + "Error")) $("#" + field + "Error").textContent = res.data.message || "Check this field.";
        if (res.status === 401) formMsg(msg, "Your sign-in has expired. Please sign in again, then save.", "error");
        else if (res.network || res.status === 404 || res.status === 501) formMsg(msg, "We can't reach GasHub right now, so nothing was saved. Check your connection and try again.", "error");
        else formMsg(msg, (res.data && res.data.message) || "We couldn't save your details. Please try again.", "error");
    });

    on("#changePasswordButton", "click", () => {
        ["currentPassword", "newPassword", "confirmNewPassword"].forEach(id => { $("#" + id).value = ""; $("#" + id + "Error").textContent = ""; });
        formMsg($("#passwordMessage"), "", "");
        openSheet("passwordSheet");
        setTimeout(() => $("#currentPassword").focus(), 120);
    });
    on("#passwordForm", "submit", e => {
        e.preventDefault();
        const cur = $("#currentPassword").value, nw = $("#newPassword").value, cf = $("#confirmNewPassword").value;
        ["currentPassword", "newPassword", "confirmNewPassword"].forEach(id => { $("#" + id + "Error").textContent = ""; });
        let ok = true;
        if (!cur) { $("#currentPasswordError").textContent = "Enter your current password."; ok = false; }
        if (nw.length < 8) { $("#newPasswordError").textContent = "Use at least 8 characters."; ok = false; }
        if (!cf) { $("#confirmNewPasswordError").textContent = "Confirm your new password."; ok = false; }
        else if (nw !== cf) { $("#confirmNewPasswordError").textContent = "Passwords do not match."; ok = false; }
        if (!ok) { formMsg($("#passwordMessage"), "Please correct the highlighted fields.", "error"); return; }
        /* A password can only be changed safely on the server, so we do not pretend to do it here. */
        formMsg($("#passwordMessage"), "Password changes will work once the GasHub account backend is connected.", "error");
    });

    /* ---- delivery pin: the customer can move it, the address stays as it was ---- */
    function locationText() {
        const s = store.get(K.location);
        return s && isFinite(s.latitude) ? (s.label || `Pinned (${Number(s.latitude).toFixed(3)}, ${Number(s.longitude).toFixed(3)})`) : "";
    }
    function renderLocation() {
        const t = locationText();
        $("#customerLocation").textContent = t || "Select location";
        $("#locValue").textContent = t || "Not set. Tap Edit pin to drop one on the map.";
    }

    const NAIROBI = [-1.2864, 36.8172];
    let pinMap = null, pinMarker = null, pinPick = null;
    function pinSet(lat, lng, text) {
        pinPick = { latitude: lat, longitude: lng };
        $("#pinStatus").textContent = text || "Pin placed. Tap Save pin to keep it.";
        $("#pinSaveBtn").disabled = false;
    }
    function pinPut(lat, lng) {
        if (!pinMap) return;
        if (!pinMarker) {
            pinMarker = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ className: "map-pin", html: "<i></i>", iconSize: [24, 24], iconAnchor: [12, 28] }) }).addTo(pinMap);
            pinMarker.on("dragend", () => { const p = pinMarker.getLatLng(); pinSet(p.lat, p.lng, "Pin moved. Tap Save pin to keep it."); });
        } else pinMarker.setLatLng([lat, lng]);
    }
    function initPinMap() {
        if (pinMap) return true;
        if (!window.L) {
            const m = $("#pinMapMsg"); m.hidden = false;
            m.textContent = "The map could not load. Check your internet connection. You can still use your current location.";
            return false;
        }
        const s = store.get(K.location), has = s && isFinite(s.latitude);
        pinMap = L.map("pinMap", { zoomControl: true }).setView(has ? [s.latitude, s.longitude] : NAIROBI, has ? 15 : 12);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(pinMap);
        pinMap.on("click", ev => { pinPut(ev.latlng.lat, ev.latlng.lng); pinSet(ev.latlng.lat, ev.latlng.lng); });
        if (has) pinPut(s.latitude, s.longitude);
        return true;
    }
    on("#editPinBtn", "click", () => {
        pinPick = null; $("#pinSaveBtn").disabled = true;
        const t = locationText();
        $("#pinStatus").textContent = t ? `Current pin: ${t}. Tap the map to move it.` : "No pin selected.";
        openSheet("pinSheet");
        if (initPinMap()) setTimeout(() => {
            pinMap.invalidateSize();
            const s = store.get(K.location);
            if (s && isFinite(s.latitude)) { pinPut(s.latitude, s.longitude); pinMap.setView([s.latitude, s.longitude], 15); }
        }, 200);
    });
    on("#pinCurrentBtn", "click", () => {
        if (!navigator.geolocation) { $("#pinStatus").textContent = "Location is not supported on this device."; return; }
        $("#pinStatus").textContent = "Finding your location...";
        navigator.geolocation.getCurrentPosition(p => {
            const lat = p.coords.latitude, lng = p.coords.longitude;
            if (pinMap) { pinPut(lat, lng); pinMap.setView([lat, lng], 16); }
            pinSet(lat, lng, "Current location found. Tap Save pin to keep it.");
        }, err => {
            $("#pinStatus").textContent = err.code === 1 ? "Location is blocked. Allow access in your browser, or tap the map to drop a pin." : "Couldn't get your location. Tap the map to drop a pin.";
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
    });
    async function placeName(lat, lng) {
        try {
            const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
            const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=${lat}&lon=${lng}`, { signal: ctl.signal });
            clearTimeout(t);
            if (!r.ok) return null;
            const a = (await r.json()).address || {};
            return [a.neighbourhood || a.suburb || a.village || a.road, a.city || a.town || a.county].filter(Boolean).slice(0, 2).join(", ") || null;
        } catch (e) { return null; }
    }
    on("#pinSaveBtn", "click", async () => {
        if (!pinPick) return;
        const btn = $("#pinSaveBtn"); btn.disabled = true; btn.textContent = "Saving...";
        const label = await placeName(pinPick.latitude, pinPick.longitude);
        store.set(K.location, { ...pinPick, label, savedAt: new Date().toISOString() });
        btn.textContent = "Save pin"; pinPick = null;
        renderLocation(); closeSheets(); toast("Delivery pin updated");
    });

    /* ================= REWARDS ================= */
    function toggle(btn, panel) {
        const open = btn.getAttribute("aria-expanded") !== "true";
        btn.setAttribute("aria-expanded", String(open)); panel.hidden = !open;
    }
    on("#rewardsToggle", "click", () => toggle($("#rewardsToggle"), $("#rewardsPanel")));
    on("#rateToggle", "click", () => toggle($("#rateToggle"), $("#ratePanel")));

    const pick = (o, keys) => { for (const k of keys) { const v = num(o && o[k]); if (v !== null) return v; } return null; };
    /* The admin sets the rate. We accept a few shapes so the admin page can store it however it likes:
       { points: 100, ksh: 10 }  or  { ksh_per_point: 0.1 }  or  { points_per_ksh: 10 } */
    function normRate(s) {
        if (!s || typeof s !== "object") return null;
        s = s.data && typeof s.data === "object" ? s.data : s;
        let points = pick(s, ["points", "conversion_points", "points_required"]), ksh = pick(s, ["ksh", "value", "conversion_value", "amount"]);
        const perPoint = pick(s, ["ksh_per_point", "value_per_point", "point_value"]), perKsh = pick(s, ["points_per_ksh"]);
        if (perPoint !== null) { points = 1; ksh = perPoint; } else if (perKsh !== null && perKsh > 0) { points = perKsh; ksh = 1; }
        if (!points || points <= 0 || ksh === null) return null;
        return { points, ksh, min: pick(s, ["min_redeem", "minimum_points", "min_points"]), updated: s.updated_at || s.updatedAt || "" };
    }
    function readPoints(v) {
        if (typeof v === "number") return v;
        const p = pick(v, ["points", "total_points", "totalPoints", "balance", "total"]);
        return p === null ? 0 : p;
    }
    function renderPoints(pts, rate) {
        pts = Number(pts) || 0;
        $("#pointsTotal").textContent = pts.toLocaleString("en-KE");
        $("#rewardsBadge").textContent = pts.toLocaleString("en-KE") + " pts";
        $("#pointsWorth").textContent = rate ? "Worth about KSh " + (Math.floor(pts / rate.points * rate.ksh * 100) / 100).toLocaleString("en-KE", { maximumFractionDigits: 2 }) : "";
        if (rate) {
            $("#rateText").textContent = `${rate.points.toLocaleString("en-KE")} ${rate.points === 1 ? "point" : "points"} = KSh ${rate.ksh.toLocaleString("en-KE", { maximumFractionDigits: 4 })}`;
            let meta = "Set by GasHub. It can change, so check back before you redeem.";
            if (rate.min) meta += ` Minimum to redeem: ${rate.min.toLocaleString("en-KE")} points.`;
            if (rate.updated && !isNaN(new Date(rate.updated))) meta += ` Updated ${fmtDate(rate.updated)}.`;
            $("#rateMeta").textContent = meta;
        } else {
            $("#rateText").textContent = "Conversion rate not available yet";
            $("#rateMeta").textContent = "GasHub will show the rate here as soon as it is set.";
        }
    }
    async function loadRewards() {
        if (!loggedIn()) { $("#rewardsGuest").hidden = false; $("#rewardsBody").hidden = true; $("#rewardsBadge").textContent = ""; return; }
        $("#rewardsGuest").hidden = true; $("#rewardsBody").hidden = false;
        let pts = readPoints(store.get(K.points)), rate = normRate(store.get(K.rate));
        renderPoints(pts, rate);                                     /* last known values straight away */
        const r = await getJSON("/customer/rewards");
        if (r) { const p = readPoints(r); if (p || pick(r, ["points", "total_points", "totalPoints", "balance", "total"]) !== null) { pts = p; store.set(K.points, p); } }
        const s = (await getJSON("/rewards/settings")) || (await getJSON("/settings/rewards"));
        const fresh = normRate(s);
        if (fresh) { rate = fresh; store.set(K.rate, s); }
        renderPoints(pts, rate);
    }

    /* ================= EARN MORE POINTS: invite friends, share our pages, follow us ================= */
    let earn = null, earnTimer = null, clockOffset = 0;
    const SOC_MARK = { facebook: "f", instagram: "ig", tiktok: "tt", youtube: "yt", x: "X" };

    const inviteLink = () => `${location.origin}/customer-register.html?ref=${encodeURIComponent(earn.referralCode)}`;
    const inviteText = () => `Hi! I use GasHub to find gas dealers and get gas delivered. Join with my link:\n${inviteLink()}`;
    function pagesText() {
        const lines = Object.values(earn.socialLinks || {}).map(x => `${x.name}: ${x.url}`);
        return `Follow GasHub on social media:\n${lines.join("\n")}\n\nJoin GasHub with my link:\n${inviteLink()}`;
    }
    async function shareOut(text) {
        if (navigator.share) {
            try { await navigator.share({ title: "GasHub", text }); return; } catch (e) { if (e && e.name === "AbortError") return; }
        }
        await copyText(text, "Copied. Paste it in any chat.");
    }
    async function copyText(text, done) {
        try { await navigator.clipboard.writeText(text); toast(done || "Copied"); }
        catch (e) { window.prompt("Copy this:", text); }
    }

    function friendLabel(st) { return st === "claimed" ? ["claimed", "Points claimed"] : st === "ready" ? ["ready", "Ready to claim"] : st === "limit" ? ["", "Limit reached"] : ["", "Waiting for first order"]; }

    function followRow(f) {
        let btn;
        if (f.claimed) btn = '<button type="button" class="btn done" disabled>Claimed ✓</button>';
        else if (f.started) btn = `<button type="button" class="btn yellow" data-claim="${esc(f.platform)}" data-at="${esc(f.canClaimAt || "")}" data-pts="${f.points}">Claim +${f.points}</button>`;
        else btn = `<button type="button" class="btn primary" data-follow="${esc(f.platform)}">Follow</button>`;
        return `<div class="follow-row">
            <span class="soc ${esc(f.platform)}" aria-hidden="true">${esc(SOC_MARK[f.platform] || f.name[0])}</span>
            <div class="follow-text"><strong>${esc(f.name)}</strong><span>Follow us and earn ${f.points} points</span></div>${btn}</div>`;
    }

    function renderEarn() {
        const box = $("#earnBody"); if (!box || !earn) return;
        clearInterval(earnTimer);
        if (!earn.enabled) { box.innerHTML = '<div class="empty">Unavailable at the moment.</div>'; return; }
        const ref = earn.referral, hasInvite = ref.points > 0, hasSocial = Object.keys(earn.socialLinks || {}).length > 0, follow = earn.follow || [];
        const app = earn.app;
        if (!hasInvite && !follow.length && !hasSocial && !(app && app.points > 0)) { box.innerHTML = '<div class="empty">Unavailable at the moment.</div>'; return; }

        let html = "";
        if (hasInvite) {
            const rule = ref.requires === "first_order"
                ? "You earn points when a friend joins with your link and completes their first paid order."
                : "You earn points when a friend downloads GasHub and signs up with your link.";
            html += `<div class="earn-block">
                <h3>Invite friends to GasHub <span class="earn-pts">+${ref.points} pts per friend</span></h3>
                <p>${rule}${ref.maxFriends ? ` You can earn from up to ${ref.maxFriends} friends.` : ""}</p>
                <div class="code-chip"><div><small>Your invite code</small><strong>${esc(earn.referralCode)}</strong></div><button type="button" class="link-btn" id="copyCode">Copy</button></div>
                <div class="share-row">
                    <button type="button" class="btn primary" id="shareInvite">Invite</button>
                    <a class="btn wa" id="shareWa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(inviteText())}">WhatsApp</a>
                    <button type="button" class="btn outline" id="copyInvite">Copy link</button>
                </div>
                <div class="mini-stats">
                    <div><b>${ref.joined} ${ref.joined === 1 ? "friend" : "friends"} joined</b><small>${ref.claimableCount} ready to claim</small></div>
                    <button type="button" class="btn yellow" id="claimRef" ${ref.claimableCount ? "" : "disabled"}>Claim +${ref.claimablePoints}</button>
                </div>
                ${ref.friends.length ? `<div class="friend-list">${ref.friends.slice(0, 8).map(f => { const l = friendLabel(f.status); return `<div class="friend">${esc(f.name)}<span class="${l[0]}">${l[1]}</span></div>`; }).join("")}</div>` : ""}
            </div>`;
        }
        if (hasInvite && hasSocial) {
            html += `<div class="earn-block">
                <h3>Share our social pages</h3>
                <p>Send friends our accounts together with your invite link. You earn the same points once they join through it.</p>
                <button type="button" class="btn outline block" id="shareSocial">Share GasHub pages</button>
            </div>`;
        }
        if (app && app.points > 0) {
            html += `<div class="earn-block">
                <h3>Download the GasHub app <span class="earn-pts">+${app.points} pts</span></h3>
                ${app.claimed
                    ? '<p>You installed the app and your points were added. Thank you!</p><button type="button" class="btn done block" disabled>Points added ✓</button>'
                    : `<p>Install GasHub from Google Play, open it and sign in with this account. Your ${app.points} points are added automatically once the app confirms it is installed.</p>
                       <a class="btn primary block" target="_blank" rel="noopener" href="${esc(app.url)}">Get it on Google Play</a>
                       <button type="button" class="btn outline block" id="refreshApp" style="margin-top:8px">I've signed in. Check again</button>`}
            </div>`;
        }
        if (follow.length) {
            html += `<div class="earn-block"><h3>Follow GasHub</h3><p>Follow our pages, then come back and claim your points. Each page can be claimed once.</p>${follow.map(followRow).join("")}</div>`;
        }
        /* every account the admin switched on is shown here (also the ones with no points), as plain links */
        if (hasSocial) {
            html += `<div class="earn-block"><h3>Find GasHub online</h3><div class="follow-row" style="flex-wrap:wrap;gap:8px">${Object.entries(earn.socialLinks).map(([p, x]) =>
                `<a class="btn outline" target="_blank" rel="noopener" href="${esc(x.url)}">${esc(x.name)}</a>`).join("")}</div></div>`;
        }
        box.innerHTML = html;
        tickClaims(); earnTimer = setInterval(tickClaims, 1000);
    }

    /* "Claim" opens a few seconds after "Follow" (the server checks this too) */
    function tickClaims() {
        const now = Date.now() + clockOffset;
        $$("#earnBody [data-claim]").forEach(b => {
            const at = Date.parse(b.dataset.at || ""), left = isFinite(at) ? Math.ceil((at - now) / 1000) : 0;
            if (left > 0) { b.disabled = true; b.textContent = `Claim in ${left}s`; }
            else { b.disabled = false; b.textContent = `Claim +${b.dataset.pts}`; }
        });
    }

    async function loadEarn() {
        const box = $("#earnBody"); if (!box || !loggedIn()) return;
        const r = await call("/customer/earn");
        if (!r.ok) {
            const m = r.status === 503 ? "Unavailable at the moment." : r.status === 401 ? "Sign in again to see ways to earn extra points." : "We couldn't load rewards. Check your connection and try again.";
            box.innerHTML = `<div class="empty">${esc(m)}</div>`; return;
        }
        earn = r.data;
        clockOffset = Date.parse(earn.serverTime) - Date.now() || 0;
        if (isFinite(Number(earn.balance))) store.set(K.points, Number(earn.balance));
        renderEarn();
    }

    on("#earnBody", "click", async e => {
        if (!earn) return;
        const t = e.target.closest("button"); if (!t) return;
        if (t.id === "shareInvite") return shareOut(inviteText());
        if (t.id === "shareSocial") return shareOut(pagesText());
        if (t.id === "copyInvite") return copyText(inviteLink(), "Invite link copied");
        if (t.id === "copyCode") return copyText(earn.referralCode, "Code copied");
        if (t.id === "refreshApp") {
            const before = earn.app && earn.app.claimed;
            await loadEarn(); loadRewards();
            toast(earn.app && earn.app.claimed && !before ? "App points added" : "We haven't seen you sign in on the app yet.");
            return;
        }

        if (t.id === "claimRef") {
            t.disabled = true;
            const r = await call("/customer/earn/referrals/claim", { method: "POST" });
            if (r.ok) toast(r.data.message || "Points added"); else if (r.status === 401) signInAgain(); else toast((r.data && r.data.message) || "We couldn't add your points. Try again.");
            await loadEarn(); loadRewards(); return;
        }
        if (t.dataset.follow) {
            const f = earn.follow.find(x => x.platform === t.dataset.follow); if (!f) return;
            window.open(f.url, "_blank", "noopener");                       /* opened straight away so the phone does not block it */
            const r = await call(`/customer/earn/follow/${encodeURIComponent(f.platform)}/start`, { method: "POST" });
            if (r.ok) { f.started = true; f.claimed = !!r.data.claimed; f.canClaimAt = r.data.canClaimAt; clockOffset = Date.parse(r.data.serverTime) - Date.now() || clockOffset; renderEarn(); }
            else if (r.status === 401) signInAgain(); else toast((r.data && r.data.message) || "Something went wrong. Try again.");
            return;
        }
        if (t.dataset.claim) {
            const f = earn.follow.find(x => x.platform === t.dataset.claim); if (!f) return;
            t.disabled = true;
            const r = await call(`/customer/earn/follow/${encodeURIComponent(f.platform)}/claim`, { method: "POST" });
            if (r.ok) { toast(r.data.message || "Points added"); await loadEarn(); loadRewards(); }
            else if (r.status === 429) { f.canClaimAt = new Date(Date.now() + clockOffset + (r.data.retryAfter || 5) * 1000).toISOString(); toast(r.data.message || "Please wait a moment."); renderEarn(); }
            else if (r.status === 409) { await loadEarn(); toast("You already claimed this reward."); }
            else if (r.status === 401) { signInAgain(); renderEarn(); }
            else { toast((r.data && r.data.message) || "We couldn't add your points. Try again."); renderEarn(); }
        }
    });

    /* ================= FAVOURITES + FOLLOWED DEALERS ================= */
    const entryId = e => (e && typeof e === "object") ? (e.id ?? e.product_id ?? e.productId ?? e.dealer_id ?? e.dealerId ?? "") : e;
    function readSaved(keys) {
        for (const key of keys) {
            const v = store.get(key);
            if (Array.isArray(v) && v.length) return { key, list: v };
            if (v && typeof v === "object" && !Array.isArray(v)) {
                const list = Object.keys(v).filter(i => v[i]).map(i => typeof v[i] === "object" ? { id: i, ...v[i] } : i);
                if (list.length) return { key, list };
            }
        }
        return { key: keys[0], list: [] };
    }
    function removeSaved(saved, id) {
        const v = store.get(saved.key);
        if (Array.isArray(v)) store.set(saved.key, v.filter(e => String(entryId(e)) !== String(id)));
        else if (v && typeof v === "object") { delete v[id]; store.set(saved.key, v); }
    }
    const heart = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5 6.4 5c2 0 3.5 1.1 4.3 2.5h.6C12.1 6.1 13.6 5 15.6 5 19 5 20.8 8.6 21.5 11.8 19.5 16.4 12 21 12 21z"/></svg>';
    const cyl = '<svg viewBox="0 0 24 24"><rect x="6.5" y="9" width="11" height="13" rx="3.5" fill="#e03131"/><rect x="9.5" y="3.5" width="5" height="5.5" rx="1.2" fill="#3b3f52"/><rect x="8" y="13" width="8" height="3" rx="1.5" fill="#ffc20e"/></svg>';
    let FAV = { key: K.favs[0], list: [] }, FOL = { key: K.follows[0], list: [] };

    async function renderFavs() {
        FAV = readSaved(K.favs);
        const catalog = FAV.list.some(e => typeof e !== "object") ? await getList("/products", "products") : null;
        const items = FAV.list.map(e => {
            const id = entryId(e), found = catalog && catalog.find(p => String(p.id ?? p.product_id) === String(id));
            const p = Object.assign({}, found || {}, (e && typeof e === "object") ? e : {});
            const dealer = p.dealer_name || (p.dealer && typeof p.dealer === "object" ? p.dealer.name : p.dealer) || "";
            return { id, name: p.name || p.title || p.product_name || "Saved product", price: num(p.price ?? p.selling_price), img: p.image_url || p.image || p.photo_url || p.img || "", dealer };
        });
        $("#favCount").textContent = items.length;
        $("#favEmpty").hidden = items.length > 0;
        $("#favList").innerHTML = items.map(p => `
            <div class="mcard">
                <a class="mlink" href="customer-product.html?id=${encodeURIComponent(p.id)}">
                    <div class="mphoto">${p.img ? `<img src="${esc(p.img)}" alt="" loading="lazy">` : cyl}</div>
                    <div class="mbody"><h3>${esc(p.name)}</h3>${p.price !== null ? `<p>${money(p.price)}</p>` : ""}${p.dealer ? `<small>${esc(p.dealer)}</small>` : ""}</div>
                </a>
                <button type="button" class="mrm" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)} from favourites">${heart}</button>
            </div>`).join("");
    }
    on("#favList", "click", e => {
        const b = e.target.closest(".mrm"); if (!b) return;
        removeSaved(FAV, b.dataset.id); renderFavs(); toast("Removed from favourites");
    });

    async function renderFollows() {
        FOL = readSaved(K.follows);
        const catalog = FOL.list.some(e => typeof e !== "object") ? await getList("/dealers", "dealers") : null;
        const items = FOL.list.map(e => {
            const id = entryId(e), found = catalog && catalog.find(d => String(d.id ?? d.dealer_id) === String(id));
            const d = Object.assign({}, found || {}, (e && typeof e === "object") ? e : {});
            const name = d.name || d.business_name || d.dealer_name || "Dealer";
            return { id, name, place: d.address || d.city || (typeof d.location === "string" ? d.location : "") || "Kenya", logo: d.logo || d.logo_url || "" };
        });
        $("#followCount").textContent = items.length;
        $("#followEmpty").hidden = items.length > 0;
        $("#followList").innerHTML = items.map(d => `
            <div class="drow">
                <a class="dlink" href="customer-dealer.html?id=${encodeURIComponent(d.id)}">
                    <div class="dlogo">${d.logo ? `<img src="${esc(d.logo)}" alt="">` : esc(initials(d.name))}</div>
                    <div class="dtext"><strong>${esc(d.name)}</strong><span>${esc(d.place)}</span></div>
                </a>
                <button type="button" class="unfollow" data-id="${esc(d.id)}" aria-label="Unfollow ${esc(d.name)}">Unfollow</button>
            </div>`).join("");
    }
    on("#followList", "click", e => {
        const b = e.target.closest(".unfollow"); if (!b) return;
        removeSaved(FOL, b.dataset.id); renderFollows(); toast("Unfollowed");
    });

    /* ================= SETTINGS: THEME + NOTIFICATIONS ================= */
    const T = window.GasHubTheme || { get: () => "system", set() { }, isDark: () => false };
    function renderTheme() {
        const cur = T.get();
        $$("#themeSeg button").forEach(b => { const a = b.dataset.themePick === cur; b.classList.toggle("active", a); b.setAttribute("aria-pressed", String(a)); });
        $("#themeHint").textContent = cur === "system"
            ? `Auto (matches your phone): ${T.isDark() ? "dark" : "light"} now`
            : cur === "dark" ? "Dark theme is on" : "Light theme is on";
    }
    /* the theme choices stay hidden until the "Change theme" button is tapped */
    on("#themeToggle", "click", () => {
        const btn = $("#themeToggle"), panel = $("#themePanel");
        const open = panel.hidden;               /* hidden now -> about to open */
        panel.hidden = !open;
        btn.setAttribute("aria-expanded", String(open));
        btn.textContent = open ? "Close" : "Change theme";
    });
    on("#themeSeg", "click", e => {
        const b = e.target.closest("button[data-theme-pick]"); if (!b) return;
        T.set(b.dataset.themePick); renderTheme();
    });
    if (window.matchMedia) {
        const mq = matchMedia("(prefers-color-scheme: dark)");
        if (mq.addEventListener) mq.addEventListener("change", renderTheme);
    }

    on("#privacyBtn", "click", () => openSheet("privacySheet"));

    /* ================= CONTACT (numbers come from the admin page) ================= */
    const dial = n => String(n).replace(/[^\d+]/g, "");
    function intl(n) {
        let d = String(n).replace(/\D/g, "");
        if (d.startsWith("0")) d = "254" + d.slice(1); else if (d.length === 9) d = "254" + d;
        return d;
    }
    function renderContact(c) {
        const phone = c && (c.phone || c.call || c.phoneNumber), wa = c && (c.whatsapp || c.whatsappNumber), hours = c && (c.hours || c.workingHours);
        const body = $("#contactBody");
        if (!phone && !wa) { body.innerHTML = '<div class="empty">Contact details will appear here once GasHub adds them.</div>'; return; }
        const callIco = '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>';
        const waIco = '<svg viewBox="0 0 24 24"><path d="M3 21l1.6-4.8A8.5 8.5 0 1 1 8 19.4L3 21z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-2-1-.8.7a3.6 3.6 0 0 1-1.8-1.8l.7-.8-1-2L9 9.5z"/></svg>';
        body.innerHTML = `<div class="contact-btns">
                ${phone ? `<a class="btn primary" href="tel:${esc(dial(phone))}">${callIco}Call us</a>` : "<span></span>"}
                ${wa ? `<a class="btn wa" href="https://wa.me/${esc(intl(wa))}" target="_blank" rel="noopener">${waIco}WhatsApp</a>` : "<span></span>"}
            </div>
            <p class="contact-meta">${phone ? "Call: " + esc(phone) : ""}${phone && wa ? " · " : ""}${wa ? "WhatsApp: " + esc(wa) : ""}${hours ? "<br>" + esc(hours) : ""}</p>`;
    }
    async function loadContact() {
        renderContact(store.get(K.contact));                         /* last known numbers straight away */
        const r = await getJSON("/settings/contact");
        if (r && typeof r === "object") {
            const n = { phone: r.phone || r.call || r.phone_number || "", whatsapp: r.whatsapp || r.whatsapp_number || "", hours: r.hours || r.working_hours || "" };
            if (n.phone || n.whatsapp) { store.set(K.contact, n); renderContact(n); }
        }
    }

    /* ================= LOG OUT ================= */
    on("#logoutButton", "click", () => {
        if (window.gasHubAskLogout) { window.gasHubAskLogout(); return; }    /* the nice dialog; it signs out when confirmed */
        if (!confirm("Log out of GasHub?")) return;
        [K.session, K.logged, "token", "authToken", "customerToken"].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
        ["customer", "user", "customerData", "currentUser"].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
        if (window.gasHubLogout) window.gasHubLogout(); else location.href = "customer-login.html?logged_out=1";
    });

    /* ================= DELETE ACCOUNT =================
       The button unlocks 7 days after the account was created. After asking (and typing DELETE),
       the account is fully deleted 7 days later. The server enforces both waits. */
    const DELETE_AFTER_DAYS = 7, DELETE_WAIT_DAYS = 7, DAY_MS = 86400000;
    let serverEligibleAt = null, delTimer = null;
    const delReq = () => { const r = store.get(K.del); return r && r.deleteAt ? r : null; };
    function eligibleAtMs() {
        if (serverEligibleAt) return serverEligibleAt;
        const d = info().since ? new Date(info().since).getTime() : NaN;
        return isFinite(d) ? d + DELETE_AFTER_DAYS * DAY_MS : null;       /* unknown date: the server decides */
    }
    function renderDeletion() {
        const r = delReq(), box = $("#deleteNotice"), btn = $("#deleteBtn"), note = $("#deleteLockNote");
        if (!loggedIn()) { box.hidden = true; note.hidden = true; return; }
        if (r) {
            const left = Math.max(0, Math.ceil((r.deleteAt - Date.now()) / DAY_MS));
            $("#deleteNoticeText").textContent = `Your account will be fully deleted on ${fmtDate(r.deleteAt)} (${left} ${left === 1 ? "day" : "days"} left). Tap Keep my account to cancel.`;
            box.hidden = false; note.hidden = true; btn.disabled = true; btn.textContent = "Deletion scheduled"; return;
        }
        box.hidden = true; btn.textContent = "Delete my account";
        const el = eligibleAtMs();
        if (el && Date.now() < el) {
            /* live countdown; the button stays inactive until it reaches zero */
            const ms = el - Date.now(), d = Math.floor(ms / DAY_MS), h = Math.floor(ms % DAY_MS / 3600000), m = Math.floor(ms % 3600000 / 60000), sec = Math.floor(ms % 60000 / 1000);
            const pad = n => String(n).padStart(2, "0");
            note.textContent = `Available in ${d}d ${pad(h)}h ${pad(m)}m ${pad(sec)}s`;
            note.hidden = false; btn.disabled = true;
            clearTimeout(delTimer); delTimer = setTimeout(renderDeletion, 1000);
        } else { clearTimeout(delTimer); note.hidden = true; btn.disabled = false; }
    }
    function wipeLocalData() {
        const keys = [...K.customer, K.session, K.logged, K.orders, K.last, K.photo, K.points, ...K.favs, ...K.follows, K.notify, K.del, K.location,
            "gasHubViews", "gasHubPurchases", "gasHubRef", "token", "authToken", "customerToken"];
        keys.forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
    }
    /* the 7 days after asking are over: ask the server to finish the deletion. Returns true when this page is leaving. */
    async function finalizeDeletion() {
        const r = await call("/customer/account", { method: "DELETE" });
        if (r.ok || r.status === 401) {                                    /* 401: the nightly job already removed the account */
            wipeLocalData();
            if (window.gasHubLogout) window.gasHubLogout(); else location.href = "customer-login.html";
            return true;
        }
        if (r.data && r.data.scheduledFor) store.set(K.del, { requestedAt: Date.now(), deleteAt: Date.parse(r.data.scheduledFor) });
        return false;
    }
    function updateDeleteGo() { $("#deleteGo").disabled = !($("#deleteConfirm").value === "DELETE" && $("#deleteAck").checked); }
    on("#deleteBtn", "click", () => {
        $("#deleteConfirm").value = ""; $("#deleteAck").checked = false; updateDeleteGo();
        openSheet("deleteSheet");
    });
    on("#deleteConfirm", "input", updateDeleteGo);
    on("#deleteAck", "change", updateDeleteGo);
    on("#deleteGo", "click", async () => {
        if ($("#deleteConfirm").value !== "DELETE" || !$("#deleteAck").checked) return;
        const go = $("#deleteGo"); go.disabled = true; go.textContent = "Please wait...";
        const r = await call("/customer/account/delete-request", { method: "POST" });
        go.textContent = "Delete my account"; updateDeleteGo();
        if (r.ok && r.data.deletion) {
            const d = r.data.deletion;
            store.set(K.del, { requestedAt: Date.parse(d.requestedAt) || Date.now(), deleteAt: Date.parse(d.scheduledFor) || (Date.now() + DELETE_WAIT_DAYS * DAY_MS) });
            closeSheets(); renderDeletion();
            toast(`Your account will be deleted in ${DELETE_WAIT_DAYS} days`);
            return;
        }
        if (r.status === 403 && r.data.eligibleAt) { serverEligibleAt = Date.parse(r.data.eligibleAt); closeSheets(); renderDeletion(); toast(r.data.message || "You can't delete your account yet."); return; }
        if (r.status === 401) { closeSheets(); signInAgain(); return; }
        toast(r.network ? "We can't reach GasHub right now. Try again in a moment." : ((r.data && r.data.message) || "We couldn't schedule the deletion. Try again."));
    });
    on("#cancelDeleteBtn", "click", async () => {
        const r = await call("/customer/account/delete-cancel", { method: "POST" });
        if (r.ok) { localStorage.removeItem(K.del); renderDeletion(); toast("Good news, your account is staying"); }
        else if (r.status === 401) signInAgain();
        else toast(r.network ? "We can't reach GasHub right now. Try again in a moment." : "We couldn't cancel the deletion. Try again.");
    });

    /* ---- sync with the account on the server (member-since date, deletion state) ---- */
    async function syncAccount() {
        if (!loggedIn()) return;
        const r = await call("/customer/account");
        if (!r.ok) return;
        if (r.data.customer) { applyCustomer(r.data.customer); renderHero(); renderSummary(); }
        const d = r.data.deletion;
        if (d) {
            serverEligibleAt = d.eligibleAt ? Date.parse(d.eligibleAt) : null;
            if (d.scheduledFor) store.set(K.del, { requestedAt: Date.parse(d.requestedAt) || Date.now(), deleteAt: Date.parse(d.scheduledFor) });
            else localStorage.removeItem(K.del);
        }
        renderDeletion();
    }

    document.addEventListener("keydown", e => { if (e.key === "Escape") { closeMenu(); closeSheets(); } });

    /* ================= START ================= */
    function startPage() {
        safe(renderHero);
        safe(renderStats);
        safe(renderSummary);
        safe(renderLocation);
        safe(renderTheme);
        safe(renderDeletion);
        safe(loadRewards);
        safe(loadEarn);
        safe(renderFavs);
        safe(renderFollows);
        safe(loadContact);
        safe(syncAccount);
    }
    const r0 = delReq();
    if (r0 && loggedIn() && Date.now() >= r0.deleteAt) {
        finalizeDeletion().then(left => { if (!left) startPage(); });      /* the 7 days are over */
    } else {
        startPage();
    }
})();