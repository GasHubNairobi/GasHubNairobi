/**
 * GasHub Admin - Dealer Directory & Partner Management
 * File: admin-dealers.js
 * Description: Manages real-time dealer accounts, verification status, active storefront state,
 * and partner operations without changing any backend route contracts.
 */

document.addEventListener("DOMContentLoaded", () => {
    "use strict";

    const DEALERS_API = "/api/admin/dealers";
    const PAGE_SIZE = 8;

    const state = {
        dealers: [],
        filtered: [],
        page: 1,
        loading: false,
        busyIds: new Set(),
        currentVerifyingDealer: null
    };

    const el = {
        message: document.getElementById("dealersMessage"),
        total: document.getElementById("totalDealers"),
        active: document.getElementById("activeDealers"),
        inactive: document.getElementById("inactiveDealers"),
        products: document.getElementById("dealerProducts"),
        search: document.getElementById("dealerSearch"),
        status: document.getElementById("dealerStatusFilter"),
        body: document.getElementById("dealersTableBody"),
        pageInfo: document.getElementById("dealersPaginationInfo"),
        pageButtons: document.getElementById("dealersPaginationButtons"),
        countLabel: document.getElementById("dealerCountLabel"),
        refresh: document.getElementById("refreshDealers"),
        sidebar: document.getElementById("adminSidebar"),
        overlay: document.getElementById("sidebarOverlay"),
        mobileMenu: document.getElementById("mobileMenuButton")
    };

    /* =========================================================
       UTILITY & FORMATTING FUNCTIONS
    ========================================================= */

    function escapeHtml(value) {
        if (window.GasHubAdmin?.escapeHtml) {
            return window.GasHubAdmin.escapeHtml(String(value ?? ""));
        }

        return String(value ?? "").replace(/[&<>"']/g, character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[character]);
    }

    function dealerId(dealer) {
        return dealer.id ?? dealer.dealer_id;
    }

    function nameOf(dealer) {
        return dealer.business_name || dealer.name || "Unnamed Dealer";
    }

    function codeOf(dealer) {
        return dealer.dealer_code || dealer.code || "No Code";
    }

    function phoneOf(dealer) {
        return dealer.phone || "—";
    }

    function emailOf(dealer) {
        return dealer.email || "—";
    }

    function locationOf(dealer) {
        // Same wording as the customer dealer pages: location, town, county (no repeats).
        const seen = new Set();
        const parts = [dealer.location, dealer.town, dealer.county]
            .map(part => String(part ?? "").trim())
            .filter(part => {
                const key = part.toLowerCase();
                if (!part || seen.has(key)) return false;
                seen.add(key);
                return true;
            });

        return parts.join(", ") || dealer.address || "Location unlisted";
    }

    function ratingLine(dealer) {
        const rating = Number(dealer.rating) || 0;
        const reviews = Number(dealer.review_count) || 0;
        const followers = Number(dealer.follower_count) || 0;

        return `${rating > 0 ? `★ ${rating.toFixed(1)}` : "No rating"} · ${reviews} review${reviews === 1 ? "" : "s"} · ${followers} follower${followers === 1 ? "" : "s"}`;
    }

    function productCount(dealer) {
        return Number(dealer.product_count) || 0;
    }

    function normalizedStatus(dealer) {
        const value = String(dealer.status || "active").toLowerCase();

        if (["inactive", "disabled", "deactivated"].includes(value)) {
            return "inactive";
        }

        if (value === "suspended") {
            return "suspended";
        }

        return "active";
    }

    function isVerified(dealer) {
        if (typeof dealer.verification_active === "boolean") return dealer.verification_active;
        if (dealer.is_verified !== true) return false;
        if (!dealer.verification_expires_at) return false;

        const expiry = new Date(dealer.verification_expires_at);
        return !Number.isNaN(expiry.getTime()) && expiry > new Date();
    }

    function verifiedBadge(dealer) {
        if (!isVerified(dealer)) return "";

        const expiry = new Date(dealer.verification_expires_at);
        const expiryFormatted = !Number.isNaN(expiry.getTime()) 
            ? expiry.toLocaleDateString() 
            : "";

        return `
            <span class="gh-verified"
                  title="Verified GasHub Partner (Valid until ${escapeHtml(expiryFormatted)})"
                  aria-label="Verified GasHub dealer">
                <svg class="gh-verified-seal"
                     viewBox="0 0 24 24"
                     aria-hidden="true">
                    <path d="M12 1.2 15 2.8 18.4 2.9 19.4 6.2
                    21.8 8.7 21 12 21.8 15.3 19.4 17.8
                    18.4 21.1 15 21.2 12 22.8 9 21.2
                    5.6 21.1 4.6 17.8 2.2 15.3 3 12
                    2.2 8.7 4.6 6.2 5.6 2.9 9 2.8Z"/>
                    <path d="m7.4 12.1 3 3.1 6.4-6.5"/>
                </svg>
                <span>Verified</span>
            </span>
        `;
    }

    function avatarColorClass(id) {
        const colors = ["", "avatar-green", "avatar-amber", "avatar-violet"];
        const num = String(id).split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
        return colors[num % colors.length];
    }

    function showMessage(message, type = "error") {
        if (!el.message) return;

        el.message.textContent = message;
        el.message.className = `admin-message ${type}`;
        el.message.style.display = message ? "block" : "none";

        if (message && type === "success") {
            setTimeout(() => {
                if (el.message.textContent === message) {
                    el.message.style.display = "none";
                }
            }, 6000);
        }
    }

    /* =========================================================
       API REQUEST WRAPPER
    ========================================================= */

    async function request(url, options = {}) {
        if (window.GasHubAdmin?.adminApiRequest) {
            return window.GasHubAdmin.adminApiRequest(url, options);
        }

        const token = localStorage.getItem("gashub_admin_token") || 
                      localStorage.getItem("adminToken") || "";

        const response = await fetch(url, {
            ...options,
            credentials: "include",
            headers: {
                ...(options.body ? { "Content-Type": "application/json" } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(options.headers || {})
            }
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(
                payload.message || `Request failed (${response.status})`
            );
        }

        return payload;
    }

    /* =========================================================
       STATISTICS & FILTERS
    ========================================================= */

    function updateStats() {
        if (el.total) {
            el.total.textContent = state.dealers.length;
        }

        if (el.active) {
            el.active.textContent = state.dealers.filter(
                dealer => normalizedStatus(dealer) === "active"
            ).length;
        }

        if (el.inactive) {
            el.inactive.textContent = state.dealers.filter(
                dealer => normalizedStatus(dealer) !== "active"
            ).length;
        }

        if (el.products) {
            el.products.textContent = state.dealers.reduce(
                (sum, dealer) => sum + productCount(dealer), 0
            );
        }
    }

    function applyFilters() {
        const query = String(el.search?.value || "").trim().toLowerCase();
        const selectedStatus = String(el.status?.value || "").trim().toLowerCase();

        state.filtered = state.dealers.filter(dealer => {
            const searchable = [
                nameOf(dealer),
                codeOf(dealer),
                dealer.username || "",
                dealer.contact_person || "",
                phoneOf(dealer),
                emailOf(dealer),
                locationOf(dealer),
                dealer.town || "",
                dealer.county || ""
            ].join(" ").toLowerCase();

            const matchesQuery = !query || searchable.includes(query);

            let matchesStatus = true;
            if (selectedStatus === "active") {
                matchesStatus = normalizedStatus(dealer) === "active";
            } else if (selectedStatus === "inactive") {
                matchesStatus = normalizedStatus(dealer) === "inactive";
            } else if (selectedStatus === "suspended") {
                matchesStatus = normalizedStatus(dealer) === "suspended";
            } else if (selectedStatus === "verified") {
                matchesStatus = isVerified(dealer);
            } else if (selectedStatus === "unverified") {
                matchesStatus = !isVerified(dealer);
            }

            return matchesQuery && matchesStatus;
        });

        state.page = 1;
        updateStats();
        render();
    }

    /* =========================================================
       TABLE RENDERING
    ========================================================= */

    function render() {
        if (!el.body) return;

        const total = state.filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

        state.page = Math.min(state.page, totalPages);

        const start = (state.page - 1) * PAGE_SIZE;
        const rows = state.filtered.slice(start, start + PAGE_SIZE);

        if (!rows.length) {
            el.body.innerHTML = `
                <tr>
                    <td colspan="6" class="table-empty">
                        ${state.loading
                            ? '<span class="loader"></span> Loading real dealers…'
                            : "No dealers matched your search or filter."}
                    </td>
                </tr>
            `;

            if (el.pageInfo) el.pageInfo.textContent = "Showing 0 dealers";
            if (el.pageButtons) el.pageButtons.innerHTML = "";
            if (el.countLabel) el.countLabel.textContent = "0 records";
            return;
        }

        el.body.innerHTML = rows.map(dealer => {
            const id = escapeHtml(dealerId(dealer));
            const status = normalizedStatus(dealer);
            const verified = isVerified(dealer);
            const isBusy = state.busyIds.has(String(dealerId(dealer)));

            const statusClass =
                status === "active" ? "success" :
                status === "suspended" ? "danger" : "neutral";

            const initials = nameOf(dealer)
                .split(/\s+/)
                .slice(0, 2)
                .map(part => part[0] || "")
                .join("")
                .toUpperCase() || "D";

            const onboardingNotice = dealer.onboarding_completed === false
                ? '<span class="onboarding-badge" title="Dealer has not completed initial password change">Pending setup</span>'
                : "";

            return `
                <tr>
                    <td>
                        <div class="dealer-cell">
                            <div class="dealer-avatar ${avatarColorClass(dealerId(dealer))}">
                                ${dealer.logo
                                    ? `<img src="${escapeHtml(dealer.logo)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" onerror="this.replaceWith(document.createTextNode('${escapeHtml(initials)}'))">`
                                    : escapeHtml(initials)}
                            </div>
                            <div class="dealer-name">
                                <div class="dealer-name-line">
                                    <strong>${escapeHtml(nameOf(dealer))}</strong>
                                    ${verifiedBadge(dealer)}
                                </div>
                                <div class="dealer-code-tag">
                                    <span>${escapeHtml(codeOf(dealer))}</span>
                                    ${onboardingNotice}
                                </div>
                                <small style="display:block;font-size:11px;color:#64748b;margin-top:2px;">${escapeHtml(ratingLine(dealer))}</small>
                            </div>
                        </div>
                    </td>
                    <td>
                        <div class="contact-cell">
                            <span class="contact-phone">${escapeHtml(phoneOf(dealer))}</span>
                            <span class="contact-email">${escapeHtml(emailOf(dealer))}</span>
                        </div>
                    </td>
                    <td>
                        <div class="location-cell">
                            <span class="location-pin" aria-hidden="true">⌖</span>
                            <div>
                                <span>${escapeHtml(locationOf(dealer))}</span>
                                ${dealer.latitude && dealer.longitude ? `<small style="display:block;font-size:10.5px;color:#64748b;margin-top:2px;font-family:monospace;">📍 ${Number(dealer.latitude).toFixed(4)}, ${Number(dealer.longitude).toFixed(4)}</small>` : ''}
                            </div>
                        </div>
                    </td>
                    <td>
                        <span class="product-count" title="${productCount(dealer)} products listed">
                            ${productCount(dealer)}
                        </span>
                    </td>
                    <td>
                        <span class="status-badge ${statusClass}">
                            ${escapeHtml(
                                status === "active" ? "Active" :
                                status === "suspended" ? "Suspended" : "Disabled"
                            )}
                        </span>
                    </td>
                    <td>
                        <div class="dealer-actions">
                            <button
                                type="button"
                                class="dealer-action view-action"
                                data-action="view"
                                data-id="${id}"
                                title="View dealer details and store">
                                View
                            </button>
                            <button
                                type="button"
                                class="dealer-action toggle-action ${status === "active" ? "disable-action" : "enable-action"}"
                                data-action="toggle"
                                data-id="${id}"
                                ${isBusy ? "disabled" : ""}
                                title="${status === "active" ? "Disable dealer store" : "Activate dealer store"}">
                                ${isBusy ? "Saving…" : status === "active" ? "Disable" : "Enable"}
                            </button>
                            <button
                                type="button"
                                class="dealer-action verify-action ${verified ? "verified-btn" : ""}"
                                data-action="verify-modal"
                                data-id="${id}"
                                ${isBusy ? "disabled" : ""}
                                title="${verified ? "Manage or revoke verified seal" : "Grant verified partner seal"}">
                                ${verified ? "★ Seal" : "+ Verify"}
                            </button>
                            <button
                                type="button"
                                class="dealer-action delete-action"
                                data-action="delete"
                                data-id="${id}"
                                ${isBusy ? "disabled" : ""}
                                title="Permanently delete dealer account">
                                Delete
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join("");

        if (el.pageInfo) {
            el.pageInfo.textContent =
                `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, total)} of ${total} dealers`;
        }

        if (el.countLabel) {
            el.countLabel.textContent =
                `${total} record${total === 1 ? "" : "s"}`;
        }

        renderPagination(totalPages);
    }

    function renderPagination(totalPages) {
        if (!el.pageButtons) return;

        el.pageButtons.innerHTML = "";

        function addButton(label, page, disabled, active = false) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = `pagination-button${active ? " active" : ""}`;
            button.textContent = label;
            button.disabled = disabled;

            button.addEventListener("click", () => {
                state.page = page;
                render();
            });

            el.pageButtons.appendChild(button);
        }

        addButton("‹", Math.max(1, state.page - 1), state.page === 1);

        for (let page = 1; page <= totalPages; page++) {
            addButton(String(page), page, false, page === state.page);
        }

        addButton(
            "›",
            Math.min(totalPages, state.page + 1),
            state.page === totalPages
        );
    }

    /* =========================================================
       LOAD DEALERS (GET /api/admin/dealers)
    ========================================================= */

    async function loadDealers() {
        if (state.loading) return;

        state.loading = true;
        showMessage("");

        if (el.body) {
            el.body.innerHTML = `
                <tr>
                    <td colspan="6" class="table-loading">
                        <span class="loader"></span> Loading real dealers from database…
                    </td>
                </tr>
            `;
        }

        try {
            const result = await request(DEALERS_API);

            if (result.success !== true || !Array.isArray(result.dealers)) {
                throw new Error("The dealers API returned an unexpected response.");
            }

            state.dealers = result.dealers;
            applyFilters();
        } catch (error) {
            console.error("Unable to load GasHub dealers:", error);

            state.dealers = [];
            state.filtered = [];
            updateStats();
            render();

            showMessage(
                `Could not load dealers from the database: ${error.message}`
            );
        } finally {
            state.loading = false;
        }
    }

    /* =========================================================
       ADD DEALER MODAL (POST /api/admin/dealers)
    ========================================================= */

    const addDealerModal = document.getElementById("addDealerModal");
    const addDealerForm = document.getElementById("addDealerForm");
    const addDealerMessage = document.getElementById("addDealerMessage");
    const submitAddDealer = document.getElementById("submitAddDealer");

    function closeAddDealerModal() {
        if (addDealerModal) addDealerModal.hidden = true;
        addDealerForm?.reset();
        if (addDealerMessage) {
            addDealerMessage.textContent = "";
            addDealerMessage.style.display = "none";
            addDealerMessage.className = "admin-message";
        }
    }

    document.getElementById("openAddDealer")?.addEventListener("click", () => {
        if (addDealerModal) addDealerModal.hidden = false;
        addDealerForm?.querySelector('input[name="username"]')?.focus();
    });

    document.getElementById("closeAddDealer")?.addEventListener("click", closeAddDealerModal);
    document.getElementById("cancelAddDealer")?.addEventListener("click", closeAddDealerModal);
    addDealerModal?.querySelector("[data-close-dealer-modal]")?.addEventListener("click", closeAddDealerModal);

    addDealerForm?.addEventListener("submit", async event => {
        event.preventDefault();
        if (!addDealerForm.reportValidity()) return;

        const payload = Object.fromEntries(new FormData(addDealerForm).entries());

        if (submitAddDealer) {
            submitAddDealer.disabled = true;
            submitAddDealer.textContent = "Creating…";
        }

        if (addDealerMessage) {
            addDealerMessage.textContent = "";
            addDealerMessage.style.display = "none";
        }

        try {
            const result = await request("/api/admin/dealers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!result.success) {
                throw new Error(result.message || "Could not create dealer.");
            }

            closeAddDealerModal();
            showMessage(
                `One-time dealer login created. Username: ${result.credentials?.username || payload.username}. Share the initial password privately.`,
                "success"
            );
            await loadDealers();
        } catch (error) {
            if (addDealerMessage) {
                addDealerMessage.textContent = error.message || "Could not create dealer.";
                addDealerMessage.className = "admin-message error";
                addDealerMessage.style.display = "block";
            }
        } finally {
            if (submitAddDealer) {
                submitAddDealer.disabled = false;
                submitAddDealer.textContent = "Create login";
            }
        }
    });

    /* =========================================================
       VERIFICATION DECISION MODAL
       Endpoint: PATCH /api/admin/dealers/:id/verification
    ========================================================= */

    const verifyDealerModal = document.getElementById("verifyDealerModal");
    const verifyDealerForm = document.getElementById("verifyDealerForm");
    const verifyModalMessage = document.getElementById("verifyModalMessage");
    const verifyModalSubtitle = document.getElementById("verifyModalSubtitle");
    const verifyDecisionSelect = document.getElementById("verifyDecisionSelect");
    const verifyDurationContainer = document.getElementById("verifyDurationContainer");
    const verifyDurationSelect = document.getElementById("verifyDurationSelect");
    const verifyCustomDateWrapper = document.getElementById("verifyCustomDateWrapper");
    const verifyCustomExpiryDate = document.getElementById("verifyCustomExpiryDate");
    const submitVerifyModal = document.getElementById("submitVerifyModal");

    function openVerifyModal(dealer) {
        state.currentVerifyingDealer = dealer;
        if (!verifyDealerModal) return;

        const currentlyVerified = isVerified(dealer);

        if (verifyModalSubtitle) {
            verifyModalSubtitle.textContent = `Managing verification seal for "${nameOf(dealer)}"`;
        }

        if (verifyDecisionSelect) {
            verifyDecisionSelect.value = currentlyVerified ? "revoke" : "grant";
        }

        if (verifyDurationContainer) {
            verifyDurationContainer.style.display = currentlyVerified ? "none" : "block";
        }

        if (verifyModalMessage) {
            verifyModalMessage.textContent = "";
            verifyModalMessage.style.display = "none";
        }

        // Set min date for custom picker to tomorrow
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (verifyCustomExpiryDate) {
            verifyCustomExpiryDate.min = tomorrow.toISOString().split("T")[0];
            verifyCustomExpiryDate.value = "";
        }

        verifyDealerModal.hidden = false;
    }

    function closeVerifyModal() {
        if (verifyDealerModal) verifyDealerModal.hidden = true;
        state.currentVerifyingDealer = null;
        verifyDealerForm?.reset();
    }

    verifyDecisionSelect?.addEventListener("change", () => {
        const granting = verifyDecisionSelect.value === "grant";
        if (verifyDurationContainer) {
            verifyDurationContainer.style.display = granting ? "block" : "none";
        }
    });

    verifyDurationSelect?.addEventListener("change", () => {
        if (verifyCustomDateWrapper) {
            verifyCustomDateWrapper.style.display = 
                verifyDurationSelect.value === "custom" ? "block" : "none";
        }
    });

    document.getElementById("closeVerifyModal")?.addEventListener("click", closeVerifyModal);
    document.getElementById("cancelVerifyModal")?.addEventListener("click", closeVerifyModal);
    verifyDealerModal?.querySelector("[data-close-verify-modal]")?.addEventListener("click", closeVerifyModal);

    verifyDealerForm?.addEventListener("submit", async event => {
        event.preventDefault();
        const dealer = state.currentVerifyingDealer;
        if (!dealer) return;

        const id = dealerId(dealer);
        const decision = verifyDecisionSelect?.value;
        const granting = decision === "grant";

        let expiresAt = null;

        if (granting) {
            const duration = verifyDurationSelect?.value || "365";
            if (duration === "custom") {
                const customVal = verifyCustomExpiryDate?.value;
                if (!customVal) {
                    if (verifyModalMessage) {
                        verifyModalMessage.textContent = "Please select a valid custom expiry date.";
                        verifyModalMessage.className = "admin-message error";
                        verifyModalMessage.style.display = "block";
                    }
                    return;
                }
                expiresAt = new Date(`${customVal}T23:59:59Z`).toISOString();
            } else {
                const days = Number(duration) || 365;
                const date = new Date();
                date.setDate(date.getDate() + days);
                expiresAt = date.toISOString();
            }
        }

        if (submitVerifyModal) {
            submitVerifyModal.disabled = true;
            submitVerifyModal.textContent = "Saving Decision…";
        }

        try {
            const result = await request(`${DEALERS_API}/${encodeURIComponent(id)}/verification`, {
                method: "PATCH",
                body: JSON.stringify({
                    verified: granting,
                    expiresAt: expiresAt
                })
            });

            const updated = result?.dealer || result?.data?.dealer || result?.data;
            if (updated && typeof updated === "object") {
                Object.assign(dealer, updated);
            } else {
                dealer.is_verified = granting;
                dealer.verification_expires_at = expiresAt;
            }

            closeVerifyModal();
            showMessage(
                granting
                    ? `Verification seal granted to ${nameOf(dealer)}.`
                    : `Verification seal revoked for ${nameOf(dealer)}.`,
                "success"
            );
            applyFilters();
        } catch (error) {
            if (verifyModalMessage) {
                verifyModalMessage.textContent = error.message || "Failed to update verification status.";
                verifyModalMessage.className = "admin-message error";
                verifyModalMessage.style.display = "block";
            }
        } finally {
            if (submitVerifyModal) {
                submitVerifyModal.disabled = false;
                submitVerifyModal.textContent = "Save Decision";
            }
        }
    });

    /* =========================================================
       DEALER DECISIONS: STATUS TOGGLE & DELETE
    ========================================================= */

    async function toggleDealer(id) {
        const dealer = state.dealers.find(item => String(dealerId(item)) === String(id));
        if (!dealer || state.busyIds.has(String(id))) return;

        const enabling = normalizedStatus(dealer) !== "active";
        const nextStatus = enabling ? "active" : "inactive";
        const action = enabling ? "enable" : "disable";

        if (!(await GasHubDialog.confirm({
            title: enabling ? "Enable dealer?" : "Disable dealer?",
            message: `${enabling ? "Enable" : "Disable"} ${nameOf(dealer)} on the marketplace?`,
            confirmText: enabling ? "Enable" : "Disable", tone: enabling ? "success" : "warning"
        }))) {
            return;
        }

        state.busyIds.add(String(id));
        render();

        try {
            const result = await request(`${DEALERS_API}/${encodeURIComponent(id)}/status`, {
                method: "PATCH",
                body: JSON.stringify({ status: nextStatus })
            });

            const updated = result?.dealer || result?.data?.dealer || result?.data;
            if (updated && typeof updated === "object") {
                Object.assign(dealer, updated);
            }

            dealer.status = nextStatus;
            if ("is_active" in dealer) dealer.is_active = enabling;
            showMessage(`${nameOf(dealer)} has been ${action}d.`, "success");
        } catch (error) {
            showMessage(error.message || `Could not ${action} this dealer.`);
        } finally {
            state.busyIds.delete(String(id));
            applyFilters();
        }
    }

    async function deleteDealer(id) {
        const dealer = state.dealers.find(item => String(dealerId(item)) === String(id));
        if (!dealer || state.busyIds.has(String(id))) return;

        if (!(await GasHubDialog.confirm({
            title: "Delete dealer?",
            message: `Permanently delete ${nameOf(dealer)}? This will remove access and cannot be undone.`,
            confirmText: "Delete", tone: "danger"
        }))) {
            return;
        }

        state.busyIds.add(String(id));
        render();

        try {
            await request(`${DEALERS_API}/${encodeURIComponent(id)}`, {
                method: "DELETE"
            });

            state.dealers = state.dealers.filter(item => String(dealerId(item)) !== String(id));
            showMessage(`${nameOf(dealer)} was removed successfully.`, "success");
            applyFilters();
        } catch (error) {
            showMessage(error.message || "Could not delete this dealer.");
        } finally {
            state.busyIds.delete(String(id));
            render();
        }
    }

    async function toggleVerification(id) {
        const dealer = state.dealers.find(item => String(dealerId(item)) === String(id));
        if (!dealer || state.busyIds.has(String(id))) return;

        const currentlyVerified = isVerified(dealer);
        const action = currentlyVerified ? "Revoke" : "Grant";
        const promptMsg = currentlyVerified
            ? `Revoke verified partner seal for ${nameOf(dealer)}?`
            : `Grant official GasHub Verified seal to ${nameOf(dealer)} for 1 year (365 days)?`;

        if (!(await GasHubDialog.confirm({
            title: currentlyVerified ? "Revoke verified seal?" : "Grant verified seal?",
            message: promptMsg,
            confirmText: currentlyVerified ? "Revoke" : "Grant", tone: currentlyVerified ? "warning" : "success"
        }))) return;

        state.busyIds.add(String(id));
        render();

        try {
            const nextVerified = !currentlyVerified;
            const expiresAt = nextVerified 
                ? new Date(Date.now() + 365 * 86400000).toISOString() 
                : null;

            const result = await request(`${DEALERS_API}/${encodeURIComponent(id)}/verification`, {
                method: "PATCH",
                body: JSON.stringify({ verified: nextVerified, expiresAt })
            });

            const updated = result?.dealer || result?.data?.dealer || result?.data;
            if (updated && typeof updated === "object") {
                Object.assign(dealer, updated);
            } else {
                dealer.is_verified = nextVerified;
                dealer.verification_expires_at = expiresAt;
            }

            showMessage(
                nextVerified
                    ? `Verification seal granted to ${nameOf(dealer)}.`
                    : `Verification seal revoked for ${nameOf(dealer)}.`,
                "success"
            );
        } catch (error) {
            showMessage(error.message || `Could not ${action.toLowerCase()} verification for this dealer.`);
        } finally {
            state.busyIds.delete(String(id));
            applyFilters();
        }
    }

    /* =========================================================
       EVENT LISTENERS
    ========================================================= */

    el.search?.addEventListener("input", applyFilters);
    el.status?.addEventListener("change", applyFilters);
    el.refresh?.addEventListener("click", loadDealers);

    el.body?.addEventListener("click", async event => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;

        const id = button.dataset.id;
        if (!id) return;

        const action = button.dataset.action;

        if (action === "view") {
            window.location.href = `admin-dealer-details.html?id=${encodeURIComponent(id)}`;
        } else if (action === "toggle") {
            await toggleDealer(id);
        } else if (action === "verify-modal") {
            await toggleVerification(id);
        } else if (action === "delete") {
            await deleteDealer(id);
        }
    });

    // Mobile sidebar toggle
    el.mobileMenu?.addEventListener("click", () => {
        el.sidebar?.classList.toggle("open");
        el.overlay?.classList.toggle("open");
    });

    el.overlay?.addEventListener("click", () => {
        el.sidebar?.classList.remove("open");
        el.overlay?.classList.remove("open");
    });

    // Copyright year
    const yearEl = document.getElementById("currentYear");
    if (yearEl) {
        yearEl.textContent = String(new Date().getFullYear());
    }

    // Initialize data
    loadDealers();
});