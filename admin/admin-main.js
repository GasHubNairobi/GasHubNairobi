/* =========================================================
GASHUB ADMIN PANEL
MAIN ADMIN JAVASCRIPT
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    initializeSidebar();
    initializeMobileMenu();
    initializeLogout();
    loadAdminInformation();
    setActiveNavigation();
});

/* =========================================================
SIDEBAR
========================================================= */

function initializeSidebar() {
    const sidebarToggle =
        document.getElementById("sidebarToggle");

    if (!sidebarToggle) {
        return;
    }

    sidebarToggle.addEventListener("click", () => {
        document.body.classList.toggle(
            "sidebar-collapsed"
        );

        const collapsed =
            document.body.classList.contains(
                "sidebar-collapsed"
            );

        localStorage.setItem(
            "gashub_admin_sidebar_collapsed",
            collapsed ? "true" : "false"
        );
    });

    const savedState =
        localStorage.getItem(
            "gashub_admin_sidebar_collapsed"
        );

    if (
        savedState === "true" &&
        window.innerWidth > 768
    ) {
        document.body.classList.add(
            "sidebar-collapsed"
        );
    }

    window.addEventListener("resize", () => {
        if (window.innerWidth <= 768) {
            document.body.classList.remove(
                "sidebar-collapsed"
            );
        }
    });
}

/* =========================================================
MOBILE MENU
========================================================= */

function initializeMobileMenu() {
    const mobileMenuButton =
        document.getElementById(
            "mobileMenuButton"
        );

    if (!mobileMenuButton) {
        return;
    }

    mobileMenuButton.addEventListener("click", () => {
        document.body.classList.toggle(
            "sidebar-open"
        );
    });

    document.addEventListener("click", (event) => {
        const sidebar =
            document.getElementById(
                "adminSidebar"
            );

        if (!sidebar) {
            return;
        }

        if (
            !document.body.classList.contains(
                "sidebar-open"
            )
        ) {
            return;
        }

        const clickedInsideSidebar =
            sidebar.contains(event.target);

        const clickedMenuButton =
            mobileMenuButton.contains(
                event.target
            );

        if (
            !clickedInsideSidebar &&
            !clickedMenuButton
        ) {
            closeMobileSidebar();
        }
    });

    document
        .querySelectorAll(
            ".admin-nav .nav-item"
        )
        .forEach((item) => {
            item.addEventListener("click", () => {
                if (window.innerWidth <= 768) {
                    closeMobileSidebar();
                }
            });
        });
}

function closeMobileSidebar() {
    document.body.classList.remove(
        "sidebar-open"
    );
}

/* =========================================================
LOGOUT
========================================================= */

function initializeLogout() {
    const logoutButton =
        document.getElementById(
            "logoutButton"
        );

    if (!logoutButton) {
        return;
    }

    logoutButton.addEventListener(
        "click",
        async () => {
            const confirmed =
                await GasHubDialog.confirm({
                    title: "Log out?",
                    message: "You will need to sign in again to use the admin panel.",
                    confirmText: "Log out", tone: "primary", icon: "logout"
                });

            if (!confirmed) {
                return;
            }

            try {
                const response =
                    await fetch(
                        "/api/admin/logout",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type":
                                    "application/json"
                            },
                            credentials:
                                "include"
                        }
                    );

                if (response.ok) {
                    clearAdminSession();

                    window.location.href =
                        "admin-login.html";

                    return;
                }

                clearAdminSession();

                window.location.href =
                    "admin-login.html";

            } catch (error) {
                console.error(
                    "Logout error:",
                    error
                );

                clearAdminSession();

                window.location.href =
                    "admin-login.html";
            }
        }
    );
}

function clearAdminSession() {
    localStorage.removeItem(
        "gashub_admin"
    );

    sessionStorage.removeItem(
        "gashub_admin"
    );

    localStorage.removeItem(
        "gashub_admin_token"
    );

    sessionStorage.removeItem(
        "gashub_admin_token"
    );
}

/* =========================================================
ADMIN INFORMATION
========================================================= */

function loadAdminInformation() {
    let admin = null;

    try {
        const storedAdmin =
            localStorage.getItem(
                "gashub_admin"
            ) ||
            sessionStorage.getItem(
                "gashub_admin"
            );

        if (storedAdmin) {
            admin = JSON.parse(
                storedAdmin
            );
        }
    } catch (error) {
        console.warn(
            "Could not read admin information:",
            error
        );
    }

    if (!admin) {
        return;
    }

    const adminNameElement =
        document.getElementById(
            "adminName"
        );

    const adminAvatarElement =
        document.getElementById(
            "adminAvatar"
        );

    const name =
        admin.name ||
        admin.full_name ||
        admin.username ||
        admin.email ||
        "Administrator";

    if (adminNameElement) {
        adminNameElement.textContent =
            name;
    }

    if (adminAvatarElement) {
        adminAvatarElement.textContent =
            getInitials(name);
    }
}

/* =========================================================
ADMIN INITIALS
========================================================= */

