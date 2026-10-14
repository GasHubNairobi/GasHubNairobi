/* GasHub admin - Messaging pages.
   One script for the four pages; <body data-msg-page="..."> says which one is open:
     email            admin-email-broadcast.html
     sms              admin-sms-broadcast.html
     item-reminder    admin-item-reminders.html
     restock-reminder admin-restock-reminders.html
   Needs admin-main.js (GasHubAdmin.adminApiRequest). Backend: controllers/admin-messaging-controller.js */
(function () {
    "use strict";

    const api = (url, options) => GasHubAdmin.adminApiRequest(url, options);
    const esc = (v) => GasHubAdmin.escapeHtml(v);
    const $ = (id) => document.getElementById(id);
    const page = document.body.dataset.msgPage;
    const BASE = "/api/admin/messaging";

    /* ---------- small helpers ---------- */
    function flash(message, type) {
        const box = $("msgFlash");
        if (!box) return;
        box.className = "admin-message show " + (type || "success");
        box.textContent = message;
        box.scrollIntoView({ behavior: "smooth", block: "nearest" });
        clearTimeout(flash.t);
        flash.t = setTimeout(() => { box.className = "admin-message"; }, 9000);
    }

    function when(value) {
        if (!value) return "-";
        const d = new Date(value);
        return isNaN(d) ? "-" : d.toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    const badge = (status) => {
        const map = { completed: "success", sent: "success", sending: "warning", pending: "warning", interrupted: "danger", failed: "danger" };
        return `<span class="status-badge ${map[status] || "neutral"}">${esc(status)}</span>`;
    };

    function busy(button, on, label) {
        if (!button) return;
        if (on) { button.dataset.label = button.textContent; button.textContent = label || "Please wait..."; }
        else if (button.dataset.label) { button.textContent = button.dataset.label; }
        button.disabled = on;
    }

    function openModal(id) { const m = $(id); if (m) { m.classList.add("open"); m.setAttribute("aria-hidden", "false"); } }
    function closeModal(id) { const m = $(id); if (m) { m.classList.remove("open"); m.setAttribute("aria-hidden", "true"); } }

    /* click a {placeholder} chip -> insert it where the cursor was last */
    function bindChips() {
        let last = null;
        document.querySelectorAll(".msg-field input[type=text], .msg-field textarea").forEach((el) => el.addEventListener("focus", () => { last = el; }));
        document.querySelectorAll(".msg-chip").forEach((chip) => chip.addEventListener("click", () => {
            const el = last || document.querySelector(".msg-field textarea");
            if (!el) return;
            const s = el.selectionStart == null ? el.value.length : el.selectionStart;
            const e = el.selectionEnd == null ? s : el.selectionEnd;
            el.value = el.value.slice(0, s) + chip.dataset.token + el.value.slice(e);
            el.focus();
            el.selectionStart = el.selectionEnd = s + chip.dataset.token.length;
            el.dispatchEvent(new Event("input"));
        }));
    }

    /* SMS length: 160 characters for one SMS (70 when the text has emoji or special letters) */
    function smsInfo(text) {
        const gsm = /^[A-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\r\n^{}\\[~\]|€]*$/;
        const unicode = !gsm.test(text);
        const single = unicode ? 70 : 160, multi = unicode ? 67 : 153;
        const n = text.length;
        const parts = n === 0 ? 0 : n <= single ? 1 : Math.ceil(n / multi);
        return { n, parts, unicode };
    }

    /* ============================================================
       BROADCAST PAGES (email / sms)
    ============================================================ */
    function initBroadcast() {
        const channel = page;                       /* "email" or "sms" */
        const isEmail = channel === "email";
        let overview = null;
        let pollTimer = null;
        let aud = "customers";                         /* who receives it: "customers" or "dealers" */
        const audWord = () => (aud === "dealers" ? "dealers" : "customers");
        const audOne = () => (aud === "dealers" ? "dealer" : "customer");

        const subject = $("msgSubject"), body = $("msgBody");
        const sendBtn = $("sendBtn"), testBtn = $("testBtn");

        /* "Send to" picker: customers or dealers (dealers use the email / phone they registered with) */
        (function addAudiencePicker() {
            const first = (isEmail ? subject : body).closest(".msg-field");
            if (!first) return;
            const box = document.createElement("div");
            box.className = "msg-field";
            box.innerHTML = `<label for="msgAudience">Send to</label>
                <select id="msgAudience"><option value="customers">All active customers</option><option value="dealers">All active dealers</option></select>`;
            first.parentNode.insertBefore(box, first);
            box.querySelector("select").addEventListener("change", (e) => {
                aud = e.target.value === "dealers" ? "dealers" : "customers";
                applyAudience();
                loadHistory();
            });
        })();

        function applyAudience() {
            const dl = aud === "dealers";
            if (overview) {
                const a = dl ? overview.dealers : overview.audience;
                const reach = isEmail ? a.withEmail : a.withPhone;
                const ready = isEmail ? overview.email.configured : overview.sms.configured;
                $("statActive").textContent = dl ? a.activeDealers : a.activeCustomers;
                $("statReach").textContent = reach;
                sendBtn.disabled = !ready || !reach;
            }
            const lab = $("statActive").parentElement.querySelector(".stat-label");
            if (lab) lab.textContent = dl ? "Active dealers" : "Active customers";
            sendBtn.textContent = dl ? "Send to all dealers" : "Send to all customers";
            const t = $("confirmTitle"); if (t) t.textContent = dl ? "Send to all dealers?" : "Send to all customers?";
            updateCounter();
        }

        function updateCounter() {
            const c = $("msgCounter");
            if (!c) return;
            if (isEmail) {
                c.innerHTML = `<span>Use <b>{name}</b> to greet each ${audOne()} by first name.</span><strong>${body.value.length} / 5000</strong>`;
            } else {
                const i = smsInfo(body.value);
                c.innerHTML = `<span>${i.parts ? i.parts + " SMS per " + audOne() : "Use {name} to greet each " + audOne()}${i.unicode ? " (emoji or special letters make each SMS shorter)" : ""}</span>` +
                    `<strong class="${i.n > 612 ? "over" : ""}">${i.n} / 612</strong>`;
            }
        }

        async function loadOverview() {
            try {
                overview = await api(`${BASE}/overview`);
                const ready = isEmail ? overview.email.configured : overview.sms.configured;
                $("statReady").textContent = ready ? "Ready" : "Not set up";
                const banner = $("msgBanner");
                if (!ready) {
                    banner.textContent = isEmail
                        ? "Email is not set up yet. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM to the .env file and restart the server."
                        : "SMS is not set up yet. Add AT_USERNAME and AT_API_KEY (Africa's Talking) to the .env file and restart the server.";
                    banner.classList.add("show");
                }
                applyAudience();
                testBtn.disabled = !ready;
            } catch (error) {
                flash(error.message, "error");
            }
        }

        async function loadHistory() {
            const tbody = $("historyBody");
            try {
                const data = await api(`${BASE}/broadcasts?channel=${channel}`);
                const rows = (data.broadcasts || []).filter((b) => (b.audience || "customers") === aud);
                if (!rows.length) { tbody.innerHTML = `<tr><td colspan="6" class="table-loading">Nothing sent to ${audWord()} yet.</td></tr>`; return rows; }
                tbody.innerHTML = rows.map((b) => `
                    <tr>
                        <td>${when(b.created_at)}</td>
                        <td><div class="msg-cell-text" title="${esc(b.body)}">${esc(isEmail ? (b.subject || "") + " - " : "")}${esc(b.body)}</div></td>
                        <td>${b.recipients_total}</td>
                        <td>${b.sent_count}</td>
                        <td>${b.failed_count}${b.failed_count && b.last_error ? ` <span title="${esc(b.last_error)}">&#9432;</span>` : ""}</td>
                        <td>${badge(b.status)}</td>
                    </tr>`).join("");
                return rows;
            } catch (error) {
                tbody.innerHTML = `<tr><td colspan="6" class="table-loading">${esc(error.message)}</td></tr>`;
                return [];
            }
        }

        function showProgress(b) {
            const box = $("msgProgress");
            const done = b.sent_count + b.failed_count;
            const pct = b.recipients_total ? Math.round((done / b.recipients_total) * 100) : 0;
            box.classList.add("show");
            box.querySelector("span.bar").style.width = pct + "%";
            box.querySelector("strong").textContent = b.status === "sending" ? "Sending..." : b.status === "completed" ? "Finished" : "Stopped (" + b.status + ")";
            box.querySelector("p").textContent = `${done} of ${b.recipients_total} done - ${b.sent_count} sent, ${b.failed_count} failed`;
        }

        function follow(id) {
            clearInterval(pollTimer);
            const tick = async () => {
                try {
                    const { broadcast } = await api(`${BASE}/broadcasts/${id}`);
                    showProgress(broadcast);
                    if (broadcast.status !== "sending") {
                        clearInterval(pollTimer);
                        sendBtn.disabled = false;
                        loadHistory();
                        flash(`Done. ${broadcast.sent_count} sent, ${broadcast.failed_count} failed.`, broadcast.failed_count ? "warning" : "success");
                    }
                } catch (error) { /* keep trying */ }
            };
            tick();
            pollTimer = setInterval(tick, 2000);
        }

        function validate() {
            if (isEmail && !subject.value.trim()) { flash("Write the email subject first.", "error"); subject.focus(); return false; }
            if (!body.value.trim()) { flash("Write your message first.", "error"); body.focus(); return false; }
            if (!isEmail && body.value.length > 612) { flash("The SMS is too long. Keep it under 612 characters.", "error"); return false; }
            return true;
        }

        testBtn.addEventListener("click", async () => {
            if (!validate()) return;
            busy(testBtn, true, "Sending test...");
            try {
                const r = await api(`${BASE}/broadcasts`, { method: "POST", body: { channel, subject: subject ? subject.value : "", message: body.value, audience: aud, test: true } });
                flash(r.message);
            } catch (error) { flash(error.message, "error"); } finally { busy(testBtn, false); }
        });

        sendBtn.addEventListener("click", () => {
            if (!validate()) return;
            const src = aud === "dealers" ? overview.dealers : overview.audience;
            const reach = isEmail ? src.withEmail : src.withPhone;
            $("confirmText").innerHTML = `This will send the ${isEmail ? "email" : "SMS"} below to <b>${reach} active ${audWord()}</b>. It cannot be undone once sending starts.`;
            $("confirmPreview").textContent = (isEmail ? subject.value.trim() + "\n\n" : "") + body.value.trim();
            openModal("confirmModal");
        });

        $("confirmSend").addEventListener("click", async () => {
            const button = $("confirmSend");
            busy(button, true, "Starting...");
            try {
                const r = await api(`${BASE}/broadcasts`, { method: "POST", body: { channel, subject: subject ? subject.value : "", message: body.value, audience: aud, confirm: true } });
                closeModal("confirmModal");
                sendBtn.disabled = true;
                flash(r.message);
                follow(r.id);
            } catch (error) {
                closeModal("confirmModal");
                flash(error.message, "error");
            } finally { busy(button, false); }
        });

        ["confirmCancel", "confirmClose", "confirmBackdrop"].forEach((id) => $(id).addEventListener("click", () => closeModal("confirmModal")));
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal("confirmModal"); });
        body.addEventListener("input", updateCounter);
        bindChips();
        updateCounter();

        loadOverview();
        loadHistory().then((rows) => {
            const running = rows.find((b) => b.status === "sending");
            if (running) { sendBtn.disabled = true; follow(running.id); }
        });
    }

    /* ============================================================
       AUTOMATED REMINDER PAGES (item-reminder / restock-reminder)
    ============================================================ */
    function initAutomation() {
        const kind = page;
        const isItem = kind === "item-reminder";
        const f = {
            enabled: $("fEnabled"), timing: $("fTiming"), emailOn: $("fEmailOn"), smsOn: $("fSmsOn"),
            emailSubject: $("fEmailSubject"), emailMessage: $("fEmailMessage"), smsMessage: $("fSmsMessage")
        };

        function syncPanels() {
            [["email", f.emailOn], ["sms", f.smsOn]].forEach(([name, box]) => {
                const panel = $(name + "Panel");
                panel.classList.toggle("on", box.checked);
                panel.classList.toggle("off", !box.checked);
                $(name + "State").textContent = box.checked ? "ON - customers get this " + (name === "email" ? "email" : "SMS") : "OFF - not sent";
            });
        }

        function updateSmsCounter() {
            const i = smsInfo(f.smsMessage.value);
            $("smsCounter").innerHTML = `<span>${i.parts ? i.parts + " SMS per customer" : ""}${i.unicode ? " (emoji or special letters make each SMS shorter)" : ""}</span><strong class="${i.n > 612 ? "over" : ""}">${i.n} / 612</strong>`;
        }

        function updateSwitchText() {
            $("switchState").textContent = f.enabled.checked ? "ON - reminders are being sent automatically" : "OFF - no reminders are sent";
        }

        function fill(data) {
            const s = data.settings;
            f.enabled.checked = !!s.enabled;
            f.timing.value = isItem ? s.delayHours : s.daysAfter;
            f.emailOn.checked = !!s.emailEnabled;
            f.smsOn.checked = !!s.smsEnabled;
            f.emailSubject.value = s.emailSubject || "";
            f.emailMessage.value = s.emailMessage || "";
            f.smsMessage.value = s.smsMessage || "";
            syncPanels();
            updateSmsCounter();
            updateSwitchText();

            $("statDue").textContent = data.dueNow;
            const week = data.lastSevenDays || [];
            const n = (ch, st) => (week.find((w) => w.channel === ch && w.status === st) || { n: 0 }).n;
            $("statEmailWeek").textContent = n("email", "sent");
            $("statSmsWeek").textContent = n("sms", "sent");
            $("statFailedWeek").textContent = n("email", "failed") + n("sms", "failed");

            const warn = [];
            if (!data.email.configured) warn.push("Email is not set up (SMTP_* in .env).");
            if (!data.sms.configured) warn.push("SMS is not set up (AT_USERNAME and AT_API_KEY in .env).");
            const banner = $("msgBanner");
            if (warn.length) { banner.textContent = warn.join(" ") + " A reminder can only go out through a channel that is set up."; banner.classList.add("show"); }
            else banner.classList.remove("show");

            const tbody = $("logBody");
            tbody.innerHTML = (data.recent || []).length
                ? data.recent.map((l) => `
                    <tr>
                        <td>${when(l.created_at)}</td>
                        <td>${esc(l.full_name || "-")}</td>
                        <td>${l.channel === "email" ? "Email" : "SMS"}</td>
                        <td><div class="msg-cell-text" title="${esc(l.detail)}">${esc(l.detail || "")}</div></td>
                        <td>${badge(l.status)}</td>
                    </tr>`).join("")
                : `<tr><td colspan="5" class="table-loading">No reminders sent yet.</td></tr>`;
        }

        const payload = () => ({
            enabled: f.enabled.checked,
            [isItem ? "delayHours" : "daysAfter"]: f.timing.value,
            emailEnabled: f.emailOn.checked,
            smsEnabled: f.smsOn.checked,
            emailSubject: f.emailSubject.value,
            emailMessage: f.emailMessage.value,
            smsMessage: f.smsMessage.value
        });

        async function load() {
            try { fill(await api(`${BASE}/automation/${kind}`)); }
            catch (error) { flash(error.message, "error"); }
        }

        function bindTest(buttonId, channel) {
            $(buttonId).addEventListener("click", async () => {
                const b = $(buttonId);
                busy(b, true, "Sending test...");
                try {
                    const r = await api(`${BASE}/automation/${kind}/test`, { method: "POST", body: { ...payload(), channel } });
                    flash(r.message);
                } catch (error) { flash(error.message, "error"); } finally { busy(b, false); }
            });
        }

        $("saveBtn").addEventListener("click", async () => {
            const b = $("saveBtn");
            busy(b, true, "Saving...");
            try {
                const r = await api(`${BASE}/automation/${kind}`, { method: "PUT", body: payload() });
                flash(r.message);
                await load();
            } catch (error) { flash(error.message, "error"); } finally { busy(b, false); }
        });

        $("runBtn").addEventListener("click", async () => {
            const b = $("runBtn");
            busy(b, true, "Checking...");
            try {
                const r = await api(`${BASE}/automation/run`, { method: "POST", body: {} });
                flash(r.message);
                await load();
            } catch (error) { flash(error.message, "error"); } finally { busy(b, false); }
        });

        bindTest("testEmailBtn", "email");
        bindTest("testSmsBtn", "sms");
        f.enabled.addEventListener("change", updateSwitchText);
        f.emailOn.addEventListener("change", syncPanels);
        f.smsOn.addEventListener("change", syncPanels);
        f.smsMessage.addEventListener("input", updateSmsCounter);
        bindChips();
        load();
    }

    document.addEventListener("DOMContentLoaded", () => {
        if (page === "email" || page === "sms") initBroadcast();
        else if (page === "item-reminder" || page === "restock-reminder") initAutomation();
    });
})();
