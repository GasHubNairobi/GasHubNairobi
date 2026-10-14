/* =========================================================
   GASHUB ADMIN - ORDERS
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    initializeOrdersPage();
});

let orders = [];
let currentPage = 1;
let selectedOrderId = null;

const ORDERS_PER_PAGE = 10;

/* =========================================================
   INITIALIZE
========================================================= */

function initializeOrdersPage() {
    bindOrderEvents();
    loadOrders();
}

/* =========================================================
   EVENTS
========================================================= */

function bindOrderEvents() {
    const searchInput = document.getElementById("orderSearch");
    const statusFilter = document.getElementById("orderStatusFilter");

    if (searchInput) {
        searchInput.addEventListener("input", () => {
            currentPage = 1;
            renderOrders();
        });
    }

    if (statusFilter) {
        statusFilter.addEventListener("change", () => {
            currentPage = 1;
            renderOrders();
        });
    }

    const closeOrderModal = document.getElementById("closeOrderModal");
    const closeOrderButton = document.getElementById("closeOrderButton");
    const orderModalBackdrop = document.getElementById("orderModalBackdrop");

    closeOrderModal?.addEventListener("click", closeOrderDetailsModal);
    closeOrderButton?.addEventListener("click", closeOrderDetailsModal);
    orderModalBackdrop?.addEventListener("click", closeOrderDetailsModal);

    const closeStatusModal = document.getElementById("closeStatusModal");
    const cancelStatusButton = document.getElementById("cancelStatusButton");
    const orderStatusBackdrop = document.getElementById("orderStatusBackdrop");

    closeStatusModal?.addEventListener("click", closeStatusModalWindow);
    cancelStatusButton?.addEventListener("click", closeStatusModalWindow);
    orderStatusBackdrop?.addEventListener("click", closeStatusModalWindow);

    document
        .getElementById("updateOrderButton")
        ?.addEventListener("click", openStatusModal);

    document
        .getElementById("cancelOrderButton")
        ?.addEventListener("click", cancelSelectedOrder);

    document
        .getElementById("orderStatusForm")
        ?.addEventListener("submit", saveOrderStatus);

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeOrderDetailsModal();
            closeStatusModalWindow();
        }
    });
}

/* =========================================================
   LOAD ORDERS
========================================================= */

async function loadOrders() {
    const tableBody = document.getElementById("ordersTableBody");

    try {
        if (tableBody) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="table-loading">
                        Loading orders...
                    </td>
                </tr>
            `;
        }

        const customerFilter = new URLSearchParams(window.location.search).get("customer");

        const response = await GasHubAdmin.adminApiRequest(
            customerFilter
                ? `/api/admin/orders?customer=${encodeURIComponent(customerFilter)}`
                : "/api/admin/orders"
        );

        orders = normalizeOrdersResponse(response);

        currentPage = 1;

        updateOrderStatistics();
        renderOrders();
        showCustomerFilterBanner(customerFilter);

    } catch (error) {
        console.error("Failed to load orders:", error);

        orders = [];

        updateOrderStatistics();

        if (tableBody) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="table-empty">
                        <strong>Unable to load orders</strong>
                        <span>${escapeHtml(error.message || "Please try again later.")}</span>
                    </td>
                </tr>
            `;
        }

        showOrderMessage(
            error.message || "Unable to load orders.",
            "error"
        );
    }
}

/* =========================================================
   NORMALIZE RESPONSE
========================================================= */

function normalizeOrdersResponse(response) {
    if (Array.isArray(response)) {
        return response;
    }

    if (Array.isArray(response?.orders)) {
        return response.orders;
    }

    if (Array.isArray(response?.data)) {
        return response.data;
    }

    if (Array.isArray(response?.data?.orders)) {
        return response.data.orders;
    }

    return [];
}

/* =========================================================
   STATISTICS
========================================================= */

