/* GasHub customer registration.

   Two ways to create an account:
   1. Email  - the customer fills in the form and picks a password.
   2. Social - the customer taps Google / Facebook / X, the server does the OAuth step, then sends them
               back here with ?auth=complete_profile so they can add the details the provider does not give
               (phone, delivery address) and accept the terms.

   Passwords are only sent to the GasHub server over HTTPS and are never saved on the phone.
   The server creates the account and decides who is signed in (ideally with an HttpOnly cookie).
   The server routes this page expects are listed in gashub-auth-api.md. */
(function () {
    "use strict";

    const API = "/api";
    const DEFAULT_NEXT = "customer-home.html";
    const NAMES = { google: "Google", facebook: "Facebook", x: "X" };

    /* personal data that belongs to one customer: cleared if a different customer registers on this phone */
    const PERSONAL_KEYS = ["gasHubProfilePhoto", "gasHubPoints", "gasHubFavourites", "gasHubFavorites", "gasHubFavs", "favourites", "favorites",
        "gasHubFollowedDealers", "gasHubFollowing", "gasHubFollowedDealer", "followedDealers", "gasHubOrderHistory", "gasHubLastOrder",
        "gasHubViews", "gasHubPurchases", "gasHubDeletionRequest", "gasHubNotify"];

    const $ = id => document.getElementById(id);
    const form = $("registerForm"), msgBox = $("formMessage"), button = $("registerButton");
    const fullName = $("fullName"), phone = $("phone"), email = $("email"), address = $("address"),
        password = $("password"), confirmPassword = $("confirmPassword"), terms = $("terms");

    /* ---------- invited by a friend: ?ref=CODE is remembered until the account is created ---------- */
    const REF_KEY = "gasHubRef";
    (function rememberInvite() {
        try {
            const code = String(new URLSearchParams(location.search).get("ref") || "").trim().toUpperCase();
            if (/^[A-Z0-9]{6,12}$/.test(code)) localStorage.setItem(REF_KEY, code);
        } catch (e) { }
    })();
    const inviteCode = () => { try { return localStorage.getItem(REF_KEY) || ""; } catch (e) { return ""; } };

    /* ---------- helpers ---------- */
    const readJSON = (area, k) => { try { return JSON.parse(area.getItem(k)); } catch (e) { return null; } };
    const writeJSON = (area, k, v) => { try { area.setItem(k, JSON.stringify(v)); } catch (e) { } };
    const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;

    /* Kenyan numbers: accepts 07.., 01.., +2547.., 2547.. and returns 07XXXXXXXX / 01XXXXXXXX */
    function normalizePhone(v) {
        let n = String(v || "").trim().replace(/[\s\-()]/g, "");
        if (n.startsWith("+254")) n = "0" + n.slice(4);
        else if (n.startsWith("254")) n = "0" + n.slice(3);
        return n;
    }
    const isPhone = v => /^(07|01)\d{8}$/.test(v);

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
    const authState = params.get("auth");
    const authError = params.get("auth_error");
    const authProvider = params.get("provider");
    if (authState || authError || authProvider) cleanUrl("auth", "auth_error", "provider");
    $("signinLink").href = "customer-login.html" + (next !== DEFAULT_NEXT ? "?next=" + encodeURIComponent(next) : "");

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
        msgBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    /* ---------- field errors ---------- */
    function setError(field, message) {
        const g = field.closest(".form-group");
        if (g) { g.classList.add("has-error"); g.classList.remove("has-success"); }
        const e = $(field.id + "Error"); if (e) e.textContent = message;
    }
    function clearError(field) {
        const g = field.closest(".form-group");
        if (g) g.classList.remove("has-error", "has-success");
        const e = $(field.id + "Error"); if (e) e.textContent = "";
    }
    function markOk(field) {
        const g = field.closest(".form-group");
        if (g) { g.classList.remove("has-error"); g.classList.add("has-success"); }
        const e = $(field.id + "Error"); if (e) e.textContent = "";
    }

    /* ---------- show / hide password ---------- */
    document.querySelectorAll(".password-toggle").forEach(btn => btn.addEventListener("click", () => {
        const input = $(btn.dataset.target), show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.textContent = show ? "Hide" : "Show";
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
        btn.setAttribute("aria-pressed", String(show));
    }));

    /* ---------- password strength ---------- */
    function strength(pw) {
        let s = 0;
        if (pw.length >= 8) s++;
        if (pw.length >= 12 || (/[a-z]/.test(pw) && /[A-Z]/.test(pw))) s++;
        if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw) || pw.length >= 14) s++;
        return pw.length < 8 ? Math.min(s, 1) : Math.max(s, 1);
    }
    password.addEventListener("input", () => {
        const pw = password.value, lvl = pw ? strength(pw) : 0;
        $("strength").dataset.level = String(lvl);
        $("strengthText").textContent = !pw ? "" : pw.length < 8 ? "Too short" : ["", "Weak", "Okay", "Strong"][lvl];
        clearError(password);
        if (confirmPassword.value) checkConfirm();
    });
    function checkConfirm() {
        if (!confirmPassword.value) { clearError(confirmPassword); return; }
        if (confirmPassword.value === password.value) markOk(confirmPassword);
        else setError(confirmPassword, "Passwords do not match.");
    }
    confirmPassword.addEventListener("input", checkConfirm);
    [fullName, phone, email, address].forEach(f => f.addEventListener("input", () => { clearError(f); clearMessage(); }));
    terms.addEventListener("change", () => { $("termsError").textContent = ""; });

    /* ---------- talking to the server ---------- */
    let csrf = "";
    async function api(path, opts) {
        opts = opts || {};
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
        const headers = { Accept: "application/json" };
        if (opts.body) headers["Content-Type"] = "application/json";
        if (csrf) headers["X-CSRF-Token"] = csrf;
        try {
            const res = await fetch(API + path, {
                method: opts.method || "GET", headers, credentials: "same-origin", cache: "no-store", signal: ctl.signal,
                body: opts.body ? JSON.stringify(opts.body) : undefined
            });
            let data = {}; try { data = await res.json(); } catch (e) { }
            return { ok: res.ok, status: res.status, data: data || {}, retryAfter: parseInt(res.headers.get("Retry-After"), 10) || 0 };
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

    /* ---------- keep the new customer's details on this phone (display only, never the password) ---------- */
    function saveLocalSession(c, method) {
        c = c || {};
        const name = c.fullName || c.name || c.full_name || `${c.first_name || ""} ${c.last_name || ""}`.trim();
        const mail = String(c.email || "").toLowerCase();

        const old = readJSON(localStorage, "gasHubCustomer") || {};
        const sameCustomer = !old.email || !mail || String(old.email).toLowerCase() === mail;
        if (!sameCustomer) PERSONAL_KEYS.forEach(k => localStorage.removeItem(k));

        const customer = {
            ...(sameCustomer ? old : {}),
            id: c.id ?? c.customer_id ?? old.id,
            fullName: name || "", name: name || "", email: mail,
            phone: c.phone || c.phoneNumber || c.phone_number || "",
            address: c.address || c.deliveryAddress || "",
            createdAt: c.createdAt || c.created_at || new Date().toISOString()
        };
        writeJSON(localStorage, "gasHubCustomer", customer);
        writeJSON(localStorage, "customer", customer);
        writeJSON(localStorage, "gasHubCustomerProfile", { fullName: customer.fullName, phone: customer.phone, email: customer.email, address: customer.address });
        writeJSON(localStorage, "gasHubCustomerSession", { email: customer.email, method, loggedInAt: new Date().toISOString(), remember: true });
        localStorage.setItem("gasHubLoggedIn", "true");
        if (c.photo && !localStorage.getItem("gasHubProfilePhoto")) writeJSON(localStorage, "gasHubProfilePhoto", c.photo);
        localStorage.removeItem("token"); sessionStorage.removeItem("token");
    }
    function goNext() { setTimeout(() => location.replace(next), 900); }

    /* ---------- mode: "email" or "social" ---------- */
    let mode = "email", socialProvider = "";

    function enterSocialMode(profile, provider) {
        mode = "social"; socialProvider = provider || profile.provider || "social";
        const label = NAMES[socialProvider] || "your social account";
        $("socialSection").hidden = true;
        $("passwordSection").hidden = true;
        $("panelTitle").textContent = "Almost done";
        $("panelSub").textContent = "Confirm your details to finish creating your account.";
        $("socialBannerText").textContent = `Signing up with ${label}. Add the details below and we'll create your account.`;
        $("socialBanner").hidden = false;
        if (profile.photo && /^https:\/\//.test(profile.photo)) { $("socialPhoto").src = profile.photo; $("socialPhoto").hidden = false; }
        fullName.value = profile.fullName || profile.name || "";
        if (profile.email) { email.value = profile.email; email.readOnly = true; }   /* verified by the provider */
        button.textContent = "Finish creating account";
        (fullName.value ? phone : fullName).focus();
    }

    /* ---------- validation ---------- */
    function validate() {
        let ok = true;
        clearMessage();
        [fullName, phone, email, address, password, confirmPassword].forEach(clearError);

        if (fullName.value.trim().length < 2) { setError(fullName, "Enter your full name."); ok = false; } else markOk(fullName);

        const ph = normalizePhone(phone.value);
        if (!ph) { setError(phone, "Enter your phone number."); ok = false; }
        else if (!isPhone(ph)) { setError(phone, "Enter a valid Kenyan phone number, e.g. 0712345678."); ok = false; }
        else { phone.value = ph; markOk(phone); }

        const em = email.value.trim();
        if (!em) { setError(email, "Enter your email address."); ok = false; }
        else if (!isEmail(em)) { setError(email, "Enter a valid email address."); ok = false; }
        else markOk(email);

        if (address.value.trim().length > 300) { setError(address, "Address is too long."); ok = false; }

        if (mode === "email") {
            const pw = password.value;
            if (pw.length < 8) { setError(password, "Password must contain at least 8 characters."); ok = false; }
            else if (pw.length > 128) { setError(password, "That password is too long."); ok = false; }
            else markOk(password);

            if (!confirmPassword.value) { setError(confirmPassword, "Confirm your password."); ok = false; }
            else if (confirmPassword.value !== pw) { setError(confirmPassword, "Passwords do not match."); ok = false; }
            else markOk(confirmPassword);
        }

        if (!terms.checked) { $("termsError").textContent = "You must agree before creating an account."; ok = false; }
        else $("termsError").textContent = "";

        if (!ok) {
            showMessage("Please correct the highlighted fields and try again.");
            const first = form.querySelector(".has-error input, .has-error textarea"); if (first) first.focus();
        }
        return ok;
    }

    /* ---------- busy state ---------- */
    function setBusy(busy, label) {
        if (busy) { button.dataset.label = button.textContent; button.textContent = label; button.disabled = true; }
        else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; }
    }

    /* ================= SUBMIT (email sign-up, or finishing a social sign-up) ================= */
    form.addEventListener("submit", async e => {
        e.preventDefault();
        if (button.disabled || !validate()) return;

        const details = {
            fullName: fullName.value.trim(),
            phone: normalizePhone(phone.value),
            email: email.value.trim().toLowerCase(),
            address: address.value.trim(),
            acceptedTerms: true,
            ref: inviteCode()
        };

        setBusy(true, "Creating account...");
        await csrfReady;
        const res = mode === "social"
            ? await api("/auth/complete-profile", { method: "POST", body: { ...details, provider: socialProvider } })
            : await api("/auth/register", { method: "POST", body: { ...details, password: password.value } });
        setBusy(false);

        if (res.ok || res.status === 201) {
            password.value = ""; confirmPassword.value = "";
            try { localStorage.removeItem(REF_KEY); } catch (e) { }
            const c = res.data && (res.data.customer || res.data.user);

            /* the server wants the email checked before the first sign-in */
            if (res.data && res.data.verificationRequired) {
                showMessage("Account created! We've sent a verification link to your email. Verify it, then sign in.", "success");
                form.hidden = true; $("socialSection").hidden = true; $("socialBanner").hidden = true;
                return;
            }
            if (c) saveLocalSession(c, mode === "social" ? socialProvider : "email");
            else saveLocalSession(details, "email");     /* server created the account but sent no profile back */
            showMessage("Your GasHub account has been created. Taking you in...", "success");
            goNext();
            return;
        }
        registerFailed(res);
    });

    function registerFailed(res) {
        const code = res.data && (res.data.code || res.data.error);
        const field = res.data && res.data.field;
        if (res.network) { showMessage("We can't reach GasHub right now. Check your internet connection and try again."); return; }
        if (res.status === 404 || res.status === 501) { showMessage("Sign-up isn't available right now. Please try again later."); return; }
        if (res.status === 429) { showMessage("Too many attempts. Please wait a moment and try again."); return; }
        if (res.status === 403 && code === "account_banned") { showMessage((res.data && res.data.message) || "This email or phone number can't be used to create a GasHub account."); return; }
        if (res.status === 409) {
            if (code === "phone_exists" || field === "phone") {
                setError(phone, "An account with this phone number already exists.");
                showMessage("That phone number is already registered.", "error", { label: "Sign in", run: () => location.assign("customer-login.html") });
            } else {
                setError(email, "An account with this email already exists.");
                showMessage("This email is already registered.", "error", { label: "Sign in", run: () => location.assign("customer-login.html") });
            }
            return;
        }
        if (res.status === 400 || res.status === 422) {
            if (field && $(field)) setError($(field), res.data.message || "Please check this field.");
            showMessage((res.data && res.data.message) || "Please check your details and try again.");
            return;
        }
        if (res.status === 401 && mode === "social") {
            showMessage("Your sign-up session expired. Please start again.", "error");
            location.replace("customer-register.html"); return;
        }
        showMessage("Something went wrong on our side. Please try again in a moment.");
    }

    /* ================= SIGN UP WITH GOOGLE / FACEBOOK / X ================= */
    Object.keys(NAMES).forEach(p => $(p + "Login").addEventListener("click", async () => {
        clearMessage();
        const btn = $(p + "Login");
        if (btn.disabled) return;
        await providersReady;
        if (!providers || !providers[p]) { showMessage(`${NAMES[p]} sign-up isn't available yet. Please use your email instead.`); return; }
        btn.disabled = true;                                        /* the server takes over from here (OAuth) */
        window.location.assign(`${API}/auth/${p}?mode=register&next=${encodeURIComponent(next)}`);
    }));
    window.addEventListener("pageshow", e => { if (e.persisted) Object.keys(NAMES).forEach(p => { $(p + "Login").disabled = false; }); });

    const SOCIAL_ERRORS = {
        access_denied: "You cancelled the sign-up. You can try again any time.",
        account_exists: "An account with this email already exists. Please sign in instead.",
        email_missing: "We couldn't get an email address from that account. Please enter one below.",
        email_not_verified: "That account's email isn't verified yet. Verify it with the provider and try again.",
        provider_unavailable: "That sign-up option isn't available right now. Please use another method.",
        invalid_state: "The sign-up took too long or was interrupted. Please try again."
    };

    /* back from the provider: fetch what they shared (name, email, photo) and ask for the rest */
    async function finishSocialReturn() {
        showMessage("Getting your details...", "info");
        const res = await api("/auth/social-profile");
        const profile = res.ok && res.data && (res.data.profile || res.data.customer || res.data.user);
        if (!profile) { showMessage("We couldn't read your details from that account. Please try again or use your email."); return; }
        clearMessage();
        enterSocialMode(profile, authProvider);
        if (!profile.email) showMessage(`${NAMES[authProvider] || "That account"} didn't share an email address. Please enter one below.`, "info");
    }

    /* the social account already had a GasHub account: the server signed them in */
    async function finishExistingAccount() {
        showMessage("You already have a GasHub account. Signing you in...", "info");
        const res = await api("/auth/me");
        if (res.ok && res.data && (res.data.customer || res.data.user)) {
            saveLocalSession(res.data.customer || res.data.user, authProvider || "social");
            goNext();
        } else showMessage("We couldn't sign you in. Please try again.");
    }

    /* ================= START ================= */
    if (authState === "complete_profile") finishSocialReturn();
    else if (authState === "success") finishExistingAccount();
    else if (authError) showMessage(SOCIAL_ERRORS[authError] || "That sign-up didn't work. Please try again or use your email.");
})();