/* =========================================================
   GASHUB EXECUTIVE DEALER DASHBOARD
   File: dealer-dashboard.js
   Dynamic interactions, responsive SVG charts, mobile drawer,
   and operational live data feeds directly synchronized with
   the Stock Control & Inventory system (Single Source of Truth).
   ========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    initDealerDashboard();
});

/* Shared Storage Key matching Stock Control module */
const INVENTORY_STORAGE_KEY = "gashub_dealer_inventory_v2";


/* =========================================================
   1. DASHBOARD INITIALIZATION
   ========================================================= */
function initDealerDashboard() {
    setupMobileSidebarDrawer();
    setupSalesPeriodAnalytics();
    setupOrderSearchFilter();
    setupNotificationTrigger();
    setupQuickActionTriggers();
    setupVerificationModal();
    checkVerificationStatus();
    loadDealerProfileData();
    renderDynamicSalesChart("30days");
    renderDynamicInventoryData();
    setupInventorySync();
    loadRecentOrdersLive();
}

/* =========================================================
   2. RESPONSIVE MOBILE SIDEBAR DRAWER
   ========================================================= */
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
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && sidebar.classList.contains("open")) {
            closeSidebar();
        }
    });

    // Close on navigation link click on mobile
    const navLinks = sidebar.querySelectorAll(".nav-item");
    navLinks.forEach((link) => {
        link.addEventListener("click", () => {
            if (window.innerWidth <= 820) {
                closeSidebar();
            }
        });
    });
}

/* =========================================================
   3. DYNAMIC INTERACTIVE SVG SALES CHART
   ========================================================= */
const SALES_DATASETS = {
    "7days": {
        labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        values: [18000, 24500, 31000, 22000, 48000, 52000, 45000],
        revenue: "KSh 240,500",
        orders: "68 Units",
        rate: "99.1%"
    },
    "30days": {
        labels: ["Week 1", "Week 2", "Week 3", "Week 4"],
        values: [185000, 240000, 290000, 230000],
        revenue: "KSh 945,000",
        orders: "342 Units",
        rate: "98.4%"
    },
    "90days": {
        labels: ["Month 1", "Month 2", "Month 3"],
        values: [780000, 920000, 1140000],
        revenue: "KSh 2,840,000",
        orders: "1,080 Units",
        rate: "98.8%"
    },
    "year": {
        labels: ["Q1", "Q2", "Q3", "Q4"],
        values: [2600000, 3100000, 3450000, 3950000],
        revenue: "KSh 13,100,000",
        orders: "4,920 Units",
        rate: "99.2%"
    }
};

function setupSalesPeriodAnalytics() {
    const periodSelect = document.getElementById("salesPeriod");
    if (!periodSelect) return;

    periodSelect.addEventListener("change", (e) => {
        const period = e.target.value;
        renderDynamicSalesChart(period);
        showDashboardBanner(`Displaying sales & refill statistics for: ${e.target.options[e.target.selectedIndex].text}`);
    });
}