function updateOrderStatistics() {
    const total = orders.length;

    const pending = orders.filter(order =>
        normalizeStatus(order.status) === "pending"
    ).length;

    const confirmed = orders.filter(order =>
        normalizeStatus(order.status) === "confirmed"
    ).length;

    const completed = orders.filter(order =>
        normalizeStatus(order.status) === "completed"
    ).length;

    setElementText("totalOrders", total);
    setElementText("pendingOrders", pending);
    setElementText("confirmedOrders", confirmed);
    setElementText("completedOrders", completed);

    setElementText("ordersBadge", pending);
}

/* =========================================================
   FILTERING
========================================================= */

function getFilteredOrders() {
    const searchValue = (
        document.getElementById("orderSearch")?.value || ""
    ).trim().toLowerCase();

    const statusValue = (
        document.getElementById("orderStatusFilter")?.value || ""
    ).toLowerCase();

    return orders.filter(order => {

        const orderId = String(
            order.id ||
            order.order_id ||
            order.order_code ||
            ""
        ).toLowerCase();

        const orderCode = String(
            order.order_code ||
            order.order_number ||
            ""
        ).toLowerCase();

        const customerName = String(
            order.customer_name ||
            order.full_name ||
            order.customer?.full_name ||
            order.customer?.name ||
            ""
        ).toLowerCase();

        const customerPhone = String(
            order.customer_phone ||
            order.phone ||
            order.customer?.phone ||
            ""
        ).toLowerCase();

        const productName = String(
            order.product_name ||
            order.product?.name ||
            ""
        ).toLowerCase();

        const dealerName = String(order.dealer_name || "").toLowerCase();

        const phoneDigits = value => String(value || "").replace(/\D/g, "");
        const localPhone = value => phoneDigits(value).replace(/^254/, "").replace(/^0/, "");
        const searchDigits = phoneDigits(searchValue);
        const searchLocal = localPhone(searchValue);

        // Phone matches 0712..., 712..., 254712... and +254712... alike
        const matchesPhone =
            searchDigits.length >= 3 &&
            (
                phoneDigits(customerPhone).includes(searchDigits) ||
                localPhone(customerPhone).includes(searchLocal) ||
                phoneDigits(order.delivery_phone).includes(searchDigits) ||
                localPhone(order.delivery_phone).includes(searchLocal)
            );

        const matchesSearch =
            !searchValue ||
            orderId.includes(searchValue) ||
            orderCode.includes(searchValue) ||
            customerName.includes(searchValue) ||
            customerPhone.includes(searchValue) ||
            productName.includes(searchValue) ||
            dealerName.includes(searchValue) ||
            matchesPhone;

        const orderStatus = normalizeStatus(order.status);

        const matchesStatus =
            !statusValue ||
            orderStatus === statusValue;

        return matchesSearch && matchesStatus;
    });
}

/* =========================================================
   RENDER ORDERS
========================================================= */

