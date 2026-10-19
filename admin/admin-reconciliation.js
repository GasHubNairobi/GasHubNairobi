/* Admin: Daily Money Check. Read-only: shows how much money moved on a day and lists anything that does not line up. */
document.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);
    const el = {
        date: $("rcDate"), refresh: $("rcRefresh"), print: $("rcPrint"), message: $("rcMessage"), banner: $("rcBanner"),
        received: $("rcReceived"), dealers: $("rcDealers"), withdrawals: $("rcWithdrawals"), refunds: $("rcRefunds"),
        methods: $("rcMethods"), dayLabel: $("rcDayLabel"), net: $("rcNet"), issues: $("rcIssues"), checked: $("rcChecked")
    };
    const ksh = (n) => Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
    const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v);
    const cell = (v) => {
        if (v == null || v === "") return "-";
        if (isDate(v)) return new Date(v).toLocaleString("en-KE", { timeZone: "Africa/Nairobi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
        if (typeof v === "number" || /^-?\d+\.\d+$/.test(String(v))) return ksh(v);
        return esc(v);
    };
    const nairobiToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

    function message(text, type) {
        el.message.textContent = text || "";
        el.message.className = "admin-message" + (text ? " show " + (type || "error") : "");
    }

    function render(r) {
        const t = r.totals || {};
        el.received.textContent = ksh(t.receivedOnline);
        el.dealers.textContent = ksh(t.dealerPayouts && t.dealerPayouts.total);
        el.withdrawals.textContent = ksh(t.withdrawals && t.withdrawals.total);
        el.refunds.textContent = ksh(t.refunds && t.refunds.total);

        const rows = (t.receivedByMethod || []).map((m) =>
            `<div class="rc-method"><span>${esc(m.method)} (${m.count} payment${m.count === 1 ? "" : "s"})</span><strong>KSh ${ksh(m.total)}</strong></div>`).join("");
        el.methods.innerHTML = rows || '<p class="rc-note">No payments were recorded on this day.</p>';
        const cashNote = t.cashRecorded ? ` Cash recorded on delivery: KSh ${ksh(t.cashRecorded)} (not counted above, it goes to the dealer).` : "";
        el.net.textContent = `Received online, minus dealer payouts, customer withdrawals and refunds sent today: KSh ${ksh(t.net)}. A negative number just means more went out today than came in; it is not an error by itself.` + cashNote +
            (t.unavailable && t.unavailable.length ? ` Some figures could not be read (${t.unavailable.join(", ")}).` : "");

        if (el.dayLabel && r.date) el.dayLabel.textContent = new Date(r.date + "T12:00:00Z").toLocaleDateString("en-KE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
        const s = r.summary || {};
        if (s.problems > 0) { el.banner.className = "rc-banner bad"; el.banner.textContent = `${s.problems} thing${s.problems === 1 ? "" : "s"} need${s.problems === 1 ? "s" : ""} your attention now` + (s.watch ? `, and ${s.watch} to keep an eye on.` : "."); }
        else if (s.watch > 0) { el.banner.className = "rc-banner watch"; el.banner.textContent = `No money problems found, but ${s.watch} thing${s.watch === 1 ? "" : "s"} to keep an eye on.`; }
        else { el.banner.className = "rc-banner ok"; el.banner.textContent = "All clear. Nothing looks wrong with the money."; }
        if (s.couldNotRun) el.banner.textContent += ` (${s.couldNotRun} check${s.couldNotRun === 1 ? "" : "s"} could not run.)`;

        const okIcon = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#dcfce7"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#16a34a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const offIcon = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#e2e8f0"/><path d="M12 7v6M12 16.5v.5" stroke="#64748b" stroke-width="2.4" stroke-linecap="round"/></svg>';
        const list = r.issues || [];
        const bad = list.filter((c) => !c.error && c.count > 0).sort((a, b) => (a.severity === "high" ? 0 : 1) - (b.severity === "high" ? 0 : 1));
        const fine = list.filter((c) => c.error || c.count === 0);
        const card = (c) => {
            const tag = `<span class="rc-tag ${c.severity}">${c.severity === "high" ? "Needs attention" : "Keep an eye"} &middot; ${c.count}</span>`;
            const body = `<p class="rc-help">${esc(c.help)}</p><div class="admin-table-wrapper"><table class="admin-table"><thead><tr>` +
                c.cols.map((k) => `<th>${esc(k[1])}</th>`).join("") + "</tr></thead><tbody>" +
                c.rows.map((row) => "<tr>" + c.cols.map((k) => `<td>${cell(row[k[0]])}</td>`).join("") + "</tr>").join("") + "</tbody></table></div>";
            return `<div class="rc-issue ${c.severity}"><h3>${esc(c.title)} ${tag}</h3>${body}</div>`;
        };
        el.issues.innerHTML =
            (bad.length ? '<div class="rc-section">Needs a look (' + bad.length + ")</div>" + bad.map(card).join("") : "") +
            (fine.length ? '<div class="rc-section">Checks that are fine (' + fine.length + ')</div><div class="rc-oks">' +
                fine.map((c) => `<div class="rc-ok${c.error ? " off" : ""}">${c.error ? offIcon : okIcon}<span>${esc(c.title)}${c.error ? " (could not run)" : ""}</span></div>`).join("") + "</div>" : "");

        el.checked.textContent = "Checked " + new Date(r.checkedAt).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" }) + " (Nairobi time). This page only reads the records; it never changes any money.";
    }

    async function load() {
        message("");
        el.refresh.disabled = true;
        el.banner.className = "rc-banner watch";
        el.banner.textContent = "Checking the money...";
        try {
            const r = await GasHubAdmin.adminApiRequest("/api/admin/reconciliation?date=" + encodeURIComponent(el.date.value || nairobiToday()));
            if (!r || r.success === false) throw new Error((r && r.message) || "Unable to build the daily money check.");
            render(r);
        } catch (error) {
            el.banner.className = "rc-banner bad";
            el.banner.textContent = "The check could not be completed.";
            message(error.message || "Unable to build the daily money check.", "error");
        } finally { el.refresh.disabled = false; }
    }

    el.date.value = nairobiToday();
    el.date.max = nairobiToday();
    el.refresh.addEventListener("click", load);
    el.date.addEventListener("change", load);
    el.print.addEventListener("click", () => window.print());
    load();
});
