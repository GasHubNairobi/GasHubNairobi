/* =========================================================
   GASHUB EXECUTIVE DEALER PORTAL - CORE UNIFIED ENGINE
   File: gashub-core.js
   Central State, Single Dealer Profile, Logo Propagation,
   Admin Approval Workflow, TikTok Badge & Global Watermark
   ========================================================= */

(function (window, document) {
    "use strict";

    const STORAGE_KEY_ACTIVE = "gashub_dealer_active_profile";
    const STORAGE_KEY_PENDING = "gashub_dealer_pending_profile";
    const STORAGE_KEY_STATUS = "gashub_dealer_profile_status";
    const STORAGE_KEY_VERIFIED = "gashub_dealer_verified";

    /* Publishing stock to customers (backend: POST /api/dealers/products/sync) */
    const INVENTORY_KEY = "gashub_dealer_inventory_v2";
    const SYNC_ENDPOINT = "/api/dealers/products/sync";
    const MINE_ENDPOINT = "/api/dealers/products/mine";
    /* Category words the customer product page understands for its Gas / Cylinders / Gas + Cylinder / Accessories filters */
    const TYPE_LABELS = {
        cylinder: "Gas Cylinder",
        refill: "Gas Refill",
        empty: "Empty Cylinder",
        accessory: "Accessory",
        industrial: "Industrial Gas"
    };
    function typeFromLabel(label) {
        const t = String(label || "").toLowerCase();
        if (/access/.test(t)) return "accessory";
        if (/industrial/.test(t)) return "industrial";
        if (/empty/.test(t)) return "empty";
        if (/cylinder/.test(t)) return "cylinder";
        return "refill";
    }

    /* Delivery messengers (riders) and which messenger is on which order */
    const MESSENGERS_KEY = "gashub_dealer_messengers_v1";
    const ASSIGNMENTS_KEY = "gashub_order_messenger_assignments_v1";

    /* Default Authoritative Dealer Profile (Single Source of Truth) */
    const DEFAULT_PROFILE = {
        businessName: "",
        contactName: "",
        businessType: "",
        location: "",
        address: "",
        phone: "",
        email: "",
        registrationNumber: "",
        taxNumber: "",
        logoUrl: "",
        followers: "0",
        reviews: "No reviews yet",
        isVerified: false,
        updatedAt: null
    };
    /* Authentic High-Resolution TikTok Blue Badge SVG */
    const TIKTOK_BADGE_SVG = `
        <svg viewBox="0 0 24 24" class="tiktok-badge-svg" aria-label="Verified EPRA Dealer" style="display:inline-block; vertical-align:middle; width:18px; height:18px; filter:drop-shadow(0 1px 2px rgba(32, 213, 236, 0.45));">
            <path fill="#20d5ec" d="M12 2C13.2 2 14.3 2.7 14.9 3.8C15.8 3.5 16.8 3.6 17.6 4.1C18.4 4.6 19 5.4 19.1 6.4C20.1 6.8 20.9 7.6 21.2 8.6C21.4 9.6 21.1 10.7 20.4 11.5C21 12.3 21.2 13.4 20.9 14.4C20.5 15.4 19.7 16.2 18.7 16.5C18.5 17.5 17.9 18.3 17 18.8C16.1 19.2 15.1 19.3 14.2 18.9C13.5 19.9 12.4 20.5 11.2 20.5C10 20.5 8.9 19.9 8.2 18.9C7.3 19.3 6.3 19.2 5.4 18.8C4.5 18.3 3.9 17.5 3.7 16.5C2.7 16.2 1.9 15.4 1.5 14.4C1.2 13.4 1.4 12.3 2 11.5C1.3 10.7 1 9.6 1.2 8.6C1.5 7.6 2.3 6.8 3.3 6.4C3.4 5.4 4 4.6 4.8 4.1C5.6 3.6 6.6 3.5 7.5 3.8C8.1 2.7 9.2 2 10.4 2H12Z"/>
            <path fill="#ffffff" d="M10.2 15.5L6.7 12L8.1 10.6L10.2 12.7L15.9 7L17.3 8.4L10.2 15.5Z"/>
        </svg>
    `;

    const GasHubCore = {
        /* Retrieve the currently active approved profile */
        getActiveProfile() {
            let sessionDealer = {};
            let sessionUser = {};
            try {
                sessionDealer = JSON.parse(localStorage.getItem("gashub_dealer") || "{}");
                sessionUser = JSON.parse(localStorage.getItem("gashub_dealer_user") || "{}");
            } catch (e) {}

            try {
                const stored = localStorage.getItem(STORAGE_KEY_ACTIVE);
                const parsed = stored ? JSON.parse(stored) : {};

                const businessName = sessionDealer.business_name || parsed.businessName || DEFAULT_PROFILE.businessName;
                const contactName = sessionDealer.contact_person || sessionUser.full_name || parsed.contactName || DEFAULT_PROFILE.contactName;
                const phone = sessionDealer.phone || sessionUser.phone || parsed.phone || DEFAULT_PROFILE.phone;
                const email = sessionDealer.email || sessionUser.email || parsed.email || DEFAULT_PROFILE.email;
                const location = sessionDealer.location || sessionDealer.town || parsed.location || DEFAULT_PROFILE.location;
                const address = sessionDealer.address || parsed.address || DEFAULT_PROFILE.address;
                const isVerified = sessionDealer.verification_active !== undefined ? Boolean(sessionDealer.verification_active) : sessionDealer.is_verified !== undefined ? Boolean(sessionDealer.is_verified) : (parsed.isVerified || localStorage.getItem(STORAGE_KEY_VERIFIED) === "true");

                return {
                    ...DEFAULT_PROFILE,
                    ...parsed,
                    ...sessionDealer,
                    businessName: businessName || "Dealer",
                    contactName: contactName || "",
                    phone: phone || "",
                    email: email || "",
                    location: location || "",
                    address: address || "",
                    latitude: sessionDealer.latitude !== undefined ? sessionDealer.latitude : parsed.latitude,
                    longitude: sessionDealer.longitude !== undefined ? sessionDealer.longitude : parsed.longitude,
                    logoUrl: sessionDealer.logo !== undefined ? (sessionDealer.logo || "") : (parsed.logoUrl || ""),
                    isVerified: Boolean(isVerified),
                    status: sessionDealer.status || "active",
                    followers: String(sessionDealer.follower_count ?? sessionDealer.followers_count ?? parsed.followers ?? "0"),
                    reviews: sessionDealer.rating !== undefined
                        ? `${Number(sessionDealer.rating || 0).toFixed(1)} (${sessionDealer.review_count ?? sessionDealer.reviews_count ?? 0})`
                        : (parsed.reviews || "0.0 (0)")
                };
            } catch (e) {
                console.warn("[GasHubCore] Failed to load active profile:", e);
            }
            return { ...DEFAULT_PROFILE };
        },

        /* Save approved profile to localStorage */
        setActiveProfile(profile) {
            try {
                localStorage.setItem(STORAGE_KEY_ACTIVE, JSON.stringify(profile));
                if (profile.isVerified !== undefined) {
                    localStorage.setItem(STORAGE_KEY_VERIFIED, profile.isVerified ? "true" : "false");
                }
            } catch (e) {
                console.error("[GasHubCore] Failed to save active profile:", e);
            }
            this.syncAcrossPage();
        },

        /* Retrieve pending profile changes awaiting admin approval */
        getPendingProfile() {
            try {
                const pending = localStorage.getItem(STORAGE_KEY_PENDING);
                return pending ? JSON.parse(pending) : null;
            } catch (e) {
                return null;
            }
        },

        /* Submit changes for admin approval */
        submitChangesForApproval(changes) {
            const current = this.getActiveProfile();
            const pending = { ...current, ...changes, submittedAt: new Date().toISOString() };
            try {
                localStorage.setItem(STORAGE_KEY_PENDING, JSON.stringify(pending));
                localStorage.setItem(STORAGE_KEY_STATUS, "pending_approval");
            } catch (e) {
                console.error("[GasHubCore] Failed to queue pending profile:", e);
            }
            return pending;
        },

        /* Admin approves pending changes -> becomes active profile */
        adminApprovePending() {
            const pending = this.getPendingProfile();
            if (pending) {
                pending.updatedAt = new Date().toISOString();
                this.setActiveProfile(pending);
                try {
                    localStorage.removeItem(STORAGE_KEY_PENDING);
                    localStorage.setItem(STORAGE_KEY_STATUS, "approved");
                } catch (e) {}
                this.syncAcrossPage();
                return true;
            }
            return false;
        },

        /* Admin rejects pending changes */
        adminRejectPending() {
            try {
                localStorage.removeItem(STORAGE_KEY_PENDING);
                localStorage.setItem(STORAGE_KEY_STATUS, "rejected");
            } catch (e) {}
            return true;
        },

        /* Returns current approval status: 'approved' | 'pending_approval' */
        getStatus() {
            return localStorage.getItem(STORAGE_KEY_STATUS) || "approved";
        },

        /* Update business logo directly */
        updateBusinessLogo(logoDataUrl) {
            const current = this.getActiveProfile();
            current.logoUrl = logoDataUrl;
            this.setActiveProfile(current);
            this.syncAcrossPage();
        },

        /* Synchronize all page headers, avatars, sidebars, and watermarks */
        syncAcrossPage() {
            const profile = this.getActiveProfile();
            const displayName = profile.businessName || "Dealer";

            // 1. Update Dealer Business Name across headers and cards
            const nameSelectors = [
                "#dealerHeaderName",
                "#sidebarDealerName",
                "#dashboardDealerName",
                "#dealerBusinessName",
                "[data-profile-business-name]",
                ".header-dealer-name",
                ".sidebar-dealer-name"
            ];
            nameSelectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    el.textContent = displayName;
                });
            });

            // Location
            document.querySelectorAll("#dealerBusinessLocation, [data-profile-location]").forEach(el => {
                const locText = [profile.town, profile.location, profile.address].filter(Boolean).join(", ");
                el.textContent = locText || profile.location || "Kenya";
            });

            // Phone & Contact
            document.querySelectorAll("#dealerBusinessPhone, [data-profile-phone]").forEach(el => {
                el.textContent = profile.phone || "—";
            });
            document.querySelectorAll("#dealerContactPerson, [data-profile-contact-name]").forEach(el => {
                el.textContent = profile.contactName || "—";
            });

            // 2. Update Header & Profile Avatars (business picture if there is one, otherwise the first letter).
            //    Every avatar is a fixed-size circle; the picture is added INSIDE it and can never grow past it.
            const initial = (displayName.trim().charAt(0) || "G").toUpperCase();
            const hasLogo = Boolean(profile.logoUrl && profile.logoUrl.trim().length > 10);
            const avatarBoxes = new Set();
            document.querySelectorAll(
                "#dealerAvatarInitial, .dealer-avatar, .header-avatar, [data-profile-avatar], .dealer-profile-large-avatar"
            ).forEach(el => {
                const circle = el.id === "dealerAvatarInitial" ? el.closest(".header-avatar, .dealer-avatar") : null;
                avatarBoxes.add(circle || el);
            });

            avatarBoxes.forEach(box => {
                let letter = box.querySelector(":scope > #dealerAvatarInitial, :scope > .gh-avatar-letter");
                if (!letter) {                       /* circle that had the letter written straight into it */
                    box.textContent = "";
                    letter = document.createElement("span");
                    letter.className = "gh-avatar-letter";
                    box.appendChild(letter);
                }
                letter.textContent = initial;

                let img = box.querySelector(":scope > img.dealer-avatar-img");
                if (hasLogo) {
                    if (!img) {
                        img = document.createElement("img");
                        img.className = "dealer-avatar-img";
                        box.appendChild(img);
                    }
                    img.alt = displayName;
                    if (img.getAttribute("src") !== profile.logoUrl) img.setAttribute("src", profile.logoUrl);
                    box.classList.add("has-logo");
                } else {
                    if (img) img.remove();
                    box.classList.remove("has-logo");
                }
            });

            // 3. Update Followers & Reviews (rating in bold, the number of reviews lighter)
            const followersEl = document.getElementById("sidebarFollowersCount");
            if (followersEl) followersEl.textContent = profile.followers || "0";

            const reviewsEl = document.getElementById("sidebarReviewsCount");
            if (reviewsEl) {
                const txt = String(profile.reviews || "0.0 (0)").trim();
                const m = txt.match(/^(\S+)\s*(\(.*\))?$/);
                reviewsEl.textContent = "";
                const rating = document.createElement("span");
                rating.textContent = m ? m[1] : txt;
                reviewsEl.appendChild(rating);
                if (m && m[2]) {
                    const count = document.createElement("span");
                    count.className = "user-stat-muted";
                    count.textContent = " " + m[2];
                    reviewsEl.appendChild(count);
                }
            }

            // 4. Update TikTok Verified Badge everywhere
            const isVerified = Boolean(profile.isVerified);
            document.querySelectorAll("#sidebarVerifiedBadge, .tiktok-verified-badge").forEach(badge => {
                badge.innerHTML = TIKTOK_BADGE_SVG;
                if (isVerified) {
                    badge.classList.add("verified-active");
                    badge.style.display = "inline-flex";
                    badge.style.opacity = "1";
                    badge.style.filter = "none";
                } else {
                    badge.classList.remove("verified-active");
                    badge.style.display = "none";
                    badge.style.opacity = "0";
                }
            });

            // Update verification request button
            const reqBtn = document.getElementById("btnRequestVerification");
            if (reqBtn) {
                if (isVerified) {
                    reqBtn.classList.add("is-verified");
                    reqBtn.innerHTML = '<i class="fa-solid fa-circle-check fa-sm text-success"></i> <span>EPRA Verified Outlet</span>';
                    reqBtn.disabled = true;
                } else {
                    reqBtn.classList.remove("is-verified");
                    reqBtn.disabled = false;
                }
            }

            // Compliance status text
            const complianceStatus = document.getElementById("dealerAccountStatus");
            if (complianceStatus) {
                complianceStatus.textContent = isVerified ? "EPRA Certified Active • Verified Dealer" : "Safety Compliance • Pending Verification";
            }

            // Bind logout on all logout buttons
            this.bindLogoutButtons();

            // 5. Ensure Visible Watermark Overlay exists
            this.ensureWatermarkOverlay();
        },

        /* Global Logout helper */
        bindLogoutButtons() {
            document.querySelectorAll("[data-dealer-logout], .btn-dealer-logout, #dealerLogoutBtn").forEach(btn => {
                if (btn.dataset.logoutBound) return;
                btn.dataset.logoutBound = "true";
                btn.addEventListener("click", (e) => {
                    e.preventDefault();
                    [localStorage, sessionStorage].forEach(store => {
                        ["gashub_dealer_token", "gashub_dealer_user", "gashub_dealer", "gashub_dealer_id", "gashub_dealer_code", "gashub_dealer_requires_setup"].forEach(k => store.removeItem(k));
                    });
                    window.location.replace("dealer-login.html");
                });
            });
        },

        /* Refresh live dealer data from backend API */
        async refreshDealerFromServer() {
            const token = localStorage.getItem("gashub_dealer_token");
            const dealerId = localStorage.getItem("gashub_dealer_id");
            if (!token || !dealerId) return;

            try {
                const response = await fetch(`/api/dealers/${encodeURIComponent(dealerId)}`, {
                    headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` }
                });
                if (!response.ok) return;
                const result = await response.json();
                if (result.success && result.dealer) {
                    localStorage.setItem("gashub_dealer", JSON.stringify(result.dealer));
                    this.syncAcrossPage();
                }
            } catch (err) {
                // Silently keep cached data if network unreachable
            }
        },

        /* Injects a visible, clean watermark overlay that won't block clicks */
        ensureWatermarkOverlay() {
            let overlay = document.getElementById("gashubGlobalWatermarkOverlay");
            if (!overlay) {
                overlay = document.createElement("div");
                overlay.id = "gashubGlobalWatermarkOverlay";
                overlay.className = "gashub-watermark-overlay";
                overlay.setAttribute("aria-hidden", "true");
                document.body.appendChild(overlay);
            }
        },

        /* =====================================================
           PUBLISH STOCK TO CUSTOMERS
           The dealer's stock is sent to the backend, which saves it;
           customer pages then read it from GET /api/products.
           Cost price, empties, alert level and bay location are
           never sent.
           ===================================================== */
        readInventory() {
            try {
                const parsed = JSON.parse(localStorage.getItem(INVENTORY_KEY) || "[]");
                return Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                return [];
            }
        },

        /* One stock item -> the fields POST /api/dealers/products/sync reads.
           "sku" is how the backend recognises the same product next time. */
        toSyncProduct(p) {
            return {
                sku: String(p.sku || p.id || "").trim(),
                name: String(p.name || "").trim(),
                type: TYPE_LABELS[p.type] || p.type || "Gas",
                size: String(p.size || "").trim(),
                price: Number(p.price) || 0,
                stock: Math.max(0, parseInt(p.stock, 10) || 0),
                available: p.available !== false,
                description: p.description || "",
                image: p.image || ""
            };
        },

        /* Backend row -> dealer stock item (used to restore stock on a new browser) */
        fromServerProduct(p) {
            const type = typeFromLabel(p.category);
            const raw = String(p.cylinder_size ?? "").trim();
            const size = !raw ? "" : (/^\d+(\.\d+)?$/.test(raw) ? raw + (p.cylinder_unit || "kg") : raw);
            return {
                id: p.product_code || `PRD-${p.id}`,
                sku: p.product_code || "",
                brand: "",
                name: p.name || "",
                type,
                size: size || (type === "accessory" ? "Standard Kit" : "13kg"),
                valve: "20mm Clip-On",
                stock: Math.max(0, parseInt(p.stock_quantity, 10) || 0),
                emptyStock: 0,
                lowStockLimit: 5,
                costPrice: 0,
                price: Number(p.price) || 0,
                location: "Main Yard",
                available: p.status !== "inactive",
                description: p.description || "",
                image: p.image || ""
            };
        },

        /* Pull this dealer's saved products from the server. Used only when this
           browser has no stock yet, so a replace-style sync can never wipe the
           server list by sending an empty one. */
        async hydrateFromServer() {
            const token = localStorage.getItem("gashub_dealer_token");
            if (!token) return [];
            try {
                const res = await fetch(MINE_ENDPOINT, {
                    headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` }
                });
                if (!res.ok) return [];
                const data = await res.json();
                return (Array.isArray(data.products) ? data.products : []).map(p => this.fromServerProduct(p));
            } catch (e) {
                return [];
            }
        },

        /* Send the stock to the backend. Resolves { ok, status, message }.
           opts.immediate  send now instead of after a short pause
           opts.allowEmpty allow sending an empty list (dealer deleted their last item) */
        syncInventory(products, opts = {}) {
            const items = (Array.isArray(products) ? products : this.readInventory()).filter(Boolean);
            if (!items.length && !opts.allowEmpty) {
                return Promise.resolve({ ok: false, skipped: true, message: "Nothing to publish." });
            }

            const token = localStorage.getItem("gashub_dealer_token");
            if (!token) {
                if (!this._warnedNoLogin) {
                    this._warnedNoLogin = true;
                    this.showToast("Saved on this device. Log in as a dealer to publish products to customers.", "warning");
                }
                return Promise.resolve({ ok: false, status: 401, message: "Not logged in." });
            }

            const body = JSON.stringify({ products: items.map(p => this.toSyncProduct(p)) });
            const send = async () => {
                try {
                    const res = await fetch(SYNC_ENDPOINT, {
                        method: "POST",
                        headers: {
                            "Accept": "application/json",
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${token}`
                        },
                        body
                    });
                    let data = {};
                    try { data = await res.json(); } catch (e) {}
                    if (res.ok && data.success !== false) {
                        this.showToast("Stock published - customers can see it now.", "success");
                        return { ok: true, status: res.status };
                    }
                    const message = res.status === 401
                        ? "Dealer session expired. Please log in again to publish products."
                        : res.status === 413
                        ? "The photos are too large to publish together. Remove or replace some photos with smaller ones and try again."
                        : ((data.message || `The server refused the update (${res.status}).`) + (data.detail ? ` (${data.detail})` : ""));
                    this.showToast(message, "error");
                    return { ok: false, status: res.status, message };
                } catch (err) {
                    const message = "Saved on this device, but the server could not be reached.";
                    this.showToast(message, "warning");
                    return { ok: false, status: 0, message };
                }
            };

            clearTimeout(this._syncTimer);
            if (this._syncResolve) { this._syncResolve({ ok: true, skipped: true }); this._syncResolve = null; }
            if (opts.immediate) return send();

            return new Promise((resolve) => {
                this._syncResolve = resolve;
                this._syncTimer = setTimeout(async () => {
                    this._syncResolve = null;
                    resolve(await send());
                }, 800);
            });
        },

        /* Shrinks a chosen photo so it fits in storage and uploads quickly */
        readImageCompressed(file, maxSide = 600, quality = 0.75) {
            return new Promise((resolve, reject) => {
                if (file && file.size > 15 * 1024 * 1024) { reject(new Error("That photo is too large. Choose one under 15 MB.")); return; }
                const reader = new FileReader();
                reader.onerror = () => reject(reader.error);
                reader.onload = () => {
                    const img = new Image();
                    img.onerror = () => reject(new Error("That file is not a picture this browser can open. Choose a JPG, PNG or WebP photo."));
                    img.onload = () => {
                        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                        const canvas = document.createElement("canvas");
                        canvas.width = Math.max(1, Math.round(img.width * scale));
                        canvas.height = Math.max(1, Math.round(img.height * scale));
                        const ctx = canvas.getContext("2d");
                        ctx.fillStyle = "#ffffff";
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        resolve(canvas.toDataURL("image/jpeg", quality));
                    };
                    img.src = reader.result;
                };
                reader.readAsDataURL(file);
            });
        },

        /* =====================================================
           DELIVERY MESSENGERS
           A dealer keeps a list of messengers (full name, ID number,
           phone). When an order is for delivery, one of them can be
           assigned to it. The assignment keeps a copy of the messenger's
           details, so an old order still shows who delivered it even if
           that messenger is later edited or removed.
           ===================================================== */
        readMessengers() {
            try {
                const parsed = JSON.parse(localStorage.getItem(MESSENGERS_KEY) || "[]");
                return Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                return [];
            }
        },

        writeMessengers(list) {
            try {
                localStorage.setItem(MESSENGERS_KEY, JSON.stringify(list));
                return true;
            } catch (e) {
                console.error("[GasHubCore] Failed to save messengers:", e);
                return false;
            }
        },

        /* Kenyan mobile numbers: 07xx, 01xx, +2547xx, 2547xx -> 07xxxxxxxx. Returns "" if invalid. */
        normalizePhone(raw) {
            let d = String(raw || "").replace(/[\s\-().]/g, "");
            if (d.startsWith("+")) d = d.slice(1);
            if (/^254[17]\d{8}$/.test(d)) d = "0" + d.slice(3);
            else if (/^[17]\d{8}$/.test(d)) d = "0" + d;
            return /^0[17]\d{8}$/.test(d) ? d : "";
        },

        /* Phone for display: 0712 345 678 */
        formatPhone(phone) {
            const d = String(phone || "");
            return /^\d{10}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : d;
        },

        /* Checks the three fields. Returns { ok, errors:{fullName,idNumber,phone}, values }.
           ignoreId lets an edit keep its own ID number / phone without a duplicate error. */
        validateMessenger(input, ignoreId) {
            const fullName = String(input.fullName || "").trim().replace(/\s+/g, " ");
            const idNumber = String(input.idNumber || "").trim().toUpperCase();
            const phone = this.normalizePhone(input.phone);
            const errors = {};
            const others = this.readMessengers().filter(m => m.id !== ignoreId);

            if (fullName.split(" ").filter(Boolean).length < 2 || fullName.length < 3) {
                errors.fullName = "Enter the messenger's full name (first and last name).";
            }
            if (!/^[A-Z0-9]{6,12}$/.test(idNumber)) {
                errors.idNumber = "Enter a valid ID number (6-12 letters or digits).";
            } else if (others.some(m => m.idNumber === idNumber)) {
                errors.idNumber = "A messenger with this ID number already exists.";
            }
            if (!phone) {
                errors.phone = "Enter a valid Kenyan phone number, e.g. 0712 345 678.";
            } else if (others.some(m => m.phone === phone)) {
                errors.phone = "A messenger with this phone number already exists.";
            }
            return { ok: Object.keys(errors).length === 0, errors, values: { fullName, idNumber, phone } };
        },

        addMessenger(input) {
            const check = this.validateMessenger(input);
            if (!check.ok) return check;
            const list = this.readMessengers();
            const messenger = {
                id: "MSG-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
                ...check.values,
                createdAt: new Date().toISOString()
            };
            list.push(messenger);
            this.writeMessengers(list);
            return { ok: true, messenger };
        },

        updateMessenger(id, input) {
            const check = this.validateMessenger(input, id);
            if (!check.ok) return check;
            const list = this.readMessengers();
            const idx = list.findIndex(m => m.id === id);
            if (idx === -1) return { ok: false, errors: { fullName: "This messenger no longer exists." } };
            list[idx] = { ...list[idx], ...check.values, updatedAt: new Date().toISOString() };
            this.writeMessengers(list);
            return { ok: true, messenger: list[idx] };
        },

        removeMessenger(id) {
            this.writeMessengers(this.readMessengers().filter(m => m.id !== id));
        },

        readAssignments() {
            try {
                const parsed = JSON.parse(localStorage.getItem(ASSIGNMENTS_KEY) || "{}");
                return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
            } catch (e) {
                return {};
            }
        },

        /* The messenger on one order, or null */
        getOrderMessenger(orderId) {
            return this.readAssignments()[String(orderId)] || null;
        },

        assignMessengerToOrder(orderId, messengerId) {
            const m = this.readMessengers().find(x => x.id === messengerId);
            if (!m) return null;
            const all = this.readAssignments();
            all[String(orderId)] = {
                messengerId: m.id,
                fullName: m.fullName,
                idNumber: m.idNumber,
                phone: m.phone,
                assignedAt: new Date().toISOString()
            };
            try { localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(all)); } catch (e) { return null; }
            return all[String(orderId)];
        },

        unassignOrderMessenger(orderId) {
            const all = this.readAssignments();
            delete all[String(orderId)];
            try { localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(all)); } catch (e) {}
        },

        /* How many orders each messenger has been given: { messengerId: count } */
        countAssignmentsByMessenger() {
            const counts = {};
            Object.values(this.readAssignments()).forEach(a => {
                counts[a.messengerId] = (counts[a.messengerId] || 0) + 1;
            });
            return counts;
        },

        /* Toast notification helper */
        showToast(message, type = "info") {
            let container = document.getElementById("gashubToastContainer");
            if (!container) {
                container = document.createElement("div");
                container.id = "gashubToastContainer";
                container.style.cssText = "position:fixed; top:20px; right:20px; z-index:999999; display:flex; flex-direction:column; gap:10px; pointer-events:none;";
                document.body.appendChild(container);
            }

            const toast = document.createElement("div");
            toast.style.cssText = `
                padding: 12px 18px;
                border-radius: 8px;
                font-family: 'Inter', sans-serif;
                font-size: 13px;
                font-weight: 600;
                color: #ffffff;
                background: ${type === "success" ? "#059669" : type === "error" ? "#dc2626" : type === "warning" ? "#d97706" : "#2563eb"};
                box-shadow: 0 4px 12px rgba(0,0,0,0.18);
                pointer-events: auto;
                display: flex;
                align-items: center;
                gap: 10px;
                animation: toastSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            `;

            const icon = type === "success" ? "fa-circle-check" : type === "error" ? "fa-circle-xmark" : type === "warning" ? "fa-triangle-exclamation" : "fa-circle-info";
            toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
            container.appendChild(toast);

            setTimeout(() => {
                toast.style.opacity = "0";
                toast.style.transition = "opacity 0.3s ease";
                setTimeout(() => toast.remove(), 300);
            }, 3800);
        }
    };

    // Auto-run on DOM load
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            GasHubCore.syncAcrossPage();
            GasHubCore.refreshDealerFromServer();
        });
    } else {
        GasHubCore.syncAcrossPage();
        GasHubCore.refreshDealerFromServer();
    }

    // Tell the server this dealer is online, so customers see "Active now" instead of "Offline".
    function dealerHeartbeat() {
        try {
            const token = localStorage.getItem("gashub_dealer_token");
            if (!token || document.hidden) return;
            fetch("/api/dealers/heartbeat", { method: "POST", headers: { Authorization: "Bearer " + token }, keepalive: true }).catch(() => {});
        } catch (e) { /* never break the page */ }
    }
    dealerHeartbeat();
    setInterval(dealerHeartbeat, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) dealerHeartbeat(); });

    // Expose to global window
    window.GasHubCore = GasHubCore;
    window.TIKTOK_BADGE_SVG = TIKTOK_BADGE_SVG;

})(window, document);