function renderOrders() {
    const tableBody = document.getElementById("ordersTableBody");

    if (!tableBody) {
        return;
    }

    const filteredOrders = getFilteredOrders();

    const totalPages = Math.max(
        1,
        Math.ceil(filteredOrders.length / ORDERS_PER_PAGE)
    );

    if (currentPage > totalPages) {
        currentPage = totalPages;
    }

    const startIndex =
        (currentPage - 1) * ORDERS_PER_PAGE;

    const pageOrders = filteredOrders.slice(
        startIndex,
        startIndex + ORDERS_PER_PAGE
    );

    if (!pageOrders.length) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="8" class="table-empty">
                    <strong>No orders found</strong>
                    <span>
                        There are no orders matching the current search or filter.
                    </span>
                </td>
            </tr>
        `;

        updatePagination(
            filteredOrders.length,
            totalPages
        );

        return;
    }

    tableBody.innerHTML = pageOrders
        .map(order => createOrderRow(order))
        .join("");

    updatePagination(
        filteredOrders.length,
        totalPages
    );
}

/* =========================================================
   ORDER ROW
========================================================= */

function createOrderRow(order) {
    const id =
        order.id ||
        order.order_id ||
        "";

    const orderCode =
        order.order_code ||
        order.order_number ||
        `#${id}`;

    const customerName =
        order.customer_name ||
        order.full_name ||
        order.customer?.full_name ||
        order.customer?.name ||
        "Unknown Customer";

    const customerPhone =
        order.customer_phone ||
        order.phone ||
        order.customer?.phone ||
        "";

    const productName =
        order.product_name ||
        order.product?.name ||
        "—";

    const quantity =
        order.quantity ??
        order.order_quantity ??
        1;

    const total =
        order.total_amount ??
        order.total ??
        order.amount ??
        0;

    const status =
        normalizeStatus(order.status);

    const date =
        order.created_at ||
        order.order_date ||
        order.date ||
        null;

    return `
        <tr>
            <td>
                <span class="table-primary-text">
                    ${escapeHtml(orderCode)}
                </span>
            </td>

            <td>
                <span class="table-primary-text">
                    ${escapeHtml(customerName)}
                </span>

                ${
                    customerPhone
                        ? `
                            <span class="table-secondary-text">
                                ${escapeHtml(customerPhone)}
                            </span>
                        `
                        : ""
                }
            </td>

            <td>
                <span class="table-primary-text">
                    ${escapeHtml(productName)}
                </span>
            </td>

            <td>
                ${escapeHtml(String(quantity))}
            </td>

            <td>
                <span class="table-price">
                    ${formatCurrency(total)}
                </span>
                ${
                    Number(order.points_used) > 0
                        ? `<span class="table-secondary-text">Coins: ${Number(order.points_used).toLocaleString("en-KE")} (− ${formatCurrency(order.discount_amount)})</span>`
                        : ""
                }
                ${
                    String(order.fulfilment) !== "pickup" && Number(order.delivery_fee) > 0
                        ? `<span class="table-secondary-text">Delivery fee: ${formatCurrency(order.delivery_fee)} (incl.)</span>`
                        : ""
                }
                ${
                    order.commission_amount !== undefined
                        ? `<span class="table-secondary-text">Commission: ${formatCurrency(order.commission_amount)}</span>`
                        : ""
                }
            </td>

            <td>
                ${createStatusBadge(status)}
            </td>

            <td>
                <span class="table-secondary-text" title="Order placed">
                    Placed: ${escapeHtml(formatOrderDateTime(date))}
                </span>
                ${
                    order.completed_at
                        ? `<span class="table-secondary-text" title="Order completed">Completed: ${escapeHtml(formatOrderDateTime(order.completed_at))}</span>`
                        : ""
                }
            </td>

            <td>
                <div class="table-actions">

                    <button
                        type="button"
                        class="table-action-button"
                        data-action="view"
                        data-order-id="${escapeHtml(String(id))}"
                    >
                        View
                    </button>

                    <button
                        type="button"
                        class="table-action-button"
                        data-action="status"
                        data-order-id="${escapeHtml(String(id))}"
                    >
                        Status
                    </button>

                </div>
            </td>
        </tr>
    `;
}

/* =========================================================
   TABLE ACTIONS
========================================================= */

document.addEventListener("click", event => {
    const button = event.target.closest("[data-action]");

    if (!button) {
        return;
    }

    const action = button.dataset.action;
    const orderId = button.dataset.orderId;

    if (!orderId) {
        return;
    }

    if (action === "view") {
        openOrderDetails(orderId);
    }

    if (action === "status") {
        selectedOrderId = orderId;
        openStatusModal();
    }
});

/* =========================================================
   ORDER DETAILS
========================================================= */

