/* =========================================================
   GASHUB ADMIN AUTHENTICATION
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    initializeAdminLogin();
});

/* =========================================================
   INITIALIZE LOGIN
========================================================= */

function initializeAdminLogin() {
    const loginForm = document.getElementById("adminLoginForm");
    const passwordInput = document.getElementById("password");
    const togglePassword = document.getElementById("togglePassword");

    if (!loginForm) {
        return;
    }

    /* -----------------------------------------------------
       SHOW / HIDE PASSWORD
    ----------------------------------------------------- */

    if (togglePassword && passwordInput) {
        togglePassword.addEventListener("click", () => {
            const isPassword = passwordInput.type === "password";

            passwordInput.type = isPassword
                ? "text"
                : "password";

            togglePassword.textContent = isPassword
                ? "Hide"
                : "Show";

            togglePassword.setAttribute(
                "aria-label",
                isPassword
                    ? "Hide password"
                    : "Show password"
            );
        });
    }

    /* -----------------------------------------------------
       LOGIN FORM
    ----------------------------------------------------- */

    loginForm.addEventListener("submit", handleAdminLogin);
}

/* =========================================================
   HANDLE ADMIN LOGIN
========================================================= */

async function handleAdminLogin(event) {
    event.preventDefault();

    const usernameInput = document.getElementById("username");
    const passwordInput = document.getElementById("password");
    const loginButton = document.getElementById("loginButton");
    const loginButtonText = document.getElementById("loginButtonText");

    if (!usernameInput || !passwordInput) {
        return;
    }

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    clearLoginMessage();

    /* -----------------------------------------------------
       BASIC VALIDATION
    ----------------------------------------------------- */

    if (!username) {
        showLoginMessage(
            "Please enter your username or email.",
            "error"
        );

        usernameInput.focus();
        return;
    }

    if (!password) {
        showLoginMessage(
            "Please enter your password.",
            "error"
        );

        passwordInput.focus();
        return;
    }

    /* -----------------------------------------------------
       LOADING STATE
    ----------------------------------------------------- */

    setLoginLoading(true);

    try {
        /*
         * The actual admin login endpoint will be created
         * in the new server.js.
         *
         * We intentionally do not hardcode credentials here.
         */

        const response = await fetch("/api/admin/login", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                username,
                password
            })
        });

        let data = {};

        try {
            data = await response.json();
        } catch (_) {
            data = {};
        }

        if (!response.ok || !data.success) {
            throw new Error(
                data.message ||
                "Invalid username or password."
            );
        }

        /* -------------------------------------------------
           STORE AUTHENTICATED ADMIN INFORMATION
        ------------------------------------------------- */

        if (data.admin) {
            localStorage.setItem(
                "gashub_admin",
                JSON.stringify(data.admin)
            );
        }

        /*
         * If the new backend provides a token, keep it.
         * This does not require us to decide the final
         * authentication method yet.
         */

        if (data.token) {
            localStorage.setItem(
                "gashub_admin_token",
                data.token
            );
        }

        if (data.accessToken) {
            localStorage.setItem(
                "gashub_admin_token",
                data.accessToken
            );
        }

        /* -------------------------------------------------
           SUCCESS
        ------------------------------------------------- */

        showLoginMessage(
            data.message || "Login successful.",
            "success"
        );

        if (loginButtonText) {
            loginButtonText.textContent = "Login Successful";
        }

        /*
         * Give the success message a moment to appear before
         * moving to the dashboard.
         */

        setTimeout(() => {
            window.location.href = "admin-dashboard.html";
        }, 500);

    } catch (error) {
        console.error("Admin login error:", error);

        showLoginMessage(
            error.message ||
            "Unable to complete login. Please try again.",
            "error"
        );

        setLoginLoading(false);
    }
}

/* =========================================================
   LOGIN LOADING STATE
========================================================= */

function setLoginLoading(isLoading) {
    const loginButton = document.getElementById("loginButton");
    const loginButtonText = document.getElementById("loginButtonText");

    if (!loginButton) {
        return;
    }

    loginButton.disabled = isLoading;

    if (isLoading) {
        loginButton.classList.add("loading");

        if (loginButtonText) {
            loginButtonText.textContent = "Signing in...";
        }
    } else {
        loginButton.classList.remove("loading");

        if (loginButtonText) {
            loginButtonText.textContent = "Sign In";
        }
    }
}

/* =========================================================
   SHOW LOGIN MESSAGE
========================================================= */

function showLoginMessage(message, type = "error") {
    const messageElement =
        document.getElementById("loginMessage");

    if (!messageElement) {
        return;
    }

    messageElement.textContent = message;

    messageElement.classList.remove(
        "show",
        "error",
        "success"
    );

    messageElement.classList.add(
        "show",
        type === "success"
            ? "success"
            : "error"
    );
}

/* =========================================================
   CLEAR LOGIN MESSAGE
========================================================= */

function clearLoginMessage() {
    const messageElement =
        document.getElementById("loginMessage");

    if (!messageElement) {
        return;
    }

    messageElement.textContent = "";

    messageElement.classList.remove(
        "show",
        "error",
        "success"
    );
}

/* =========================================================
   ENTER KEY SUPPORT
========================================================= */

document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
        return;
    }

    const activeElement = document.activeElement;

    if (
        activeElement &&
        (
            activeElement.id === "username" ||
            activeElement.id === "password"
        )
    ) {
        const form = document.getElementById("adminLoginForm");

        if (form) {
            /*
             * The browser normally submits the form itself.
             * This simply ensures the form exists.
             */
            return;
        }
    }
});