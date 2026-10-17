/* Admin: customer requests to withdraw GasHub points as M-Pesa money. */
document.addEventListener("DOMContentLoaded", () => {
    const state = { list: [], account: "", rate: 0, fees: { unit: "coins", ranges: [] } };
    const el = {
        message: document.getElementById("wdMessage"),
        body: document.getElementById("wdTableBody"),
        search: document.getElementById("wdSearch"),
        filter: document.getElementById("wdStatusFilter"),
        pending: document.getElementById("statPending"),
        owed: document.getElementById("statOwed"),
        paid: document.getElementById("statPaid"),
        rejected: document.getElementById("statRejected"),
        minInput: document.getElementById("wdMinAmount"),
        minForm: document.getElementById("wdSettingsForm"),
        minSave: document.getElementById("wdMinSave"),
        toggle: document.getElementById("wdToggle"),
        knob: document.getElementById("wdKnob"),
        toggleText: document.getElementById("wdToggleText"),
        rateNote: document.getElementById("wdRateNote"),
        tiers: document.getElementById("wdTiers"), unitBtns: Array.from(document.querySelectorAll("[data-unit]")), unitHint: document.getElementById("wdUnitHint"), maxInput: document.getElementById("wdMaxCoins"), addTier: document.getElementById("wdAddTier"),
        feeForm: document.getElementById("wdFeeForm"), feeSave: document.getElementById("wdFeeSave"), csv: document.getElementById("wdCsv"),
        opensAt: document.getElementById("wdOpensAt"),
        switchForm: document.getElementById("wdSwitchForm"),
        switchSave: document.getElementById("wdSwitchSave"),
        stateTag: document.getElementById("wdStateTag"),
        autoTag: document.getElementById("wdAutoTag"), payAt: document.getElementById("wdPayAt"), schedForm: document.getElementById("wdSchedForm"),
        schedSave: document.getElementById("wdSchedSave"), schedClear: document.getElementById("wdSchedClear"), schedHint: document.getElementById("wdSchedHint"), schedNote: document.getElementById("wdSchedNote")
    };

    /* the admin works in Nairobi time (UTC+3, no daylight saving): convert to and from the datetime-local box */
    const toInput = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 16) : ""; };
    const fromInput = (v) => (v ? new Date(v + ":00+03:00").toISOString() : "");

    function showSwitch(r) {
        const open = r.withdrawals_enabled !== false;
        const waiting = !open && r.opens_at && new Date(r.opens_at) > new Date();
        el.toggle.classList.toggle("on", open);
        el.toggle.setAttribute("aria-pressed", String(open));
        el.knob.textContent = open ? "ON" : "OFF";
        el.toggleText.textContent = open ? "Withdrawals are ON" : (waiting ? "Withdrawals are OFF until " + when(r.opens_at) : "Withdrawals are OFF");
        el.switchForm.hidden = open;
        if (document.activeElement !== el.opensAt) el.opensAt.value = open ? "" : toInput(r.opens_at);
        el.stateTag.className = "wd-state " + (open ? "on" : "off");
        el.stateTag.textContent = open ? "Open" : (waiting ? "Closed until " + when(r.opens_at) : "Closed");
    }

    /* ---------- scheduled payout: one schedule for everything, kept in Payout Planner ---------- */
    const isOpenReq = (w) => w.status === "pending" || w.status === "approved";
    function showSchedule(r) {
        el.autoTag.className = "wd-state " + (r.auto_payout ? "on" : "off");
        el.autoTag.textContent = r.auto_payout ? "Paybill ready" : "Automatic payout not set up";
        GasHubPlannerBanner.render(document.getElementById("wdPlannerBanner"), r.payout_schedule);
    }

    /* ---------- withdrawal charges (ranges) ---------- */
    let feeUnit = "coins";
    let tierData = [];
    const unitName = () => (feeUnit === "ksh" ? "KSh" : "GasHub Coins");
    function lowestInUnit() {
        const min = Number(el.minInput.value) || 1;
        return feeUnit === "ksh" ? min : Math.max(1, Math.ceil(min / (state.rate || 1)));
    }
    function setUnit(u) {
        feeUnit = u === "ksh" ? "ksh" : "coins";
        el.unitBtns.forEach((b) => { const on = b.dataset.unit === feeUnit; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
        el.unitHint.textContent = feeUnit === "ksh"
            ? "Each range is the amount withdrawn in shillings, e.g. 100 to 500."
            : "Each range is the number of GasHub Coins withdrawn, e.g. 100 to 500 coins. Lowest allowed: " + lowestInUnit().toLocaleString("en-KE") + " coins.";
    }
    function tierRow(t, i) {
        const last = i === tierData.length - 1;
        return `<div class="wd-tier" data-i="${i}">
            <div><label>From (${unitName()})</label><input type="number" min="1" step="1" inputmode="numeric" data-from value="${esc(t.from)}" placeholder="e.g. ${lowestInUnit()}"></div>
            <div><label>To (${unitName()})</label><input type="number" min="1" step="1" inputmode="numeric" data-to value="${esc(t.to)}" placeholder="${last ? "empty = and above" : "e.g. 100"}"></div>
            <div><label>Transaction charge (KSh)</label><input type="number" min="0" step="0.01" inputmode="decimal" data-fee value="${esc(t.fee)}" placeholder="e.g. 5"></div>
            <button type="button" class="wd-x" data-del="${i}" aria-label="Remove range">&times;</button>
        </div>`;
    }
    function drawTiers() {
        el.tiers.innerHTML = tierData.length
            ? tierData.map(tierRow).join("")
            : '<p class="table-secondary-text" style="margin:0 0 10px">No charges yet. Withdrawals are free. Click &ldquo;+ Add range&rdquo; to start charging.</p>';
    }
    function readTiers() {
        tierData = Array.from(el.tiers.querySelectorAll(".wd-tier")).map((row) => ({
            from: row.querySelector("[data-from]").value, to: row.querySelector("[data-to]").value, fee: row.querySelector("[data-fee]").value
        }));
    }
    function showFees(r) {
        if (!r || !r.fees) return;
        if (document.activeElement && el.tiers.contains(document.activeElement)) return;      /* never redraw while the admin is typing */
        setUnit(r.fees.unit || "coins");
        tierData = (r.fees.ranges || []).map((x) => ({ from: x.from, to: x.to == null ? "" : x.to, fee: x.fee }));
        drawTiers();
    }
    el.addTier.addEventListener("click", () => {
        readTiers();
        const prev = tierData[tierData.length - 1];
        const start = prev && prev.to !== "" ? Math.floor(Number(prev.to)) + 1 : (prev ? "" : lowestInUnit());
        tierData.push({ from: start, to: "", fee: "" });
        drawTiers();
        const rows = el.tiers.querySelectorAll(".wd-tier"); const last = rows[rows.length - 1];
        if (last) last.querySelector(start === "" ? "[data-from]" : "[data-to]").focus();
    });
    el.tiers.addEventListener("click", (e) => { const b = e.target.closest("[data-del]"); if (!b) return; readTiers(); tierData.splice(Number(b.dataset.del), 1); drawTiers(); });
    el.unitBtns.forEach((b) => b.addEventListener("click", () => { readTiers(); setUnit(b.dataset.unit); drawTiers(); }));
    el.feeForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        readTiers();
        el.feeSave.disabled = true;
        try {
            const r = await GasHubAdmin.adminApiRequest("/api/admin/withdrawals/settings", { method: "PUT", body: { fees: { unit: feeUnit, tiers: tierData } } });
            el.feeSave.blur(); showFees(r); await load();
            showMessage(r.message || "Saved.", "success");
        } catch (error) {
            showMessage(error.message || "Unable to save the charges.", "error");
        } finally { el.feeSave.disabled = false; }
    });

    /* ---------- records download (CSV of what is on screen) ---------- */
    el.csv.addEventListener("click", () => {
        const term = String(el.search.value || "").trim().toLowerCase(), status = el.filter.value;
        const rows = state.list.filter((w) => (!status || w.status === status) && (!term || [w.reference, w.customer_name, w.customer_email, w.phone].join(" ").toLowerCase().includes(term)));
        const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
        const head = ["Reference", "Customer", "Email", "M-Pesa", "Coins", "Amount KSh", "Charge KSh", "Sent KSh", "Status", "Note", "Requested", "Processed", "Processed by"];
        const lines = [head.map(q).join(",")].concat(rows.map((w) => [w.reference, w.customer_name, w.customer_email, w.phone, w.points, w.amount_ksh, w.fee_ksh, w.net_ksh, LABEL[w.status] || w.status, w.admin_note, w.created_at, w.processed_at || "", w.processed_by].map(q).join(",")));
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
        a.download = "gashub-withdrawals-" + new Date().toISOString().slice(0, 10) + ".csv";
        document.body.appendChild(a); a.click(); a.remove();
    });

    function showPayout(r) {
        if (r.current_rate_ksh) { state.rate = r.current_rate_ksh; el.rateNote.textContent = "Current rate: 1 point = KSh " + ksh(r.current_rate_ksh) + ". Open requests (waiting or approved) are worked out at this rate."; el.rateNote.hidden = false; }
    }    const esc = (v) => GasHubAdmin.escapeHtml(v === null || v === undefined ? "" : String(v));
    const ksh = (n) => (Number(n) || 0).toLocaleString("en-KE", { maximumFractionDigits: 2 });

    function showMessage(message, type = "error") {
        if (!message) { el.message.textContent = ""; el.message.className = "admin-message"; el.message.style.display = "none"; return; }
        el.message.textContent = message; el.message.className = `admin-message ${type}`; el.message.style.display = "block";
    }

    const LABEL = { pending: "Waiting", approved: "Approved", paid: "Paid", rejected: "Rejected" };
    const TONE = { pending: "warning", approved: "neutral", paid: "success", rejected: "danger" };
    const badge = (s) => `<span class="status-badge ${TONE[s] || "neutral"}">${esc(LABEL[s] || s)}</span>`;
    const when = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toLocaleString("en-KE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; };

    function stats() {
        const L = state.list;
        el.pending.textContent = L.filter((w) => w.status === "pending").length;
        el.owed.textContent = ksh(L.filter((w) => w.status === "pending" || w.status === "approved").reduce((s, w) => s + w.amount_ksh, 0));
        el.paid.textContent = ksh(L.filter((w) => w.status === "paid").reduce((s, w) => s + w.amount_ksh, 0));
        el.rejected.textContent = L.filter((w) => w.status === "rejected").length;
    }

    function actions(w) {
        if (w.status === "paid" || w.status === "rejected") return `<span class="table-secondary-text">${esc(w.processed_by ? "By " + w.processed_by : "")}</span>`;
        if (w.payout_state === "sending" && !w.payout_stale) return `<span class="wd-sending">Sending to M-Pesa...</span>`;
        const again = w.payout_state === "failed" || w.payout_stale;
        return `<div class="wd-actions">
            <button type="button" class="link-button go" data-id="${esc(w.id)}" data-act="send">${again ? "Send again" : "Send now"}</button>
            ${w.status === "pending" ? `<button type="button" class="link-button" data-id="${esc(w.id)}" data-act="approved">Approve</button>` : ""}
            <button type="button" class="link-button ok" data-id="${esc(w.id)}" data-act="paid">Mark paid</button>
            <button type="button" class="link-button no" data-id="${esc(w.id)}" data-act="rejected">Reject</button>
        </div>`;
    }
    function payNote(w) {
        if (!isOpenReq(w)) return "";
        if (w.payout_state === "sending" && !w.payout_stale) return `<div class="table-secondary-text wd-sending">Sending to M-Pesa...</div>`;
        if (w.payout_stale) return `<div class="table-secondary-text wd-fail">No answer from M-Pesa yet. Check your M-Pesa statement, then Mark paid or Send again.</div>`;
        if (w.payout_state === "failed") return `<div class="table-secondary-text wd-fail wd-note">Payment failed: ${esc(w.payout_error || "M-Pesa could not send the money.")}</div>`;
        return "";
    }

    function render() {
        const term = String(el.search.value || "").trim().toLowerCase();
        const status = el.filter.value;
        const rows = state.list.filter((w) =>
            (!status || w.status === status) &&
            (!term || [w.reference, w.customer_name, w.customer_email, w.phone].join(" ").toLowerCase().includes(term)));
        if (!rows.length) { el.body.innerHTML = `<tr><td colspan="8" class="table-empty">No withdrawal requests found.</td></tr>`; return; }
        el.body.innerHTML = rows.map((w) => `
            <tr>
                <td><span class="table-code">${esc(w.reference)}</span></td>
                <td><div class="table-primary-text">${esc(w.customer_name)}</div><div class="table-secondary-text">${esc(w.customer_email)}</div></td>
                <td><span class="wd-phone">${esc(w.phone)}</span></td>
                <td><div class="table-primary-text">KSh ${esc(ksh(w.net_ksh))}</div><div class="table-secondary-text">KSh ${esc(ksh(w.amount_ksh))} less KSh ${esc(ksh(w.fee_ksh))} charge</div><div class="table-secondary-text">at KSh ${esc(ksh(w.rate_ksh))} per point</div></td>
                <td>${esc(w.points.toLocaleString("en-KE"))}</td>
                <td>${badge(w.status)}${payNote(w)}${w.admin_note ? `<div class="table-secondary-text wd-note">${esc(w.admin_note)}</div>` : ""}</td>
                <td>${esc(when(w.created_at))}</td>
                <td>${actions(w)}</td>
            </tr>`).join("");
    }

    /* while a payment is on its way to M-Pesa, check every few seconds so the row turns Paid by itself */
    let poll = null;
    function pollIfNeeded() {
        const any = state.list.some((w) => isOpenReq(w) && w.payout_state === "sending" && !w.payout_stale);
        if (any && !poll) poll = setInterval(() => load(true), 5000);
        else if (!any && poll) { clearInterval(poll); poll = null; }
    }

    async function load(quiet) {
        try {
            if (!quiet) showMessage("");
            const before = new Map(state.list.map((w) => [String(w.id), w.payout_state]));
            const r = await GasHubAdmin.adminApiRequest("/api/admin/withdrawals");
            state.list = Array.isArray(r?.withdrawals) ? r.withdrawals : [];
            if (quiet) state.list.forEach((w) => {
                if (before.get(String(w.id)) !== "sending") return;
                if (w.status === "paid") showMessage(`${w.customer_name} was paid KSh ${ksh(w.net_ksh)}. ${w.admin_note || ""}`.trim(), "success");
                else if (w.payout_state === "failed") showMessage(`The payment to ${w.customer_name} failed: ${w.payout_error || "M-Pesa could not send the money."}`, "error");
            });
            if (r) { showSwitch(r); showPayout(r); showSchedule(r); }
            if (r && r.min_amount_ksh != null && document.activeElement !== el.minInput) el.minInput.value = r.min_amount_ksh;
            if (r) { if (document.activeElement !== el.maxInput) el.maxInput.value = r.max_coins == null ? "" : r.max_coins; showFees(r); }
            stats(); render(); pollIfNeeded();
        } catch (error) {
            if (quiet === true) return;                      /* a quiet refresh that fails changes nothing */
            state.list = []; stats();
            el.body.innerHTML = `<tr><td colspan="8" class="table-empty">Failed to load withdrawals.</td></tr>`;
            showMessage(error.message || "Failed to load withdrawals.", "error");
        }
    }

    el.body.addEventListener("click", async (event) => {
        const btn = event.target.closest("button[data-act]");
        if (!btn) return;
        const w = state.list.find((x) => String(x.id) === btn.dataset.id);
        if (!w) return;
        const act = btn.dataset.act;
        let note = "";

        if (act === "send") {
            const retry = w.payout_state === "failed" || w.payout_stale;
            if (!(await GasHubDialog.confirm({ title: retry ? "Send this payment again?" : "Send the money now?", message: `KSh ${ksh(w.net_ksh)} (KSh ${ksh(w.amount_ksh)} less KSh ${ksh(w.fee_ksh)} charge, at today\u2019s rate) will be sent to ${w.phone} (${w.customer_name}) by M-Pesa right now. It is marked Paid when M-Pesa confirms, and the customer is told by email and SMS.` + (retry ? " Check your M-Pesa statement first so the customer is not paid twice." : ""), confirmText: retry ? "Send again" : "Send now", tone: "primary" }))) return;
            btn.disabled = true;
            try {
                const r = await GasHubAdmin.adminApiRequest(`/api/admin/withdrawals/${encodeURIComponent(w.id)}/send-now`, { method: "POST", body: {} });
                Object.assign(w, r.withdrawal || {});
                stats(); render(); pollIfNeeded();
                showMessage(r.message || "Sending.", "success");
            } catch (error) {
                btn.disabled = false;
                showMessage(error.message || "Unable to send this payment.", "error");
                load(true);
            }
            return;
        }
        if (act === "approved") {
            if (!(await GasHubDialog.confirm({ title: "Approve this request?", message: `${w.customer_name} will receive KSh ${ksh(w.net_ksh)} to ${w.phone} (KSh ${ksh(w.amount_ksh)} less KSh ${ksh(w.fee_ksh)} charge). The amount is worked out at today\u2019s rate. Mark it Paid after you send the money.`, confirmText: "Approve", tone: "primary" }))) return;
        } else if (act === "paid") {
            note = await GasHubDialog.prompt({ title: "Mark as paid", message: `Send KSh ${ksh(w.net_ksh)} (KSh ${ksh(w.amount_ksh)} less KSh ${ksh(w.fee_ksh)} charge, from ${w.points.toLocaleString("en-KE")} coins at today\u2019s rate) to ${w.phone} (${w.customer_name}) by M-Pesa` + `, then enter the receipt code.`, label: "M-Pesa receipt code", placeholder: "e.g. QGH7XK2LMN", confirmText: "Mark as paid", requiredMessage: "Enter the receipt code." });
            if (note === null || note === undefined) return;
            note = "M-Pesa code " + String(note).trim();
        } else {
            note = await GasHubDialog.prompt({ title: "Reject this request", message: "The customer will see this reason and their points will be returned.", label: "Reason", placeholder: "e.g. Number does not match your registered name", confirmText: "Reject and return points", requiredMessage: "Give a short reason." });
            if (note === null || note === undefined) return;
            note = String(note).trim();
        }

        btn.disabled = true;
        try {
            const r = await GasHubAdmin.adminApiRequest(`/api/admin/withdrawals/${encodeURIComponent(w.id)}`, { method: "PATCH", body: { status: act, note } });
            Object.assign(w, r.withdrawal || {});
            stats(); render();
            showMessage(r.message || "Updated.", "success");
        } catch (error) {
            btn.disabled = false;
            showMessage(error.message || "Unable to update this request.", "error");
        }
    });

    el.minForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const n = Number(el.minInput.value);
        if (!Number.isInteger(n) || n < 1) { showMessage("Enter the lowest amount as a whole number of shillings, 1 or more."); return; }
        el.minSave.disabled = true;
        try {
            const r = await GasHubAdmin.adminApiRequest("/api/admin/withdrawals/settings", { method: "PUT", body: { min_amount_ksh: n, max_coins: el.maxInput.value.trim() } });
            el.minInput.value = r.min_amount_ksh;
            el.maxInput.value = r.max_coins == null ? "" : r.max_coins;
            readTiers(); setUnit(feeUnit);
            showMessage(r.message || "Saved.", "success");
        } catch (error) {
            showMessage(error.message || "Unable to save the setting.", "error");
        } finally { el.minSave.disabled = false; }
    });

    /* the ON/OFF button saves straight away, no extra confirmation */
    el.toggle.addEventListener("click", async () => {
        const wantOpen = !el.toggle.classList.contains("on");
        el.toggle.disabled = true;
        try {
            const r = await GasHubAdmin.adminApiRequest("/api/admin/withdrawals/settings", { method: "PUT", body: { withdrawals_enabled: wantOpen, opens_at: "" } });
            showSwitch(r);
            showMessage(r.message || "Saved.", "success");
        } catch (error) {
            showMessage(error.message || "Unable to change withdrawals.", "error");
        } finally { el.toggle.disabled = false; }
    });

    /* while OFF the admin can set when they open again */
    el.switchForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const opens_at = fromInput(el.opensAt.value);
        if (opens_at && new Date(opens_at) <= new Date()) { showMessage("Choose a reopening time that is in the future."); return; }
        el.switchSave.disabled = true;
        try {
            const r = await GasHubAdmin.adminApiRequest("/api/admin/withdrawals/settings", { method: "PUT", body: { withdrawals_enabled: false, opens_at } });
            showSwitch(r);
            showMessage(r.message || "Saved.", "success");
        } catch (error) {
            showMessage(error.message || "Unable to save the setting.", "error");
        } finally { el.switchSave.disabled = false; }
    });

    el.search.addEventListener("input", render);
    el.filter.addEventListener("change", render);
    load();
});