async function openOrderDetails(orderId) {
    selectedOrderId = orderId;

    const modal = document.getElementById("orderDetailsModal");
    const body = document.getElementById("orderDetailsBody");
    const title = document.getElementById("orderModalTitle");
    const subtitle = document.getElementById("orderModalSubtitle");

    if (!modal || !body) {
        return;
    }

    const order = orders.find(item =>
        String(
            item.id ||
            item.order_id
        ) === String(orderId)
    );

    if (title) {
        title.textContent =
            order?.order_code ||
            order?.order_number ||
            `Order #${orderId}`;
    }

    if (subtitle) {
        subtitle.textContent = "View order information.";
    }

    body.innerHTML = `
        <div class="table-loading">
            Loading order details...
        </div>
    `;

    modal.querySelector(".modal-dialog")?.classList.add("od-dialog");
    openModal(modal);

    try {
        const response =
            await GasHubAdmin.adminApiRequest(
                `/api/admin/orders/${encodeURIComponent(orderId)}`
            );

        const detailedOrder =
            response?.order ||
            response?.data ||
            response ||
            order;

        body.innerHTML =
            createOrderDetails(detailedOrder);

    } catch (error) {
        console.error(
            "Failed to load order details:",
            error
        );

        if (order) {
            body.innerHTML =
                createOrderDetails(order);
        } else {
            body.innerHTML = `
                <div class="table-empty">
                    <strong>Unable to load order</strong>
                    <span>
                        ${escapeHtml(error.message || "Please try again later.")}
                    </span>
                </div>
            `;
        }
    }
}

/* =========================================================
   ORDER DETAILS HTML
========================================================= */

