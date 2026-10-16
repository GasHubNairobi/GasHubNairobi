document.addEventListener("DOMContentLoaded", () => {
    const state = {
        payments: [],
        filteredPayments: [],
        currentPage: 1,
        pageSize: 10
    };

    const elements = {
        message: document.getElementById("paymentsMessage"),

        totalPayments: document.getElementById("totalPayments"),
        totalPaymentAmount: document.getElementById("totalPaymentAmount"),
        pendingPayments: document.getElementById("pendingPayments"),
        completedPayments: document.getElementById("completedPayments"),

        search: document.getElementById("paymentSearch"),
        statusFilter: document.getElementById("paymentStatusFilter"),

        tableBody: document.getElementById("paymentsTableBody"),

        paginationInfo: document.getElementById("paymentsPaginationInfo"),
        paginationButtons: document.getElementById("paymentsPaginationButtons"),

        detailsModal: document.getElementById("paymentDetailsModal"),
        modalBackdrop: document.getElementById("paymentModalBackdrop"),
        modalTitle: document.getElementById("paymentModalTitle"),
        modalSubtitle: document.getElementById("paymentModalSubtitle"),
        detailsBody: document.getElementById("paymentDetailsBody"),

        closeModal: document.getElementById("closePaymentModal"),
        closeButton: document.getElementById("closePaymentButton")
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

    function getPaymentId(payment) {
        return (
            payment.id ??
            payment.payment_id ??
            payment.transaction_id ??
            ""
        );
    }

    function getOrderId(payment) {
        return (
            payment.order_id ??
            payment.order?.id ??
            payment.order_code ??
            payment.order?.order_code ??
            "—"
        );
    }

    function getCustomerName(payment) {
        return (
            payment.customer_name ||
            payment.full_name ||
            payment.customer?.full_name ||
            payment.customer?.name ||
            "—"
        );
    }

    function getAmount(payment) {
        const value =
            payment.amount ??
            payment.total_amount ??
            payment.paid_amount ??
            0;

        const amount = Number(value);

        return Number.isFinite(amount) ? amount : 0;
    }

    function getPaymentMethod(payment) {
        return (
            payment.payment_method ||
            payment.method ||
            "—"
        );
    }

    function getPaymentDate(payment) {
        return (
            payment.created_at ||
            payment.payment_date ||
            payment.paid_at ||
            payment.date ||
            null
        );
    }

    function normalizeStatus(status) {
        const value = String(status || "")
            .trim()
            .toLowerCase()
            .replace(/-/g, "_")
            .replace(/\s+/g, "_");

        if (
            value === "success" ||
            value === "successful" ||
            value === "paid"
        ) {
            return "completed";
        }

        if (
            value === "cancelled" ||
            value === "canceled"
        ) {
            return "cancelled";
        }

        if (
            value === "failed" ||
            value === "failure"
        ) {
            return "failed";
        }

        if (
            value === "pending" ||
            value === "processing"
        ) {
            return "pending";
        }

        return value || "pending";
    }

    function getStatusLabel(status) {
        const normalized = normalizeStatus(status);

        const labels = {
            pending: "Pending",
            completed: "Completed",
            failed: "Failed",
            cancelled: "Cancelled"
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

        if (normalized === "completed") {
            return "success";
        }

        if (normalized === "pending") {
            return "warning";
        }

        if (
            normalized === "failed" ||
            normalized === "cancelled"
        ) {
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

    function formatAmount(value) {
        const amount = Number(value);

        if (!Number.isFinite(amount)) {
            return "KSh 0";
        }

        return `KSh ${amount.toLocaleString("en-KE", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        })}`;
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

    function normalizePayments(response) {
        if (Array.isArray(response)) {
            return response;
        }

        if (Array.isArray(response?.payments)) {
            return response.payments;
        }

        if (Array.isArray(response?.data)) {
            return response.data;
        }

        if (Array.isArray(response?.data?.payments)) {
            return response.data.payments;
        }

        return [];
    }

    function updateStatistics() {
        const payments = state.payments;

        /* only completed payments count: a refunded (or failed / pending) payment is not money received */
        const totalAmount = payments.reduce(
            (total, payment) =>
                normalizeStatus(payment.status) === "completed" ? total + getAmount(payment) : total,
            0
        );

        const pending = payments.filter(
            payment =>
                normalizeStatus(payment.status) === "pending"
        ).length;

        const completed = payments.filter(
            payment =>
                normalizeStatus(payment.status) === "completed"
        ).length;

        elements.totalPayments.textContent =
            payments.length;

        elements.totalPaymentAmount.textContent =
            formatAmount(totalAmount);

        elements.pendingPayments.textContent =
            pending;

        elements.completedPayments.textContent =
            completed;
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

        state.filteredPayments =
            state.payments.filter(payment => {

                const searchableText = [
                    getPaymentId(payment),
                    getOrderId(payment),
                    getCustomerName(payment),
                    getPaymentMethod(payment),
                    payment.transaction_code,
                    payment.reference,
                    payment.mpesa_receipt
                ]
                    .join(" ")
                    .toLowerCase();

                const matchesSearch =
                    !searchTerm ||
                    searchableText.includes(searchTerm);

                const matchesStatus =
                    !selectedStatus ||
                    normalizeStatus(payment.status) ===
                    selectedStatus;

                return matchesSearch && matchesStatus;
            });

        state.currentPage = 1;

        renderTable();
    }

    function renderTable() {
        const payments = state.filteredPayments;

        if (!payments.length) {
            elements.tableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="table-empty">
                        No payments found.
                    </td>
                </tr>
            `;

            updatePagination(0);
            return;
        }

        const totalPages = Math.ceil(
            payments.length / state.pageSize
        );

        if (state.currentPage > totalPages) {
            state.currentPage = totalPages;
        }

        const startIndex =
            (state.currentPage - 1) *
            state.pageSize;

        const pagePayments =
            payments.slice(
                startIndex,
                startIndex + state.pageSize
            );

        elements.tableBody.innerHTML =
            pagePayments.map(payment => {

                const paymentId =
                    getPaymentId(payment);

                return `
                    <tr>

                        <td>
                            <div class="table-primary-text">
                                ${escapeHtml(
                                    payment.transaction_code ||
                                    payment.reference ||
                                    paymentId ||
                                    "Payment"
                                )}
                            </div>
                        </td>

                        <td>
                            ${escapeHtml(
                                String(getOrderId(payment))
                            )}
                        </td>

                        <td>
                            ${escapeHtml(
                                getCustomerName(payment)
                            )}
                        </td>

                        <td>
                            <span class="table-price">
                                ${formatAmount(
                                    getAmount(payment)
                                )}
                            </span>
                        </td>

                        <td>
                            ${escapeHtml(
                                getPaymentMethod(payment)
                            )}
                        </td>

                        <td>
                            ${createStatusBadge(
                                payment.status
                            )}
                        </td>

                        <td>
                            ${formatDate(
                                getPaymentDate(payment)
                            )}
                        </td>

                        <td>
                            <div class="table-actions">

                                <button
                                    type="button"
                                    class="table-action-button"
                                    data-action="view"
                                    data-id="${escapeHtml(
                                        String(paymentId)
                                    )}"
                                >
                                    View
                                </button>

                            </div>
                        </td>

                    </tr>
                `;
            }).join("");

        updatePagination(payments.length);
    }

    function updatePagination(totalItems) {
        if (!totalItems) {
            elements.paginationInfo.textContent =
                "Showing 0 payments";

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
            `Showing ${start}-${end} of ${totalItems} payments`;

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
        nextButton.textContent = "Next";

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

    async function loadPayments() {
        try {
            showMessage("");

            elements.tableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="table-loading">
                        Loading payments...
                    </td>
                </tr>
            `;

            const response =
                await GasHubAdmin.adminApiRequest(
                    "/api/admin/payments"
                );

            const payments =
                normalizePayments(response);

            state.payments = payments;
            state.filteredPayments =
                [...payments];

            updateStatistics();
            renderTable();

        } catch (error) {
            console.error(
                "Failed to load payments:",
                error
            );

            state.payments = [];
            state.filteredPayments = [];

            updateStatistics();

            elements.tableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="table-empty">
                        Failed to load payments.
                    </td>
                </tr>
            `;

            updatePagination(0);

            showMessage(
                error.message ||
                "Failed to load payments.",
                "error"
            );
        }
    }

    /* M-Pesa / bank money goes into GasHub's account, so GasHub confirms it here. Cash is confirmed by the dealer. */
    function isCashPayment(payment) {
        return String(getPaymentMethod(payment)).toLowerCase() === "cash";
    }

    function confirmBlock(payment) {
        if (normalizeStatus(payment.status) !== "pending") {
            return payment.notes
                ? `<p class="settings-hint" style="margin-top:12px">${escapeHtml(payment.notes)}</p>`
                : "";
        }

        if (isCashPayment(payment)) {
            return `<p class="settings-hint" style="margin-top:12px">Cash payments are confirmed by the dealer once the cash is handed over.</p>`;
        }

        return `
            <div class="confirm-box" style="margin-top:16px;padding:14px;border:1px solid #cbd5e1;border-radius:12px;background:#f8fafc">
                <strong>Has this money reached the GasHub account?</strong>
                <p class="settings-hint" style="margin:6px 0 10px">
                    Find the code in GasHub's M-Pesa statement. If it matches the amount, confirm it: the order shows as paid
                    and an order that was already delivered is completed. If you cannot find it, reject it so the customer can send the right code.
                </p>
                <div class="form-group">
                    <label for="confirmPaymentCode">M-Pesa code</label>
                    <input type="text" id="confirmPaymentCode" maxlength="12" value="${escapeHtml(payment.mpesa_receipt_number || payment.transaction_code || "")}" placeholder="e.g. QGH7XK2LMN">
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
                    <button type="button" class="primary-button" data-confirm-payment="${escapeHtml(String(getPaymentId(payment)))}">Confirm money received</button>
                    <button type="button" class="secondary-button" data-reject-payment="${escapeHtml(String(getPaymentId(payment)))}">Reject code</button>
                </div>
            </div>
        `;
    }

    async function confirmPaymentById(paymentId, button) {
        const code = (document.getElementById("confirmPaymentCode")?.value || "").trim();
        button.disabled = true;
        try {
            const result = await GasHubAdmin.adminApiRequest(
                `/api/admin/payments/${encodeURIComponent(paymentId)}/confirm`,
                { method: "POST", body: { mpesa_receipt: code } }
            );
            closeModal();
            await loadPayments(); loadRefunds();
            showMessage(result.message || "Payment confirmed.", "success");
        } catch (error) {
            showMessage(error.message || "Could not confirm this payment.");
            button.disabled = false;
        }
    }

    async function rejectPaymentById(paymentId, button) {
        const reason = await GasHubDialog.prompt({ title: "Reject this payment?", message: "Say why it is rejected (code not found in the M-Pesa statement, wrong amount, ...). The reason is kept with the payment.", label: "Reason", value: "Code not found in the GasHub M-Pesa statement", multiline: true, confirmText: "Reject payment", tone: "danger", requiredMessage: "Please give a reason." });
        if (reason === null) return;
        button.disabled = true;
        try {
            const result = await GasHubAdmin.adminApiRequest(
                `/api/admin/payments/${encodeURIComponent(paymentId)}/reject`,
                { method: "POST", body: { reason } }
            );
            closeModal();
            await loadPayments(); loadRefunds();
            showMessage(result.message || "Payment rejected.", "success");
        } catch (error) {
            showMessage(error.message || "Could not reject this payment.");
            button.disabled = false;
        }
    }

    async function viewPayment(paymentId) {
        if (!paymentId) {
            return;
        }

        openModal();

        elements.modalTitle.textContent =
            "Payment Details";

        elements.modalSubtitle.textContent =
            "Loading payment information...";

        elements.detailsBody.innerHTML = `
            <div class="table-loading">
                Loading payment details...
            </div>
        `;

        try {
            const response =
                await GasHubAdmin.adminApiRequest(
                    `/api/admin/payments/${encodeURIComponent(
                        paymentId
                    )}`
                );

            const payment =
                response?.payment ||
                response?.data ||
                response;

            if (
                !payment ||
                typeof payment !== "object"
            ) {
                throw new Error(
                    "Payment details could not be loaded."
                );
            }

            elements.modalTitle.textContent =
                "Payment Details";

            elements.modalSubtitle.textContent =
                `Payment ${
                    payment.transaction_code ||
                    payment.reference ||
                    paymentId
                }`;

            elements.detailsBody.innerHTML = `
                <div class="form-grid">

                    <div class="form-group">
                        <label>Payment</label>

                        <div class="detail-value">
                            ${escapeHtml(
                                payment.transaction_code ||
                                payment.reference ||
                                paymentId
                            )}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Order</label>

                        <div class="detail-value">
                            ${escapeHtml(
                                String(
                                    getOrderId(payment)
                                )
                            )}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Customer</label>

                        <div class="detail-value">
                            ${escapeHtml(
                                getCustomerName(payment)
                            )}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Amount</label>

                        <div class="detail-value">
                            ${formatAmount(
                                getAmount(payment)
                            )}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Payment Method</label>

                        <div class="detail-value">
                            ${escapeHtml(
                                getPaymentMethod(payment)
                            )}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Status</label>

                        <div class="detail-value">
                            ${createStatusBadge(
                                payment.status
                            )}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Date</label>

                        <div class="detail-value">
                            ${formatDateTime(
                                getPaymentDate(payment)
                            )}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Reference</label>

                        <div class="detail-value">
                            ${escapeHtml(
                                payment.reference ||
                                payment.transaction_code ||
                                payment.mpesa_receipt ||
                                "—"
                            )}
                        </div>
                    </div>

                </div>
                ${confirmBlock(payment)}
            `;

        } catch (error) {
            console.error(
                "Failed to load payment details:",
                error
            );

            elements.detailsBody.innerHTML = `
                <div class="table-empty">
                    Failed to load payment details.
                </div>
            `;

            elements.modalSubtitle.textContent =
                "Unable to load payment information.";
        }
    }

    function openModal() {
        elements.detailsModal.classList.add("open");

        elements.detailsModal.setAttribute(
            "aria-hidden",
            "false"
        );

        document.body.classList.add(
            "modal-open"
        );
    }

    function closeModal() {
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

    function setupEvents() {
        elements.detailsBody?.addEventListener("click", event => {
            const confirmButton = event.target.closest("[data-confirm-payment]");
            if (confirmButton) {
                confirmPaymentById(confirmButton.getAttribute("data-confirm-payment"), confirmButton);
                return;
            }
            const rejectButton = event.target.closest("[data-reject-payment]");
            if (rejectButton) {
                rejectPaymentById(rejectButton.getAttribute("data-reject-payment"), rejectButton);
            }
        });

        document.getElementById("confirmOrderPaymentForm")?.addEventListener("submit", async event => {
            event.preventDefault();
            const orderNumber = document.getElementById("confirmOrderNumber").value.trim();
            const code = document.getElementById("confirmOrderCode").value.trim();
            const button = document.getElementById("confirmOrderButton");
            if (!orderNumber || !code) return;
            if (!(await GasHubDialog.confirm({ title: "Confirm payment received?", message: `Confirm that the money for order ${orderNumber} (M-Pesa code ${code.toUpperCase()}) is in the GasHub account?`, confirmText: "Yes, it is there", tone: "success" }))) return;
            button.disabled = true;
            try {
                const result = await GasHubAdmin.adminApiRequest(
                    `/api/admin/payments/orders/${encodeURIComponent(orderNumber)}/confirm`,
                    { method: "POST", body: { mpesa_receipt: code } }
                );
                event.target.reset();
                await loadPayments(); loadRefunds();
                showMessage(result.message || "Payment confirmed.", "success");
            } catch (error) {
                showMessage(error.message || "Could not confirm this payment.");
            } finally {
                button.disabled = false;
            }
        });

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

                viewPayment(
                    button.getAttribute("data-id")
                );
            }
        );

        elements.closeModal?.addEventListener(
            "click",
            closeModal
        );

        elements.closeButton?.addEventListener(
            "click",
            closeModal
        );

        elements.modalBackdrop?.addEventListener(
            "click",
            closeModal
        );

        document.addEventListener(
            "keydown",
            event => {
                if (
                    event.key === "Escape" &&
                    elements.detailsModal.classList.contains(
                        "open"
                    )
                ) {
                    closeModal();
                }
            }
        );
    }

    /* =========================================================
       REFUNDS: paid orders that were cancelled. GasHub sends the money back, then records the receipt here.
    ========================================================= */
    async function loadRefunds() {
        const body = document.getElementById("refundsTableBody");
        if (!body) return;
        try {
            const r = await GasHubAdmin.adminApiRequest("/api/admin/payments/refunds");
            const pending = Array.isArray(r && r.pending) ? r.pending : [];
            const done = Array.isArray(r && r.done) ? r.done : [];
            const auto = !!(r && r.auto_enabled);
            const stale = o => !o.refund_payout_started_at || (Date.now() - new Date(o.refund_payout_started_at).getTime()) > 30 * 60 * 1000;
            const isSending = o => o.refund_payout_state === "sending" && !stale(o);
            const actionCell = o => {
                const ref = escapeHtml(o.order_number || o.id);
                const amt = escapeHtml(formatAmount(o.refund_amount));
                const ph = escapeHtml(o.refund_phone || o.customer_phone || "");
                const manual = `<button type="button" class="secondary-button" data-refund-done="${ref}" data-refund-amount="${amt}" data-refund-phone="${ph}">Mark as refunded</button>`;
                if (!auto) return manual;
                if (isSending(o)) return `<span class="refund-state">Sending to M-Pesa...</span>`;
                const failed = o.refund_payout_state === "failed" || (o.refund_payout_state === "sending" && stale(o));
                const why = failed ? `<small class="refund-error">${escapeHtml(o.refund_payout_error || "M-Pesa did not answer. Check your M-Pesa statement before sending again.")}</small><br>` : "";
                return `${why}<button type="button" class="primary-button" data-refund-send="${ref}" data-refund-amount="${amt}" data-refund-phone="${ph}" data-refund-name="${escapeHtml(o.customer_name || "")}">${failed ? "Refund again" : "Refund now"}</button> ${manual}`;
            };
            if (pending.some(isSending)) { clearTimeout(window.__refundPoll); window.__refundPoll = setTimeout(loadRefunds, 6000); }
            const count = document.getElementById("refundCount");
            if (count) { count.textContent = pending.length; count.hidden = !pending.length; }
            body.innerHTML = pending.length ? pending.map(o => `
                <tr>
                    <td><strong>${escapeHtml(o.order_number || o.id)}</strong><br><small>${escapeHtml(o.dealer_name || "")}</small></td>
                    <td>${escapeHtml(o.customer_name || "—")}<br><small>${escapeHtml(o.customer_phone || "")}</small></td>
                    <td><strong>${escapeHtml(o.refund_phone || o.customer_phone || "—")}</strong></td>
                    <td><strong>${escapeHtml(formatAmount(o.refund_amount))}</strong></td>
                    <td>${escapeHtml(o.refund_note || o.cancellation_reason || "Cancelled")}</td>
                    <td>${escapeHtml(formatDateTime(o.refund_requested_at))}</td>
                    <td>${actionCell(o)}</td>
                </tr>`).join("")
                : `<tr><td colspan="7" class="table-loading">No refunds waiting. Nothing is owed back to customers.</td></tr>`;
            const box = document.getElementById("refundDoneBox");
            if (box) {
                box.hidden = !done.length;
                document.getElementById("refundDoneCount").textContent = done.length;
                document.getElementById("refundsDoneBody").innerHTML = done.map(o => `
                    <tr>
                        <td><strong>${escapeHtml(o.order_number || o.id)}</strong></td>
                        <td>${escapeHtml(o.customer_name || "—")}</td>
                        <td>${escapeHtml(formatAmount(o.refund_amount))}</td>
                        <td>${escapeHtml(o.refund_phone || "—")}</td>
                        <td>${escapeHtml(o.refund_mpesa_receipt || "—")}</td>
                        <td>${escapeHtml(formatDateTime(o.refunded_at))}</td>
                        <td>${escapeHtml(o.refunded_by || "—")}</td>
                    </tr>`).join("");
            }
        } catch (error) {
            console.error("Failed to load refunds:", error);
            body.innerHTML = `<tr><td colspan="7" class="table-loading">Could not load refunds. ${escapeHtml(error.message || "")}</td></tr>`;
        }
    }

    async function completeRefundFor(orderRef, amount, phone, button) {
        const receipt = await GasHubDialog.prompt({
            title: "Mark refund as sent",
            message: `Send ${amount} to ${phone || "the customer's M-Pesa number"} first, then enter the M-Pesa receipt code of that transfer.`,
            label: "M-Pesa receipt code of the refund",
            placeholder: "e.g. QGH7XK2LMN",
            confirmText: "Mark as refunded",
            tone: "success",
            requiredMessage: "Enter the receipt code."
        });
        if (!receipt) return;
        button.disabled = true;
        try {
            const result = await GasHubAdmin.adminApiRequest(
                `/api/admin/payments/refunds/${encodeURIComponent(orderRef)}/complete`,
                { method: "POST", body: { mpesa_receipt: receipt } }
            );
            showMessage(result.message || "Refund recorded.", "success");
            await loadRefunds();
            await loadPayments(); loadRefunds();
        } catch (error) {
            showMessage(error.message || "Could not record this refund.");
            button.disabled = false;
        }
    }

    /* "Refund now": the money goes back automatically to the M-Pesa number the customer paid with */
    async function sendRefundFor(orderRef, amount, phone, name, button) {
        const ok = await GasHubDialog.confirm({
            title: "Refund this customer now?",
            message: `${amount} will be sent automatically from the GasHub M-Pesa account to ${phone || "the number the customer paid with"}${name ? " (" + name + ")" : ""}. This sends real money and cannot be undone.`,
            confirmText: "Refund now",
            cancelText: "Cancel",
            tone: "warning"
        });
        if (!ok) return;
        button.disabled = true;
        try {
            const result = await GasHubAdmin.adminApiRequest(`/api/admin/payments/refunds/${encodeURIComponent(orderRef)}/send`, { method: "POST", body: {} });
            showMessage(result.message || "Refund sent.", "success");
        } catch (error) {
            showMessage(error.message || "Could not send this refund.");
        }
        await loadRefunds();
    }

    document.getElementById("refundsTableBody")?.addEventListener("click", event => {
        const s = event.target.closest("[data-refund-send]");
        if (s) return sendRefundFor(s.dataset.refundSend, s.dataset.refundAmount, s.dataset.refundPhone, s.dataset.refundName, s);
        const b = event.target.closest("[data-refund-done]");
        if (b) completeRefundFor(b.dataset.refundDone, b.dataset.refundAmount, b.dataset.refundPhone, b);
    });

    setupEvents();
    loadPayments();
    loadRefunds();
});