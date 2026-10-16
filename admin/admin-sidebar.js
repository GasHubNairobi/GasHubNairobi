/* =========================================================
   GASHUB ADMIN - SHARED SIDEBAR + LOGOUT
   One sidebar definition used by every admin page.
   Add new menu items here and they appear everywhere.
========================================================= */
(function () {
    "use strict";

    var NAV = [
        { href: "admin-dashboard.html", icon: "⌂", label: "Dashboard" },
        { href: "admin-product.html", icon: "▣", label: "Products" },
        { href: "admin-orders.html", icon: "▤", label: "Orders", badge: true },
        { href: "admin-messengers.html", icon: "➤", label: "Messengers" },
        { href: "admin-customers.html", icon: "♙", label: "Customers" },
        { href: "admin-dealers.html", icon: "♟", label: "Dealers", also: ["admin-dealer-details.html"] },
        { href: "admin-dealer-requests.html", icon: "✍", label: "Dealer Applications" },
        { href: "admin-complaints.html", icon: "!", label: "Complaints" },
        { href: "admin-reviews.html", icon: "★", label: "Reviews" },
        { href: "admin-payment.html", icon: "KSh", label: "Payments" },
        { href: "admin-payout-planner.html", icon: "◷", label: "Payout Planner" },
        { href: "admin-withdrawals.html", icon: "⇩", label: "Point Withdrawals" },
        { href: "admin-report.html", icon: "▥", label: "Reports" },
        { href: "admin-email-broadcast.html", icon: "✉", label: "Email Broadcast" },
        { href: "admin-sms-broadcast.html", icon: "☎", label: "SMS Broadcast" },
        { href: "admin-item-reminders.html", icon: "◔", label: "Item Reminders" },
        { href: "admin-restock-reminders.html", icon: "↻", label: "Restock Reminders" },
        { href: "admin-settings.html", icon: "⚙", label: "Settings" }
    ];

    var LOGIN_PAGE = "admin-login.html";
    var COLLAPSE_KEY = "gashub_admin_sidebar_collapsed";

    function esc(v) {
        return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function currentPage() {
        var p = (location.pathname.split("/").pop() || "").toLowerCase();
        return p || "admin-dashboard.html";
    }

    function readAdmin() {
        try {
            var raw = localStorage.getItem("gashub_admin") || sessionStorage.getItem("gashub_admin");
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function initials(name) {
        var w = String(name || "").trim().split(/\s+/).filter(Boolean);
        if (!w.length) return "A";
        if (w.length === 1) return w[0].charAt(0).toUpperCase();
        return (w[0].charAt(0) + w[w.length - 1].charAt(0)).toUpperCase();
    }

    function getToken() {
        try {
            return localStorage.getItem("gashub_admin_token") || sessionStorage.getItem("gashub_admin_token") ||
                localStorage.getItem("adminToken") || "";
        } catch (e) { return ""; }
    }

    function clearSession() {
        ["gashub_admin", "gashub_admin_token", "adminToken"].forEach(function (k) {
            try { localStorage.removeItem(k); } catch (e) { }
            try { sessionStorage.removeItem(k); } catch (e) { }
        });
    }

    function buildHtml() {
        var page = currentPage();
        var admin = readAdmin() || {};
        var name = admin.full_name || admin.name || admin.username || admin.email || "Administrator";
        var role = admin.role ? String(admin.role).replace(/_/g, " ") : "Platform admin";

        var links = NAV.map(function (n) {
            var active = page === n.href || (n.also && n.also.indexOf(page) > -1);
            return '<a class="gh-sb-link' + (active ? " active" : "") + '" href="' + n.href + '"' +
                (active ? ' aria-current="page"' : "") + ' title="' + esc(n.label) + '">' +
                '<span class="gh-sb-icon">' + n.icon + '</span>' +
                '<span class="gh-sb-text">' + esc(n.label) + '</span>' +
                (n.badge ? '<span class="gh-sb-badge" id="ordersBadge">0</span>' : "") +
                '</a>';
        }).join("");

        return '' +
            '<div class="gh-sb-header">' +
            '<a class="gh-sb-brand" href="admin-dashboard.html" aria-label="GasHub Admin home">' +
            '<img src="images/logo.png" alt="GasHub logo">' +
            '<span class="gh-sb-brand-text"><strong>GasHub</strong><span>ADMIN PANEL</span></span></a>' +
            '<button type="button" class="gh-sb-toggle" id="ghSidebarToggle" aria-label="Collapse sidebar">☰</button>' +
            '</div>' +
            '<nav class="gh-sb-nav" aria-label="Admin navigation">' + links + '</nav>' +
            '<div class="gh-sb-footer">' +
            '<div class="gh-sb-account" title="' + esc(name) + ' - ' + esc(role) + '">' +
            '<div class="gh-sb-user"><div class="gh-sb-avatar">' + esc(initials(name)) + '<i class="gh-sb-avatar-dot"></i></div>' +
            '<div class="gh-sb-user-meta"><span class="gh-sb-user-label">Signed in as</span><strong>' + esc(name) + '</strong><small class="gh-sb-role">' + esc(role) + '</small></div></div>' +
            '<div class="gh-sb-status"><span class="gh-sb-dot"></span><span>System Online</span></div></div>' +
            '<button type="button" class="gh-sb-logout" id="ghLogoutButton" title="Log out">' +
            '<span aria-hidden="true">↪</span><span class="gh-sb-logout-label">Log out</span></button>' +
            '</div>';
    }

    async function logout(btn) {
        if (!(await GasHubDialog.confirm({ title: "Log out?", message: "You will need to sign in again to use the admin panel.", confirmText: "Log out", tone: "primary", icon: "logout" }))) return;
        if (btn) { btn.disabled = true; }
        var token = getToken();
        try {
            // Server must receive the Bearer token to end the session and clear the cookie.
            await fetch("/api/admin/logout", {
                method: "POST",
                credentials: "include",
                headers: Object.assign({ "Content-Type": "application/json" },
                    token ? { Authorization: "Bearer " + token } : {})
            });
        } catch (e) {
            console.warn("Logout request failed:", e);
        }
        clearSession();
        location.replace(LOGIN_PAGE);
    }

    function setOpen(open) {
        document.body.classList.toggle("gh-open", !!open);
    }

    async function loadOrdersBadge() {
        var badge = document.getElementById("ordersBadge");
        if (!badge) return;
        var token = getToken();
        try {
            var r = await fetch("/api/admin/orders", {
                credentials: "include",
                headers: token ? { Authorization: "Bearer " + token } : {}
            });
            if (!r.ok) return;
            var d = await r.json();
            var orders = Array.isArray(d) ? d : (d.orders || []);
            var pending = orders.filter(function (o) {
                var s = String(o.status || o.order_status || "").toLowerCase();
                return s === "pending" || s === "new";
            }).length;
            badge.textContent = pending;
            badge.style.display = pending ? "inline-flex" : "none";
        } catch (e) { /* badge is optional */ }
    }

    function mount() {
        // Remove every legacy sidebar/overlay so only one sidebar exists
        document.querySelectorAll("aside.admin-sidebar, aside.sidebar, #sidebarOverlay, .sidebar-overlay, .mobile-scrim, #sidebarMobileOverlay")
            .forEach(function (el) { if (el.id !== "ghSidebar") el.remove(); });

        var aside = document.getElementById("ghSidebar");
        if (!aside) {
            aside = document.createElement("aside");
            aside.id = "ghSidebar";
            document.body.insertBefore(aside, document.body.firstChild);
        }
        aside.className = "gh-sidebar";
        aside.setAttribute("aria-label", "Admin sidebar");
        aside.innerHTML = buildHtml();

        var overlay = document.createElement("div");
        overlay.className = "gh-sb-overlay";
        overlay.id = "ghSidebarOverlay";
        document.body.appendChild(overlay);

        document.body.classList.add("gh-has-sidebar");
        try {
            if (localStorage.getItem(COLLAPSE_KEY) === "true" && window.innerWidth > 900) {
                document.body.classList.add("gh-collapsed");
            }
        } catch (e) { }

        document.getElementById("ghSidebarToggle").addEventListener("click", function () {
            var c = document.body.classList.toggle("gh-collapsed");
            try { localStorage.setItem(COLLAPSE_KEY, c ? "true" : "false"); } catch (e) { }
        });
        document.getElementById("ghLogoutButton").addEventListener("click", function () { logout(this); });
        overlay.addEventListener("click", function () { setOpen(false); });
        aside.querySelectorAll(".gh-sb-link").forEach(function (a) {
            a.addEventListener("click", function () { setOpen(false); });
        });
        // Each page has its own hamburger button; wire them all to the shared sidebar
        document.addEventListener("click", function (e) {
            if (e.target.closest("#mobileMenuButton, .mobile-menu, .mobile-menu-button")) {
                setOpen(!document.body.classList.contains("gh-open"));
            }
        });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });

        loadOrdersBadge();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
    else mount();
})();
