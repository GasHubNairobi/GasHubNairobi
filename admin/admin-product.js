/* the public product/dealer lists are hidden from customers when dealers are switched off, so send the admin token */
function adminFetch(url, options) {
    options = options || {};
    let token = "";
    try { token = localStorage.getItem("gashub_admin_token") || sessionStorage.getItem("gashub_admin_token") || ""; } catch (e) { }
    /* every admin request (including save and delete) must carry the admin token, otherwise the server answers "administrator authentication required" */
    return fetch(url, { ...options, credentials: "include", headers: { ...(options.headers || {}), ...(token ? { Authorization: "Bearer " + token } : {}) } });
}

/* =========================================================
   GASHUB ADMIN - PRODUCT MANAGEMENT
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    initializeProductPage();
});

/* =========================================================
   STATE
========================================================= */

let products = [];
let dealers = [];
let editingProductId = null;

/* =========================================================
   INITIALIZE
========================================================= */

function initializeProductPage() {
    initializeProductModal();
    initializeProductSearch();
    initializeProductStatusFilter();
    initializeProductForm();

    loadProducts();
    loadDealers();
}

/* =========================================================
   LOAD PRODUCTS
========================================================= */

async function loadProducts() {
    const tableBody = document.getElementById("productsTableBody");

    if (!tableBody) {
        return;
    }

    tableBody.innerHTML = `
        <tr>
            <td colspan="8" class="table-empty">
                Loading products...
            </td>
        </tr>
    `;

    try {
        const response = await adminFetch("/api/products");

        if (!response.ok) {
            throw new Error("Unable to load products.");
        }

        const data = await response.json();

        if (!data.success) {
            throw new Error(
                data.message || "Unable to load products."
            );
        }

        products = Array.isArray(data.products)
            ? data.products
            : [];

        updateProductStatistics();
        renderProducts();

    } catch (error) {
        console.error("Load products error:", error);

        products = [];

        updateProductStatistics();

        tableBody.innerHTML = `
            <tr>
                <td colspan="8" class="table-empty">
                    Unable to load products.
                </td>
            </tr>
        `;

        showProductMessage(
            error.message || "Unable to load products.",
            "error"
        );
    }
}

/* =========================================================
   LOAD DEALERS
========================================================= */

async function loadDealers() {
    const dealerSelect = document.getElementById("productDealer");

    if (!dealerSelect) {
        return;
    }

    try {
        const response = await adminFetch("/api/dealers");

        if (!response.ok) {
            throw new Error("Unable to load dealers.");
        }

        const data = await response.json();

        dealers = Array.isArray(data.dealers)
            ? data.dealers
            : [];

        populateDealerSelect();

    } catch (error) {
        console.error("Load dealers error:", error);

        dealers = [];
        populateDealerSelect();
    }
}

/* =========================================================
   POPULATE DEALER SELECT
========================================================= */

function populateDealerSelect(selectedId = "") {
    const dealerSelect =
        document.getElementById("productDealer");

    if (!dealerSelect) {
        return;
    }

    dealerSelect.innerHTML = `
        <option value="">Select Dealer</option>
    `;

    dealers.forEach((dealer) => {
        const option = document.createElement("option");

        option.value = dealer.id;
        option.textContent =
            dealer.businessName ||
            dealer.name ||
            "Unnamed Dealer";

        if (String(dealer.id) === String(selectedId)) {
            option.selected = true;
        }

        dealerSelect.appendChild(option);
    });
}

/* =========================================================
   UPDATE STATISTICS
========================================================= */

function updateProductStatistics() {
    const total = products.length;

    const available = products.filter(
        product =>
            String(product.status || "").toLowerCase() ===
            "available"
    ).length;

    const outOfStock = products.filter(
        product =>
            String(product.status || "").toLowerCase() ===
            "out_of_stock"
    ).length;

    const unavailable = products.filter(
        product =>
            String(product.status || "").toLowerCase() ===
            "unavailable"
    ).length;

    setText("totalProducts", total);
    setText("availableProducts", available);
    setText("outOfStockProducts", outOfStock);
    setText("unavailableProducts", unavailable);
}

/* =========================================================
   RENDER PRODUCTS
========================================================= */

