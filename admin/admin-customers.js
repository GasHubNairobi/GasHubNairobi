 /* =========================================================
    GASHUB ADMIN - CUSTOMERS
 ========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    initializeCustomersPage();
});

let customers = [];
let currentCustomerPage = 1;
let selectedCustomerId = null;

const CUSTOMERS_PER_PAGE = 10;

/* =========================================================
   INITIALIZE
========================================================= */

function initializeCustomersPage() {
    bindCustomerEvents();
    loadCustomers();
}

/* =========================================================
   EVENTS
========================================================= */

function bindCustomerEvents() {
    const searchInput =
        document.getElementById("customerSearch");

    const statusFilter =
        document.getElementById("customerStatusFilter");

    searchInput?.addEventListener("input", () => {
        currentCustomerPage = 1;
        renderCustomers();
    });

    statusFilter?.addEventListener("change", () => {
        currentCustomerPage = 1;
        renderCustomers();
    });

    document
        .getElementById("closeCustomerModal")
        ?.addEventListener(
            "click",
            closeCustomerDetailsModal
        );

    document
        .getElementById("closeCustomerButton")
        ?.addEventListener(
            "click",
            closeCustomerDetailsModal
        );

    document
        .getElementById("customerModalBackdrop")
        ?.addEventListener(
            "click",
            closeCustomerDetailsModal
        );

    document
        .getElementById("viewCustomerOrdersButton")
        ?.addEventListener(
            "click",
            viewCustomerOrders
        );

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeCustomerDetailsModal();
        }
    });
}

/* =========================================================
   LOAD CUSTOMERS
========================================================= */

async function loadCustomers() {
    const tableBody =
        document.getElementById("customersTableBody");

    try {
        if (tableBody) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="table-loading">
                        Loading customers...
                    </td>
                </tr>
            `;
        }

        const response =
            await GasHubAdmin.adminApiRequest(
                "/api/admin/customers"
            );

        customers =
            normalizeCustomersResponse(response);

        currentCustomerPage = 1;

        updateCustomerStatistics();
        renderCustomers();

    } catch (error) {
        console.error(
            "Failed to load customers:",
            error
        );

        customers = [];

        updateCustomerStatistics();

        if (tableBody) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="table-empty">
                        <strong>Unable to load customers</strong>
                        <span>
                            ${escapeHtml(
                                error.message ||
                                "Please try again later."
                            )}
                        </span>
                    </td>
                </tr>
            `;
        }

        showCustomerMessage(
            error.message ||
            "Unable to load customers.",
            "error"
        );
    }
}

/* =========================================================
   NORMALIZE RESPONSE
========================================================= */

function normalizeCustomersResponse(response) {
    if (Array.isArray(response)) {
        return response;
    }

    if (Array.isArray(response?.customers)) {
        return response.customers;
    }

    if (Array.isArray(response?.data)) {
        return response.data;
    }

    if (Array.isArray(response?.data?.customers)) {
        return response.data.customers;
    }

    return [];
}

/* =========================================================
   STATISTICS
========================================================= */

function updateCustomerStatistics() {
    const total =
        customers.length;

    const active =
        customers.filter(customer =>
            normalizeCustomerStatus(
                customer.status
            ) === "active"
        ).length;

    const inactive =
        customers.filter(customer =>
            normalizeCustomerStatus(
                customer.status
            ) === "inactive"
        ).length;

    const now = new Date();

    const newCustomers =
        customers.filter(customer => {

            const createdAt =
                customer.created_at;

            if (!createdAt) {
                return false;
            }

            const date =
                new Date(createdAt);

            if (Number.isNaN(date.getTime())) {
                return false;
            }

            const difference =
                now.getTime() -
                date.getTime();

            return difference <=
                30 * 24 * 60 * 60 * 1000;

        }).length;

    setCustomerText(
        "totalCustomers",
        total
    );

    setCustomerText(
        "activeCustomers",
        active
    );

    setCustomerText(
        "inactiveCustomers",
        inactive
    );

    setCustomerText(
        "newCustomers",
        newCustomers
    );
}

/* =========================================================
   FILTER CUSTOMERS
========================================================= */

