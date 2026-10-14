/* GasHub customer sign-in.

   The password is only ever sent to the GasHub server over HTTPS. It is never saved on the phone.
   The server decides who is signed in (ideally with an HttpOnly cookie). This page only keeps
   harmless display details such as the customer's name.

   The server routes this page expects are listed in gashub-auth-api.md. */
(function () {
    "use strict";

    const API = "/api";
    const DEFAULT_NEXT = "customer-home.html";
    const REMEMBERED_EMAIL = "gasHubRememberedEmail";
    const THROTTLE = "gasHubLoginThrottle";
    const NAMES = { google: "Google", facebook: "Facebook", x: "X" };

    /* personal data that belongs to one customer: cleared if a different customer signs in on this phone */
    const PERSONAL_KEYS = ["gasHubProfilePhoto", "gasHubPoints", "gasHubFavourites", "gasHubFavorites", "gasHubFavs", "favourites", "favorites",
        "gasHubFollowedDealers", "gasHubFollowing", "gasHubFollowedDealer", "followedDealers", "gasHubOrderHistory", "gasHubLastOrder",
        "gasHubViews", "gasHubPurchases", "gasHubDeletionRequest", "gasHubNotify"];

    const $ = id => document.getElementById(id);
    const msgBox = $("loginMessage"), loginForm = $("loginForm"), loginEmail = $("loginEmail"), loginPassword = $("loginPassword"),
        rememberMe = $("rememberMe"), loginButton = $("loginButton"), capsHint = $("capsHint"),
        forgotForm = $("forgotForm"), forgotEmail = $("forgotEmail"), forgotButton = $("forgotButton"),
        resetForm = $("resetForm"), resetPassword = $("resetPassword"), resetConfirm = $("resetConfirm"), resetButton = $("resetButton");

    /* ---------- small helpers ---------- */
    const readJSON = (area, k) => { try { return JSON.parse(area.getItem(k)); } catch (e) { return null; } };
    const writeJSON = (area, k, v) => { try { area.setItem(k, JSON.stringify(v)); } catch (e) { } };
    const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
    const fmtWait = s => s >= 60 ? Math.ceil(s / 60) + (Math.ceil(s / 60) === 1 ? " minute" : " minutes") : s + (s === 1 ? " second" : " seconds");

    /* only allow going to one of our own .html pages (stops "open redirect" tricks) */
    function safeNext(v) {
        v = String(v || "").trim();
        return v && !v.includes("..") && /^[A-Za-z0-9][A-Za-z0-9_\-\/]*\.html(\?[A-Za-z0-9_=&%.\-]*)?$/.test(v) ? v : DEFAULT_NEXT;
    }
    function cleanUrl(...names) {
        const u = new URL(location.href);
        names.forEach(n => u.searchParams.delete(n));
        history.replaceState(null, "", u.pathname + u.search + u.hash);
    }

    const params = new URLSearchParams(location.search);
    const next = safeNext(params.get("next"));
    let resetToken = params.get("reset");
    const verifyToken = params.get("verify");
    const authState = params.get("auth");
    const authError = params.get("auth_error");
    const authProvider = params.get("provider");
    const loggedOut = params.get("logged_out");
    /* tokens in the address bar can leak through history or screenshots, so remove them straight away */
    if (resetToken || verifyToken || authState || authError || authProvider) cleanUrl("reset", "verify", "auth", "auth_error", "provider");

    /* ---------- messages ---------- */
    function clearMessage() { msgBox.hidden = true; msgBox.textContent = ""; msgBox.className = "login-message"; }
    function showMessage(text, type, action) {
        msgBox.hidden = false;
        msgBox.className = "login-message" + (type === "success" ? " success" : type === "info" ? " info" : "");
        msgBox.textContent = "";                                    /* textContent only: never inject HTML */
        const s = document.createElement("span"); s.textContent = text; msgBox.appendChild(s);
        if (action) {
            const b = document.createElement("button");
            b.type = "button"; b.className = "msg-action"; b.textContent = action.label; b.addEventListener("click", action.run);
            msgBox.appendChild(b);
        }
    }

    /* ---------- panels: sign in / forgot / new password ---------- */
    const PANELS = {
        signin: { el: $("panelSignin"), title: "Sign in", sub: "Use your GasHub account to continue.", focus: loginEmail },
        forgot: { el: $("panelForgot"), title: "Reset your password", sub: "Enter your email and we'll send you a reset link.", focus: forgotEmail },
        reset: { el: $("panelReset"), title: "Choose a new password", sub: "Pick a password you don't use anywhere else.", focus: resetPassword }
    };
    function showPanel(name, keepMessage) {
        Object.keys(PANELS).forEach(k => { PANELS[k].el.hidden = k !== name; });
        $("panelTitle").textContent = PANELS[name].title;
        $("panelSub").textContent = PANELS[name].sub;
        if (!keepMessage) clearMessage();
        setTimeout(() => PANELS[name].focus && PANELS[name].focus.focus(), 60);
    }
    document.addEventListener("click", e => {
        const b = e.target.closest("[data-show]");
        if (b) showPanel(b.dataset.show);
    });
    $("forgotPassword").addEventListener("click", () => { forgotEmail.value = loginEmail.value.trim(); showPanel("forgot"); });

    /* ---------- show / hide password ---------- */
    document.querySelectorAll(".password-toggle").forEach(btn => btn.addEventListener("click", () => {
        const input = $(btn.dataset.target), show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.textContent = show ? "Hide" : "Show";
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
        btn.setAttribute("aria-pressed", String(show));
    }));
    loginPassword.addEventListener("keyup", e => { capsHint.hidden = !(e.getModifierState && e.getModifierState("CapsLock")); });
    loginPassword.addEventListener("blur", () => { capsHint.hidden = true; });
    [loginEmail, loginPassword].forEach(i => i.addEventListener("input", clearMessage));

    /* ---------- talking to the server ---------- */
    let csrf = "";
    const savedToken = () => localStorage.getItem("token") || sessionStorage.getItem("token") || "";
    async function api(path, opts) {
        opts = opts || {};
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
        const headers = { Accept: "application/json" };
        if (opts.body) headers["Content-Type"] = "application/json";
        if (csrf) headers["X-CSRF-Token"] = csrf;
        const tok = savedToken(); if (tok) headers.Authorization = "Bearer " + tok;
        try {
            const res = await fetch(API + path, {
                method: opts.method || "GET", headers, credentials: "same-origin", cache: "no-store", signal: ctl.signal,
                body: opts.body ? JSON.stringify(opts.body) : undefined
            });
            let data = {}; try { data = await res.json(); } catch (e) { }
            return { ok: res.ok, status: res.status, data: data || {}, retryAfter: parseInt(res.headers.get("Retry-After"), 10) || (data && data.retryAfter) || 0 };
        } catch (e) {
            return { ok: false, status: 0, data: {}, network: true };
        } finally { clearTimeout(timer); }
    }
    const csrfReady = api("/auth/csrf").then(r => { if (r.ok && r.data && r.data.csrfToken) csrf = r.data.csrfToken; });
    let providers = null;
    const providersReady = api("/auth/providers").then(r => {
        const d = r.ok && r.data ? (r.data.providers || r.data) : {};
        providers = d && typeof d === "object" ? d : {};
        Object.keys(NAMES).forEach(p => $(p + "Login").classList.toggle("is-off", !providers[p]));
    });

    /* ---------- keeping the sign-in on this phone ---------- */
    function completeLogin(c, token, remember, method) {
        c = c || {};
        const name = c.fullName || c.name || c.full_name || `${c.first_name || ""} ${c.last_name || ""}`.trim();
        const email = String(c.email || "").toLowerCase();

        const old = readJSON(localStorage, "gasHubCustomer") || {};
        const sameCustomer = !old.email || !email || String(old.email).toLowerCase() === email;
        if (!sameCustomer) PERSONAL_KEYS.forEach(k => localStorage.removeItem(k));   /* a different person is using this phone */

        const customer = {
            ...(sameCustomer ? old : {}),
            id: c.id ?? c.customer_id ?? old.id,
            fullName: name || (sameCustomer ? old.fullName : "") || "",
            name: name || (sameCustomer ? old.name : "") || "",
            email: email || (sameCustomer ? old.email : "") || "",
            phone: c.phone || c.phoneNumber || c.phone_number || (sameCustomer ? old.phone : "") || "",
            address: c.address || c.deliveryAddress || (sameCustomer ? old.address : "") || "",
            createdAt: c.createdAt || c.created_at || (sameCustomer ? old.createdAt : "") || ""
        };
        writeJSON(localStorage, "gasHubCustomer", customer);
        writeJSON(localStorage, "customer", customer);          /* the home page reads this for the greeting */
        writeJSON(localStorage, "gasHubCustomerProfile", { fullName: customer.fullName, phone: customer.phone, email: customer.email, address: customer.address });
        writeJSON(localStorage, "gasHubCustomerSession", { email: customer.email, method, loggedInAt: new Date().toISOString(), remember: !!remember });
        localStorage.setItem("gasHubLoggedIn", "true");
        if (c.photo && !localStorage.getItem("gasHubProfilePhoto") && !localStorage.getItem("gasHubPhotoRemoved")) writeJSON(localStorage, "gasHubProfilePhoto", c.photo);

        /* Only used if the server sends a token in the reply. A server cookie (HttpOnly) is safer; see gashub-auth-api.md. */
        localStorage.removeItem("token"); sessionStorage.removeItem("token");
        if (token) (remember ? localStorage : sessionStorage).setItem("token", token);
    }
    function clearStaleSignIn() {
        ["gasHubLoggedIn", "gasHubCustomerSession", "token", "authToken", "customerToken"].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
    }
    function goNext() { setTimeout(() => location.replace(next), 600); }

    /* ---------- loading + cooldown on buttons ---------- */
    let cooldownTimer = null;
    function setBusy(btn, busy, label) {
        if (busy) { btn.dataset.label = btn.textContent; btn.textContent = label; btn.disabled = true; }
        else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
    }
    function startCooldown(btn, seconds, onDone) {
        clearInterval(cooldownTimer);
        const label = btn.dataset.label || btn.textContent;
        btn.dataset.label = label; btn.disabled = true;
        let left = seconds;
        const tick = () => {
            if (left <= 0) { clearInterval(cooldownTimer); btn.textContent = label; btn.disabled = false; if (onDone) onDone(); return; }
            btn.textContent = `Try again in ${fmtWait(left)}`; left--;
        };
        tick(); cooldownTimer = setInterval(tick, 1000);
    }

    /* A short pause after repeated wrong passwords. This is only for the customer's benefit:
       the real limit has to be enforced by the server. */
    const throttleLeft = () => { const t = readJSON(sessionStorage, THROTTLE); return t && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 1000) : 0; };
    function recordFail() {
        const t = readJSON(sessionStorage, THROTTLE) || { fails: 0, until: 0 };
        t.fails++;
        if (t.fails >= 5) t.until = Date.now() + Math.min(300, 30 * Math.pow(2, t.fails - 5)) * 1000;
        writeJSON(sessionStorage, THROTTLE, t);
        return throttleLeft();
    }

    /* ================= SIGN IN WITH EMAIL ================= */
    loginForm.addEventListener("submit", async e => {
        e.preventDefault(); clearMessage();
        if (loginButton.disabled) return;

        const wait = throttleLeft();
        if (wait) { showMessage(`Too many attempts. Please wait ${fmtWait(wait)} and try again.`); startCooldown(loginButton, wait); return; }

        const email = loginEmail.value.trim().toLowerCase(), password = loginPassword.value;
        if (!email) { showMessage("Please enter your email address."); loginEmail.focus(); return; }
        if (!isEmail(email)) { showMessage("Please enter a valid email address."); loginEmail.focus(); return; }
        if (!password) { showMessage("Please enter your password."); loginPassword.focus(); return; }

        setBusy(loginButton, true, "Signing in...");
        await csrfReady;
        const res = await api("/auth/login", { method: "POST", body: { email, password, remember: rememberMe.checked } });
        setBusy(loginButton, false);

        if (res.ok && res.data && (res.data.customer || res.data.user)) {
            sessionStorage.removeItem(THROTTLE);
            if (rememberMe.checked) localStorage.setItem(REMEMBERED_EMAIL, email); else localStorage.removeItem(REMEMBERED_EMAIL);
            completeLogin(res.data.customer || res.data.user, res.data.token, rememberMe.checked, "email");
            loginPassword.value = "";
            showMessage("Signed in. Taking you in...", "success");
            goNext();
            return;
        }
        loginFailed(res, email);
    });

    function loginFailed(res, email) {
        const code = res.data && (res.data.code || res.data.error);
        if (res.network) { showMessage("We can't reach GasHub right now. Check your internet connection and try again."); return; }
        if (res.status === 404 || res.status === 501 || (res.ok && !res.data.customer && !res.data.user)) { showMessage("Sign-in isn't available right now. Please try again later."); return; }
        if (res.status === 429 || res.status === 423 || code === "too_many_attempts" || code === "account_locked") {
            const s = res.retryAfter || 60;
            showMessage(`Too many attempts. Please wait ${fmtWait(s)} and try again.`); startCooldown(loginButton, s); return;
        }
        if (res.status === 403 && code === "email_not_verified") {
            showMessage("Please verify your email first. We sent you a link when you signed up.", "info", { label: "Resend email", run: () => resendVerification(email) }); return;
        }
        if (res.status === 403 && code === "account_banned") { showMessage((res.data && res.data.message) || "This account has been banned. Please contact GasHub support."); return; }
        if (res.status === 403) { showMessage("This account can't sign in right now. Please contact GasHub support."); return; }
        if (res.status === 401 || code === "invalid_credentials") {
            const s = recordFail();
            showMessage("Incorrect email or password."); /* never say which one was wrong */
            if (s) startCooldown(loginButton, s);
            loginPassword.focus(); loginPassword.select(); return;
        }
        if (res.status === 400 || res.status === 422) { showMessage((res.data && res.data.message) || "Please check your details and try again."); return; }
        showMessage("Something went wrong on our side. Please try again in a moment.");
    }

    async function resendVerification(email) {
        const res = await api("/auth/resend-verification", { method: "POST", body: { email } });
        if (res.network) { showMessage("We can't reach GasHub right now. Please try again."); return; }
        showMessage("If that account still needs verifying, we've sent a new link. Check your inbox and spam folder.", "success");
    }

    /* ================= SIGN IN WITH GOOGLE / FACEBOOK / X ================= */
    Object.keys(NAMES).forEach(p => $(p + "Login").addEventListener("click", async () => {
        clearMessage();
        const btn = $(p + "Login");
        if (btn.disabled) return;
        await providersReady;
        if (!providers || !providers[p]) { showMessage(`${NAMES[p]} sign-in isn't available yet. Please use your email and password.`); return; }
        btn.disabled = true;                                        /* the server takes over from here (OAuth) */
        window.location.assign(`${API}/auth/${p}?next=${encodeURIComponent(next)}`);
    }));
    window.addEventListener("pageshow", e => { if (e.persisted) Object.keys(NAMES).forEach(p => { $(p + "Login").disabled = false; }); });

    const SOCIAL_ERRORS = {
        access_denied: "You cancelled the sign-in. You can try again any time.",
        account_exists: "An account with this email already exists. Sign in with your password, or the method you used before.",
        email_missing: "We couldn't get an email address from that account. Please use another sign-in method.",
        email_not_verified: "That account's email isn't verified yet. Verify it with the provider and try again.",
        provider_unavailable: "That sign-in option isn't available right now. Please use another method.",
        account_disabled: "This account can't sign in right now. Please contact GasHub support.",
        invalid_state: "The sign-in took too long or was interrupted. Please try again."
    };
    async function finishSocialLogin() {
        showMessage("Finishing sign-in...", "info");
        const res = await api("/auth/me");
        if (res.ok && res.data && (res.data.customer || res.data.user)) {
            completeLogin(res.data.customer || res.data.user, null, true, authProvider || "social");
            showMessage("Signed in. Taking you in...", "success"); goNext();
        } else showMessage("We couldn't finish signing you in. Please try again.");
    }

    /* ================= FORGOT PASSWORD ================= */
    forgotForm.addEventListener("submit", async e => {
        e.preventDefault(); clearMessage();
        if (forgotButton.disabled) return;
        const email = forgotEmail.value.trim().toLowerCase();
        if (!isEmail(email)) { showMessage("Please enter a valid email address."); forgotEmail.focus(); return; }
        setBusy(forgotButton, true, "Sending...");
        await csrfReady;
        const res = await api("/auth/forgot-password", { method: "POST", body: { email } });
        setBusy(forgotButton, false);
        if (res.network) { showMessage("We can't reach GasHub right now. Please try again."); return; }
        if (res.status === 404 || res.status === 501) { showMessage("Password reset isn't available right now. Please try again later."); return; }
        if (res.status === 429) { const s = res.retryAfter || 60; showMessage(`Please wait ${fmtWait(s)} before asking for another link.`); startCooldown(forgotButton, s); return; }
        if (res.status >= 500) { showMessage("Something went wrong on our side. Please try again in a moment."); return; }
        /* same answer whether or not the email has an account, so nobody can use this to find out who is registered */
        showMessage("If there is a GasHub account for that email, we've sent a link to reset the password. Check your inbox and spam folder.", "success");
        startCooldown(forgotButton, 60);
    });

    /* ================= NEW PASSWORD (link from the email) ================= */
    function strength(pw) {
        let s = 0;
        if (pw.length >= 8) s++;
        if (pw.length >= 12 || (/[a-z]/.test(pw) && /[A-Z]/.test(pw))) s++;
        if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw) || pw.length >= 14) s++;
        return pw.length < 8 ? Math.min(s, 1) : Math.max(s, 1);
    }
    resetPassword.addEventListener("input", () => {
        const pw = resetPassword.value, lvl = pw ? strength(pw) : 0;
        $("strength").dataset.level = String(lvl);
        $("strengthText").textContent = !pw ? "" : pw.length < 8 ? "Too short" : ["", "Weak", "Okay", "Strong"][lvl];
    });
    resetForm.addEventListener("submit", async e => {
        e.preventDefault(); clearMessage();
        if (resetButton.disabled) return;
        const pw = resetPassword.value, cf = resetConfirm.value;
        if (pw.length < 8) { showMessage("Your new password must be at least 8 characters."); resetPassword.focus(); return; }
        if (pw.length > 128) { showMessage("That password is too long."); return; }
        if (pw !== cf) { showMessage("The two passwords don't match."); resetConfirm.focus(); return; }
        if (!resetToken) { showMessage("This reset link isn't valid. Please ask for a new one.", "error", { label: "Get a new link", run: () => showPanel("forgot") }); return; }

        setBusy(resetButton, true, "Saving...");
        await csrfReady;
        const res = await api("/auth/reset-password", { method: "POST", body: { token: resetToken, password: pw } });
        setBusy(resetButton, false);

        if (res.ok) {
            resetToken = null; resetPassword.value = ""; resetConfirm.value = "";
            showPanel("signin");
            showMessage("Your password has been changed. Sign in with your new password.", "success");
            return;
        }
        if (res.network) { showMessage("We can't reach GasHub right now. Please try again."); return; }
        if (res.status === 400 || res.status === 410 || res.status === 404) {
            showMessage((res.data && res.data.code === "weak_password" && res.data.message) || "This link has expired or was already used. Please ask for a new one.", "error", { label: "Get a new link", run: () => showPanel("forgot") });
            return;
        }
        showMessage("Something went wrong on our side. Please try again in a moment.");
    });

    /* ================= VERIFY EMAIL (link from the email) ================= */
    async function verifyEmail(token) {
        showMessage("Verifying your email...", "info");
        const res = await api("/auth/verify-email", { method: "POST", body: { token } });
        if (res.ok) { showMessage("Your email is verified. You can sign in now.", "success"); return; }
        if (res.network) { showMessage("We can't reach GasHub right now. Open the link again in a moment."); return; }
        showMessage("This verification link has expired or was already used. Sign in and we'll send you a new one.", "error");
    }

    /* ================= ALREADY SIGNED IN? ================= */
    async function checkExistingSession() {
        const res = await api("/auth/me");
        if (res.ok && res.data && (res.data.customer || res.data.user)) {
            completeLogin(res.data.customer || res.data.user, null, true, "session");
            location.replace(next);
        } else if (res.status === 401) clearStaleSignIn();         /* the server says no, so drop the old local sign-in */
    }

    /* ================= START ================= */
    const savedEmail = localStorage.getItem(REMEMBERED_EMAIL);
    if (savedEmail) { loginEmail.value = savedEmail; rememberMe.checked = true; }

    if (resetToken) { showPanel("reset", true); }
    else if (verifyToken) { verifyEmail(verifyToken); }
    else if (authState === "success") { finishSocialLogin(); }
    else if (authState === "complete_profile") {            /* new Google customer: add phone + address on the sign-up page */
        location.replace("customer-register.html?auth=complete_profile&provider=" + encodeURIComponent(authProvider || "google") + "&next=" + encodeURIComponent(next));
    }
    else if (authError) { showMessage(SOCIAL_ERRORS[authError] || "That sign-in didn't work. Please try again or use another method."); }
    else if (!loggedOut) { checkExistingSession(); }
    if (loggedOut) showMessage("You've been signed out.", "info");
})();