/* GasHub dealer verification (blue badge) - shared by every dealer page.
   - Whether the dealer is verified comes from the SERVER (GET /api/dealers/verification/mine), never from a guess kept in the browser,
     so a verified dealer is never asked to verify again.
   - "Verify" opens a pop-up showing the fee the GasHub admin set for THIS dealer. The dealer types the M-Pesa number, the server sends
     the PIN prompt (through the M-Pesa keys saved on the server), and once the money is received and confirmed the dealer is verified
     automatically. The page just waits for that and then shows the badge. */
(function () {
    "use strict";

    var API = "/api/dealers/verification";
    var VERIFIED_KEY = "gashub_dealer_verified";
    var BTN_SELECTOR = "#btnRequestVerification, #btnProfileRequestVerification, .btn-request-verification";
    var state = { verified: null, fee: null, mpesaEnabled: true, busy: false };
    var originalButtons = new WeakMap();
    var modal = null;

    function token() { try { return localStorage.getItem("gashub_dealer_token") || ""; } catch (e) { return ""; } }
    function ksh(n) { return "KSh " + Number(n).toLocaleString("en-KE"); }
    function $(id) { return document.getElementById(id); }

    function api(path, opts) {
        opts = opts || {};
        var headers = { "Accept": "application/json", "Authorization": "Bearer " + token() };
        if (opts.body) headers["Content-Type"] = "application/json";
        return fetch(API + path, { method: opts.method || "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: "no-store" })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._http = r.status; return j; }); });
    }

    function toast(message, kind) {
        try { if (window.GasHubCore && typeof GasHubCore.showToast === "function") { GasHubCore.showToast(message, kind || "info"); return; } } catch (e) { /* fall through */ }
        try { if (window.GasHubDialog && typeof GasHubDialog.alert === "function") { GasHubDialog.alert(message); return; } } catch (e) { /* fall through */ }
        alert(message);
    }

    /* ---------- what the page shows ---------- */
    function remember(verified) {
        try {
            localStorage.setItem(VERIFIED_KEY, verified ? "true" : "false");
            var cached = JSON.parse(localStorage.getItem("gashub_dealer") || "{}");
            cached.is_verified = verified;
            cached.verification_active = verified;
            localStorage.setItem("gashub_dealer", JSON.stringify(cached));
        } catch (e) { /* storage blocked: the page still works from the server answer */ }
    }

    function render() {
        var verified = state.verified === true;
        var unknown = state.verified === null;

        document.querySelectorAll(".tiktok-verified-badge").forEach(function (b) {
            b.classList.toggle("verified-active", verified);
            if (b.id === "profileVerifiedBadge") b.hidden = !verified;
            else if (!unknown) b.style.display = verified ? "inline-flex" : "none";
        });

        document.querySelectorAll(BTN_SELECTOR).forEach(function (btn) {
            if (!originalButtons.has(btn)) originalButtons.set(btn, btn.innerHTML);
            if (unknown) return;
            if (btn.id === "btnProfileRequestVerification") {                    /* profile card: hide the button once verified */
                btn.hidden = verified;
                btn.disabled = state.busy;
                var t = $("profileVerificationBtnText");
                if (t) t.textContent = state.busy ? "Verification pending" : "Get verified";
                return;
            }
            if (verified) {
                btn.classList.add("is-verified");
                btn.innerHTML = '<i class="fa-solid fa-circle-check fa-sm text-success"></i> <span>EPRA Verified Outlet</span>';
                btn.disabled = true;
            } else {
                btn.classList.remove("is-verified");
                btn.innerHTML = originalButtons.get(btn);
                btn.disabled = state.busy;
                var label = btn.querySelector("#verificationBtnText");
                if (label) label.textContent = state.busy ? "Verification Pending" : "Request Verification";
            }
        });

        var compliance = document.querySelector("[data-compliance-status], #complianceStatus");
        if (compliance && !unknown) compliance.textContent = verified ? "EPRA Certified Active • Verified Dealer" : "Safety Compliance • Pending Verification";
        try { if (window.GasHubCore && typeof GasHubCore.syncAcrossPage === "function") GasHubCore.syncAcrossPage(); } catch (e) { /* ignore */ }
    }

    function apply(j) {
        if (!j || j.success === false || typeof j.verified !== "boolean") return false;
        state.verified = j.verified;
        state.fee = j.fee || null;
        if (typeof j.mpesa_enabled === "boolean") state.mpesaEnabled = j.mpesa_enabled;
        remember(j.verified);
        render();
        return true;
    }

    function refresh() {
        if (!token()) return Promise.resolve(false);
        return api("/mine").then(function (j) { apply(j); return j; }).catch(function () { return null; });
    }

    /* ---------- the pop-up ---------- */
    var CSS = [
        ".ghv-back{position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px}",
        ".ghv-back[hidden]{display:none}",
        ".ghv-box{background:#fff;color:#0f172a;border-radius:16px;width:100%;max-width:440px;max-height:92vh;overflow:auto;box-shadow:0 20px 50px rgba(0,0,0,.3);font-family:inherit}",
        ".ghv-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid #e2e8f0}",
        ".ghv-head h2{margin:0;font-size:18px}.ghv-head span{font-size:12px;color:#64748b}",
        ".ghv-x{border:0;background:none;font-size:18px;cursor:pointer;color:#64748b;padding:6px}",
        ".ghv-body{padding:18px 20px}.ghv-foot{display:flex;gap:10px;justify-content:flex-end;padding:14px 20px;border-top:1px solid #e2e8f0}",
        ".ghv-perks{display:grid;gap:8px;margin:0 0 14px;padding:12px 14px;background:#f1f5f9;border-radius:12px;font-size:13px}",
        ".ghv-perks div{display:flex;gap:8px;align-items:flex-start}.ghv-perks i{color:#16a34a;margin-top:2px}",
        ".ghv-fee{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;margin-bottom:14px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:12px;font-size:14px}",
        ".ghv-fee strong{font-size:18px;color:#1d4ed8}.ghv-fee.missing{border-color:#fecaca;background:#fef2f2}.ghv-fee.missing strong{color:#b91c1c;font-size:14px}",
        ".ghv-box label{display:block;font-size:13px;font-weight:600;margin:12px 0 6px}",
        ".ghv-box input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font:inherit}",
        ".ghv-status{display:none;margin-top:14px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.45;background:#eff6ff;color:#1e3a8a}",
        ".ghv-status.on{display:block}.ghv-status.err{background:#fef2f2;color:#991b1b}.ghv-status.ok{background:#f0fdf4;color:#166534}",
        ".ghv-btn{border:1px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:10px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer}",
        ".ghv-btn.primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff}.ghv-btn:disabled{opacity:.55;cursor:not-allowed}"
    ].join("");

    function build() {
        if (modal) return modal;
        var old = $("verificationModalBackdrop");            /* the older built-in pop-up is replaced by this one */
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var st = document.createElement("style");
        st.textContent = CSS;
        document.head.appendChild(st);
        modal = document.createElement("div");
        modal.className = "ghv-back";
        modal.hidden = true;
        modal.innerHTML =
            '<div class="ghv-box" role="dialog" aria-modal="true" aria-labelledby="ghvTitle">' +
            '<div class="ghv-head"><div><h2 id="ghvTitle">Get Verified</h2><span>Official GasHub &amp; EPRA Dealer Badge</span></div>' +
            '<button type="button" class="ghv-x" id="ghvClose" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
            '<form id="ghvForm" novalidate><div class="ghv-body">' +
            '<div class="ghv-perks">' +
            '<div><i class="fa-solid fa-circle-check"></i><span>Top ranking in customer cylinder searches on GasHub App</span></div>' +
            '<div><i class="fa-solid fa-circle-check"></i><span>EPRA Safety Compliance digital certificate seal</span></div></div>' +
            '<div class="ghv-fee" id="ghvFee"><span>Admin Verification Fee:</span><strong id="ghvFeeAmount">—</strong></div>' +
            '<label for="ghvOutlet">Depot / Outlet Name</label><input type="text" id="ghvOutlet" maxlength="120" autocomplete="organization">' +
            '<label for="ghvLicense">EPRA License Number</label><input type="text" id="ghvLicense" maxlength="80" placeholder="e.g. EPRA/LPG/2026/8942">' +
            '<label for="ghvPhone">M-Pesa Phone Number (for the PIN prompt)</label><input type="tel" id="ghvPhone" inputmode="tel" placeholder="07XX XXX XXX or 01XX XXX XXX" autocomplete="tel">' +
            '<div class="ghv-status" id="ghvStatus" role="status" aria-live="polite"></div></div>' +
            '<div class="ghv-foot"><button type="button" class="ghv-btn" id="ghvCancel">Cancel</button>' +
            '<button type="submit" class="ghv-btn primary" id="ghvPay"><i class="fa-solid fa-mobile-screen-button fa-sm"></i> <span id="ghvPayText">Pay via M-Pesa</span></button></div>' +
            '</form></div>';
        document.body.appendChild(modal);
        $("ghvClose").addEventListener("click", close);
        $("ghvCancel").addEventListener("click", close);
        modal.addEventListener("click", function (e) { if (e.target === modal) close(); });
        $("ghvForm").addEventListener("submit", submit);
        return modal;
    }

    function say(msg, kind) {
        var box = $("ghvStatus");
        if (!box) return;
        box.className = "ghv-status" + (msg ? " on" : "") + (kind === "err" ? " err" : kind === "ok" ? " ok" : "");
        box.textContent = msg || "";
    }
    function close() { if (modal && !state.busy) modal.hidden = true; }

    function profileValue(key) {
        try { var d = JSON.parse(localStorage.getItem("gashub_dealer") || "{}"); return d[key] || ""; } catch (e) { return ""; }
    }

    function open() {
        if (state.verified === true) { toast("Your outlet is already verified.", "success"); return; }
        build();
        if (!$("ghvOutlet").value) $("ghvOutlet").value = profileValue("business_name");
        if (!$("ghvPhone").value) $("ghvPhone").value = profileValue("phone");
        say("", "");
        $("ghvFeeAmount").textContent = "Checking...";
        $("ghvPay").disabled = true;
        modal.hidden = false;
        /* always ask the server: it knows the real fee and whether the dealer was verified in the meantime */
        api("/mine").then(function (j) {
            if (!apply(j)) throw new Error((j && j.message) || "Unable to load your verification details.");
            if (j.verified) { modal.hidden = true; toast("Your outlet is already verified.", "success"); return; }
            var fee = $("ghvFee");
            if (j.fee) {
                fee.classList.remove("missing");
                $("ghvFeeAmount").textContent = ksh(j.fee);
                $("ghvPayText").textContent = "Pay " + ksh(j.fee) + " via M-Pesa";
                $("ghvPay").disabled = false;
                if (!j.mpesa_enabled) say("M-Pesa payments are not switched on yet. Please contact GasHub support.", "err");
                if (j.pending_checkout_request_id) { say("A payment prompt is already waiting on your phone. Enter your PIN, or wait a minute and try again.", ""); }
            } else {
                fee.classList.add("missing");
                if (j.default_fee) {
                    /* just shown: the dealer still cannot pay until GasHub Admin sets the fee for this outlet */
                    $("ghvFeeAmount").textContent = ksh(j.default_fee);
                    $("ghvPayText").textContent = "Pay via M-Pesa";
                } else {
                    $("ghvFeeAmount").textContent = "Not set yet";
                    $("ghvPayText").textContent = "Pay via M-Pesa";
                    say("GasHub Admin has not set a verification fee for your outlet yet. Please contact GasHub support.", "err");
                }
            }
        }).catch(function (err) {
            $("ghvFeeAmount").textContent = "—";
            say(err.message || "Unable to load your verification details.", "err");
        });
    }

    function submit(e) {
        e.preventDefault();
        if (state.busy) return;
        var outlet = $("ghvOutlet").value.trim(), license = $("ghvLicense").value.trim(), phone = $("ghvPhone").value.trim();
        if (!outlet || !license) { say("Enter your outlet name and EPRA license number.", "err"); return; }
        if (!/^(?:\+?254|0)?[17]\d{8}$/.test(phone.replace(/[\s\-()]/g, ""))) { say("Enter a valid Safaricom number, e.g. 0712 345 678 or 0110 123 456.", "err"); return; }

        state.busy = true;
        $("ghvPay").disabled = true;
        var label = $("ghvPayText").textContent;
        $("ghvPayText").textContent = "Sending prompt...";
        render();
        function finish(message, kind) {
            state.busy = false;
            $("ghvPayText").textContent = label;
            $("ghvPay").disabled = state.verified === true;
            say(message, kind);
            render();
        }

        api("/pay", { method: "POST", body: { phone: phone, outlet_name: outlet, epra_license: license } }).then(function (j) {
            if (j.code === "already_verified") { apply(j); modal.hidden = true; state.busy = false; render(); toast("Your outlet is already verified.", "success"); return; }
            if (!j.success) { finish(j.message || "We couldn't send the prompt. Please try again.", "err"); return; }
            $("ghvPayText").textContent = "Waiting for payment...";
            say("M-Pesa prompt sent to " + phone + ". Enter your PIN on your phone to pay " + ksh(j.amount) + ". This page will update by itself.", "");
            poll(j.checkoutRequestId, Date.now(), finish);
        }).catch(function () { finish("Network problem. Please check your connection and try again.", "err"); });
    }

    function poll(id, startedAt, finish) {
        if (Date.now() - startedAt > 4 * 60 * 1000) { finish("We have not received the payment yet. If money was taken from your M-Pesa, your badge will appear automatically within a few minutes.", "err"); return; }
        setTimeout(function () {
            api("/status?checkout_request_id=" + encodeURIComponent(id)).then(function (j) {
                if (j && j.status === "paid") {
                    apply({ success: true, verified: true, fee: state.fee, mpesa_enabled: state.mpesaEnabled });
                    refresh();
                    state.busy = false;
                    render();
                    if (modal) modal.hidden = true;
                    toast("Payment received. Your outlet is now verified!", "success");
                    return;
                }
                if (j && j.success && (j.status === "cancelled" || j.status === "timeout" || j.status === "failed")) { finish(j.message || "The payment was not completed.", "err"); return; }
                poll(id, startedAt, finish);
            }).catch(function () { poll(id, startedAt, finish); });
        }, 3000);
    }

    /* ---------- start ---------- */
    document.addEventListener("click", function (e) {
        var btn = e.target.closest && e.target.closest(BTN_SELECTOR);
        if (!btn) return;
        e.preventDefault();
        e.stopImmediatePropagation();                      /* the older page code must not run its own (fake) flow */
        if (!btn.disabled) open();
    }, true);

    function start() {
        /* a dealer already known to be verified never sees "Get verified" while the server answer loads */
        var cached = false;
        try { cached = localStorage.getItem(VERIFIED_KEY) === "true"; } catch (e) { /* ignore */ }
        if (cached) { state.verified = true; render(); }
        refresh();
        setInterval(function () { if (!document.hidden && !state.busy) refresh(); }, 120000);
    }

    window.GasHubVerification = { refresh: refresh, open: open };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
