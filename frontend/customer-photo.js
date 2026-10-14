/* GasHub customer profile photo (shared).
   One place decides what every profile picture on the customer pages shows:
     1. a photo the customer chose on the profile page, otherwise
     2. the photo from their Google (or other social) account, which the server saved when they signed in.
   It fills the menu avatar on every page and the big photo on the profile page, and keeps them filled even when a
   page's own script later rewrites the avatar with a letter. If a photo cannot load, the letter stays. */
(function () {
    "use strict";
    var KEY = "gasHubProfilePhoto";

    function ok(u) { return typeof u === "string" && /^(data:image\/|https:\/\/|\/)/.test(u); }
    function read() {
        try {
            var raw = localStorage.getItem(KEY);
            if (!raw) return "";
            try { var v = JSON.parse(raw); return ok(v) ? v : ""; } catch (e) { return ok(raw) ? raw : ""; }
        } catch (e) { return ""; }
    }
    function save(u) { try { localStorage.setItem(KEY, JSON.stringify(u)); } catch (e) { } }
    function customerName() {
        var keys = ["gasHubCustomer", "customer", "gasHubCustomerProfile"];
        for (var i = 0; i < keys.length; i++) {
            try {
                var c = JSON.parse(localStorage.getItem(keys[i]));
                var n = c && (c.fullName || c.name || c.full_name);
                if (n) return String(n);
            } catch (e) { }
        }
        return "";
    }

    /* the small round avatars (menu drawer, page headers). The big one on the profile page is drawn by customer-profile.js. */
    function targets() {
        var out = [], seen = [];
        var list = document.querySelectorAll("#avatar, .gh-d-avatar, .customer-avatar");
        for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (seen.indexOf(el) > -1 || el.querySelector("#avatarImg")) continue;
            seen.push(el); out.push(el);
        }
        return out;
    }

    var painting = false, broken = "";
    function paint() {
        if (painting) return;
        painting = true;
        try {
            var ph = read();
            if (ph && ph === broken) ph = "";
            targets().forEach(function (el) {
                var cur = el.querySelector("img[data-ghp]");
                if (!ph) { if (cur) { cur.remove(); if (!el.textContent.trim()) el.textContent = (customerName() || "C").charAt(0).toUpperCase(); } return; }
                if (cur && cur.getAttribute("src") === ph) return;
                el.textContent = "";
                var im = document.createElement("img");
                im.setAttribute("data-ghp", "1"); im.alt = "";
                im.referrerPolicy = "no-referrer";          /* Google refuses photos that arrive with another site as referrer */
                im.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover;display:block";
                im.onerror = function () { broken = ph; paint(); };
                im.src = ph;
                el.appendChild(im);
            });
        } finally { painting = false; }
    }

    /* other scripts write a letter into the avatar after us: put the photo back */
    var observer = null, queued = false;
    function watch() {
        if (!window.MutationObserver) return;
        observer = new MutationObserver(function () {
            if (queued) return; queued = true;
            setTimeout(function () { queued = false; paint(); }, 0);
        });
        targets().forEach(function (el) { observer.observe(el, { childList: true, characterData: true, subtree: true }); });
    }

    /* signed-in customer with no photo on this phone yet: fetch the one the server holds (their Google picture) */
    function sync() {
        if (read()) return;
        try { if (localStorage.getItem("gasHubPhotoRemoved")) return; } catch (e) { }   /* the customer removed it on purpose */
        fetch("/api/customer/account", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var u = d && d.customer && d.customer.photo;
                if (!ok(u) || read()) return;
                save(u); paint();
                try { window.dispatchEvent(new Event("gashub-photo")); } catch (e) { }
            })
            .catch(function () { });
    }

    function start() { paint(); watch(); sync(); }
    window.GasHubPhoto = { get: read, paint: paint, sync: sync };
    window.addEventListener("storage", function (e) { if (!e.key || e.key === KEY) paint(); });
    window.addEventListener("gashub-photo", paint);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