function createOrderDetails(order) {
    const money = value => formatCurrency(Number(value || 0));
    const text = value =>
        value === null || value === undefined || value === ""
            ? '<span class="od-empty">—</span>'
            : escapeHtml(String(value));
    const when = value =>
        value ? escapeHtml(formatOrderDateTime(value)) : '<span class="od-empty">—</span>';
    const label = value =>
        String(value || "")
            .replace(/_/g, " ")
            .replace(/\b\w/g, c => c.toUpperCase());

    const field = (name, value, wide = false) => `
        <div class="od-field${wide ? " od-wide" : ""}">
            <span class="od-label">${name}</span>
            <span class="od-value">${value}</span>
        </div>`;

    const card = (icon, title, inner, extra = "") => `
        <section class="od-card ${extra}">
            <header class="od-card-head">
                <span class="od-icon" aria-hidden="true">${icon}</span>
                <h4>${title}</h4>
            </header>
            <div class="od-grid">${inner}</div>
        </section>`;

    const orderCode = order.order_code || order.order_number || `#${order.id || ""}`;
    const status = normalizeStatus(order.status);
    const payments = Array.isArray(order.payments) ? order.payments : [];
    const items = Array.isArray(order.items) ? order.items : [];
    const lastPayment = payments[0] || {};
    const paymentMethod = order.payment_method_chosen === false ? "" : (order.payment_method || lastPayment.method || "");
    const hasMessenger = order.rider_name || order.rider_phone;
    const coin = '<span class="coin" aria-hidden="true"><span class="face"><img src="images/logo.png" alt=""></span></span>';
    const pointsUsed = Number(order.points_used) || 0;
    const pointsDiscount = Number(order.discount_amount) || 0;
    const isPickup = String(order.fulfilment || "").toLowerCase() === "pickup";
    const hasPin = order.delivery_latitude != null && order.delivery_longitude != null;
    const pinHtml = hasPin
        ? `<a href="https://www.google.com/maps?q=${encodeURIComponent(order.delivery_latitude + "," + order.delivery_longitude)}" target="_blank" rel="noopener">Open on map (${Number(order.delivery_latitude).toFixed(5)}, ${Number(order.delivery_longitude).toFixed(5)})</a>`
        : '<span class="od-empty">No pin saved</span>';

    const payState = String(order.payment_status || "").toLowerCase();
    const payClass =
        ["paid", "completed", "success", "successful"].includes(payState) ? "success"
        : ["failed", "cancelled", "refunded"].includes(payState) ? "danger"
        : "warning";

    /* progress timeline */
    const failed = ["cancelled", "rejected"].includes(String(order.status || "").toLowerCase());
    /* when the money was confirmed: the order's own paid_at, else the earliest paid payment record */
    const paidRows = payments
        .filter(pm => pm.paid_at && ["paid", "completed", "success", "successful"].includes(String(pm.status || "").toLowerCase()))
        .map(pm => pm.paid_at)
        .sort();
    const paidAt = order.paid_at || paidRows[0] || null;
    const steps = [
        ["Order placed", order.created_at],
        ["Confirmed", order.confirmed_at],
        ["Paid", paidAt],
        ["Delivery started", order.dispatched_at],
        ["Delivered", order.delivered_at],
        ["Completed", order.completed_at]
    ];
    const timeline = `
        <div class="od-timeline">
            ${steps.map(([name, date]) => `
                <div class="od-step${date ? " done" : ""}">
                    <span class="od-dot"></span>
                    <strong>${name}</strong>
                    <small>${date ? escapeHtml(formatOrderDateTime(date)) : "Pending"}</small>
                </div>`).join("")}
        </div>
        ${failed ? `
            <div class="od-alert">
                ${escapeHtml(label(order.status))}${order.cancelled_at ? " on " + escapeHtml(formatOrderDateTime(order.cancelled_at)) : ""}
                ${order.cancellation_reason ? " — " + escapeHtml(order.cancellation_reason) : ""}
            </div>` : ""}`;

    const itemsCard = `
        <section class="od-card od-full">
            <header class="od-card-head">
                <span class="od-icon" aria-hidden="true">🛒</span>
                <h4>Items ordered</h4>
            </header>
            <div class="od-table-wrap">
                <table class="od-table">
                    <thead><tr><th>Product</th><th>Size</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th></tr></thead>
                    <tbody>
                        ${(items.length ? items : [{ product_name: order.product_name, quantity: order.quantity }]).map(i => `
                            <tr>
                                <td><strong>${text(i.product_name)}</strong></td>
                                <td>${text(i.cylinder_size)}</td>
                                <td class="num">${text(i.quantity)}</td>
                                <td class="num">${i.unit_price !== undefined ? money(i.unit_price) : text("")}</td>
                                <td class="num">${i.total_price !== undefined ? money(i.total_price) : text("")}</td>
                            </tr>`).join("")}
                    </tbody>
                </table>
            </div>
        </section>`;

    const paymentRecords = payments.length ? `
        <div class="od-wide">
            <span class="od-label">Payment records</span>
            <div class="od-table-wrap">
                <table class="od-table">
                    <thead><tr><th>Method</th><th class="num">Amount</th><th>Status</th><th>Receipt / code</th><th>Phone</th><th>Paid</th></tr></thead>
                    <tbody>
                        ${payments.map(pm => `
                            <tr>
                                <td>${text(label(pm.method))}</td>
                                <td class="num">${money(pm.amount)}</td>
                                <td>${text(label(pm.status))}</td>
                                <td>${text(pm.mpesa_receipt_number || pm.transaction_code || pm.payment_reference)}</td>
                                <td>${text(pm.phone_number)}</td>
                                <td>${when(pm.paid_at || pm.created_at)}</td>
                            </tr>`).join("")}
                    </tbody>
                </table>
            </div>
        </div>` : "";

    return `
        <div class="od-wrap">

            <div class="od-hero">
                <div>
                    <span class="od-hero-label">Order</span>
                    <strong class="od-hero-code">${text(orderCode)}</strong>
                    <span class="od-hero-date">Placed ${when(order.created_at)}</span>
                </div>
                <div class="od-hero-right">
                    ${createStatusBadge(status)}
                    <strong class="od-hero-total">${money(order.total_amount)}</strong>
                    <span class="od-pay ${payClass}">${text(order.payment_status_label || label(order.payment_status))}</span>
                    ${pointsUsed > 0 ? `<span class="od-points">${coin}${pointsUsed.toLocaleString("en-KE")} used · − ${money(pointsDiscount)}</span>` : ""}
                </div>
            </div>

            <div class="od-card od-full od-progress">${timeline}</div>

            <div class="od-cols">
                ${card("👤", "Customer",
                    field("Name", text(order.customer_name)) +
                    field("Phone", text(order.customer_phone)) +
                    field("Email", text(order.customer_email), true))}

                ${card("🏪", "Dealer",
                    field("Business", text(order.dealer_name)) +
                    field("Phone", text(order.dealer_phone)) +
                    field("Email", text(order.dealer_email), true))}

                ${card("📍", isPickup ? "Pickup" : "Delivery",
                    isPickup
                        ? field("Option", '<span class="od-chip">Dealer pickup</span>') +
                          field("Pick up from", text(order.dealer_name)) +
                          field("Customer notes", text(order.customer_notes), true)
                        : field("Option", '<span class="od-chip">Home delivery</span>') +
                          field("Area", text([order.delivery_town, order.delivery_county].filter(Boolean).join(", "))) +
                          field("Address details", text(order.delivery_address), true) +
                          field("Landmark", text(order.delivery_landmark)) +
                          field("Delivery phone", text(order.delivery_phone)) +
                          field("Pinned location", pinHtml, true) +
                          field("Delivery notes", text(order.delivery_notes)) +
                          field("Customer notes", text(order.customer_notes)))}

                ${isPickup ? "" : card("🏍️", "Messenger",
                    hasMessenger
                        ? field("Name", text(order.rider_name)) +
                          field("Phone", text(order.rider_phone)) +
                          field("ID number", text(order.rider_id_number)) +
                          field("Vehicle reg.", text(order.rider_vehicle_reg)) +
                          field("Assigned", when(order.rider_assigned_at), true)
                        : '<div class="od-wide od-none">No messenger assigned yet.</div>')}
            </div>

            ${itemsCard}

            ${card("💳", "Payment",
                field("Mode of payment", `<span class="od-chip">${paymentMethod ? text(label(paymentMethod)) : "Not chosen yet"}</span>`) +
                field("Payment status", `<span class="od-pay ${payClass}">${text(order.payment_status_label || label(order.payment_status))}</span>`) +
                field("Subtotal", money(order.subtotal)) +
                field("Delivery fee charged by dealer", money(order.delivery_fee)) +
                (pointsUsed > 0
                    ? `<div class="od-wide od-discount-row"><span>${coin}GasHub Coins used: ${pointsUsed.toLocaleString("en-KE")}</span><strong>− ${money(pointsDiscount)} discount</strong></div>`
                    : "") +
                `<div class="od-wide od-total-row"><span>Total</span><strong>${money(order.total_amount)}</strong></div>` +
                paymentRecords, "od-full")}

            <section class="od-card od-full od-commission">
                <header class="od-card-head">
                    <span class="od-icon" aria-hidden="true">💰</span>
                    <h4>Dealer commission</h4>
                    <span class="od-rate">${escapeHtml(String(order.commission_rate))}%${order.commission_is_default ? " · default" : ""}</span>
                </header>
                <div class="od-comm-grid">
                    <div><span class="od-label">Charged on (subtotal)</span><strong>${money(order.commission_base)}</strong></div>
                    <div><span class="od-label">Delivery fee (dealer's, no commission)</span><strong>${money(order.delivery_fee)}</strong></div>
                    <div class="od-comm-main"><span class="od-label">Commission for this order</span><strong>${money(order.commission_amount)}</strong></div>
                    <div><span class="od-label">Dealer receives</span><strong>${money(order.dealer_payout)}</strong></div>
                </div>
            </section>

        </div>
    `;
}

