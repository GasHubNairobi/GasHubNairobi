/* Admin: Payout Planner. See backend/controllers/payout-planner-controller.js */
document.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);
    const esc = (v) => GasHubAdmin.escapeHtml(v === null || v === undefined ? "" : String(v));
    const kes = (n) => Number(n || 0).toLocaleString("en-KE", { maximumFractionDigits: 0 });
    const api = (url, opts) => GasHubAdmin.adminApiRequest(url, opts);
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    /* the admin works in Nairobi time (UTC+3, no daylight saving) */
    const toInput = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 16) : ""; };
    const fromInput = (v) => (v ? new Date(v + ":00+03:00").toISOString() : "");
    const when = (iso) => iso ? new Date(iso).toLocaleString("en-KE", { timeZone: "Africa/Nairobi", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " (Nairobi)" : "";
    let data = null;

    function msg(text, type) {
        const m = $("ppMessage");
        m.textContent = text; m.className = "admin-message show " + (type || "error");
        clearTimeout(msg.t); msg.t = setTimeout(() => { m.className = "admin-message"; }, 7000);
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    /* ---------- 1. the calculation ---------- */
    function showTotals(d) {
        const t = d.totals, c = d.config;
        $("ppNeeded").textContent = kes(t.needed);
        $("ppBalance").textContent = t.estimated_balance === null ? "-" : kes(t.estimated_balance);
        $("ppShort").textContent = kes(t.shortfall);
        $("ppCount").textContent = t.payments;
        const tag = $("ppFundTag");
        if (t.payments === 0) { tag.className = "pp-tag off"; tag.textContent = "Nothing to pay"; }
        else if (t.estimated_balance === null) { tag.className = "pp-tag bad"; tag.textContent = "Enter your Paybill balance"; }
        else if (t.shortfall > 0) { tag.className = "pp-tag bad"; tag.textContent = "Deposit KSh " + kes(t.shortfall) + " more"; }
        else { tag.className = "pp-tag on"; tag.textContent = "Funded"; }

        const row = (label, val, cls) => `<tr class="${cls || ""}"><td>${label}</td><td>${val}</td></tr>`;
        let h = "";
        h += row(`Customer withdrawals (${t.customers_count})`, "KSh " + kes(t.customers_counted));
        if (!c.customers.only_approved) h += row(`of which approved (confirmed) KSh ${kes(t.customers_confirmed)}, still waiting KSh ${kes(t.customers_waiting)}`, "", "sub");
        else if (t.customers_waiting) h += row(`Not counted: ${kes(t.customers_waiting)} still waiting for your approval`, "", "sub");
        h += row(`Dealer payouts, sent automatically (${t.dealers_count})`, "KSh " + kes(t.dealers_counted));
        h += row(`M-Pesa charges (${t.payments} × KSh ${c.fee_per_payment})`, "KSh " + kes(t.fees));
        if (c.buffer_pct) h += row(`Safety extra (${c.buffer_pct}%)`, "KSh " + kes(t.buffer));
        h += row("Total the Paybill must hold", "KSh " + kes(t.needed), "total");
        if (t.estimated_balance !== null) {
            h += row(`Paybill now (you entered KSh ${kes(c.float.balance)}, ${when(c.float.at)}; KSh ${kes(t.sent_since)} sent since)`, "KSh " + kes(t.estimated_balance), "sub");
            h += t.shortfall > 0 ? row("Deposit this much more", "KSh " + kes(t.shortfall), "total short") : row("Enough in the Paybill", "OK", "total ok");
        }
        if (t.dealers_manual || t.customers_manual) h += row(`Pay by hand (Paybill/Till destination, or over the KSh ${kes(d.max_per_payment)} limit): not in the total`, "KSh " + kes(t.dealers_manual + t.customers_manual), "sub");
        $("ppSum").innerHTML = h;
        if (document.activeElement !== $("ppFee")) $("ppFee").value = c.fee_per_payment || "";
        if (document.activeElement !== $("ppBuf")) $("ppBuf").value = c.buffer_pct || "";
        $("ppBalNote").textContent = c.float.at ? "Last entered " + when(c.float.at) + ". Update it after each top-up." : "Type what your M-Pesa portal shows, then press Save.";
    }
    $("ppFundsForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = { fee_per_payment: $("ppFee").value === "" ? 0 : $("ppFee").value, buffer_pct: $("ppBuf").value === "" ? 0 : $("ppBuf").value };
        if ($("ppBal").value !== "") body.balance = $("ppBal").value;
        $("ppFundsSave").disabled = true;
        try { const r = await api("/api/admin/payout-planner/funds", { method: "PUT", body }); $("ppBal").value = ""; msg(r.message || "Saved.", "success"); await load(); }
        catch (err) { msg(err.message || "Unable to save."); } finally { $("ppFundsSave").disabled = false; }
    });

    /* ---------- 2. the two schedules ---------- */
    function schedHtml(who, s, next) {
        const mode = s.mode;
        const opts = [["off", "Off (I will pay by hand)"], ["once", "Once, on a date"], ["daily", "Every day"], ["weekly", "Every week"]]
            .map(([v, l]) => `<option value="${v}"${v === mode ? " selected" : ""}>${l}</option>`).join("");
        const days = DAYS.map((n, i) => `<option value="${i}"${Number(s.day) === i ? " selected" : ""}>${n}</option>`).join("");
        return `
            <div><label>When should the money be sent?</label><select name="mode">${opts}</select></div>
            <div class="pp-row" data-show="once"><div style="grid-column:1/-1"><label>Date and time (Nairobi)</label><input type="datetime-local" name="at" value="${esc(toInput(s.at))}"></div></div>
            <div class="pp-row" data-show="weekly"><div><label>Day</label><select name="day">${days}</select></div><div><label>Time (Nairobi)</label><input type="time" name="time_w" value="${esc(s.time || "10:00")}"></div></div>
            <div class="pp-row" data-show="daily"><div><label>Time (Nairobi)</label><input type="time" name="time_d" value="${esc(s.time || "10:00")}"></div></div>
            ${who === "customers" ? `<label class="pp-check"><input type="checkbox" name="only_approved"${s.only_approved ? " checked" : ""}><span>Send only requests I have approved<br><small>Leave unticked to also send requests that are still waiting.</small></span></label>` : ""}
            <div class="pp-next">${mode === "off" ? "Not scheduled. Nothing is sent automatically." : next ? "Next run: <strong>" + esc(when(next)) + "</strong>" : "No upcoming run."}</div>
            ${s.last_result ? `<div class="pp-last">Last run${s.last_run_at ? " (" + esc(when(s.last_run_at)) + ")" : ""}: ${esc(s.last_result)}</div>` : ""}
            <div class="pp-actions">
                <button type="submit" class="link-button ok">Save schedule</button>
                <button type="button" class="link-button go" data-run="${who}">Send now</button>
            </div>`;
    }
    function syncVisible(form) {
        const mode = form.elements.mode.value;
        form.querySelectorAll("[data-show]").forEach((r) => { r.hidden = r.dataset.show !== mode; });
    }
    function showSchedules(d) {
        document.querySelectorAll(".pp-sched").forEach((form) => {
            const who = form.dataset.who;
            if (form.contains(document.activeElement)) return;      /* do not rebuild while the admin is typing */
            form.innerHTML = schedHtml(who, d.config[who], d.next[who]);
            syncVisible(form);
        });
        const tag = (id, s) => { const el = $(id); el.className = "pp-tag " + (s.mode === "off" ? "off" : "on"); el.textContent = s.mode === "off" ? "Off" : s.mode === "once" ? "Once" : s.mode === "daily" ? "Every day" : "Every week"; };
        tag("ppTagCustomers", d.config.customers); tag("ppTagDealers", d.config.dealers);
    }
    document.querySelectorAll(".pp-sched").forEach((form) => {
        form.addEventListener("change", (e) => { if (e.target.name === "mode") syncVisible(form); });
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const f = form.elements, mode = f.mode.value;
            const body = { who: form.dataset.who, mode };
            if (mode === "once") body.at = fromInput(f.at.value);
            if (mode === "weekly") { body.day = f.day.value; body.time = f.time_w.value; }
            if (mode === "daily") body.time = f.time_d.value;
            if (form.dataset.who === "customers") body.only_approved = f.only_approved.checked;
            try { const r = await api("/api/admin/payout-planner/schedule", { method: "PUT", body }); msg(r.message || "Saved.", "success"); form.querySelector("button").blur(); await load(true); }
            catch (err) { msg(err.message || "Unable to save the schedule."); }
        });
        form.addEventListener("click", async (e) => {
            const b = e.target.closest("[data-run]");
            if (!b) return;
            const who = b.dataset.run, t = data.totals;
            const text = who === "customers"
                ? `Send ${t.customers_count} customer payment${t.customers_count === 1 ? "" : "s"} (KSh ${kes(t.customers_counted)}) to M-Pesa right now? Make sure the Paybill holds enough.`
                : `Create payouts for every dealer with money ready (about KSh ${kes(t.dealers_counted)}) and send them to M-Pesa right now? Make sure the Paybill holds enough.`;
            const ok = window.GasHubDialog && GasHubDialog.confirm ? await GasHubDialog.confirm(text) : window.confirm(text);
            if (!ok) return;
            b.disabled = true;
            try { const r = await api("/api/admin/payout-planner/run", { method: "POST", body: { who } }); msg(r.message || "Done.", "success"); await load(true); }
            catch (err) { msg(err.message || "Unable to send."); } finally { b.disabled = false; }
        });
    });

    /* ---------- the two lists ---------- */
    const statePill = { ready: ["Approved", "good"], scheduled: ["Scheduled", "good"], earned: ["Earned: next run makes the payout", "good"], held: ["On hold (not counted)", "warn"], sending: ["Sending to M-Pesa", "warn"], failed: ["Failed: Send again", "bad"], no_destination: ["No payout number saved", "bad"], below_minimum: ["Below minimum, rolls over", "warn"] };
    function showLists(d) {
        $("ppCustBody").innerHTML = d.customers.length ? d.customers.map((c) => {
            const [label, cls] = c.over_limit ? ["Over limit: pay by hand", "bad"] : c.state !== "ready" ? statePill[c.state] : c.confirmed ? ["Approved", "good"] : c.counted ? ["Waiting (counted)", "warn"] : ["Waiting (not counted)", ""];
            return `<tr><td>${esc(c.reference)}</td><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td><span class="pp-pill ${cls}">${esc(label)}</span>${c.error ? `<div class="pp-muted">${esc(c.error)}</div>` : ""}</td>
                <td class="pp-num">${kes(c.gross)}</td><td class="pp-num">${kes(c.fee)}</td><td class="pp-num">${kes(c.send)}</td></tr>`;
        }).join("") : `<tr><td colspan="7" class="table-empty">No open withdrawal requests.</td></tr>`;
        $("ppDealBody").innerHTML = d.dealers.length ? d.dealers.map((x) => {
            const [label, cls] = statePill[x.state] || [x.state, ""];
            return `<tr><td>${esc(x.name)}</td><td>${x.kind === "payout" ? "Payout " + esc(x.reference) : "Earned (" + x.orders + " orders)"}</td><td>${esc(x.destination || "-")}</td>
                <td>${x.auto ? "Automatic" : "By hand"}</td><td><span class="pp-pill ${cls}">${esc(label)}</span>${x.error ? `<div class="pp-muted">${esc(x.error)}</div>` : ""}</td><td class="pp-num">${kes(x.send)}</td></tr>`;
        }).join("") : `<tr><td colspan="6" class="table-empty">No dealer money is waiting to be paid.</td></tr>`;
    }

    async function load(force) {
        try {
            const d = await api("/api/admin/payout-planner");
            data = d;
            showTotals(d); showLists(d);
            const rt = d.routes || {}, tag = $("ppRouteTag");
            tag.className = "pp-tag " + (rt.separated ? "on" : "bad"); tag.textContent = rt.separated ? "Separate" : "Fix needed";
            $("ppRoutes").innerHTML = "Customer payments go IN to the Till <strong>" + esc(rt.till || "not set") + "</strong>. Payouts and refunds go OUT of the Paybill <strong>" + esc(rt.paybill || "not set") + "</strong>. They are different accounts and never share a route." +
                (rt.problems && rt.problems.length ? '<br><span style="color:#dc2f45;font-weight:600">' + rt.problems.map(esc).join("<br>") + "</span>" : "");
            if (force) document.activeElement && document.activeElement.blur && document.activeElement.blur();
            showSchedules(d);
            if (!d.b2c_ready) msg("Automatic M-Pesa sending (B2C) is not set up yet, so schedules cannot be switched on. The deposit calculation still works. See PAYOUT-PLANNER.md.", "error");
        } catch (err) { msg(err.message || "Unable to load the planner."); }
    }
    load();
    setInterval(() => { if (!document.hidden) load(); }, 60000);
});
