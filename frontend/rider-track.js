/* GasHub messenger page (opened from the dealer's tracking link, no login).
   - "Start delivery" asks the phone for its location, then tells the server the delivery has started.
   - While the delivery runs, the phone's real GPS position is sent every few seconds (the server also ignores
     positions that did not change, so a parked messenger does not fill the database).
   - "Confirm order completed" only appears when the messenger is about 1 minute from the customer (the server decides,
     from the phone's position, and checks again when the button is pressed). It marks the order delivered, and the order
     completes as soon as the payment is confirmed (straight away if it is already paid).
   - Sharing stops once the order is delivered.
   A web page can only read GPS while it is open, so the messenger must keep this page open. */
(function () {
    "use strict";

    var token = new URLSearchParams(location.search).get("t") || "";
    var API = "/api/track/rider/" + encodeURIComponent(token);
    var SEND_EVERY = 6000;            /* ms between position uploads */

    /* this phone's secret key: the first phone that starts the delivery owns the link, so a forwarded link is useless */
    var deviceKey = (function () {
        var k = "";
        try { k = localStorage.getItem("gashub_rider_device") || ""; } catch (e) { /* storage blocked */ }
        if (!/^[a-f0-9]{32}$/.test(k)) {
            var a = new Uint8Array(16);
            (window.crypto || window.msCrypto).getRandomValues(a);
            k = Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
            try { localStorage.setItem("gashub_rider_device", k); } catch (e) { /* keeps it in memory for this visit */ }
        }
        return k;
    })();

    var $ = function (id) { return document.getElementById(id); };
    var watchId = null, timer = null, wakeLock = null, latest = null, lastFixAt = 0, sending = false, sharing = false;
    var noPin = false;                /* the order has no delivery pin, so distance cannot be measured */

    function show(which) {
        ["vLoading", "vEnd", "vMain"].forEach(function (id) { $(id).hidden = id !== which; });
    }
    function end(kind, title, text) {
        stopSharing();
        var icon = $("endIcon");
        icon.className = "big" + (kind === "ok" ? " ok" : (kind === "bad" ? " bad" : ""));
        icon.textContent = kind === "ok" ? "\u2713" : "!";
        $("endTitle").textContent = title; $("endText").textContent = text;
        show("vEnd");
    }
    function warn(msg) { var w = $("warn"); w.textContent = msg || ""; w.hidden = !msg; }
    function setStatus(kind, title, text) {
        $("statusDot").className = "dot" + (kind ? " " + kind : "");
        $("statusTitle").textContent = title; $("statusText").textContent = text;
    }
    function hhmmss(d) { return d.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }

    async function call(path, method, body) {
        var r = await fetch(API + path, {
            method: method || "GET", cache: "no-store",
            headers: body ? { "Content-Type": "application/json", "X-Device-Key": deviceKey } : { "X-Device-Key": deviceKey },
            body: body ? JSON.stringify(body) : undefined
        });
        var j = {};
        try { j = await r.json(); } catch (e) { /* not JSON */ }
        return { status: r.status, ok: r.ok && j.success !== false, json: j };
    }

    /* ---------- screen wake lock (keeps the phone awake so GPS keeps running) ---------- */
    async function keepAwake() {
        try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* optional */ }
    }
    document.addEventListener("visibilitychange", function () { if (sharing && !document.hidden) keepAwake(); });


    /* ---------- "about 1 minute from the customer" ---------- */
    function fmtDist(m) { return m < 1000 ? Math.max(10, Math.round(m / 10) * 10) + " m" : (m / 1000).toFixed(1) + " km"; }
    function setNear(info) {
        var hint = $("nearHint"), btn = $("doneBtn");
        if (!sharing) { hint.hidden = true; btn.hidden = true; return; }
        var near = noPin || (info && info.nearby === true);
        btn.hidden = !near;
        hint.hidden = false;
        hint.className = "near" + (near ? " ready" : "");
        if (near) {
            hint.textContent = noPin
                ? "This order has no map pin, so we cannot measure the distance. Confirm only after you have handed the order to the customer."
                : "You are close to the customer. Confirm the order once you have handed it over.";
        } else {
            var d = info && info.distanceM != null ? " You are about " + fmtDist(info.distanceM) + " away." : "";
            hint.textContent = "The confirm button appears when you are about 1 minute from the customer." + d;
        }
    }

    /* ---------- GPS ---------- */
    function gpsError(err) {
        if (err && err.code === 1) {
            warn("Location permission is blocked. Allow location for this page in your browser settings, then reload.");
            setStatus("err", "Location is blocked", "The customer cannot see you until you allow location.");
        } else if (err && err.code === 2) {
            warn("Your phone cannot find its GPS position right now. Check that location is turned on.");
            setStatus("err", "GPS unavailable", "Waiting for your phone to find its position...");
        } else {
            warn("Still looking for your GPS position. Move to an open area if this continues.");
        }
    }
    function onPosition(p) {
        latest = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed };
        lastFixAt = Date.now();
        warn("");
    }
    function startWatch() {
        if (watchId != null) return;
        watchId = navigator.geolocation.watchPosition(onPosition, gpsError, { enableHighAccuracy: true, maximumAge: 3000, timeout: 25000 });
        timer = setInterval(upload, SEND_EVERY);
        sharing = true;
        keepAwake();
        setStatus("live", "Sharing your location", "The customer can see you on the map. Waiting for the first GPS position...");
        $("startBtn").hidden = true;
        setNear(null);
        upload();
    }
    function stopSharing() {
        sharing = false;
        $("doneBtn").hidden = true; $("nearHint").hidden = true;
        if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
        if (timer) { clearInterval(timer); timer = null; }
        try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
        wakeLock = null;
    }

    async function upload() {
        if (sending || !sharing) return;
        if (!latest) return;
        /* a position older than 40 seconds is not sent as if it were new */
        if (Date.now() - lastFixAt > 40000) { setStatus("err", "No GPS signal", "Waiting for your phone to find its position..."); return; }
        sending = true;
        try {
            var res = await call("/location", "POST", latest);
            if (res.status === 403) { end("bad", "Link in use on another phone", res.json.message || "Ask the dealer for a new link."); return; }
            if (res.status === 404 && res.json.code === "expired") { end("bad", "Link expired", res.json.message); return; }
            if (res.status === 404 || res.status === 410) { end("ok", "Delivery finished", "Location sharing has stopped. You can close this page."); return; }
            if (res.ok) {
                setStatus("live", "Sharing your location", "Last sent at " + hhmmss(new Date()) + ". Keep this page open.");
                setNear(res.json);
            }
        } catch (e) {
            setStatus("err", "No internet", "We will keep trying. Your position is sent again as soon as you are back online.");
        } finally { sending = false; }
    }

    /* ---------- buttons ---------- */
    function askForPosition() {
        return new Promise(function (resolve, reject) {
            navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 });
        });
    }
    $("startBtn").addEventListener("click", async function () {
        var btn = this;
        warn("");
        if (!window.isSecureContext) { warn("GPS only works on a secure (https) page. Ask the dealer to send the link again from the live site."); return; }
        if (!navigator.geolocation) { warn("This phone or browser does not support GPS."); return; }
        btn.disabled = true; btn.textContent = "Getting your location...";
        try {
            var p = await askForPosition();        /* asks permission first, so a refusal never starts the delivery */
            onPosition(p);
        } catch (err) { gpsError(err); btn.disabled = false; btn.textContent = "Start delivery"; return; }
        try {
            var res = await call("/start", "POST", {});
            if (res.status === 403) { end("bad", "Link in use on another phone", res.json.message || "Ask the dealer for a new link."); return; }
            if (!res.ok) { warn(res.json.message || "Could not start the delivery."); btn.disabled = false; btn.textContent = "Start delivery"; if (res.status === 410 || res.status === 404) end("bad", res.json.code === "expired" ? "Link expired" : "Delivery finished", res.json.message || ""); return; }
            startWatch();
        } catch (e) {
            warn("No internet connection. Try again."); btn.disabled = false; btn.textContent = "Start delivery";
        }
    });

    $("doneBtn").addEventListener("click", async function () {
        if (!confirm("Confirm that you have handed the order to the customer? Location sharing will stop.")) return;
        var btn = this; btn.disabled = true;
        try {
            var res = await call("/delivered", "POST", {});
            if (res.status === 403) { end("bad", "Link in use on another phone", res.json.message || "Ask the dealer for a new link."); return; }
            if (res.ok || res.status === 410) { end("ok", "Order confirmed", res.json.message || "Thank you. Location sharing has stopped. You can close this page."); return; }
            if (res.status === 409) {
                /* the server says we are not close enough yet (or it cannot see our position): hide the button again */
                warn(res.json.message || "You can confirm when you are about 1 minute from the customer.");
                setNear({ nearby: false, distanceM: res.json.distanceM });
                btn.disabled = false;
                return;
            }
            warn(res.json.message || "Could not confirm this order."); btn.disabled = false;
        } catch (e) { warn("No internet connection. Try again."); btn.disabled = false; }
    });

    /* ---------- load ---------- */
    async function load() {
        if (!/^[a-f0-9]{48}$/.test(token)) { end("bad", "Link not valid", "Ask the dealer to send you the tracking link again."); return; }
        var res;
        try { res = await call("", "GET"); } catch (e) { end("bad", "No internet", "Check your connection and reload this page."); return; }
        if (res.status === 403) { end("bad", "Link in use on another phone", res.json.message || "Ask the dealer to send you a new link."); return; }
        if (res.status === 404) { end("bad", res.json.code === "expired" ? "Link expired" : "Link not valid", res.json.message || "Ask the dealer to send you a new tracking link."); return; }
        if (res.status === 410) { end("ok", "Delivery finished", "There is nothing more to do here. You can close this page."); return; }
        if (!res.ok) { end("bad", "Something went wrong", res.json.message || "Please reload this page."); return; }

        var o = res.json;
        $("orderNo").textContent = o.orderNumber || "";
        $("riderName").textContent = o.riderName || "";
        $("destText").textContent = o.destination.address || "Delivery address not given";
        if (o.destination.landmark) { $("destLandmark").textContent = "Near " + o.destination.landmark; $("destLandmark").hidden = false; }
        if (o.customerPhone) {
            var tel = /^0\d{9}$/.test(o.customerPhone) ? "+254" + o.customerPhone.slice(1) : o.customerPhone;
            $("callBtn").href = "tel:" + tel; $("callBtn").hidden = false;
        }
        var d = o.destination;
        if (d.lat != null && d.lng != null) {
            $("navBtn").href = "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(d.lat + "," + d.lng);
            $("navBtn").hidden = false;
        } else if (d.address) {
            $("navBtn").href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(d.address);
            $("navBtn").hidden = false;
        }
        noPin = !!(o.arrival && o.arrival.needsPin);
        var pay = o.payment;
        if (pay) {
            var cash = pay.method === "cash" && !pay.paid;
            $("payCard").className = "card pay" + (cash ? " cash" : "");
            $("payTitle").textContent = cash ? "Collect KSh " + Number(pay.amountDue || 0).toLocaleString("en-KE") + " cash" : (pay.paid ? "Already paid" : "Paid through GasHub");
            $("payText").textContent = cash
                ? "The customer pays cash on delivery. Hand the cash to the dealer: the order completes once the dealer confirms it."
                : (pay.paid ? "Nothing to collect. Just hand over the order."
                    : "The customer pays GasHub by M-Pesa. Do not take money for this order.");
            $("payCard").hidden = false;
        }
        show("vMain");
        if (o.started && navigator.geolocation) startWatch();   /* page was reloaded mid-delivery: carry on sharing */
    }
    load();
})();