/* =========================================================
   CUSTOMER FILTER BANNER (?customer=ID from the Customers page)
========================================================= */

function showCustomerFilterBanner(customerId) {
    if (!customerId) return;

    const first = orders[0];
    const name = first?.customer_name || `customer ${customerId}`;
    const message = document.getElementById("ordersMessage");

    if (message) {
        window.clearTimeout(showOrderMessage.timeout);
        message.className = "admin-message show success";
        message.innerHTML =
            `Showing all ${orders.length} order${orders.length === 1 ? "" : "s"} for <strong>${escapeHtml(name)}</strong>. ` +
            `<a href="admin-orders.html">Show all orders</a>`;
    }
}

/* =========================================================
   STATUS MODAL
========================================================= */

function openStatusModal() {
    if (!selectedOrderId) {
        return;
    }

    const modal =
        document.getElementById("orderStatusModal");

    const orderIdInput =
        document.getElementById("statusOrderId");

    const statusSelect =
        document.getElementById("newOrderStatus");

    const order = orders.find(item =>
        String(
            item.id ||
            item.order_id
        ) === String(selectedOrderId)
    );

    if (orderIdInput) {
        orderIdInput.value = selectedOrderId;
    }

    if (statusSelect) {
        statusSelect.value =
            normalizeStatus(order?.status);
    }

    if (modal) {
        openModal(modal);
    }
}

