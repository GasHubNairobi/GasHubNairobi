
/* =========================================================
   GAS HUB
   DEALER AUTHENTICATION
   Login + Registration
   ========================================================= */

/* true when running as the installed app (not a normal browser tab): the server then keeps the dealer signed in until they log out */
function isApp() {
    try { if (/^android-app:\/\//.test(document.referrer || "")) return true; } catch (e) { }
    try { return window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: fullscreen)").matches || window.matchMedia("(display-mode: minimal-ui)").matches; }
    catch (e) { return false; }
}

document.addEventListener("DOMContentLoaded", () => {

    /* =====================================================
       SHARED ELEMENTS
       ===================================================== */

    const currentYear = document.getElementById("currentYear");

    if (currentYear) {
        currentYear.textContent = new Date().getFullYear();
    }


    /* =====================================================
       PASSWORD TOGGLE
       ===================================================== */

    function setupPasswordToggle(buttonId, inputId) {

        const button = document.getElementById(buttonId);
        const input = document.getElementById(inputId);

        if (!button || !input) {
            return;
        }

        button.addEventListener("click", () => {

            const showingPassword =
                input.type === "text";

            input.type =
                showingPassword
                    ? "password"
                    : "text";

            const icon = button.querySelector("i");

            if (icon) {

                icon.classList.toggle(
                    "fa-eye",
                    showingPassword
                );

                icon.classList.toggle(
                    "fa-eye-slash",
                    !showingPassword
                );
            }

            button.setAttribute(
                "aria-label",
                showingPassword
                    ? "Show password"
                    : "Hide password"
            );
        });
    }


    setupPasswordToggle(
        "passwordToggle",
        "loginPassword"
    );

    setupPasswordToggle(
        "registerPasswordToggle",
        "registerPassword"
    );

    setupPasswordToggle(
        "confirmPasswordToggle",
        "confirmPassword"
    );


    /* =====================================================
       MESSAGE HELPERS
       ===================================================== */

    function showMessage(element, message, type = "error") {

        if (!element) {
            return;
        }

        element.textContent = message;

        element.className =
            `auth-message ${type}`;
    }


    function clearMessage(element) {

        if (!element) {
            return;
        }

        element.textContent = "";

        element.className = "auth-message";
    }


    /* =====================================================
       BUTTON LOADING
       ===================================================== */

    function setButtonLoading(button, loading) {

        if (!button) {
            return;
        }

        button.disabled = loading;

        button.classList.toggle(
            "loading",
            loading
        );
    }


    /* =====================================================
       INPUT ERROR HELPERS
       ===================================================== */

    function clearInputErrors(form) {

        if (!form) {
            return;
        }

        const inputs =
            form.querySelectorAll(
                "input, select"
            );

        inputs.forEach(input => {
            input.classList.remove("input-error");
        });
    }


    function markInputError(input) {

        if (!input) {
            return;
        }

        input.classList.add("input-error");

        input.focus();
    }


    /* =====================================================
       LOGIN
       ===================================================== */

    const loginForm =
        document.getElementById("dealerLoginForm");

    if (loginForm) {

        const loginIdentifier =
            document.getElementById(
                "loginIdentifier"
            );

        // Start each visit with a blank identifier. Browsers may still offer
        // their own saved autofill suggestions, which are controlled by the browser.
        if (loginIdentifier) {
            loginIdentifier.value = "";
            window.addEventListener("pageshow", () => {
                loginIdentifier.value = "";
            });
        }

        const loginPassword =
            document.getElementById(
                "loginPassword"
            );

        const rememberMe =
            document.getElementById(
                "rememberMe"
            );

        const loginButton =
            document.getElementById(
                "loginButton"
            );

        const loginMessage =
            document.getElementById(
                "loginMessage"
            );

        const forgotPassword =
            document.getElementById(
                "forgotPassword"
            );


        /* ================================================
           LOGIN SUBMIT
           ================================================ */

        loginForm.addEventListener(
            "submit",
            async event => {

                event.preventDefault();

                clearMessage(loginMessage);

                clearInputErrors(loginForm);


                const identifier =
                    loginIdentifier
                        ? loginIdentifier.value.trim()
                        : "";

                const password =
                    loginPassword
                        ? loginPassword.value
                        : "";

                const remember =
                    rememberMe
                        ? rememberMe.checked
                        : false;


                /* ==========================================
                   VALIDATION
                   ========================================== */

                if (!identifier) {

                    showMessage(
                        loginMessage,
                        "Please enter your email or phone number."
                    );

                    markInputError(
                        loginIdentifier
                    );

                    return;
                }


                if (!password) {

                    showMessage(
                        loginMessage,
                        "Please enter your password."
                    );

                    markInputError(
                        loginPassword
                    );

                    return;
                }


                if (password.length < 8) {

                    showMessage(
                        loginMessage,
                        "Your password must contain at least 8 characters."
                    );

                    markInputError(
                        loginPassword
                    );

                    return;
                }


                /* ==========================================
                   LOGIN LOADING
                   ========================================== */

                setButtonLoading(
                    loginButton,
                    true
                );


                try {

                    const response = await fetch("/api/dealers/login", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Accept: "application/json", "X-GasHub-App": isApp() ? "1" : "0" },
                        // Send a canonical identifier plus compatibility aliases for
                        // API versions that expect username/email/phone/dealer_code.
                        body: JSON.stringify({ identifier, username: identifier, user_code: identifier, email: identifier, phone: identifier, dealer_code: identifier, password })
                    });
                    const result = await response.json().catch(() => ({}));
                    if (!response.ok || result.success !== true || !result.token || !result.dealer) {
                        throw new Error(result.message || "Unable to sign in. Check your username and password.");
                    }

                    [localStorage, sessionStorage].forEach(store => {
                        ["gashub_dealer_token", "gashub_dealer_user", "gashub_dealer", "gashub_dealer_id", "gashub_dealer_code"].forEach(key => store.removeItem(key));
                    });
                    // Existing dealer modules read the authenticated token from localStorage.
                    // Keep the token there so every dealer page uses the same session.
                    localStorage.setItem("gashub_dealer_token", result.token);
                    localStorage.setItem("gashub_dealer_user", JSON.stringify(result.user || {}));
                    localStorage.setItem("gashub_dealer", JSON.stringify(result.dealer));
                    localStorage.setItem("gashub_dealer_id", String(result.dealer.id));
                    localStorage.setItem("gashub_dealer_code", String(result.dealer.dealer_code || ""));
                    localStorage.setItem("gashub_dealer_requires_setup", result.requires_setup ? "true" : "false");

                    if (result.requires_setup) {
                        showMessage(loginMessage, "Initial login accepted. Please complete your profile and set a new password.", "success");
                        window.location.replace("dealer-first-login.html");
                        return;
                    }
                    showMessage(loginMessage, `Welcome back, ${result.dealer.business_name}. Opening your dealer portal…`, "success");
                    window.location.replace("dealer-dashboard.html");

                } catch (error) {

                    console.error(
                        "Dealer login error:",
                        error
                    );

                    showMessage(
                        loginMessage,
                        error.message || "Unable to process your login. Please try again."
                    );

                } finally {

                    setButtonLoading(
                        loginButton,
                        false
                    );
                }

            }
        );


        /* ================================================
           FORGOT / RESET PASSWORD
           ================================================ */

        const $ = id => document.getElementById(id);
        const panelMessage = $("panelMessage");
        const panels = {
            signin: { el: $("panelSignin"), title: "Welcome back", sub: "Sign in to manage your dealer account.", focus: loginIdentifier },
            forgot: { el: $("panelForgot"), title: "Reset your password", sub: "Enter how you sign in and we'll email you a reset link.", focus: $("forgotIdentifier") },
            sent: { el: $("panelSent"), title: "Check your email", sub: "Open the link we sent to choose a new password." },
            reset: { el: $("panelReset"), title: "Choose a new password", sub: "Pick a password you don't use anywhere else.", focus: $("resetPassword") }
        };
        function showPanel(name, keepMessage) {
            Object.keys(panels).forEach(k => { panels[k].el.hidden = k !== name; });
            $("panelTitle").textContent = panels[name].title;
            $("panelSub").textContent = panels[name].sub;
            if (!keepMessage) clearMessage(panelMessage);
            if (name !== "signin") clearMessage(loginMessage);
            if (panels[name].focus) setTimeout(() => panels[name].focus.focus(), 50);
        }
        function say(text, type, action) {
            panelMessage.textContent = text;
            panelMessage.className = `auth-message ${type || "error"}`;
            if (action) {
                panelMessage.appendChild(document.createElement("br"));
                const b = document.createElement("button");
                b.type = "button"; b.className = "msg-action"; b.textContent = action.label;
                b.addEventListener("click", action.run);
                panelMessage.appendChild(b);
            }
        }
        async function post(url, body) {
            try {
                const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
                const data = await r.json().catch(() => ({}));
                return { ok: r.ok, status: r.status, data, retryAfter: Number(r.headers.get("Retry-After")) || 0 };
            } catch (e) { return { network: true, status: 0, data: {} }; }
        }

        document.querySelectorAll("[data-panel]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); showPanel(a.dataset.panel); }));
        document.querySelectorAll(".password-toggle[data-target]").forEach(btn => btn.addEventListener("click", () => {
            const input = $(btn.dataset.target), show = input.type === "password";
            input.type = show ? "text" : "password";
            btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
            const i = btn.querySelector("i"); if (i) { i.classList.toggle("fa-eye", !show); i.classList.toggle("fa-eye-slash", show); }
        }));

        /* "Send again" waits a minute so the inbox is not flooded */
        let cooldownTimer = null;
        function startCooldown(btn, seconds) {
            clearInterval(cooldownTimer);
            const label = btn.querySelector(".button-text"), text = label.textContent.replace(/ \(\d+s\)$/, "");
            let left = seconds; btn.disabled = true; label.textContent = `${text} (${left}s)`;
            cooldownTimer = setInterval(() => {
                left--;
                if (left <= 0) { clearInterval(cooldownTimer); btn.disabled = false; label.textContent = text; }
                else label.textContent = `${text} (${left}s)`;
            }, 1000);
        }

        let lastIdentifier = "";
        async function sendLink(button) {
            if (button.disabled) return;
            const identifier = lastIdentifier;
            if (!identifier) { say("Please enter your email, phone number, username or dealer code."); $("forgotIdentifier").focus(); return; }
            setButtonLoading(button, true);
            const res = await post("/api/dealers/forgot-password", { identifier });
            setButtonLoading(button, false);
            if (res.network) { say("We can't reach GasHub right now. Check your connection and try again."); return; }
            if (res.status === 429) { const s = res.retryAfter || 60; say(`Too many requests. Please wait ${s >= 60 ? Math.ceil(s / 60) + " minute(s)" : s + " seconds"} and try again.`); startCooldown(button, Math.min(s, 900)); return; }
            if (res.status === 503) { say("Password reset isn't available right now. Please contact GasHub support."); return; }
            if (!res.ok) { say(res.data.message || "Something went wrong on our side. Please try again in a moment."); return; }
            showPanel("sent");
            startCooldown($("resendButton"), 60);
        }
        $("forgotForm").addEventListener("submit", e => {
            e.preventDefault(); clearMessage(panelMessage);
            lastIdentifier = $("forgotIdentifier").value.trim();
            sendLink($("forgotButton"));
        });
        $("resendButton").addEventListener("click", () => sendLink($("resendButton")));

        if (forgotPassword) {
            forgotPassword.addEventListener("click", event => {
                event.preventDefault();
                $("forgotIdentifier").value = loginIdentifier ? loginIdentifier.value.trim() : "";
                showPanel("forgot");
            });
        }

        /* ---- new password (the link from the email: dealer-login.html?reset=TOKEN) ---- */
        const strengthOf = pw => {
            let n = 0;
            if (pw.length >= 8) n++;
            if (pw.length >= 12 || (/[a-z]/.test(pw) && /[A-Z]/.test(pw))) n++;
            if ((/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) || pw.length >= 14) n++;
            return pw.length < 8 ? Math.min(n, 1) : Math.max(n, 1);
        };
        $("resetPassword").addEventListener("input", () => {
            const pw = $("resetPassword").value, lvl = pw ? strengthOf(pw) : 0;
            $("strength").dataset.level = String(lvl);
            $("strengthText").textContent = !pw ? "" : pw.length < 8 ? "Too short" : ["", "Weak", "Okay", "Strong"][lvl];
        });

        let resetToken = new URLSearchParams(location.search).get("reset");
        if (resetToken) history.replaceState(null, "", location.pathname);   /* keep the secret token out of the address bar and history */
        const askNewLink = { label: "Get a new link", run: () => showPanel("forgot") };

        $("resetForm").addEventListener("submit", async e => {
            e.preventDefault(); clearMessage(panelMessage);
            const pw = $("resetPassword").value, cf = $("resetConfirm").value, button = $("resetButton");
            if (button.disabled) return;
            if (pw.length < 8) { say("Your new password must be at least 8 characters."); $("resetPassword").focus(); return; }
            if (pw.length > 128) { say("That password is too long."); return; }
            if (pw !== cf) { say("The two passwords don't match."); $("resetConfirm").focus(); return; }
            if (!resetToken) { say("This reset link isn't valid. Please ask for a new one.", "error", askNewLink); return; }
            setButtonLoading(button, true);
            const res = await post("/api/dealers/reset-password", { token: resetToken, password: pw });
            setButtonLoading(button, false);
            if (res.ok) {
                resetToken = null; $("resetPassword").value = ""; $("resetConfirm").value = "";
                showPanel("signin");
                say("Your password has been changed. Sign in with your new password.", "success");
                return;
            }
            if (res.network) { say("We can't reach GasHub right now. Please try again."); return; }
            if (res.status === 400) { say(res.data.message || "Please choose a different password."); return; }
            if (res.status === 410) { say("This link has expired or was already used.", "error", askNewLink); return; }
            if (res.status === 429) { say("Too many attempts. Please wait a few minutes and try again."); return; }
            say("Something went wrong on our side. Please try again in a moment.");
        });

        /* opened from the email: check the link first so an expired one is explained straight away */
        if (resetToken) {
            showPanel("reset", true);
            post("/api/dealers/reset-password/check", { token: resetToken }).then(res => {
                if (res.status === 410) { showPanel("forgot", true); say("This reset link has expired or was already used. Enter your details to get a new one.", "error"); }
            });
        }


        /* ================================================
           CLEAR LOGIN MESSAGE
           ================================================ */

        if (loginIdentifier) {

            loginIdentifier.addEventListener(
                "input",
                () => {

                    loginIdentifier.classList.remove(
                        "input-error"
                    );

                    clearMessage(loginMessage);
                }
            );
        }


        if (loginPassword) {

            loginPassword.addEventListener(
                "input",
                () => {

                    loginPassword.classList.remove(
                        "input-error"
                    );

                    clearMessage(loginMessage);
                }
            );
        }

    }


    /* =====================================================
       DEALER REGISTRATION
       ===================================================== */

    const registerForm =
        document.getElementById(
            "dealerRegisterForm"
        );

    if (registerForm) {

        const businessName =
            document.getElementById(
                "businessName"
            );

        const businessType =
            document.getElementById(
                "businessType"
            );

        const businessLocation =
            document.getElementById(
                "businessLocation"
            );

        const contactName =
            document.getElementById(
                "contactName"
            );

        const phoneNumber =
            document.getElementById(
                "phoneNumber"
            );

        const emailAddress =
            document.getElementById(
                "emailAddress"
            );

        const registerPassword =
            document.getElementById(
                "registerPassword"
            );

        const confirmPassword =
            document.getElementById(
                "confirmPassword"
            );

        const agreeTerms =
            document.getElementById(
                "agreeTerms"
            );

        const registerButton =
            document.getElementById(
                "registerButton"
            );

        const registerMessage =
            document.getElementById(
                "registerMessage"
            );


        /* ================================================
           VALIDATE EMAIL
           ================================================ */

        function isValidEmail(email) {

            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
                .test(email);
        }


        /* ================================================
           VALIDATE PHONE
           ================================================ */

        function isValidPhone(phone) {

            const cleaned =
                phone.replace(/[\s\-()]/g, "");

            return /^(\+254|0)[17]\d{8}$/
                .test(cleaned);
        }


        /* ================================================
           VALIDATE REGISTRATION
           ================================================ */

        function validateRegistration() {

            clearInputErrors(registerForm);

            clearMessage(registerMessage);


            /* ---------------------------------------------
               Business name
               --------------------------------------------- */

            if (!businessName.value.trim()) {

                showMessage(
                    registerMessage,
                    "Please enter your business name."
                );

                markInputError(
                    businessName
                );

                return false;
            }


            /* ---------------------------------------------
               Business type
               --------------------------------------------- */

            if (!businessType.value) {

                showMessage(
                    registerMessage,
                    "Please select your business type."
                );

                markInputError(
                    businessType
                );

                return false;
            }


            /* ---------------------------------------------
               Location
               --------------------------------------------- */

            if (!businessLocation.value.trim()) {

                showMessage(
                    registerMessage,
                    "Please enter your business location."
                );

                markInputError(
                    businessLocation
                );

                return false;
            }


            /* ---------------------------------------------
               Contact name
               --------------------------------------------- */

            if (!contactName.value.trim()) {

                showMessage(
                    registerMessage,
                    "Please enter the contact person's name."
                );

                markInputError(
                    contactName
                );

                return false;
            }


            /* ---------------------------------------------
               Phone
               --------------------------------------------- */

            const phone =
                phoneNumber.value.trim();

            if (!phone) {

                showMessage(
                    registerMessage,
                    "Please enter a phone number."
                );

                markInputError(
                    phoneNumber
                );

                return false;
            }


            if (!isValidPhone(phone)) {

                showMessage(
                    registerMessage,
                    "Please enter a valid Kenyan phone number."
                );

                markInputError(
                    phoneNumber
                );

                return false;
            }


            /* ---------------------------------------------
               Email
               --------------------------------------------- */

            const email =
                emailAddress.value.trim();

            if (!email) {

                showMessage(
                    registerMessage,
                    "Please enter your email address."
                );

                markInputError(
                    emailAddress
                );

                return false;
            }


            if (!isValidEmail(email)) {

                showMessage(
                    registerMessage,
                    "Please enter a valid email address."
                );

                markInputError(
                    emailAddress
                );

                return false;
            }


            /* ---------------------------------------------
               Password
               --------------------------------------------- */

            const password =
                registerPassword.value;

            if (!password) {

                showMessage(
                    registerMessage,
                    "Please create a password."
                );

                markInputError(
                    registerPassword
                );

                return false;
            }


            if (password.length < 8) {

                showMessage(
                    registerMessage,
                    "Your password must contain at least 8 characters."
                );

                markInputError(
                    registerPassword
                );

                return false;
            }


            /* ---------------------------------------------
               Confirm password
               --------------------------------------------- */

            if (!confirmPassword.value) {

                showMessage(
                    registerMessage,
                    "Please confirm your password."
                );

                markInputError(
                    confirmPassword
                );

                return false;
            }


            if (
                password !==
                confirmPassword.value
            ) {

                showMessage(
                    registerMessage,
                    "The passwords do not match."
                );

                markInputError(
                    confirmPassword
                );

                return false;
            }


            /* ---------------------------------------------
               Terms
               --------------------------------------------- */

            if (!agreeTerms.checked) {

                showMessage(
                    registerMessage,
                    "Please agree to the dealer terms and conditions."
                );

                agreeTerms.focus();

                return false;
            }


            return true;
        }


        /* ================================================
           REGISTRATION SUBMIT
           ================================================ */

        registerForm.addEventListener(
            "submit",
            async event => {

                event.preventDefault();


                if (!validateRegistration()) {
                    return;
                }


                const registrationData = {

                    businessName:
                        businessName.value.trim(),

                    businessType:
                        businessType.value,

                    businessLocation:
                        businessLocation.value.trim(),

                    contactName:
                        contactName.value.trim(),

                    phone:
                        phoneNumber.value.trim(),

                    email:
                        emailAddress.value.trim()

                };


                setButtonLoading(
                    registerButton,
                    true
                );


                try {

                    /*
                     * Backend dealer registration will be
                     * connected here after we establish the
                     * actual dealer database/API structure.
                     *
                     * Password is intentionally NOT logged.
                     */

                    await new Promise(resolve => {
                        setTimeout(resolve, 700);
                    });


                    console.log(
                        "Dealer registration form validated.",
                        registrationData
                    );


                    showMessage(
                        registerMessage,
                        "Your registration details are valid. Backend registration will be connected next.",
                        "success"
                    );


                } catch (error) {

                    console.error(
                        "Dealer registration error:",
                        error
                    );

                    showMessage(
                        registerMessage,
                        "Unable to process your registration. Please try again."
                    );

                } finally {

                    setButtonLoading(
                        registerButton,
                        false
                    );
                }

            }
        );


        /* ================================================
           LIVE INPUT CLEANUP
           ================================================ */

        const registrationInputs =
            registerForm.querySelectorAll(
                "input, select"
            );

        registrationInputs.forEach(input => {

            input.addEventListener(
                "input",
                () => {

                    input.classList.remove(
                        "input-error"
                    );

                    clearMessage(
                        registerMessage
                    );
                }
            );

            input.addEventListener(
                "change",
                () => {

                    input.classList.remove(
                        "input-error"
                    );

                    clearMessage(
                        registerMessage
                    );
                }
            );

        });


        /* ================================================
           PASSWORD MATCH CHECK
           ================================================ */

        if (confirmPassword) {

            confirmPassword.addEventListener(
                "input",
                () => {

                    if (
                        registerPassword.value &&
                        confirmPassword.value &&
                        registerPassword.value !==
                        confirmPassword.value
                    ) {

                        confirmPassword.classList.add(
                            "input-error"
                        );

                    } else {

                        confirmPassword.classList.remove(
                            "input-error"
                        );
                    }
                }
            );
        }

    }

});
