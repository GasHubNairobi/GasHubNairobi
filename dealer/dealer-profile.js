/* =========================================================
   GASHUB EXECUTIVE DEALER PORTAL - OUTLET PROFILE ENGINE
   File: dealer-profile.js
   Full Business Profile Management, Interactive Map Location Picker,
   Global Logo Propagation, and Admin Approval Workflow
   ========================================================= */

document.addEventListener("DOMContentLoaded", function () {
    DealerProfileApp.init();
});

const DealerProfileApp = (function () {
    "use strict";

    let leafletMap = null;
    let mapMarker = null;
    let selectedCoords = { lat: -1.2921, lng: 36.8219 };
    let selectedAddress = "Nairobi Central, Commercial Bay A";

    /* Kenyan commercial hubs quick dictionary */
    const KENYA_LOCATIONS = {
        "nairobi": { lat: -1.2921, lng: 36.8219, label: "Nairobi Central, Commercial Bay A" },
        "westlands": { lat: -1.2673, lng: 36.8115, label: "Westlands Commercial Hub, Nairobi" },
        "industrial area": { lat: -1.3125, lng: 36.8524, label: "Enterprise Road, Industrial Area, Nairobi" },
        "kilimani": { lat: -1.2892, lng: 36.7865, label: "Argwings Kodhek, Kilimani, Nairobi" },
        "mombasa": { lat: -4.0435, lng: 39.6682, label: "Mombasa CBD & Port Depot, Coast" },
        "nyali": { lat: -4.0256, lng: 39.7042, label: "Links Road, Nyali, Mombasa" },
        "kisumu": { lat: -0.0917, lng: 34.7680, label: "Kisumu Central Depot, Lake Basin" },
        "nakuru": { lat: -0.3031, lng: 36.0800, label: "Kenyatta Avenue, Nakuru Central" },
        "eldoret": { lat: 0.5143, lng: 35.2698, label: "Uganda Road Commercial Bay, Eldoret" },
        "thika": { lat: -1.0333, lng: 37.0694, label: "Garissa Road, Thika Depot" }
    };

    function init() {
        populateFormFromActiveProfile();
        checkAndRenderApprovalStatus();
        refreshAccountStatus();
        setInterval(refreshAccountStatus, 60000);
        initBusinessForm();
        initContactForm();
        initLogoHandlers();
        initMapLocationPicker();
        initVerificationRequest();
        initWorkingHours();
    }

    /* =========================================================
       1. POPULATE FORM & CARDS FROM UNIFIED GASHUB CORE
       ========================================================= */
    function populateFormFromActiveProfile() {
        if (!window.GasHubCore) return;

        const profile = GasHubCore.getActiveProfile();
        const pending = GasHubCore.getPendingProfile();
        // If pending approval exists, preview pending in the form so dealer sees their submission
        const displayData = pending || profile;

        // name, location and address always come from the saved (server) profile
        setVal("profileBusinessName", profile.businessName || "");
        setVal("profileBusinessType", displayData.businessType || "Authorized LPG Distributor");
        setVal("profileLocation", profile.location || "");
        setVal("profileAddress", profile.address || "");
        setVal("profileRegistrationNumber", displayData.registrationNumber || "");
        setVal("profileTaxNumber", displayData.taxNumber || "");

        setVal("profileContactName", displayData.contactName || "");
        setVal("profilePhone", displayData.phone || "");
        setVal("profileEmail", displayData.email || "");

        setText("[data-profile-business-name]", profile.businessName || "GasHub Depot");
        setText("[data-profile-contact-name]", profile.contactName || "Dealer");
        setText("[data-profile-location]", profile.location || "—");
        setText("[data-profile-phone]", profile.phone || "—");
        setText("[data-profile-email]", profile.email || "—");

        // The picture itself is drawn by GasHubCore.syncAcrossPage() below

        GasHubCore.syncAcrossPage();
    }

    /* =========================================================
       2. ADMIN APPROVAL BANNER & NOTIFICATION
       ========================================================= */
    function checkAndRenderApprovalStatus() {
        const banner = document.getElementById("profileApprovalBanner");
        const statusPill = document.getElementById("profileStatusPill");
        const statusText = document.getElementById("profileStatusText");
        const detailsText = document.getElementById("pendingApprovalDetailsText");

        const status = GasHubCore.getStatus();
        const pending = GasHubCore.getPendingProfile();
        const accountStatus = String((GasHubCore.getActiveProfile() || {}).status || "active").toLowerCase();

        // The admin's decision (suspended / disabled) always shows instead of "Active"
        if (accountStatus === "suspended" || accountStatus === "inactive" || accountStatus === "disabled") {
            const suspended = accountStatus === "suspended";
            if (banner) banner.hidden = true;
            if (statusPill) {
                statusPill.className = "dealer-profile-account-status " + (suspended ? "suspended" : "inactive");
            }
            if (statusText) {
                statusText.textContent = suspended ? "Suspended Dealer Account" : "Inactive Dealer Account";
            }
            return;
        }

        if (status === "pending_approval" && pending) {
            if (banner) banner.hidden = false;
            if (statusPill) {
                statusPill.className = "dealer-profile-account-status pending";
            }
            if (statusText) {
                statusText.textContent = "Pending Admin Approval";
            }
            if (detailsText) {
                detailsText.innerHTML = `<strong>Queued Update:</strong> ${escapeHtml(pending.businessName)} • ${escapeHtml(pending.location)} • Phone: ${escapeHtml(pending.phone)}. <em>Awaiting EPRA &amp; GasHub Admin verification before going live.</em>`;
            }
        } else {
            if (banner) banner.hidden = true;
            if (statusPill) {
                statusPill.className = "dealer-profile-account-status";
            }
            if (statusText) {
                statusText.textContent = "Active Dealer Account";
            }
        }
    }

    /* Ask the server for the dealer's current account status (the admin may have suspended it) */
    async function refreshAccountStatus() {
        const token = localStorage.getItem("gashub_dealer_token");
        const dealerId = localStorage.getItem("gashub_dealer_id");
        if (!token || !dealerId) return;
        try {
            const response = await fetch("/api/dealers/" + encodeURIComponent(dealerId), {
                headers: { "Accept": "application/json", "Authorization": "Bearer " + token }
            });
            if (!response.ok) return;
            const result = await response.json();
            if (result && result.success && result.dealer) {
                const cached = JSON.parse(localStorage.getItem("gashub_dealer") || "{}");
                localStorage.setItem("gashub_dealer", JSON.stringify(Object.assign({}, cached, { status: result.dealer.status })));
                checkAndRenderApprovalStatus();
            }
        } catch (err) { /* keep what is shown */ }
    }

    /* =========================================================
       3. BUSINESS PROFILE FORM SUBMISSION
       ========================================================= */
    const BUSINESS_PROFILE_ENDPOINT = "/api/dealers/profile/mine";
    let coordsChosen = false;      // true once the dealer picked a spot on the map
    let nameChangeState = null;    // { can_change, next_change_at, days_left } from the server

    async function businessProfileRequest(method, body) {
        const token = localStorage.getItem("gashub_dealer_token");
        if (!token) throw new Error("Your session has expired. Please sign in again.");
        const response = await fetch(BUSINESS_PROFILE_ENDPOINT, {
            method: method,
            headers: Object.assign(
                { "Accept": "application/json", "Authorization": "Bearer " + token },
                body ? { "Content-Type": "application/json" } : {}
            ),
            body: body ? JSON.stringify(body) : undefined
        });
        const result = await response.json().catch(function () { return {}; });
        if (!response.ok || result.success === false) {
            throw new Error(result.message || "Request failed (" + response.status + ")");
        }
        return result;
    }

    function formatLongDate(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Nairobi" });
    }

    /* Shows whether the business name can be changed now, or when it unlocks */
    function renderNameChangeHint(info) {
        nameChangeState = info || null;
        const input = document.getElementById("profileBusinessName");
        if (!input) return;

        let hint = document.getElementById("businessNameHint");
        if (!hint) {
            hint = document.createElement("small");
            hint.id = "businessNameHint";
            hint.className = "dealer-profile-card-description";
            hint.style.display = "block";
            hint.style.marginTop = "6px";
            const group = input.closest(".dealer-profile-form-group");
            (group || input.parentNode).appendChild(hint);
        }

        if (info && info.can_change === false) {
            hint.textContent = "You changed your business name recently. You can change it again on " +
                formatLongDate(info.next_change_at) + " (" + info.days_left + " day" + (info.days_left === 1 ? "" : "s") + " left).";
        } else {
            hint.textContent = "You can change your business name once every 30 days.";
        }
    }

    /* Put the server's saved business details into the page and the cached dealer record */
    function applyServerBusinessProfile(dealer) {
        if (!dealer) return;
        try {
            const cached = JSON.parse(localStorage.getItem("gashub_dealer") || "{}");
            localStorage.setItem("gashub_dealer", JSON.stringify(Object.assign({}, cached, {
                business_name: dealer.business_name,
                location: dealer.location,
                address: dealer.address,
                latitude: dealer.latitude,
                longitude: dealer.longitude
            })));
        } catch (err) { /* cache only */ }
    }

    async function loadBusinessProfileFromServer() {
        try {
            const result = await businessProfileRequest("GET");
            applyServerBusinessProfile(result.dealer);
            populateFormFromActiveProfile();
            renderNameChangeHint(result.name_change);
        } catch (err) {
            console.warn("Could not load business profile from the server:", err.message);
            renderNameChangeHint(null);
        }
    }

    function initBusinessForm() {
        const form = document.getElementById("dealerBusinessProfileForm");
        if (!form) return;

        renderNameChangeHint(null);
        loadBusinessProfileFromServer();

        form.addEventListener("submit", async function (e) {
            e.preventDefault();
            clearErrors();

            const businessName = getVal("profileBusinessName").trim();
            const businessType = getVal("profileBusinessType");
            const location = getVal("profileLocation").trim();
            const address = getVal("profileAddress").trim();
            const registrationNumber = getVal("profileRegistrationNumber").trim();
            const taxNumber = getVal("profileTaxNumber").trim();

            let valid = true;
            if (!businessName) {
                setError("profileBusinessName", "Business name is required.");
                valid = false;
            }
            if (!location) {
                setError("profileLocation", "Business location is required. Use 'Pin / Choose on Map'.");
                valid = false;
            }

            const currentName = String((GasHubCore.getActiveProfile() || {}).businessName || "").trim();
            if (businessName && businessName !== currentName && nameChangeState && nameChangeState.can_change === false) {
                setError("profileBusinessName", "You can change your business name again on " + formatLongDate(nameChangeState.next_change_at) + ".");
                valid = false;
            }

            if (!valid) {
                GasHubCore.showToast("Please fix the business details highlighted below.", "error");
                return;
            }

            const payload = { businessName, location, address };
            if (coordsChosen) {
                payload.latitude = selectedCoords.lat;
                payload.longitude = selectedCoords.lng;
            }

            const saveBtn = document.getElementById("saveBusinessProfile");
            if (saveBtn) saveBtn.disabled = true;

            try {
                const result = await businessProfileRequest("PUT", payload);
                applyServerBusinessProfile(result.dealer);

                // business type, registration and tax numbers are kept on this device only
                const profile = GasHubCore.getActiveProfile();
                GasHubCore.setActiveProfile(Object.assign({}, profile, { businessType, registrationNumber, taxNumber }));

                coordsChosen = false;
                populateFormFromActiveProfile();
                renderNameChangeHint(result.name_change);
                GasHubCore.showToast(result.message || "Business information saved.", "success");
            } catch (err) {
                GasHubCore.showToast(err.message || "Business information was not saved.", "error");
                loadBusinessProfileFromServer();
            } finally {
                if (saveBtn) saveBtn.disabled = false;
            }
        });

        // Reset button
        const resetBtn = document.getElementById("resetBusinessProfile") || document.getElementById("resetBusinessProfileButton");
        if (resetBtn) {
            resetBtn.addEventListener("click", function () {
                clearErrors();
                coordsChosen = false;
                populateFormFromActiveProfile();
                GasHubCore.showToast("Business form reverted to your saved details.", "info");
            });
        }
    }

    /* =========================================================
       4. CONTACT PROFILE FORM SUBMISSION
       ========================================================= */
    function initContactForm() {
        const form = document.getElementById("dealerContactProfileForm");
        if (!form) return;

        form.addEventListener("submit", function (e) {
            e.preventDefault();
            clearErrors();

            const contactName = getVal("profileContactName").trim();
            const phone = getVal("profilePhone").trim();
            const email = getVal("profileEmail").trim();

            let valid = true;
            if (!contactName) {
                setError("profileContactName", "Contact person name is required.");
                valid = false;
            }
            if (!phone) {
                setError("profilePhone", "Valid phone number is required.");
                valid = false;
            }

            if (!valid) {
                GasHubCore.showToast("Please complete the required contact fields.", "error");
                return;
            }

            const updates = {
                contactName,
                phone,
                email
            };

            GasHubCore.submitChangesForApproval(updates);
            checkAndRenderApprovalStatus();
            GasHubCore.showToast("Contact information submitted for GasHub Admin Review.", "warning");
        });
    }

    /* =========================================================
       5. BUSINESS LOGO UPLOAD & GLOBAL AVATAR PROPAGATION
       ========================================================= */
    /* Shrinks the chosen picture so it is quick to save and load everywhere */
    function shrinkImage(file, maxSide) {
        return new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onerror = function () { reject(new Error("Could not read that image.")); };
            reader.onload = function () {
                const img = new Image();
                img.onerror = function () { reject(new Error("That file is not a valid image.")); };
                img.onload = function () {
                    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.max(1, Math.round(img.width * scale));
                    canvas.height = Math.max(1, Math.round(img.height * scale));
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    let out = canvas.toDataURL("image/webp", 0.85);
                    if (out.indexOf("data:image/webp") !== 0) out = canvas.toDataURL("image/jpeg", 0.85);
                    resolve(out);
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    /* Saves the logo on the server, then updates this device so every page shows it */
    async function saveLogoToServer(logo) {
        const token = localStorage.getItem("gashub_dealer_token");
        if (!token) throw new Error("Your session has expired. Please sign in again.");
        const response = await fetch("/api/dealers/logo/mine", {
            method: "PUT",
            headers: { "Accept": "application/json", "Content-Type": "application/json", "Authorization": "Bearer " + token },
            body: JSON.stringify({ logo: logo })
        });
        const result = await response.json().catch(function () { return {}; });
        if (!response.ok || result.success === false) {
            throw new Error(result.message || "Request failed (" + response.status + ")");
        }
        try {
            const cached = JSON.parse(localStorage.getItem("gashub_dealer") || "{}");
            localStorage.setItem("gashub_dealer", JSON.stringify(Object.assign({}, cached, { logo: result.logo || "" })));
        } catch (err) { /* cache only */ }
        GasHubCore.updateBusinessLogo(result.logo || "");
        return result;
    }

    /* Photo options (same idea as WhatsApp): Upload photo opens the gallery, Take photo opens the camera,
       and the trash button removes it. The picture is saved the moment it is chosen. */
    function initLogoHandlers() {
        const byId = (id) => document.getElementById(id);
        const galleryInput = byId("profilePhotoGallery");
        const cameraInput = byId("profilePhotoCamera");
        const galleryBtn = byId("btnPhotoGallery");
        const cameraBtn = byId("btnPhotoCamera");
        const removeBtn = byId("btnPhotoRemove");
        const avatar = document.querySelector(".dealer-profile-large-avatar");
        if (!galleryInput || !cameraInput || !galleryBtn || !cameraBtn) return;

        const controls = [galleryBtn, cameraBtn, removeBtn].filter(Boolean);
        function setBusy(busy) {
            controls.forEach(function (c) { c.disabled = busy; });
            if (avatar) avatar.classList.toggle("is-saving", busy);
        }
        function refreshRemoveButton() {
            if (removeBtn) removeBtn.hidden = !(avatar && avatar.classList.contains("has-logo"));
        }

        galleryBtn.addEventListener("click", function () { galleryInput.click(); });
        cameraBtn.addEventListener("click", function () { cameraInput.click(); });

        async function onPicked(input) {
            const file = input.files && input.files[0];
            input.value = "";                                   /* lets the same photo be chosen again */
            if (!file) return;

            if (!/^image\//i.test(file.type)) {
                GasHubCore.showToast("Please choose a photo (JPG, PNG or WebP).", "error");
                return;
            }
            if (file.size > 15 * 1024 * 1024) {
                GasHubCore.showToast("That photo is too large. Please choose one under 15MB.", "error");
                return;
            }

            setBusy(true);
            try {
                const dataUrl = await shrinkImage(file, 512);   /* small and quick to load everywhere */
                await saveLogoToServer(dataUrl);
                GasHubCore.showToast("Photo saved. Customers and admin will now see it.", "success");
            } catch (err) {
                GasHubCore.showToast("Photo was not saved: " + err.message, "error");
            } finally {
                setBusy(false);
                refreshRemoveButton();
            }
        }
        galleryInput.addEventListener("change", function () { onPicked(galleryInput); });
        cameraInput.addEventListener("change", function () { onPicked(cameraInput); });

        if (removeBtn) {
            removeBtn.addEventListener("click", async function () {
                const ok = await GasHubDialog.confirm({
                    title: "Remove photo?",
                    message: "Your business photo will be removed and your first letter will show instead.",
                    confirmText: "Remove",
                    tone: "danger"
                });
                if (!ok) return;
                setBusy(true);
                try {
                    await saveLogoToServer("");
                    GasHubCore.showToast("Photo removed.", "info");
                } catch (err) {
                    GasHubCore.showToast("Photo was not removed: " + err.message, "error");
                } finally {
                    setBusy(false);
                    refreshRemoveButton();
                }
            });
        }

        /* the trash button follows whether a picture is showing */
        if (avatar && window.MutationObserver) {
            new MutationObserver(refreshRemoveButton).observe(avatar, { attributes: true, attributeFilter: ["class"] });
        }
        refreshRemoveButton();
    }

    /* =========================================================
       6. INTERACTIVE MAP LOCATION PICKER (LEAFLET + GPS)
       ========================================================= */
    function initMapLocationPicker() {
        const openBtn = document.getElementById("btnOpenLocationMapPicker");
        const modal = document.getElementById("locationPickerModalBackdrop");
        const closeBtn = document.getElementById("closeLocationModalBtn");
        const cancelBtn = document.getElementById("cancelLocationPickerBtn");
        const confirmBtn = document.getElementById("confirmLocationPickerBtn");

        const gpsBtn = document.getElementById("btnPinCurrentGpsLocation");
        const searchInput = document.getElementById("mapSearchTownInput");

        if (!openBtn || !modal) return;

        openBtn.addEventListener("click", function () {
            modal.hidden = false;
            setupLeafletMap();
        });

        const closeModal = () => { modal.hidden = true; };
        if (closeBtn) closeBtn.addEventListener("click", closeModal);
        if (cancelBtn) cancelBtn.addEventListener("click", closeModal);

        // Confirm Selected Location
        if (confirmBtn) {
            confirmBtn.addEventListener("click", function () {
                const locInput = document.getElementById("profileLocation");
                const addrInput = document.getElementById("profileAddress");

                coordsChosen = true;
                if (locInput) locInput.value = selectedAddress;
                if (addrInput && !addrInput.value) {
                    addrInput.value = `${selectedAddress} (GPS: ${selectedCoords.lat.toFixed(4)}, ${selectedCoords.lng.toFixed(4)})`;
                }

                closeModal();
                GasHubCore.showToast(`Location set to: ${selectedAddress}. Click 'Save Changes' to save it.`, "success");
            });
        }

        // GPS Current Location Button
        if (gpsBtn) {
            gpsBtn.addEventListener("click", function () {
                if (!navigator.geolocation) {
                    GasHubCore.showToast("Geolocation is not supported by your browser.", "error");
                    return;
                }

                gpsBtn.disabled = true;
                gpsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Pinning GPS...</span>';

                navigator.geolocation.getCurrentPosition(
                    function (pos) {
                        gpsBtn.disabled = false;
                        gpsBtn.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> <span>Pin My Current GPS Location</span>';

                        const lat = pos.coords.latitude;
                        const lng = pos.coords.longitude;
                        selectedCoords = { lat, lng };

                        // Reverse lookup or friendly label
                        selectedAddress = `Nairobi Depot (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
                        updateMapMarker(lat, lng, "Current GPS Position");
                        updateLocationDisplay(selectedAddress, lat, lng);
                        GasHubCore.showToast("Current GPS Location pinned successfully!", "success");
                    },
                    function (err) {
                        gpsBtn.disabled = false;
                        gpsBtn.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> <span>Pin My Current GPS Location</span>';
                        GasHubCore.showToast("GPS access denied or unavailable. You can click on the map to pin any location.", "warning");
                    },
                    { enableHighAccuracy: true, timeout: 8000 }
                );
            });
        }

        // Search Input
        if (searchInput) {
            searchInput.addEventListener("input", function () {
                const query = this.value.trim().toLowerCase();
                if (!query) return;

                for (const [key, loc] of Object.entries(KENYA_LOCATIONS)) {
                    if (key.includes(query) || loc.label.toLowerCase().includes(query)) {
                        selectedCoords = { lat: loc.lat, lng: loc.lng };
                        selectedAddress = loc.label;
                        updateMapMarker(loc.lat, loc.lng, loc.label);
                        updateLocationDisplay(loc.label, loc.lat, loc.lng);
                        break;
                    }
                }
            });
        }
    }

    function setupLeafletMap() {
        const container = document.getElementById("dealerLocationMap");
        if (!container) return;

        // Leaflet already initialized?
        if (leafletMap) {
            setTimeout(() => {
                leafletMap.invalidateSize();
            }, 250);
            return;
        }

        // Check if Leaflet library is loaded
        if (typeof L === "undefined") {
            container.innerHTML = `
                <div style="padding:40px; text-align:center; color:#64748b;">
                    <i class="fa-solid fa-map-location-dot fa-3x" style="color:#d97706; margin-bottom:12px;"></i>
                    <p style="font-weight:600;">Interactive Map Ready</p>
                    <p style="font-size:12px;">Click below to pick a major Kenya depot location:</p>
                    <div style="display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-top:14px;">
                        ${Object.values(KENYA_LOCATIONS).map(loc => `
                            <button type="button" class="btn btn-sm btn-secondary" onclick="DealerProfileApp.selectQuickLocation('${loc.label}', ${loc.lat}, ${loc.lng})">
                                ${loc.label.split(',')[0]}
                            </button>
                        `).join('')}
                    </div>
                </div>
            `;
            return;
        }

        // Init map
        try {
            const profile = (window.GasHubCore && GasHubCore.getActiveProfile) ? GasHubCore.getActiveProfile() : {};
            if (profile.latitude && profile.longitude && !isNaN(Number(profile.latitude)) && !isNaN(Number(profile.longitude))) {
                selectedCoords = { lat: Number(profile.latitude), lng: Number(profile.longitude) };
                selectedAddress = profile.location || profile.address || `Dealer Depot (${selectedCoords.lat.toFixed(4)}, ${selectedCoords.lng.toFixed(4)})`;
            }

            leafletMap = L.map("dealerLocationMap").setView([selectedCoords.lat, selectedCoords.lng], 14);
            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                attribution: "&copy; OpenStreetMap contributors",
                maxZoom: 19
            }).addTo(leafletMap);

            mapMarker = L.marker([selectedCoords.lat, selectedCoords.lng], { draggable: true }).addTo(leafletMap);

            mapMarker.on("dragend", function (e) {
                const pos = e.target.getLatLng();
                selectedCoords = { lat: pos.lat, lng: pos.lng };
                selectedAddress = `Custom Depot Pin (${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)})`;
                updateLocationDisplay(selectedAddress, pos.lat, pos.lng);
            });

            leafletMap.on("click", function (e) {
                const pos = e.latlng;
                selectedCoords = { lat: pos.lat, lng: pos.lng };
                selectedAddress = `Selected Depot Location (${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)})`;
                updateMapMarker(pos.lat, pos.lng, selectedAddress);
                updateLocationDisplay(selectedAddress, pos.lat, pos.lng);
            });

            setTimeout(() => {
                leafletMap.invalidateSize();
            }, 300);
        } catch (err) {
            console.warn("[DealerProfileApp] Map init fallback:", err);
        }
    }

    function updateMapMarker(lat, lng, popupText) {
        if (!leafletMap) return;
        leafletMap.setView([lat, lng], 14);
        if (mapMarker) {
            mapMarker.setLatLng([lat, lng]);
            mapMarker.bindPopup(`<strong>${popupText}</strong>`).openPopup();
        }
    }

    function updateLocationDisplay(label, lat, lng) {
        const display = document.getElementById("selectedLocationDisplay");
        if (display) {
            display.textContent = `${label} [${lat.toFixed(4)}, ${lng.toFixed(4)}]`;
        }
    }

    /* Helper for fallback selection */
    function selectQuickLocation(label, lat, lng) {
        selectedCoords = { lat, lng };
        selectedAddress = label;
        updateLocationDisplay(label, lat, lng);
        GasHubCore.showToast(`Selected: ${label}`, "info");
    }

    /* =========================================================
       7. VERIFICATION REQUEST (BADGE / GET VERIFIED BUTTON + PAYMENT)
       ---------------------------------------------------------
       Status: none -> pending (paid, waiting for admin) -> verified
       Fee = the amount the GasHub Admin set for THIS dealer.
       ========================================================= */

    // Set to true if the badge should be given immediately after payment
    // (instead of waiting for the GasHub Admin to approve it).
    const VERIFY_INSTANTLY_AFTER_PAYMENT = false;

    let verificationPaymentBusy = false;

    function getDealerId() {
        const p = (window.GasHubCore && GasHubCore.getActiveProfile && GasHubCore.getActiveProfile()) || {};
        return String(p.dealerId || p.dealer_id || p.id || "default");
    }

    /* Fee set by admin for this dealer. Returns a number, or null when not set yet.
       Reads GasHubCore.getVerificationFee(dealerId) if it exists, otherwise
       localStorage "gashub_verification_fees" = { "<dealerId>": 2500 } */
    function getAssignedVerificationFee() {
        try {
            if (window.GasHubCore && typeof GasHubCore.getVerificationFee === "function") {
                const coreFee = Number(GasHubCore.getVerificationFee(getDealerId()));
                if (coreFee > 0) return coreFee;
            }
        } catch (err) { /* continue */ }

        try {
            const fees = JSON.parse(localStorage.getItem("gashub_verification_fees")) || {};
            const fee = Number(fees[getDealerId()]);
            if (fee > 0) return fee;
        } catch (err) { /* continue */ }

        return null;
    }

    function formatKsh(amount) {
        return "KSh " + Number(amount).toLocaleString("en-KE");
    }

    function getVerificationState() {
        if (localStorage.getItem("gashub_dealer_verified") === "true") return "verified";
        try {
            const rec = JSON.parse(localStorage.getItem("gashub_dealer_verification"));
            if (rec && rec.status) return rec.status;
        } catch (err) { /* continue */ }
        return "none";
    }

    function renderVerificationState() {
        const state = getVerificationState();
        const verified = state === "verified";
        const pending = state === "pending";

        // Profile card: badge or "Get verified" button next to the business name
        const profileBadge = document.getElementById("profileVerifiedBadge");
        const profileBtn = document.getElementById("btnProfileRequestVerification");
        const profileBtnText = document.getElementById("profileVerificationBtnText");

        if (profileBadge) profileBadge.hidden = !verified;
        if (profileBtn) {
            profileBtn.hidden = verified;
            profileBtn.disabled = pending;
            profileBtn.classList.toggle("is-pending", pending);
        }
        if (profileBtnText) profileBtnText.textContent = pending ? "Verification pending" : "Get verified";

        // Sidebar mini-profile
        const sidebarBadge = document.getElementById("sidebarVerifiedBadge");
        const sidebarBtn = document.getElementById("btnRequestVerification");
        if (sidebarBadge) sidebarBadge.classList.toggle("verified-active", verified);
        if (sidebarBtn) {
            if (verified) {
                sidebarBtn.classList.add("is-verified");
                sidebarBtn.innerHTML = '<i class="fa-solid fa-circle-check fa-sm text-success"></i> <span>EPRA Verified Outlet</span>';
                sidebarBtn.disabled = true;
            } else if (pending) {
                const label = document.getElementById("verificationBtnText");
                if (label) label.textContent = "Verification Pending";
                sidebarBtn.disabled = true;
            }
        }
    }

    function initVerificationRequest() {
        renderVerificationState();

        const modal = document.getElementById("verificationModalBackdrop");
        const form = document.getElementById("verificationForm");
        if (!modal || !form) return;

        ["btnProfileRequestVerification", "btnRequestVerification"].forEach(function (id) {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener("click", function () {
                    if (getVerificationState() === "none") openVerificationModal();
                });
            }
        });

        const closeM = () => { if (!verificationPaymentBusy) modal.hidden = true; };
        const closeMBtn = document.getElementById("closeVerificationModalBtn");
        const cancelBtn = document.getElementById("cancelVerificationBtn");
        if (closeMBtn) closeMBtn.addEventListener("click", closeM);
        if (cancelBtn) cancelBtn.addEventListener("click", closeM);

        form.addEventListener("submit", handleVerificationPayment);
    }

    function openVerificationModal() {
        const modal = document.getElementById("verificationModalBackdrop");
        if (!modal) return;

        const profile = (window.GasHubCore && GasHubCore.getActiveProfile && GasHubCore.getActiveProfile()) || {};
        if (!getVal("verifyOutletName")) setVal("verifyOutletName", profile.businessName || "");
        if (!getVal("verifyMpesaPhone")) setVal("verifyMpesaPhone", profile.phone || "");

        const fee = getAssignedVerificationFee();
        const feeAmount = document.getElementById("verificationFeeAmount");
        const feePill = document.getElementById("verificationFeePill");
        const submitBtn = document.getElementById("submitVerificationBtn");
        const payText = document.getElementById("verificationPayBtnText");

        if (fee) {
            if (feeAmount) feeAmount.textContent = formatKsh(fee);
            if (feePill) feePill.classList.remove("is-missing");
            if (submitBtn) submitBtn.disabled = false;
            if (payText) payText.textContent = "Pay " + formatKsh(fee) + " via M-Pesa";
            setVerificationStatus("", "");
        } else {
            if (feeAmount) feeAmount.textContent = "Not set yet";
            if (feePill) feePill.classList.add("is-missing");
            if (submitBtn) submitBtn.disabled = true;
            if (payText) payText.textContent = "Pay via M-Pesa";
            setVerificationStatus("GasHub Admin has not set a verification fee for your outlet yet. Please contact GasHub support.", "error");
        }

        modal.hidden = false;
    }

    function setVerificationStatus(message, kind) {
        const box = document.getElementById("verificationPayStatus");
        if (!box) return;
        box.className = "verification-pay-status";
        box.textContent = message || "";
        if (!message) return;
        box.classList.add("is-visible");
        if (kind === "error") box.classList.add("is-error");
        if (kind === "success") box.classList.add("is-success");
    }

    /* 07XX / 01XX / +2547XX / 2547XX  ->  2547XXXXXXXX (null when invalid) */
    function normalizeKenyanPhone(raw) {
        const digits = String(raw || "").replace(/[\s\-()]/g, "");
        const m = digits.match(/^(?:\+?254|0)?([17]\d{8})$/);
        return m ? "254" + m[1] : null;
    }

    /* Sends the M-Pesa STK push.
       Connect your backend by defining GasHubCore.initiateMpesaStk({ phone, amount, reference, description })
       that returns (a Promise of) { success: true/false, receipt, message }.
       Without it this SIMULATES a successful payment so you can test the screens. */
    function requestMpesaPayment(payload) {
        if (window.GasHubCore && typeof GasHubCore.initiateMpesaStk === "function") {
            return Promise.resolve(GasHubCore.initiateMpesaStk(payload));
        }
        console.warn("[DealerProfileApp] GasHubCore.initiateMpesaStk not found - SIMULATING M-Pesa payment.");
        return new Promise(function (resolve) {
            setTimeout(function () {
                resolve({ success: true, receipt: "SIM" + Date.now().toString(36).toUpperCase() });
            }, 3000);
        });
    }

    async function handleVerificationPayment(e) {
        e.preventDefault();
        if (verificationPaymentBusy) return;

        const outletName = getVal("verifyOutletName").trim();
        const license = getVal("verifyEpraLicense").trim();
        const phone = normalizeKenyanPhone(getVal("verifyMpesaPhone"));
        const amount = getAssignedVerificationFee();

        if (!amount) {
            setVerificationStatus("No verification fee has been set for your outlet yet.", "error");
            return;
        }
        if (!outletName || !license) {
            setVerificationStatus("Enter your outlet name and EPRA license number.", "error");
            return;
        }
        if (!phone) {
            setVerificationStatus("Enter a valid Safaricom number, e.g. 0712 345 678.", "error");
            return;
        }

        const submitBtn = document.getElementById("submitVerificationBtn");
        const payText = document.getElementById("verificationPayBtnText");
        const originalLabel = payText ? payText.textContent : "";

        verificationPaymentBusy = true;
        if (submitBtn) submitBtn.disabled = true;
        if (payText) payText.textContent = "Waiting for M-Pesa...";
        setVerificationStatus("M-Pesa prompt sent to " + phone + ". Enter your PIN on your phone to pay " + formatKsh(amount) + ".", "info");

        try {
            const result = await requestMpesaPayment({
                phone: phone,
                amount: amount,
                reference: "VERIFY-" + getDealerId(),
                description: "GasHub dealer verification"
            });

            if (!result || !result.success) {
                throw new Error((result && result.message) || "Payment was not completed.");
            }

            const record = {
                status: VERIFY_INSTANTLY_AFTER_PAYMENT ? "verified" : "pending",
                dealerId: getDealerId(),
                outletName: outletName,
                epraLicense: license,
                amount: amount,
                phone: phone,
                receipt: result.receipt || "",
                paidAt: new Date().toISOString()
            };
            localStorage.setItem("gashub_dealer_verification", JSON.stringify(record));
            if (VERIFY_INSTANTLY_AFTER_PAYMENT) localStorage.setItem("gashub_dealer_verified", "true");

            if (window.GasHubCore && typeof GasHubCore.submitVerificationRequest === "function") {
                GasHubCore.submitVerificationRequest(record);
            }

            verificationPaymentBusy = false;
            const modal = document.getElementById("verificationModalBackdrop");
            if (modal) modal.hidden = true;
            renderVerificationState();
            GasHubCore.showToast(
                VERIFY_INSTANTLY_AFTER_PAYMENT
                    ? "Payment received. Your outlet is now verified!"
                    : "Payment received. GasHub Admin will review your verification request.",
                "success"
            );
        } catch (err) {
            verificationPaymentBusy = false;
            if (submitBtn) submitBtn.disabled = false;
            if (payText) payText.textContent = originalLabel;
            setVerificationStatus(err.message || "Payment failed. Please try again.", "error");
        }
    }

    /* =========================================================
       8. WORKING HOURS
       ---------------------------------------------------------
       Saved on the server (PUT /api/dealers/working-hours/mine) so the
       admin pages and the customer pages read the same hours.
       localStorage "gashub_dealer_working_hours" is only a cache so the
       form fills instantly.
       { open24, openTime, closeTime, days }
         open24 = true  -> shop is ALWAYS open (24 hours, every day)
         open24 = false -> shop is open only on `days`, between openTime
                           and closeTime, and shows Closed otherwise
       days: 0 = Sunday ... 6 = Saturday. Times are Kenya time.
       ========================================================= */

    const WORKING_HOURS_KEY = "gashub_dealer_working_hours";
    const WORKING_HOURS_ENDPOINT = "/api/dealers/working-hours/mine";
    const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    function cleanWorkingHours(saved) {
        saved = saved && typeof saved === "object" ? saved : {};
        // older versions saved { enabled:false } to mean "no schedule" = always open
        const legacyOff = saved.enabled === false;
        const hasData = Object.keys(saved).length > 0;
        return {
            open24: hasData ? (legacyOff || saved.open24 === true) : true,
            openTime: saved.openTime || "08:00",
            closeTime: saved.closeTime || "18:00",
            days: Array.isArray(saved.days) ? saved.days.map(Number) : [1, 2, 3, 4, 5, 6, 0]
        };
    }

    function readCachedHours() {
        try {
            const all = JSON.parse(localStorage.getItem(WORKING_HOURS_KEY)) || {};
            return all[getDealerId()] || null;
        } catch (err) {
            return null;
        }
    }

    function loadWorkingHours() {
        return cleanWorkingHours(readCachedHours());
    }

    function storeWorkingHours(hours) {
        let all = {};
        try { all = JSON.parse(localStorage.getItem(WORKING_HOURS_KEY)) || {}; } catch (err) { all = {}; }
        all[getDealerId()] = hours;
        try { localStorage.setItem(WORKING_HOURS_KEY, JSON.stringify(all)); } catch (err) { /* cache only */ }
        document.dispatchEvent(new CustomEvent("gashub:working-hours-changed", { detail: { dealerId: getDealerId() } }));
    }

    async function workingHoursRequest(method, body) {
        const token = localStorage.getItem("gashub_dealer_token");
        if (!token) throw new Error("Your session has expired. Please sign in again.");
        const response = await fetch(WORKING_HOURS_ENDPOINT, {
            method: method,
            headers: Object.assign(
                { "Accept": "application/json", "Authorization": "Bearer " + token },
                body ? { "Content-Type": "application/json" } : {}
            ),
            body: body ? JSON.stringify(body) : undefined
        });
        const result = await response.json().catch(function () { return {}; });
        if (!response.ok || result.success === false) {
            throw new Error(result.message || "Request failed (" + response.status + ")");
        }
        return result;
    }

    function minutesOf(time) {
        const parts = time.split(":");
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }

    function formatClock(totalMinutes) {
        const h = Math.floor(totalMinutes / 60);
        const m = totalMinutes % 60;
        return (h % 12 === 0 ? 12 : h % 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h >= 12 ? "PM" : "AM");
    }

    /* Current day + minutes in Kenya time, so the device clock/timezone can't change the result */
    function nowInKenya() {
        const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Africa/Nairobi",
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).formatToParts(new Date());

        const pick = (type) => (parts.find(p => p.type === type) || {}).value || "0";
        let h = parseInt(pick("hour"), 10);
        if (h === 24) h = 0;
        return { day: DAY_SHORT.indexOf(pick("weekday")), minutes: h * 60 + parseInt(pick("minute"), 10) };
    }

    /* Returns { isOpen, label, detail } for a working-hours object */
    function getWorkingHoursStatus(hours) {
        if (hours.open24) {
            return { isOpen: true, label: "Open 24 hours", detail: "" };
        }
        if (!hours.days.length) {
            return { isOpen: false, label: "Closed", detail: "Temporarily closed" };
        }

        const now = nowInKenya();
        const works = (d) => hours.days.indexOf(d) !== -1;
        const open = minutesOf(hours.openTime);
        const close = minutesOf(hours.closeTime);
        let isOpen;

        if (open === close) {
            isOpen = works(now.day);
        } else if (open < close) {
            isOpen = works(now.day) && now.minutes >= open && now.minutes < close;
        } else {
            // overnight hours, e.g. 8:00 PM to 2:00 AM
            isOpen = (works(now.day) && now.minutes >= open) || (works((now.day + 6) % 7) && now.minutes < close);
        }

        if (isOpen) {
            return { isOpen: true, label: "Open now", detail: "Closes at " + formatClock(close) };
        }

        let detail = "";
        for (let i = 0; i < 8; i++) {
            const d = (now.day + i) % 7;
            if (!works(d)) continue;
            if (i === 0 && now.minutes >= open) continue;
            detail = "Opens " + (i === 0 ? "today" : i === 1 ? "tomorrow" : DAY_FULL[d]) + " at " + formatClock(open);
            break;
        }
        return { isOpen: false, label: "Closed", detail: detail };
    }

    function readWorkingHoursForm() {
        return {
            open24: isChecked("hoursOpen24"),
            openTime: getVal("hoursOpenTime"),
            closeTime: getVal("hoursCloseTime"),
            days: Array.prototype.map.call(
                document.querySelectorAll('input[name="hoursDay"]:checked'),
                function (box) { return Number(box.value); }
            )
        };
    }

    function fillWorkingHoursForm(hours) {
        setChecked("hoursOpen24", hours.open24);
        setVal("hoursOpenTime", hours.openTime);
        setVal("hoursCloseTime", hours.closeTime);
        document.querySelectorAll('input[name="hoursDay"]').forEach(function (box) {
            box.checked = hours.days.indexOf(Number(box.value)) !== -1;
        });
    }

    function summarizeDays(days) {
        if (days.length === 7) return "every day";
        return [1, 2, 3, 4, 5, 6, 0]
            .filter(function (d) { return days.indexOf(d) !== -1; })
            .map(function (d) { return DAY_SHORT[d]; })
            .join(", ");
    }

    function refreshWorkingHoursForm() {
        const hours = readWorkingHoursForm();

        // 24 hours switches the schedule off; otherwise the schedule decides Open / Closed
        const fields = document.getElementById("hoursFields");
        if (fields) fields.classList.toggle("is-off", hours.open24);

        ["hoursOpenTime", "hoursCloseTime"].forEach(function (id) {
            const el = document.getElementById(id);
            if (el) el.disabled = hours.open24;
        });
        document.querySelectorAll('input[name="hoursDay"]').forEach(function (box) {
            box.disabled = hours.open24;
        });

        const preview = document.getElementById("hoursPreview");
        const previewText = document.getElementById("hoursPreviewText");
        if (!preview || !previewText) return;
        preview.classList.remove("is-open", "is-closed");

        if (hours.open24) {
            previewText.textContent = "Open 24 hours. Customers always see your outlet as open.";
            preview.classList.add("is-open");
            return;
        }
        if (!hours.days.length) {
            previewText.textContent = "Select at least one working day.";
            return;
        }
        if (!hours.openTime || !hours.closeTime) {
            previewText.textContent = "Enter your opening and closing times.";
            return;
        }

        const status = getWorkingHoursStatus(hours);
        previewText.textContent = formatClock(minutesOf(hours.openTime)) + " to " + formatClock(minutesOf(hours.closeTime)) +
            ", " + summarizeDays(hours.days) + ". Right now (Kenya time): " + status.label + (status.detail ? ", " + status.detail : "") + ".";
        preview.classList.add(status.isOpen ? "is-open" : "is-closed");
    }

    function refreshHoursStatusPill() {
        const pill = document.getElementById("profileHoursStatus");
        if (!pill) return;

        const status = getWorkingHoursStatus(loadWorkingHours());
        pill.hidden = false;
        pill.classList.toggle("is-open", status.isOpen);
        pill.classList.toggle("is-closed", !status.isOpen);
        pill.textContent = status.label + (status.detail ? " · " + status.detail : "");
    }

    /* Load the hours saved on the server (so every device and the admin see the same thing). */
    async function syncWorkingHoursFromServer() {
        try {
            const result = await workingHoursRequest("GET");
            if (result.working_hours) {
                storeWorkingHours(cleanWorkingHours(result.working_hours));
            } else {
                // nothing on the server yet: send hours this browser saved before the server existed
                const cached = readCachedHours();
                if (cached && cached.open24 !== true && cached.enabled !== false && Array.isArray(cached.days)) {
                    const local = cleanWorkingHours(cached);
                    if (local.days.length && local.openTime && local.closeTime && local.openTime !== local.closeTime) {
                        await workingHoursRequest("PUT", local);
                    }
                }
            }
            fillWorkingHoursForm(loadWorkingHours());
            refreshWorkingHoursForm();
            refreshHoursStatusPill();
        } catch (err) {
            console.warn("Could not load working hours from the server:", err.message);
        }
    }

    function initWorkingHours() {
        const form = document.getElementById("dealerWorkingHoursForm");
        if (!form) return;

        fillWorkingHoursForm(loadWorkingHours());
        refreshWorkingHoursForm();
        refreshHoursStatusPill();
        syncWorkingHoursFromServer();

        form.addEventListener("input", refreshWorkingHoursForm);
        form.addEventListener("change", refreshWorkingHoursForm);

        form.addEventListener("submit", async function (e) {
            e.preventDefault();
            clearErrors();

            const hours = readWorkingHoursForm();
            let valid = true;

            if (!hours.open24) {
                if (!hours.days.length) {
                    setErrorFor("hoursDays", "Select at least one working day.");
                    valid = false;
                }
                if (!hours.openTime) {
                    setError("hoursOpenTime", "Enter your opening time.");
                    valid = false;
                }
                if (!hours.closeTime) {
                    setError("hoursCloseTime", "Enter your closing time.");
                    valid = false;
                }
                if (hours.openTime && hours.closeTime && hours.openTime === hours.closeTime) {
                    setError("hoursCloseTime", "Closing time must be different from opening time. Choose 'Open 24 hours' if you never close.");
                    valid = false;
                }
            }

            if (!valid) {
                GasHubCore.showToast("Please fix the working hours highlighted below.", "error");
                return;
            }

            const saveBtn = document.getElementById("saveWorkingHours");
            if (saveBtn) saveBtn.disabled = true;

            try {
                const result = await workingHoursRequest("PUT", hours);
                const saved = cleanWorkingHours(result.working_hours || hours);
                storeWorkingHours(saved);
                if (window.GasHubCore && typeof GasHubCore.updateWorkingHours === "function") {
                    GasHubCore.updateWorkingHours(saved);
                }
                fillWorkingHoursForm(saved);
                refreshWorkingHoursForm();
                refreshHoursStatusPill();
                GasHubCore.showToast(
                    saved.open24
                        ? "Saved. Your shop is now open 24 hours."
                        : "Working hours saved. Customers will see your business as closed outside these hours.",
                    "success"
                );
            } catch (err) {
                GasHubCore.showToast("Working hours were not saved: " + err.message, "error");
            } finally {
                if (saveBtn) saveBtn.disabled = false;
            }
        });

        const resetBtn = document.getElementById("resetWorkingHours");
        if (resetBtn) {
            resetBtn.addEventListener("click", function () {
                clearErrors();
                fillWorkingHoursForm(loadWorkingHours());
                refreshWorkingHoursForm();
                GasHubCore.showToast("Working hours reverted to the saved schedule.", "info");
            });
        }

        // keep the status pill and preview accurate as time passes
        setInterval(function () {
            refreshHoursStatusPill();
            refreshWorkingHoursForm();
        }, 30000);
    }

    /* =========================================================
       HELPERS
       ========================================================= */
    function getVal(id) {
        const el = document.getElementById(id);
        return el ? el.value : "";
    }

    function setVal(id, val) {
        const el = document.getElementById(id);
        if (el) el.value = val;
    }

    function isChecked(id) {
        const el = document.getElementById(id);
        return !!(el && el.checked);
    }

    function setChecked(id, val) {
        const el = document.getElementById(id);
        if (el) el.checked = !!val;
    }

    function setText(sel, text) {
        document.querySelectorAll(sel).forEach(el => el.textContent = text);
    }

    function setError(fieldId, msg) {
        const el = document.getElementById(fieldId);
        if (el) el.classList.add("dealer-input-error");
        const err = document.querySelector(`[data-error-for="${fieldId}"]`);
        if (err) err.textContent = msg;
    }

    /* error message only (for groups that have no single input) */
    function setErrorFor(key, msg) {
        const err = document.querySelector(`[data-error-for="${key}"]`);
        if (err) err.textContent = msg;
    }

    function clearErrors() {
        document.querySelectorAll(".dealer-input-error").forEach(el => el.classList.remove("dealer-input-error"));
        document.querySelectorAll(".dealer-profile-field-error").forEach(el => el.textContent = "");
    }

    function escapeHtml(str) {
        if (!str) return "";
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    return {
        init,
        selectQuickLocation
    };
})();