function getFilteredCustomers() {
    const searchValue =
        (
            document.getElementById(
                "customerSearch"
            )?.value || ""
        )
            .trim()
            .toLowerCase();

    const statusValue =
        (
            document.getElementById(
                "customerStatusFilter"
            )?.value || ""
        )
            .trim()
            .toLowerCase();

    return customers.filter(customer => {

        const name =
            String(
                customer.full_name || ""
            ).toLowerCase();

        const code =
            String(
                customer.user_code || ""
            ).toLowerCase();

        const phone =
            String(
                customer.phone || ""
            ).toLowerCase();

        const email =
            String(
                customer.email || ""
            ).toLowerCase();

        const address =
            String(
                customer.default_address || ""
            ).toLowerCase();

        const matchesSearch =
            !searchValue ||
            name.includes(searchValue) ||
            code.includes(searchValue) ||
            phone.includes(searchValue) ||
            email.includes(searchValue) ||
            address.includes(searchValue);

        const status =
            normalizeCustomerStatus(
                customerDisplayStatus(customer)
            );

        const matchesStatus =
            !statusValue ||
            status === statusValue;

        return (
            matchesSearch &&
            matchesStatus
        );
    });
}

/* =========================================================
   RENDER CUSTOMERS
========================================================= */

function renderCustomers() {
    const tableBody =
        document.getElementById(
            "customersTableBody"
        );

    if (!tableBody) {
        return;
    }

    const filteredCustomers =
        getFilteredCustomers();

    const totalPages =
        Math.max(
            1,
            Math.ceil(
                filteredCustomers.length /
                CUSTOMERS_PER_PAGE
            )
        );

    if (
        currentCustomerPage >
        totalPages
    ) {
        currentCustomerPage =
            totalPages;
    }

    const startIndex =
        (
            currentCustomerPage - 1
        ) *
        CUSTOMERS_PER_PAGE;

    const pageCustomers =
        filteredCustomers.slice(
            startIndex,
            startIndex +
                CUSTOMERS_PER_PAGE
        );

    if (!pageCustomers.length) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="8" class="table-empty">
                    <strong>No customers found</strong>
                    <span>
                        There are no customers matching the current search or filter.
                    </span>
                </td>
            </tr>
        `;

        updateCustomerPagination(
            filteredCustomers.length,
            totalPages
        );

        return;
    }

    tableBody.innerHTML =
        pageCustomers
            .map(createCustomerRow)
            .join("");

    updateCustomerPagination(
        filteredCustomers.length,
        totalPages
    );
}

/* =========================================================
   CUSTOMER ROW
========================================================= */

function createCustomerRow(customer) {
    const id =
        customer.id || "";

    const name =
        customer.full_name ||
        "Unnamed Customer";

    const code =
        customer.user_code ||
        "—";

    const phone =
        customer.phone ||
        "—";

    const email =
        customer.email ||
        "—";

    const address =
        customer.default_address ||
        "—";

    const status =
        normalizeCustomerStatus(
            customer.status
        );

    const createdAt =
        customer.created_at;

    return `
        <tr>

            <td>
                <span class="table-primary-text">
                    ${escapeHtml(name)}
                </span>
            </td>

            <td>
                <span class="table-code">
                    ${escapeHtml(code)}
                </span>
            </td>

            <td>
                ${escapeHtml(phone)}
            </td>

            <td>
                ${escapeHtml(email)}
            </td>

            <td>
                <span class="table-secondary-text">
                    ${escapeHtml(address)}
                </span>
            </td>

            <td>
                ${createCustomerStatusBadge(customerDisplayStatus(customer))}
            </td>

            <td>
                <span class="table-secondary-text">
                    ${escapeHtml(
                        formatCustomerDate(
                            createdAt
                        )
                    )}
                </span>
            </td>

            <td>
                <div class="table-actions">

                    <button
                        type="button"
                        class="table-action-button"
                        data-customer-action="view"
                        data-customer-id="${escapeHtml(
                            String(id)
                        )}"
                    >
                        View
                    </button>

                    ${createCustomerModerationButtons(customer)}

                </div>
            </td>

        </tr>
    `;
}

/* =========================================================
   CUSTOMER ACTIONS
========================================================= */

document.addEventListener("click", event => {

    const button =
        event.target.closest(
            "[data-customer-action]"
        );

    if (!button) {
        return;
    }

    const action =
        button.dataset.customerAction;

    const customerId =
        button.dataset.customerId;

    if (!customerId) {
        return;
    }

    if (action === "view") {
        openCustomerDetails(
            customerId
        );
    } else if (action === "ban") {
        banCustomer(customerId);
    } else if (action === "unban") {
        unbanCustomer(customerId);
    } else if (action === "delete") {
        deleteCustomer(customerId);
    }

});

/* =========================================================
   BAN / UNBAN / DELETE
   Ban: customer is signed out and cannot sign in (reason is kept).
   Delete: personal details are erased; if they were banned, their
   email, phone and social login can't be used to sign up again.
========================================================= */

function createCustomerModerationButtons(customer) {
    if (isDeletedCustomer(customer)) {
        return "";
    }

    const id = escapeHtml(String(customer.id || ""));

    const toggle = customer.banned_at
        ? `<button type="button" class="table-action-button"
                data-customer-action="unban" data-customer-id="${id}">Unban</button>`
        : `<button type="button" class="table-action-button danger"
                data-customer-action="ban" data-customer-id="${id}">Ban</button>`;

    return `
        ${toggle}
        <button type="button" class="table-action-button danger"
            data-customer-action="delete" data-customer-id="${id}">Delete</button>
    `;
}

function findCustomerById(customerId) {
    return customers.find(item => String(item.id) === String(customerId));
}

async function banCustomer(customerId) {
    const customer = findCustomerById(customerId);
    const name = customer?.full_name || "this customer";

    const reason = await GasHubDialog.prompt({
        title: "Ban " + name + "?",
        message: "They will be signed out straight away and won't be able to sign in. You can lift the ban later.",
        label: "Reason (what rule did they break?)",
        placeholder: "e.g. Repeated fake orders",
        confirmText: "Ban account",
        required: true
    });

    if (reason === null || !String(reason).trim()) {
        return;
    }

    try {
        const result = await GasHubAdmin.adminApiRequest(
            `/api/admin/customers/${encodeURIComponent(customerId)}/ban`,
            { method: "PATCH", body: { reason: String(reason).trim() } }
        );
        showCustomerMessage(result?.message || "Customer banned.", "success");
        await loadCustomers();
    } catch (error) {
        showCustomerMessage(error.message || "Unable to ban this customer.", "error");
    }
}

async function unbanCustomer(customerId) {
    const customer = findCustomerById(customerId);

    const ok = await GasHubDialog.confirm({
        title: "Lift the ban?",
        message: `${customer?.full_name || "This customer"} will be able to sign in again.`,
        confirmText: "Unban",
        tone: "primary"
    });

    if (!ok) {
        return;
    }

    try {
        const result = await GasHubAdmin.adminApiRequest(
            `/api/admin/customers/${encodeURIComponent(customerId)}/unban`,
            { method: "PATCH" }
        );
        showCustomerMessage(result?.message || "Ban lifted.", "success");
        await loadCustomers();
    } catch (error) {
        showCustomerMessage(error.message || "Unable to lift this ban.", "error");
    }
}

async function deleteCustomer(customerId) {
    const customer = findCustomerById(customerId);
    const name = customer?.full_name || "this customer";
    const banned = Boolean(customer?.banned_at);

    const ok = await GasHubDialog.confirm({
        title: "Delete " + name + "?",
        message: "This permanently erases their name, email, phone, address and points. "
            + "Past orders stay for your records without their name. This cannot be undone."
            + (banned
                ? "\n\nBecause they are banned, their email, phone and social login will also be blocked from signing up again."
                : "\n\nThey are not banned, so they could sign up again. Ban them first if this is for breaking the rules."),
        confirmText: "Delete account",
        tone: "danger"
    });

    if (!ok) {
        return;
    }

    const send = force => GasHubAdmin.adminApiRequest(
        `/api/admin/customers/${encodeURIComponent(customerId)}`,
        { method: "DELETE", body: { force, reason: customer?.ban_reason || "" } }
    );

    try {
        let result;

        try {
            result = await send(false);
        } catch (error) {
            if (error.code !== "open_orders") {
                throw error;
            }

            const again = await GasHubDialog.confirm({
                title: "Orders still in progress",
                message: error.message + " Delete the account anyway?",
                confirmText: "Delete anyway",
                tone: "danger"
            });

            if (!again) {
                return;
            }

            result = await send(true);
        }

        showCustomerMessage(result?.message || "Account deleted.", "success");
        closeCustomerDetailsModal();
        await loadCustomers();
    } catch (error) {
        showCustomerMessage(error.message || "Unable to delete this customer.", "error");
    }
}

/* =========================================================
   CUSTOMER DETAILS
========================================================= */

async function openCustomerDetails(
    customerId
) {
    selectedCustomerId =
        customerId;

    const modal =
        document.getElementById(
            "customerDetailsModal"
        );

    const body =
        document.getElementById(
            "customerDetailsBody"
        );

    const title =
        document.getElementById(
            "customerModalTitle"
        );

    const subtitle =
        document.getElementById(
            "customerModalSubtitle"
        );

    if (!modal || !body) {
        return;
    }

    const customer =
        customers.find(item =>
            String(item.id) ===
            String(customerId)
        );

    if (title) {
        title.textContent =
            customer?.full_name ||
            "Customer Details";
    }

    if (subtitle) {
        subtitle.textContent =
            customer?.user_code
                ? `Customer ${customer.user_code}`
                : "View customer information.";
    }

    body.innerHTML = `
        <div class="table-loading">
            Loading customer details...
        </div>
    `;

    openCustomerModal(modal);

    try {
        const response =
            await GasHubAdmin.adminApiRequest(
                `/api/admin/customers/${encodeURIComponent(
                    customerId
                )}`
            );

        const detailedCustomer = {
            ...(
                response?.customer ||
                response?.data ||
                response ||
                customer
            ),
            ...(response?.statistics || {}),
            orders: response?.orders || [],
            coin_history: response?.coin_history || [],
            withdrawals: response?.withdrawals || []
        };

        body.innerHTML =
            createCustomerDetails(
                detailedCustomer
            );

    } catch (error) {
        console.error(
            "Failed to load customer details:",
            error
        );

        if (customer) {
            body.innerHTML =
                createCustomerDetails(
                    customer
                );
        } else {
            body.innerHTML = `
                <div class="table-empty">
                    <strong>
                        Unable to load customer
                    </strong>

                    <span>
                        ${escapeHtml(
                            error.message ||
                            "Please try again later."
                        )}
                    </span>
                </div>
            `;
        }
    }
}

/* =========================================================
   CUSTOMER DETAILS HTML
========================================================= */

function createCustomerDetails(
    customer
) {
    const name =
        customer.full_name ||
        "—";

    const code =
        customer.user_code ||
        "—";

    const phone =
        customer.phone ||
        "—";

    const email =
        customer.email ||
        "—";

    const address =
        customer.default_address ||
        "—";

    const status =
        normalizeCustomerStatus(
            customer.status
        );

    const registered =
        customer.created_at;

    const lastLogin =
        customer.last_login_at;

    return `
        <div style="
            padding: 24px;
        ">

            <div style="
                display: grid;
                grid-template-columns:
                    repeat(2, minmax(0, 1fr));
                gap: 20px;
            ">

                <div>
                    <span class="table-secondary-text">
                        Full Name
                    </span>

                    <strong class="table-primary-text">
                        ${escapeHtml(name)}
                    </strong>
                </div>

                <div>
                    <span class="table-secondary-text">
                        Customer Code
                    </span>

                    <strong class="table-primary-text">
                        ${escapeHtml(code)}
                    </strong>
                </div>

                <div>
                    <span class="table-secondary-text">
                        Phone
                    </span>

                    <strong class="table-primary-text">
                        ${escapeHtml(phone)}
                    </strong>
                </div>

                <div>
                    <span class="table-secondary-text">
                        Email
                    </span>

                    <strong class="table-primary-text">
                        ${escapeHtml(email)}
                    </strong>
                </div>

                <div style="
                    grid-column: 1 / -1;
                ">
                    <span class="table-secondary-text">
                        Default Address
                    </span>

                    <strong class="table-primary-text">
                        ${escapeHtml(address)}
                    </strong>
                </div>

                <div>
                    <span class="table-secondary-text">
                        Status
                    </span>

                    <div style="
                        margin-top: 5px;
                    ">
                        ${createCustomerStatusBadge(
                            customerDisplayStatus(customer)
                        )}
                    </div>
                </div>

                ${customer.banned_at ? `
                <div>
                    <span class="table-secondary-text">
                        Ban reason
                    </span>

                    <strong class="table-primary-text">
                        ${escapeHtml(customer.ban_reason || "—")}
                    </strong>
                    <span class="table-secondary-text">
                        Banned ${escapeHtml(formatCustomerDate(customer.banned_at))}
                    </span>
                </div>` : ""}

                <div>
                    <span class="table-secondary-text">
                        Registered
                    </span>

                    <strong class="table-primary-text">
                        ${escapeHtml(
                            formatCustomerDate(
                                registered
                            )
                        )}
                    </strong>
                </div>

                <div>
                    <span class="table-secondary-text">
                        Last Login
                    </span>

                    <strong class="table-primary-text">
                        ${escapeHtml(
                            formatCustomerDate(
                                lastLogin
                            )
                        )}
                    </strong>
                </div>

            ${createCustomerManagePanel(customer)}

            </div>

        </div>
    `;
}

/* =========================================================
   MANAGE ONE CUSTOMER: orders, GasHub coins, withdrawals
========================================================= */

function ksh(n) {
    return "KSh " + Number(n || 0).toLocaleString("en-KE", { maximumFractionDigits: 2 });
}

function coinsFmt(n) {
    return Number(n || 0).toLocaleString("en-KE");
}

function createCustomerManagePanel(c) {
    if (c.points_balance === undefined) return "";

    const orders = c.orders || [];
    const completed = orders.filter(o => String(o.status).toLowerCase() === "completed");
    const completedValue = completed.reduce((t, o) => t + (Number(o.total_amount) || 0), 0);
    const withdrawals = c.withdrawals || [];
    const history = c.coin_history || [];

    const orderRows = orders.length ? orders.map(o => `
        <tr>
            <td><strong>${escapeHtml(o.order_number || o.id)}</strong></td>
            <td>${escapeHtml(o.product_name || "—")}<br><small>${escapeHtml(o.dealer_name || "")}</small></td>
            <td>${escapeHtml(ksh(o.total_amount))}</td>
            <td><span class="cm-pill cm-${escapeHtml(String(o.status || "").toLowerCase())}">${escapeHtml(o.status || "—")}</span></td>
            <td>${escapeHtml(o.payment_status || "—")}</td>
            <td>${escapeHtml(formatCustomerDate(o.created_at))}</td>
        </tr>`).join("") : `<tr><td colspan="6" class="cm-empty">This customer has no orders yet.</td></tr>`;

    const wdRows = withdrawals.length ? withdrawals.map(w => `
        <tr>
            <td><strong>${escapeHtml(w.reference)}</strong></td>
            <td>${escapeHtml(coinsFmt(w.points))}</td>
            <td>${escapeHtml(ksh(w.amount_ksh))}${Number(w.fee_ksh) > 0 ? `<br><small>fee ${escapeHtml(ksh(w.fee_ksh))}</small>` : ""}</td>
            <td>${escapeHtml(w.phone || "—")}</td>
            <td><span class="cm-pill cm-${escapeHtml(String(w.status).toLowerCase())}">${escapeHtml(w.status)}</span>${w.admin_note ? `<br><small>${escapeHtml(w.admin_note)}</small>` : ""}</td>
            <td>${escapeHtml(formatCustomerDate(w.created_at))}</td>
        </tr>`).join("") : `<tr><td colspan="6" class="cm-empty">No withdrawals yet.</td></tr>`;

    const coinRows = history.length ? history.map(h => {
        const pts = Number(h.points) || 0;
        return `<tr>
            <td class="${pts < 0 ? "cm-neg" : "cm-pos"}"><strong>${pts > 0 ? "+" : ""}${escapeHtml(coinsFmt(pts))}</strong></td>
            <td>${escapeHtml(String(h.reason || "").replace(/_/g, " "))}</td>
            <td>${escapeHtml(h.note || "")}</td>
            <td>${escapeHtml(formatCustomerDate(h.created_at))}</td>
        </tr>`;
    }).join("") : `<tr><td colspan="4" class="cm-empty">No coin activity yet.</td></tr>`;

    return `
    <div class="cm-wrap" style="grid-column: 1 / -1;">
        <div class="cm-stats">
            <div class="cm-stat"><span>Orders completed</span><strong>${escapeHtml(String(completed.length))}</strong><small>of ${escapeHtml(String(orders.length))} placed &middot; ${escapeHtml(ksh(completedValue))}</small></div>
            <div class="cm-stat cm-gold"><span>GasHub Coins balance</span><strong>${escapeHtml(coinsFmt(c.points_balance))}</strong><small>earned ${escapeHtml(coinsFmt(c.points_earned))} &middot; used ${escapeHtml(coinsFmt(c.points_used))}</small></div>
            <div class="cm-stat"><span>Withdrawn so far</span><strong>${escapeHtml(ksh(c.withdrawn_ksh))}</strong><small>${escapeHtml(coinsFmt(c.withdrawn_coins))} coins paid out</small></div>
            <div class="cm-stat"><span>Withdrawal pending</span><strong>${escapeHtml(ksh(c.pending_withdrawal_ksh))}</strong><small>${escapeHtml(coinsFmt(c.pending_withdrawal_coins))} coins awaiting payment</small></div>
        </div>

        <div class="cm-tabs" role="tablist">
            <button type="button" class="cm-tab on" data-cm-tab="orders">Orders (${orders.length})</button>
            <button type="button" class="cm-tab" data-cm-tab="withdrawals">Withdrawals (${withdrawals.length})</button>
            <button type="button" class="cm-tab" data-cm-tab="coins">Coin activity (${history.length})</button>
        </div>

        <div class="cm-pane" data-cm-pane="orders"><div class="cm-scroll"><table class="cm-table">
            <thead><tr><th>Order</th><th>Product / dealer</th><th>Total</th><th>Status</th><th>Payment</th><th>Date</th></tr></thead>
            <tbody>${orderRows}</tbody></table></div></div>

        <div class="cm-pane" data-cm-pane="withdrawals" hidden><div class="cm-scroll"><table class="cm-table">
            <thead><tr><th>Reference</th><th>Coins</th><th>Amount</th><th>M-Pesa</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>${wdRows}</tbody></table></div></div>

        <div class="cm-pane" data-cm-pane="coins" hidden><div class="cm-scroll"><table class="cm-table">
            <thead><tr><th>Coins</th><th>Reason</th><th>Note</th><th>Date</th></tr></thead>
            <tbody>${coinRows}</tbody></table></div></div>
    </div>`;
}

document.addEventListener("click", (e) => {
    const tab = e.target.closest && e.target.closest("[data-cm-tab]");
    if (!tab) return;
    const wrap = tab.closest(".cm-wrap");
    wrap.querySelectorAll("[data-cm-tab]").forEach(t => t.classList.toggle("on", t === tab));
    wrap.querySelectorAll("[data-cm-pane]").forEach(p => { p.hidden = p.dataset.cmPane !== tab.dataset.cmTab; });
});

/* =========================================================
   VIEW CUSTOMER ORDERS
========================================================= */

function viewCustomerOrders() {
    if (!selectedCustomerId) {
        return;
    }

    window.location.href =
        `admin-orders.html?customer=${encodeURIComponent(
            selectedCustomerId
        )}`;
}

/* =========================================================
   MODAL
========================================================= */

function openCustomerModal(modal) {
    modal.classList.add("open");
    modal.setAttribute(
        "aria-hidden",
        "false"
    );

    document.body.classList.add(
        "modal-open"
    );
}

function closeCustomerModal(modal) {
    modal.classList.remove("open");
    modal.setAttribute(
        "aria-hidden",
        "true"
    );

    if (
        !document.querySelector(
            ".modal.open"
        )
    ) {
        document.body.classList.remove(
            "modal-open"
        );
    }
}

function closeCustomerDetailsModal() {
    const modal =
        document.getElementById(
            "customerDetailsModal"
        );

    if (modal) {
        closeCustomerModal(modal);
    }

    selectedCustomerId = null;
}

/* =========================================================
   PAGINATION
========================================================= */

function updateCustomerPagination(
    totalItems,
    totalPages
) {
    const info =
        document.getElementById(
            "customersPaginationInfo"
        );

    const buttons =
        document.getElementById(
            "customersPaginationButtons"
        );

    if (totalItems === 0) {

        if (info) {
            info.textContent =
                "Showing 0 customers";
        }

        if (buttons) {
            buttons.innerHTML = "";
        }

        return;
    }

    const start =
        (
            currentCustomerPage - 1
        ) *
        CUSTOMERS_PER_PAGE + 1;

    const end =
        Math.min(
            currentCustomerPage *
                CUSTOMERS_PER_PAGE,
            totalItems
        );

    if (info) {
        info.textContent =
            `Showing ${start}-${end} of ${totalItems} customers`;
    }

    if (!buttons) {
        return;
    }

    let html = "";

    html += `
        <button
            type="button"
            class="pagination-button"
            ${
                currentCustomerPage === 1
                    ? "disabled"
                    : ""
            }
            data-customer-page="${
                currentCustomerPage - 1
            }"
        >
            Previous
        </button>
    `;

    for (
        let page = 1;
        page <= totalPages;
        page++
    ) {
        html += `
            <button
                type="button"
                class="pagination-button ${
                    page ===
                    currentCustomerPage
                        ? "active"
                        : ""
                }"
                data-customer-page="${page}"
            >
                ${page}
            </button>
        `;
    }

    html += `
        <button
            type="button"
            class="pagination-button"
            ${
                currentCustomerPage === totalPages
                    ? "disabled"
                    : ""
            }
            data-customer-page="${
                currentCustomerPage + 1
            }"
        >
            Next
        </button>
    `;

    buttons.innerHTML = html;

    buttons
        .querySelectorAll(
            "[data-customer-page]"
        )
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {

                    const page =
                        Number(
                            button.dataset
                                .customerPage
                        );

                    if (
                        page < 1 ||
                        page > totalPages ||
                        page ===
                            currentCustomerPage
                    ) {
                        return;
                    }

                    currentCustomerPage =
                        page;

                    renderCustomers();
                }
            );

        });
}

/* =========================================================
   STATUS
========================================================= */

function normalizeCustomerStatus(
    status
) {
    const value =
        String(status || "")
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, "_");

    if (value === "active") {
        return "active";
    }

    if (value === "inactive") {
        return "inactive";
    }

    if (value === "suspended") {
        return "suspended";
    }

    return value || "inactive";
}

/* what the admin should see: Banned and Deleted take priority over the plain status */
function customerDisplayStatus(customer) {
    if (isDeletedCustomer(customer)) return "deleted";
    if (customer.banned_at) return "banned";
    return customer.status;
}

function isDeletedCustomer(customer) {
    return /^deleted-.*@deleted\.invalid$/.test(String(customer.email || ""));
}

function createCustomerStatusBadge(
    status
) {
    const normalized =
        normalizeCustomerStatus(
            status
        );

    const labels = {
        active: "Active",
        inactive: "Inactive",
        suspended: "Suspended",
        banned: "Banned",
        deleted: "Deleted"
    };

    const classes = {
        active: "success",
        inactive: "neutral",
        suspended: "danger",
        banned: "danger",
        deleted: "neutral"
    };

    return `
        <span class="status-badge ${
            classes[normalized] ||
            "neutral"
        }">
            ${escapeHtml(
                labels[normalized] ||
                status ||
                "Unknown"
            )}
        </span>
    `;
}

/* =========================================================
   FORMATTING
========================================================= */

function formatCustomerDate(
    value
) {
    if (!value) {
        return "—";
    }

    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return String(value);
    }

    return date.toLocaleDateString(
        "en-KE",
        {
            day: "2-digit",
            month: "short",
            year: "numeric"
        }
    );
}

/* =========================================================
   HELPERS
========================================================= */

function setCustomerText(
    id,
    value
) {
    const element =
        document.getElementById(id);

    if (element) {
        element.textContent =
            value;
    }
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function showCustomerMessage(
    message,
    type = "success"
) {
    const element =
        document.getElementById(
            "customersMessage"
        );

    if (!element) {
        return;
    }

    element.textContent =
        message;

    element.className =
        `admin-message show ${type}`;

    window.clearTimeout(
        showCustomerMessage.timeout
    );

    showCustomerMessage.timeout =
        window.setTimeout(() => {

            element.className =
                "admin-message";

            element.textContent =
                "";

        }, 5000);
}