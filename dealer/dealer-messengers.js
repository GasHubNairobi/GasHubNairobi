/* =========================================================
   GASHUB EXECUTIVE DEALER MESSENGERS
   File: dealer-messengers.js

   The dealer's list of delivery messengers: full name,
   ID number and phone number. They are saved on the server
   (/api/dealers/riders/mine), so the same list is used on the
   Orders page to assign a messenger to a delivery order, and the
   customer sees that messenger on their order.
   ========================================================= */

(function () {
    "use strict";

    const state = { search: "", status: "", from: "", to: "", editingId: null, list: [], loading: true, open: new Set() };
    const STATUS_LABEL = { on_delivery: "On delivery", pending: "Pending", available: "Available" };
    const STATUS_ICON = { on_delivery: "fa-route", pending: "fa-hourglass-half", available: "fa-circle-check" };
    const ORDER_LABEL = { pending: "Awaiting your confirmation", confirmed: "Waiting to start", processing: "Waiting to start", out_for_delivery: "On delivery", delivered: "Delivered", completed: "Completed", cancelled: "Cancelled", rejected: "Rejected" };

    const token = () => localStorage.getItem("gashub_dealer_token") || "";
    async function api(path, options) {
        const o = options || {};
        const r = await fetch(path, {
            method: o.method || "GET", cache: "no-store",
            headers: Object.assign({ Accept: "application/json", Authorization: "Bearer " + token() }, o.body ? { "Content-Type": "application/json" } : {}),
            body: o.body ? JSON.stringify(o.body) : undefined
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) { const e = new Error("Your session has expired. Please sign in again."); e.unauthorized = true; throw e; }
        if (!r.ok || j.success === false) { const e = new Error(j.message || "Request failed (" + r.status + ")"); e.field = j.field; throw e; }
        return j;
    }

    document.addEventListener("DOMContentLoaded", function () {
        setupMobileSidebarDrawer();
        bindEvents();
        load();
    });

    async function load() {
        try {
            const qs = [state.from && "from=" + state.from, state.to && "to=" + state.to].filter(Boolean).join("&");
            state.list = (await api("/api/dealers/riders/mine" + (qs ? "?" + qs : ""))).riders || [];
        } catch (e) {
            state.list = [];
            banner(e.message || "We could not load your messengers.");
            if (e.unauthorized) setTimeout(() => { window.location.href = "dealer-login.html"; }, 1800);
        }
        state.loading = false;
        render();
    }

    /* ---------- Rendering ---------- */

    const formatPhone = phone => { const d = String(phone || "").replace(/\s/g, ""); return /^\d{10}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : d; };

    function getFiltered() {
        const q = state.search.trim().toLowerCase();
        const qDigits = q.replace(/\D/g, "");
        return state.list.filter(m => {
            if (state.status && m.work_status !== state.status) return false;
            if (!q) return true;
            return m.full_name.toLowerCase().includes(q) ||
                m.id_number.toLowerCase().includes(q) ||
                (m.vehicle_reg || "").toLowerCase().includes(q) ||
                (m.email || "").toLowerCase().includes(q) ||
                (qDigits && m.phone.includes(qDigits));
        });
    }

    function render() {
        const all = state.list;
        const list = getFiltered();

        setText("messengersTotalCount", state.loading ? "—" : all.length);
        renderPeriodTotals();
        const count = st => all.filter(m => m.work_status === st).length;
        setText("messengersOnDeliveryCount", state.loading ? "—" : count("on_delivery"));
        setText("messengersPendingCount", state.loading ? "—" : count("pending"));
        setText("messengersAvailableCount", state.loading ? "—" : count("available"));

        const body = document.getElementById("messengersTableBody");
        const empty = document.getElementById("messengersEmptyState");
        const wrapper = document.querySelector(".dealer-messengers-page .dealer-orders-table-wrapper");

        if (!list.length) {
            body.innerHTML = "";
            if (wrapper) wrapper.hidden = true;
            empty.hidden = false;
            const searching = all.length > 0;
            setText("messengersEmptyHeading", searching ? "No messengers match your search" : "No messengers yet");
            setText("messengersEmptyMessage", searching
                ? "Try a different name, ID number, phone number, vehicle or status."
                : "Add the people who deliver for you. You will then be able to assign them to delivery orders.");
            const addBtn = document.getElementById("btnEmptyAddMessenger");
            if (addBtn) addBtn.hidden = searching;
            return;
        }

        if (wrapper) wrapper.hidden = false;
        empty.hidden = true;

        body.innerHTML = list.map(m => {
            const isOpen = state.open.has(String(m.id));
            const ws = m.work_status || "available";
            return `
            <tr data-id="${esc(m.id)}">
                <td data-label="Full Name">
                    <div class="messenger-name-cell">
                        <span class="messenger-avatar" aria-hidden="true">${esc(initials(m.full_name))}</span>
                        <strong>${esc(m.full_name)}</strong>
                    </div>
                </td>
                <td data-label="ID Number"><code>${esc(m.id_number)}</code></td>
                <td data-label="Phone Number">
                    <a href="tel:${esc(toIntl(m.phone))}" class="customer-phone" title="Call messenger">
                        <i class="fa-solid fa-phone" aria-hidden="true"></i>
                        <span>${esc(formatPhone(m.phone))}</span>
                    </a>
                </td>
                <td data-label="Email">${m.email ? `<a href="mailto:${esc(m.email)}">${esc(m.email)}</a>` : '<span style="color:#b45309">Add email</span>'}</td>
                <td data-label="Vehicle Reg">${m.vehicle_reg ? `<span class="m-vehicle"><i class="fa-solid fa-motorcycle" aria-hidden="true"></i> ${esc(m.vehicle_reg)}</span>` : '<span class="m-vehicle-missing">Add vehicle</span>'}</td>
                <td data-label="Status"><span class="m-status ${esc(ws)}"><i class="fa-solid ${STATUS_ICON[ws] || "fa-circle"}" aria-hidden="true"></i> ${esc(STATUS_LABEL[ws] || ws)}</span></td>
                <td data-label="Orders Summary">
                    <div class="m-summary">
                        <div class="m-summary-line">
                            <span><b>${m.on_delivery_jobs || 0}</b> on delivery</span>
                            <span><b>${m.waiting_jobs || 0}</b> waiting</span>
                            <span><b>${m.delivered_jobs || 0}</b> delivered</span>
                            ${m.cancelled_jobs ? `<span><b>${m.cancelled_jobs}</b> cancelled</span>` : ""}
                        </div>
                        ${hasPeriod() ? `<div class="m-period-line"><b>${m.period_assigned || 0}</b> given in period · <b>${m.period_delivered || 0}</b> delivered${m.period_cancelled ? ` · <b>${m.period_cancelled}</b> cancelled` : ""}${m.period_open ? ` · <b>${m.period_open}</b> still open` : ""}</div>` : ""}
                        <button type="button" class="m-toggle" data-action="toggle" data-id="${esc(m.id)}" aria-expanded="${isOpen}">
                            ${isOpen ? "Hide orders" : `View orders (${hasPeriod() ? (m.period_assigned || 0) : (m.deliveries || 0)})`}
                        </button>
                    </div>
                </td>
                <td data-label="Actions" class="text-center">
                    <div class="table-actions">
                        <button type="button" class="action-btn" data-action="edit" data-id="${esc(m.id)}" title="Edit messenger" aria-label="Edit ${esc(m.full_name)}">
                            <i class="fa-solid fa-pen" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="action-btn btn-reject" data-action="delete" data-id="${esc(m.id)}" title="Remove messenger" aria-label="Remove ${esc(m.full_name)}">
                            <i class="fa-solid fa-trash" aria-hidden="true"></i>
                        </button>
                    </div>
                </td>
            </tr>
            ${isOpen ? `<tr class="m-orders-row"><td colspan="8">${ordersHtml(m)}</td></tr>` : ""}`;
        }).join("");
    }

    const hasPeriod = () => Boolean(state.from || state.to);
    const dayLabel = d => new Date(d + "T00:00:00").toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });
    const isoDay = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

    function renderPeriodTotals() {
        const box = document.getElementById("periodTotals");
        const note = document.getElementById("periodNote");
        if (!box) return;
        if (!hasPeriod()) {
            box.hidden = true;
            if (note) note.textContent = "Showing all time. Pick a period to see how many orders each messenger was given.";
            return;
        }
        const sum = k => state.list.reduce((n, m) => n + Number(m[k] || 0), 0);
        const range = state.from && state.to ? (state.from === state.to ? dayLabel(state.from) : dayLabel(state.from) + " to " + dayLabel(state.to))
            : state.from ? "from " + dayLabel(state.from) : "up to " + dayLabel(state.to);
        if (note) note.textContent = "Orders given to messengers " + range + ".";
        box.hidden = false;
        box.innerHTML = `<span><b>${sum("period_assigned")}</b> orders given</span><span><b>${sum("period_delivered")}</b> delivered</span><span><b>${sum("period_open")}</b> still open</span><span><b>${sum("period_cancelled")}</b> cancelled</span><span>Value delivered: <b>KSh ${Math.round(sum("period_value")).toLocaleString("en-KE")}</b></span>`;
    }

    function setPeriod(from, to) {
        state.from = from || ""; state.to = to || "";
        document.getElementById("periodFrom").value = state.from;
        document.getElementById("periodTo").value = state.to;
        document.querySelectorAll("[data-preset]").forEach(c => c.classList.remove("active"));
        load();
    }

    /* the orders given to one messenger: open ones first, then the latest finished ones */
    function ordersHtml(m) {
        const orders = m.orders || [];
        if (!orders.length) return '<div class="m-orders-empty">No orders have been assigned to this messenger yet.</div>';
        return '<div class="m-orders-list">' + orders.map(o => {
            const place = [o.delivery_address, o.delivery_town].filter(Boolean).join(", ");
            const paid = o.payment_status === "paid" ? "Paid" : "Not paid";
            const when = o.rider_assigned_at ? "Assigned " + fmtTime(o.rider_assigned_at) : "";
            const started = o.dispatched_at ? " · Started " + fmtTime(o.dispatched_at) : "";
            const done = (o.completed_at || o.delivered_at) ? " · Delivered " + fmtTime(o.completed_at || o.delivered_at) : "";
            return `<div class="m-order">
                <div><strong>${esc(o.order_number || o.id)}</strong><small>${esc(o.customer_name || "Customer")}</small></div>
                <div>${esc(o.items || "Order items")}<small>${esc(place || "No address")} · KSh ${Number(o.total_amount || 0).toLocaleString("en-KE")} · ${esc(paid)}</small><small>${esc(when + started + done)}</small></div>
                <span class="m-order-state ${esc(o.status)}">${esc(ORDER_LABEL[o.status] || o.status)}</span>
            </div>`;
        }).join("") + "</div>";
    }

    function fmtTime(v) {
        const d = new Date(v);
        return isNaN(d) ? "" : d.toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    }

    /* ---------- Events ---------- */

    function bindEvents() {
        on("btnAddMessenger", "click", () => openForm(null));
        on("btnEmptyAddMessenger", "click", () => openForm(null));
        on("btnCloseMessengerModal", "click", closeForm);
        on("btnCancelMessenger", "click", closeForm);
        on("messengerForm", "submit", onSubmit);

        const search = document.getElementById("headerSearchInput");
        if (search) search.addEventListener("input", () => {
            state.search = search.value;
            render();
        });

        document.getElementById("messengersTableBody").addEventListener("click", function (e) {
            const btn = e.target.closest("[data-action]");
            if (!btn) return;
            const m = state.list.find(x => String(x.id) === btn.dataset.id);
            if (!m) return;
            if (btn.dataset.action === "toggle") {
                const key = String(m.id);
                if (state.open.has(key)) state.open.delete(key); else state.open.add(key);
                render();
            }
            if (btn.dataset.action === "edit") openForm(m);
            if (btn.dataset.action === "delete") removeMessenger(m);
        });

        document.querySelectorAll("[data-preset]").forEach(btn => btn.addEventListener("click", () => {
            const now = new Date(), p = btn.dataset.preset;
            const from = p === "today" ? now : p === "7" ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6) : new Date(now.getFullYear(), now.getMonth(), 1);
            setPeriod(isoDay(from), isoDay(now));
            btn.classList.add("active");
        }));
        on("btnApplyPeriod", "click", () => {
            const f = document.getElementById("periodFrom").value, t = document.getElementById("periodTo").value;
            if (!f && !t) { banner("Pick a From and/or To date first."); return; }
            if (f && t && f > t) { banner("The From date must be on or before the To date."); return; }
            setPeriod(f, t);
        });
        on("btnClearPeriod", "click", () => setPeriod("", ""));

        document.querySelectorAll(".messengers-filter-bar .messengers-chip").forEach(chip => chip.addEventListener("click", () => {
            state.status = chip.dataset.status || "";
            document.querySelectorAll(".messengers-filter-bar .messengers-chip").forEach(c => c.classList.toggle("active", c === chip));
            render();
        }));

        const overlay = document.getElementById("messengerModal");
        overlay.addEventListener("click", e => { if (e.target === overlay) closeForm(); });
        document.addEventListener("keydown", e => { if (e.key === "Escape") closeForm(); });

        // Clear a field's error as soon as the dealer starts fixing it
        ["FullName", "IdNumber", "Phone", "VehicleReg", "Email"].forEach(f => {
            const input = document.getElementById("messenger" + f);
            if (input) input.addEventListener("input", () => showError(f, ""));
        });
    }

    function openForm(messenger) {
        state.editingId = messenger ? messenger.id : null;
        setText("messengerModalHeading", messenger ? "Edit Messenger" : "Add Messenger");
        document.getElementById("messengerFullName").value = messenger ? messenger.full_name : "";
        document.getElementById("messengerIdNumber").value = messenger ? messenger.id_number : "";
        document.getElementById("messengerPhone").value = messenger ? formatPhone(messenger.phone) : "";
        document.getElementById("messengerVehicleReg").value = messenger ? (messenger.vehicle_reg || "") : "";
        document.getElementById("messengerEmail").value = messenger ? (messenger.email || "") : "";
        ["FullName", "IdNumber", "Phone", "VehicleReg", "Email"].forEach(f => showError(f, ""));
        const modal = document.getElementById("messengerModal");
        modal.hidden = false;
        modal.classList.add("active");
        setTimeout(() => document.getElementById("messengerFullName").focus(), 30);
    }

    function closeForm() {
        const modal = document.getElementById("messengerModal");
        modal.classList.remove("active");
        modal.hidden = true;
        state.editingId = null;
    }

    async function onSubmit(e) {
        e.preventDefault();
        const input = {
            fullName: document.getElementById("messengerFullName").value.trim().replace(/\s+/g, " "),
            idNumber: document.getElementById("messengerIdNumber").value.trim().toUpperCase(),
            phone: document.getElementById("messengerPhone").value.replace(/[\s\-().]/g, ""),
            vehicleReg: document.getElementById("messengerVehicleReg").value.trim().toUpperCase().replace(/\s+/g, " "),
            email: document.getElementById("messengerEmail").value.trim().toLowerCase()
        };
        ["FullName", "IdNumber", "Phone", "VehicleReg", "Email"].forEach(f => showError(f, ""));
        if (input.fullName.split(" ").filter(Boolean).length < 2) { showError("FullName", "Enter the messenger's full name (first and last name)."); return; }
        if (!/^[A-Z0-9]{6,12}$/.test(input.idNumber)) { showError("IdNumber", "Enter a valid ID number (6-12 letters or digits)."); return; }
        if (!/^(\+?254|0)\d{9}$/.test(input.phone)) { showError("Phone", "Enter a valid Kenyan phone number, e.g. 0712 345 678."); return; }
        if (input.vehicleReg && !/^[A-Z0-9][A-Z0-9 \-]{3,11}$/.test(input.vehicleReg)) { showError("VehicleReg", "Enter a valid vehicle registration, e.g. KMDA 123A."); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.email)) { showError("Email", "Enter a valid email address. The delivery link is sent there."); return; }

        const saveBtn = document.getElementById("btnSaveMessenger");
        const editing = Boolean(state.editingId);
        saveBtn.disabled = true;
        try {
            const result = editing
                ? await api("/api/dealers/riders/mine/" + encodeURIComponent(state.editingId), { method: "PUT", body: input })
                : await api("/api/dealers/riders/mine", { method: "POST", body: input });
            closeForm();
            await load();
            banner(editing ? "Messenger details updated." : `${result.rider.full_name} added to your messengers.`);
        } catch (err) {
            const key = { fullName: "FullName", idNumber: "IdNumber", phone: "Phone", vehicleReg: "VehicleReg", email: "Email" }[err.field];
            if (key) showError(key, err.message); else banner(err.message);
        } finally {
            saveBtn.disabled = false;
        }
    }

    async function removeMessenger(m) {
        const jobs = m.active_jobs || 0;
        const extra = jobs
            ? `\n\n${m.full_name} still has ${jobs} open order${jobs === 1 ? "" : "s"}. Those orders will keep showing their name.`
            : "";
        if (!(await GasHubDialog.confirm({ title: "Remove messenger?", message: `Remove ${m.full_name} from your messengers?${extra}`, confirmText: "Remove", tone: "danger" }))) return;
        try {
            await api("/api/dealers/riders/mine/" + encodeURIComponent(m.id), { method: "DELETE" });
            await load();
            banner(`${m.full_name} removed.`);
        } catch (err) {
            banner(err.message);
        }
    }

    /* ---------- Helpers ---------- */

    function showError(field, message) {
        const el = document.getElementById("err" + field);
        const input = document.getElementById("messenger" + field);
        if (!el) return;
        el.textContent = message || "";
        el.hidden = !message;
        if (input) input.classList.toggle("has-error", Boolean(message));
    }

    let bannerTimer;
    function banner(message) {
        const el = document.getElementById("messengersMessage");
        if (!el) return;
        el.textContent = message;
        el.hidden = false;
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => { el.hidden = true; }, 4000);
    }

    function setupMobileSidebarDrawer() {
        const menuBtn = document.getElementById("dealerMobileMenu");
        const sidebar = document.getElementById("dealerSidebar");
        const overlay = document.getElementById("dealerSidebarOverlay");
        const closeBtn = document.getElementById("sidebarCloseBtn");
        if (!menuBtn || !sidebar || !overlay) return;

        function open() {
            sidebar.classList.add("open");
            overlay.classList.add("active");
            menuBtn.setAttribute("aria-expanded", "true");
            document.body.style.overflow = "hidden";
        }
        function close() {
            sidebar.classList.remove("open");
            overlay.classList.remove("active");
            menuBtn.setAttribute("aria-expanded", "false");
            document.body.style.overflow = "";
        }
        menuBtn.addEventListener("click", open);
        overlay.addEventListener("click", close);
        if (closeBtn) closeBtn.addEventListener("click", close);
        document.addEventListener("keydown", e => {
            if (e.key === "Escape" && sidebar.classList.contains("open")) close();
        });
        sidebar.querySelectorAll(".nav-item").forEach(link => {
            link.addEventListener("click", () => { if (window.innerWidth <= 820) close(); });
        });
    }

    function on(id, evt, fn) {
        const el = document.getElementById(id);
        if (el) el.addEventListener(evt, fn);
    }

    function setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = String(text);
    }

    function initials(name) {
        const parts = String(name).trim().split(/\s+/).filter(Boolean);
        return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
    }

    function toIntl(phone) {
        return /^0\d{9}$/.test(phone) ? "+254" + phone.slice(1) : phone;
    }

    function esc(val) {
        return String(val ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
})();
