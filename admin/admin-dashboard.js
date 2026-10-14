/* =========================================================
GASHUB ADMIN DASHBOARD
DASHBOARD JAVASCRIPT
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
initializeDashboard();
});

/* =========================================================
INITIALIZE DASHBOARD
========================================================= */

async function initializeDashboard() {


setLastUpdated();

const refreshButton =
    document.getElementById("refreshDashboard");

if (refreshButton) {
    refreshButton.addEventListener(
        "click",
        loadDashboard
    );
}

await loadDashboard();


}

/* =========================================================
LOAD DASHBOARD
========================================================= */

async function loadDashboard() {


setDashboardLoading(true);

try {

    /*
     * The dashboard uses the backend's dashboard endpoint.
     * Once the GasHub backend route is available, the response
     * can provide all dashboard information from one request.
     */
    const data =
        await GasHubAdmin.adminApiRequest(
            "/api/admin/dashboard"
        );

    updateDashboard(data);

    setLastUpdated();

} catch (error) {

    console.error(
        "Dashboard loading error:",
        error
    );

    /*
     * Do not insert fake statistics when the backend
     * is unavailable.
     */
    showDashboardError();

} finally {

    setDashboardLoading(false);
}


}

/* =========================================================
UPDATE DASHBOARD
========================================================= */

function updateDashboard(data) {


if (!data || typeof data !== "object") {
    return;
}

const statistics =
    data.statistics ||
    data.stats ||
    data;

const orders =
    data.orders ||
    data.recentOrders ||
    [];

const orderStatus =
    data.orderStatus ||
    data.status ||
    {};


/* ---------------------------------------------
   MAIN STATISTICS
   --------------------------------------------- */

setElementValue(
    "totalProducts",
    getNumber(
        statistics.totalProducts ??
        statistics.products
    )
);

setElementValue(
    "totalOrders",
    getNumber(
        statistics.totalOrders ??
        statistics.orders
    )
);

setElementValue(
    "totalCustomers",
    getNumber(
        statistics.totalCustomers ??
        statistics.customers
    )
);

setElementValue(
    "pendingOrders",
    getNumber(
        statistics.pendingOrders ??
        orderStatus.pending
    )
);


/* ---------------------------------------------
   ORDER STATUS
   --------------------------------------------- */

setElementValue(
    "statusPending",
    getNumber(
        orderStatus.pending ??
        statistics.pendingOrders
    )
);

setElementValue(
    "statusConfirmed",
    getNumber(
        orderStatus.confirmed
    )
);

setElementValue(
    "statusDelivery",
    getNumber(
        orderStatus.delivery ??
        orderStatus.outForDelivery
    )
);

setElementValue(
    "statusCompleted",
    getNumber(
        orderStatus.completed
    )
);

setElementValue(
    "statusCancelled",
    getNumber(
        orderStatus.cancelled
    )
);


/* ---------------------------------------------
   RECENT ORDERS
   --------------------------------------------- */

renderRecentOrders(orders);


}

/* =========================================================
RECENT ORDERS
========================================================= */

function renderRecentOrders(orders) {


const table =
    document.getElementById(
        "recentOrdersTable"
    );

if (!table) {
    return;
}

table.innerHTML = "";

if (!Array.isArray(orders) || orders.length === 0) {

    table.innerHTML = `
        <tr>
            <td colspan="5" class="empty-state">
                No orders available.
            </td>
        </tr>
    `;

    return;
}

orders
    .slice(0, 10)
    .forEach((order) => {

        const row =
            document.createElement("tr");

        const orderNumber =
            order.order_number ||
            order.orderNumber ||
            order.order_code ||
            order.id ||
            "—";

        const customer =
            order.customer_name ||
            order.customerName ||
            order.name ||
            "—";

        const product =
            order.product_name ||
            order.productName ||
            order.product ||
            "—";

        const amount =
            order.total_amount ??
            order.totalAmount ??
            order.amount ??
            0;

        const status =
            order.status ||
            order.order_status ||
            "Pending";

        row.innerHTML = `
            <td>
                <span class="dashboard-order-number">
                    ${GasHubAdmin.escapeHtml(orderNumber)}
                </span>
            </td>

            <td>
                <span class="dashboard-customer-name">
                    ${GasHubAdmin.escapeHtml(customer)}
                </span>
            </td>

            <td>
                <span class="dashboard-product-name">
                    ${GasHubAdmin.escapeHtml(product)}
                </span>
            </td>

            <td>
                <span class="dashboard-amount">
                    ${formatCurrency(amount)}
                </span>
            </td>

            <td>
                ${createStatusBadge(status)}
            </td>
        `;

        table.appendChild(row);
    });


}

/* =========================================================
STATUS BADGE
========================================================= */

function createStatusBadge(status) {


const cleanStatus =
    String(status || "Pending")
        .trim();

const normalized =
    cleanStatus
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ");

let className = "pending";

if (
    normalized === "confirmed" ||
    normalized === "approved"
) {
    className = "confirmed";
}

if (
    normalized === "out for delivery" ||
    normalized === "out_for_delivery" ||
    normalized === "delivery" ||
    normalized === "dispatched"
) {
    className = "delivery";
}

if (
    normalized === "completed" ||
    normalized === "delivered"
) {
    className = "completed";
}

if (
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "rejected"
) {
    className = "cancelled";
}

return `
    <span class="order-status-badge ${className}">
        ${GasHubAdmin.escapeHtml(cleanStatus)}
    </span>
`;


}

/* =========================================================
CURRENCY
========================================================= */

function formatCurrency(amount) {


const number =
    Number(amount);

if (!Number.isFinite(number)) {
    return "KSh 0";
}

return `KSh ${number.toLocaleString("en-KE")}`;


}

/* =========================================================
SET ELEMENT VALUE
========================================================= */

function setElementValue(
elementId,
value
) {


const element =
    document.getElementById(elementId);

if (!element) {
    return;
}

element.textContent =
    formatNumber(value);


}

/* =========================================================
NUMBER HELPERS
========================================================= */

function getNumber(value) {


const number =
    Number(value);

return Number.isFinite(number)
    ? number
    : 0;


}

function formatNumber(value) {


const number =
    getNumber(value);

return number.toLocaleString("en-KE");


}

/* =========================================================
LAST UPDATED
========================================================= */

function setLastUpdated() {


const element =
    document.getElementById(
        "lastUpdated"
    );

if (!element) {
    return;
}

element.textContent =
    GasHubAdmin.formatAdminDate();


}

/* =========================================================
LOADING STATE
========================================================= */

function setDashboardLoading(isLoading) {


const refreshButton =
    document.getElementById(
        "refreshDashboard"
    );

if (!refreshButton) {
    return;
}

if (isLoading) {

    refreshButton.disabled = true;
    refreshButton.textContent =
        "Loading...";

} else {

    refreshButton.disabled = false;
    refreshButton.textContent =
        "Refresh";
}


}

/* =========================================================
ERROR STATE
========================================================= */

function showDashboardError() {


const table =
    document.getElementById(
        "recentOrdersTable"
    );

if (!table) {
    return;
}

table.innerHTML = `
    <tr>
        <td colspan="5" class="empty-state">
            Unable to load dashboard data.
        </td>
    </tr>
`;


}