function renderDynamicSalesChart(period = "30days") {
    const chartSvg = document.getElementById("dynamicSalesChart");
    const axisContainer = document.getElementById("chartAxisLabels");
    const dataset = SALES_DATASETS[period] || SALES_DATASETS["30days"];

    if (!chartSvg) return;

    // Update KPI ribbon
    setText("periodRevenue", dataset.revenue);
    setText("periodOrders", dataset.orders);
    setText("periodCompletedOrders", dataset.rate);

    // Update Axis labels
    if (axisContainer) {
        axisContainer.innerHTML = dataset.labels
            .map((label) => `<span>${escapeHtml(label)}</span>`)
            .join("");
    }

    const width = 700;
    const height = 240;
    const paddingX = 40;
    const paddingY = 30;

    const values = dataset.values;
    const minVal = Math.min(...values) * 0.85;
    const maxVal = Math.max(...values) * 1.15;

    const stepX = (width - paddingX * 2) / (values.length - 1);

    const points = values.map((val, idx) => {
        const x = paddingX + idx * stepX;
        const normalized = (val - minVal) / (maxVal - minVal);
        const y = height - paddingY - normalized * (height - paddingY * 2);
        return { x: Math.round(x), y: Math.round(y), val };
    });

    // Build SVG paths
    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    const areaPath = `${linePath} L ${points[points.length - 1].x} ${height - paddingY} L ${points[0].x} ${height - paddingY} Z`;

    // Render Grid Lines, Area, Line, Points
    chartSvg.innerHTML = `
        <defs>
            <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.35" />
                <stop offset="100%" stop-color="#f59e0b" stop-opacity="0.0" />
            </linearGradient>
        </defs>

        <!-- Subtle Grid Baseline -->
        <line x1="${paddingX}" y1="${height - paddingY}" x2="${width - paddingX}" y2="${height - paddingY}" stroke="#e2e8f0" stroke-width="1" />
        <line x1="${paddingX}" y1="${height / 2}" x2="${width - paddingX}" y2="${height / 2}" stroke="#f1f5f9" stroke-width="1" stroke-dasharray="4" />

        <!-- Area Fill -->
        <path d="${areaPath}" class="chart-area" />

        <!-- Line Stroke -->
        <path d="${linePath}" class="chart-line" />

        <!-- Interactive Points -->
        ${points.map((p) => `
            <circle cx="${p.x}" cy="${p.y}" r="4.5" class="chart-point">
                <title>KSh ${formatCurrency(p.val)}</title>
            </circle>
        `).join("")}
    `;
}

/* =========================================================
   4. LIVE INVENTORY ENGINE (Synchronized with Stock Control)
   ========================================================= */
function getStoredInventory() {
    try {
        const raw = localStorage.getItem(INVENTORY_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed;
            }
        }
    } catch (e) {
        console.warn("Could not read inventory in dashboard:", e);
    }
    // Empty until this signed-in dealer's real inventory is loaded.
    return [];
}

function renderDynamicInventoryData() {
    const products = getStoredInventory();

    const totalFullStock = products.reduce((acc, p) => acc + (Number(p.stock) || 0), 0);
    const lowStockItems = products.filter((p) => Number(p.stock) <= Number(p.lowStockLimit));
    const outOfStockItems = products.filter((p) => Number(p.stock) <= 0);

    const lowStockCount = lowStockItems.length;
    const outOfStockCount = outOfStockItems.length;

    // 1. Update Metric Card 4: Active Cylinder Stock
    const activeProductsEl = document.getElementById("activeProducts");
    if (activeProductsEl) {
        activeProductsEl.textContent = formatCurrency(totalFullStock);
    }

    const lowStockWarningTextEl = document.getElementById("lowStockWarningText");
    if (lowStockWarningTextEl) {
        const breakdownContainer = lowStockWarningTextEl.parentElement;
        if (lowStockCount > 0) {
            lowStockWarningTextEl.innerHTML = `<a href="dealer-products.html?filter=low-stock" style="color: inherit; text-decoration: none;"><strong>${lowStockCount} items</strong> at/below reorder ${outOfStockCount > 0 ? `(${outOfStockCount} out)` : ""}</a>`;
            if (breakdownContainer) {
                breakdownContainer.className = outOfStockCount > 0 ? "stat-breakdown danger" : "stat-breakdown warning";
            }
        } else {
            lowStockWarningTextEl.innerHTML = `<span style="color: #10b981; font-weight: 500;"><i class="fa-solid fa-circle-check fa-xs"></i> All items optimal</span>`;
            if (breakdownContainer) {
                breakdownContainer.className = "stat-breakdown";
            }
        }
    }

    // 2. Update Sidebar Low Stock Badge
    const sidebarBadge = document.getElementById("sidebarLowStockBadge");
    if (sidebarBadge) {
        sidebarBadge.textContent = String(lowStockCount);
        sidebarBadge.hidden = lowStockCount === 0;
    }

    // 3. Update Mobile Nav Dot
    const mobileDot = document.getElementById("mobileStockAlertDot");
    if (mobileDot) {
        mobileDot.hidden = lowStockCount === 0;
    }

    // 4. Update Header Notification Pill (Orders + Low Stock Alerts)
    const headerNotifBadge = document.getElementById("notificationBadge");
    if (headerNotifBadge) {
        lastLowStockCount = lowStockCount;
        const totalAlerts = pendingOrderAlerts + lowStockCount; // orders waiting for the dealer + inventory alerts
        headerNotifBadge.textContent = String(totalAlerts);
        headerNotifBadge.hidden = totalAlerts === 0;
    }

    // 5. Render Live Cylinder Stock Levels Matrix
    renderCylinderMatrix(products);
}

