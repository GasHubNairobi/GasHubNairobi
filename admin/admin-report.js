document.addEventListener("DOMContentLoaded", () => {
    const elements = {
        form: document.getElementById("reportFilterForm"),
        startDate: document.getElementById("reportStartDate"),
        endDate: document.getElementById("reportEndDate"),
        reportType: document.getElementById("reportType"),
        generateButton: document.getElementById("generateReportButton"),
        message: document.getElementById("reportMessage"),

        totalOrders: document.getElementById("reportTotalOrders"),
        totalSales: document.getElementById("reportTotalSales"),
        totalPayments: document.getElementById("reportTotalPayments"),
        newCustomers: document.getElementById("reportNewCustomers"),

        ordersTable: document.getElementById("reportOrdersTableBody"),
        paymentsTable: document.getElementById("reportPaymentsTableBody"),
        productsTable: document.getElementById("reportProductsTableBody"),
        customersTable: document.getElementById("reportCustomersTableBody")
    };

    function escapeHtml(value) {
        return GasHubAdmin.escapeHtml(
            value === null || value === undefined
                ? ""
                : String(value)
        );
    }

    function formatNumber(value) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return "0";
        }

        return number.toLocaleString("en-KE");
    }

    function formatCurrency(value) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return "KSh 0";
        }

        return `KSh ${number.toLocaleString("en-KE", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        })}`;
    }

    function normalizeStatus(status) {
        return String(status || "")
            .trim()
            .toLowerCase()
            .replace(/-/g, "_")
            .replace(/\s+/g, "_");
    }

    function statusLabel(status) {
        const normalized = normalizeStatus(status);

        const labels = {
            pending: "Pending",
            new: "New",
            confirmed: "Confirmed",
            approved: "Approved",
            delivery: "Delivery",
            out_for_delivery: "Out for Delivery",
            dispatched: "Dispatched",
            completed: "Completed",
            cancelled: "Cancelled",
            canceled: "Cancelled",
            failed: "Failed",
            rejected: "Rejected",
            processing: "Processing",
            in_progress: "In Progress",
            resolved: "Resolved"
        };

        return labels[normalized] ||
            normalized
                .replace(/_/g, " ")
                .replace(/\b\w/g, letter =>
                    letter.toUpperCase()
                );
    }

    function statusClass(status) {
        const normalized = normalizeStatus(status);

        if (
            normalized === "completed" ||
            normalized === "resolved" ||
            normalized === "confirmed" ||
            normalized === "approved"
        ) {
            return "success";
        }

        if (
            normalized === "pending" ||
            normalized === "new" ||
            normalized === "processing" ||
            normalized === "in_progress"
        ) {
            return "warning";
        }

        if (
            normalized === "cancelled" ||
            normalized === "canceled" ||
            normalized === "failed" ||
            normalized === "rejected"
        ) {
            return "danger";
        }

        return "neutral";
    }

    function statusBadge(status) {
        return `
            <span class="status-badge ${statusClass(status)}">
                ${escapeHtml(statusLabel(status))}
            </span>
        `;
    }

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
        elements.message.className =
            `admin-message ${type}`;
        elements.message.style.display = "block";
    }

    function getToday() {
        const date = new Date();

        const year = date.getFullYear();
        const month = String(
            date.getMonth() + 1
        ).padStart(2, "0");
        const day = String(
            date.getDate()
        ).padStart(2, "0");

        return `${year}-${month}-${day}`;
    }

    function getMonthStart() {
        const date = new Date();

        const year = date.getFullYear();
        const month = String(
            date.getMonth() + 1
        ).padStart(2, "0");

        return `${year}-${month}-01`;
    }

    function setDefaultDates() {
        if (!elements.startDate.value) {
            elements.startDate.value =
                getMonthStart();
        }

        if (!elements.endDate.value) {
            elements.endDate.value =
                getToday();
        }
    }

    function normalizeResponse(response) {
        if (!response || typeof response !== "object") {
            return {};
        }

        if (
            response.report &&
            typeof response.report === "object"
        ) {
            return response.report;
        }

        if (
            response.data &&
            typeof response.data === "object" &&
            !Array.isArray(response.data)
        ) {
            return response.data;
        }

        return response;
    }

    function getStatistics(report) {
        return (
            report.statistics ||
            report.stats ||
            report.summary ||
            {}
        );
    }

    function getArray(report, names) {
        for (const name of names) {
            if (Array.isArray(report[name])) {
                return report[name];
            }
        }

        return [];
    }

    function updateSummary(report) {
        const statistics = getStatistics(report);

        const totalOrders =
            statistics.totalOrders ??
            statistics.total_orders ??
            report.totalOrders ??
            report.total_orders ??
            0;

        const totalSales =
            statistics.totalSales ??
            statistics.total_sales ??
            report.totalSales ??
            report.total_sales ??
            0;

        const totalPayments =
            statistics.totalPayments ??
            statistics.total_payments ??
            report.totalPayments ??
            report.total_payments ??
            0;

        const newCustomers =
            statistics.newCustomers ??
            statistics.new_customers ??
            report.newCustomers ??
            report.new_customers ??
            0;

        elements.totalOrders.textContent =
            formatNumber(totalOrders);

        elements.totalSales.textContent =
            formatCurrency(totalSales);

        elements.totalPayments.textContent =
            formatCurrency(totalPayments);

        elements.newCustomers.textContent =
            formatNumber(newCustomers);
    }

    function renderOrders(report) {
        const rows = getArray(report, [
            "orders",
            "orderSummary",
            "order_summary",
            "ordersSummary",
            "orders_summary"
        ]);

        if (!rows.length) {
            elements.ordersTable.innerHTML = `
                <tr>
                    <td
                        colspan="3"
                        class="table-empty"
                    >
                        No order data available for this period.
                    </td>
                </tr>
            `;

            return;
        }

        elements.ordersTable.innerHTML =
            rows.map(row => {

                const status =
                    row.status ??
                    row.order_status ??
                    "unknown";

                const count =
                    row.count ??
                    row.orders ??
                    row.order_count ??
                    0;

                const amount =
                    row.amount ??
                    row.total_amount ??
                    row.total ??
                    0;

                return `
                    <tr>

                        <td>
                            ${statusBadge(status)}
                        </td>

                        <td>
                            ${formatNumber(count)}
                        </td>

                        <td>
                            ${formatCurrency(amount)}
                        </td>

                    </tr>
                `;
            }).join("");
    }

    function renderPayments(report) {
        const rows = getArray(report, [
            "payments",
            "paymentSummary",
            "payment_summary",
            "paymentsSummary",
            "payments_summary"
        ]);

        if (!rows.length) {
            elements.paymentsTable.innerHTML = `
                <tr>
                    <td
                        colspan="3"
                        class="table-empty"
                    >
                        No payment data available for this period.
                    </td>
                </tr>
            `;

            return;
        }

        elements.paymentsTable.innerHTML =
            rows.map(row => {

                const status =
                    row.status ??
                    row.payment_status ??
                    "unknown";

                const count =
                    row.count ??
                    row.payments ??
                    row.payment_count ??
                    0;

                const amount =
                    row.amount ??
                    row.total_amount ??
                    row.total ??
                    0;

                return `
                    <tr>

                        <td>
                            ${statusBadge(status)}
                        </td>

                        <td>
                            ${formatNumber(count)}
                        </td>

                        <td>
                            ${formatCurrency(amount)}
                        </td>

                    </tr>
                `;
            }).join("");
    }

    function renderProducts(report) {
        const rows = getArray(report, [
            "products",
            "productPerformance",
            "product_performance",
            "topProducts",
            "top_products"
        ]);

        if (!rows.length) {
            elements.productsTable.innerHTML = `
                <tr>
                    <td
                        colspan="4"
                        class="table-empty"
                    >
                        No product data available for this period.
                    </td>
                </tr>
            `;

            return;
        }

        elements.productsTable.innerHTML =
            rows.map(row => {

                const name =
                    row.product_name ||
                    row.name ||
                    row.product ||
                    "—";

                const orders =
                    row.orders ??
                    row.order_count ??
                    row.total_orders ??
                    0;

                const quantity =
                    row.quantity ??
                    row.total_quantity ??
                    row.units ??
                    0;

                const amount =
                    row.amount ??
                    row.total_amount ??
                    row.sales ??
                    0;

                return `
                    <tr>

                        <td>
                            <div class="table-primary-text">
                                ${escapeHtml(name)}
                            </div>
                        </td>

                        <td>
                            ${formatNumber(orders)}
                        </td>

                        <td>
                            ${formatNumber(quantity)}
                        </td>

                        <td>
                            ${formatCurrency(amount)}
                        </td>

                    </tr>
                `;
            }).join("");
    }

    function renderCustomers(report) {
        const rows = getArray(report, [
            "customers",
            "customerSummary",
            "customer_summary",
            "customerMetrics",
            "customer_metrics"
        ]);

        if (!rows.length) {
            const statistics =
                getStatistics(report);

            const totalCustomers =
                statistics.totalCustomers ??
                statistics.total_customers;

            const activeCustomers =
                statistics.activeCustomers ??
                statistics.active_customers;

            const inactiveCustomers =
                statistics.inactiveCustomers ??
                statistics.inactive_customers;

            if (
                totalCustomers !== undefined ||
                activeCustomers !== undefined ||
                inactiveCustomers !== undefined
            ) {
                const summaryRows = [];

                if (
                    totalCustomers !== undefined
                ) {
                    summaryRows.push([
                        "Total Customers",
                        totalCustomers
                    ]);
                }

                if (
                    activeCustomers !== undefined
                ) {
                    summaryRows.push([
                        "Active Customers",
                        activeCustomers
                    ]);
                }

                if (
                    inactiveCustomers !== undefined
                ) {
                    summaryRows.push([
                        "Inactive Customers",
                        inactiveCustomers
                    ]);
                }

                elements.customersTable.innerHTML =
                    summaryRows.map(row => `
                        <tr>
                            <td>
                                ${escapeHtml(row[0])}
                            </td>

                            <td>
                                ${formatNumber(row[1])}
                            </td>
                        </tr>
                    `).join("");

                return;
            }

            elements.customersTable.innerHTML = `
                <tr>
                    <td
                        colspan="2"
                        class="table-empty"
                    >
                        No customer data available for this period.
                    </td>
                </tr>
            `;

            return;
        }

        elements.customersTable.innerHTML =
            rows.map(row => {

                const metric =
                    row.metric ||
                    row.name ||
                    row.label ||
                    "—";

                const value =
                    row.value ??
                    row.count ??
                    row.total ??
                    0;

                return `
                    <tr>

                        <td>
                            ${escapeHtml(metric)}
                        </td>

                        <td>
                            ${formatNumber(value)}
                        </td>

                    </tr>
                `;
            }).join("");
    }

    function renderReport(response) {
        const report =
            normalizeResponse(response);

        updateSummary(report);
        renderOrders(report);
        renderPayments(report);
        renderProducts(report);
        renderCustomers(report);
    }

    async function generateReport() {
        const startDate =
            elements.startDate.value;

        const endDate =
            elements.endDate.value;

        const reportType =
            elements.reportType.value;

        if (!startDate || !endDate) {
            showMessage(
                "Please select both the start date and end date.",
                "error"
            );

            return;
        }

        if (startDate > endDate) {
            showMessage(
                "The start date cannot be after the end date.",
                "error"
            );

            return;
        }

        try {
            showMessage("");

            elements.generateButton.disabled =
                true;

            elements.generateButton.textContent =
                "Generating...";

            const query = new URLSearchParams();

            query.set(
                "start_date",
                startDate
            );

            query.set(
                "end_date",
                endDate
            );

            query.set(
                "report_type",
                reportType
            );

            const response =
                await GasHubAdmin.adminApiRequest(
                    `/api/admin/reports?${query.toString()}`
                );

            renderReport(response);

        } catch (error) {
            console.error(
                "Failed to generate report:",
                error
            );

            showMessage(
                error.message ||
                "Failed to generate report.",
                "error"
            );

        } finally {
            elements.generateButton.disabled =
                false;

            elements.generateButton.textContent =
                "Generate Report";
        }
    }

    elements.form?.addEventListener(
        "submit",
        event => {
            event.preventDefault();
            generateReport();
        }
    );

    setDefaultDates();
});