
/* =========================================================
   GAS HUB
   DEALER APPLICATION SHELL
   dealer-main.js
   ========================================================= */

document.addEventListener("DOMContentLoaded", () => {

    /* =====================================================
       ELEMENTS
       ===================================================== */

    const sidebar =
        document.querySelector(".dealer-sidebar");

    const mobileMenuButton =
        document.querySelector(".dealer-mobile-menu");

    const sidebarOverlay =
        document.querySelector(".dealer-sidebar-overlay");


    /* =====================================================
       MOBILE SIDEBAR
       ===================================================== */

    function openSidebar() {

        if (!sidebar) {
            return;
        }

        sidebar.classList.add("mobile-open");

        if (sidebarOverlay) {
            sidebarOverlay.classList.add("visible");
        }

        document.body.style.overflow = "hidden";

        if (mobileMenuButton) {
            mobileMenuButton.setAttribute(
                "aria-expanded",
                "true"
            );
        }
    }


    function closeSidebar() {

        if (!sidebar) {
            return;
        }

        sidebar.classList.remove("mobile-open");

        if (sidebarOverlay) {
            sidebarOverlay.classList.remove("visible");
        }

        document.body.style.overflow = "";

        if (mobileMenuButton) {
            mobileMenuButton.setAttribute(
                "aria-expanded",
                "false"
            );
        }
    }


    if (mobileMenuButton) {

        mobileMenuButton.addEventListener(
            "click",
            () => {

                const isOpen =
                    sidebar &&
                    sidebar.classList.contains(
                        "mobile-open"
                    );

                if (isOpen) {
                    closeSidebar();
                } else {
                    openSidebar();
                }

            }
        );

    }


    if (sidebarOverlay) {

        sidebarOverlay.addEventListener(
            "click",
            closeSidebar
        );

    }


    /* =====================================================
       CLOSE MOBILE SIDEBAR WHEN NAVIGATION IS SELECTED
       ===================================================== */

    if (sidebar) {

        const navigationLinks =
            sidebar.querySelectorAll(
                ".dealer-nav-item a"
            );

        navigationLinks.forEach(link => {

            link.addEventListener(
                "click",
                () => {

                    if (
                        window.innerWidth <= 768
                    ) {
                        closeSidebar();
                    }

                }
            );

        });

    }


    /* =====================================================
       ACTIVE NAVIGATION
       ===================================================== */

    function setActiveNavigation() {

        const currentPage =
            window.location.pathname
                .split("/")
                .pop()
                .toLowerCase();

        if (!currentPage) {
            return;
        }


        const navigationLinks =
            document.querySelectorAll(
                ".dealer-nav-item a"
            );


        navigationLinks.forEach(link => {

            const href =
                link.getAttribute("href");

            if (!href) {
                return;
            }


            const targetPage =
                href
                    .split("/")
                    .pop()
                    .split("?")[0]
                    .toLowerCase();


            link.parentElement.classList.toggle(
                "active",
                targetPage === currentPage
            );

        });

    }


    setActiveNavigation();


    /* =====================================================
       MOBILE NAVIGATION
       ===================================================== */

    function setMobileNavigation() {

        const currentPage =
            window.location.pathname
                .split("/")
                .pop()
                .toLowerCase();

        if (!currentPage) {
            return;
        }


        const mobileLinks =
            document.querySelectorAll(
                ".dealer-mobile-nav a"
            );


        mobileLinks.forEach(link => {

            const href =
                link.getAttribute("href");

            if (!href) {
                return;
            }


            const targetPage =
                href
                    .split("/")
                    .pop()
                    .split("?")[0]
                    .toLowerCase();


            link.classList.toggle(
                "active",
                targetPage === currentPage
            );

        });

    }


    setMobileNavigation();


    /* =====================================================
       WINDOW RESIZE
       ===================================================== */

    window.addEventListener(
        "resize",
        () => {

            if (
                window.innerWidth > 768
            ) {
                closeSidebar();
            }

        }
    );


    /* =====================================================
       ESCAPE KEY
       ===================================================== */

    document.addEventListener(
        "keydown",
        event => {

            if (
                event.key === "Escape"
            ) {
                closeSidebar();
            }

        }
    );


    /* =====================================================
       LOGOUT HANDLER
       ===================================================== */

    const logoutButtons =
        document.querySelectorAll(
            "[data-dealer-logout]"
        );


    logoutButtons.forEach(button => {
        button.addEventListener(
            "click",
            event => {
                event.preventDefault();
                try { if (window.GasHubDealerCache) window.GasHubDealerCache.wipe(); } catch (e) { }
                [localStorage, sessionStorage].forEach(store => {
                    ["gashub_dealer_token", "gashub_dealer_user", "gashub_dealer", "gashub_dealer_id", "gashub_dealer_code", "gashub_dealer_requires_setup"].forEach(k => store.removeItem(k));
                });
                window.location.replace("dealer-login.html");
            }
        );
    });


    /* =====================================================
       GLOBAL BUTTON LOADING
       ===================================================== */

    document.addEventListener(
        "click",
        event => {

            const button =
                event.target.closest(
                    "[data-loading-button]"
                );

            if (!button) {
                return;
            }

            if (
                button.disabled ||
                button.classList.contains("loading")
            ) {
                return;
            }

            button.classList.add("loading");

            button.disabled = true;

        }
    );


    /* =====================================================
       DEALER YEAR
       ===================================================== */

    const yearElements =
        document.querySelectorAll(
            "[data-current-year]"
        );


    yearElements.forEach(element => {

        element.textContent =
            new Date().getFullYear();

    });


});