function renderCylinderMatrix(products) {
    const container = document.getElementById("cylinderStockContainer");
    if (!container) return;

    // Categorize inventory by cylinder sizes & accessories
    const categories = [
        {
            key: "6kg",
            name: "6kg Complete & Refill",
            badge: "6kg",
            badgeClass: "gold",
            filterFn: (p) => p.size && p.size.toLowerCase().includes("6kg")
        },
        {
            key: "13kg",
            name: "13kg Standard Cylinder",
            badge: "13kg",
            badgeClass: "navy",
            filterFn: (p) => p.size && p.size.toLowerCase().includes("13kg")
        },
        {
            key: "50kg",
            name: "50kg Commercial / Hotel",
            badge: "50kg",
            badgeClass: "gray",
            filterFn: (p) => (p.size && p.size.toLowerCase().includes("50kg")) || p.type === "industrial"
        },
        {
            key: "accessory",
            name: "Regulators & Accessories",
            badge: "ACC",
            badgeClass: "dark",
            filterFn: (p) => p.type === "accessory" || (p.size && p.size.toLowerCase().includes("kit"))
        }
    ];

    // Check if there are other custom sizes in inventory (e.g. 3kg, 22.5kg, 35kg)
    const otherSizes = Array.from(
        new Set(
            products
                .map((p) => p.size)
                .filter(Boolean)
                .filter((s) => !["6kg", "13kg", "50kg", "Standard Kit"].some((k) => s.toLowerCase().includes(k.toLowerCase())))
        )
    );

    otherSizes.forEach((size) => {
        categories.push({
            key: size,
            name: `${size} Specialty Gas`,
            badge: size.substring(0, 4).toUpperCase(),
            badgeClass: "gray",
            filterFn: (p) => p.size && p.size.toLowerCase() === size.toLowerCase()
        });
    });

    container.innerHTML = "";

    categories.forEach((cat) => {
        const groupItems = products.filter(cat.filterFn);
        if (groupItems.length === 0) return;

        const totalFull = groupItems.reduce((acc, p) => acc + (Number(p.stock) || 0), 0);
        const totalEmpty = groupItems.reduce((acc, p) => acc + (Number(p.emptyStock) || 0), 0);
        const lowItems = groupItems.filter((p) => Number(p.stock) <= Number(p.lowStockLimit));
        const outItems = groupItems.filter((p) => Number(p.stock) <= 0);

        const hasOut = outItems.length > 0;
        const hasLow = lowItems.length > 0;

        let pillHtml = "";
        let progressClass = "success";

        if (hasOut) {
            pillHtml = `<span class="stock-count-pill danger">${totalFull} Full &bull; ${outItems.length} Depleted</span>`;
            progressClass = "danger";
        } else if (hasLow) {
            pillHtml = `<span class="stock-count-pill warning">${totalFull} Full &bull; ${lowItems.length} Low</span>`;
            progressClass = "warning";
        } else {
            pillHtml = `<span class="stock-count-pill success">${totalFull} Full &bull; Healthy</span>`;
            progressClass = "success";
        }

        // Percentage fill calculation based on safe buffer
        const totalUnits = Math.max(totalFull + totalEmpty, 1);
        const percent = Math.min(100, Math.max(12, Math.round((totalFull / totalUnits) * 100)));

        const row = document.createElement("div");
        row.className = "cylinder-stock-row";
        row.title = `Click to view ${cat.name} in Stock Control`;
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");

        row.innerHTML = `
            <div class="cylinder-badge ${cat.badgeClass}">${escapeHtml(cat.badge)}</div>
            <div class="cylinder-details">
                <div class="cylinder-name-row">
                    <strong>${escapeHtml(cat.name)}</strong>
                    ${pillHtml}
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar ${progressClass}" style="width: ${percent}%;"></div>
                </div>
            </div>
        `;

        row.addEventListener("click", () => {
            window.location.href = `dealer-products.html?size=${encodeURIComponent(cat.key)}`;
        });

        row.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                window.location.href = `dealer-products.html?size=${encodeURIComponent(cat.key)}`;
            }
        });

        container.appendChild(row);
    });
}

