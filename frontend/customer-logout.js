/* GasHub customer log out (shared).
   Clears what this phone remembers AND tells the server to end the session cookie.
   Without the server step the cookie stays, and the login page would sign the customer
   straight back in. Ends on the login page so they can sign in again. */
(function () {
    "use strict";
    /* login details */
    var LOCAL_KEYS = ["customer", "user", "customerData", "currentUser", "gasHubCustomer", "gasHubCustomerProfile",
        "gasHubCustomerSession", "gasHubLoggedIn", "token", "authToken", "customerToken", "gasHubRememberedEmail"];

    /* everything else that belongs to ONE customer: profile photo, points, favourite products, followed dealers, orders,
       delivery pin, notification choices, reminders, reviews, chats ... none of it may stay on the phone for the next person. */
    var PERSONAL_KEYS = ["gasHubProfilePhoto", "gasHubPoints", "gasHubFavourites", "gasHubFavorites", "gasHubFavs", "favourites", "favorites",
        "gasHubFollowedDealers", "gasHubFollowing", "gasHubFollowedDealer", "followedDealers", "gasHubOrderHistory", "gasHubOrders",
        "gasHubLastOrder", "gasHubViews", "gasHubProductLocalViews", "gasHubPurchases", "gasHubDeletionRequest", "gasHubNotify",
        "gasHubLocation", "gasHubReminders", "gasHubUsageHabit", "gasHubReplyPopup", "gasHubReplySeen", "gasHubPayPopupShown", "gasHubRef", "gasHubPhotoRemoved"];
    var PERSONAL_PREFIXES = ["gasHubReviews_", "gasHubChat_", "gashub-refill-"];

    /* Not removed on purpose (they are about this phone, not the customer): the light/dark theme, the login attempt limiter
       and shop-wide settings such as the point rate. The remembered login email IS removed on an explicit log out. */

    function removeMatching(area) {
        try {
            var doomed = [];
            for (var i = 0; i < area.length; i++) {
                var k = area.key(i);
                if (k && PERSONAL_PREFIXES.some(function (p) { return k.indexOf(p) === 0; })) doomed.push(k);
            }
            doomed.forEach(function (k) { area.removeItem(k); });
        } catch (e) { }
    }
    function wipe() {
        LOCAL_KEYS.concat(PERSONAL_KEYS).forEach(function (k) {
            try { localStorage.removeItem(k); } catch (e) { }
            try { sessionStorage.removeItem(k); } catch (e) { }
        });
        removeMatching(localStorage);
        removeMatching(sessionStorage);
    }
    function serverLogout() {
        var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 8000);
        var opts = { credentials: "same-origin", cache: "no-store", signal: ctl.signal };
        return Promise.resolve(window.GasHubPush ? window.GasHubPush.leave() : null)   /* stop phone alerts for this person first */
            .then(function () { return fetch("/api/auth/csrf", opts); })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                return fetch("/api/auth/logout", Object.assign({}, opts, {
                    method: "POST",
                    headers: { Accept: "application/json", "X-CSRF-Token": (d && d.csrfToken) || "" }
                }));
            })
            .catch(function () { })
            .then(function () { clearTimeout(timer); });
    }
    /* ---------- the log out confirmation (replaces the browser's plain pop-up) ---------- */
    var dlgOpen = false;
    function injectCss() {
        if (document.getElementById("ghLogoutCss")) return;
        var st = document.createElement("style"); st.id = "ghLogoutCss";
        st.textContent =
            ".gh-lo{position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;padding:20px;" +
            "background:rgba(10,18,50,.55);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .2s;" +
            "font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}" +
            ".gh-lo.in{opacity:1}" +
            ".gh-lo-card{width:100%;max-width:340px;padding:26px 22px 20px;border-radius:22px;text-align:center;background:#fff;color:#10233f;" +
            "box-shadow:0 24px 60px rgba(10,18,50,.35);transform:translateY(14px) scale(.96);transition:transform .22s cubic-bezier(.2,.9,.3,1.2)}" +
            ".gh-lo.in .gh-lo-card{transform:none}" +
            ".gh-lo-ico{width:62px;height:62px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center;background:#fdecec;color:#e03131}" +
            ".gh-lo-ico svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}" +
            ".gh-lo-card h2{margin:0 0 6px;font-size:19px;font-weight:800;color:#0f2a7a}" +
            ".gh-lo-card p{margin:0 0 20px;font-size:14px;line-height:1.5;color:#5f6783}" +
            ".gh-lo-btns{display:flex;gap:10px}" +
            ".gh-lo-btns button{flex:1;min-height:46px;border-radius:14px;border:0;font:inherit;font-size:15px;font-weight:700;cursor:pointer;transition:transform .1s,opacity .2s}" +
            ".gh-lo-btns button:active{transform:scale(.97)}" +
            ".gh-lo-stay{background:#eaf0ff;color:#1f4fd8}" +
            ".gh-lo-go{background:#e03131;color:#fff}" +
            ".gh-lo-btns button:disabled{opacity:.7;cursor:default}" +
            ".gh-lo-btns button:focus-visible{outline:3px solid #ffc20e;outline-offset:2px}" +
            "html[data-theme=dark] .gh-lo-card{background:#111d31;color:#e8eef9}" +
            "html[data-theme=dark] .gh-lo-card h2{color:#a9c1ff}html[data-theme=dark] .gh-lo-card p{color:#9fb0c8}" +
            "html[data-theme=dark] .gh-lo-ico{background:#3a1b22}html[data-theme=dark] .gh-lo-stay{background:#1b2750;color:#a9c1ff}" +
            "@media (prefers-reduced-motion:reduce){.gh-lo,.gh-lo-card{transition:none}}";
        document.head.appendChild(st);
    }
    window.gasHubAskLogout = function () {
        if (dlgOpen) return;
        dlgOpen = true; injectCss();
        var prevFocus = document.activeElement;
        var o = document.createElement("div");
        o.className = "gh-lo"; o.setAttribute("role", "alertdialog"); o.setAttribute("aria-modal", "true");
        o.setAttribute("aria-labelledby", "ghLoT"); o.setAttribute("aria-describedby", "ghLoD");
        o.innerHTML =
            '<div class="gh-lo-card">' +
            '<div class="gh-lo-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg></div>' +
            '<h2 id="ghLoT">Log out of GasHub?</h2>' +
            '<p id="ghLoD">You will need to sign in again to order gas, track deliveries and see your points.</p>' +
            '<div class="gh-lo-btns"><button type="button" class="gh-lo-stay">Stay signed in</button>' +
            '<button type="button" class="gh-lo-go">Log out</button></div></div>';
        document.body.appendChild(o);
        var stay = o.querySelector(".gh-lo-stay"), go = o.querySelector(".gh-lo-go"), busy = false;
        requestAnimationFrame(function () { o.classList.add("in"); stay.focus(); });
        function close() {
            if (busy) return;
            document.removeEventListener("keydown", onKey, true);
            o.classList.remove("in");
            setTimeout(function () { if (o.parentNode) o.parentNode.removeChild(o); dlgOpen = false; }, 200);
            try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { }
        }
        function onKey(e) {
            if (e.key === "Escape") { e.preventDefault(); close(); }
            else if (e.key === "Tab") {                       /* keep the keyboard inside the dialog */
                e.preventDefault(); (document.activeElement === go ? stay : go).focus();
            }
        }
        document.addEventListener("keydown", onKey, true);
        o.addEventListener("click", function (e) { if (e.target === o) close(); });
        stay.addEventListener("click", close);
        go.addEventListener("click", function () {
            busy = true; go.disabled = true; stay.disabled = true; go.textContent = "Logging out...";
            window.gasHubLogout();
        });
    };

    window.gasHubLogout = function () {
        wipe();
        return serverLogout().then(function () { wipe(); location.replace("customer-login.html?logged_out=1"); });
    };
})();