function closeStatusModalWindow() {
    const modal =
        document.getElementById("orderStatusModal");

    if (modal) {
        closeModal(modal);
    }
}

/* =========================================================
   SAVE STATUS
========================================================= */

async function saveOrderStatus(event) {
    event.preventDefault();

    if (!selectedOrderId) {
        return;
    }

    const status =
        document.getElementById("newOrderStatus")?.value;

    if (!status) {
        showOrderMessage(
            "Please select an order status.",
            "error"
        );

        return;
    }

    const button =
        document.getElementById("saveOrderStatusButton");

    if (button) {
        button.disabled = true;
        button.textContent = "Saving...";
    }

    try {
        const response =
            await GasHubAdmin.adminApiRequest(
                `/api/admin/orders/${encodeURIComponent(selectedOrderId)}`,
                {
                    method: "PATCH",
                    body: JSON.stringify({
                        /* this page calls "out for delivery" just "delivery"; the server only knows out_for_delivery */
                        status: status === "delivery" ? "out_for_delivery" : status
                    })
                }
            );

        const updatedOrder =
            response?.order ||
            response?.data;

        updateLocalOrder(
            selectedOrderId,
            updatedOrder || { status: status === "delivery" ? "out_for_delivery" : status }
        );

        updateOrderStatistics();
        renderOrders();

        closeStatusModalWindow();

        showOrderMessage(
            "Order status updated successfully.",
            "success"
        );

    } catch (error) {
        console.error(
            "Failed to update order status:",
            error
        );

        showOrderMessage(
            error.message ||
            "Unable to update order status.",
            "error"
        );

    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = "Save Status";
        }
    }
}

/* =========================================================
   CANCEL ORDER
========================================================= */

async function cancelSelectedOrder() {
    if (!selectedOrderId) {
        return;
    }

    const confirmed =
        await GasHubDialog.confirm({
            title: "Cancel this order?",
            message: "The customer and dealer will see it as cancelled. This cannot be undone.",
            confirmText: "Cancel order", cancelText: "Keep order", tone: "danger"
        });

    if (!confirmed) {
        return;
    }

    const button =
        document.getElementById("cancelOrderButton");

    if (button) {
        button.disabled = true;
        button.textContent = "Cancelling...";
    }

    try {
        const response =
            await GasHubAdmin.adminApiRequest(
                `/api/orders/${encodeURIComponent(selectedOrderId)}/cancel`,
                {
                    method: "PATCH"
                }
            );

        const updatedOrder =
            response?.order ||
            response?.data;

        updateLocalOrder(
            selectedOrderId,
            updatedOrder || { status: "cancelled" }
        );

        updateOrderStatistics();
        renderOrders();

        closeOrderDetailsModal();

        showOrderMessage(
            "Order cancelled successfully.",
            "success"
        );

    } catch (error) {
        console.error(
            "Failed to cancel order:",
            error
        );

        showOrderMessage(
            error.message ||
            "Unable to cancel order.",
            "error"
        );

    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = "Cancel Order";
        }
    }
}

/* =========================================================
   UPDATE LOCAL ORDER
========================================================= */

function updateLocalOrder(orderId, changes) {
    const index = orders.findIndex(order =>
        String(
            order.id ||
            order.order_id
        ) === String(orderId)
    );

    if (index === -1) {
        return;
    }

    orders[index] = {
        ...orders[index],
        ...changes
    };
}

/* =========================================================
   MODALS
========================================================= */

function openModal(modal) {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");

    document.body.classList.add("modal-open");
}

function closeModal(modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");

    if (
        !document.querySelector(".modal.open")
    ) {
        document.body.classList.remove("modal-open");
    }
}

