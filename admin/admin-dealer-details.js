/* GasHub admin dealer details — real database data only */
(() => {
    "use strict";

    const $ = id => document.getElementById(id);
    const params = new URLSearchParams(window.location.search);
    const dealerId = params.get("id");

    let dealer = null;
    let verificationFee = 0;

    const currency = value =>
        new Intl.NumberFormat("en-KE", {
            style: "currency",
            currency: "KES",
            minimumFractionDigits: 2
        }).format(Number(value) || 0).replace("KES", "KSh");

    const dateLabel = value => {
        if (!value) return "Not set";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "Not set";
        return new Intl.DateTimeFormat("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric"
        }).format(date);
    };

    function escapeHtml(value) {
        if (window.GasHubAdmin?.escapeHtml) {
            return window.GasHubAdmin.escapeHtml(String(value ?? ""));
        }

        return String(value ?? "").replace(/[&<>"']/g, char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[char]);
    }

    function notify(message, type = "info") {
        const box = $("pageMessage");
        if (!box) {
            window.alert(message);
            return;
        }

        box.textContent = message;
        box.classList.add("show");
        box.dataset.type = type;
    }

    function adminToken() {
        return (
            localStorage.getItem("gashub_admin_token") ||
            sessionStorage.getItem("gashub_admin_token") ||
            localStorage.getItem("adminToken") ||
            ""
        );
    }

    async function apiRequest(url, options = {}) {
        if (window.GasHubAdmin?.adminApiRequest) {
            return window.GasHubAdmin.adminApiRequest(url, options);
        }

        const token = adminToken();

        const response = await fetch(url, {
            ...options,
            credentials: "include",
            headers: {
                ...(options.body ? { "Content-Type": "application/json" } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(options.headers || {})
            }
        });

        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
            if (response.status === 401) {
                throw new Error(
                    result.message ||
                    "Your admin session expired. Please sign in again."
                );
            }

            throw new Error(
                result.message || `Request failed (${response.status})`
            );
        }

        return result;
    }

    function activeVerification() {
        if (!dealer || dealer.is_verified !== true) return false;
        if (!dealer.verification_expires_at) return false;

        const expiry = new Date(dealer.verification_expires_at);
        return !Number.isNaN(expiry.getTime()) && expiry > new Date();
    }

    function renderVerification() {
        const badge = $("verificationBadge");
        const verified = activeVerification();

        if (badge) {
            badge.classList.toggle("unverified", !verified);
            badge.setAttribute(
                "aria-label",
                verified ? "Verified GasHub dealer" : "Dealer not verified"
            );
            badge.title = verified
                ? "Verified GasHub dealer"
                : "Dealer not verified";

            badge.innerHTML = verified
                ? `<svg class="verification-seal" viewBox="0 0 24 24"
                        aria-hidden="true">
                    <path class="seal-shape"
                      d="M12 1.2 15 2.8 18.4 2.9 19.4 6.2
                      21.8 8.7 21 12 21.8 15.3 19.4 17.8
                      18.4 21.1 15 21.2 12 22.8 9 21.2
                      5.6 21.1 4.6 17.8 2.2 15.3 3 12
                      2.2 8.7 4.6 6.2 5.6 2.9 9 2.8Z"/>
                    <path class="seal-check"
                      d="m7.4 12.1 3 3.1 6.4-6.5"/>
                  </svg><span class="verified-label">Verified</span>`
                : `<span class="verified-label">Not verified</span>`;
        }

        if ($("verificationAction")) {
            $("verificationAction").textContent = verified
                ? "Renew verification"
                : "Verify dealer";
        }

        if ($("unverifyAction")) {
            $("unverifyAction").hidden = !dealer?.is_verified;
        }

        if ($("verificationStatusText")) {
            $("verificationStatusText").textContent = verified
                ? `Verified until ${dateLabel(dealer.verification_expires_at)}`
                : dealer?.is_verified
                    ? "Verification has expired"
                    : "Not currently verified";
        }

        if ($("verificationExpiryText")) {
            $("verificationExpiryText").textContent =
                dealer?.verification_expires_at
                    ? `Expiry date: ${dateLabel(dealer.verification_expires_at)}`
                    : "No active verification period";
        }
    }

    function uniqueJoin(parts, separator) {
        const seen = new Set();
        return parts
            .map(part => String(part ?? "").trim())
            .filter(part => {
                const key = part.toLowerCase();
                if (!part || seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .join(separator);
    }

    function statusLabel(status) {
        const value = String(status || "active").toLowerCase();
        if (["inactive", "disabled", "deactivated"].includes(value)) return "Disabled";
        if (value === "suspended") return "Suspended";
        return "Active";
    }

    function renderDealer() {
        if (!dealer) return;

        const name = dealer.business_name || dealer.name || "Unnamed dealer";
        const initials = name
            .split(/\s+/)
            .slice(0, 2)
            .map(part => part[0] || "")
            .join("")
            .toUpperCase() || "D";

        // Same wording as Admin > Dealers and the customer dealer pages.
        const fields = {
            dealerName: name,
            businessName: name,
            dealerCode: dealer.dealer_code || "No Code",
            dealerJoined: dateLabel(dealer.created_at),
            contactPerson: dealer.contact_person || "—",
            dealerPhone: dealer.phone || "—",
            dealerEmail: dealer.email || "—",
            dealerTown: uniqueJoin([dealer.county, dealer.town], " / ") || "—",
            dealerAddress:
                uniqueJoin([dealer.address, dealer.location, dealer.town, dealer.county], ", ") ||
                "Location unlisted",
            dealerDescription: dealer.description || "This dealer has not added a description yet."
        };

        for (const [id, value] of Object.entries(fields)) {
            const node = $(id);
            if (node) node.textContent = value;
        }

        const statusPill = document.querySelector(".profile-tags .status-pill");
        if (statusPill) {
            const label = statusLabel(dealer.status);
            statusPill.textContent = label;
            statusPill.dataset.status = label.toLowerCase();
        }

        const logoBox = $("dealerLogo");
        const logoImg = logoBox ? logoBox.querySelector("img") : null;
        const logoFallback = $("logoFallback");
        if (logoImg) {
            if (dealer.logo) {
                logoImg.onerror = () => {
                    logoImg.style.display = "none";
                    if (logoFallback) {
                        logoFallback.textContent = initials;
                        logoFallback.style.display = "grid";
                    }
                };
                logoImg.src = dealer.logo;
                logoImg.style.display = "";
                if (logoFallback) logoFallback.style.display = "none";
            } else {
                logoImg.removeAttribute("src");
                logoImg.style.display = "none";
                if (logoFallback) {
                    logoFallback.textContent = initials;
                    logoFallback.style.display = "grid";
                }
            }
        }

        const productCount = $("productCount") || $("dealerProductCount");
        if (productCount) {
            productCount.textContent = Number(dealer.product_count) || 0;
        }

        // Customer followers, rating and reviews (from the customers' side)
        const followerCount = $("followerCount");
        if (followerCount) {
            followerCount.textContent = Number(dealer.follower_count) || 0;
        }

        const rating = Number(dealer.rating) || 0;
        const ratingNode = $("dealerRating");
        if (ratingNode) {
            ratingNode.textContent = rating > 0 ? rating.toFixed(1) : "—";
        }

        const reviewCount = $("reviewCount");
        if (reviewCount) {
            reviewCount.textContent = Number(dealer.review_count) || 0;
        }

        renderVerification();
        renderWorkingHours();
    }

    /* Working hours the dealer saved in their profile (24 hours, or a daily schedule) */
    function renderWorkingHours() {
        if (!dealer) return;
        const hours = dealer.working_hours;
        const set = (id, text) => { const node = $(id); if (node) node.textContent = text; };

        if (!hours) {
            set("hoursMode", "Not set by dealer");
            set("hoursRange", "Not listed");
            set("hoursDays", "—");
            set("hoursNow", "Shown as open (no hours set)");
        } else if (hours.open24) {
            set("hoursMode", "Open 24 hours");
            set("hoursRange", "Open 24 hours");
            set("hoursDays", "Every day");
            set("hoursNow", "Open now");
        } else {
            set("hoursMode", "Scheduled hours");
            set("hoursRange", dealer.hours_text || "—");
            set("hoursDays", dealer.working_days_text || "—");
            set("hoursNow", (dealer.open_status || (dealer.is_open_now ? "Open now" : "Closed")) +
                (dealer.open_status_detail ? " · " + dealer.open_status_detail : ""));
        }

        const now = $("hoursNow");
        if (now) now.style.color = dealer.is_open_now === false ? "#a83c3c" : "#176b48";
    }

    function renderProducts(products) {
        const body = $("productsTableBody") || $("dealerProductsTableBody");
        if (!body) return;

        if (!Array.isArray(products) || products.length === 0) {
            body.innerHTML = `
                <tr><td colspan="8" class="empty-row">
                    No products found for this dealer.
                </td></tr>`;
            return;
        }

        body.innerHTML = products.map(product => `
            <tr>
                <td>${escapeHtml(product.product_code || "—")}</td>
                <td>${escapeHtml(product.name || "—")}</td>
                <td>${escapeHtml(product.category || "—")}</td>
                <td>${escapeHtml(
                    [product.cylinder_size, product.cylinder_unit]
                        .filter(Boolean).join(" ") || "—"
                )}</td>
                <td>${escapeHtml(currency(product.price))}</td>
                <td>${escapeHtml(product.stock_quantity ?? "—")}</td>
                <td>${escapeHtml(product.status || "—")}</td>
                <td>${escapeHtml(dateLabel(product.created_at))}</td>
            </tr>
        `).join("");
    }

    async function loadDealer() {
        if (!dealerId) {
            notify("No dealer ID was provided in the page URL.", "error");
            return;
        }

        try {
            const result = await apiRequest(
                `/api/dealers/${encodeURIComponent(dealerId)}`
            );

            if (!result.success || !result.dealer) {
                throw new Error("Dealer details were not returned by the API.");
            }

            dealer = result.dealer;
            renderDealer();
            renderProducts(result.products || []);
            loadCommercial();
        } catch (error) {
            console.error("Unable to load dealer:", error);
            notify(`Unable to load dealer details: ${error.message}`, "error");
        }
    }

    /* Commission rate and verification fee (admin-only endpoints) */
    function fillCommercial(settings) {
        if (!settings) return;
        if ($("commissionRate") && settings.commission_rate != null) {
            $("commissionRate").value = Number(settings.commission_rate);
        }
        if ($("verificationFee") && settings.verification_fee != null) {
            $("verificationFee").value = Number(settings.verification_fee);
            verificationFee = Number(settings.verification_fee) || 0;
        }
    }

    async function loadCommercial() {
        try {
            const result = await apiRequest(
                `/api/admin/dealers/${encodeURIComponent(dealer.id)}/commercial`
            );
            fillCommercial(result.settings);
        } catch (error) {
            console.error("Unable to load commercial settings:", error);
            notify(`Commercial settings: ${error.message}`, "error");
        }
    }

    // These forms used to have no handler, so the browser reloaded the page without ?id=
    // (the "No dealer ID" error) and the dealer details disappeared.
    $("commercialForm")?.addEventListener("submit", async event => {
        event.preventDefault();

        if (!dealer?.id) {
            notify("Dealer details have not loaded yet.", "error");
            return;
        }

        try {
            const result = await apiRequest(
                `/api/admin/dealers/${encodeURIComponent(dealer.id)}/commercial`,
                {
                    method: "PATCH",
                    body: JSON.stringify({
                        commission_rate: Number($("commissionRate")?.value),
                        verification_fee: Number($("verificationFee")?.value)
                    })
                }
            );

            fillCommercial(result.settings);
            notify("Commercial settings saved.", "success");
            closeCommercial(false);
        } catch (error) {
            console.error("Unable to save commercial settings:", error);
            notify(`Could not save commercial settings: ${error.message}`, "error");
        }
    });

    /* ---------------- Dealer payouts ---------------- */
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    let payoutSettings = null;

    function renderPayoutFields() {
        const s = payoutSettings || {};
        const method = $("payoutMethod")?.value || s.method || "phone";
        const f = (id, label, val, ph, type = "text") =>
            `<label>${label}<input id="${id}" type="${type}" value="${escapeHtml(val ?? "")}" placeholder="${ph}"></label>`;
        let html = "";
        if (method === "paybill") html += f("poPaybill", "Paybill number", s.paybill, "e.g. 247247") + f("poAccount", "Account number", s.account, "Account");
        else if (method === "till") html += f("poTill", "Till number", s.till, "e.g. 5123456");
        else html += f("poPhone", "M-Pesa phone number", s.phone, "0712345678", "tel");
        html += f("poHold", "Hold completed orders for (hours)", s.hold_hours ?? 24, "24", "number");
        html += f("poMin", "Minimum payout (KSh)", s.min_payout ?? 0, "0", "number");
        $("payoutFields").innerHTML = html;
    }

    function statusPill(status) {
        const cls = { paid: "pill-paid", scheduled: "pill-processing", held: "pill-pending", sending: "pill-processing", failed: "pill-failed" }[status] || "pill-pending";
        return `<span class="pill ${cls}">${escapeHtml(status)}</span>`;
    }

    const base = () => `/api/admin/dealers/${encodeURIComponent(dealerId)}`;

    /* "Send now" is offered for M-Pesa phone payouts once the B2C setup exists on the server */
    function canSend(p, r) {
        const phone = p.dest_method ? p.dest_method === "phone" : /^M-Pesa\s/i.test(String(p.destination || ""));
        return Boolean(r && r.automation && r.automation.configured && phone && p.status !== "held" && p.status !== "paid");
    }
    async function loadPayouts() {
        if (!dealerId) return;
        try {
            const r = await apiRequest(`${base()}/payouts`);
            payoutSettings = r.settings;
            if ($("payoutMethod")) $("payoutMethod").value = payoutSettings.method || "phone";
            renderPayoutFields();
            const b = r.balance || {};
            $("poOnline").textContent = currency(b.online_amount);
            $("poCash").textContent = "- " + currency(b.cash_commission);
            $("poNet").textContent = currency(b.net);
            $("poOnHold").textContent = `${b.on_hold_orders || 0} orders (${currency(b.on_hold_amount)})`;
            $("poHint").textContent = `Commission rate ${b.commission_rate}%. ${b.orders || 0} completed orders ready` +
                (b.net <= 0 && b.orders ? " - nothing to pay yet; cash commission carries forward." : ".") +
                (r.automation && r.automation.automatic ? " Automatic payouts are ON for all dealers." : "");
            if (window.GasHubPlannerBanner) GasHubPlannerBanner.render($("poPlannerBanner"), r.schedule);
            const rows = r.payouts || [];
            $("poBody").innerHTML = rows.length ? rows.map(p => {
                const open = p.status !== "paid";
                return `<tr><td><span class="order-number">${escapeHtml(p.reference)}</span>${p.mpesa_receipt ? `<span class="cell-sub">${escapeHtml(p.mpesa_receipt)}</span>` : ""}</td>
                    <td>${escapeHtml(new Date(p.scheduled_for).toLocaleString("en-GB"))}${new Date(p.scheduled_for) <= new Date() && p.status === "scheduled" ? '<span class="cell-sub">Due now</span>' : ""}</td>
                    <td class="money">${currency(p.online_amount)}</td><td class="money commission-money">- ${currency(p.cash_commission)}</td>
                    <td class="money net-money">${currency(p.amount)}</td><td>${escapeHtml(p.destination || "")}</td><td>${statusPill(p.status)}${p.status === "sending" ? '<span class="cell-sub">Waiting for M-Pesa...</span>' : ""}${p.auto && p.status === "scheduled" ? '<span class="cell-sub">Automatic</span>' : ""}${p.error && p.status !== "paid" ? `<span class="cell-sub" style="white-space:normal;max-width:260px;color:#b42318">${escapeHtml(p.error)}</span>` : ""}</td>
                    <td>${open && p.status === "sending" && Date.now() - new Date(p.started_at || 0).getTime() < 60 * 60000 ? '<span class="cell-sub">Locked while M-Pesa answers</span>' : open ? `${canSend(p, r) ? `<button class="row-action" data-po="send_now" data-id="${p.id}">${p.status === "failed" ? "Send again" : "Send now"}</button> ` : ""}${p.status === "failed" ? `<button class="row-action" data-po="release" data-id="${p.id}">Release</button> ` : ""}<button class="row-action" data-po="paid" data-id="${p.id}">Mark paid</button> ${p.status === "held" ? `<button class="row-action" data-po="release" data-id="${p.id}">Release</button>` : `<button class="row-action" data-po="hold" data-id="${p.id}">Hold</button>`} <button class="row-action" data-po="cancel" data-id="${p.id}">Cancel</button>` : ""}</td></tr>`;
            }).join("") : '<tr><td colspan="8" class="empty-row">No payouts yet.</td></tr>';
        } catch (error) {
            console.error("Unable to load payouts:", error);
            notify(`Payouts: ${error.message}`, "error");
            $("poBody").innerHTML = `<tr><td colspan="8" class="empty-row">${escapeHtml(error.message)}</td></tr>`;
        }
    }

    $("payoutMethod")?.addEventListener("change", () => {
        payoutSettings = { ...(payoutSettings || {}), method: $("payoutMethod").value };
        renderPayoutFields();
    });

    $("payoutForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const v = id => $(id)?.value ?? "";
        try {
            const r = await apiRequest(`${base()}/payout-settings`, {
                method: "PUT",
                body: JSON.stringify({
                    method: v("payoutMethod"), phone: v("poPhone"), paybill: v("poPaybill"), account: v("poAccount"), till: v("poTill"),
                    hold_hours: v("poHold"), min_payout: v("poMin")
                })
            });
            payoutSettings = r.settings;
            notify("Payout settings saved.", "success");
            closePayoutDestination(false);
            loadPayouts();
        } catch (error) {
            notify(`Could not save payout settings: ${error.message}`, "error");
        }
    });

    $("poSchedule")?.addEventListener("click", async () => {
        try {
            const made = await apiRequest(`${base()}/payouts`, { method: "POST", body: JSON.stringify({}) });
            notify(made.message || "Payout created.", "success");
            loadPayouts();
        } catch (error) {
            notify(error.message, "error");
        }
    });

    $("poBody")?.addEventListener("click", async event => {
        const btn = event.target.closest("[data-po]");
        if (!btn) return;
        const action = btn.dataset.po;
        const body = { action };
        if (action === "paid") {
            const code = await GasHubDialog.prompt({ title: "Mark payout as paid", message: "Enter the M-Pesa receipt code of the transfer you sent.", label: "M-Pesa receipt code", placeholder: "e.g. QGH7XK2LMN", confirmText: "Mark as paid", requiredMessage: "Enter the receipt code." });
            if (!code) return;
            body.mpesa_receipt = code;
        }
        if (action === "send_now" && !(await GasHubDialog.confirm({ title: "Send this payout to M-Pesa now?", message: "The money is sent to the dealer's M-Pesa number straight away. It turns Paid when Safaricom confirms. Check your M-Pesa statement first if an earlier attempt gave no answer.", confirmText: "Send now", cancelText: "Not yet", tone: "warning" }))) return;
        if (action === "cancel" && !(await GasHubDialog.confirm({ title: "Cancel this payout?", message: "Its orders go back into the next payout.", confirmText: "Cancel payout", cancelText: "Keep it", tone: "warning" }))) return;
        try {
            await apiRequest(`${base()}/payouts/${encodeURIComponent(btn.dataset.id)}`, { method: "PATCH", body: JSON.stringify(body) });
            loadPayouts();
        } catch (error) {
            notify(error.message, "error");
        }
    });

    function updateVerificationPreview() {
        const days = Math.max(1, Number($("verificationDays")?.value) || 1);
        const expiry = new Date();
        expiry.setHours(23, 59, 59, 999);
        expiry.setDate(expiry.getDate() + days);

        if ($("verificationFeePreview")) {
            $("verificationFeePreview").textContent =
                currency(verificationFee);
        }

        if ($("verificationExpiryPreview")) {
            $("verificationExpiryPreview").textContent = dateLabel(expiry);
        }
    }

    async function saveVerification(verified, days = null) {
        if (!dealer || !dealer.id) {
            notify("Dealer details have not loaded yet.", "error");
            return;
        }

        let expiresAt = null;

        if (verified) {
            if (!Number.isInteger(days) || days < 1 || days > 3650) {
                notify("Choose a verification duration from 1 to 3650 days.", "error");
                return;
            }

            const expiry = new Date();
            expiry.setHours(23, 59, 59, 999);
            expiry.setDate(expiry.getDate() + days);
            expiresAt = expiry.toISOString();
        }

        try {
            const result = await apiRequest(
                `/api/admin/dealers/${encodeURIComponent(dealer.id)}/verification`,
                {
                    method: "PATCH",
                    body: JSON.stringify({ verified, expiresAt })
                }
            );

            if (!result.success || !result.dealer) {
                throw new Error(result.message || "Verification was not saved.");
            }

            Object.assign(dealer, result.dealer);
            renderVerification();

            notify(
                verified
                    ? "Dealer verification saved to the database."
                    : "Dealer verification removed from the database.",
                "success"
            );
        } catch (error) {
            console.error("Unable to save verification:", error);
            notify(`Could not save verification: ${error.message}`, "error");
        }
    }

    $("verificationAction")?.addEventListener("click", () => {
        if (!dealer) {
            notify("Wait for the dealer details to load.", "error");
            return;
        }

        updateVerificationPreview();
        $("verificationDialog")?.showModal();
    });

    $("verificationDays")?.addEventListener(
        "input",
        updateVerificationPreview
    );

    $("verificationForm")?.addEventListener("submit", async event => {
        event.preventDefault();

        const days = Number($("verificationDays")?.value);

        if (!Number.isInteger(days) || days < 1 || days > 3650) {
            notify("Choose a duration from 1 to 3650 days.", "error");
            return;
        }

        if (!(await GasHubDialog.confirm({
            title: "Verify this dealer?",
            message: `${dealer?.business_name || "This dealer"} will get the verified badge for ${days} days.`,
            confirmText: "Verify", tone: "success"
        }))) return;

        await saveVerification(true, days);
        $("verificationDialog")?.close();
    });

    $("unverifyAction")?.addEventListener("click", async () => {
        if (!dealer) return;

        if (!(await GasHubDialog.confirm({
            title: "Remove verification?",
            message: `${dealer.business_name || "This dealer"} will lose the verified badge.`,
            confirmText: "Remove", tone: "warning"
        }))) return;

        await saveVerification(false);
    });

    /* ---------- Dealer orders (real data from /api/admin/orders?dealer=<id>) ---------- */
    let allOrders = [];

    const STATUS_LABELS = {
        pending: "Pending", confirmed: "Confirmed", processing: "Processing", out_for_delivery: "Out for delivery",
        delivered: "Delivered", completed: "Completed", cancelled: "Cancelled"
    };
    const statusText = o => o.status_label || STATUS_LABELS[String(o.status || "").toLowerCase()] ||
        String(o.status || "—").replace(/_/g, " ");

    function renderOrders() {
        const body = $("ordersTableBody");
        if (!body) return;
        const q = ($("orderSearch")?.value || "").trim().toLowerCase();
        const statusFilter = $("orderStatusFilter")?.value || "all";

        const rows = allOrders.filter(o => {
            if (statusFilter !== "all" && statusText(o).toLowerCase() !== statusFilter.toLowerCase()) return false;
            if (!q) return true;
            return [o.order_number, o.customer_name, o.product_name, o.customer_phone]
                .some(v => String(v || "").toLowerCase().includes(q));
        });

        const sum = (key) => rows.reduce((t, o) => t + (Number(o[key]) || 0), 0);
        const counted = rows.filter(o => !["cancelled", "canceled", "rejected"].includes(String(o.status).toLowerCase()) && !o.refund_status && String(o.payment_status || "").toLowerCase() !== "refunded");
        /* goods + delivery fee before commission, so gross - commission = dealer net (total_amount is after coin discounts, which GasHub pays) */
        const gross = counted.reduce((t, o) => t + (Number(o.dealer_gross ?? o.total_amount) || 0), 0);
        const commission = counted.reduce((t, o) => t + (Number(o.commission_amount) || 0), 0);
        const net = counted.reduce((t, o) => t + (Number(o.dealer_payout) || 0), 0);
        if ($("grossSalesTotal")) $("grossSalesTotal").textContent = currency(gross);
        if ($("commissionTotal")) $("commissionTotal").textContent = currency(commission);
        if ($("dealerNetTotal")) $("dealerNetTotal").textContent = currency(net);
        if ($("orderCount")) $("orderCount").textContent = String(rows.length);
        if ($("tableCountText")) $("tableCountText").textContent = `Showing ${rows.length} order${rows.length === 1 ? "" : "s"}`;
        if ($("completedOrders")) {
            $("completedOrders").textContent = String(
                allOrders.filter(o => ["completed", "delivered"].includes(String(o.status).toLowerCase())).length
            );
        }

        if (!rows.length) {
            body.innerHTML = `<tr><td colspan="11" class="empty-row">${
                allOrders.length ? "No orders match your search." : "This dealer has no orders yet."
            }</td></tr>`;
            return;
        }

        body.innerHTML = rows.map(o => `
            <tr>
                <td><span class="order-number">${escapeHtml(o.order_number || o.id)}</span>
                    <span class="cell-sub">${escapeHtml(dateLabel(o.created_at))}</span></td>
                <td>${escapeHtml(o.customer_name || "—")}
                    ${o.customer_phone ? `<span class="cell-sub">${escapeHtml(o.customer_phone)}</span>` : ""}</td>
                <td>${escapeHtml(o.product_name || "—")}</td>
                <td>${escapeHtml(o.quantity ?? "—")}</td>
                <td>${escapeHtml(currency(o.total_amount))}</td>
                <td>${escapeHtml(currency(o.commission_amount))}</td>
                <td>${escapeHtml(currency(o.dealer_payout))}</td>
                <td>${escapeHtml(String(o.fulfilment || "—").replace(/_/g, " "))}</td>
                <td>${escapeHtml(o.payment_status_label || o.payment_status || "—")}</td>
                <td>${escapeHtml(statusText(o))}</td>
                <td><button type="button" class="button button-light" data-view-order="${escapeHtml(o.id)}">View</button></td>
            </tr>`).join("");
    }

    async function loadOrders() {
        const body = $("ordersTableBody");
        if (!dealerId) return;
        if (body) body.innerHTML = `<tr><td colspan="11" class="empty-row">Loading orders...</td></tr>`;
        try {
            const result = await apiRequest(`/api/admin/orders?dealer=${encodeURIComponent(dealerId)}`);
            allOrders = Array.isArray(result.orders) ? result.orders : [];
            renderOrders();
        } catch (error) {
            console.error("Unable to load dealer orders:", error);
            if (body) {
                body.innerHTML = `<tr><td colspan="11" class="empty-row">Unable to load orders: ${escapeHtml(error.message)}</td></tr>`;
            }
        }
    }

    async function openOrder(id) {
        const dialog = $("orderDialog");
        const box = $("orderDialogBody");
        if (!dialog || !box) return;
        box.innerHTML = `<p class="empty-row">Loading order...</p>`;
        $("orderDialogTitle").textContent = "Order";
        dialog.showModal();
        try {
            const { order: o } = await apiRequest(`/api/admin/orders/${encodeURIComponent(id)}`);
            $("orderDialogTitle").textContent = o.order_number || "Order";
            const items = (o.items || []).map(i => `
                <tr><td>${escapeHtml(i.product_name || "—")}${i.cylinder_size ? ` (${escapeHtml(i.cylinder_size)})` : ""}</td>
                    <td>${escapeHtml(i.quantity)}</td><td>${escapeHtml(currency(i.unit_price))}</td>
                    <td>${escapeHtml(currency(i.total_price))}</td></tr>`).join("");
            const payments = (o.payments || []).map(p => `
                <tr><td>${escapeHtml(p.method || "—")}</td><td>${escapeHtml(p.status || "—")}</td>
                    <td>${escapeHtml(currency(p.amount))}</td>
                    <td>${escapeHtml(p.mpesa_receipt_number || p.transaction_code || "—")}</td></tr>`).join("");
            const row = (label, value) => `<div><small>${escapeHtml(label)}</small><strong>${escapeHtml(value ?? "—")}</strong></div>`;
            box.innerHTML = `
                <div class="detail-grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">
                    ${row("Status", statusText(o))}
                    ${row("Payment", o.payment_status_label || o.payment_status)}
                    ${row("Customer", o.customer_name)}
                    ${row("Customer phone", o.customer_phone)}
                    ${row("Fulfilment", String(o.fulfilment || "—").replace(/_/g, " "))}
                    ${row("Placed", dateLabel(o.created_at))}
                    ${row("Gross total", currency(o.total_amount))}
                    ${row(`GasHub commission (${o.commission_rate}%)`, currency(o.commission_amount))}
                    ${row("Dealer net", currency(o.dealer_payout))}
                    ${row("Delivery rider", o.rider_name ? `${o.rider_name}${o.rider_phone ? " · " + o.rider_phone : ""}` : "Not assigned")}
                </div>
                <h4 style="margin:16px 0 6px">Items</h4>
                <table class="orders-table"><thead><tr><th>Product</th><th>Qty</th><th>Unit price</th><th>Total</th></tr></thead>
                <tbody>${items || `<tr><td colspan="4" class="empty-row">No items.</td></tr>`}</tbody></table>
                <h4 style="margin:16px 0 6px">Payments</h4>
                <table class="orders-table"><thead><tr><th>Method</th><th>Status</th><th>Amount</th><th>Reference</th></tr></thead>
                <tbody>${payments || `<tr><td colspan="4" class="empty-row">No payments recorded.</td></tr>`}</tbody></table>`;
        } catch (error) {
            box.innerHTML = `<p class="empty-row">Unable to load this order: ${escapeHtml(error.message)}</p>`;
        }
    }

    $("orderSearch")?.addEventListener("input", renderOrders);
    $("orderStatusFilter")?.addEventListener("change", renderOrders);
    $("ordersTableBody")?.addEventListener("click", event => {
        const button = event.target.closest("[data-view-order]");
        if (button) openOrder(button.dataset.viewOrder);
    });

    $("sidebarCollapseButton")?.addEventListener("click", () => {
        $("adminSidebar")?.classList.toggle("open");
        $("sidebarOverlay")?.classList.toggle("show");
    });

    $("mobileMenuButton")?.addEventListener("click", () => {
        $("adminSidebar")?.classList.toggle("open");
        $("sidebarOverlay")?.classList.toggle("show");
    });

    $("sidebarOverlay")?.addEventListener("click", () => {
        $("adminSidebar")?.classList.remove("open");
        $("sidebarOverlay")?.classList.remove("show");
    });

    $("logoutButton")?.addEventListener("click", () => {
        window.location.href = "admin-login.html";
    });

    $("printOrdersButton")?.addEventListener("click", () => window.print());

    document.querySelectorAll("[data-close-dialog]").forEach(button => {
        button.addEventListener("click", () => {
            const dialog = $(button.dataset.closeDialog);
            if (dialog) dialog.close();
        });
    });

    /* ---------------- Collapsible cards (closed by default, so nothing is changed by accident) ---------------- */
    function makeCollapsible(formId) {
        const form = $(formId);
        const card = form && form.closest(".section-card");
        const heading = card && card.querySelector(".section-heading");
        if (!card || !heading || card.dataset.collapsible) return null;
        card.dataset.collapsible = "1";
        const body = document.createElement("div");
        body.className = "collapse-body";
        while (heading.nextSibling) body.appendChild(heading.nextSibling);   /* moving nodes keeps their event handlers */
        card.appendChild(body);
        const chevron = document.createElement("span");
        chevron.className = "collapse-chevron";
        chevron.setAttribute("aria-hidden", "true");
        heading.appendChild(chevron);
        heading.classList.add("collapsible");
        heading.setAttribute("role", "button");
        heading.setAttribute("tabindex", "0");
        const set = open => {
            card.classList.toggle("is-collapsed", !open);
            body.hidden = !open;
            heading.setAttribute("aria-expanded", String(open));
            heading.title = open ? "Click to hide" : "Click to view or edit";
        };
        heading.addEventListener("click", () => set(body.hidden));
        heading.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set(body.hidden); } });
        set(false);
        return set;
    }
    const closeCommercial = makeCollapsible("commercialForm") || (() => {});
    const closePayoutDestination = makeCollapsible("payoutForm") || (() => {});

    loadDealer();
    loadOrders();
    loadPayouts();
})();