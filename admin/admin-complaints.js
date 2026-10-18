document.addEventListener("DOMContentLoaded", () => {
    const state = {
        complaints: [],
        filteredComplaints: [],
        currentPage: 1,
        pageSize: 10,
        selectedComplaintId: null
    };

    const elements = {
        message: document.getElementById("complaintsMessage"),

        totalComplaints: document.getElementById("totalComplaints"),
        pendingComplaints: document.getElementById("pendingComplaints"),
        inProgressComplaints: document.getElementById("inProgressComplaints"),
        resolvedComplaints: document.getElementById("resolvedComplaints"),

        search: document.getElementById("complaintSearch"),
        statusFilter: document.getElementById("complaintStatusFilter"),

        tableBody: document.getElementById("complaintsTableBody"),

        paginationInfo: document.getElementById("complaintsPaginationInfo"),
        paginationButtons: document.getElementById("complaintsPaginationButtons"),

        detailsModal: document.getElementById("complaintDetailsModal"),
        modalBackdrop: document.getElementById("complaintModalBackdrop"),
        modalTitle: document.getElementById("complaintModalTitle"),
        modalSubtitle: document.getElementById("complaintModalSubtitle"),
        detailsBody: document.getElementById("complaintDetailsBody"),

        closeModal: document.getElementById("closeComplaintModal"),
        closeButton: document.getElementById("closeComplaintButton"),
        updateButton: document.getElementById("updateComplaintButton"),

        statusModal: document.getElementById("complaintStatusModal"),
        statusBackdrop: document.getElementById("complaintStatusBackdrop"),
        closeStatusModal: document.getElementById("closeComplaintStatusModal"),
        statusForm: document.getElementById("complaintStatusForm"),
        statusComplaintId: document.getElementById("statusComplaintId"),
        newStatus: document.getElementById("newComplaintStatus"),
        cancelStatusButton: document.getElementById("cancelComplaintStatusButton"),
        saveStatusButton: document.getElementById("saveComplaintStatusButton")
    };

    function showMessage(message, type = "error") {
        if (!elements.message) {
            return;
        }

        if (!message) {
            elements.message.textContent = "";
            elements.message.className = "admin-message";
            elements.message.style.display = "none";
            return;
        }

        elements.message.textContent = message;
        elements.message.className = `admin-message ${type}`;
        elements.message.style.display = "block";
    }

    function escapeHtml(value) {
        return GasHubAdmin.escapeHtml(
            value === null || value === undefined
                ? ""
                : String(value)
        );
    }

    function normalizeStatus(status) {
        const value = String(status || "")
            .trim()
            .toLowerCase()
            .replace(/-/g, "_")
            .replace(/\s+/g, "_");

        if (
            value === "inprogress" ||
            value === "in_progress"
        ) {
            return "in_progress";
        }

        if (
            value === "resolved" ||
            value === "closed"
        ) {
            return "resolved";
        }

        if (
            value === "rejected" ||
            value === "declined"
        ) {
            return "rejected";
        }

        if (
            value === "pending" ||
            value === "new"
        ) {
            return "pending";
        }

        return value || "pending";
    }

    function getStatusLabel(status) {
        const normalized = normalizeStatus(status);

        const labels = {
            pending: "Pending",
            in_progress: "In Progress",
            resolved: "Resolved",
            rejected: "Rejected"
        };

        return labels[normalized] ||
            normalized
                .replace(/_/g, " ")
                .replace(/\b\w/g, character =>
                    character.toUpperCase()
                );
    }

    function getStatusClass(status) {
        const normalized = normalizeStatus(status);

        if (normalized === "resolved") {
            return "success";
        }

        if (normalized === "pending") {
            return "warning";
        }

        if (normalized === "rejected") {
            return "danger";
        }

        return "neutral";
    }

    function createStatusBadge(status) {
        return `
            <span class="status-badge ${getStatusClass(status)}">
                ${escapeHtml(getStatusLabel(status))}
            </span>
        `;
    }

    function getComplaintTitle(complaint) {
        return (
            complaint.subject ||
            complaint.title ||
            complaint.complaint_title ||
            complaint.type ||
            "Complaint"
        );
    }

    function getComplaintDescription(complaint) {
        return (
            complaint.message ||
            complaint.description ||
            complaint.complaint ||
            complaint.details ||
            "—"
        );
    }

    function getCustomerName(complaint) {
        return (
            complaint.customer_name ||
            complaint.full_name ||
            complaint.customer?.full_name ||
            complaint.name ||
            "—"
        );
    }

    function getCustomerPhone(complaint) {
        return (
            complaint.customer_phone ||
            complaint.phone ||
            complaint.customer?.phone ||
            "—"
        );
    }

    function getComplaintDate(complaint) {
        return (
            complaint.created_at ||
            complaint.date ||
            complaint.submitted_at ||
            null
        );
    }

    function formatDate(value) {
        if (!value) {
            return "—";
        }

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return "—";
        }

        return date.toLocaleDateString("en-KE", {
            day: "2-digit",
            month: "short",
            year: "numeric"
        });
    }

    function formatDateTime(value) {
        if (!value) {
            return "—";
        }

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return "—";
        }

        return date.toLocaleString("en-KE", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit"
        });
    }

    function updateStatistics() {
        const complaints = state.complaints;

        elements.totalComplaints.textContent =
            complaints.length;

        elements.pendingComplaints.textContent =
            complaints.filter(
                complaint =>
                    normalizeStatus(complaint.status) === "pending"
            ).length;

        elements.inProgressComplaints.textContent =
            complaints.filter(
                complaint =>
                    normalizeStatus(complaint.status) === "in_progress"
            ).length;

        elements.resolvedComplaints.textContent =
            complaints.filter(
                complaint =>
                    normalizeStatus(complaint.status) === "resolved"
            ).length;
    }

    function applyFilters() {
        const searchTerm = String(
            elements.search?.value || ""
        )
            .trim()
            .toLowerCase();

        const selectedStatus = String(
            elements.statusFilter?.value || ""
        )
            .trim()
            .toLowerCase();

        state.filteredComplaints =
            state.complaints.filter(complaint => {

                const searchableText = [
                    complaint.id,
                    complaint.complaint_code,
                    getComplaintTitle(complaint),
                    getComplaintDescription(complaint),
                    getCustomerName(complaint),
                    getCustomerPhone(complaint)
                ]
                    .join(" ")
                    .toLowerCase();

                const matchesSearch =
                    !searchTerm ||
                    searchableText.includes(searchTerm);

                const matchesStatus =
                    !selectedStatus ||
                    normalizeStatus(complaint.status) ===
                    selectedStatus;

                return matchesSearch && matchesStatus;
            });

        state.currentPage = 1;

        renderTable();
    }

    function renderTable() {
        const complaints = state.filteredComplaints;

        if (!complaints.length) {
            elements.tableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="table-empty">
                        No complaints found.
                    </td>
                </tr>
            `;

            updatePagination(0);
            return;
        }

        const totalPages = Math.ceil(
            complaints.length / state.pageSize
        );

        if (state.currentPage > totalPages) {
            state.currentPage = totalPages;
        }

        const startIndex =
            (state.currentPage - 1) *
            state.pageSize;

        const pageComplaints =
            complaints.slice(
                startIndex,
                startIndex + state.pageSize
            );

        elements.tableBody.innerHTML =
            pageComplaints
                .map(complaint => {

                    const complaintId =
                        complaint.id ??
                        complaint.complaint_id ??
                        "";

                    return `
                        <tr>

                            <td>
                                <div class="table-primary-text">
                                    ${escapeHtml(
                                        getComplaintTitle(complaint)
                                    )}
                                </div>

                                <div class="table-secondary-text">
                                    ${escapeHtml(
                                        getComplaintDescription(
                                            complaint
                                        ).substring(0, 80)
                                    )}
                                </div>
                            </td>

                            <td>
                                ${escapeHtml(
                                    getCustomerName(complaint)
                                )}
                            </td>

                            <td>
                                ${escapeHtml(
                                    getCustomerPhone(complaint)
                                )}
                            </td>

                            <td>
                                ${createStatusBadge(
                                    complaint.status
                                )}
                            </td>

                            <td>
                                ${formatDate(
                                    getComplaintDate(complaint)
                                )}
                            </td>

                            <td>
                                <div class="table-actions">

                                    <button
                                        type="button"
                                        class="table-action-button"
                                        data-action="view"
                                        data-id="${escapeHtml(
                                            String(complaintId)
                                        )}"
                                    >
                                        View
                                    </button>

                                </div>
                            </td>

                        </tr>
                    `;
                })
                .join("");

        updatePagination(complaints.length);
    }

    function updatePagination(totalItems) {
        if (!totalItems) {
            elements.paginationInfo.textContent =
                "Showing 0 complaints";

            elements.paginationButtons.innerHTML = "";

            return;
        }

        const totalPages = Math.ceil(
            totalItems / state.pageSize
        );

        const start =
            (state.currentPage - 1) *
            state.pageSize + 1;

        const end = Math.min(
            state.currentPage * state.pageSize,
            totalItems
        );

        elements.paginationInfo.textContent =
            `Showing ${start}-${end} of ${totalItems} complaints`;

        elements.paginationButtons.innerHTML = "";

        const previousButton =
            document.createElement("button");

        previousButton.type = "button";
        previousButton.className =
            "pagination-button";
        previousButton.textContent =
            "Previous";
        previousButton.disabled =
            state.currentPage === 1;

        previousButton.addEventListener(
            "click",
            () => {
                if (state.currentPage > 1) {
                    state.currentPage--;
                    renderTable();
                }
            }
        );

        elements.paginationButtons.appendChild(
            previousButton
        );

        for (
            let page = 1;
            page <= totalPages;
            page++
        ) {
            const button =
                document.createElement("button");

            button.type = "button";
            button.className =
                "pagination-button" +
                (
                    page === state.currentPage
                        ? " active"
                        : ""
                );

            button.textContent = page;

            button.addEventListener(
                "click",
                () => {
                    state.currentPage = page;
                    renderTable();
                }
            );

            elements.paginationButtons.appendChild(
                button
            );
        }

        const nextButton =
            document.createElement("button");

        nextButton.type = "button";
        nextButton.className =
            "pagination-button";
        nextButton.textContent =
            "Next";

        nextButton.disabled =
            state.currentPage === totalPages;

        nextButton.addEventListener(
            "click",
            () => {
                if (
                    state.currentPage <
                    totalPages
                ) {
                    state.currentPage++;
                    renderTable();
                }
            }
        );

        elements.paginationButtons.appendChild(
            nextButton
        );
    }

    async function loadComplaints() {
        try {
            showMessage("");

            elements.tableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="table-loading">
                        Loading complaints...
                    </td>
                </tr>
            `;

            const response =
                await GasHubAdmin.adminApiRequest(
                    "/api/admin/complaints"
                );

            let complaints = [];

            if (Array.isArray(response)) {
                complaints = response;
            } else if (
                Array.isArray(response?.complaints)
            ) {
                complaints = response.complaints;
            } else if (
                Array.isArray(response?.data)
            ) {
                complaints = response.data;
            } else if (
                Array.isArray(response?.data?.complaints)
            ) {
                complaints =
                    response.data.complaints;
            }

            state.complaints = complaints;
            state.filteredComplaints =
                [...complaints];

            updateStatistics();
            renderTable();

        } catch (error) {
            console.error(
                "Failed to load complaints:",
                error
            );

            state.complaints = [];
            state.filteredComplaints = [];

            updateStatistics();

            elements.tableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="table-empty">
                        Failed to load complaints.
                    </td>
                </tr>
            `;

            updatePagination(0);

            showMessage(
                error.message ||
                "Failed to load complaints.",
                "error"
            );
        }
    }

    async function viewComplaint(complaintId) {
        if (!complaintId) {
            return;
        }

        state.selectedComplaintId =
            complaintId;

        openDetailsModal();

        elements.modalTitle.textContent =
            "Complaint Details";

        elements.modalSubtitle.textContent =
            "Loading complaint information...";

        elements.detailsBody.innerHTML = `
            <div class="table-loading">
                Loading complaint details...
            </div>
        `;

        try {
            const response =
                await GasHubAdmin.adminApiRequest(
                    `/api/admin/complaints/${encodeURIComponent(
                        complaintId
                    )}`
                );

            const complaint =
                response?.complaint ||
                response?.data ||
                response;

            if (
                !complaint ||
                typeof complaint !== "object"
            ) {
                throw new Error(
                    "Complaint details could not be loaded."
                );
            }

            elements.modalTitle.textContent =
                getComplaintTitle(complaint);

            elements.modalSubtitle.textContent =
                `Submitted ${formatDateTime(
                    getComplaintDate(complaint)
                )}`;

            elements.modalSubtitle.textContent =
                `${complaint.complaint_number ? complaint.complaint_number + " · " : ""}Submitted ${formatDateTime(
                    getComplaintDate(complaint)
                )}`;

            elements.detailsBody.innerHTML = `
                <div class="cx">
                    ${renderSaid(complaint)}
                    ${renderOrderSections(complaint)}
                    ${renderComposer(complaint)}
                    <section class="cx-card" id="cxHistory">
                        ${renderHistory(response?.messages || [])}
                    </section>
                </div>
            `;

        } catch (error) {
            console.error(
                "Failed to load complaint details:",
                error
            );

            elements.detailsBody.innerHTML = `
                <div class="table-empty">
                    Failed to load complaint details.
                </div>
            `;

            elements.modalSubtitle.textContent =
                "Unable to load complaint information.";
        }
    }

    /* =========================================================
       ORDER DETAILS, REPLY COMPOSER AND MESSAGE HISTORY
    ========================================================= */
    const ksh = (n) => "KSh " + Number(n || 0).toLocaleString("en-KE", { maximumFractionDigits: 0 });

    const initial = (name) => escapeHtml(String(name || "?").trim().charAt(0).toUpperCase() || "?");

    function fact(label, valueHtml) {
        if (!valueHtml) return "";
        return `<div class="cx-fact"><span>${escapeHtml(label)}</span><b>${valueHtml}</b></div>`;
    }

    function contactBtn(kind, value) {
        const v = String(value || "").trim();
        if (!v) return `<span class="cx-btn off">${kind === "tel" ? "No phone" : "No email"}</span>`;
        return kind === "tel"
            ? `<a class="cx-btn" href="tel:${escapeHtml(v.replace(/[^\d+]/g, ""))}">📞 ${escapeHtml(v)}</a>`
            : `<a class="cx-btn" href="mailto:${escapeHtml(v)}">✉️ ${escapeHtml(v)}</a>`;
    }

    function pill(text, tone) {
        return `<span class="cx-pill-s ${tone || ""}">${escapeHtml(text)}</span>`;
    }

    function orderTone(status) {
        const v = String(status || "").toLowerCase();
        if (/cancel|reject|fail/.test(v)) return "bad";
        if (/complete|deliver/.test(v)) return "good";
        return "warn";
    }

    function cardHead(icon, title, rightHtml) {
        return `<div class="cx-head"><span class="cx-ico">${icon}</span><h4>${escapeHtml(title)}</h4>${rightHtml ? `<div class="cx-head-r">${rightHtml}</div>` : ""}</div>`;
    }

    /* what the customer wrote */
    function renderSaid(c) {
        return `
            <section class="cx-card cx-said">
                ${cardHead("💬", "What the customer reported", createStatusBadge(c.status))}
                ${c.reason ? `<div class="cx-reason">${escapeHtml(c.reason)}</div>` : ""}
                <blockquote class="cx-quote">${escapeHtml(getComplaintDescription(c))}</blockquote>
                <div class="cx-meta">${escapeHtml(getCustomerName(c))} · ${escapeHtml(formatDateTime(getComplaintDate(c)))}</div>
            </section>`;
    }

    function personCard(role, icon, name, phone, email, extraHtml) {
        return `
            <section class="cx-card cx-person">
                ${cardHead(icon, role)}
                <div class="cx-who">
                    <span class="cx-avatar">${initial(name)}</span>
                    <div><b>${escapeHtml(name || "—")}</b><small>${escapeHtml(role)}</small></div>
                </div>
                <div class="cx-btns">
                    ${contactBtn("tel", phone)}
                    ${contactBtn("mail", email)}
                </div>
                ${extraHtml || ""}
            </section>`;
    }

    function renderOrderSections(c) {
        const snap = c.order_snapshot && typeof c.order_snapshot === "object" ? c.order_snapshot : null;

        /* complaints made before this feature have no copy of the order */
        if (!snap) {
            if (!c.order_number && !c.dealer_name) return "";
            const link = c.dealer_id
                ? `<a class="cx-btn primary" href="admin-dealer-details.html?id=${encodeURIComponent(c.dealer_id)}" target="_blank" rel="noopener">Open dealer account ↗</a>` : "";
            return `
                <section class="cx-card">
                    ${cardHead("🧾", "Order " + (c.order_number || ""))}
                    <div class="cx-facts">${fact("Dealer", escapeHtml(c.dealer_name))}</div>
                    <div class="cx-btns">${link}</div>
                </section>
                <div class="cx-two">
                    ${personCard("Customer", "👤", getCustomerName(c), c.customer_phone, c.customer_email)}
                </div>`;
        }

        const o = snap.order || {}, m = snap.money || {}, d = snap.dealer || {}, cu = snap.customer || {}, dl = snap.delivery || {};
        const items = Array.isArray(snap.items) ? snap.items : [];
        const place = [dl.address, dl.landmark, dl.town, dl.county].filter(Boolean).join(", ");

        const itemRows = items.map((i) => `
            <div class="cx-item">
                <div class="cx-item-n"><b>${escapeHtml(i.name)}</b>${i.size ? ` <span class="cx-size">${escapeHtml(i.size)}</span>` : ""}
                    <small>${escapeHtml(i.quantity)} × ${ksh(i.unitPrice)}</small></div>
                <div class="cx-item-t">${ksh(i.total)}</div>
            </div>`).join("");

        const order = `
            <section class="cx-card">
                ${cardHead("🧾", "Order " + (o.orderNumber || ""), pill(String(o.status || "").replace(/_/g, " "), orderTone(o.status)))}
                <div class="cx-facts">
                    ${fact("Placed", escapeHtml(formatDateTime(o.placedAt)))}
                    ${fact("Cancelled", o.cancelledAt ? escapeHtml(formatDateTime(o.cancelledAt)) : "")}
                    ${fact("Payment", escapeHtml([o.paymentMethod, o.paymentStatus].filter(Boolean).join(" · ")))}
                    ${fact("Amount paid", ksh(o.amountPaid))}
                    ${o.refundStatus ? fact("Refund", escapeHtml(o.refundStatus + (o.refundAmount != null ? " · " + ksh(o.refundAmount) : ""))) : ""}
                    ${fact("Delivery option", escapeHtml(o.fulfilment))}
                    ${fact("Delivery address", escapeHtml(place))}
                    ${fact("Why it was cancelled", escapeHtml(o.cancellationReason))}
                    ${fact("Customer notes", escapeHtml(o.customerNotes))}
                </div>

                <div class="cx-items">${itemRows || `<div class="cx-empty">No items recorded.</div>`}</div>

                <div class="cx-sum">
                    <div><span>Products total</span><b>${ksh(m.productTotal)}</b></div>
                    <div class="fee"><span>🚚 Delivery fee charged by the dealer</span><b>${ksh(m.deliveryFee)}</b></div>
                    ${m.discount ? `<div><span>Discount${m.pointsUsed ? " (" + escapeHtml(m.pointsUsed) + " points)" : ""}</span><b>- ${ksh(m.discount)}</b></div>` : ""}
                    <div class="total"><span>Order total</span><b>${ksh(m.total)}</b></div>
                </div>
            </section>`;

        const dealerExtra = `
            ${d.location ? `<div class="cx-loc">📍 ${escapeHtml(d.location)}</div>` : ""}
            ${d.id ? `<a class="cx-btn primary wide" href="admin-dealer-details.html?id=${encodeURIComponent(d.id)}" target="_blank" rel="noopener">Open dealer account ↗</a>` : ""}`;

        return order + `
            <div class="cx-two">
                ${personCard("Dealer", "🏪", d.name || c.dealer_name, d.phone, d.email, dealerExtra)}
                ${personCard("Customer", "👤", cu.name || c.customer_name, cu.phone || c.customer_phone, cu.email || c.customer_email,
                    dl.phone && dl.phone !== (cu.phone || c.customer_phone) ? `<div class="cx-loc">Delivery phone: ${escapeHtml(dl.phone)}</div>` : "")}
            </div>`;
    }

    function renderComposer(c) {
        return `
            <section class="cx-card cx-compose" data-complaint-id="${escapeHtml(c.id)}">
                ${cardHead("✉️", "Message the customer")}
                <div class="cx-chans">
                    <label class="cx-chan"><input type="checkbox" data-ch="email" checked><span>✉️ Email</span></label>
                    <label class="cx-chan"><input type="checkbox" data-ch="sms" checked><span>💬 SMS</span></label>
                    <label class="cx-chan"><input type="checkbox" data-ch="push" checked><span>🔔 Phone notification</span></label>
                </div>
                <input type="text" id="cxSubject" maxlength="150" placeholder="Subject (email title and notification title)" value="Update on your complaint ${escapeHtml(c.complaint_number || "")}">
                <textarea id="cxMessage" rows="4" maxlength="5000" placeholder="Write your message…"></textarea>
                <div class="cx-hint">You can use <code>{name}</code> <code>{order}</code> <code>{dealer}</code> <code>{complaint}</code></div>
                <div class="cx-row">
                    <button type="button" class="primary-button" id="cxSend">Send message</button>
                    <span class="cx-note" id="cxNote" role="status"></span>
                </div>
            </section>`;
    }

    function renderHistory(list) {
        const head = cardHead("🕘", "Messages sent", list.length ? pill(String(list.length), "neutral") : "");
        if (!list.length) return head + `<div class="cx-empty">Nothing has been sent to this customer yet.</div>`;
        const names = { email: ["✉️", "Email"], sms: ["💬", "SMS"], push: ["🔔", "Notification"] };
        return head + `<ul class="cx-tl">${list.map((x) => {
            const n = names[x.channel] || ["•", x.channel];
            return `<li class="${escapeHtml(x.status)}">
                <span class="dot">${n[0]}</span>
                <div class="bd">
                    <div class="top"><b>${escapeHtml(n[1])}</b>${pill(x.status === "sent" ? "Sent" : "Failed", x.status === "sent" ? "good" : "bad")}
                        <span class="m">${x.kind === "auto" ? "Automatic" : "By " + escapeHtml(x.sent_by || "admin")} · ${escapeHtml(formatDateTime(x.created_at))}</span></div>
                    ${x.recipient ? `<div class="m">To ${escapeHtml(x.recipient)}</div>` : ""}
                    <div class="txt">${escapeHtml(x.body || "")}</div>
                    ${x.error ? `<div class="err">${escapeHtml(x.error)}</div>` : ""}
                </div></li>`;
        }).join("")}</ul>`;
    }

    async function sendComplaintMessage(box) {
        const note = box.querySelector("#cxNote"), btn = box.querySelector("#cxSend");
        const channels = [...box.querySelectorAll("input[data-ch]:checked")].map((i) => i.dataset.ch);
        const subject = box.querySelector("#cxSubject").value.trim(), message = box.querySelector("#cxMessage").value.trim();
        const say = (t, cls) => { note.textContent = t; note.className = "cx-note " + (cls || ""); };

        if (!channels.length) return say("Choose Email, SMS or Phone notification.", "err");
        if (!message) return say("Write a message first.", "err");

        btn.disabled = true; say("Sending...");
        try {
            const r = await GasHubAdmin.adminApiRequest(
                `/api/admin/complaints/${encodeURIComponent(box.dataset.complaintId)}/message`,
                { method: "POST", body: { channels, subject, message } });
            say(r.message || "Sent.", "ok");
            box.querySelector("#cxMessage").value = "";
            const h = document.getElementById("cxHistory"); if (h) h.innerHTML = renderHistory(r.messages || []);
        } catch (e) {
            say(e.message || "Unable to send the message.", "err");
            /* a failed send is still written to the history: reload it */
            try {
                const full = await GasHubAdmin.adminApiRequest(`/api/admin/complaints/${encodeURIComponent(box.dataset.complaintId)}`);
                const h = document.getElementById("cxHistory"); if (h) h.innerHTML = renderHistory(full.messages || []);
            } catch (x) { /* ignore */ }
        } finally { btn.disabled = false; }
    }

    /* ---------- automatic reply settings ---------- */
    const ar = {
        enabled: document.getElementById("arEnabled"), label: document.getElementById("arEnabledLabel"),
        email: document.getElementById("arEmailOn"), sms: document.getElementById("arSmsOn"), push: document.getElementById("arPushOn"),
        subject: document.getElementById("arEmailSubject"), emailMsg: document.getElementById("arEmailMessage"),
        smsMsg: document.getElementById("arSmsMessage"), smsCount: document.getElementById("arSmsCount"),
        pushTitle: document.getElementById("arPushTitle"), pushMsg: document.getElementById("arPushMessage"),
        save: document.getElementById("arSave"), status: document.getElementById("arStatus"), hint: document.getElementById("arSetupHint")
    };

    function arSay(t, cls) { ar.status.textContent = t || ""; ar.status.className = "ar-status " + (cls || ""); }
    function arLabel() { ar.label.textContent = ar.enabled.checked ? "Automatic sending is ON" : "Automatic sending is OFF"; }
    function arCount() { ar.smsCount.textContent = `(${ar.smsMsg.value.length}/612 characters)`; }

    function arFill(s) {
        ar.enabled.checked = !!s.enabled; ar.email.checked = !!s.emailEnabled; ar.sms.checked = !!s.smsEnabled; ar.push.checked = !!s.pushEnabled;
        ar.subject.value = s.emailSubject || ""; ar.emailMsg.value = s.emailMessage || "";
        ar.smsMsg.value = s.smsMessage || ""; ar.pushTitle.value = s.pushTitle || ""; ar.pushMsg.value = s.pushMessage || "";
        arLabel(); arCount();
    }

    async function loadReplySettings() {
        if (!ar.save) return;
        try {
            const r = await GasHubAdmin.adminApiRequest("/api/admin/complaints/settings/reply");
            arFill(r.settings || {});
            const off = [];
            if (r.email && !r.email.configured) off.push("Email is not set up yet (SMTP settings)");
            if (r.sms && !r.sms.configured) off.push("SMS is not set up yet (Africa's Talking settings)");
            if (r.push && !r.push.configured) off.push("Phone notifications are not set up yet (VAPID keys)");
            ar.hint.textContent = off.length ? off.join(". ") + ". A channel that is not set up will be skipped and shown as failed in the message history." : "";
        } catch (e) { arSay(e.message || "Unable to load the reply settings.", "err"); }
    }

    async function saveReplySettings() {
        ar.save.disabled = true; arSay("Saving...");
        try {
            const r = await GasHubAdmin.adminApiRequest("/api/admin/complaints/settings/reply", {
                method: "PUT",
                body: {
                    enabled: ar.enabled.checked, emailEnabled: ar.email.checked, smsEnabled: ar.sms.checked, pushEnabled: ar.push.checked,
                    emailSubject: ar.subject.value, emailMessage: ar.emailMsg.value, smsMessage: ar.smsMsg.value,
                    pushTitle: ar.pushTitle.value, pushMessage: ar.pushMsg.value
                }
            });
            arFill(r.settings || {}); arSay(r.message || "Saved.", "ok");
        } catch (e) { arSay(e.message || "Unable to save.", "err"); }
        finally { ar.save.disabled = false; }
    }

    if (ar.save) {
        ar.save.addEventListener("click", saveReplySettings);
        ar.enabled.addEventListener("change", arLabel);
        ar.smsMsg.addEventListener("input", arCount);
    }

    elements.detailsBody.addEventListener("click", (event) => {
        const send = event.target.closest("#cxSend");
        if (send) sendComplaintMessage(send.closest(".cx-compose"));
    });

    function openDetailsModal() {
        elements.detailsModal.classList.add("open");

        elements.detailsModal.setAttribute(
            "aria-hidden",
            "false"
        );

        document.body.classList.add(
            "modal-open"
        );
    }

    function closeDetailsModal() {
        elements.detailsModal.classList.remove(
            "open"
        );

        elements.detailsModal.setAttribute(
            "aria-hidden",
            "true"
        );

        document.body.classList.remove(
            "modal-open"
        );
    }

    function openStatusModal() {
        elements.statusModal.classList.add("open");

        elements.statusModal.setAttribute(
            "aria-hidden",
            "false"
        );
    }

    function closeStatusModal() {
        elements.statusModal.classList.remove(
            "open"
        );

        elements.statusModal.setAttribute(
            "aria-hidden",
            "true"
        );
    }

    function openStatusEditor() {
        if (!state.selectedComplaintId) {
            return;
        }

        const complaint =
            state.complaints.find(
                item =>
                    String(
                        item.id ??
                        item.complaint_id
                    ) ===
                    String(
                        state.selectedComplaintId
                    )
            );

        elements.statusComplaintId.value =
            state.selectedComplaintId;

        elements.newStatus.value =
            normalizeStatus(
                complaint?.status || "pending"
            );

        closeDetailsModal();
        openStatusModal();
    }

    async function updateComplaintStatus(event) {
        event.preventDefault();

        const complaintId =
            elements.statusComplaintId.value;

        const status =
            elements.newStatus.value;

        if (!complaintId || !status) {
            return;
        }

        const originalText =
            elements.saveStatusButton.textContent;

        elements.saveStatusButton.disabled = true;
        elements.saveStatusButton.textContent =
            "Saving...";

        try {
            await GasHubAdmin.adminApiRequest(
                `/api/admin/complaints/${encodeURIComponent(
                    complaintId
                )}`,
                {
                    method: "PATCH",
                    body: JSON.stringify({
                        status
                    })
                }
            );

            closeStatusModal();

            showMessage(
                "Complaint status updated successfully.",
                "success"
            );

            await loadComplaints();

        } catch (error) {
            console.error(
                "Failed to update complaint:",
                error
            );

            showMessage(
                error.message ||
                "Failed to update complaint status.",
                "error"
            );

        } finally {
            elements.saveStatusButton.disabled =
                false;

            elements.saveStatusButton.textContent =
                originalText;
        }
    }

    function setupEvents() {
        elements.search?.addEventListener(
            "input",
            applyFilters
        );

        elements.statusFilter?.addEventListener(
            "change",
            applyFilters
        );

        elements.tableBody?.addEventListener(
            "click",
            event => {
                const button =
                    event.target.closest(
                        "[data-action='view']"
                    );

                if (!button) {
                    return;
                }

                viewComplaint(
                    button.getAttribute("data-id")
                );
            }
        );

        elements.closeModal?.addEventListener(
            "click",
            closeDetailsModal
        );

        elements.closeButton?.addEventListener(
            "click",
            closeDetailsModal
        );

        elements.modalBackdrop?.addEventListener(
            "click",
            closeDetailsModal
        );

        elements.updateButton?.addEventListener(
            "click",
            openStatusEditor
        );

        elements.closeStatusModal?.addEventListener(
            "click",
            closeStatusModal
        );

        elements.cancelStatusButton?.addEventListener(
            "click",
            closeStatusModal
        );

        elements.statusBackdrop?.addEventListener(
            "click",
            closeStatusModal
        );

        elements.statusForm?.addEventListener(
            "submit",
            updateComplaintStatus
        );

        document.addEventListener(
            "keydown",
            event => {
                if (event.key !== "Escape") {
                    return;
                }

                if (
                    elements.statusModal.classList.contains(
                        "open"
                    )
                ) {
                    closeStatusModal();
                    return;
                }

                if (
                    elements.detailsModal.classList.contains(
                        "open"
                    )
                ) {
                    closeDetailsModal();
                }
            }
        );
    }

    setupEvents();
    loadComplaints();
    loadReplySettings();
});