function setupInventorySync() {
    // Listen for cross-tab or cross-page updates
    window.addEventListener("storage", (e) => {
        if (e.key === INVENTORY_STORAGE_KEY) {
            renderDynamicInventoryData();
        }
    });

    // Listen for custom in-window updates
    window.addEventListener("gashub:inventory-updated", () => {
        renderDynamicInventoryData();
    });
}

/* =========================================================
   5. FAST FILTER ON RECENT ORDERS
   ========================================================= */
function setupOrderSearchFilter() {
    const searchInput = document.getElementById("orderSearchInput");
    const globalSearch = document.getElementById("globalSearchInput");
    const tableBody = document.getElementById("recentOrdersBody");

    function filterRows(query) {
        if (!tableBody) return;
        const q = query.toLowerCase().trim();
        const rows = tableBody.querySelectorAll("tr");

        rows.forEach((row) => {
            const text = row.textContent.toLowerCase();
            row.style.display = text.includes(q) ? "" : "none";
        });
    }

    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            filterRows(e.target.value);
        });
    }

    if (globalSearch) {
        globalSearch.addEventListener("input", (e) => {
            filterRows(e.target.value);
        });
    }
}

/* =========================================================
   6. LOAD DEALER DISPLAY PROFILE
   ========================================================= */
function loadDealerProfileData() {
    const dealerData = getStoredDealerData();

    if (!dealerData) {
        return;
    }

    const businessName =
        dealerData.businessName ||
        dealerData.business_name ||
        dealerData.name ||
        "";

    const location =
        dealerData.location ||
        dealerData.businessLocation ||
        dealerData.business_location ||
        dealerData.town ||
        dealerData.address ||
        "";

    const phone =
        dealerData.phone ||
        dealerData.phoneNumber ||
        dealerData.phone_number ||
        "";

    const contactPerson =
        dealerData.contact_person ||
        dealerData.contactPerson ||
        dealerData.contactName ||
        "";

    if (businessName) {
        setText("dealerBusinessName", businessName);
        setText("dashboardDealerName", businessName);
        setText("dealerHeaderName", businessName);
        setText("sidebarDealerName", businessName);
    }

    if (location) {
        setText("dealerBusinessLocation", location);
    }

    if (phone) {
        setText("dealerBusinessPhone", phone);
    }

    if (contactPerson) {
        setText("dealerContactPerson", contactPerson);
    }

    // TikTok Blue Verified badge sync
    const isVerified = Boolean(dealerData.is_verified || dealerData.isVerified || localStorage.getItem("gashub_dealer_verified") === "true");
    const verifiedBadge = document.getElementById("sidebarVerifiedBadge");
    if (verifiedBadge) {
        if (isVerified) {
            verifiedBadge.classList.add("verified-active");
            verifiedBadge.style.display = "inline-flex";
            verifiedBadge.style.opacity = "1";
            verifiedBadge.style.filter = "none";
        } else {
            verifiedBadge.classList.remove("verified-active");
            verifiedBadge.style.display = "none";
            verifiedBadge.style.opacity = "0";
        }
    }

    const displayName = businessName || "Dealer";
    setAvatarInitial(displayName);
}