function closeOrderDetailsModal() {
    const modal =
        document.getElementById("orderDetailsModal");

    if (modal) {
        closeModal(modal);
    }

    selectedOrderId = null;
}

/* =========================================================
   PAGINATION
========================================================= */

function updatePagination(totalItems, totalPages) {
    const info =
        document.getElementById(
            "ordersPaginationInfo"
        );

    const buttons =
        document.getElementById(
            "ordersPaginationButtons"
        );

    if (totalItems === 0) {
        if (info) {
            info.textContent = "Showing 0 orders";
        }

        if (buttons) {
            buttons.innerHTML = "";
        }

        return;
    }

    const start =
        (currentPage - 1) *
        ORDERS_PER_PAGE + 1;

    const end =
        Math.min(
            currentPage * ORDERS_PER_PAGE,
            totalItems
        );

    if (info) {
        info.textContent =
            `Showing ${start}-${end} of ${totalItems} orders`;
    }

    if (!buttons) {
        return;
    }

    let html = "";

    html += `
        <button
            type="button"
            class="pagination-button"
            ${currentPage === 1 ? "disabled" : ""}
            data-page="${currentPage - 1}"
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
                    page === currentPage
                        ? "active"
                        : ""
                }"
                data-page="${page}"
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
                currentPage === totalPages
                    ? "disabled"
                    : ""
            }
            data-page="${currentPage + 1}"
        >
            Next
        </button>
    `;

    buttons.innerHTML = html;

    buttons
        .querySelectorAll("[data-page]")
        .forEach(button => {

            button.addEventListener("click", () => {

                const page =
                    Number(button.dataset.page);

                if (
                    page < 1 ||
                    page > totalPages ||
                    page === currentPage
                ) {
                    return;
                }

                currentPage = page;

                renderOrders();
            });

        });
}

/* =========================================================
   STATUS
========================================================= */

function normalizeStatus(status) {
    const value =
        String(status || "")
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, "_");

    const aliases = {
        new: "pending",
        pending: "pending",

        confirmed: "confirmed",
        approved: "confirmed",

        delivery: "delivery",
        out_for_delivery: "delivery",
        dispatched: "delivery",

        completed: "completed",
        complete: "completed",

        cancelled: "cancelled",
        canceled: "cancelled"
    };

    return aliases[value] || value || "pending";
}

function createStatusBadge(status) {
    const normalized =
        normalizeStatus(status);

    const labels = {
        pending: "Pending",
        confirmed: "Confirmed",
        delivery: "Out for Delivery",
        delivered: "Delivered",
        completed: "Completed",
        cancelled: "Cancelled",
        rejected: "Rejected"
    };

    const classes = {
        pending: "warning",
        confirmed: "success",
        delivery: "neutral",
        delivered: "success",
        completed: "success",
        cancelled: "danger",
        rejected: "danger"
    };

    return `
        <span class="status-badge ${
            classes[normalized] || "neutral"
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

function formatCurrency(value) {
    const amount =
        Number(value) || 0;

    return `KSh ${amount.toLocaleString(
        "en-KE",
        {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }
    )}`;
}

function formatOrderDate(value) {
    if (!value) {
        return "—";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
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

/* Exact moment (date + time with seconds) - used for the order timeline so admin can see precisely when each step happened */
function formatOrderDateTime(value) {
    if (!value) {
        return "—";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleString(
        "en-KE",
        {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
            hour12: true
        }
    );
}

/* =========================================================
   HELPERS
========================================================= */

function setElementText(id, value) {
    const element =
        document.getElementById(id);

    if (element) {
        element.textContent = value;
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

function showOrderMessage(message, type = "success") {
    const element =
        document.getElementById("ordersMessage");

    if (!element) {
        return;
    }

    element.textContent = message;
    element.className =
        `admin-message show ${type}`;

    window.clearTimeout(
        showOrderMessage.timeout
    );

    showOrderMessage.timeout =
        window.setTimeout(() => {
            element.className =
                "admin-message";
            element.textContent = "";
        }, 5000);
}