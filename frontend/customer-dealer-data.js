/* GasHub shared dealers helper (used by customer-home.html and customer-dealer.html).
   Add it BEFORE the page script:  <script src="customer-dealer-data.js"></script>

   - GasHubDealers.load()          dealers loaded from /api/dealers
   - GasHubDealers.nearby(list,n)  followed dealers first, then the closest ones
   - Location comes from the pin the customer saved on the home page (localStorage "gasHubLocation")
   - Verified (blue badge) shows ONLY when the admin marked the dealer verified
     and the verification has not expired (same rule as the admin pages)

 */
(function () {
    "use strict";
    if (window.GasHubDealers) return;

    var API = "/api";
    var LOC_KEY = "gasHubLocation", FOLLOW_KEY = "gasHubFollowing";

    function read(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
    function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function token() { return localStorage.getItem("token") || localStorage.getItem("customerToken") || localStorage.getItem("authToken"); }

    /* ---------- normalize (works with live API data) ---------- */
    function num(v) { return (v === null || v === undefined || v === "" || isNaN(Number(v))) ? null : Number(v); }
    function str(v, d) { return (v === null || v === undefined) ? (d || "") : (String(v).trim() || d || ""); }

    /* Same rule as the admin pages: verified only while the seal has not expired. */
    function isVerified(d) {
        if (d.verification_active != null) return d.verification_active === true || String(d.verification_active).toLowerCase() === "true";
        var v = d.verified != null ? d.verified : d.is_verified != null ? d.is_verified : d.isVerified != null ? d.isVerified : d.admin_verified;
        if (typeof v === "string") v = ["1", "true", "yes", "verified", "approved"].indexOf(v.toLowerCase()) > -1;
        if (v != null) {
            if (!v) return false;
            if (d.verification_expires_at !== undefined) {
                var exp = d.verification_expires_at ? new Date(d.verification_expires_at) : null;
                return !!exp && !isNaN(exp.getTime()) && exp > new Date();
            }
            return true;
        }
        var s = String(d.verification_status || "").toLowerCase();
        return s === "verified" || s === "approved";
    }
    /* Same wording as Admin > Dealers: location, town, county (falls back to the address). */
    function placeOf(d) {
        var parts = [d.location, d.town, d.county].map(function (x) { return str(x); }).filter(Boolean);
        var seen = {}, uniq = parts.filter(function (x) { var k = x.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; });
        return uniq.join(", ") || str(d.address || d.city || d.area);
    }
    function countyOf(d) {
        var own = str(d.county).toLowerCase().replace(/[^a-z]/g, "").replace(/county$/, "");
        if (own) return ["nairobi", "kiambu", "machakos", "kajiado", "muranga"].indexOf(own) > -1 ? own : "other";
        var t = (str(d.county) + " " + str(d.location || d.address || d.city)).toLowerCase();
        if (/nairobi|westlands|kasarani|roysambu|karen|langata|embakasi/.test(t)) return "nairobi";
        if (/kiambu|thika|ruiru|juja|limuru|kikuyu/.test(t)) return "kiambu";
        if (/machakos|athi|mlolongo|syokimau|kangundo/.test(t)) return "machakos";
        if (/kajiado|rongai|ngong|kitengela|kiserian|ongata/.test(t)) return "kajiado";
        if (/murang/.test(t)) return "muranga";
        return "other";
    }
    function hourText(h) { var x = Number(h); var s = x >= 12 ? "PM" : "AM"; var y = x % 12 || 12; return y + ":00 " + s; }
    /* ---------- working hours (set by the dealer, times are Kenya time) ----------
       working_hours = { open24, openTime:"HH:MM", closeTime:"HH:MM", days:[0..6] } (0 = Sunday)
       open24 = always open. Otherwise open only on the chosen days between the two times. */
    var DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    function mins(t) { var p = String(t).split(":"); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }
    function kenyaNow() {
        try {
            var parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Nairobi", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
            var pick = function (t) { var f = parts.filter(function (p) { return p.type === t; })[0]; return f ? f.value : "0"; };
            var h = parseInt(pick("hour"), 10); if (h === 24) h = 0;
            return { day: DAY_SHORT.indexOf(pick("weekday")), minutes: h * 60 + parseInt(pick("minute"), 10) };
        } catch (e) {
            var n = new Date(); return { day: n.getDay(), minutes: n.getHours() * 60 + n.getMinutes() };
        }
    }
    function parseHours(w) {
        if (typeof w === "string") { try { w = JSON.parse(w); } catch (e) { w = null; } }
        return (w && typeof w === "object") ? w : null;
    }
    /* true / false from the dealer's working hours, or null when the dealer never set any */
    function openFromHours(w) {
        w = parseHours(w);
        if (!w) return null;
        if (w.open24 === true || String(w.open24).toLowerCase() === "true") return true;
        var days = Array.isArray(w.days) ? w.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
        if (!days.length || !w.openTime || !w.closeTime) return false;
        var now = kenyaNow(), open = mins(w.openTime), close = mins(w.closeTime);
        var works = function (x) { return days.indexOf(x) > -1; };
        if (open === close) return works(now.day);
        if (open < close) return works(now.day) && now.minutes >= open && now.minutes < close;
        return (works(now.day) && now.minutes >= open) || (works((now.day + 6) % 7) && now.minutes < close);
    }
    function clock12(t) { var m = mins(t), h = Math.floor(m / 60), mm = m % 60; return (h % 12 || 12) + ":" + (mm < 10 ? "0" : "") + mm + " " + (h >= 12 ? "PM" : "AM"); }
    function hoursLabel(d) {
        var w = parseHours(d.working_hours);
        if (w) {
            if (w.open24 === true || String(w.open24).toLowerCase() === "true") return "Open 24 hours";
            if (w.openTime && w.closeTime) return clock12(w.openTime) + " – " + clock12(w.closeTime);
        }
        return str(d.hours_text, "") || "";
    }
    function normalize(d, i) {
        var openH = num(d.open_hour), closeH = num(d.close_hour), open;
        var byHours = openFromHours(d.working_hours);
        var flag = d.open != null ? d.open : d.is_open_now != null ? d.is_open_now : d.is_open != null ? d.is_open : d.isOpen != null ? d.isOpen : d.availability;
        if (byHours !== null) open = byHours;   /* the dealer's own working hours always win */
        else if (flag != null) open = (flag === true || flag === 1 || String(flag).toLowerCase() === "true" || String(flag).toLowerCase() === "open");
        else if (openH != null && closeH != null) { var h = new Date().getHours(); open = h >= openH && h < closeH; }
        else open = true;
        var cnt = num(d.review_count != null ? d.review_count : d.reviews_count);
        var revs = Array.isArray(d.reviews) ? d.reviews : (Array.isArray(d.reviewsList) ? d.reviewsList : []);
        var services = Array.isArray(d.services) ? d.services : (typeof d.services === "string" ? d.services.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : []);
        return {
            id: str(d.id != null ? d.id : d.dealer_id, "dealer-" + (i + 1)),
            name: str(d.name || d.business_name || d.dealer_name, "Dealer"),
            location: placeOf(d) || "Kenya",
            countyName: str(d.county),
            county: countyOf(d),
            lat: num(d.latitude != null ? d.latitude : d.lat), lng: num(d.longitude != null ? d.longitude : d.lng),
            km: num(d.distance_km != null ? d.distance_km : d.distance),
            rating: (function () { var r = num(d.rating != null ? d.rating : d.average_rating); return (r && r > 0) ? r : null; })(),
            reviews: cnt != null ? cnt : revs.length,
            orders: num(d.orders != null ? d.orders : (d.total_orders != null ? d.total_orders : d.orders_count)) || 0,
            followers: num(d.followers != null ? d.followers : (d.followers_count != null ? d.followers_count : d.follower_count)) || 0,
            following: d.following == null ? null : !!d.following,   /* from the server when the customer is signed in */
            verified: isVerified(d),
            verificationExpiresAt: d.verification_expires_at || null,
            code: str(d.dealer_code || d.code),
            /* re-checked every time it is read, so a dealer flips between Open and Closed as the clock moves */
            get open() { var live = openFromHours(this.workingHours); return live === null ? open : live; },
            workingHours: parseHours(d.working_hours),
            always: (function () { var w = parseHours(d.working_hours); return !!w && (w.open24 === true || String(w.open24).toLowerCase() === "true"); })(),
            hours: hoursLabel(d) || ((openH != null && closeH != null) ? hourText(openH) + " – " + hourText(closeH) : str(d.hours || d.opening_hours, "Not listed")),
            logo: str(d.logo || d.logo_url),
            about: str(d.about || d.description, "This dealer has not added a description yet."),
            services: services,
            products: Array.isArray(d.products) ? d.products : null,
            reviewsList: revs,
            source: "api"
        };
    }

    var known = {};   /* dealers loaded this visit, so follow counts can be updated in place */

    async function load() {
        try {
            var t = token();
            var r = await fetch(API + "/dealers", { headers: Object.assign({ Accept: "application/json" }, t ? { Authorization: "Bearer " + t } : {}) });
            if (!r.ok) throw new Error("Unable to load dealers (" + r.status + ")");
            var d = await r.json();
            var list = Array.isArray(d) ? d : d.dealers || d.data || [];
            var out = list.map(function (x, i) { return normalize(x, i); });
            out.forEach(function (o) { known[o.id] = o; });
            /* Follows made before followers were saved on the server only exist in this browser.
               Send them once so admins and dealers see them too (only when the customer is signed in). */
            var local = followingSet();
            out.forEach(function (o) {
                if (o.following === false && local.has(String(o.id))) {
                    o.following = true; o.followers += 1;
                    var t2 = token();
                    fetch(API + "/dealers/" + encodeURIComponent(o.id) + "/follow", { method: "POST", headers: t2 ? { Authorization: "Bearer " + t2 } : {} })
                        .then(function (r) { return r.json().catch(function () { return {}; }); })
                        .then(function (j) { if (j && typeof j.follower_count === "number") o.followers = j.follower_count; })
                        .catch(function () { });
                }
            });
            return out;
        } catch (e) {
            console.error("GasHub dealer API unavailable:", e);
            return [];
        }
    }

    /* ---------- location (set on the home page) ---------- */
    function getLocation() {
        var s = read(LOC_KEY, null);
        return (s && s.latitude != null && s.longitude != null) ? s : null;
    }
    function locationLabel() {
        var s = getLocation();
        if (!s) return "";
        return s.label || ("Pinned (" + Number(s.latitude).toFixed(3) + ", " + Number(s.longitude).toFixed(3) + ")");
    }
    function distanceKm(d) {
        var loc = getLocation();
        if (loc && d.lat != null && d.lng != null) {
            var R = 6371, r = function (x) { return x * Math.PI / 180; };
            var dLat = r(d.lat - loc.latitude), dLng = r(d.lng - loc.longitude);
            var a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(r(loc.latitude)) * Math.cos(r(d.lat)) * Math.pow(Math.sin(dLng / 2), 2);
            return 2 * R * Math.asin(Math.sqrt(a));
        }
        return d.km;
    }
    function fmtKm(km) { return Math.max(0.1, km).toFixed(1) + " km"; }
    function etaMin(km) { return Math.max(5, Math.round(km * 3 + 2)); }
    function fmtEta(m) { return m >= 60 ? Math.floor(m / 60) + " hr" + (m % 60 ? " " + (m % 60) + " min" : "") : m + " min"; }
    function fmtCount(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".0", "") + "k" : String(n); }
    function initials(name) { return String(name).split(" ").map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase(); }

    /* ---------- following ---------- */
    function followingSet() { return new Set(read(FOLLOW_KEY, []).map(String)); }
    function isFollowing(id) {
        var k = known[String(id)];
        if (k && k.following !== null) return k.following;
        return followingSet().has(String(id));
    }
    function toggleFollow(id) {
        var s = followingSet(), key = String(id), nowOn = !isFollowing(key), k = known[key];
        nowOn ? s.add(key) : s.delete(key);
        write(FOLLOW_KEY, Array.from(s));
        if (k && k.following !== null) { k.following = nowOn; k.followers = Math.max(0, k.followers + (nowOn ? 1 : -1)); }
        try {
            var t = token();
            fetch(API + "/dealers/" + encodeURIComponent(key) + "/follow", { method: nowOn ? "POST" : "DELETE", headers: t ? { Authorization: "Bearer " + t } : {} })
                .then(function (r) { return r.json().catch(function () { return {}; }); })
                .then(function (j) { if (k && j && typeof j.follower_count === "number") k.followers = j.follower_count; })
                .catch(function () { });
        } catch (e) { }
        return nowOn;
    }
    /* The count comes from the server (same number admin and the dealer see). */
    function followerCount(d) { return d.following !== null && d.following !== undefined ? d.followers : d.followers + (isFollowing(d.id) ? 1 : 0); }

    /* the dealers to feature: ones the customer follows first, then the closest. Always at most n. */
    function nearby(list, n) {
        var f = followingSet();
        var scored = list.map(function (d) { return { d: d, km: distanceKm(d), f: f.has(d.id) }; });
        scored.sort(function (a, b) {
            if (a.f !== b.f) return a.f ? -1 : 1;
            if ((a.km === null) !== (b.km === null)) return a.km === null ? 1 : -1;
            if (a.km !== null && b.km !== null && a.km !== b.km) return a.km - b.km;
            return (b.d.rating || 0) - (a.d.rating || 0) || b.d.followers - a.d.followers;
        });
        return scored.slice(0, n).map(function (s) { return s.d; });
    }

    /* ---------- blue verified badge (only for admin-verified dealers) ---------- */
    function badge(d) {
        if (!d.verified) return "";
        return '<span class="vbadge" title="Verified by GasHub" role="img" aria-label="Verified by GasHub"><svg viewBox="0 0 24 24" aria-hidden="true">' +
            '<path fill="#1d7af3" d="M12 1.8l2.6 1.9 3.2-.2 1.1 3 2.7 1.8-1 3.1 1 3.1-2.7 1.8-1.1 3-3.2-.2-2.6 1.9-2.6-1.9-3.2.2-1.1-3-2.7-1.8 1-3.1-1-3.1 2.7-1.8 1.1-3 3.2.2z"/>' +
            '<path fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M7.8 12.2l3 3 5.6-6"/></svg></span>';
    }

    /* ---------- THE dealer card (Find a Dealer design) - used by the home page AND the dealers page ---------- */
    var I_PIN = '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';
    var I_CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
    var I_USERS = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/></svg>';
    var I_BAG = '<svg viewBox="0 0 24 24"><path d="M6 2l-2 4v14h16V6l-2-4H6zM4 6h16M9 10a3 3 0 0 0 6 0"/></svg>';
    function ratingHTML(d) {
        return d.rating == null
            ? '<span class="rt"><small>New</small></span>'
            : '<span class="rt"><b aria-hidden="true">★</b>' + Number(d.rating).toFixed(1) + (d.reviews ? ' <small>(' + fmtCount(d.reviews) + ')</small>' : '') + '</span>';
    }
    /* km: distance in km, or null/undefined to work it out from the pinned location */
    function cardHTML(d, km) {
        if (km === undefined) km = distanceKm(d);
        var fol = isFollowing(d.id), meta = '';
        if (km != null) meta += '<span class="mi dist">' + I_PIN + fmtKm(km) + '</span><span class="mi">' + I_CLOCK + fmtEta(etaMin(km)) + ' away</span>';
        meta += '<span class="mi">' + I_USERS + fmtCount(followerCount(d)) + ' followers</span>';
        if (d.orders) meta += '<span class="mi">' + I_BAG + fmtCount(d.orders) + '+ orders</span>';
        return '<article class="dcard" data-id="' + esc(d.id) + '" tabindex="0" role="button" aria-label="View ' + esc(d.name) + '">' +
            '<div class="dtop"><div class="dlogo">' + (d.logo ? '<img src="' + esc(d.logo) + '" alt="" loading="lazy">' : esc(initials(d.name))) + '</div>' +
            '<div class="dinfo"><div class="dname"><span>' + esc(d.name) + '</span>' + badge(d) + '</div>' +
            '<div class="dloc">' + esc(d.location) + '</div>' +
            '<div class="drow">' + ratingHTML(d) +
            '<span class="pill ' + (d.open ? 'ok' : 'bad') + '"><i></i>' + (d.open ? 'Open now' : 'Closed') + '</span>' +
            (fol ? '<span class="ftag">Following</span>' : '') + '</div></div>' +
            '<button type="button" class="dview" tabindex="-1">View</button></div>' +
            '<div class="dmeta">' + meta + '</div></article>';
    }

    window.GasHubDealers = {
        API: API, load: load, nearby: nearby, normalize: normalize,
        getLocation: getLocation, locationLabel: locationLabel, distanceKm: distanceKm,
        fmtKm: fmtKm, etaMin: etaMin, fmtEta: fmtEta, fmtCount: fmtCount, initials: initials, esc: esc,
        isFollowing: isFollowing, toggleFollow: toggleFollow, followerCount: followerCount,
        badge: badge, cardHTML: cardHTML, ratingHTML: ratingHTML, read: read, write: write, token: token, openFromHours: openFromHours
    };
})();