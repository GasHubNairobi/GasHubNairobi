/* =========================================================
   GASHUB EXECUTIVE DEALER ORDERS JAVASCRIPT
   File: dealer-order.js

   Handles:
   * Executive mobile drawer synchronization
   * LPG Orders state and localStorage persistence
   * Admin GasHub discount & commission fee calculation
   * Dealer Net Payout computation
   * Search, timeline, status, payment, and fulfilment filters
   * Printable customer invoice generation (Print/PDF)
   * Timeline-based orders report export (Print/CSV)
   * Modal dialog management with backdrop & Escape key handling
   ========================================================= */

(function () {
    "use strict";

    /* =====================================================
       1. STATE MANAGEMENT
       ===================================================== */

    // The commission rate always comes from what the admin set for this dealer (no hardcoded rate).
    const DEFAULT_ADMIN_COMMISSION_PERCENT = null;

    const ordersState = {
        orders: [],
        filteredOrders: [],
        riders: [],
        currentPage: 1,
        itemsPerPage: 10,
        adminCommissionRate: DEFAULT_ADMIN_COMMISSION_PERCENT,

        search: "",
        timeline: "month",
        orderStatus: "",
        paymentStatus: "",
        fulfilment: ""
    };

    /* =====================================================
       2. DOM READY INITIALIZATION
       ===================================================== */

    document.addEventListener("DOMContentLoaded", function () {
        initAdminCommissionRate();
        watchCommissionRate();
        setupMobileSidebarDrawer();
        initDealerProfileHeader();
        loadOrdersDatabase();
        initOrderFilters();
        initPaginationEvents();
        initExportAndPrintModals();
        initQuickActionEvents();
        initAssignMessengerModal();
        initTrackingLinkButton();
    });

    /* =====================================================
       3. ADMIN COMMISSION RATE ENGINE
       ===================================================== */

    /* Shows the commission rate on the page (badge, labels, statements) */
    function paintCommissionRate() {
        const known = Number.isFinite(ordersState.adminCommissionRate);
        const rateFormatted = known ? ordersState.adminCommissionRate.toFixed(1) + "%" : "...";
        const dealerNetRateFormatted = known ? (100 - ordersState.adminCommissionRate).toFixed(1) + "%" : "...";

        const adminBadgeText = document.getElementById("adminCommissionRateText");
        if (adminBadgeText) {
            adminBadgeText.textContent = rateFormatted;
        }

        document.querySelectorAll(".admin-rate-col, .admin-rate-text").forEach(el => {
            el.textContent = rateFormatted;
        });

        document.querySelectorAll(".dealer-rate-text").forEach(el => {
            el.textContent = dealerNetRateFormatted;
        });

        const gashubRateSubtext = document.getElementById("gashubRateSubtext");
        if (gashubRateSubtext) {
            gashubRateSubtext.textContent = `${rateFormatted} Admin platform fee`;
        }

        const dealerNetSubtext = document.getElementById("dealerNetSubtext");
        if (dealerNetSubtext) {
            dealerNetSubtext.textContent = `${dealerNetRateFormatted} Net to dealer`;
        }
    }

    /* First paint uses the last rate this device saw; loadCommissionRate() then asks the server for the real one. */
    function initAdminCommissionRate() {
        const storedRate = localStorage.getItem("gashub_admin_discount");
        if (storedRate !== null && storedRate !== "" && !isNaN(Number(storedRate))) {
            ordersState.adminCommissionRate = Number(storedRate);
        } else {
            ordersState.adminCommissionRate = DEFAULT_ADMIN_COMMISSION_PERCENT;
        }
        paintCommissionRate();
    }

    /* The rate the admin set for THIS dealer (Admin -> Dealers -> dealer details -> Commission). Returns true when it changed. */
    async function loadCommissionRate() {
        try {
            const json = await dealerApi("/api/dealers/commission/mine");
            const rate = Number(json.commission_rate);
            if (!Number.isFinite(rate) || rate < 0 || rate > 100) return false;
            const changed = rate !== ordersState.adminCommissionRate;
            ordersState.adminCommissionRate = rate;
            try { localStorage.setItem("gashub_admin_discount", String(rate)); } catch (e) {}
            paintCommissionRate();
            return changed;
        } catch (error) {
            console.error("Could not load the commission rate:", error);
            return false;
        }
    }

    /* Pick up a rate change made by the admin without the dealer having to sign out */
    function watchCommissionRate() {
        const refresh = async () => {
            if (await loadCommissionRate()) applyOrderFilters();
        };
        setInterval(refresh, 60000);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
        window.addEventListener("focus", refresh);
    }

    /* =====================================================
       4. MOBILE SIDEBAR DRAWER (Matches Dashboard)
       ===================================================== */

    function setupMobileSidebarDrawer() {
        const menuBtn = document.getElementById("dealerMobileMenu");
        const sidebar = document.getElementById("dealerSidebar");
        const overlay = document.getElementById("dealerSidebarOverlay");
        const closeBtn = document.getElementById("sidebarCloseBtn");

        if (!menuBtn || !sidebar || !overlay) return;

        function openSidebar() {
            sidebar.classList.add("open");
            overlay.classList.add("active");
            menuBtn.setAttribute("aria-expanded", "true");
            document.body.style.overflow = "hidden";
        }

        function closeSidebar() {
            sidebar.classList.remove("open");
            overlay.classList.remove("active");
            menuBtn.setAttribute("aria-expanded", "false");
            document.body.style.overflow = "";
        }

        menuBtn.addEventListener("click", openSidebar);
        overlay.addEventListener("click", closeSidebar);

        if (closeBtn) {
            closeBtn.addEventListener("click", closeSidebar);
        }

        // Close on Escape key
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && sidebar.classList.contains("open")) {
                closeSidebar();
            }
        });

        // Close when clicking nav items on mobile
        sidebar.querySelectorAll(".nav-item").forEach(link => {
            link.addEventListener("click", () => {
                if (window.innerWidth <= 820) {
                    closeSidebar();
                }
            });
        });
    }

    /* =====================================================
       5. DEALER PROFILE DISPLAY
       ===================================================== */

    function initDealerProfileHeader() {
        const dealer = getStoredDealerData() || {};

        const displayName = dealer.business_name || dealer.businessName || dealer.name || "Dealer";
        const nameEl = document.getElementById("dealerHeaderName");
        const initialEl = document.getElementById("dealerAvatarInitial");

        if (nameEl) nameEl.textContent = displayName;
        if (initialEl) initialEl.textContent = displayName.charAt(0).toUpperCase();
    }

    function getStoredDealerData() {
        const keys = ["gashub_dealer", "gashub_dealer_user", "dealer", "dealerData", "dealerProfile", "gasHubDealer"];
        for (const key of keys) {
            try {
                const stored = localStorage.getItem(key);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    if (parsed && typeof parsed === "object") return parsed;
                }
            } catch (e) {}
        }
        return null;
    }

    /* =====================================================
       6. LIVE ORDERS LOADING
       ===================================================== */

    function dealerToken() {
        return localStorage.getItem("gashub_dealer_token") || "";
    }

    /* Talks to the server as the signed-in dealer. Returns the parsed JSON; throws Error(message) when the server refuses. */
    async function dealerApi(path, options) {
        const opts = options || {};
        const response = await fetch(path, {
            method: opts.method || "GET",
            headers: Object.assign({ Accept: "application/json", Authorization: `Bearer ${dealerToken()}` },
                opts.body ? { "Content-Type": "application/json" } : {}),
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            cache: "no-store"
        });
        let json = {};
        try { json = await response.json(); } catch (e) {}
        if (response.status === 401) {
            const err = new Error("Your session has expired. Please sign in again.");
            err.unauthorized = true;
            throw err;
        }
        if (!response.ok || json.success === false) throw new Error(json.message || `Request failed (${response.status})`);
        return json;
    }

    /* The server's status names -> the names this page uses */
    const STATUS_FROM_SERVER = {
        pending: "pending", confirmed: "approved", processing: "approved", out_for_delivery: "dispatched",
        delivered: "delivered", completed: "completed", rejected: "rejected", cancelled: "cancelled"
    };

    function riderFromServer(o) {
        return o.rider_name ? { id: o.delivery_agent_id, fullName: o.rider_name, phone: o.rider_phone || "", idNumber: o.rider_id_number || "", vehicle: o.rider_vehicle_reg || "" } : null;
    }

    /* The exact moments of an order (placed, confirmed, paid, delivery started, delivered, completed, cancelled) */
    function timesFromServer(o) {
        return {
            orderDate: o.created_at,
            confirmedAt: o.confirmed_at || null,
            paidAt: o.paid_at || null,
            dispatchedAt: o.dispatched_at || null,
            deliveredAt: o.delivered_at || null,
            completedAt: o.completed_at || null,
            cancelledAt: o.cancelled_at || null
        };
    }

    /* One order from /api/dealers/orders/mine -> the shape the rest of this file uses */
    function mapServerOrder(o) {
        const items = Array.isArray(o.items) ? o.items : [];
        const first = items[0] || {};
        const discount = Number(o.discount_amount) || 0;
        return {
            id: o.order_number || String(o.id),
            serverId: o.id,
            ...timesFromServer(o),
            customerName: o.customer_name || "Customer",
            customerPhone: o.delivery_phone || o.customer_phone || "",
            productName: items.length > 1 ? `${first.name} + ${items.length - 1} more` : (first.name || "LPG order"),
            cylinderSize: first.size || "",
            quantity: items.reduce((n, i) => n + (Number(i.quantity) || 0), 0) || 1,
            unitPrice: Number(first.unit_price) || 0,
            total_amount: Math.max(0, (Number(o.subtotal) || 0) - discount),
            deliveryFee: Number(o.delivery_fee) || 0,
            fulfilment: o.fulfilment === "pickup" ? "pickup" : "delivery",
            deliveryAddress: [o.delivery_address, o.delivery_town, o.delivery_county].filter(Boolean).join(", "),
            pinUrl: (o.fulfilment !== "pickup" && o.delivery_latitude != null && o.delivery_longitude != null)
                ? `https://www.google.com/maps?q=${encodeURIComponent(o.delivery_latitude + "," + o.delivery_longitude)}` : "",
            paymentMethod: o.payment_method || "",
            paymentMethodChosen: o.payment_method_chosen !== false,   /* the customer chooses after the dealer confirms */
            paymentStatus: o.payment_status || "pending",
            refundStatus: o.refund_status || "",
            transactionRef: o.mpesa_receipt_number || "",
            status: STATUS_FROM_SERVER[o.status] || o.status || "pending",
            rider: riderFromServer(o)
        };
    }

    async function loadOrdersDatabase() {
        await loadCommissionRate();
        try {
            const [ordersJson, ridersJson] = await Promise.all([
                dealerApi("/api/dealers/orders/mine"),
                dealerApi("/api/dealers/riders/mine").catch(() => ({ riders: [] }))
            ]);
            ordersState.orders = (ordersJson.orders || []).map(mapServerOrder);
            ordersState.riders = ridersJson.riders || [];
            saveOrdersDatabase();
        } catch (error) {
            console.error("Dealer orders API unavailable:", error);
            ordersState.orders = [];
            showFeedbackBanner(error.message || "We could not load your orders.", "error");
            if (error.unauthorized) setTimeout(() => { window.location.href = "dealer-login.html"; }, 1800);
        }
        applyOrderFilters();
    }

    function applyOrderFilters() {
        const search = ordersState.search;
        const timeline = ordersState.timeline;
        const status = normalize(ordersState.orderStatus);
        const payment = normalize(ordersState.paymentStatus);
        const fulfilment = normalize(ordersState.fulfilment);

        const now = new Date().getTime();

        ordersState.filteredOrders = ordersState.orders.filter(order => {
            // Search query
            if (search) {
                const searchString = [
                    order.id,
                    order.customerName,
                    order.customerPhone,
                    order.productName,
                    order.gasBrand,
                    order.transactionRef,
                    order.deliveryAddress
                ].filter(Boolean).join(" ").toLowerCase();

                if (!searchString.includes(search)) return false;
            }

            // Timeline filter
            if (timeline && timeline !== "all") {
                const orderDate = new Date(order.orderDate).getTime();
                const diffDays = (now - orderDate) / (1000 * 3600 * 24);

                if (timeline === "today" && diffDays > 1) return false;
                if (timeline === "week" && diffDays > 7) return false;
                if (timeline === "month" && diffDays > 30) return false;
                if (timeline === "quarter" && diffDays > 90) return false;
            }

            // Status filters
            if (status && normalize(order.status) !== status) return false;
            if (payment && normalize(order.paymentStatus) !== payment) return false;
            if (fulfilment && normalize(order.fulfilment) !== fulfilment) return false;

            return true;
        });

        updateStatisticsCards();
        renderOrdersTable();
        updateTimelineExportPreview();
    }

    /* =====================================================
       10. STATS CARDS UPDATE
       ===================================================== */

    function updateStatisticsCards() {
        const orders = ordersState.filteredOrders;
        const totalCount = orders.length;

        const pendingOrders = orders.filter(o => normalize(o.status) === "pending").length;
        /* the sidebar and bell show every order waiting for the dealer, whatever filters are on the table */
        const waitingForDealer = ordersState.orders.filter(o => normalize(o.status) === "pending").length;
        const completedOrders = orders.filter(o => normalize(o.status) === "completed").length;

        let grossRevenue = 0;
        let gashubCut = 0;
        let dealerNet = 0;

        orders.forEach(order => {
            const st = normalize(order.status);
            if (st !== "rejected" && st !== "cancelled") {
                const fin = calculateOrderFinancials(order);
                grossRevenue += fin.gross;
                gashubCut += fin.gashubFee;
                dealerNet += fin.dealerNet;
            }
        });

        setText("totalOrdersCount", formatNumber(totalCount));
        setText("ordersCompletedRatio", `${completedOrders} completed`);
        setText("pendingOrdersCount", formatNumber(pendingOrders));
        setText("grossSalesAmount", formatCurrency(grossRevenue));
        setText("gashubIssuedAmount", formatCurrency(gashubCut));
        setText("dealerNetPayoutAmount", formatCurrency(dealerNet));

        // Update sidebar and notification badges
        const sidebarOrdersBadge = document.getElementById("sidebarOrdersBadge");
        if (sidebarOrdersBadge) {
            sidebarOrdersBadge.textContent = waitingForDealer;
            sidebarOrdersBadge.hidden = waitingForDealer <= 0;
        }

        /* the bell is kept up to date by dealer-alerts.js */
        if (window.GasHubDealerAlerts) window.GasHubDealerAlerts.refresh();
    }

    /* =====================================================
       11. TABLE RENDERING WITH GAS HUB SPLIT
       ===================================================== */

    function renderOrdersTable() {
        const tableBody = document.getElementById("ordersTableBody");
        const emptyState = document.getElementById("ordersEmptyState");

        if (!tableBody) return;

        const filtered = ordersState.filteredOrders;

        if (filtered.length === 0) {
            tableBody.innerHTML = "";
            if (emptyState) emptyState.hidden = false;
            updatePaginationControls(0);
            return;
        }

        if (emptyState) emptyState.hidden = true;

        const start = (ordersState.currentPage - 1) * ordersState.itemsPerPage;
        const end = start + ordersState.itemsPerPage;
        const pageOrders = filtered.slice(start, end);

        tableBody.innerHTML = pageOrders.map(order => createOrderTableRow(order)).join("");

        attachTableRowActionListeners();
        updatePaginationControls(filtered.length);
    }

    function createOrderTableRow(order) {
        const fin = calculateOrderFinancials(order);
        const st = normalize(order.status);

        return `
            <tr data-order-id="${escapeHtml(order.id)}">
                <td>
                    <a href="javascript:void(0)" class="order-number-link" data-action="view" data-id="${escapeHtml(order.id)}">
                        ${escapeHtml(order.id)}
                    </a>
                    <span class="order-timestamp" title="Order placed">Placed: ${formatDateTime(order.orderDate)}</span>
                    ${order.completedAt ? `<span class="order-timestamp" title="Order completed">Completed: ${formatDateTime(order.completedAt)}</span>` : ""}
                </td>

                <td class="customer-cell">
                    <strong>${escapeHtml(order.customerName)}</strong>
                    <a href="tel:${escapeHtml(order.customerPhone)}" class="customer-phone" title="Call customer">
                        <i class="fa-solid fa-phone" aria-hidden="true"></i>
                        <span>${escapeHtml(order.customerPhone)}</span>
                    </a>
                </td>

                <td>
                    <div class="product-cell">
                        <div class="product-mini-icon">
                            <i class="fa-solid fa-gas-pump" aria-hidden="true"></i>
                        </div>
                        <div class="product-meta-text">
                            <strong>${escapeHtml(order.productName)}</strong>
                            <span>${escapeHtml(order.gasBrand || "LPG")} &bull; ${escapeHtml(order.productType || "Refill")}</span>
                        </div>
                    </div>
                </td>

                <td class="text-center font-bold">
                    ${escapeHtml(String(order.quantity || 1))}
                </td>

                <td class="text-right">
                    <span class="order-gross-amount">${formatCurrency(fin.gross)}</span>
                </td>

                <td class="text-right">
                    <div class="order-gashub-cut">
                        <span>${formatCurrency(fin.gashubFee)}</span>
                        <small>(${fin.rate.toFixed(1)}%)</small>
                    </div>
                </td>

                <td class="text-right">
                    <span class="order-dealer-net">${formatCurrency(fin.dealerNet)}</span>
                </td>

                <td>
                    ${createFulfilmentBadge(order.fulfilment)}
                    ${createMessengerChip(order)}
                </td>

                <td>
                    ${createPaymentBadge(order.paymentStatus)}
                    <div style="font-size:11px;color:#64748b;margin-top:4px">${escapeHtml(paymentNote(order))}</div>
                </td>

                <td>
                    ${createStatusBadge(order.status)}
                </td>

                <td class="text-center">
                    <!-- One labelled button only. Every action (confirm, assign messenger, cash, complete, print)
                         is inside the order window, so a tap on a small phone screen can't hit the wrong one. -->
                    <button
                        type="button"
                        class="view-order-btn"
                        data-action="view"
                        data-id="${escapeHtml(order.id)}"
                        aria-label="View order ${escapeHtml(order.id)} and its actions"
                    >View</button>
                </td>
            </tr>
        `;
    }

    /* =====================================================
       PAYMENT RULES (the server enforces the same rules)
       - cash            : the dealer confirms it
       - M-Pesa / bank   : paid into GasHub's account; GasHub confirms it
       - delivery orders : the messenger confirms the delivery, then the order completes once paid
       ===================================================== */

    function isCashOrder(order) {
        return order.paymentMethodChosen !== false && normalize(order.paymentMethod) === "cash";
    }

    function canConfirmCash(order) {
        const st = normalize(order.status);
        return isCashOrder(order)
            && normalize(order.paymentStatus) !== "paid"
            && (st === "approved" || st === "dispatched" || st === "delivered");
    }

    function canCompletePickup(order) {
        return normalize(order.fulfilment) === "pickup"
            && normalize(order.status) === "approved"
            && normalize(order.paymentStatus) === "paid";
    }

    /* the small line under the Paid / Unpaid badge: who confirms the money */
    function paymentNote(order) {
        /* a cancelled order that was paid to GasHub: GasHub, not the dealer, gives the customer their money back */
        if (order.refundStatus === "pending") return "Cancelled: GasHub is refunding the customer";
        if (order.refundStatus === "refunded") return "Cancelled: GasHub refunded the customer";
        const paid = normalize(order.paymentStatus) === "paid";
        if (isCashOrder(order)) return paid ? "Cash received" : "Cash - you confirm";
        /* the order is sent out after the customer has paid online (or chosen cash on delivery) */
        const st = normalize(order.status);
        if (!paid && order.paymentMethodChosen === false && (st === "approved" || st === "processing")) return "Waiting: customer is choosing how to pay";
        if (!paid && (st === "approved" || st === "processing")) return "Waiting for payment - GasHub confirms, then send it out";
        return paid ? "Received by GasHub" : "M-Pesa to GasHub - GasHub confirms";
    }

    async function confirmCash(order) {
        if (!(await GasHubDialog.confirm({ title: "Cash received?", message: "Confirm that the cash for order " + order.id + " has been received?\n\nThis marks the order as paid. If the messenger has already confirmed the delivery, the order is completed.", confirmText: "Yes, received", tone: "success" }))) return;
        try {
            const json = await dealerApi("/api/dealers/orders/" + encodeURIComponent(order.id) + "/payment", {
                method: "POST",
                body: { method: "cash" }
            });
            order.paymentStatus = json.order.payment_status || "paid";
            order.status = STATUS_FROM_SERVER[json.order.status] || json.order.status;
            Object.assign(order, timesFromServer(json.order));
            saveOrdersDatabase();
            applyOrderFilters();
            showFeedbackBanner(json.message || "Cash payment confirmed.", "success");
        } catch (error) {
            showFeedbackBanner(error.message || "Could not confirm the cash payment.", "error");
        }
    }

    /* =====================================================
       12. BADGE HELPERS
       ===================================================== */

    function createStatusBadge(status) {
        const norm = normalize(status);
        if (norm === "pending") return `<span class="badge badge-pending"><i class="fa-solid fa-clock"></i> Pending</span>`;
        if (norm === "approved") return `<span class="badge badge-approved"><i class="fa-solid fa-check"></i> Approved</span>`;
        if (norm === "dispatched") return `<span class="badge badge-dispatched"><i class="fa-solid fa-truck-fast"></i> In Transit</span>`;
        if (norm === "delivered") return `<span class="badge badge-dispatched"><i class="fa-solid fa-box-open"></i> Delivered</span>`;
        if (norm === "cancelled") return `<span class="badge badge-rejected"><i class="fa-solid fa-circle-xmark"></i> Cancelled</span>`;
        if (norm === "completed") return `<span class="badge badge-completed"><i class="fa-solid fa-circle-check"></i> Completed</span>`;
        if (norm === "rejected") return `<span class="badge badge-rejected"><i class="fa-solid fa-circle-xmark"></i> Rejected</span>`;
        return `<span class="badge">${escapeHtml(status || "—")}</span>`;
    }

    function createPaymentBadge(payment) {
        const norm = normalize(payment);
        if (norm === "paid") return `<span class="badge badge-paid"><i class="fa-solid fa-circle-check"></i> Paid</span>`;
        if (norm === "pending") return `<span class="badge badge-unpaid"><i class="fa-solid fa-clock"></i> Unpaid</span>`;
        if (norm === "failed") return `<span class="badge badge-failed"><i class="fa-solid fa-xmark"></i> Failed</span>`;
        if (norm === "refunded") return `<span class="badge badge-refunded"><i class="fa-solid fa-rotate-left"></i> Refunded</span>`;
        return `<span class="badge">${escapeHtml(payment || "—")}</span>`;
    }

    function createFulfilmentBadge(fulfilment) {
        const norm = normalize(fulfilment);
        if (norm === "delivery") return `<span class="badge badge-delivery"><i class="fa-solid fa-truck"></i> Delivery</span>`;
        return `<span class="badge badge-pickup"><i class="fa-solid fa-store"></i> Pickup</span>`;
    }

    /* =====================================================
       13. ROW ACTIONS INTERACTION
       ===================================================== */

    function attachTableRowActionListeners() {
        document.querySelectorAll("[data-action]").forEach(btn => {
            btn.addEventListener("click", function () {
                const action = this.dataset.action;
                const id = this.dataset.id;
                const order = ordersState.orders.find(o => o.id === id);

                if (!order) return;

                if (action === "view") {
                    openOrderDetailsModal(order);
                } else if (action === "print") {
                    openOrderInvoiceModal(order);
                } else if (action === "assign") {
                    openAssignMessengerModal(order);
                } else if (action === "approve") {
                    updateOrderStatus(order, "approved", "Order approved successfully for dispatch.").then(ok => {
                        // A delivery order needs someone to take it to the customer
                        if (ok && isAssignable(order) && !getOrderMessenger(order)) {
                            openAssignMessengerModal(order);
                        }
                    });
                } else if (action === "cash") {
                    confirmCash(order);
                } else if (action === "complete") {
                    updateOrderStatus(order, "completed", "Order marked as completed. The customer now sees it as completed.");
                } else if (action === "reject") {
                    GasHubDialog.confirm({ title: "Reject this order?", message: `Reject order ${order.id}? The customer will be notified.`, confirmText: "Reject order", cancelText: "Keep order", tone: "danger" }).then(yes => {
                        if (yes) updateOrderStatus(order, "rejected", "Order rejected and customer notified.");
                    });
                }
            });
        });
    }

    /* The server's name for each action button */
    const STATUS_TO_SERVER = { approved: "confirmed", dispatched: "out_for_delivery", completed: "completed", rejected: "rejected" };

    /* Saves the change on the server first. The page only changes once the server says yes,
       so what the dealer sees is what the customer sees. */
    async function updateOrderStatus(order, newStatus, message) {
        try {
            const json = await dealerApi(`/api/dealers/orders/${encodeURIComponent(order.id)}`, {
                method: "PATCH",
                body: { status: STATUS_TO_SERVER[newStatus] || newStatus }
            });
            order.status = STATUS_FROM_SERVER[json.order.status] || json.order.status;
            order.paymentStatus = json.order.payment_status || order.paymentStatus;
            order.rider = riderFromServer(json.order);
            Object.assign(order, timesFromServer(json.order));
            saveOrdersDatabase();
            applyOrderFilters();
            /* a confirmed order that already had a messenger: the server has just emailed them the delivery link */
            const mail = json.messengerEmail;
            showFeedbackBanner(mail && mail.message ? `${message} ${mail.message}` : message, mail && mail.message && !mail.sent ? "info" : "success");
            return true;
        } catch (error) {
            showFeedbackBanner(error.message || "Could not update this order.", "error");
            return false;
        }
    }

    /* =====================================================
       14. PRINTABLE ORDER INVOICE MODAL
       ===================================================== */

    function openOrderInvoiceModal(order) {
        const modal = document.getElementById("orderInvoiceModal");
        if (!modal) return;

        const fin = calculateOrderFinancials(order);
        const dealer = getStoredDealerData() || { businessName: "", location: "", phone: "" };

        // Populate fields
        setText("invModalOrderNumber", `#${order.id}`);
        setText("invModalDate", formatDateTime(order.orderDate));
        setText("invModalStatusBadge", (order.status || "Pending").toUpperCase());

        setText("invModalDealerName", dealer.businessName || "GasHub Authorized Depot");
        setText("invModalDealerLocation", dealer.location || "Nairobi, Kenya");
        setText("invModalDealerPhone", `Tel: ${dealer.phone || "+254 711 234 567"}`);

        setText("invModalCustomerName", order.customerName || "Customer");
        setText("invModalCustomerPhone", `Tel: ${order.customerPhone || "—"}`);
        setText("invModalCustomerAddress", `Address: ${order.deliveryAddress || "Depot Counter"}`);
        setText("invModalFulfilmentType", `Fulfilment: ${order.fulfilment === "delivery" ? "Doorstep Delivery" : "Depot Pickup"}`);

        // Items Table
        const itemsBody = document.getElementById("invModalItemsBody");
        if (itemsBody) {
            itemsBody.innerHTML = `
                <tr>
                    <td><strong>${escapeHtml(order.productName)}</strong></td>
                    <td>${escapeHtml(order.gasBrand || "LPG")} (${escapeHtml(order.cylinderSize || "13kg")})</td>
                    <td class="text-center">${escapeHtml(order.productType || "Refill")}</td>
                    <td class="text-center font-bold">${order.quantity || 1}</td>
                    <td class="text-right">${formatCurrency(order.unitPrice || fin.gross)}</td>
                    <td class="text-right font-bold">${formatCurrency(fin.gross)}</td>
                </tr>
            `;
        }

        // Financials
        setText("invModalPaymentMethod", order.paymentMethodChosen === false ? "Not chosen yet" : (order.paymentMethod || "M-Pesa Express"));
        setText("invModalTransactionRef", order.transactionRef || "MPESA-CONFIRMED");
        setText("invModalGrossAmount", formatCurrency(fin.gross));
        setText("invModalDeliveryFee", formatCurrency(order.deliveryFee || 0));
        setText("invModalCustomerTotal", formatCurrency(fin.gross + (order.deliveryFee || 0)));

        setText("invModalCommissionRate", `${fin.rate.toFixed(1)}%`);
        setText("invModalGashubFee", `- ${formatCurrency(fin.gashubFee)}`);
        setText("invModalDealerRate", `${(100 - fin.rate).toFixed(1)}%`);
        setText("invModalDealerNet", formatCurrency(fin.dealerNet));

        openModal(modal);
    }

    /* =====================================================
       15. QUICK ORDER DETAILS MODAL
       ===================================================== */

    function openOrderDetailsModal(order) {
        const modal = document.getElementById("orderDetailsModal");
        const body = document.getElementById("orderDetailsModalBody");
        const footer = document.getElementById("orderDetailsModalFooter");
        const num = document.getElementById("viewModalOrderNum");

        if (!modal || !body || !footer) return;

        const fin = calculateOrderFinancials(order);
        if (num) num.textContent = `#${order.id}`;

        body.innerHTML = buildOrderActionsPanel(order) + `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 18px;">
                <div>
                    <label style="font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase;">Customer Information</label>
                    <p style="margin: 4px 0 0; font-size: 14px; font-weight: 700; color: #0f172a;">${escapeHtml(order.customerName)}</p>
                    <p style="margin: 2px 0 0; font-size: 12px; color: #64748b;">${escapeHtml(order.customerPhone)}</p>
                    <p style="margin: 4px 0 0; font-size: 12px; color: #334155;"><strong>Address:</strong> ${escapeHtml(order.deliveryAddress || "Depot Counter")}${order.pinUrl ? ` &middot; <a href="${order.pinUrl}" target="_blank" rel="noopener">Pinned location</a>` : ""}</p>
                </div>
                <div>
                    <label style="font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase;">Order Metadata</label>
                    <p style="margin: 4px 0 0; font-size: 12px;"><strong>Placed:</strong> ${formatDateTime(order.orderDate)}</p>
                    <p style="margin: 2px 0 0; font-size: 12px;"><strong>Method:</strong> ${order.fulfilment === "delivery" ? "Express Delivery" : "Store Pickup"}</p>
                    <p style="margin: 2px 0 0; font-size: 12px;"><strong>M-Pesa Ref:</strong> <code>${escapeHtml(order.transactionRef || "N/A")}</code></p>
                </div>
            </div>

            ${buildTimesBlock(order)}

            ${createDetailsMessengerBlock(order)}

            ${buildDeliveryBlock(order)}

            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-bottom: 18px;">
                <label style="font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase;">LPG Product Specification</label>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
                    <div>
                        <strong style="font-size: 14px; color: #0f172a;">${escapeHtml(order.productName)}</strong>
                        <div style="font-size: 11px; color: #64748b; margin-top: 2px;">
                            ${escapeHtml(order.gasBrand || "LPG")} &bull; ${escapeHtml(order.cylinderSize || "13kg")} &bull; ${escapeHtml(order.productType || "Refill")}
                        </div>
                    </div>
                    <span style="font-size: 14px; font-weight: 700; color: #0f172a;">Qty: ${order.quantity || 1}</span>
                </div>
            </div>

            <div style="border-top: 1px solid #e2e8f0; padding-top: 14px;">
                <label style="font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase;">Financial Settlement Breakdown</label>
                <div style="display: flex; justify-content: space-between; margin-top: 8px; font-size: 13px;">
                    <span>Gross Customer Payment:</span>
                    <strong>${formatCurrency(fin.gross)}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; margin-top: 4px; font-size: 13px; color: #6366f1;">
                    <span>Admin GasHub Commission (${fin.rate.toFixed(1)}%):</span>
                    <strong>- ${formatCurrency(fin.gashubFee)}</strong>
                </div>
                ${order.fulfilment === "pickup" ? "" : `<div style="display: flex; justify-content: space-between; margin-top: 4px; font-size: 13px;">
                    <span>Delivery fee charged (no commission):</span>
                    <strong>+ ${formatCurrency(fin.deliveryFee)}</strong>
                </div>`}
                <div style="display: flex; justify-content: space-between; margin-top: 8px; padding-top: 8px; border-top: 1px dashed #cbd5e1; font-size: 15px; font-weight: 800; color: #059669;">
                    <span>Net Dealer Receivable:</span>
                    <span>${formatCurrency(fin.dealerNet)}</span>
                </div>
            </div>
        `;

        footer.innerHTML = `
            <button type="button" class="btn btn-secondary btn-sm" id="btnModalCloseDetails">Close</button>
        `;

        openModal(modal);

        const closeBtnBottom = document.getElementById("btnModalCloseDetails");
        if (closeBtnBottom) closeBtnBottom.onclick = () => closeModal(modal);

        bindOrderActionsPanel(order, modal);
        bindDeliveryBlock(order, modal);
    }

    /* ---------- delivery: distance, travel time and the delivery fee ----------
       Shown for delivery orders. The dealer sees how far and how long it is to the customer and enters the delivery fee.
       The fee is saved on the order, the customer sees it and pays it with the order, and it is never part of GasHub's commission. */
    function canEditDeliveryFee(order) {
        const st = normalize(order.status);
        if (order.fulfilment === "pickup") return false;
        /* The fee is fixed the moment the dealer confirms the order: that is when the customer is shown the total and pays. */
        if (st !== "pending") return false;
        return !/^(paid|complete|success)/i.test(String(order.paymentStatus || ""));
    }

    function buildDeliveryBlock(order) {
        if (order.fulfilment === "pickup") return "";
        const fee = Number(order.deliveryFee) || 0;
        const editable = canEditDeliveryFee(order);
        const lbl = 'font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase;';
        return `<div id="dlvBlock" style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 14px; margin-bottom: 18px;">
            <label style="${lbl}">Delivery distance &amp; fee</label>
            <div id="dlvRoute" style="display: flex; gap: 22px; margin-top: 8px; font-size: 13px; color: #0f172a;">Working out the distance to the customer&hellip;</div>
            ${editable ? `
            <div style="margin-top: 12px;">
                <label for="dlvFeeInput" style="font-size: 12px; font-weight: 700; color: #0f172a;">Delivery fee (KSh)</label>
                <div style="display: flex; gap: 8px; margin-top: 4px;">
                    <input id="dlvFeeInput" type="number" inputmode="decimal" min="0" max="20000" step="10" value="${fee}" style="flex: 1; min-width: 0; min-height: 40px; padding: 0 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px;">
                    <button type="button" class="btn btn-primary btn-sm" id="dlvFeeSave">Save fee</button>
                </div>
                <p id="dlvFeeMsg" style="margin: 6px 0 0; font-size: 12px; color: #64748b;">Charge by distance. <strong>Save the fee before you confirm the order: once the order is confirmed the fee is fixed and cannot be changed.</strong> GasHub takes no commission on it.</p>
            </div>` : `
            <div style="display: flex; justify-content: space-between; margin-top: 12px; padding-top: 10px; border-top: 1px dashed #bae6fd; font-size: 14px;">
                <span>Delivery fee (fixed)</span><strong>${formatCurrency(fee)}</strong>
            </div>`}
        </div>`;
    }

    function fmtDuration(min) {
        const m = Math.max(1, Math.round(Number(min) || 0));
        if (m < 60) return `${m} min`;
        const h = Math.floor(m / 60), r = m % 60;
        return r ? `${h} h ${r} min` : `${h} h`;
    }

    function bindDeliveryBlock(order, modal) {
        const box = modal.querySelector("#dlvRoute");
        if (!box) return;
        const cell = (label, value) => `<div><div style="font-size: 11px; color: #64748b;">${label}</div><strong style="font-size: 16px;">${value}</strong></div>`;
        dealerApi(`/api/dealers/orders/${encodeURIComponent(order.id)}/route`).then(r => {
            if (!modal.contains(box)) return;
            if (r.ok) {
                box.innerHTML = cell("Distance", `${r.distance_km} km`) + cell("Travel time", fmtDuration(r.duration_min)) +
                    (r.source === "estimate" ? `<div style="flex-basis: 100%; font-size: 11px; color: #92400e;">Estimate (straight-line distance plus a road allowance). The road route could not be loaded.</div>` : "");
            } else {
                box.textContent = r.reason === "customer_location_missing" ? "The customer did not pin a location on this order, so the distance can't be worked out."
                    : (r.reason === "dealer_location_missing" ? "Your business location is not saved yet. Add it on your profile to see distances." : "Distance is not available for this order.");
            }
        }).catch(err => {
            if (!modal.contains(box)) return;
            const why = String((err && err.message) || "").trim();
            box.textContent = "Could not load the distance" + (why ? " (" + why + ")" : "") + ". " +
                (/404/.test(why) ? "The server is missing the new distance route: restart or redeploy the backend with the latest files." : "Please try again.");
        });

        const save = modal.querySelector("#dlvFeeSave");
        if (!save) return;
        save.addEventListener("click", async function () {
            const input = modal.querySelector("#dlvFeeInput"), msg = modal.querySelector("#dlvFeeMsg");
            const fee = Number(input.value);
            if (!Number.isFinite(fee) || fee < 0 || fee > 20000) { msg.style.color = "#b91c1c"; msg.textContent = "Enter a delivery fee between KSh 0 and KSh 20,000."; return; }
            save.disabled = true; msg.style.color = "#64748b"; msg.textContent = "Saving...";
            try {
                const json = await dealerApi(`/api/dealers/orders/${encodeURIComponent(order.id)}`, { method: "PATCH", body: { delivery_fee: fee } });
                order.deliveryFee = Number(json.order.delivery_fee) || 0;
                saveOrdersDatabase();
                applyOrderFilters();
                showFeedbackBanner(`Delivery fee set to ${formatCurrency(order.deliveryFee)}. The customer can see it on their order.`, "success");
                openOrderDetailsModal(order);                 /* redraw with the new fee in the breakdown */
            } catch (error) {
                save.disabled = false; msg.style.color = "#b91c1c"; msg.textContent = error.message || "Could not save the delivery fee.";
            }
        });
    }

    /* ---------- the actions, shown inside the order window ----------
       Every button has a text label (no icon-only buttons), they are big and stacked with space between them,
       and the risky ones (confirm, reject, complete, cash) ask "Are you sure?" before anything is sent. */
    function buildOrderActionsPanel(order) {
        const st = normalize(order.status);
        const btn = (key, label, cls) => `<button type="button" class="oa-btn ${cls}" data-oa="${key}">${label}</button>`;
        const row = [];

        /* the three main buttons sit in ONE row: [confirm / cash / complete]  [assign messenger]  [reject] */
        if (st === "pending") row.push(btn("approve", "Confirm order", "oa-confirm"));
        if (canConfirmCash(order)) row.push(btn("cash", "Confirm cash received", "oa-confirm"));
        if (canCompletePickup(order)) row.push(btn("complete", "Complete order", "oa-confirm"));
        if (isAssignable(order)) row.push(btn("assign", getOrderMessenger(order) ? "Change messenger" : "Assign messenger", "oa-assign"));
        if (st === "pending") row.push(btn("reject", "Reject order", "oa-reject"));

        const messenger = isAssignable(order) && getOrderMessenger(order)
            ? `<div class="oa-note">Messenger: <b>${escapeHtml(getOrderMessenger(order).fullName)}</b></div>` : "";

        return `<div class="oa-panel" role="group" aria-label="Order actions">
            ${row.length ? `<div class="oa-row oa-cols-${row.length}">${row.join("")}</div>` : ""}
            ${messenger}
            ${btn("print", "Print receipt", "oa-print")}
        </div>`;
    }

    function bindOrderActionsPanel(order, modal) {
        modal.querySelectorAll("[data-oa]").forEach(b => {
            b.addEventListener("click", async function () {
                const key = this.dataset.oa;
                if (key === "print") { closeModal(modal); openOrderInvoiceModal(order); return; }
                if (key === "assign") { closeModal(modal); openAssignMessengerModal(order); return; }
                if (key === "approve") {
                    const yes = await GasHubDialog.confirm({ title: "Confirm this order?", message: `Confirm order ${order.id}? The customer will get an SMS and email saying they can now pay.` + (order.fulfilment === "delivery" && !(Number(order.deliveryFee) > 0) ? " The delivery fee is still KSh 0, so delivery will be free. Set the delivery fee first if you want to charge for it." : ""), confirmText: "Yes, confirm order", cancelText: "Not yet", tone: "success" });
                    if (!yes) return;
                    closeModal(modal);
                    const ok = await updateOrderStatus(order, "approved", "Order confirmed. The customer has been told they can now pay.");
                    if (ok && isAssignable(order) && !getOrderMessenger(order)) openAssignMessengerModal(order);
                    return;
                }
                if (key === "reject") {
                    const yes = await GasHubDialog.confirm({ title: "Reject this order?", message: `Reject order ${order.id}? The customer will be notified.`, confirmText: "Reject order", cancelText: "Keep order", tone: "danger" });
                    if (!yes) return;
                    closeModal(modal);
                    updateOrderStatus(order, "rejected", "Order rejected and customer notified.");
                    return;
                }
                if (key === "cash") { closeModal(modal); confirmCash(order); return; }
                if (key === "complete") {
                    const yes = await GasHubDialog.confirm({ title: "Complete this order?", message: `Has the customer collected order ${order.id}?`, confirmText: "Yes, complete it", cancelText: "Not yet", tone: "success" });
                    if (!yes) return;
                    closeModal(modal);
                    updateOrderStatus(order, "completed", "Order marked as completed. The customer now sees it as completed.");
                }
            });
        });
    }

    /* =====================================================
       16. GLOBAL MODALS INITIALIZATION & EVENT LISTENERS
       ===================================================== */

    function initExportAndPrintModals() {
        const exportModal = document.getElementById("orderExportModal");
        const invoiceModal = document.getElementById("orderInvoiceModal");
        const detailsModal = document.getElementById("orderDetailsModal");

        const openBtn1 = document.getElementById("btnOpenExportModal");
        const openBtn2 = document.getElementById("btnHeaderExportReport");

        if (openBtn1) openBtn1.addEventListener("click", () => {
            openModal(exportModal);
            updateTimelineExportPreview();
        });
        if (openBtn2) openBtn2.addEventListener("click", () => {
            openModal(exportModal);
            updateTimelineExportPreview();
        });

        // Close buttons for Export Modal
        const closeExport = document.getElementById("btnCloseExportModal");
        const closeExportBottom = document.getElementById("btnCloseExportModalBottom");
        if (closeExport) closeExport.addEventListener("click", () => closeModal(exportModal));
        if (closeExportBottom) closeExportBottom.addEventListener("click", () => closeModal(exportModal));

        // Close buttons for Invoice Modal
        const closeInv = document.getElementById("btnCloseInvoiceModal");
        const closeInvBottom = document.getElementById("btnCloseInvoiceModalBottom");
        if (closeInv) closeInv.addEventListener("click", () => closeModal(invoiceModal));
        if (closeInvBottom) closeInvBottom.addEventListener("click", () => closeModal(invoiceModal));

        // Close button for Details Modal header
        const closeDetails = document.getElementById("btnCloseOrderDetailsModal");
        if (closeDetails) closeDetails.addEventListener("click", () => closeModal(detailsModal));

        // Print triggers
        const triggerPrint = document.getElementById("btnTriggerPrintInvoice");
        const triggerPrintBottom = document.getElementById("btnTriggerPrintInvoiceBottom");
        const printAction = () => window.print();
        if (triggerPrint) triggerPrint.addEventListener("click", printAction);
        if (triggerPrintBottom) triggerPrintBottom.addEventListener("click", printAction);

        // Timeline selector in Export Modal
        const timelineSelect = document.getElementById("exportTimelineSelect");
        if (timelineSelect) {
            timelineSelect.addEventListener("change", updateTimelineExportPreview);
        }

        const btnPrintReport = document.getElementById("btnPrintTimelineReport");
        if (btnPrintReport) {
            btnPrintReport.addEventListener("click", () => {
                const timeline = timelineSelect ? timelineSelect.value : "month";
                printTimelineReport(timeline);
            });
        }

        const btnCSV = document.getElementById("btnDownloadReportCSV");
        if (btnCSV) {
            btnCSV.addEventListener("click", () => {
                const timeline = timelineSelect ? timelineSelect.value : "month";
                downloadOrdersCSV(timeline);
            });
        }

        // Click outside on the dark backdrop to close any open modal
        document.querySelectorAll(".dealer-modal-overlay").forEach(overlay => {
            overlay.addEventListener("click", function (e) {
                if (e.target === overlay) {
                    closeModal(overlay);
                }
            });
        });

        // Escape key closes any active modal
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") {
                document.querySelectorAll(".dealer-modal-overlay.active").forEach(m => {
                    closeModal(m);
                });
            }
        });
    }

    function getOrdersByTimeline(timeline) {
        const now = new Date().getTime();
        return ordersState.orders.filter(order => {
            if (timeline === "all") return true;
            const diffDays = (now - new Date(order.orderDate).getTime()) / (1000 * 3600 * 24);
            if (timeline === "today") return diffDays <= 1;
            if (timeline === "week") return diffDays <= 7;
            if (timeline === "month") return diffDays <= 30;
            if (timeline === "quarter") return diffDays <= 90;
            return true;
        });
    }

    function updateTimelineExportPreview() {
        const select = document.getElementById("exportTimelineSelect");
        const timeline = select ? select.value : "month";
        const orders = getOrdersByTimeline(timeline);

        let gross = 0;
        let gashub = 0;
        let net = 0;

        orders.forEach(o => {
            if (normalize(o.status) !== "rejected") {
                const fin = calculateOrderFinancials(o);
                gross += fin.gross;
                gashub += fin.gashubFee;
                net += fin.dealerNet;
            }
        });

        setText("exportPreviewOrderCount", orders.length);
        setText("exportPreviewGross", formatCurrency(gross));
        setText("exportPreviewFeeRate", `${(Number(ordersState.adminCommissionRate) || 0).toFixed(1)}%`);
        setText("exportPreviewGashub", formatCurrency(gashub));
        setText("exportPreviewNet", formatCurrency(net));
    }

    function printTimelineReport(timeline) {
        const orders = getOrdersByTimeline(timeline);
        const dealer = getStoredDealerData() || { businessName: "" };

        const printWindow = window.open("", "_blank");
        if (!printWindow) {
            alert("Please allow popups to print report.");
            return;
        }

        let gross = 0;
        let gashub = 0;
        let net = 0;

        const rowsHtml = orders.map(o => {
            const fin = calculateOrderFinancials(o);
            gross += fin.gross;
            gashub += fin.gashubFee;
            net += fin.dealerNet;

            return `
                <tr>
                    <td>${escapeHtml(o.id)}</td>
                    <td>${formatDateTime(o.orderDate)}</td>
                    <td>${escapeHtml(o.customerName)} (${escapeHtml(o.customerPhone)})</td>
                    <td>${escapeHtml(o.productName)}</td>
                    <td style="text-align: right;">${formatCurrency(fin.gross)}</td>
                    <td style="text-align: right; color: #6366f1;">${formatCurrency(fin.gashubFee)}</td>
                    <td style="text-align: right; color: #059669; font-weight: bold;">${formatCurrency(fin.dealerNet)}</td>
                    <td>${escapeHtml(o.status.toUpperCase())}</td>
                </tr>
            `;
        }).join("");

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>GasHub Orders Report - ${timeline.toUpperCase()}</title>
                <style>
                    body { font-family: Inter, Arial, sans-serif; padding: 30px; color: #1e293b; }
                    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #d97706; padding-bottom: 15px; margin-bottom: 20px; }
                    .header h1 { margin: 0; font-size: 20px; color: #0f172a; }
                    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; background: #f8fafc; padding: 15px; border-radius: 8px; margin-bottom: 25px; }
                    .summary-item span { font-size: 11px; color: #64748b; display: block; }
                    .summary-item strong { font-size: 16px; color: #0f172a; }
                    table { width: 100%; border-collapse: collapse; font-size: 12px; }
                    th { background: #f1f5f9; text-align: left; padding: 10px; border-bottom: 1px solid #cbd5e1; }
                    td { padding: 9px 10px; border-bottom: 1px solid #e2e8f0; }
                    .footer { margin-top: 30px; text-align: center; font-size: 11px; color: #94a3b8; }
                </style>
            </head>
            <body>
                <div class="header">
                    <div>
                        <h1>GASHUB DEALER DISPATCH & SETTLEMENT REPORT</h1>
                        <p style="margin: 3px 0; font-size: 13px;">Dealer: ${escapeHtml(dealer.businessName || "Authorized Dealer")}</p>
                        <small style="color: #64748b;">Timeline: ${timeline.toUpperCase()} &bull; Generated: ${new Date().toLocaleString()}</small>
                    </div>
                </div>

                <div class="summary">
                    <div class="summary-item">
                        <span>TOTAL ORDERS</span>
                        <strong>${orders.length}</strong>
                    </div>
                    <div class="summary-item">
                        <span>GROSS REVENUE</span>
                        <strong>${formatCurrency(gross)}</strong>
                    </div>
                    <div class="summary-item">
                        <span>GASHUB COMMISSION (${(Number(ordersState.adminCommissionRate) || 0).toFixed(1)}%)</span>
                        <strong style="color: #6366f1;">${formatCurrency(gashub)}</strong>
                    </div>
                    <div class="summary-item">
                        <span>NET DEALER PAYOUT</span>
                        <strong style="color: #059669;">${formatCurrency(net)}</strong>
                    </div>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th>Order #</th>
                            <th>Date</th>
                            <th>Customer</th>
                            <th>Product</th>
                            <th style="text-align: right;">Gross</th>
                            <th style="text-align: right;">GasHub Cut</th>
                            <th style="text-align: right;">Dealer Net</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>

                <div class="footer">
                    <p>GasHub Official Audited Statement &bull; EPRA Certified Portal &bull; Valid Without Stamp</p>
                </div>

                <script>
                    window.onload = function() { window.print(); }
                </script>
            </body>
            </html>
        `;

        printWindow.document.write(html);
        printWindow.document.close();
    }

    function downloadOrdersCSV(timeline) {
        const orders = getOrdersByTimeline(timeline);
        if (orders.length === 0) {
            alert("No orders available in the selected timeline.");
            return;
        }

        const headers = [
            "Order ID",
            "Order Date",
            "Customer Name",
            "Customer Phone",
            "Product",
            "Brand",
            "Quantity",
            "Gross Amount (KSh)",
            `GasHub Fee ${(Number(ordersState.adminCommissionRate) || 0).toFixed(1)}% (KSh)`,
            "Dealer Net Payout (KSh)",
            "Fulfilment",
            "Delivery Address",
            "Payment Status",
            "Payment Method",
            "M-Pesa Reference",
            "Order Status",
            "Confirmed At",
            "Paid At",
            "Delivery Started At",
            "Delivered At",
            "Completed At"
        ];

        const rows = orders.map(o => {
            const fin = calculateOrderFinancials(o);
            return [
                `"${o.id}"`,
                `"${o.orderDate}"`,
                `"${o.customerName || ""}"`,
                `"${o.customerPhone || ""}"`,
                `"${o.productName || ""}"`,
                `"${o.gasBrand || ""}"`,
                o.quantity || 1,
                fin.gross.toFixed(2),
                fin.gashubFee.toFixed(2),
                fin.dealerNet.toFixed(2),
                `"${o.fulfilment || ""}"`,
                `"${(o.deliveryAddress || "").replace(/"/g, '""')}"`,
                `"${o.paymentStatus || ""}"`,
                `"${o.paymentMethodChosen === false ? "Not chosen yet" : (o.paymentMethod || "")}"`,
                `"${o.transactionRef || ""}"`,
                `"${o.status || ""}"`,
                `"${o.confirmedAt || ""}"`,
                `"${o.paidAt || ""}"`,
                `"${o.dispatchedAt || ""}"`,
                `"${o.deliveredAt || ""}"`,
                `"${o.completedAt || ""}"`
            ];
        });

        const csvContent = [headers.join(","), ...rows.map(r => r.join(","))].join("\r\n");
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `GasHub_Orders_Report_${timeline}_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /* =====================================================
       17. PAGINATION CONTROLS
       ===================================================== */

    function initPaginationEvents() {
        const prevBtn = document.getElementById("ordersPreviousPage");
        const nextBtn = document.getElementById("ordersNextPage");

        if (prevBtn) {
            prevBtn.addEventListener("click", () => {
                if (ordersState.currentPage > 1) {
                    ordersState.currentPage--;
                    renderOrdersTable();
                }
            });
        }

        if (nextBtn) {
            nextBtn.addEventListener("click", () => {
                const totalPages = Math.ceil(ordersState.filteredOrders.length / ordersState.itemsPerPage);
                if (ordersState.currentPage < totalPages) {
                    ordersState.currentPage++;
                    renderOrdersTable();
                }
            });
        }
    }

    function updatePaginationControls(totalItems) {
        const info = document.getElementById("ordersPaginationInfo");
        const prevBtn = document.getElementById("ordersPreviousPage");
        const nextBtn = document.getElementById("ordersNextPage");
        const numbersContainer = document.getElementById("ordersPageNumbers");

        const totalPages = Math.ceil(totalItems / ordersState.itemsPerPage) || 1;

        if (info) {
            info.textContent = `Showing ${totalItems === 0 ? 0 : (ordersState.currentPage - 1) * ordersState.itemsPerPage + 1} - ${Math.min(ordersState.currentPage * ordersState.itemsPerPage, totalItems)} of ${totalItems} orders`;
        }

        if (prevBtn) prevBtn.disabled = ordersState.currentPage <= 1;
        if (nextBtn) nextBtn.disabled = ordersState.currentPage >= totalPages;

        if (numbersContainer) {
            numbersContainer.innerHTML = "";
            for (let i = 1; i <= totalPages; i++) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = `dealer-orders-page-button ${i === ordersState.currentPage ? "active" : ""}`;
                btn.textContent = i;
                btn.addEventListener("click", () => {
                    ordersState.currentPage = i;
                    renderOrdersTable();
                });
                numbersContainer.appendChild(btn);
            }
        }
    }

    /* =====================================================
       18. QUICK ACTIONS & TOAST
       ===================================================== */

    function initQuickActionEvents() {
        const refreshBtn = document.getElementById("btnRefreshOrders");
        if (refreshBtn) {
            refreshBtn.addEventListener("click", () => {
                refreshBtn.querySelector("i").classList.add("fa-spin");
                setTimeout(() => {
                    refreshBtn.querySelector("i").classList.remove("fa-spin");
                    applyOrderFilters();
                    showFeedbackBanner("Orders registry synchronized with live feed.", "info");
                }, 400);
            });
        }
    }

    function showFeedbackBanner(message, type = "info") {
        const banner = document.getElementById("ordersMessage");
        if (!banner) return;

        banner.textContent = message;
        banner.className = `dashboard-alert-banner ${type}`;
        banner.hidden = false;

        setTimeout(() => {
            banner.hidden = true;
        }, 4500);
    }

    /* =====================================================
       19. FORMATTERS & HELPERS
       ===================================================== */

    function normalize(val) {
        return String(val || "").trim().toLowerCase().replace(/[_-]+/g, " ");
    }

    function setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function formatCurrency(val) {
        const num = Number(val);
        if (!Number.isFinite(num)) return "KSh 0.00";
        return "KSh " + new Intl.NumberFormat("en-KE", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(num);
    }

    function formatNumber(val) {
        const num = Number(val);
        if (!Number.isFinite(num)) return "0";
        return new Intl.NumberFormat("en-KE").format(num);
    }

    /* "Order times" box in the order pop-up: every step with its exact date and time */
    function buildTimesBlock(order) {
        const closed = ["rejected", "cancelled"].includes(normalize(order.status));
        const rows = [
            ["Order placed", order.orderDate],
            ["Confirmed", order.confirmedAt],
            ["Paid", order.paidAt],
            ["Delivery started", order.dispatchedAt],
            ["Delivered", order.deliveredAt],
            ["Completed", order.completedAt]
        ];
        if (closed) rows.push([normalize(order.status) === "rejected" ? "Rejected" : "Cancelled", order.cancelledAt]);
        return `
            <div style="margin-bottom: 18px; padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc;">
                <label style="font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase;">Order Times</label>
                ${rows.map(([name, when]) => `
                    <div style="display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 12px; border-bottom: 1px dashed #e2e8f0;">
                        <strong style="color: #334155;">${name}</strong>
                        <span style="color: ${when ? "#0f172a" : "#94a3b8"}; text-align: right;">${when ? escapeHtml(formatDateTime(when)) : "—"}</span>
                    </div>`).join("")}
            </div>`;
    }

    function formatDateTime(val) {
        if (!val) return "—";
        const d = new Date(val);
        if (isNaN(d.getTime())) return String(val);
        return new Intl.DateTimeFormat("en-KE", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        }).format(d);
    }

    function escapeHtml(val) {
        return String(val ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /* =====================================================
       19b. DELIVERY MESSENGERS
       The dealer's messengers are managed on dealer-messengers.html
       (saved on the server). Here a delivery order can be
       given to one of them.
       ===================================================== */

    /* The messenger on an order (pass the order or its number), or null. Comes from the order itself, as saved on the server. */
    function getOrderMessenger(ref) {
        const order = ref && typeof ref === "object" ? ref : ordersState.orders.find(o => String(o.id) === String(ref));
        if (!order || !order.rider) return null;
        return { messengerId: order.rider.id, fullName: order.rider.fullName, idNumber: order.rider.idNumber, phone: order.rider.phone };
    }

    /* 0712345678 -> 0712 345 678 */
    function formatPhone(phone) {
        const d = String(phone || "").replace(/\s/g, "");
        return /^\d{10}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : d;
    }

    /* Only delivery orders that are still open can be given to a messenger */
    function isAssignable(order) {
        if (!order) return false;
        if (normalize(order.fulfilment) !== "delivery") return false;
        const st = normalize(order.status);
        return st !== "rejected" && st !== "cancelled" && st !== "completed";
    }

    function createMessengerChip(order) {
        if (normalize(order.fulfilment) !== "delivery") return "";
        const m = getOrderMessenger(order);
        if (m) {
            return `<div><span class="order-messenger-chip" title="${escapeHtml(m.fullName)} - ${escapeHtml(m.phone)}"><i class="fa-solid fa-motorcycle" aria-hidden="true"></i> ${escapeHtml(m.fullName)}</span></div>`;
        }
        if (isAssignable(order)) {
            return `<div><span class="order-messenger-chip unassigned"><i class="fa-solid fa-user-clock" aria-hidden="true"></i> No messenger</span></div>`;
        }
        return "";
    }

    function createDetailsMessengerBlock(order) {
        if (normalize(order.fulfilment) !== "delivery") return "";
        const m = getOrderMessenger(order);
        const label = `<label style="font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase;">Delivery Messenger</label>`;
        if (!m) {
            return `<div class="order-detail-messenger">${label}<p style="margin: 6px 0 0; font-size: 12px; color: #92400e;">No messenger assigned yet.</p></div>`;
        }
        const tel = /^0\d{9}$/.test(m.phone) ? "+254" + m.phone.slice(1) : m.phone;
        return `
            <div class="order-detail-messenger">
                ${label}
                <p style="margin: 4px 0 0; font-size: 14px; font-weight: 700; color: #0f172a;">${escapeHtml(m.fullName)}</p>
                <p style="margin: 2px 0 0; font-size: 12px; color: #334155;"><strong>ID Number:</strong> ${escapeHtml(m.idNumber)}</p>
                <p style="margin: 2px 0 0; font-size: 12px; color: #334155;"><strong>Phone:</strong> <a href="tel:${escapeHtml(tel)}">${escapeHtml(formatPhone(m.phone))}</a></p>
                ${canShareTracking(order) ? `
                    <div class="order-detail-tracking" style="margin-top: 10px;">
                        <button type="button" class="btn btn-secondary btn-sm" data-track-link="${escapeHtml(order.id)}">
                            <i class="fa-solid fa-location-crosshairs"></i> Get live tracking link
                        </button>
                        <p style="margin: 6px 0 0; font-size: 11px; color: #64748b;">Send this link to ${escapeHtml(m.fullName)}. When they open it and tap Start delivery, the customer sees them live on the map.</p>
                    </div>` : ""}
            </div>
        `;
    }

    /* Live tracking can be shared for an open delivery order that has a messenger (not pending, not finished) */
    function canShareTracking(order) {
        if (!order || normalize(order.fulfilment) !== "delivery" || !getOrderMessenger(order)) return false;
        const st = normalize(order.status);
        return st === "approved" || st === "dispatched";
    }

    /* "Get live tracking link": asks the server for this order's secret link, then shows Email, Copy and WhatsApp buttons.
       The link works for 12 hours and locks to the first phone that starts the delivery. */
    function initTrackingLinkButton() {
        document.addEventListener("click", async (event) => {
            const btn = event.target.closest("[data-track-link]");
            if (!btn) return;
            const order = ordersState.orders.find(o => String(o.id) === btn.getAttribute("data-track-link"));
            if (!order) return;
            const box = btn.closest(".order-detail-tracking");
            const m = getOrderMessenger(order);
            const wa = String(m && m.phone || "").replace(/[^\d]/g, "").replace(/^0/, "254");
            const orderPath = `/api/dealers/orders/${encodeURIComponent(order.id)}`;

            async function showLink(renew) {
                const json = await dealerApi(`${orderPath}/tracking-link`, { method: "POST", body: renew ? { renew: true } : {} });
                const text = `Hello ${m ? m.fullName : ""}, open this link on your phone to start delivery of order ${order.id}. Tap "Start delivery" and keep the page open: ${json.link}`;
                box.innerHTML = "";
                const note = document.createElement("div");
                note.style.cssText = "font-size:12px; color:#64748b; margin-bottom:6px;";
                note.textContent = `Works for ${json.expiresInHours || 12} hours and locks to the first phone that starts the delivery.`;
                const input = document.createElement("input");
                input.type = "text"; input.readOnly = true; input.value = json.link;
                input.style.cssText = "width:100%; padding:8px; font-size:12px; border:1px solid #cbd5e1; border-radius:8px;";
                input.addEventListener("focus", () => input.select());
                const emailBtn = document.createElement("button");
                emailBtn.type = "button"; emailBtn.className = "btn btn-primary btn-sm"; emailBtn.style.marginTop = "6px";
                emailBtn.innerHTML = '<i class="fa-solid fa-envelope"></i> Email to messenger';
                emailBtn.addEventListener("click", async () => {
                    emailBtn.disabled = true;
                    try {
                        const r = await dealerApi(`${orderPath}/email-tracking-link`, { method: "POST", body: {} });
                        emailBtn.innerHTML = '<i class="fa-solid fa-check"></i> Emailed';
                        showFeedbackBanner(r.message || "Email sent to the messenger.", "success");
                    } catch (error) {
                        emailBtn.disabled = false;
                        showFeedbackBanner(error.message || "Could not email the messenger.", "error");
                    }
                });
                const copyBtn = document.createElement("button");
                copyBtn.type = "button"; copyBtn.className = "btn btn-secondary btn-sm"; copyBtn.style.cssText = "margin:6px 0 0 6px;";
                copyBtn.textContent = "Copy link";
                copyBtn.addEventListener("click", async () => {
                    try { await navigator.clipboard.writeText(json.link); copyBtn.textContent = "Copied"; }
                    catch (e) { input.select(); copyBtn.textContent = "Press Ctrl+C to copy"; }
                });
                const renewBtn = document.createElement("button");
                renewBtn.type = "button"; renewBtn.className = "btn btn-secondary btn-sm"; renewBtn.style.cssText = "margin:6px 0 0 6px;";
                renewBtn.textContent = "New link (old one stops)";
                renewBtn.title = "Use this if the messenger changed phone or the link was shared by mistake";
                renewBtn.addEventListener("click", async () => {
                    if (!(await GasHubDialog.confirm({ title: "Make a new link?", message: "The old link stops working straight away. Send the new link to the messenger.", confirmText: "Make new link", tone: "warning" }))) return;
                    renewBtn.disabled = true;
                    try { await showLink(true); showFeedbackBanner("New link created. The old one no longer works.", "success"); }
                    catch (error) { renewBtn.disabled = false; showFeedbackBanner(error.message || "Could not create a new link.", "error"); }
                });
                box.append(note, input, emailBtn, copyBtn);
                if (wa) {
                    const waLink = document.createElement("a");
                    waLink.className = "btn btn-secondary btn-sm"; waLink.style.cssText = "margin: 6px 0 0 6px;";
                    waLink.target = "_blank"; waLink.rel = "noopener";
                    waLink.href = `https://wa.me/${wa}?text=${encodeURIComponent(text)}`;
                    waLink.textContent = "Send on WhatsApp";
                    box.append(waLink);
                }
                box.append(renewBtn);
            }

            btn.disabled = true;
            try { await showLink(false); }
            catch (error) {
                btn.disabled = false;
                showFeedbackBanner(error.message || "Could not create the tracking link.", "error");
            }
        });
    }

    /* Open jobs per messenger, counted from the orders on this page */
    function countActiveJobs() {
        const counts = {};
        ordersState.orders.forEach(order => {
            const st = normalize(order.status);
            if (!order.rider || st === "completed" || st === "rejected" || st === "cancelled") return;
            counts[order.rider.id] = (counts[order.rider.id] || 0) + 1;
        });
        return counts;
    }

    function openAssignMessengerModal(order) {
        const modal = document.getElementById("assignMessengerModal");
        const body = document.getElementById("assignMessengerModalBody");
        const footer = document.getElementById("assignMessengerModalFooter");
        if (!modal || !body || !footer) return;

        const messengers = ordersState.riders;
        const current = getOrderMessenger(order);
        const jobs = countActiveJobs();
        setText("assignModalOrderNum", `#${order.id}`);

        const summary = `
            <div class="assign-order-summary">
                <strong>${escapeHtml(order.customerName || "Customer")}</strong>
                <p>${escapeHtml(order.productName || "LPG order")} &times; ${escapeHtml(String(order.quantity || 1))}</p>
                <p><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${escapeHtml(order.deliveryAddress || "No delivery address on this order")}
                ${order.pinUrl ? ` &middot; <a href="${order.pinUrl}" target="_blank" rel="noopener">Open pinned location</a>` : ""}</p>
            </div>
        `;

        if (!messengers.length) {
            body.innerHTML = summary + `
                <div class="assign-empty">
                    <i class="fa-solid fa-motorcycle" aria-hidden="true"></i>
                    <p>You have not added any messengers yet.</p>
                    <a href="dealer-messengers.html" class="btn btn-primary btn-sm">
                        <i class="fa-solid fa-user-plus" aria-hidden="true"></i> Add a Messenger
                    </a>
                </div>
            `;
            footer.innerHTML = `<button type="button" class="btn btn-secondary btn-sm" id="btnAssignCancel">Close</button>`;
        } else {
            const selectedId = current && messengers.some(m => String(m.id) === String(current.messengerId)) ? String(current.messengerId) : "";
            body.innerHTML = summary + `
                <span class="assign-list-label">Choose who delivers this order</span>
                <div class="assign-messenger-list" role="radiogroup" aria-label="Messengers">
                    ${messengers.map(m => `
                        <label class="assign-messenger-option">
                            <input type="radio" name="assignMessenger" value="${escapeHtml(m.id)}" ${String(m.id) === selectedId ? "checked" : ""}>
                            <span class="assign-messenger-meta">
                                <strong>${escapeHtml(m.full_name)}</strong>
                                <span>ID ${escapeHtml(m.id_number)} &bull; ${escapeHtml(formatPhone(m.phone))}</span>
                            </span>
                            <span class="assign-messenger-jobs">${jobs[m.id] || 0} active</span>
                        </label>
                    `).join("")}
                </div>
            `;
            footer.innerHTML = `
                <button type="button" class="btn btn-secondary btn-sm" id="btnAssignCancel">Cancel</button>
                ${current ? `<button type="button" class="btn btn-secondary btn-sm" id="btnAssignRemove"><i class="fa-solid fa-user-slash"></i> Remove</button>` : ""}
                <button type="button" class="btn btn-primary btn-sm" id="btnAssignConfirm" ${selectedId ? "" : "disabled"}>
                    <i class="fa-solid fa-check"></i> ${current ? "Change Messenger" : "Assign Messenger"}
                </button>
            `;

            const confirmBtn = document.getElementById("btnAssignConfirm");
            body.querySelectorAll('input[name="assignMessenger"]').forEach(r => {
                r.addEventListener("change", () => { confirmBtn.disabled = false; });
            });
            confirmBtn.onclick = async () => {
                const picked = body.querySelector('input[name="assignMessenger"]:checked');
                if (!picked) return;
                confirmBtn.disabled = true;
                try {
                    const json = await dealerApi(`/api/dealers/orders/${encodeURIComponent(order.id)}`, { method: "PATCH", body: { riderId: picked.value } });
                    order.rider = riderFromServer(json.order);
                    closeModal(modal);
                    renderOrdersTable();
                    const mail = json.messengerEmail;
                    if (mail && mail.sent) {
                        showFeedbackBanner(`${order.rider.fullName} assigned to order ${order.id}. ${mail.message}`, "success");
                    } else if (mail && mail.message) {
                        showFeedbackBanner(mail.message, mail.message.indexOf("not sent") > -1 || mail.message.indexOf("no link") > -1 ? "error" : "info");
                    } else {
                        showFeedbackBanner(`${order.rider.fullName} assigned to deliver order ${order.id}. The customer can now see who is bringing their gas.`, "success");
                    }
                } catch (error) {
                    confirmBtn.disabled = false;
                    showFeedbackBanner(error.message || "Could not assign the messenger. Please try again.", "error");
                }
            };
            const removeBtn = document.getElementById("btnAssignRemove");
            if (removeBtn) removeBtn.onclick = async () => {
                try {
                    await dealerApi(`/api/dealers/orders/${encodeURIComponent(order.id)}`, { method: "PATCH", body: { clearRider: true } });
                    order.rider = null;
                    closeModal(modal);
                    renderOrdersTable();
                    showFeedbackBanner(`Messenger removed from order ${order.id}.`, "info");
                } catch (error) {
                    showFeedbackBanner(error.message || "Could not remove the messenger.", "error");
                }
            };
        }

        const cancelBtn = document.getElementById("btnAssignCancel");
        if (cancelBtn) cancelBtn.onclick = () => closeModal(modal);
        openModal(modal);
    }

    function initAssignMessengerModal() {
        const modal = document.getElementById("assignMessengerModal");
        const closeBtn = document.getElementById("btnCloseAssignModal");
        if (closeBtn && modal) closeBtn.addEventListener("click", () => closeModal(modal));
    }

    /* =====================================================
       19c. HELPERS THE UPLOADED FILE WAS MISSING
       dealer-order.js called these but never defined them, so the
       Orders page threw errors on load. If your own copy of the
       file already has them, delete this block.
       ===================================================== */

    function openModal(modal) {
        if (!modal) return;
        modal.hidden = false;
        modal.classList.add("active");
    }

    function closeModal(modal) {
        if (!modal) return;
        modal.classList.remove("active");
        modal.hidden = true;
    }

    /* Gross = what the customer paid for the goods; GasHub takes its commission from it */
    function calculateOrderFinancials(order) {
        const rate = Number(ordersState.adminCommissionRate) || 0;
        const qty = Number(order.quantity) || 1;
        const gross = Number(
            order.total_amount ?? order.totalAmount ?? order.amount ??
            (Number(order.unitPrice) ? Number(order.unitPrice) * qty : 0)
        ) || 0;
        /* GasHub's commission is on the products only. The delivery fee is the dealer's own charge: no commission on it. */
        const gashubFee = Math.round(gross * rate) / 100;
        const deliveryFee = order.fulfilment === "pickup" ? 0 : (Number(order.deliveryFee) || 0);
        return { gross, rate, gashubFee, deliveryFee, dealerNet: gross - gashubFee + deliveryFee };
    }

    /* Keeps a copy of the orders on this device (the server is the source of truth) */
    function saveOrdersDatabase() {
        try {
            localStorage.setItem("gashub_dealer_orders_cache", JSON.stringify(ordersState.orders));
        } catch (e) {}
    }

    function initOrderFilters() {
        const byId = id => document.getElementById(id);
        const searchInputs = [byId("orderSearch"), byId("headerSearchInput")].filter(Boolean);
        const clearSearch = byId("clearOrderSearch");
        const selects = {
            timeline: byId("orderTimelineFilter"),
            orderStatus: byId("orderStatusFilter"),
            paymentStatus: byId("paymentStatusFilter"),
            fulfilment: byId("fulfilmentFilter")
        };

        function refresh() {
            ordersState.currentPage = 1;
            applyOrderFilters();
        }

        searchInputs.forEach(input => {
            input.addEventListener("input", () => {
                ordersState.search = input.value.trim().toLowerCase();
                searchInputs.forEach(other => { if (other !== input) other.value = input.value; });
                if (clearSearch) clearSearch.hidden = !input.value;
                refresh();
            });
        });

        if (clearSearch) {
            clearSearch.addEventListener("click", () => {
                searchInputs.forEach(i => { i.value = ""; });
                ordersState.search = "";
                clearSearch.hidden = true;
                refresh();
            });
        }

        Object.keys(selects).forEach(key => {
            const el = selects[key];
            if (!el) return;
            if (ordersState[key] !== undefined && [...el.options].some(o => o.value === ordersState[key])) {
                el.value = ordersState[key];
            }
            el.addEventListener("change", () => {
                ordersState[key] = el.value;
                refresh();
            });
        });

        function resetAll() {
            searchInputs.forEach(i => { i.value = ""; });
            ordersState.search = "";
            if (clearSearch) clearSearch.hidden = true;
            ordersState.timeline = "month";
            ordersState.orderStatus = "";
            ordersState.paymentStatus = "";
            ordersState.fulfilment = "";
            Object.keys(selects).forEach(key => { if (selects[key]) selects[key].value = ordersState[key]; });
            refresh();
        }

        ["clearOrderFilters", "clearEmptyStateFilters"].forEach(id => {
            const btn = byId(id);
            if (btn) btn.addEventListener("click", resetAll);
        });
    }

    /* =====================================================
       20. GLOBAL EXPORT
       ===================================================== */

    window.GasHubOrders = {
        applyOrderFilters,
        calculateOrderFinancials,
        openOrderInvoiceModal,
        openOrderDetailsModal,
        closeModal,
        printTimelineReport,
        downloadOrdersCSV
    };

})();