function getStoredDealerData() {
    const possibleKeys = [
        "gashub_dealer",
        "gashub_dealer_user",
        "gashub_dealer_active_profile",
        "dealer",
        "dealerData",
        "dealerProfile",
        "gasHubDealer"
    ];

    for (const key of possibleKeys) {
        const storedValue = localStorage.getItem(key);
        if (!storedValue) continue;

        try {
            const parsed = JSON.parse(storedValue);
            if (parsed && typeof parsed === "object") {
                return parsed;
            }
        } catch (e) {}
    }

    return null;
}

/* orders waiting for the dealer to confirm, and low-stock items: together they make the bell's number */
let pendingOrderAlerts = 0;
let lastLowStockCount = 0;

async function loadRecentOrdersLive() {
    const tableBody = document.getElementById("recentOrdersBody");
    const token = localStorage.getItem("gashub_dealer_token") || localStorage.getItem("dealerToken") || "";
    try {
        /* the signed-in dealer's own orders only (GET /api/orders returns every dealer's orders) */
        const response = await fetch("/api/dealers/orders/mine", {
            headers: Object.assign({ Accept: "application/json" }, token ? { Authorization: `Bearer ${token}` } : {})
        });
        if (!response.ok) throw new Error("Orders API unavailable");
        const payload = await response.json();
        const orders = Array.isArray(payload) ? payload : (payload.orders || payload.data || []);

        // Update stats
        setText("totalOrders", orders.length);
        const revenue = orders.filter(o => (o.payment_status === "paid" || o.paymentStatus === "paid")).reduce((s, o) => s + (Number(o.total_amount || o.amount || 0)), 0);
        setText("totalSales", `KSh ${revenue.toLocaleString("en-KE")}`);
        const statusOf = o => String(o.status || o.order_status || "pending").toLowerCase();
        /* Pending Delivery = delivery orders that are not finished yet: waiting for the dealer to confirm, confirmed/being prepared, or out with the messenger */
        const pending = orders.filter(o => o.fulfilment !== "pickup" && ["pending", "confirmed", "processing", "out_for_delivery"].includes(statusOf(o)));
        setText("pendingOrders", pending.length);
        /* the sidebar badge and the bell count the orders that still need the dealer to confirm them */
        pendingOrderAlerts = orders.filter(o => statusOf(o) === "pending").length;
        const sidebarOrdersBadge = document.getElementById("sidebarOrdersBadge");
        if (sidebarOrdersBadge) { sidebarOrdersBadge.textContent = String(pendingOrderAlerts); sidebarOrdersBadge.hidden = pendingOrderAlerts === 0; }
        const bell = document.getElementById("notificationBadge");
        if (bell) { const n = pendingOrderAlerts + lastLowStockCount; bell.textContent = String(n); bell.hidden = n === 0; }

        if (!tableBody) return;
        if (orders.length === 0) {
            tableBody.innerHTML = `
                <tr id="emptyOrdersRow">
                    <td colspan="7" class="text-center py-4 text-muted" style="text-align: center; padding: 32px 16px; color: #64748b;">
                        <i class="fa-solid fa-receipt fa-2x" style="opacity: 0.35; margin-bottom: 8px; display: block;"></i>
                        <span>No customer orders received yet. New customer orders will appear here.</span>
                    </td>
                </tr>
            `;
            return;
        }

        const recent = orders.slice(0, 5);
        tableBody.innerHTML = recent.map(o => {
            const orderId = escapeHtml(o.order_code || o.order_number || o.id || "ORD-000");
            const customerName = escapeHtml(o.customer_name || o.customerName || "Customer");
            const customerContact = escapeHtml(o.delivery_address || o.customer_phone || o.customerPhone || "");
            const firstItem = Array.isArray(o.items) && o.items[0] ? o.items[0] : null;
            const item = escapeHtml(o.item_name || o.product_name || o.productName || (firstItem ? firstItem.name + (o.items.length > 1 ? ` + ${o.items.length - 1} more` : "") : "LPG Cylinder"));
            const amount = Number(o.total_amount || o.amount || 0);
            const payment = escapeHtml(o.payment_method || o.paymentMethod || "M-Pesa");
            const status = String(o.status || o.order_status || "pending").toLowerCase();
            const done = status === "delivered" || status === "completed";
            const moving = status === "in_transit" || status === "out_for_delivery";
            const statusClass = done ? "delivered" : moving ? "in-transit" : "pending";
            const statusText = done ? "Delivered" : moving ? "In Transit" : (status === "confirmed" || status === "processing") ? "Approved" : (status === "cancelled" || status === "rejected") ? "Closed" : "Pending";

            return `
                <tr>
                    <td><span class="order-id">#${orderId}</span></td>
                    <td>
                        <div class="customer-info-cell">
                            <strong>${customerName}</strong>
                            <small>${customerContact}</small>
                        </div>
                    </td>
                    <td><span class="cylinder-tag">${item}</span></td>
                    <td><strong>KSh ${amount.toLocaleString("en-KE")}</strong></td>
                    <td><span class="pay-tag mpesa">${payment}</span></td>
                    <td><span class="status-pill ${statusClass}">${statusText}</span></td>
                    <td class="text-right">
                        <a href="dealer-orders.html" class="row-action-btn" aria-label="View order">
                            <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
                        </a>
                    </td>
                </tr>
            `;
        }).join("");
    } catch (err) {
        // Keep existing table body
    }
}

