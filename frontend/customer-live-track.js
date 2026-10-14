/* GasHub live order tracking for the customer's order page (customer-orders.html).

   DELIVERY orders  - inside the "Your messenger" card: a live map with the messenger's real GPS position,
                      the delivery pin, distance and an estimated arrival time. It only exists while the order is open:
                      once the order is delivered, completed or cancelled the map is removed and the server stops
                      sending coordinates (GET /api/my/orders/:id/tracking).
   PICKUP orders    - a "Pick up your order" card with the dealer's shop location (where the product was listed),
                      its address and a Get directions button. Hidden once the order is finished.

   Maps use Leaflet + OpenStreetMap, like the rest of GasHub, so there is no map billing.
   The ETA is an estimate from the straight-line distance (no routing service is called). */
(function () {
    "use strict";

    var R = window.GasHubRewards;
    var $ = function (id) { return document.getElementById(id); };
    var esc = function (s) { return R && R.esc ? R.esc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

    var FAST = 5000, SLOW = 15000;       /* poll every 5 s while live, every 15 s while waiting */
    var ROAD_FACTOR = 1.3, DEFAULT_KMH = 25;

    var cur = null;                      /* { id, pickup } */
    var timer = null, polling = false, stopped = false;
    var map = null, riderMarker = null, destMarker = null, line = null, follow = true, anim = null, lastRider = null, shopMap = null, shopFor = null;

    /* ---------- tiny helpers ---------- */
    function km(aLat, aLng, bLat, bLng) {
        var r = 6371, d = Math.PI / 180, dLat = (bLat - aLat) * d, dLng = (bLng - aLng) * d;
        var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(aLat * d) * Math.cos(bLat * d) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * r * Math.asin(Math.sqrt(h));
    }
    function ago(iso) {
        var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (s < 60) return "less than a minute ago";
        var m = Math.round(s / 60);
        return m + (m === 1 ? " minute ago" : " minutes ago");
    }
    function eta(distKm, speedMs) {
        var kmh = speedMs != null && speedMs * 3.6 > 5 ? Math.min(50, Math.max(12, speedMs * 3.6)) : DEFAULT_KMH;
        return Math.max(1, Math.round((distKm * ROAD_FACTOR / kmh) * 60));
    }
    function fmtDist(k) { return k < 1 ? Math.round(k * 1000 / 10) * 10 + " m" : (k < 10 ? k.toFixed(1) : Math.round(k)) + " km"; }

    var BIKE = '<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#1f4fd8" stroke="#fff" stroke-width="3"/>' +
        '<g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="15" cy="30" r="4"/><circle cx="33" cy="30" r="4"/>' +
        '<path d="M15 30l5-9h6l3 9M26 21l-2-4h-4M29 21h4"/></g><rect x="19" y="12" width="10" height="5" rx="1.5" fill="#ffc20e"/></svg>';
    var PIN = '<svg viewBox="0 0 32 42" width="30" height="40" aria-hidden="true"><path d="M16 1C8 1 2 7 2 15c0 10 14 26 14 26s14-16 14-26C30 7 24 1 16 1z" fill="#e03131" stroke="#fff" stroke-width="2"/><circle cx="16" cy="15" r="5.5" fill="#fff"/></svg>';
    var SHOP = '<svg viewBox="0 0 32 42" width="30" height="40" aria-hidden="true"><path d="M16 1C8 1 2 7 2 15c0 10 14 26 14 26s14-16 14-26C30 7 24 1 16 1z" fill="#1f4fd8" stroke="#fff" stroke-width="2"/><path d="M9 13l1.5-4h11L23 13v2H9zM10 16h12v7H10z" fill="#fff"/></svg>';
    function icon(svg, w, h, ax, ay) { return L.divIcon({ className: "lt-icon", html: svg, iconSize: [w, h], iconAnchor: [ax, ay] }); }

    /* ---------- fetching ---------- */
    async function fetchTracking(id) {
        var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 6000);
        try {
            var r = await fetch("/api/my/orders/" + encodeURIComponent(id) + "/tracking", {
                headers: R && R.authHeaders ? R.authHeaders(false) : {}, credentials: "same-origin", cache: "no-store", signal: ctl.signal
            });
            clearTimeout(t);
            if (r.status === 401 || r.status === 403 || r.status === 404) return { gone: true };
            if (!r.ok) return { error: true };
            return await r.json();
        } catch (e) { clearTimeout(t); return { error: true }; }
    }

    /* ---------- delivery box ---------- */
    function box() { return $("trackBox"); }

    function ensureShell() {
        var b = box();
        if (!b || b.getAttribute("data-ready")) return;
        b.setAttribute("data-ready", "1");
        b.innerHTML =
            '<div class="lt-msg" id="ltMsg" hidden></div>' +
            '<div class="lt-mapwrap" id="ltWrap" hidden>' +
                '<div class="lt-map" id="ltMap"></div>' +
                '<button type="button" class="lt-recenter" id="ltRecenter" aria-label="Centre the map on the messenger" title="Centre on messenger">' +
                    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg></button>' +
                '<div class="lt-panel" id="ltPanel"></div>' +
            '</div>';
        $("ltRecenter").addEventListener("click", function () { follow = true; recenter(true); });
    }

    function message(text, kind) {
        var m = $("ltMsg");
        if (!m) return;
        m.hidden = !text; m.textContent = text || ""; m.className = "lt-msg" + (kind ? " " + kind : "");
    }
    function showMap(on) { var w = $("ltWrap"); if (w) w.hidden = !on; if (on && map) setTimeout(function () { map.invalidateSize(); }, 50); }

    function destroyMap() {
        if (anim) { cancelAnimationFrame(anim); anim = null; }
        if (map) { map.remove(); map = null; }
        riderMarker = destMarker = line = lastRider = null; follow = true;
        var w = $("ltWrap"); if (w) w.hidden = true;
    }

    function buildMap(d) {
        if (map || typeof L === "undefined") return;
        map = L.map("ltMap", { zoomControl: false, attributionControl: true }).setView([d.rider.lat, d.rider.lng], 15);
        L.control.zoom({ position: "topleft" }).addTo(map);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
        map.on("dragstart", function () { follow = false; });
        if (d.destination) destMarker = L.marker([d.destination.lat, d.destination.lng], { icon: icon(PIN, 30, 40, 15, 40), title: "Your delivery location" }).addTo(map);
    }

    /* the messenger's marker glides to each new position instead of jumping */
    function moveRider(lat, lng) {
        if (!riderMarker) {
            riderMarker = L.marker([lat, lng], { icon: icon(BIKE, 40, 40, 20, 20), title: "Your messenger", zIndexOffset: 500 }).addTo(map);
            lastRider = { lat: lat, lng: lng };
            return;
        }
        var from = riderMarker.getLatLng(), to = { lat: lat, lng: lng }, t0 = performance.now(), dur = FAST - 600;
        if (anim) cancelAnimationFrame(anim);
        (function step(now) {
            var k = Math.min(1, (now - t0) / dur);
            riderMarker.setLatLng([from.lat + (to.lat - from.lat) * k, from.lng + (to.lng - from.lng) * k]);
            if (follow && map) map.panTo(riderMarker.getLatLng(), { animate: false });
            if (k < 1) anim = requestAnimationFrame(step); else anim = null;
        })(t0);
        lastRider = to;
    }

    function recenter(fit) {
        if (!map || !lastRider) return;
        if (fit && destMarker) map.fitBounds(L.latLngBounds([[lastRider.lat, lastRider.lng], destMarker.getLatLng()]), { padding: [50, 50], maxZoom: 17, animate: true });
        else map.setView([lastRider.lat, lastRider.lng], Math.max(map.getZoom(), 15), { animate: true });
    }

    function renderLive(d) {
        var stale = d.state === "waiting_gps" && d.rider;
        if (typeof L === "undefined") {               /* Leaflet did not load: still tell the customer where things stand */
            message("Your messenger is on the way. The live map could not load; check your connection and refresh.", "warn");
            return;
        }
        var wrap = $("ltWrap"); if (wrap) wrap.hidden = false;   /* visible first, so the map is measured at its real size */
        buildMap(d);
        message(stale ? "Location paused. Last seen " + ago(d.rider.updatedAt) + ". The messenger's GPS or signal may be weak." : "", stale ? "warn" : "");
        moveRider(d.rider.lat, d.rider.lng);
        riderMarker.setOpacity(stale ? 0.55 : 1);

        var dist = null, mins = null;
        if (d.destination) {
            dist = km(d.rider.lat, d.rider.lng, d.destination.lat, d.destination.lng);
            mins = eta(dist, d.rider.speed);
            if (!line) line = L.polyline([[d.rider.lat, d.rider.lng], [d.destination.lat, d.destination.lng]], { color: "#1f4fd8", weight: 3, opacity: .55, dashArray: "6 8" }).addTo(map);
            else line.setLatLngs([[d.rider.lat, d.rider.lng], [d.destination.lat, d.destination.lng]]);
            if (follow && !riderMarker._fitted) { riderMarker._fitted = true; recenter(true); }
        }
        var arrived = dist != null && dist < 0.08;
        $("ltPanel").innerHTML =
            '<div class="lt-ptop"><span class="lt-live' + (stale ? " off" : "") + '"></span><b>' + esc(arrived ? "Your messenger is at your location" : (stale ? "Waiting for location" : "On the way to you")) + '</b></div>' +
            (d.destination
                ? '<div class="lt-stats"><div><small>Arrives in</small><strong>' + (arrived ? "Now" : "~" + mins + " min") + '</strong></div>' +
                  '<div><small>Distance</small><strong>' + esc(fmtDist(dist)) + '</strong></div>' +
                  '<div><small>Updated</small><strong>' + (stale ? esc(ago(d.rider.updatedAt)) : "Live") + '</strong></div></div>' +
                  '<p class="lt-note">Estimate based on straight-line distance.</p>'
                : '<p class="lt-note">Distance is not shown because no map pin was saved for this delivery address.</p>');
    }

    function renderDelivery(d) {
        ensureShell();
        switch (d.state) {
            case "no_rider":
                destroyMap(); message("", ""); box().hidden = true; return;
            case "waiting_start":
                destroyMap(); box().hidden = false;
                message("Live tracking starts when your messenger sets off with your order.", ""); return;
            case "waiting_gps":
                box().hidden = false;
                if (d.rider) { renderLive(d); return; }
                destroyMap(); message("Your messenger is on the way, but we can't see their location yet. Their GPS may be off or the signal weak. This updates by itself.", "warn"); return;
            case "live":
                box().hidden = false; renderLive(d); return;
            case "ended":
                destroyMap(); box().hidden = false;
                message(d.reason === "cancelled" || d.reason === "rejected" ? "This order was cancelled. Tracking is not available." : "Your order has been delivered. Live tracking has ended.", "done");
                stopPolling(true); return;
        }
    }

    /* ---------- pickup card ---------- */
    function renderPickup(d) {
        var card = $("pickupCard");
        if (!card) return;
        if (d.state !== "pickup_open" || !d.shop) { card.hidden = true; return; }
        var s = d.shop, hasPin = s.lat != null && s.lng != null && isFinite(s.lat) && isFinite(s.lng);
        var where = [s.address, s.location].filter(function (x, i, a) { return x && a.indexOf(x) === i; }).join(" \u00b7 ");
        var dir = hasPin ? "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(s.lat + "," + s.lng)
                         : "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent([s.name, where].filter(Boolean).join(" "));
        $("pickupBox").innerHTML =
            '<p class="pk-name">' + esc(s.name || "Dealer shop") + '</p>' +
            (where ? '<p class="pk-addr">' + esc(where) + '</p>' : '<p class="pk-addr">The dealer has not added a shop address yet.</p>') +
            (hasPin ? '<div class="lt-map pk-map" id="pkMap"></div>' : "") +
            '<a class="pk-btn" href="' + esc(dir) + '" target="_blank" rel="noopener">Get directions</a>' +
            '<p class="lt-note">Show your order number when you arrive to collect your order.</p>';
        card.hidden = false;
        if (hasPin && typeof L !== "undefined") {
            if (shopMap) { shopMap.remove(); shopMap = null; }
            shopMap = L.map("pkMap", { zoomControl: true, scrollWheelZoom: false }).setView([s.lat, s.lng], 16);
            L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(shopMap);
            L.marker([s.lat, s.lng], { icon: icon(SHOP, 30, 40, 15, 40), title: s.name || "Dealer shop" }).addTo(shopMap);
        }
    }

    /* ---------- polling ---------- */
    function stopPolling(final) { if (timer) { clearTimeout(timer); timer = null; } if (final) stopped = true; }

    async function tick() {
        timer = null;
        if (!cur || stopped) return;
        if (document.hidden) { schedule(SLOW); return; }
        if (polling) return;
        polling = true;
        var id = cur.id, d = await fetchTracking(id);
        polling = false;
        if (!cur || cur.id !== id || stopped) return;
        if (d.gone) { stopPolling(true); var b = box(); if (b) b.hidden = true; var pc = $("pickupCard"); if (pc) pc.hidden = true; return; }
        if (d.error) { schedule(SLOW); return; }          /* network blip: keep showing the last position and try again */

        if (d.mode === "pickup") {
            if (!shopFor || d.state === "ended") { renderPickup(d); shopFor = d.state === "ended" ? null : id; }
            if (d.state === "ended") { stopPolling(true); return; }
            schedule(SLOW * 2); return;                /* the shop does not move: check again only to notice completion */
        }
        renderDelivery(d);
        if (d.state === "ended") return;
        schedule(d.state === "live" ? FAST : (d.state === "waiting_gps" ? FAST : SLOW));
    }
    function schedule(ms) { if (stopped) return; if (timer) clearTimeout(timer); timer = setTimeout(tick, ms); }

    document.addEventListener("visibilitychange", function () { if (!document.hidden && cur && !stopped && !polling) { if (timer) clearTimeout(timer); tick(); } });

    /* ---------- entry point, called by customer-orders.js after every render ---------- */
    function update(order) {
        if (!order) return;
        var id = String(order.id), pickup = !!order.pickup, ended = order.stage === 3 || order.stage === -1;
        var sameOrder = cur && cur.id === id && cur.pickup === pickup;

        /* Finished order: take everything down at once, without waiting for the next poll */
        if (ended) {
            cur = { id: id, pickup: pickup };
            stopPolling(true);
            destroyMap();
            if (shopMap) { shopMap.remove(); shopMap = null; }
            var pc = $("pickupCard"); if (pc) pc.hidden = true;
            if (!pickup) {
                var b = box();
                if (b && order.stage === 3) { ensureShell(); b.hidden = false; message("Your order has been delivered. Live tracking has ended.", "done"); }
                else if (b) b.hidden = true;
            }
            return;
        }
        if (sameOrder && !stopped) {                  /* already tracking this order: just check now, the status may have changed */
            if (!polling) { if (timer) clearTimeout(timer); tick(); }
            return;
        }
        cur = { id: id, pickup: pickup }; stopped = false; shopFor = null;
        if (pickup) { var bx = box(); if (bx) bx.hidden = true; }
        tick();
    }

    window.GasHubLiveTrack = { update: update };
})();