function getInitials(name) {
    if (!name) {
        return "A";
    }

    const words =
        name
            .trim()
            .split(/\s+/)
            .filter(Boolean);

    if (words.length === 1) {
        return words[0]
            .charAt(0)
            .toUpperCase();
    }

    return (
        words[0].charAt(0) +
        words[words.length - 1].charAt(0)
    ).toUpperCase();
}

/* =========================================================
ACTIVE NAVIGATION
========================================================= */

function setActiveNavigation() {
    const currentPage =
        window.location.pathname
            .split("/")
            .pop()
            .toLowerCase();

    const navigationItems =
        document.querySelectorAll(
            ".admin-nav .nav-item"
        );

    navigationItems.forEach((item) => {
        const href =
            item.getAttribute("href");

        if (!href) {
            return;
        }

        const targetPage =
            href
                .split("/")
                .pop()
                .toLowerCase();

        item.classList.remove("active");

        if (
            targetPage ===
            currentPage
        ) {
            item.classList.add("active");
        }
    });
}

/* =========================================================
ORDERS BADGE
========================================================= */

async function loadOrdersBadge() {
    const badge =
        document.getElementById(
            "ordersBadge"
        );

    if (!badge) {
        return;
    }

    try {
        /* the admin's own order list (needs the admin sign-in; the public /api/orders is now admin-only too) */
        const data = await adminApiRequest("/api/admin/orders");

        let orders = [];

        if (Array.isArray(data)) {
            orders = data;
        } else if (
            Array.isArray(data.orders)
        ) {
            orders = data.orders;
        }

        const pendingCount =
            orders.filter((order) => {
                const status =
                    String(
                        order.status ||
                        order.order_status ||
                        ""
                    ).toLowerCase();

                return (
                    status === "pending" ||
                    status === "new"
                );
            }).length;

        badge.textContent =
            pendingCount;

        if (pendingCount === 0) {
            badge.style.display =
                "none";
        } else {
            badge.style.display =
                "inline-flex";
        }

    } catch (error) {
        console.warn(
            "Could not load orders badge:",
            error
        );
    }
}

/* =========================================================
CURRENT DATE / TIME
========================================================= */

function formatAdminDate(
    date = new Date()
) {
    return date.toLocaleString(
        "en-KE",
        {
            dateStyle: "medium",
            timeStyle: "short"
        }
    );
}

/* =========================================================
GLOBAL API HELPER
========================================================= */

async function adminApiRequest(
    url,
    options = {}
) {
    const requestOptions = {
        ...options,
        credentials: "include",
        headers: {
            "Content-Type":
                "application/json",
            ...(options.headers || {})
        }
    };

    /*
     * The admin files pass JavaScript objects
     * through options.body.
     *
     * fetch() requires the body to be a JSON
     * string when Content-Type is application/json.
     */
    if (
        requestOptions.body !== undefined &&
        requestOptions.body !== null &&
        typeof requestOptions.body === "object"
    ) {
        requestOptions.body =
            JSON.stringify(
                requestOptions.body
            );
    }

    /*
     * Send the stored admin token when one exists.
     * This allows the backend to authenticate
     * protected admin requests.
     */
    const token =
        localStorage.getItem(
            "gashub_admin_token"
        ) ||
        sessionStorage.getItem(
            "gashub_admin_token"
        );

    if (token) {
        requestOptions.headers.Authorization =
            `Bearer ${token}`;
    }

    const response =
        await fetch(
            url,
            requestOptions
        );

    let data = null;

    try {
        data =
            await response.json();
    } catch {
        data = null;
    }

    if (!response.ok) {
        const message =
            data?.message ||
            data?.error ||
            `Request failed with status ${response.status}`;

        const failure = new Error(message);
        failure.status = response.status;
        failure.code = data?.code;
        failure.data = data;
        throw failure;
    }

    return data;
}

/* =========================================================
GLOBAL HELPERS
========================================================= */

function escapeHtml(value) {
    if (
        value === null ||
        value === undefined
    ) {
        return "";
    }

    return String(value)
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}

function showAdminMessage(
    message,
    type = "success"
) {
    const existing =
        document.querySelector(
            ".admin-message"
        );

    if (existing) {
        existing.remove();
    }

    const messageElement =
        document.createElement(
            "div"
        );

    messageElement.className =
        `admin-message admin-message-${type}`;

    messageElement.textContent =
        message;

    document.body.appendChild(
        messageElement
    );

    setTimeout(() => {
        messageElement.classList.add(
            "hide"
        );

        setTimeout(() => {
            messageElement.remove();
        }, 300);

    }, 3000);
}

/* =========================================================
INITIALIZE ORDER BADGE
========================================================= */

loadOrdersBadge();

/* =========================================================
EXPORT SHARED FUNCTIONS
========================================================= */

window.GasHubAdmin = {
    adminApiRequest,
    escapeHtml,
    showAdminMessage,
    formatAdminDate,
    getInitials,
    loadOrdersBadge,
    closeMobileSidebar
};