function setAvatarInitial(name) {
    const avatarEl = document.getElementById("dealerAvatarInitial");
    if (!avatarEl) return;

    const clean = String(name || "").trim();
    if (!clean) {
        avatarEl.textContent = "G";
        return;
    }

    avatarEl.textContent = clean.charAt(0).toUpperCase();
}

/* =========================================================
   7. NOTIFICATIONS & TOAST BANNER
   ========================================================= */
function setupNotificationTrigger() {
    const bellBtn = document.getElementById("dealerNotificationButton");
    if (!bellBtn) return;

    bellBtn.addEventListener("click", () => {
        const products = getStoredInventory();
        const lowItems = products.filter((p) => Number(p.stock) <= Number(p.lowStockLimit));

        if (lowItems.length > 0) {
            const sampleNames = lowItems.slice(0, 3).map((p) => p.name).join(", ");
            showDashboardBanner(`Attention: ${lowItems.length} products low in stock (${sampleNames}). Click 'Stock Control' to restock immediately.`);
        } else {
            showDashboardBanner("All cylinder stock levels optimal. You have 4 delivery orders awaiting dispatch.");
        }
    });
}

function setupQuickActionTriggers() {
    const quickSale = document.getElementById("quickSaleBtn");
    const stockIntake = document.getElementById("btnStockIntake");
    const exportBtn = document.getElementById("btnExportReport");

    if (quickSale) {
        quickSale.addEventListener("click", () => {
            showDashboardBanner("Quick Cylinder Refill POS: Select product in Stock Control to dispatch.");
            setTimeout(() => {
                window.location.href = "dealer-products.html";
            }, 800);
        });
    }

    if (stockIntake) {
        // Already an <a> tag linking to dealer-products.html?action=intake
    }

    if (exportBtn) {
        exportBtn.addEventListener("click", () => {
            showDashboardBanner("Redirecting to Stock Control to export full CSV audit report...");
            setTimeout(() => {
                window.location.href = "dealer-products.html";
            }, 600);
        });
    }
}

function showDashboardBanner(message) {
    const banner = document.getElementById("dashboardMessage");
    if (!banner) return;

    banner.textContent = message;
    banner.hidden = false;

    window.clearTimeout(showDashboardBanner.timeout);
    showDashboardBanner.timeout = window.setTimeout(() => {
        banner.hidden = true;
    }, 5000);
}

/* =========================================================
   7B. TIKTOK-STYLE BLUE BADGE VERIFICATION
   ========================================================= */
