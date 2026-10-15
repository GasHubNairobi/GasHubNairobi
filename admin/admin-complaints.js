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

            elements.detailsBody.innerHTML = `
                <div class="form-grid">

                    <div class="form-group">
                        <label>Complaint</label>
                        <div class="detail-value">
                            ${escapeHtml(
                                getComplaintTitle(
                                    complaint
                                )
                            )}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Customer</label>
                        <div class="detail-value">
                            ${escapeHtml(
                                getCustomerName(
                                    complaint
                                )
                            )}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Phone</label>
                        <div class="detail-value">
                            ${escapeHtml(
                                getCustomerPhone(
                                    complaint
                                )
                            )}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Status</label>
                        <div class="detail-value">
                            ${createStatusBadge(
                                complaint.status
                            )}
                        </div>
                    </div>

                    <div class="form-group full-width">
                        <label>Complaint Details</label>
                        <div class="detail-value">
                            ${escapeHtml(
                                getComplaintDescription(
                                    complaint
                                )
                            )}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Date Submitted</label>
                        <div class="detail-value">
                            ${formatDateTime(
                                getComplaintDate(
                                    complaint
                                )
                            )}
                        </div>
                    </div>

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
});