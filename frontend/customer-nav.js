/* GasHub shared customer navigation (sidebar + bottom tabs).
   Add ONE line right after <body> on a page:
     <script src="customer-nav.js" data-active="home" data-sidebar="true" data-tabs="true"></script>
   data-active : home | products | dealers | orders | profile | about   (which item is highlighted)
   data-sidebar: "true" adds the slide-in sidebar (opened by the #menuBtn hamburger in the page header)
   data-tabs   : "true" adds the bottom tab bar (phones/tablets). Leave both off on focused pages such as checkout.
   Keeps the old element ids (mobileMenu, menuOverlay, closeMenuBtn, logoutLink, helpLink, menuCustomerName, avatar)
   so each page's own script keeps working. */
(function () {
    "use strict";
    var me = document.currentScript, d = (me && me.dataset) || {};
    var active = d.active || "", wantSide = d.sidebar === "true", wantTabs = d.tabs === "true";
    var base = me && me.src ? me.src.replace(/[^\/]*$/, "") : "";

    /* stylesheet (own classes, so page CSS cannot restyle it) */
    /* Until customer-nav.css has loaded, the menu, its dark cover and the bottom tabs have no styling and would
       show as plain unstyled content on top of the page for a second (most visible on refresh). Keep them hidden
       until the stylesheet is ready. */
    var hold = document.createElement("style");
    hold.textContent = ".gh-scrim,.gh-drawer,.gh-tabs{display:none!important}";
    document.head.appendChild(hold);
    var released = false;
    function release() { if (released) return; released = true; if (hold.parentNode) hold.parentNode.removeChild(hold); }
    /* Reveal ONLY once the stylesheet has really loaded (a slow connection used to show the menu unstyled after 4 seconds).
       If the request fails it is retried, so the menu is never shown without its styling. */
    var tries = 0;
    function loadNavCss() {
        var css = document.createElement("link"); css.rel = "stylesheet";
        css.href = base + "customer-nav.css" + (tries ? "?r=" + tries + "-" + Date.now() : "");
        css.onload = release;
        css.onerror = function () { if (css.parentNode) css.parentNode.removeChild(css); if (++tries <= 5) setTimeout(loadNavCss, 800 * tries); };
        document.head.appendChild(css);
    }
    loadNavCss();

    var I = {
        home: '<path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z"/>',
        products: '<path d="M12 2c3 4 5 6.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.4 1 2.2 2 2.5C11 7.5 11 4.5 12 2z"/><path d="M9 21h6"/>',
        dealers: '<path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v8h14v-8"/><path d="M10 20v-4h4v4"/>',
        orders: '<path d="M6 2h12a1 1 0 0 1 1 1v18l-3-2-3 2-3-2-3 2V3a1 1 0 0 1 1-1z"/><path d="M9 8h6M9 12h6"/>',
        withdraw: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14.5h2"/><path d="M7 6l8-3 2 3"/>',
        profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
        about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
        ai: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 11h.01M12 11h.01M15 11h.01"/>',
        heart: '<path d="M12 21s-7-4.5-9.3-9A5.2 5.2 0 0 1 12 6.6 5.2 5.2 0 0 1 21.3 12C19 16.5 12 21 12 21z"/>',
        privacy: '<path d="M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
        help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17v.01"/>',
        logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
        login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>'
    };
    function svg(k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + I[k] + "</svg>"; }
    function cls(k) { return k === active ? ' class="active" aria-current="page"' : ""; }

    var MAIN = [
        ["home", "Home", "customer-home.html"],
        ["products", "Gas &amp; Cylinders", "customer-product.html"],
        ["dealers", "Find a Dealer", "customer-dealer.html"],
        ["orders", "My Orders", "customer-orders.html"],
        ["withdraw", "Withdraw Points", "customer-withdraw.html"],
        ["profile", "My Profile", "customer-profile.html"]
    ];
    var TABS = [["home", "Home"], ["products", "Products"], ["dealers", "Dealers"], ["orders", "Orders"], ["profile", "Profile"]];
    var HREF = { home: "customer-home.html", products: "customer-product.html", dealers: "customer-dealer.html", orders: "customer-orders.html", profile: "customer-profile.html" };

    var html = "";
    if (wantSide) {
        html += '<div class="gh-scrim" id="menuOverlay"></div>' +
            '<aside class="gh-drawer" id="mobileMenu" aria-hidden="true" aria-label="Menu">' +
            '<div class="gh-d-head"><img src="/Images/logo.png" alt="GasHub"><button type="button" class="gh-d-close" id="closeMenuBtn" aria-label="Close menu">&times;</button></div>' +
            '<div class="gh-d-user"><div class="gh-d-avatar" id="avatar">C</div><div><strong id="menuCustomerName">Welcome</strong><small>GasHub Customer</small></div></div>' +
            '<nav class="gh-d-nav" aria-label="Main menu">' +
            MAIN.map(function (m) { return '<a href="' + m[2] + '"' + cls(m[0]) + ">" + svg(m[0]) + m[1] + "</a>"; }).join("") +
            '<a href="customer-about.html"' + cls("about") + ">" + svg("about") + "About GasHub</a>" +
            '<div class="gh-d-sep"></div>' +
            '<a href="customer-profile.html#favSection">' + svg("heart") + "Favourite products</a>" +
            "</nav>" +
            '<div class="gh-d-foot">' +
            '<a href="#" id="helpLink">' + svg("help") + "Help &amp; Support</a>" +
            '<a href="/privacy-policy.html?from=app">' + svg("privacy") + "Privacy Policy</a>" +
            '<a href="customer-login.html" id="logoutLink">' + svg("logout") + "Logout</a>" +
            "</div></aside>";
    }
    if (wantTabs) {
        html += '<nav class="gh-tabs" aria-label="Main">' +
            TABS.map(function (t) { return '<a href="' + HREF[t[0]] + '"' + cls(t[0]) + ">" + svg(t[0]) + "<span>" + t[1] + "</span></a>"; }).join("") + "</nav>";
    }
    if (document.body) document.body.insertAdjacentHTML("afterbegin", html);
    else document.write(html);
    if (wantTabs) document.body.classList.add("gh-has-tabs");

    var $ = function (id) { return document.getElementById(id); };
    function openMenu() { var m = $("mobileMenu"), s = $("menuOverlay"); if (!m) return; m.classList.add("active"); s.classList.add("show"); m.setAttribute("aria-hidden", "false"); }
    function closeMenu() { var m = $("mobileMenu"), s = $("menuOverlay"); if (!m) return; m.classList.remove("active"); s.classList.remove("show"); m.setAttribute("aria-hidden", "true"); }
    window.GasHubNav = { open: openMenu, close: closeMenu };

    /* Our handlers run first (capture) and stop the page's older handlers, so nothing opens twice or asks twice. */
    if (wantSide) {
        document.addEventListener("click", function (e) {
            var t = e.target; if (!t || !t.closest) return;
            if (t.closest("#menuBtn")) { e.preventDefault(); e.stopPropagation(); openMenu(); return; }
            if (t.closest("#closeMenuBtn") || t.closest("#menuOverlay")) { e.stopPropagation(); closeMenu(); return; }
            if (t.closest("#helpLink")) {
                e.preventDefault(); e.stopPropagation(); closeMenu();
                if (window.GasHubAssistant && window.GasHubAssistant.open) window.GasHubAssistant.open(); else location.href = "customer-profile.html#contact";
                return;
            }
            if (t.closest("#logoutLink")) {
                e.preventDefault(); e.stopPropagation();
                closeMenu();
                if (t.closest("#logoutLink").getAttribute("data-guest") === "1") { location.href = "customer-login.html"; return; }
                if (window.gasHubAskLogout) window.gasHubAskLogout();
                else if (confirm("Are you sure you want to log out?")) { if (window.gasHubLogout) window.gasHubLogout(); else location.href = "customer-login.html?logged_out=1"; }
                return;
            }
            if (t.closest("#mobileMenu a[href]") && !t.closest("#helpLink,#logoutLink")) closeMenu();
        }, true);
        document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); });

        /* customer name + initial */
        function who() {
            var c = null, keys = ["customer", "user", "customerData", "currentUser", "gasHubCustomer", "gasHubCustomerProfile"];
            for (var i = 0; i < keys.length && !c; i++) { try { c = JSON.parse(localStorage.getItem(keys[i])); } catch (e) { c = null; } }
            if (!c) return;
            var n = c.name || c.full_name || c.fullName || ((c.first_name || "") + " " + (c.last_name || "")).trim() || "Customer";
            $("menuCustomerName").textContent = n; $("avatar").textContent = String(n).charAt(0).toUpperCase();
            /* the profile photo is drawn by customer-photo.js */
        }
        who();

        /* Visitors who are not signed in see "Login" instead of "Logout". The saved sign-in flag decides at once;
           then the server is asked, and its answer wins (401 = not signed in). If the server cannot be reached the saved flag stays. */
        function setGuest(guest) {
            var a = $("logoutLink"); if (!a) return;
            var small = document.querySelector("#mobileMenu .gh-d-user small");
            if (guest) {
                a.setAttribute("data-guest", "1"); a.setAttribute("href", "customer-login.html");
                a.innerHTML = svg("login") + "Login";
                if ($("menuCustomerName")) $("menuCustomerName").textContent = "Welcome";
                if ($("avatar")) $("avatar").textContent = "G";
                if (small) small.textContent = "Log in to order";
            } else {
                a.removeAttribute("data-guest");
                a.innerHTML = svg("logout") + "Logout";
                if (small) small.textContent = "GasHub Customer";
            }
        }
        var savedIn = false;
        try { savedIn = localStorage.getItem("gasHubLoggedIn") === "true"; } catch (x) { savedIn = true; }
        setGuest(!savedIn);
        try {
            fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" }).then(function (r) {
                if (r.status === 401 || r.status === 403) setGuest(true);
                else if (r.ok) { setGuest(false); who(); }
            }).catch(function () { });
        } catch (x) { }
    }

    /* Back/forward cache: after logging out, pressing Back can bring up an old copy of the page that still shows the
       last customer's name. If the customer is no longer saved on this phone, reload so the page shows the truth. */
    window.addEventListener("pageshow", function (e) {
        if (!e.persisted) return;
        var has = false;
        try { has = !!(localStorage.getItem("gasHubCustomer") || localStorage.getItem("customer") || localStorage.getItem("gasHubLoggedIn")); } catch (x) { has = true; }
        var named = !!document.querySelector("#menuCustomerName") && document.querySelector("#menuCustomerName").textContent.trim() !== "Welcome";
        if (!has && named) location.reload();
    });
})();
