/* =========================================================
   GASHUB EXECUTIVE DEALER PORTAL
   STOCK CONTROL & PRODUCT INVENTORY ENGINE
   File: dealer-products.js
   Full Stock Management, Manual Gas Brand Entry,
   Low-Stock Alerts, Web Audio / Push Notifications & Mobile Controls
   ========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    GasHubStockApp.init();
});

/* =========================================================
   APPLICATION NAMESPACE
   ========================================================= */
const GasHubStockApp = (() => {

    /* Shared Storage Key - Single Source of Truth */
    const STORAGE_KEY = "gashub_dealer_inventory_v2";

    
    /* Runtime State */
    const state = {
        products: [],
        filteredProducts: [],
        searchQuery: "",
        selectedBrand: "",
        selectedType: "",
        selectedSize: "",
        selectedStockStatus: "",
        viewMode: "table",
        currentPage: 1,
        itemsPerPage: 10,
        activeProductForAdjust: null,
        notifications: [],
        hasPromptedPush: false
    };

    let pendingDeleteProductId = null;
    let initialising = true;

    /* =========================================================
       INITIALIZATION
       ========================================================= */
    function init() {
        loadStoredData();
        setupEventListeners();
        setupSidebarMobile();
        populateBrandFilterOptions();
        checkAndTriggerLowStockAlerts();
        checkUrlParameters();
        render();
        loadDealerHeaderProfile();
        checkVerificationStatus();
        setupLiveStorageListener();

        /* Publish what this browser already has (first visit after this update),
           or restore from the server when this browser has nothing yet. */
        if (state.products.length > 0) {
            publishToCustomers();
            initialising = false;
        } else {
            restoreFromServerIfEmpty().finally(() => { initialising = false; });
        }
    }

    function loadStoredData() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    state.products = parsed;
                    return;
                }
            }
        } catch (e) {
            console.warn("Could not read stored inventory, starting with an empty inventory.", e);
        }
        state.products = [];
        saveStoredData();
    }

    function saveStoredData() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state.products));
            window.dispatchEvent(new CustomEvent("gashub:inventory-updated", { detail: state.products }));
        } catch (e) {
            console.error("Failed to save inventory to localStorage.", e);
            showToast("Could not save - browser storage is full. Remove some photos.", "error");
        }
        publishToCustomers();
    }

    /* Send the stock to the backend so customers see it.
       An empty list is only sent after the page has loaded, i.e. when the dealer
       really deleted their last item - never on page load. */
    function publishToCustomers() {
        if (window.GasHubCore && typeof window.GasHubCore.syncInventory === "function") {
            window.GasHubCore.syncInventory(state.products, { allowEmpty: !initialising });
        }
    }

    /* New browser / cleared storage: restore this dealer's products from the server
       instead of publishing an empty list over them. */
    async function restoreFromServerIfEmpty() {
        if (state.products.length > 0 || !window.GasHubCore) return;
        const restored = await window.GasHubCore.hydrateFromServer();
        if (restored.length > 0 && state.products.length === 0) {
            state.products = restored;
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.products)); } catch (e) {}
            populateBrandFilterOptions();
            checkAndTriggerLowStockAlerts();
            applyFilters();
            showToast(`Restored ${restored.length} product(s) from your account.`, "info");
        }
    }

    /* Live cross-tab sync */
    function setupLiveStorageListener() {
        window.addEventListener("storage", (e) => {
            if (e.key === STORAGE_KEY) {
                loadStoredData();
                populateBrandFilterOptions();
                checkAndTriggerLowStockAlerts();
                applyFilters();
            }
        });
    }

    /* URL Parameter pre-filters & quick triggers */
    function checkUrlParameters() {
        const params = new URLSearchParams(window.location.search);
        const filter = params.get("filter");
        const size = params.get("size");
        const brand = params.get("brand");
        const action = params.get("action");
        const search = params.get("search");

        if (search) {
            const searchInput = document.getElementById("productSearch");
            const globalSearch = document.getElementById("globalStockSearch");
            if (searchInput) searchInput.value = search;
            if (globalSearch) globalSearch.value = search;
            state.searchQuery = search.toLowerCase().trim();
        }

        if (filter) {
            const statusSelect = document.getElementById("stockStatusFilter");
            if (statusSelect && ["in-stock", "low-stock", "out-of-stock"].includes(filter)) {
                statusSelect.value = filter;
                state.selectedStockStatus = filter;
            }
        }

        if (size) {
            const sizeSelect = document.getElementById("sizeFilter");
            if (sizeSelect) {
                for (let opt of sizeSelect.options) {
                    if (opt.value.toLowerCase() === size.toLowerCase()) {
                        sizeSelect.value = opt.value;
                        state.selectedSize = opt.value;
                        break;
                    }
                }
            }
        }

        if (brand) {
            const brandSelect = document.getElementById("brandFilter");
            if (brandSelect) {
                brandSelect.value = brand;
                state.selectedBrand = brand;
            }
        }

        applyFilters();

        if (action === "add") {
            setTimeout(() => openProductModal(), 150);
        } else if (action === "intake") {
            setTimeout(() => {
                if (state.products.length > 0) {
                    openQuickAdjustModal(state.products[0].id, "restock");
                } else {
                    openProductModal();
                }
            }, 150);
        }
    }

    function loadDealerHeaderProfile() {
        const dealerKeys = ["gashub_dealer", "gashub_dealer_user", "dealer", "dealerData", "dealerProfile", "gasHubDealer"];
        for (const k of dealerKeys) {
            const str = localStorage.getItem(k);
            if (str) {
                try {
                    const data = JSON.parse(str);
                    const name = data.business_name || data.businessName || data.name || data.outletName;
                    if (name) {
                        const el = document.getElementById("dealerHeaderName");
                        if (el) el.textContent = name;
                        const initialEl = document.getElementById("dealerAvatarInitial");
                        if (initialEl) initialEl.textContent = name.trim().charAt(0).toUpperCase();
                        break;
                    }
                } catch (err) {}
            }
        }
    }

    /* =========================================================
       DOM EVENT LISTENERS
       ========================================================= */
    function setupEventListeners() {
        const globalSearch = document.getElementById("globalStockSearch");
        if (globalSearch) {
            globalSearch.addEventListener("input", (e) => {
                const query = e.target.value;
                const localSearch = document.getElementById("productSearch");
                if (localSearch) localSearch.value = query;
                state.searchQuery = query.toLowerCase().trim();
                state.currentPage = 1;
                applyFilters();
            });
        }

        const searchInput = document.getElementById("productSearch");
        const clearSearchBtn = document.getElementById("clearProductSearch");
        if (searchInput) {
            searchInput.addEventListener("input", (e) => {
                state.searchQuery = e.target.value.toLowerCase().trim();
                if (clearSearchBtn) clearSearchBtn.hidden = state.searchQuery.length === 0;
                state.currentPage = 1;
                applyFilters();
            });
        }

        if (clearSearchBtn) {
            clearSearchBtn.addEventListener("click", () => {
                if (searchInput) searchInput.value = "";
                if (globalSearch) globalSearch.value = "";
                state.searchQuery = "";
                clearSearchBtn.hidden = true;
                state.currentPage = 1;
                applyFilters();
                if (searchInput) searchInput.focus();
            });
        }

        const brandFilter = document.getElementById("brandFilter");
        if (brandFilter) {
            brandFilter.addEventListener("change", (e) => {
                state.selectedBrand = e.target.value;
                state.currentPage = 1;
                applyFilters();
            });
        }

        const typeFilter = document.getElementById("productTypeFilter");
        if (typeFilter) {
            typeFilter.addEventListener("change", (e) => {
                state.selectedType = e.target.value;
                state.currentPage = 1;
                applyFilters();
            });
        }

        const sizeFilter = document.getElementById("sizeFilter");
        if (sizeFilter) {
            sizeFilter.addEventListener("change", (e) => {
                state.selectedSize = e.target.value;
                state.currentPage = 1;
                applyFilters();
            });
        }

        const statusFilter = document.getElementById("stockStatusFilter");
        if (statusFilter) {
            statusFilter.addEventListener("change", (e) => {
                state.selectedStockStatus = e.target.value;
                state.currentPage = 1;
                applyFilters();
            });
        }

        const clearAllFiltersBtn = document.getElementById("clearAllFiltersBtn");
        if (clearAllFiltersBtn) {
            clearAllFiltersBtn.addEventListener("click", resetAllFilters);
        }

        const viewTableBtn = document.getElementById("viewTableBtn");
        const viewGridBtn = document.getElementById("viewGridBtn");
        if (viewTableBtn && viewGridBtn) {
            viewTableBtn.addEventListener("click", () => setViewMode("table"));
            viewGridBtn.addEventListener("click", () => setViewMode("grid"));
        }

        const openAddModalBtns = [
            document.getElementById("openAddProductModalBtn"),
            document.getElementById("introAddProductBtn"),
            document.getElementById("emptyAddProductBtn")
        ];
        openAddModalBtns.forEach((btn) => {
            if (btn) btn.addEventListener("click", () => openProductModal());
        });

        const closeProductModalBtn = document.getElementById("closeProductModalBtn");
        const cancelProductModalBtn = document.getElementById("cancelProductModalBtn");
        if (closeProductModalBtn) closeProductModalBtn.addEventListener("click", closeProductModal);
        if (cancelProductModalBtn) cancelProductModalBtn.addEventListener("click", closeProductModal);

        const productForm = document.getElementById("productForm");
        let keepModalOpenForAnother = false;
        if (productForm) {
            productForm.addEventListener("submit", (e) => {
                handleProductFormSubmit(e, keepModalOpenForAnother);
                keepModalOpenForAnother = false;
            });
        }

        const saveAndAddAnotherBtn = document.getElementById("saveAndAddAnotherBtn");
        if (saveAndAddAnotherBtn && productForm) {
            saveAndAddAnotherBtn.addEventListener("click", () => {
                keepModalOpenForAnother = true;
                if (typeof productForm.requestSubmit === "function") {
                    productForm.requestSubmit();
                } else {
                    productForm.dispatchEvent(new Event("submit", { cancelable: true }));
                }
            });
        }

        const headerSaveProductBtn = document.getElementById("headerSaveProductBtn");
        if (headerSaveProductBtn && productForm) {
            headerSaveProductBtn.addEventListener("click", (e) => {
                e.preventDefault();
                keepModalOpenForAnother = false;
                if (typeof productForm.requestSubmit === "function") {
                    productForm.requestSubmit();
                } else {
                    productForm.dispatchEvent(new Event("submit", { cancelable: true }));
                }
            });
        }

        /* Photo Upload & Camera Capture Listeners */
        const btnUploadPhoto = document.getElementById("btnUploadPhoto");
        const btnCaptureCamera = document.getElementById("btnCaptureCamera");
        const productImageFileInput = document.getElementById("productImageFileInput");
        const productCameraFileInput = document.getElementById("productCameraFileInput");
        const btnRemovePhoto = document.getElementById("btnRemovePhoto");

        if (btnUploadPhoto && productImageFileInput) {
            btnUploadPhoto.addEventListener("click", () => productImageFileInput.click());
        }
        if (btnCaptureCamera && productCameraFileInput) {
            btnCaptureCamera.addEventListener("click", () => productCameraFileInput.click());
        }
        if (productImageFileInput) {
            productImageFileInput.addEventListener("change", handlePhotoFileInput);
        }
        if (productCameraFileInput) {
            productCameraFileInput.addEventListener("change", handlePhotoFileInput);
        }
        if (btnRemovePhoto) {
            btnRemovePhoto.addEventListener("click", resetProductPhotoUpload);
        }

        /* SKU Regeneration & Live Generation Listeners */
        const btnRegenerateSku = document.getElementById("btnRegenerateSku");
        if (btnRegenerateSku) {
            btnRegenerateSku.addEventListener("click", () => {
                const brandVal = document.getElementById("modalBrand")?.value || "";
                const sizeVal = document.getElementById("modalSize")?.value || "";
                const typeVal = document.getElementById("modalType")?.value || "";
                const skuInput = document.getElementById("modalSku");
                if (skuInput) {
                    skuInput.value = generateSku(brandVal, sizeVal, typeVal);
                    showToast(`Generated new SKU: ${skuInput.value}`, "info");
                }
            });
        }

        const modalBrandInput = document.getElementById("modalBrand");
        const modalSizeInput = document.getElementById("modalSize");
        const modalTypeInput = document.getElementById("modalType");
        [modalBrandInput, modalSizeInput, modalTypeInput].forEach((inputEl) => {
            if (inputEl) {
                inputEl.addEventListener("input", () => {
                    const idVal = document.getElementById("modalProductId")?.value;
                    const skuInput = document.getElementById("modalSku");
                    if (!idVal && skuInput) {
                        skuInput.value = generateSku(modalBrandInput.value, modalSizeInput.value, modalTypeInput.value);
                    }
                });
            }
        });

        /* Custom Delete Confirmation Modal Listeners */
        const closeDeleteModalBtn = document.getElementById("closeDeleteModalBtn");
        const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");
        const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
        if (closeDeleteModalBtn) closeDeleteModalBtn.addEventListener("click", closeDeleteModal);
        if (cancelDeleteBtn) cancelDeleteBtn.addEventListener("click", closeDeleteModal);
        if (confirmDeleteBtn) confirmDeleteBtn.addEventListener("click", executeDeleteProduct);

        /* Blue Badge Verification Modal Listeners */
        const btnRequestVerification = document.getElementById("btnRequestVerification");
        const closeVerificationModalBtn = document.getElementById("closeVerificationModalBtn");
        const cancelVerificationBtn = document.getElementById("cancelVerificationBtn");
        const verificationForm = document.getElementById("verificationForm");

        if (btnRequestVerification) btnRequestVerification.addEventListener("click", openVerificationModal);
        if (closeVerificationModalBtn) closeVerificationModalBtn.addEventListener("click", closeVerificationModal);
        if (cancelVerificationBtn) cancelVerificationBtn.addEventListener("click", closeVerificationModal);
        if (verificationForm) verificationForm.addEventListener("submit", handleVerificationSubmit);

        const closeQuickAdjustBtn = document.getElementById("closeQuickAdjustBtn");
        const cancelQuickAdjustBtn = document.getElementById("cancelQuickAdjustBtn");
        if (closeQuickAdjustBtn) closeQuickAdjustBtn.addEventListener("click", closeQuickAdjustModal);
        if (cancelQuickAdjustBtn) cancelQuickAdjustBtn.addEventListener("click", closeQuickAdjustModal);

        const quickAdjustForm = document.getElementById("quickAdjustForm");
        if (quickAdjustForm) {
            quickAdjustForm.addEventListener("submit", handleQuickAdjustSubmit);
        }

        const notifBtn = document.getElementById("dealerNotificationButton");
        const notifPopover = document.getElementById("notificationPopover");
        if (notifBtn && notifPopover) {
            notifBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const isHidden = notifPopover.hidden;
                notifPopover.hidden = !isHidden;
                notifBtn.setAttribute("aria-expanded", String(!isHidden));
            });

            document.addEventListener("click", (e) => {
                if (!notifPopover.contains(e.target) && !notifBtn.contains(e.target)) {
                    notifPopover.hidden = true;
                    notifBtn.setAttribute("aria-expanded", "false");
                }
            });
        }

        const bannerFilterBtn = document.getElementById("bannerFilterBtn");
        if (bannerFilterBtn) {
            bannerFilterBtn.addEventListener("click", () => {
                if (statusFilter) statusFilter.value = "low-stock";
                state.selectedStockStatus = "low-stock";
                state.currentPage = 1;
                applyFilters();
                window.scrollTo({ top: 380, behavior: "smooth" });
            });
        }

        const dismissBannerBtn = document.getElementById("dismissBannerBtn");
        if (dismissBannerBtn) {
            dismissBannerBtn.addEventListener("click", () => {
                const banner = document.getElementById("lowStockBanner");
                if (banner) banner.hidden = true;
            });
        }

        const filterLowStockFromNotif = document.getElementById("filterLowStockFromNotif");
        if (filterLowStockFromNotif) {
            filterLowStockFromNotif.addEventListener("click", () => {
                if (notifPopover) notifPopover.hidden = true;
                if (statusFilter) statusFilter.value = "low-stock";
                state.selectedStockStatus = "low-stock";
                state.currentPage = 1;
                applyFilters();
                window.scrollTo({ top: 380, behavior: "smooth" });
            });
        }

        const enablePushNotifsBtn = document.getElementById("enablePushNotifsBtn");
        if (enablePushNotifsBtn) {
            enablePushNotifsBtn.addEventListener("click", requestBrowserNotificationPermission);
        }

        const exportCsvBtn = document.getElementById("exportCsvBtn");
        if (exportCsvBtn) {
            exportCsvBtn.addEventListener("click", exportInventoryCsv);
        }

        const printAuditBtn = document.getElementById("printAuditBtn");
        if (printAuditBtn) {
            printAuditBtn.addEventListener("click", printStockAuditSheet);
        }

        const prevPageBtn = document.getElementById("prevPageBtn");
        const nextPageBtn = document.getElementById("nextPageBtn");
        if (prevPageBtn) {
            prevPageBtn.addEventListener("click", () => {
                if (state.currentPage > 1) {
                    state.currentPage--;
                    render();
                }
            });
        }
        if (nextPageBtn) {
            nextPageBtn.addEventListener("click", () => {
                const totalPages = getTotalPages();
                if (state.currentPage < totalPages) {
                    state.currentPage++;
                    render();
                }
            });
        }
    }

    function setupSidebarMobile() {
        const toggleBtn = document.getElementById("dealerMobileMenu");
        const closeBtn = document.getElementById("sidebarCloseBtn");
        const sidebar = document.getElementById("dealerSidebar");
        const overlay = document.getElementById("dealerSidebarOverlay");

        function openSidebar() {
            if (sidebar) sidebar.classList.add("open");
            if (overlay) overlay.classList.add("visible");
            if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "true");
        }

        function closeSidebar() {
            if (sidebar) sidebar.classList.remove("open");
            if (overlay) overlay.classList.remove("visible");
            if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
        }

        if (toggleBtn) toggleBtn.addEventListener("click", openSidebar);
        if (closeBtn) closeBtn.addEventListener("click", closeSidebar);
        if (overlay) overlay.addEventListener("click", closeSidebar);
    }

    /* =========================================================
       FILTER & SEARCH LOGIC
       ========================================================= */
    function applyFilters() {
        let list = [...state.products];

        if (state.searchQuery) {
            const q = state.searchQuery;
            list = list.filter((p) => {
                const text = [
                    p.name,
                    p.brand,
                    p.sku,
                    p.size,
                    p.type,
                    p.location,
                    p.description
                ]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase();
                return text.includes(q);
            });
        }

        if (state.selectedBrand) {
            list = list.filter((p) => p.brand.toLowerCase() === state.selectedBrand.toLowerCase());
        }

        if (state.selectedType) {
            list = list.filter((p) => p.type.toLowerCase() === state.selectedType.toLowerCase());
        }

        if (state.selectedSize) {
            list = list.filter((p) => p.size.toLowerCase() === state.selectedSize.toLowerCase());
        }

        if (state.selectedStockStatus) {
            if (state.selectedStockStatus === "in-stock") {
                list = list.filter((p) => p.stock > p.lowStockLimit);
            } else if (state.selectedStockStatus === "low-stock") {
                list = list.filter((p) => p.stock > 0 && p.stock <= p.lowStockLimit);
            } else if (state.selectedStockStatus === "out-of-stock") {
                list = list.filter((p) => p.stock <= 0);
            }
        }

        state.filteredProducts = list;
        render();
    }

    function resetAllFilters() {
        state.searchQuery = "";
        state.selectedBrand = "";
        state.selectedType = "";
        state.selectedSize = "";
        state.selectedStockStatus = "";
        state.currentPage = 1;

        const s1 = document.getElementById("productSearch");
        const s2 = document.getElementById("globalStockSearch");
        const clearBtn = document.getElementById("clearProductSearch");
        const b = document.getElementById("brandFilter");
        const t = document.getElementById("productTypeFilter");
        const sz = document.getElementById("sizeFilter");
        const st = document.getElementById("stockStatusFilter");

        if (s1) s1.value = "";
        if (s2) s2.value = "";
        if (clearBtn) clearBtn.hidden = true;
        if (b) b.value = "";
        if (t) t.value = "";
        if (sz) sz.value = "";
        if (st) st.value = "";

        applyFilters();
        showToast("All filters have been reset.", "info");
    }

    function populateBrandFilterOptions() {
        const select = document.getElementById("brandFilter");
        const datalist = document.getElementById("brandDatalist");
        if (!select) return;

        const brands = Array.from(new Set(state.products.map((p) => p.brand.trim()).filter(Boolean))).sort();
        const current = select.value;
        select.innerHTML = '<option value="">All Brands</option>';

        brands.forEach((brand) => {
            const opt = document.createElement("option");
            opt.value = brand;
            opt.textContent = brand;
            select.appendChild(opt);
        });

        select.value = current;

        // Also update brand datalist so all added brands are suggested
        if (datalist) {
            const existingDatalist = Array.from(datalist.options).map(o => o.value);
            brands.forEach((brand) => {
                if (!existingDatalist.includes(brand)) {
                    const opt = document.createElement("option");
                    opt.value = brand;
                    datalist.appendChild(opt);
                }
            });
        }
    }

    function setViewMode(mode) {
        state.viewMode = mode;
        const tableView = document.getElementById("stockTableView");
        const cardView = document.getElementById("stockCardView");
        const btnTable = document.getElementById("viewTableBtn");
        const btnGrid = document.getElementById("viewGridBtn");

        if (mode === "grid") {
            if (tableView) tableView.hidden = true;
            if (cardView) cardView.hidden = false;
            if (btnTable) btnTable.classList.remove("active");
            if (btnGrid) btnGrid.classList.add("active");
        } else {
            if (tableView) tableView.hidden = false;
            if (cardView) cardView.hidden = true;
            if (btnTable) btnTable.classList.add("active");
            if (btnGrid) btnGrid.classList.remove("active");
        }
    }

    /* =========================================================
       LOW STOCK NOTIFICATION SYSTEM & AUDIO ALERT
       ========================================================= */
    function checkAndTriggerLowStockAlerts() {
        const lowStockItems = state.products.filter((p) => p.stock <= p.lowStockLimit);
        const outOfStockItems = state.products.filter((p) => p.stock <= 0);

        const totalAlerts = lowStockItems.length;

        const headerBadge = document.getElementById("notificationBadge");
        const sidebarBadge = document.getElementById("sidebarLowStockBadge");
        const mobileDot = document.getElementById("mobileStockAlertDot");

        if (headerBadge) {
            headerBadge.textContent = String(totalAlerts);
            headerBadge.hidden = totalAlerts === 0;
        }

        if (sidebarBadge) {
            sidebarBadge.textContent = String(totalAlerts);
            sidebarBadge.hidden = totalAlerts === 0;
        }

        if (mobileDot) {
            mobileDot.hidden = totalAlerts === 0;
        }

        const banner = document.getElementById("lowStockBanner");
        const bannerLowCount = document.getElementById("bannerLowCount");
        const bannerTitle = document.getElementById("lowStockBannerTitle");
        const bannerMsg = document.getElementById("lowStockBannerMessage");

        if (totalAlerts > 0) {
            if (banner) banner.hidden = false;
            if (bannerLowCount) bannerLowCount.textContent = String(totalAlerts);

            if (outOfStockItems.length > 0) {
                if (bannerTitle) bannerTitle.textContent = `CRITICAL: ${outOfStockItems.length} Products Depleted & ${lowStockItems.length - outOfStockItems.length} Low!`;
                if (bannerMsg) bannerMsg.textContent = "Immediate distributor reorder required to prevent lost customer sales.";
            } else {
                if (bannerTitle) bannerTitle.textContent = `Warning: ${totalAlerts} Gas Cylinder Items Below Reorder Level`;
                if (bannerMsg) bannerMsg.textContent = "Current quantities have fallen at or below your safety threshold.";
            }
        } else {
            if (banner) banner.hidden = true;
        }

        renderNotificationPopover(lowStockItems);

        if (totalAlerts > 0 && "Notification" in window && Notification.permission === "granted") {
            try {
                const sampleName = lowStockItems[0].name;
                const notification = new Notification("GasHub Stock Alert!", {
                    body: `${sampleName} and ${totalAlerts - 1} other item(s) are critically low!`,
                    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23d97706'%3E%3Cpath d='M12 23c-4.97 0-9-4.03-9-9 0-4.06 2.76-7.48 6.57-8.54C9.28 6.46 9 7.69 9 9c0 2.22 1.25 4.15 3.09 5.12-.06-.36-.09-.73-.09-1.12 0-3.1 2.3-5.65 5.3-5.96-.3 6.94 4.7 6.46 4.7 6.96 0 4.97-4.03 9-9 9z'/%3E%3C/svg%3E"
                });
                notification.onclick = () => {
                    window.focus();
                };
            } catch (err) {}
        }
    }

    function renderNotificationPopover(lowItems) {
        const list = document.getElementById("notificationList");
        if (!list) return;

        if (lowItems.length === 0) {
            list.innerHTML = `
                <div class="popover-empty">
                    <i class="fa-solid fa-circle-check text-success"></i>
                    <span>All stock levels are optimal. No reorders needed!</span>
                </div>
            `;
            return;
        }

        list.innerHTML = "";
        lowItems.forEach((item) => {
            const isOut = item.stock <= 0;
            const itemEl = document.createElement("div");
            itemEl.className = `notification-item ${isOut ? "critical" : ""}`;
            itemEl.innerHTML = `
                <div class="notification-item-icon">
                    <i class="fa-solid ${isOut ? "fa-circle-xmark" : "fa-triangle-exclamation"}"></i>
                </div>
                <div class="notification-item-content">
                    <strong class="notification-item-title">${escapeHtml(item.name)}</strong>
                    <div class="notification-item-text">
                        <span>Current Stock: <strong>${item.stock}</strong> (Min: ${item.lowStockLimit})</span>
                    </div>
                </div>
                <button type="button" class="btn btn-warning-dark btn-xs" data-quick-restock-id="${item.id}" title="Quick Restock">
                    <i class="fa-solid fa-plus fa-xs"></i>
                </button>
            `;

            const quickRestockBtn = itemEl.querySelector("[data-quick-restock-id]");
            if (quickRestockBtn) {
                quickRestockBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const pop = document.getElementById("notificationPopover");
                    if (pop) pop.hidden = true;
                    openQuickAdjustModal(item.id, "restock");
                });
            }

            list.appendChild(itemEl);
        });
    }

    function requestBrowserNotificationPermission() {
        if (!("Notification" in window)) {
            showToast("Your browser does not support desktop notifications.", "warning");
            return;
        }

        Notification.requestPermission().then((permission) => {
            if (permission === "granted") {
                showToast("Low stock browser notifications enabled!", "success");
                playAlertChime();
            } else {
                showToast("Notification permission was denied.", "warning");
            }
        });
    }

    function playAlertChime() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = "sine";
            osc.frequency.setValueAtTime(587.33, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);

            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start();
            osc.stop(ctx.currentTime + 0.35);
        } catch (e) {}
    }

    /* =========================================================
       RENDER ENGINE
       ========================================================= */
    function render() {
        updateInventoryMetrics();
        renderTable();
        renderCards();
        updatePagination();
    }

    function updateInventoryMetrics() {
        const totalSkus = state.products.length;
        const totalFullUnits = state.products.reduce((acc, p) => acc + (Number(p.stock) || 0), 0);
        const totalEmptyUnits = state.products.reduce((acc, p) => acc + (Number(p.emptyStock) || 0), 0);
        const lowStockCount = state.products.filter((p) => p.stock <= p.lowStockLimit).length;
        const totalValuation = state.products.reduce((acc, p) => acc + ((Number(p.costPrice) || 0) * (Number(p.stock) || 0)), 0);

        setElementText("statTotalSkus", formatNumber(totalSkus));
        setElementText("statFullUnits", formatNumber(totalFullUnits));
        setElementText("statEmptyUnits", formatNumber(totalEmptyUnits));
        setElementText("statLowStock", formatNumber(lowStockCount));
        setElementText("statStockValuation", `KSh ${formatCurrency(totalValuation)}`);

        const lowStatCard = document.getElementById("lowStockStatCard");
        if (lowStatCard) {
            if (lowStockCount > 0) {
                lowStatCard.classList.add("alert-card");
            } else {
                lowStatCard.classList.remove("alert-card");
            }
        }
    }

    function renderTable() {
        const tbody = document.getElementById("productsTableBody");
        const emptyState = document.getElementById("stockEmptyState");
        const tableView = document.getElementById("stockTableView");
        if (!tbody) return;

        const items = getPaginatedItems();

        if (items.length === 0) {
            tbody.innerHTML = "";
            if (emptyState) emptyState.hidden = false;
            if (tableView) tableView.hidden = true;
            return;
        }

        if (emptyState) emptyState.hidden = true;
        if (tableView && state.viewMode === "table") tableView.hidden = false;

        tbody.innerHTML = "";

        items.forEach((p) => {
            const row = document.createElement("tr");

            const isLow = p.stock > 0 && p.stock <= p.lowStockLimit;
            const isOut = p.stock <= 0;
            if (isOut) row.className = "row-out-of-stock";
            else if (isLow) row.className = "row-low-stock";

            const statusBadge = getStockStatusBadgeHtml(p);

            row.innerHTML = `
                <td>
                    <div class="table-product-cell">
                        <div class="table-product-avatar ${p.image ? "has-image" : ""}">
                            ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" class="table-product-thumb">` : `<i class="fa-solid ${getProductIconClass(p.type)}"></i>`}
                        </div>
                        <div class="table-product-meta">
                            <span class="table-brand-tag">${escapeHtml(p.brand)}</span>
                            <strong class="table-product-title">${escapeHtml(p.name)}</strong>
                            <span class="table-product-sku">SKU: ${escapeHtml(p.sku || "N/A")} | ${escapeHtml(p.location || "General Yard")}</span>
                        </div>
                    </div>
                </td>

                <td>
                    <span class="badge-category">
                        <i class="fa-solid fa-tag fa-xs"></i>
                        ${escapeHtml(capitalize(p.type))}
                    </span>
                </td>

                <td>
                    <span class="badge-size-weight">${escapeHtml(p.size)}</span>
                    <span class="badge-valve-spec">${escapeHtml(p.valve || "Standard")}</span>
                </td>

                <td>
                    <div class="stock-stepper">
                        <button type="button" class="stock-stepper-btn" data-step-dec="${p.id}" title="Sell/Dispatch (-1)" ${p.stock <= 0 ? "disabled" : ""}>
                            <i class="fa-solid fa-minus fa-xs"></i>
                        </button>
                        <span class="stock-stepper-value ${isOut ? "out" : isLow ? "low" : ""}">${formatNumber(p.stock)}</span>
                        <button type="button" class="stock-stepper-btn" data-step-inc="${p.id}" title="Restock (+1)">
                            <i class="fa-solid fa-plus fa-xs"></i>
                        </button>
                    </div>
                </td>

                <td>
                    <span class="empty-cylinder-count">
                        <i class="fa-solid fa-arrow-rotate-left fa-xs"></i>
                        ${formatNumber(p.emptyStock || 0)}
                    </span>
                </td>

                <td>
                    <span class="badge-category" title="Alert trigger point">
                        <i class="fa-solid fa-bell fa-xs text-warning"></i>
                        ≤ ${formatNumber(p.lowStockLimit)}
                    </span>
                </td>

                <td>
                    <span class="price-retail">KSh ${formatCurrency(p.price)}</span>
                    <span class="price-wholesale">Cost: KSh ${formatCurrency(p.costPrice || 0)}</span>
                </td>

                <td>
                    ${statusBadge}
                </td>

                <td>
                    <div class="table-actions">
                        <button type="button" class="action-btn-sm restock" data-action-adjust="${p.id}" title="Adjust Stock / Quick Restock">
                            <i class="fa-solid fa-boxes-stacked fa-xs"></i>
                        </button>
                        <button type="button" class="action-btn-sm" data-action-edit="${p.id}" title="Edit Product Details">
                            <i class="fa-solid fa-pen-to-square fa-xs"></i>
                        </button>
                        <button type="button" class="action-btn-sm delete" data-action-delete="${p.id}" title="Delete Product">
                            <i class="fa-solid fa-trash fa-xs"></i>
                        </button>
                    </div>
                </td>
            `;

            const decBtn = row.querySelector(`[data-step-dec="${p.id}"]`);
            const incBtn = row.querySelector(`[data-step-inc="${p.id}"]`);
            if (decBtn) decBtn.addEventListener("click", () => quickStepStock(p.id, -1));
            if (incBtn) incBtn.addEventListener("click", () => quickStepStock(p.id, 1));

            const adjustBtn = row.querySelector(`[data-action-adjust="${p.id}"]`);
            const editBtn = row.querySelector(`[data-action-edit="${p.id}"]`);
            const deleteBtn = row.querySelector(`[data-action-delete="${p.id}"]`);

            if (adjustBtn) adjustBtn.addEventListener("click", () => openQuickAdjustModal(p.id));
            if (editBtn) editBtn.addEventListener("click", () => openProductModal(p.id));
            if (deleteBtn) deleteBtn.addEventListener("click", () => openDeleteModal(p.id));

            tbody.appendChild(row);
        });
    }

    function renderCards() {
        const cardContainer = document.getElementById("stockCardView");
        if (!cardContainer) return;

        const items = getPaginatedItems();
        cardContainer.innerHTML = "";

        items.forEach((p) => {
            const isLow = p.stock > 0 && p.stock <= p.lowStockLimit;
            const isOut = p.stock <= 0;

            const card = document.createElement("div");
            card.className = `stock-card ${isOut ? "is-out" : isLow ? "is-low" : ""}`;

            card.innerHTML = `
                <div class="stock-card-header">
                    <div style="display: flex; gap: 12px; align-items: flex-start; flex: 1; min-width: 0;">
                        <div class="table-product-avatar ${p.image ? "has-image" : ""}" style="width: 44px; height: 44px; min-width: 44px; border-radius: 8px;">
                            ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" class="table-product-thumb">` : `<i class="fa-solid ${getProductIconClass(p.type)}"></i>`}
                        </div>
                        <div style="flex: 1; min-width: 0;">
                            <div class="stock-card-brand-row">
                                <span class="table-brand-tag">${escapeHtml(p.brand)}</span>
                                <span class="badge-category"><i class="fa-solid fa-tag fa-xs"></i> ${escapeHtml(capitalize(p.type))}</span>
                            </div>
                            <h3 class="stock-card-title">${escapeHtml(p.name)}</h3>
                            <div class="stock-card-spec-row">
                                <span><i class="fa-solid fa-weight-hanging fa-xs"></i> ${escapeHtml(p.size)}</span>
                                <span>•</span>
                                <span>${escapeHtml(p.valve || "Standard")}</span>
                                <span>•</span>
                                <span>SKU: ${escapeHtml(p.sku || "N/A")}</span>
                            </div>
                        </div>
                    </div>
                    <div>
                        ${getStockStatusBadgeHtml(p)}
                    </div>
                </div>

                <div class="stock-card-inventory-strip">
                    <div>
                        <span class="inventory-strip-label">Full Stock</span>
                        <div style="font-size: 16px; font-weight: 800; color: ${isOut ? "#ef4444" : isLow ? "#d97706" : "#0f172a"};">
                            ${formatNumber(p.stock)} units
                        </div>
                    </div>

                    <div class="inventory-strip-controls">
                        <button type="button" class="btn-card-step" data-mobile-dec="${p.id}" ${p.stock <= 0 ? "disabled" : ""} title="Sell 1 unit">
                            <i class="fa-solid fa-minus fa-xs"></i>
                        </button>
                        <button type="button" class="btn-card-step" data-mobile-inc="${p.id}" title="Restock 1 unit">
                            <i class="fa-solid fa-plus fa-xs"></i>
                        </button>
                    </div>
                </div>

                <div class="stock-card-footer">
                    <div class="stock-card-price-info">
                        <strong>KSh ${formatCurrency(p.price)}</strong>
                        <span>Empties: ${formatNumber(p.emptyStock || 0)} | Alert: ≤${p.lowStockLimit}</span>
                    </div>

                    <div class="stock-card-actions">
                        <button type="button" class="btn-mobile-action" data-card-adjust="${p.id}" title="Stock Adjustment">
                            <i class="fa-solid fa-boxes-stacked fa-xs"></i>
                        </button>
                        <button type="button" class="btn-mobile-action" data-card-edit="${p.id}" title="Edit">
                            <i class="fa-solid fa-pen-to-square fa-xs"></i>
                        </button>
                        <button type="button" class="btn-mobile-action" data-card-del="${p.id}" title="Delete">
                            <i class="fa-solid fa-trash fa-xs"></i>
                        </button>
                    </div>
                </div>
            `;

            const decBtn = card.querySelector(`[data-mobile-dec="${p.id}"]`);
            const incBtn = card.querySelector(`[data-mobile-inc="${p.id}"]`);
            if (decBtn) decBtn.addEventListener("click", () => quickStepStock(p.id, -1));
            if (incBtn) incBtn.addEventListener("click", () => quickStepStock(p.id, 1));

            const adjustBtn = card.querySelector(`[data-card-adjust="${p.id}"]`);
            const editBtn = card.querySelector(`[data-card-edit="${p.id}"]`);
            const delBtn = card.querySelector(`[data-card-del="${p.id}"]`);

            if (adjustBtn) adjustBtn.addEventListener("click", () => openQuickAdjustModal(p.id));
            if (editBtn) editBtn.addEventListener("click", () => openProductModal(p.id));
            if (delBtn) delBtn.addEventListener("click", () => openDeleteModal(p.id));

            cardContainer.appendChild(card);
        });
    }

    function getStockStatusBadgeHtml(p) {
        if (p.stock <= 0) {
            return `
                <span class="stock-status-badge out-of-stock">
                    <span class="status-dot-sm"></span>
                    Out of Stock
                </span>
            `;
        }
        if (p.stock <= p.lowStockLimit) {
            return `
                <span class="stock-status-badge low-stock">
                    <span class="status-dot-sm"></span>
                    Low Stock (${p.stock})
                </span>
            `;
        }
        return `
            <span class="stock-status-badge in-stock">
                <span class="status-dot-sm"></span>
                In Stock (${p.stock})
            </span>
        `;
    }

    function getProductIconClass(type) {
        switch (type) {
            case "refill":
                return "fa-arrow-rotate-right";
            case "accessory":
                return "fa-wrench";
            case "industrial":
                return "fa-industry";
            case "empty":
                return "fa-box-open";
            default:
                return "fa-gas-pump";
        }
    }

    /* =========================================================
       STOCK STEPPERS & ADJUSTMENTS
       ========================================================= */
    function quickStepStock(productId, delta) {
        const product = state.products.find((p) => p.id === productId);
        if (!product) return;

        const oldStock = product.stock;
        const newStock = Math.max(0, oldStock + delta);

        if (delta < 0 && oldStock > 0 && product.type === "refill") {
            product.emptyStock = (product.emptyStock || 0) + 1;
        }

        product.stock = newStock;
        saveStoredData();
        checkAndTriggerLowStockAlerts();
        applyFilters();

        if (delta > 0) {
            showToast(`+1 Added to ${product.name} (Now: ${newStock})`, "success");
        } else {
            showToast(`-1 Dispatched from ${product.name} (Now: ${newStock})`, "info");
        }
    }

    /* =========================================================
       PHOTO UPLOAD & CAMERA CAPTURE HANDLERS
       ========================================================= */
    function handlePhotoFileInput(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            showToast("Please select a valid image file (JPG, PNG, WebP).", "error");
            return;
        }

        const compress = window.GasHubCore && window.GasHubCore.readImageCompressed
            ? window.GasHubCore.readImageCompressed(file)
            : new Promise((resolve) => {
                const r = new FileReader();
                r.onload = (ev) => resolve(ev.target.result);
                r.readAsDataURL(file);
            });

        compress.then((dataUrl) => {
            const photoPreview = document.getElementById("productPhotoPreview");
            const photoPlaceholder = document.getElementById("photoPlaceholder");
            const btnRemovePhoto = document.getElementById("btnRemovePhoto");
            const modalProductImage = document.getElementById("modalProductImage");

            if (photoPreview) {
                photoPreview.src = dataUrl;
                photoPreview.hidden = false;
            }
            if (photoPlaceholder) photoPlaceholder.hidden = true;
            if (btnRemovePhoto) btnRemovePhoto.hidden = false;
            if (modalProductImage) modalProductImage.value = dataUrl;

            showToast("Product photo loaded successfully!", "success");
        });
    }

    function resetProductPhotoUpload() {
        const photoPreview = document.getElementById("productPhotoPreview");
        const photoPlaceholder = document.getElementById("photoPlaceholder");
        const btnRemovePhoto = document.getElementById("btnRemovePhoto");
        const modalProductImage = document.getElementById("modalProductImage");
        const fileInput = document.getElementById("productImageFileInput");
        const camInput = document.getElementById("productCameraFileInput");

        if (photoPreview) {
            photoPreview.src = "";
            photoPreview.hidden = true;
        }
        if (photoPlaceholder) photoPlaceholder.hidden = false;
        if (btnRemovePhoto) btnRemovePhoto.hidden = true;
        if (modalProductImage) modalProductImage.value = "";
        if (fileInput) fileInput.value = "";
        if (camInput) camInput.value = "";
    }

    /* =========================================================
       AUTO SKU GENERATOR
       ========================================================= */
    function generateSku(brand = "", size = "", type = "") {
        const brandClean = (brand || "GAS").replace(/[^a-zA-Z0-9]/g, "").substring(0, 3).toUpperCase() || "GAS";
        const sizeClean = (size || "13K").replace(/[^a-zA-Z0-9]/g, "").toUpperCase() || "13K";
        const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
        return `GH-${brandClean}-${sizeClean}-${rand}`;
    }

    /* =========================================================
       ADD / EDIT PRODUCT MODAL
       ========================================================= */
    function openProductModal(productId = null) {
        const backdrop = document.getElementById("productModalBackdrop");
        const titleEl = document.getElementById("modalTitle");
        const saveBtnText = document.getElementById("saveBtnText");
        const form = document.getElementById("productForm");

        if (!backdrop || !form) return;
        form.reset();
        resetProductPhotoUpload();

        const idInput = document.getElementById("modalProductId");
        const brandInput = document.getElementById("modalBrand");
        const nameInput = document.getElementById("modalName");
        const typeInput = document.getElementById("modalType");
        const sizeInput = document.getElementById("modalSize");
        const valveInput = document.getElementById("modalValve");
        const stockInput = document.getElementById("modalStock");
        const emptyInput = document.getElementById("modalEmptyStock");
        const limitInput = document.getElementById("modalLowStockLimit");
        const costInput = document.getElementById("modalCostPrice");
        const priceInput = document.getElementById("modalSellingPrice");
        const skuInput = document.getElementById("modalSku");
        const locInput = document.getElementById("modalLocation");
        const availInput = document.getElementById("modalAvailable");
        const descInput = document.getElementById("modalDescription");
        const photoPreview = document.getElementById("productPhotoPreview");
        const photoPlaceholder = document.getElementById("photoPlaceholder");
        const btnRemovePhoto = document.getElementById("btnRemovePhoto");
        const modalProductImage = document.getElementById("modalProductImage");

        if (skuInput) skuInput.readOnly = true;

        if (productId) {
            const item = state.products.find((p) => p.id === productId);
            if (!item) return;

            titleEl.textContent = "Edit Product Details";
            saveBtnText.textContent = "Save Changes";

            idInput.value = item.id;
            brandInput.value = item.brand;
            nameInput.value = item.name;
            typeInput.value = item.type;
            sizeInput.value = item.size;
            valveInput.value = item.valve || "20mm Clip-On";
            stockInput.value = item.stock;
            emptyInput.value = item.emptyStock || 0;
            limitInput.value = item.lowStockLimit || 5;
            costInput.value = item.costPrice || "";
            priceInput.value = item.price || "";
            skuInput.value = item.sku || generateSku(item.brand, item.size, item.type);
            locInput.value = item.location || "";
            availInput.value = String(item.available !== false);
            descInput.value = item.description || "";

            if (item.image) {
                if (modalProductImage) modalProductImage.value = item.image;
                if (photoPreview) {
                    photoPreview.src = item.image;
                    photoPreview.hidden = false;
                }
                if (photoPlaceholder) photoPlaceholder.hidden = true;
                if (btnRemovePhoto) btnRemovePhoto.hidden = false;
            }
        } else {
            titleEl.textContent = "Add New Inventory Item";
            saveBtnText.textContent = "Save Product";
            idInput.value = "";
            limitInput.value = "5";
            stockInput.value = "0";
            emptyInput.value = "0";
            if (skuInput) {
                skuInput.value = generateSku(brandInput ? brandInput.value : "", sizeInput ? sizeInput.value : "", typeInput ? typeInput.value : "");
            }
        }

        backdrop.hidden = false;
        if (brandInput) brandInput.focus();
    }

    function closeProductModal() {
        const backdrop = document.getElementById("productModalBackdrop");
        if (backdrop) backdrop.hidden = true;
    }

    function handleProductFormSubmit(e, keepOpen = false) {
        e.preventDefault();

        const idInput = document.getElementById("modalProductId");
        const brandInput = document.getElementById("modalBrand");
        const nameInput = document.getElementById("modalName");
        const typeInput = document.getElementById("modalType");
        const sizeInput = document.getElementById("modalSize");
        const valveInput = document.getElementById("modalValve");
        const stockInput = document.getElementById("modalStock");
        const emptyInput = document.getElementById("modalEmptyStock");
        const limitInput = document.getElementById("modalLowStockLimit");
        const costInput = document.getElementById("modalCostPrice");
        const priceInput = document.getElementById("modalSellingPrice");
        const skuInput = document.getElementById("modalSku");
        const locInput = document.getElementById("modalLocation");
        const availInput = document.getElementById("modalAvailable");
        const descInput = document.getElementById("modalDescription");
        const modalProductImage = document.getElementById("modalProductImage");

        const brand = brandInput.value.trim();
        const name = nameInput.value.trim();
        const price = Number(priceInput.value);

        if (!brand || !name || isNaN(price) || price <= 0) {
            showToast("Please fill in a valid brand, product name, and selling price.", "error");
            return;
        }

        const id = idInput.value || `PRD-${Date.now().toString(36).toUpperCase()}`;

        const productData = {
            id,
            brand,
            name,
            type: typeInput.value,
            size: sizeInput.value.trim() || "13kg",
            valve: valveInput.value,
            stock: Math.max(0, parseInt(stockInput.value, 10) || 0),
            emptyStock: Math.max(0, parseInt(emptyInput.value, 10) || 0),
            lowStockLimit: Math.max(1, parseInt(limitInput.value, 10) || 5),
            costPrice: Math.max(0, parseFloat(costInput.value) || 0),
            price,
            sku: skuInput.value.trim() || generateSku(brand, sizeInput.value, typeInput.value),
            location: locInput.value.trim() || "Main Yard",
            available: availInput.value === "true",
            description: descInput.value.trim(),
            image: (modalProductImage && modalProductImage.value) ? modalProductImage.value : ""
        };

        const existingIndex = state.products.findIndex((p) => p.id === id);
        if (existingIndex > -1) {
            if (!productData.image && state.products[existingIndex].image) {
                productData.image = state.products[existingIndex].image;
            }
            state.products[existingIndex] = productData;
            showToast(`Product "${productData.name}" updated successfully!`, "success");
        } else {
            state.products.unshift(productData);
            showToast(`Item "${productData.name}" saved to stock!`, "success");
        }

        saveStoredData();
        populateBrandFilterOptions();
        checkAndTriggerLowStockAlerts();
        applyFilters();

        if (keepOpen) {
            // Reset for next item
            if (idInput) idInput.value = "";
            if (nameInput) {
                nameInput.value = "";
                nameInput.focus();
            }
            if (stockInput) stockInput.value = "10";
            if (skuInput) skuInput.value = generateSku(brand, sizeInput.value, typeInput.value);
            resetProductPhotoUpload();
            showToast("Saved! Enter details for your next product.", "info");
        } else {
            closeProductModal();
        }
    }

    /* =========================================================
       CUSTOM DELETE CONFIRMATION MODAL (NO WINDOW POPUP)
       ========================================================= */
    function openDeleteModal(productId) {
        const item = state.products.find((p) => p.id === productId);
        if (!item) return;

        pendingDeleteProductId = productId;
        const modal = document.getElementById("deleteConfirmModalBackdrop");
        const nameEl = document.getElementById("deleteProductName");
        const metaEl = document.getElementById("deleteProductMeta");

        if (nameEl) nameEl.textContent = item.name;
        if (metaEl) {
            metaEl.textContent = `${item.brand} • ${item.size} • Stock: ${item.stock} full units • SKU: ${item.sku || "N/A"}`;
        }
        if (modal) modal.hidden = false;
    }

    function closeDeleteModal() {
        pendingDeleteProductId = null;
        const modal = document.getElementById("deleteConfirmModalBackdrop");
        if (modal) modal.hidden = true;
    }

    function executeDeleteProduct() {
        if (!pendingDeleteProductId) return;
        const item = state.products.find((p) => p.id === pendingDeleteProductId);
        const itemName = item ? item.name : "Item";

        state.products = state.products.filter((p) => p.id !== pendingDeleteProductId);
        saveStoredData();
        populateBrandFilterOptions();
        checkAndTriggerLowStockAlerts();
        applyFilters();
        closeDeleteModal();
        showToast(`"${itemName}" was removed from inventory.`, "info");
    }

    function confirmDeleteProduct(productId) {
        openDeleteModal(productId);
    }

    /* =========================================================
       TIKTOK-STYLE BLUE BADGE VERIFICATION ENGINE
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

    function openVerificationModal() {
        const backdrop = document.getElementById("verificationModalBackdrop");
        if (!backdrop) return;
        const outletInput = document.getElementById("verifyOutletName");
        if (outletInput && !outletInput.value) {
            outletInput.value = "";
        }
        backdrop.hidden = false;
    }

    function closeVerificationModal() {
        const backdrop = document.getElementById("verificationModalBackdrop");
        if (backdrop) backdrop.hidden = true;
    }

    function handleVerificationSubmit(e) {
        e.preventDefault();
        const phoneInput = document.getElementById("verifyMpesaPhone");
        const phone = phoneInput ? phoneInput.value.trim() : "";
        if (!phone) {
            showToast("Please enter a valid M-Pesa phone number.", "error");
            return;
        }

        const submitBtn = document.getElementById("submitVerificationBtn");
        const originalBtnHtml = submitBtn ? submitBtn.innerHTML : "";
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin fa-sm"></i> Sending M-Pesa STK Prompt...`;
        }

        setTimeout(() => {
            localStorage.setItem("gashub_dealer_verified", "true");
            checkVerificationStatus();
            closeVerificationModal();
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnHtml;
            }
            showToast("M-Pesa payment received! TikTok-style Blue Checkmark badge is now active on your profile.", "success");
        }, 1200);
    }

    /* =========================================================
       QUICK ADJUST MODAL
       ========================================================= */
    function openQuickAdjustModal(productId, defaultOperation = "restock") {
        const item = state.products.find((p) => p.id === productId);
        if (!item) return;

        const backdrop = document.getElementById("quickAdjustModalBackdrop");
        if (!backdrop) return;

        document.getElementById("adjustProductId").value = item.id;
        document.getElementById("adjustProductName").textContent = item.name;
        document.getElementById("adjustProductMeta").textContent = `${item.brand} • ${item.size} • SKU: ${item.sku || "N/A"}`;
        document.getElementById("adjustCurrentStock").textContent = `${item.stock} Units`;
        document.getElementById("adjustCurrentEmpty").textContent = `${item.emptyStock || 0} Units`;

        const opSelect = document.getElementById("adjustOperation");
        if (opSelect) opSelect.value = defaultOperation;

        const qtyInput = document.getElementById("adjustQuantity");
        if (qtyInput) qtyInput.value = defaultOperation === "restock" ? "10" : "1";

        backdrop.hidden = false;
        if (qtyInput) qtyInput.focus();
    }

    function closeQuickAdjustModal() {
        const backdrop = document.getElementById("quickAdjustModalBackdrop");
        if (backdrop) backdrop.hidden = true;
    }

    function handleQuickAdjustSubmit(e) {
        e.preventDefault();

        const id = document.getElementById("adjustProductId").value;
        const item = state.products.find((p) => p.id === id);
        if (!item) return;

        const op = document.getElementById("adjustOperation").value;
        const qty = parseInt(document.getElementById("adjustQuantity").value, 10);

        if (isNaN(qty) || qty <= 0) {
            showToast("Please enter a valid positive quantity.", "error");
            return;
        }

        switch (op) {
            case "restock":
                item.stock += qty;
                showToast(`Restocked +${qty} units of ${item.name}`, "success");
                break;
            case "dispatch":
                if (qty > item.stock) {
                    showToast(`Cannot dispatch ${qty} units. Only ${item.stock} in stock!`, "error");
                    return;
                }
                item.stock -= qty;
                showToast(`Dispatched -${qty} units of ${item.name}`, "info");
                break;
            case "swap":
                if (qty > item.stock) {
                    showToast(`Not enough full cylinders to swap ${qty} units!`, "error");
                    return;
                }
                item.stock -= qty;
                item.emptyStock = (item.emptyStock || 0) + qty;
                showToast(`Swapped ${qty} cylinders (-Full, +Empty)`, "success");
                break;
            case "set":
                item.stock = qty;
                showToast(`Stock count set directly to ${qty} units`, "info");
                break;
            case "receive-empties":
                item.emptyStock = (item.emptyStock || 0) + qty;
                showToast(`Received +${qty} empty cylinders for ${item.name}`, "success");
                break;
            case "depot-swap":
                if (qty > (item.emptyStock || 0)) {
                    showToast(`Cannot send ${qty} empties. Only ${item.emptyStock || 0} empties in buffer!`, "error");
                    return;
                }
                item.emptyStock = Math.max(0, (item.emptyStock || 0) - qty);
                item.stock += qty;
                showToast(`Depot swap completed: Sent ${qty} empties, received ${qty} full cylinders!`, "success");
                break;
        }

        saveStoredData();
        checkAndTriggerLowStockAlerts();
        applyFilters();
        closeQuickAdjustModal();
    }

    /* =========================================================
       EXPORT CSV & PRINT AUDIT SHEET
       ========================================================= */
    function exportInventoryCsv() {
        if (state.products.length === 0) {
            showToast("No products available to export.", "warning");
            return;
        }

        const headers = ["SKU", "Brand", "Product Name", "Type", "Size", "Valve", "Full Stock", "Empty Stock", "Alert Limit", "Wholesale Cost (KSh)", "Retail Price (KSh)", "Storage Bay", "Status"];
        const rows = state.products.map((p) => [
            `"${p.sku || ""}"`,
            `"${p.brand}"`,
            `"${p.name.replace(/"/g, '""')}"`,
            `"${p.type}"`,
            `"${p.size}"`,
            `"${p.valve || ""}"`,
            p.stock,
            p.emptyStock || 0,
            p.lowStockLimit,
            p.costPrice || 0,
            p.price,
            `"${p.location || ""}"`,
            p.stock <= 0 ? "OUT OF STOCK" : p.stock <= p.lowStockLimit ? "LOW STOCK" : "IN STOCK"
        ]);

        const csvContent = "\uFEFF" + [headers.join(","), ...rows.map((e) => e.join(","))].join("\r\n");
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `GasHub_Inventory_Audit_${new Date().toISOString().slice(0, 10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showToast("Stock CSV exported successfully!", "success");
    }

    function printStockAuditSheet() {
        const printContainer = document.getElementById("printSheetContainer");
        if (!printContainer) return;

        const dateStr = new Date().toLocaleDateString("en-KE", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
        });
        const auditCode = `GH-AUD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

        printContainer.innerHTML = `
            <div class="print-document-wrapper" style="position: relative; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; padding: 24px; background: #ffffff; color: #0f172a;">
                <!-- Anti-Forgery Watermark Overlay -->
                <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-image: url('images/watermark.png'); background-position: center; background-repeat: no-repeat; background-size: 340px; opacity: 0.06; pointer-events: none; z-index: 0;"></div>

                <div style="position: relative; z-index: 1;">
                    <!-- Official Header with GasHub Logo -->
                    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #d97706; padding-bottom: 14px; margin-bottom: 18px;">
                        <div style="display: flex; align-items: center; gap: 14px;">
                            <img src="images/logo.png" alt="GasHub Official Logo" style="height: 52px; width: auto; object-fit: contain;">
                            <div>
                                <h1 style="margin: 0; font-size: 19px; font-weight: 800; color: #0f172a; text-transform: uppercase; letter-spacing: 0.5px;">GasHub Dealer Stock Audit & Valuation Certificate</h1>
                                <div style="font-size: 11px; color: #64748b; margin-top: 2px;">
                                    Official Physical Inventory Audit Sheet • EPRA LPG Safety Compliance Certified
                                </div>
                            </div>
                        </div>
                        <div style="text-align: right; font-size: 11px; line-height: 1.5;">
                            <strong style="color: #d97706; font-size: 12px;">SECURITY CODE: ${auditCode}</strong><br>
                            <span>Audit Date: ${dateStr}</span><br>
                            <span style="display: inline-block; padding: 2px 6px; background: #ecfdf5; color: #059669; border-radius: 4px; font-weight: 700; font-size: 10px;">EPRA / KEBS SECURE</span>
                        </div>
                    </div>

                    <!-- Audit Information Bar -->
                    <div style="display: flex; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 14px; margin-bottom: 16px; font-size: 11px;">
                        <div><strong>Dealership:</strong> GasHub Central Depot</div>
                        <div><strong>Auditor:</strong> System / Victor M.</div>
                        <div><strong>License:</strong> EPRA/LPG/2026/8942</div>
                        <div><strong>Total Catalog:</strong> ${state.products.length} Products</div>
                    </div>

                    <!-- Inventory Audit Table -->
                    <table style="width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 20px;">
                        <thead>
                            <tr style="background: #0f172a; color: #ffffff;">
                                <th style="border: 1px solid #0f172a; padding: 7px 6px; text-align: left;">SKU Code</th>
                                <th style="border: 1px solid #0f172a; padding: 7px 6px; text-align: left;">Brand</th>
                                <th style="border: 1px solid #0f172a; padding: 7px 6px; text-align: left;">Product Name</th>
                                <th style="border: 1px solid #0f172a; padding: 7px 6px; text-align: center;">Size</th>
                                <th style="border: 1px solid #0f172a; padding: 7px 6px; text-align: center;">System Full</th>
                                <th style="border: 1px solid #0f172a; padding: 7px 6px; text-align: center;">Physical Full</th>
                                <th style="border: 1px solid #0f172a; padding: 7px 6px; text-align: center;">System Empty</th>
                                <th style="border: 1px solid #0f172a; padding: 7px 6px; text-align: center;">Physical Empty</th>
                                <th style="border: 1px solid #0f172a; padding: 7px 6px; text-align: right;">Unit Price</th>
                                <th style="border: 1px solid #0f172a; padding: 7px 6px; text-align: center;">Audit Pass</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${state.products.map((p, idx) => `
                                <tr style="background: ${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};">
                                    <td style="border: 1px solid #cbd5e1; padding: 6px; font-family: monospace; font-size: 10px;">${escapeHtml(p.sku || "GH-N/A")}</td>
                                    <td style="border: 1px solid #cbd5e1; padding: 6px; font-weight: 700;">${escapeHtml(p.brand)}</td>
                                    <td style="border: 1px solid #cbd5e1; padding: 6px;">${escapeHtml(p.name)}</td>
                                    <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: center;">${escapeHtml(p.size)}</td>
                                    <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: center; font-weight: 700;">${formatNumber(p.stock)}</td>
                                    <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: center;">[ &nbsp; &nbsp; &nbsp; ]</td>
                                    <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: center;">${formatNumber(p.emptyStock || 0)}</td>
                                    <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: center;">[ &nbsp; &nbsp; &nbsp; ]</td>
                                    <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: right;">KSh ${formatCurrency(p.price)}</td>
                                    <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: center;">[ &nbsp; ] Pass</td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>

                    <!-- Anti-Forgery Security Footnote & Signatures -->
                    <div style="border-top: 1px dashed #cbd5e1; padding-top: 14px; display: flex; justify-content: space-between; align-items: flex-end; font-size: 11px;">
                        <div>
                            <p style="margin: 0 0 4px; font-weight: 700; color: #475569;">Anti-Counterfeit & Audit Verification Notice:</p>
                            <p style="margin: 0; color: #64748b; font-size: 10px; max-width: 440px; line-height: 1.4;">
                                This document is an authentic inventory count statement protected under GasHub Dealer Security Framework. Any tampering, uncertified alterations, or duplicate serial numbers constitute a violation of Energy & Petroleum Regulatory Authority (EPRA) regulations.
                            </p>
                        </div>

                        <div style="display: flex; gap: 36px; text-align: center;">
                            <div>
                                <div style="border-bottom: 1px solid #0f172a; width: 130px; margin-bottom: 4px; height: 26px;"></div>
                                <span style="font-size: 10px; color: #64748b;">Depot Manager Signature</span>
                            </div>
                            <div>
                                <div style="border-bottom: 1px solid #0f172a; width: 130px; margin-bottom: 4px; height: 26px;"></div>
                                <span style="font-size: 10px; color: #64748b;">Official Seal / Stamp</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        window.print();
    }

    /* =========================================================
       PAGINATION LOGIC
       ========================================================= */
    function getPaginatedItems() {
        const start = (state.currentPage - 1) * state.itemsPerPage;
        return state.filteredProducts.slice(start, start + state.itemsPerPage);
    }

    function getTotalPages() {
        return Math.max(1, Math.ceil(state.filteredProducts.length / state.itemsPerPage));
    }

    function updatePagination() {
        const total = state.filteredProducts.length;
        const totalPages = getTotalPages();

        const info = document.getElementById("paginationInfoText");
        const prevBtn = document.getElementById("prevPageBtn");
        const nextBtn = document.getElementById("nextPageBtn");
        const pageContainer = document.getElementById("paginationPageNumbers");
        const paginationWrap = document.getElementById("stockPagination");

        if (total === 0) {
            if (paginationWrap) paginationWrap.hidden = true;
            return;
        }

        if (paginationWrap) paginationWrap.hidden = false;

        const start = (state.currentPage - 1) * state.itemsPerPage + 1;
        const end = Math.min(state.currentPage * state.itemsPerPage, total);

        if (info) info.textContent = `Showing ${start}–${end} of ${total} products`;

        if (prevBtn) prevBtn.disabled = state.currentPage <= 1;
        if (nextBtn) nextBtn.disabled = state.currentPage >= totalPages;

        if (pageContainer) {
            pageContainer.innerHTML = "";
            for (let page = 1; page <= totalPages; page++) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = `btn-page ${page === state.currentPage ? "active" : ""}`;
                btn.textContent = String(page);
                btn.addEventListener("click", () => {
                    state.currentPage = page;
                    render();
                });
                pageContainer.appendChild(btn);
            }
        }
    }

    /* =========================================================
       HELPERS & UTILITIES
       ========================================================= */
    function showToast(message, type = "info") {
        const toast = document.getElementById("stockToast");
        if (!toast) return;

        toast.className = `stock-toast ${type} show`;
        let iconHtml = '<i class="fa-solid fa-circle-info"></i>';
        if (type === "success") iconHtml = '<i class="fa-solid fa-circle-check"></i>';
        if (type === "warning") iconHtml = '<i class="fa-solid fa-triangle-exclamation"></i>';
        if (type === "error") iconHtml = '<i class="fa-solid fa-circle-xmark"></i>';

        toast.innerHTML = `${iconHtml} <span>${escapeHtml(message)}</span>`;

        clearTimeout(showToast.timer);
        showToast.timer = setTimeout(() => {
            toast.classList.remove("show");
        }, 4000);
    }

    function formatNumber(num) {
        const n = Number(num);
        return Number.isFinite(n) ? new Intl.NumberFormat("en-KE").format(n) : "0";
    }

    function formatCurrency(num) {
        const n = Number(num);
        return Number.isFinite(n)
            ? new Intl.NumberFormat("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
            : "0";
    }

    function capitalize(str) {
        if (!str) return "";
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function escapeHtml(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function setElementText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    /* Public API */
    return {
        init,
        quickStepStock,
        openProductModal,
        openQuickAdjustModal,
        openDeleteModal,
        closeDeleteModal,
        executeDeleteProduct,
        openVerificationModal,
        closeVerificationModal,
        generateSku,
        exportInventoryCsv,
        printStockAuditSheet,
        applyFilters
    };
})();