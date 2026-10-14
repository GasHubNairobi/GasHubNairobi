/* Admin: dealer reviews left by customers after completed orders. */
document.addEventListener("DOMContentLoaded", () => {
    const state = { reviews: [] };

    const elements = {
        message: document.getElementById("reviewsMessage"),
        tableBody: document.getElementById("reviewsTableBody"),
        search: document.getElementById("reviewSearch"),
        statusFilter: document.getElementById("reviewStatusFilter"),
        totalReviews: document.getElementById("totalReviews"),
        publishedReviews: document.getElementById("publishedReviews"),
        hiddenReviews: document.getElementById("hiddenReviews"),
        averageRating: document.getElementById("averageRating")
    };

    const escapeHtml = (value) =>
        GasHubAdmin.escapeHtml(value === null || value === undefined ? "" : String(value));

    function showMessage(message, type = "error") {
        const el = elements.message;
        if (!el) return;
        if (!message) {
            el.textContent = "";
            el.className = "admin-message";
            el.style.display = "none";
            return;
        }
        el.textContent = message;
        el.className = `admin-message ${type}`;
        el.style.display = "block";
    }

    const getRating = (r) => {
        const n = Number(r.rating ?? r.stars ?? 0);
        return Number.isFinite(n) ? n : 0;
    };

    function normalizeStatus(status) {
        const v = String(status || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
        if (["hidden", "unpublished", "rejected", "deleted"].includes(v)) return "hidden";
        return "published";
    }

    const statusBadge = (status) => {
        const hidden = normalizeStatus(status) === "hidden";
        return `<span class="status-badge ${hidden ? "neutral" : "success"}">${hidden ? "Hidden" : "Published"}</span>`;
    };

    function formatDate(value) {
        const d = value ? new Date(value) : null;
        if (!d || Number.isNaN(d.getTime())) return "—";
        return d.toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
    }

    function ratingHtml(rating) {
        const v = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
        return `<span class="review-rating">${"★".repeat(v)}${"☆".repeat(5 - v)}<span>${v}/5</span></span>`;
    }

    function updateStatistics() {
        const list = state.reviews;
        const published = list.filter((r) => normalizeStatus(r.status) === "published").length;
        const ratings = list.map(getRating).filter((n) => n > 0);
        const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
        elements.totalReviews.textContent = list.length;
        elements.publishedReviews.textContent = published;
        elements.hiddenReviews.textContent = list.length - published;
        elements.averageRating.textContent = avg.toFixed(1);
    }

    function applyFilters() {
        const term = String(elements.search?.value || "").trim().toLowerCase();
        const status = String(elements.statusFilter?.value || "").trim().toLowerCase();

        renderReviews(state.reviews.filter((r) => {
            const text = [r.dealer_name, r.customer_name, r.order_number, r.product_name, r.comment, r.rating]
                .join(" ").toLowerCase();
            return (!term || text.includes(term)) && (!status || normalizeStatus(r.status) === status);
        }));
    }

    function renderReviews(list) {
        if (!list.length) {
            elements.tableBody.innerHTML = `<tr><td colspan="8" class="table-empty">No reviews found.</td></tr>`;
            return;
        }
        elements.tableBody.innerHTML = list.map((r) => {
            const hidden = normalizeStatus(r.status) === "hidden";
            return `
                <tr>
                    <td><div class="table-primary-text">${escapeHtml(r.dealer_name || "—")}</div></td>
                    <td>
                        <div class="table-primary-text">${escapeHtml(r.customer_name || "—")}</div>
                        <div class="table-secondary-text">${escapeHtml(r.customer_email || "")}</div>
                    </td>
                    <td><span class="table-code">${escapeHtml(r.order_number || "—")}</span></td>
                    <td>${ratingHtml(getRating(r))}</td>
                    <td><div class="table-secondary-text review-comment">${escapeHtml(r.comment || "—")}</div></td>
                    <td>${statusBadge(r.status)}</td>
                    <td>${formatDate(r.created_at)}</td>
                    <td>
                        <button type="button" class="link-button" data-id="${escapeHtml(r.id)}" data-next="${hidden ? "published" : "hidden"}">
                            ${hidden ? "Publish" : "Hide"}
                        </button>
                    </td>
                </tr>`;
        }).join("");
    }

    async function loadReviews() {
        try {
            showMessage("");
            elements.tableBody.innerHTML = `<tr><td colspan="8" class="table-loading">Loading reviews...</td></tr>`;
            const response = await GasHubAdmin.adminApiRequest("/api/admin/reviews");
            state.reviews = Array.isArray(response?.reviews) ? response.reviews : [];
            updateStatistics();
            applyFilters();
        } catch (error) {
            console.error("Failed to load reviews:", error);
            state.reviews = [];
            updateStatistics();
            elements.tableBody.innerHTML = `<tr><td colspan="8" class="table-empty">Failed to load reviews.</td></tr>`;
            showMessage(error.message || "Failed to load reviews.", "error");
        }
    }

    elements.tableBody.addEventListener("click", async (event) => {
        const btn = event.target.closest("button[data-id]");
        if (!btn) return;
        btn.disabled = true;
        try {
            await GasHubAdmin.adminApiRequest(`/api/admin/reviews/${encodeURIComponent(btn.dataset.id)}`, {
                method: "PATCH",
                body: { status: btn.dataset.next }
            });
            const row = state.reviews.find((r) => String(r.id) === btn.dataset.id);
            if (row) row.status = btn.dataset.next;
            updateStatistics();
            applyFilters();
            showMessage(btn.dataset.next === "hidden" ? "Review hidden. It no longer counts toward the dealer's rating." : "Review published.", "success");
        } catch (error) {
            btn.disabled = false;
            showMessage(error.message || "Unable to update this review.", "error");
        }
    });

    elements.search?.addEventListener("input", applyFilters);
    elements.statusFilter?.addEventListener("change", applyFilters);

    loadReviews();
});