function checkVerificationStatus() {
    const isVerified = localStorage.getItem("gashub_dealer_verified") === "true";
    const badges = document.querySelectorAll(".tiktok-verified-badge");
    const btns = document.querySelectorAll(".btn-request-verification");

    badges.forEach((b) => {
        if (isVerified) {
            b.classList.add("verified-active");
            b.style.display = "inline-flex";
        } else {
            b.classList.remove("verified-active");
            b.style.display = "none";
        }
    });

    btns.forEach((btn) => {
        if (isVerified) {
            btn.classList.add("is-verified");
            btn.innerHTML = `<i class="fa-solid fa-circle-check fa-sm text-success"></i> <span>EPRA Verified Outlet</span>`;
            btn.disabled = true;
        } else {
            btn.classList.remove("is-verified");
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" class="tiktok-badge-svg-sm" aria-hidden="true">
                    <path fill="#20d5ec" d="M12 0l2.5 3.5 4.3-.7 1.4 4.1 4.1 1.4-.7 4.3 3.5 2.5-3.5 2.5.7 4.3-4.1 1.4-1.4 4.1-4.3-.7L12 24l-2.5-3.5-4.3.7-1.4-4.1-4.1-1.4.7-4.3L-1.9 9l3.5-2.5-.7-4.3 4.1-1.4 1.4-4.1 4.3.7L12 0z"/>
                    <path fill="#fff" d="M9.8 16.2l-3.5-3.5 1.4-1.4 2.1 2.1 6.3-6.3 1.4 1.4-7.7 7.7z"/>
                </svg>
                <span id="verificationBtnText">Request Verification</span>
            `;
            btn.disabled = false;
        }
    });
}

function setupVerificationModal() {
    const btnRequestVerification = document.getElementById("btnRequestVerification");
    const closeVerificationModalBtn = document.getElementById("closeVerificationModalBtn");
    const cancelVerificationBtn = document.getElementById("cancelVerificationBtn");
    const verificationModalBackdrop = document.getElementById("verificationModalBackdrop");
    const verificationForm = document.getElementById("verificationForm");

    if (btnRequestVerification) {
        btnRequestVerification.addEventListener("click", () => {
            if (verificationModalBackdrop) {
                const outletInput = document.getElementById("verifyOutletName");
                if (outletInput && !outletInput.value) {
                    outletInput.value = "GasHub Depot Nairobi Central";
                }
                verificationModalBackdrop.hidden = false;
            }
        });
    }

    function closeModal() {
        if (verificationModalBackdrop) verificationModalBackdrop.hidden = true;
    }

    if (closeVerificationModalBtn) closeVerificationModalBtn.addEventListener("click", closeModal);
    if (cancelVerificationBtn) cancelVerificationBtn.addEventListener("click", closeModal);

    if (verificationForm) {
        verificationForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const phoneInput = document.getElementById("verifyMpesaPhone");
            const phone = phoneInput ? phoneInput.value.trim() : "";
            if (!phone) {
                showDashboardBanner("Please enter a valid M-Pesa phone number for the verification prompt.");
                return;
            }

            const submitBtn = document.getElementById("submitVerificationBtn");
            const origHtml = submitBtn ? submitBtn.innerHTML : "";
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin fa-sm"></i> Sending M-Pesa STK Prompt...`;
            }

            setTimeout(() => {
                localStorage.setItem("gashub_dealer_verified", "true");
                checkVerificationStatus();
                closeModal();
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = origHtml;
                }
                showDashboardBanner("Verification fee of KSh 2,500 confirmed via M-Pesa! TikTok-style Blue Checkmark badge is now active.");
            }, 1200);
        });
    }
}

/* =========================================================
   8. UTILITY HELPERS & PUBLIC API
   ========================================================= */
function setText(elementId, value) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = value;
}

function formatCurrency(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return "0";
    return new Intl.NumberFormat("en-KE").format(num);
}

function escapeHtml(val) {
    return String(val)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* Global API for Backend Integration */
window.DealerDashboard = {
    renderDynamicSalesChart,
    renderDynamicInventoryData,
    showDashboardBanner,
    setText,
    formatCurrency
};