function renderProducts() {
    const tableBody =
        document.getElementById("productsTableBody");

    if (!tableBody) {
        return;
    }

    const searchInput =
        document.getElementById("productSearch");

    const statusFilter =
        document.getElementById("productStatusFilter");

    const search = String(
        searchInput?.value || ""
    ).trim().toLowerCase();

    const status = String(
        statusFilter?.value || ""
    ).trim().toLowerCase();

    const filteredProducts = products.filter((product) => {
        const searchableText = [
            product.name,
            product.product_code,
            product.category,
            product.cylinder_size,
            product.dealer_name,
            product.location
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

        const matchesSearch =
            !search ||
            searchableText.includes(search);

        const matchesStatus =
            !status ||
            String(product.status || "").toLowerCase() ===
                status;

        return matchesSearch && matchesStatus;
    });

    if (filteredProducts.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="8" class="table-empty">
                    No products found.
                </td>
            </tr>
        `;

        return;
    }

    tableBody.innerHTML = filteredProducts
        .map(product => createProductRow(product))
        .join("");

    initializeProductRowButtons();
}

/* =========================================================
   CREATE PRODUCT ROW
========================================================= */

function createProductRow(product) {
    const productName =
        escapeHtml(product.name || "Unnamed Product");

    const productCode =
        escapeHtml(product.product_code || "—");

    const category =
        escapeHtml(product.category || "—");

    const cylinderSize =
        escapeHtml(product.cylinder_size || "—");

    const dealer =
        escapeHtml(
            product.dealer_name ||
            "No Dealer"
        );

    const price =
        formatCurrency(product.price);

    const status =
        String(product.status || "").toLowerCase();

    const statusLabel =
        getProductStatusLabel(status);

    return `
        <tr>

            <td>
                <div class="product-table-name">
                    ${productName}
                </div>
            </td>

            <td>
                ${productCode}
            </td>

            <td>
                ${category}
            </td>

            <td>
                ${cylinderSize}
            </td>

            <td>
                ${price}
            </td>

            <td>
                ${dealer}
            </td>

            <td>
                <span class="status-badge ${getStatusClass(status)}">
                    ${statusLabel}
                </span>
            </td>

            <td>
                <div class="table-actions">

                    <button
                        type="button"
                        class="table-action-button edit-product-button"
                        data-id="${escapeHtml(product.id)}"
                    >
                        Edit
                    </button>

                    <button
                        type="button"
                        class="table-action-button delete-product-button danger"
                        data-id="${escapeHtml(product.id)}"
                    >
                        Delete
                    </button>

                </div>
            </td>

        </tr>
    `;
}

/* =========================================================
   PRODUCT ROW BUTTONS
========================================================= */

function initializeProductRowButtons() {
    document
        .querySelectorAll(".edit-product-button")
        .forEach(button => {
            button.addEventListener("click", () => {
                const id = button.dataset.id;
                openEditProduct(id);
            });
        });

    document
        .querySelectorAll(".delete-product-button")
        .forEach(button => {
            button.addEventListener("click", () => {
                const id = button.dataset.id;
                deleteProduct(id);
            });
        });
}

/* =========================================================
   MODAL
========================================================= */

function initializeProductModal() {
    const addButton =
        document.getElementById("addProductButton");

    const closeButton =
        document.getElementById("closeProductModal");

    const cancelButton =
        document.getElementById("cancelProductButton");

    const backdrop =
        document.getElementById("productModalBackdrop");

    if (addButton) {
        addButton.addEventListener("click", () => {
            openAddProduct();
        });
    }

    if (closeButton) {
        closeButton.addEventListener("click", closeProductModal);
    }

    if (cancelButton) {
        cancelButton.addEventListener(
            "click",
            closeProductModal
        );
    }

    if (backdrop) {
        backdrop.addEventListener(
            "click",
            closeProductModal
        );
    }

    document.addEventListener("keydown", event => {
        if (
            event.key === "Escape" &&
            isProductModalOpen()
        ) {
            closeProductModal();
        }
    });
}

/* =========================================================
   OPEN ADD PRODUCT
========================================================= */

function openAddProduct() {
    editingProductId = null;

    const form =
        document.getElementById("productForm");

    const title =
        document.getElementById("productModalTitle");

    if (form) {
        form.reset();
    }

    const productId =
        document.getElementById("productId");

    if (productId) {
        productId.value = "";
    }

    if (title) {
        title.textContent = "Add Product";
    }

    populateDealerSelect();

    openProductModal();
}

/* =========================================================
   OPEN EDIT PRODUCT
========================================================= */

function openEditProduct(id) {
    const product = products.find(
        item => String(item.id) === String(id)
    );

    if (!product) {
        showProductMessage(
            "Product could not be found.",
            "error"
        );

        return;
    }

    editingProductId = product.id;

    setText(
        "productModalTitle",
        "Edit Product"
    );

    setInputValue(
        "productId",
        product.id
    );

    setInputValue(
        "productName",
        product.name
    );

    setInputValue(
        "productCode",
        product.product_code
    );

    setInputValue(
        "productCategory",
        product.category
    );

    setInputValue(
        "cylinderSize",
        product.cylinder_size
    );

    setInputValue(
        "productPrice",
        product.price
    );

    setInputValue(
        "productLocation",
        product.location
    );

    setInputValue(
        "productDescription",
        product.description
    );

    setInputValue(
        "productImage",
        product.image
    );

    setSelectValue(
        "productStatus",
        product.status
    );

    populateDealerSelect(product.dealer_id);

    openProductModal();
}

/* =========================================================
   OPEN MODAL
========================================================= */

function openProductModal() {
    const modal =
        document.getElementById("productModal");

    if (!modal) {
        return;
    }

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");

    document.body.classList.add("modal-open");

    const nameInput =
        document.getElementById("productName");

    if (nameInput) {
        setTimeout(() => nameInput.focus(), 100);
    }
}

/* =========================================================
   CLOSE MODAL
========================================================= */

function closeProductModal() {
    const modal =
        document.getElementById("productModal");

    if (!modal) {
        return;
    }

    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");

    document.body.classList.remove("modal-open");

    editingProductId = null;
}

/* =========================================================
   MODAL STATE
========================================================= */

function isProductModalOpen() {
    const modal =
        document.getElementById("productModal");

    return modal &&
        modal.classList.contains("open");
}

/* =========================================================
   PRODUCT FORM
========================================================= */

function initializeProductForm() {
    const form =
        document.getElementById("productForm");

    if (!form) {
        return;
    }

    form.addEventListener(
        "submit",
        handleProductSubmit
    );
}

/* =========================================================
   SUBMIT PRODUCT
========================================================= */

async function handleProductSubmit(event) {
    event.preventDefault();

    const saveButton =
        document.getElementById("saveProductButton");

    const productId =
        document.getElementById("productId")?.value.trim();

    const product = {
        name: getInputValue("productName"),
        product_code: getInputValue("productCode"),
        category: getInputValue("productCategory"),
        cylinder_size: getInputValue("cylinderSize"),
        price: Number(
            getInputValue("productPrice") || 0
        ),
        dealer_id:
            getInputValue("productDealer") || null,
        location: getInputValue("productLocation"),
        description:
            getInputValue("productDescription"),
        status:
            getInputValue("productStatus") ||
            "available",
        image: getInputValue("productImage")
    };

    if (!product.name) {
        showProductMessage(
            "Product name is required.",
            "error"
        );

        return;
    }

    if (!Number.isFinite(product.price) || product.price < 0) {
        showProductMessage(
            "Enter a valid product price.",
            "error"
        );

        return;
    }

    setButtonLoading(saveButton, true);

    try {
        const url = productId
            ? `/api/admin/products/${encodeURIComponent(productId)}`
            : "/api/admin/products";

        const method = productId
            ? "PUT"
            : "POST";

        const response = await adminFetch(url, {
            method,
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(product)
        });

        let data = {};

        try {
            data = await response.json();
        } catch (_) {
            data = {};
        }

        if (!response.ok || !data.success) {
            throw new Error(
                data.message ||
                "Unable to save product."
            );
        }

        closeProductModal();

        showProductMessage(
            data.message ||
            (
                productId
                    ? "Product updated successfully."
                    : "Product created successfully."
            ),
            "success"
        );

        await loadProducts();

    } catch (error) {
        console.error("Save product error:", error);

        showProductMessage(
            error.message ||
            "Unable to save product.",
            "error"
        );

    } finally {
        setButtonLoading(saveButton, false);
    }
}

/* =========================================================
   DELETE PRODUCT
========================================================= */

async function deleteProduct(id) {
    const product = products.find(
        item => String(item.id) === String(id)
    );

    if (!product) {
        return;
    }

    const productName =
        product.name || "this product";

    const confirmed = await GasHubDialog.confirm({
        title: "Delete product?",
        message: `Delete ${productName}? This action cannot be undone.`,
        confirmText: "Delete", tone: "danger"
    });

    if (!confirmed) {
        return;
    }

    try {
        const response = await adminFetch(
            `/api/admin/products/${encodeURIComponent(id)}`,
            {
                method: "DELETE"
            }
        );

        let data = {};

        try {
            data = await response.json();
        } catch (_) {
            data = {};
        }

        if (!response.ok || !data.success) {
            throw new Error(
                data.message ||
                "Unable to delete product."
            );
        }

        showProductMessage(
            data.message ||
            "Product deleted successfully.",
            "success"
        );

        await loadProducts();

    } catch (error) {
        console.error("Delete product error:", error);

        showProductMessage(
            error.message ||
            "Unable to delete product.",
            "error"
        );
    }
}

/* =========================================================
   SEARCH
========================================================= */

function initializeProductSearch() {
    const searchInput =
        document.getElementById("productSearch");

    if (!searchInput) {
        return;
    }

    searchInput.addEventListener(
        "input",
        renderProducts
    );
}

/* =========================================================
   STATUS FILTER
========================================================= */

function initializeProductStatusFilter() {
    const filter =
        document.getElementById("productStatusFilter");

    if (!filter) {
        return;
    }

    filter.addEventListener(
        "change",
        renderProducts
    );
}

/* =========================================================
   STATUS HELPERS
========================================================= */

function getProductStatusLabel(status) {
    switch (status) {
        case "available":
            return "Available";

        case "out_of_stock":
            return "Out of Stock";

        case "unavailable":
            return "Unavailable";

        default:
            return status
                ? capitalizeWords(status.replace(/_/g, " "))
                : "Unknown";
    }
}

function getStatusClass(status) {
    switch (status) {
        case "available":
            return "success";

        case "out_of_stock":
            return "warning";

        case "unavailable":
            return "danger";

        default:
            return "neutral";
    }
}

/* =========================================================
   MESSAGE
========================================================= */

function showProductMessage(
    message,
    type = "success"
) {
    const element =
        document.getElementById("productMessage");

    if (!element) {
        return;
    }

    element.textContent = message;

    element.className =
        `admin-message ${type} show`;

    clearTimeout(
        showProductMessage.timeout
    );

    showProductMessage.timeout =
        setTimeout(() => {
            element.classList.remove("show");
        }, 5000);
}

/* =========================================================
   BUTTON LOADING
========================================================= */

function setButtonLoading(button, loading) {
    if (!button) {
        return;
    }

    if (loading) {
        button.disabled = true;

        if (!button.dataset.originalText) {
            button.dataset.originalText =
                button.textContent;
        }

        button.textContent = "Saving...";
    } else {
        button.disabled = false;

        button.textContent =
            button.dataset.originalText ||
            "Save Product";
    }
}

/* =========================================================
   INPUT HELPERS
========================================================= */

function getInputValue(id) {
    const element =
        document.getElementById(id);

    return element
        ? element.value.trim()
        : "";
}

function setInputValue(id, value) {
    const element =
        document.getElementById(id);

    if (element) {
        element.value =
            value === null ||
            value === undefined
                ? ""
                : value;
    }
}

function setSelectValue(id, value) {
    const element =
        document.getElementById(id);

    if (element) {
        element.value =
            value === null ||
            value === undefined
                ? ""
                : value;
    }
}

function setText(id, value) {
    const element =
        document.getElementById(id);

    if (element) {
        element.textContent =
            value === null ||
            value === undefined
                ? ""
                : value;
    }
}

/* =========================================================
   CURRENCY
========================================================= */

function formatCurrency(value) {
    const amount = Number(value || 0);

    return `KSh ${amount.toLocaleString(
        "en-KE",
        {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }
    )}`;
}

/* =========================================================
   CAPITALIZE
========================================================= */

function capitalizeWords(value) {
    return String(value)
        .replace(/\b\w/g, letter =>
            letter.toUpperCase()
        );
}

/* =========================================================
   HTML ESCAPING
========================================================= */

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}