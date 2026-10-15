document.addEventListener("DOMContentLoaded", () => {
    const state = {
        admins: [],
        editingAdminId: null
    };

    /* ---------- super admin lock ---------- */
    let superToken = "";   /* in memory only: a page reload locks the sections again */

    function superRequest(path, options = {}) {
        return GasHubAdmin.adminApiRequest(path, {
            ...options,
            headers: { ...(options.headers || {}), ...(superToken ? { "X-Super-Unlock": superToken } : {}) }
        });
    }

    const elements = {
        message: document.getElementById("settingsMessage"),
        profileForm: document.getElementById("adminProfileForm"),
        adminFullName: document.getElementById("adminFullName"),
        adminEmail: document.getElementById("adminEmail"),
        adminPhone: document.getElementById("adminPhone"),
        adminUsername: document.getElementById("adminUsername"),
        saveAdminProfileButton: document.getElementById("saveAdminProfileButton"),

        passwordForm: document.getElementById("changePasswordForm"),
        currentPassword: document.getElementById("currentPassword"),
        newPassword: document.getElementById("newPassword"),
        confirmPassword: document.getElementById("confirmPassword"),
        changePasswordButton: document.getElementById("changePasswordButton"),

        addAdminButton: document.getElementById("addAdminButton"),
        adminsTableBody: document.getElementById("adminsTableBody"),

        adminModal: document.getElementById("adminModal"),
        adminModalBackdrop: document.getElementById("adminModalBackdrop"),
        adminModalTitle: document.getElementById("adminModalTitle"),
        closeAdminModal: document.getElementById("closeAdminModal"),

        adminForm: document.getElementById("adminForm"),
        adminId: document.getElementById("adminId"),
        adminName: document.getElementById("adminName"),
        adminFormEmail: document.getElementById("adminFormEmail"),
        adminFormPhone: document.getElementById("adminFormPhone"),
        adminFormUsername: document.getElementById("adminFormUsername"),
        adminFormRole: document.getElementById("adminFormRole"),
        adminFormStatus: document.getElementById("adminFormStatus"),
        adminFormPassword: document.getElementById("adminFormPassword"),

        cancelAdminButton: document.getElementById("cancelAdminButton"),
        adminModalMessage: document.getElementById("adminModalMessage"),
        saveAdminButton: document.getElementById("saveAdminButton")
    };

    function escapeHtml(value) {
        return GasHubAdmin.escapeHtml(
            value === null || value === undefined ? "" : String(value)
        );
    }

    function showMessage(message, type = "error") {
        if (!elements.message) return;

        if (!message) {
            elements.message.textContent = "";
            elements.message.className = "admin-message";
            elements.message.style.display = "none";
            return;
        }

        elements.message.textContent = message;
        elements.message.className = `admin-message ${type}`;
        elements.message.style.display = "block";
    }

    function getStoredAdmin() {
        try {
            const stored = localStorage.getItem("gashub_admin");
            if (stored) return JSON.parse(stored);
        } catch (error) {
            console.error("Failed to read stored admin:", error);
        }
        return null;
    }

    function updateStoredAdmin(admin) {
        try {
            localStorage.setItem("gashub_admin", JSON.stringify(admin));
        } catch (error) {
            console.error("Failed to update stored admin:", error);
        }
    }

    function loadProfile() {
        const admin = getStoredAdmin();
        if (!admin) return;

        if (elements.adminFullName) {
            elements.adminFullName.value = admin.full_name || admin.name || "";
        }
        if (elements.adminEmail) {
            elements.adminEmail.value = admin.email || "";
        }
        if (elements.adminPhone) {
            elements.adminPhone.value = admin.phone || "";
        }
        if (elements.adminUsername) {
            elements.adminUsername.value = admin.username || admin.user_code || "";
        }
        renderProfileSummary(admin);
    }

    function renderProfileSummary(admin) {
        if (!admin) return;
        const name = admin.full_name || admin.name || admin.admin_name || "Administrator";
        const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value || "—"; };
        setText("profileName", name);
        setText("profileEmail", admin.email);
        setText("profilePhone", admin.phone);
        setText("profileUsername", admin.username || admin.user_code);
        const role = String(admin.role || "admin").replace(/_/g, " ");
        setText("profileRole", role.charAt(0).toUpperCase() + role.slice(1));
        const avatar = document.getElementById("profileAvatar");
        if (avatar) avatar.textContent = name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "A";
    }

    /* ---------- Edit Profile popup ---------- */
    const profileModal = document.getElementById("profileModal");
    const profileModalMessage = document.getElementById("profileModalMessage");

    function showProfileModalMessage(message) {
        if (!profileModalMessage) return;
        profileModalMessage.textContent = message || "";
        profileModalMessage.className = message ? "admin-message modal-message error show" : "admin-message modal-message";
    }

    function openProfileModal() {
        loadProfile();
        showProfileModalMessage("");
        profileModal.classList.add("open");
        profileModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
        setTimeout(() => elements.adminFullName && elements.adminFullName.focus(), 50);
    }

    function closeProfileModal() {
        profileModal.classList.remove("open");
        profileModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
    }

    document.getElementById("editProfileButton")?.addEventListener("click", openProfileModal);
    document.getElementById("closeProfileModal")?.addEventListener("click", closeProfileModal);
    document.getElementById("cancelProfileButton")?.addEventListener("click", closeProfileModal);
    document.getElementById("profileModalBackdrop")?.addEventListener("click", closeProfileModal);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && profileModal?.classList.contains("open")) closeProfileModal(); });

    function getAdminId(admin) {
        return admin.id ?? admin.admin_id ?? "";
    }

    function getAdminName(admin) {
        return admin.full_name || admin.name || admin.admin_name || "—";
    }

    function getAdminEmail(admin) {
        return admin.email || "—";
    }

    function getAdminPhone(admin) {
        return admin.phone || "—";
    }

    function getAdminRole(admin) {
        return admin.role || "admin";
    }

    function getAdminStatus(admin) {
        return (admin.status || "active").toString().toLowerCase();
    }

    function statusBadge(status) {
        const normalized = String(status || "").toLowerCase();
        let className = "neutral";

        if (normalized === "active") {
            className = "success";
        } else if (["inactive", "suspended"].includes(normalized)) {
            className = "danger";
        }

        const label = normalized
            .replace(/_/g, " ")
            .replace(/\b\w/g, letter => letter.toUpperCase());

        return `<span class="status-badge ${className}">${escapeHtml(label)}</span>`;
    }

    function roleLabel(role) {
        return String(role || "admin")
            .replace(/_/g, " ")
            .replace(/\b\w/g, letter => letter.toUpperCase());
    }

    function normalizeAdmins(response) {
        if (Array.isArray(response)) return response;
        if (Array.isArray(response?.admins)) return response.admins;
        if (Array.isArray(response?.data)) return response.data;
        if (Array.isArray(response?.data?.admins)) return response.data.admins;
        return [];
    }

    function renderAdmins() {
        if (!elements.adminsTableBody) return;

        if (!state.admins.length) {
            elements.adminsTableBody.innerHTML = `
                <tr><td colspan="6" class="table-empty">
                    No administrators found.
                </td></tr>`;
            return;
        }

        elements.adminsTableBody.innerHTML = state.admins.map(admin => {
            const id = getAdminId(admin);

            return `
                <tr>
                    <td><div class="table-primary-text">${escapeHtml(getAdminName(admin))}</div></td>
                    <td>${escapeHtml(getAdminEmail(admin))}</td>
                    <td>${escapeHtml(getAdminPhone(admin))}</td>
                    <td>${escapeHtml(roleLabel(getAdminRole(admin)))}</td>
                    <td>${statusBadge(getAdminStatus(admin))}</td>
                    <td>
                        <div class="table-actions">
                            <button type="button" class="table-action-button"
                                data-action="edit" data-id="${escapeHtml(id)}">Edit</button>
                            <button type="button" class="table-action-button danger"
                                data-action="delete" data-id="${escapeHtml(id)}">Delete</button>
                        </div>
                    </td>
                </tr>`;
        }).join("");
    }

    async function loadAdmins() {
        if (!elements.adminsTableBody) return;

        try {
            elements.adminsTableBody.innerHTML = `
                <tr><td colspan="6" class="table-loading">
                    Loading administrators...
                </td></tr>`;

            const response = await superRequest("/api/admin/admins");
            state.admins = normalizeAdmins(response);
            renderAdmins();
        } catch (error) {
            console.error("Failed to load administrators:", error);

            elements.adminsTableBody.innerHTML = `
                <tr><td colspan="6" class="table-empty">
                    Failed to load administrators.
                </td></tr>`;

            showMessage(error.message || "Failed to load administrators.");
        }
    }

    /* errors while the Add/Edit window is open are shown inside it (the page message sits behind the window) */
    function showModalMessage(text) {
        const box = elements.adminModalMessage;
        if (!box) { showMessage(text); return; }
        box.textContent = text || "";
        box.className = "admin-message modal-message error" + (text ? " show" : "");
    }

    function openAdminModal(admin = null) {
        if (!elements.adminForm || !elements.adminModal) return;

        elements.adminForm.reset();
        showModalMessage("");

        if (admin) {
            state.editingAdminId = getAdminId(admin);
            elements.adminModalTitle.textContent = "Edit Administrator";
            elements.adminId.value = getAdminId(admin);
            elements.adminName.value = getAdminName(admin) === "—" ? "" : getAdminName(admin);
            elements.adminFormEmail.value = admin.email || "";
            elements.adminFormPhone.value = admin.phone || "";
            elements.adminFormUsername.value = admin.username || admin.user_code || "";
            elements.adminFormRole.value = admin.role || "admin";
            elements.adminFormStatus.value = admin.status || "active";
            elements.adminFormPassword.required = false;
            elements.adminFormPassword.placeholder = "Leave blank to keep current password";
            elements.saveAdminButton.textContent = "Update Administrator";
        } else {
            state.editingAdminId = null;
            elements.adminModalTitle.textContent = "Add Administrator";
            elements.adminId.value = "";
            elements.adminFormRole.value = "admin";
            elements.adminFormStatus.value = "active";
            elements.adminFormPassword.required = true;
            elements.adminFormPassword.placeholder = "Enter password";
            elements.saveAdminButton.textContent = "Save Administrator";
        }

        elements.adminModal.classList.add("open");
        elements.adminModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
    }

    function closeAdminModal() {
        elements.adminModal?.classList.remove("open");
        elements.adminModal?.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        state.editingAdminId = null;
    }

    async function saveAdmin(event) {
        event.preventDefault();

        const fullName = elements.adminName.value.trim();
        const email = elements.adminFormEmail.value.trim();
        const phone = elements.adminFormPhone.value.trim();
        const username = elements.adminFormUsername.value.trim();
        const role = elements.adminFormRole.value;
        const status = elements.adminFormStatus.value;
        const password = elements.adminFormPassword.value;

        if (!fullName || !email) {
            showModalMessage("Full name and email are required.");
            return;
        }

        if (!state.editingAdminId && !password) {
            showModalMessage("A password is required for a new administrator.");
            return;
        }

        const payload = { full_name: fullName, email, phone, username, role, status };
        if (password) payload.password = password;

        try {
            elements.saveAdminButton.disabled = true;
            elements.saveAdminButton.textContent = "Saving...";

            if (state.editingAdminId) {
                await superRequest(
                    `/api/admin/admins/${encodeURIComponent(state.editingAdminId)}`,
                    { method: "PUT", body: payload }
                );
                showMessage("Administrator updated successfully.", "success");
            } else {
                await superRequest("/api/admin/admins", {
                    method: "POST",
                    body: payload
                });
                showMessage("Administrator added successfully.", "success");
            }

            closeAdminModal();
            await loadAdmins();
        } catch (error) {
            console.error("Failed to save administrator:", error);
            if (String(error.message || "").startsWith("This section is locked")) {
                closeAdminModal();
                relock("Locked after a period of inactivity. Unlock again, then re-enter the administrator.");
            } else {
                showModalMessage(error.message || "Failed to save administrator.");
            }
        } finally {
            elements.saveAdminButton.disabled = false;
            elements.saveAdminButton.textContent = "Save Administrator";
        }
    }

    async function deleteAdmin(adminId) {
        if (!adminId) return;

        const admin = state.admins.find(item =>
            String(getAdminId(item)) === String(adminId)
        );

        const name = admin ? getAdminName(admin) : "this administrator";

        if (!(await GasHubDialog.confirm({
            title: "Delete administrator?",
            message: `Delete ${name}? This action cannot be undone.`,
            confirmText: "Delete", tone: "danger"
        }))) {
            return;
        }

        try {
            await superRequest(
                `/api/admin/admins/${encodeURIComponent(adminId)}`,
                { method: "DELETE" }
            );

            showMessage("Administrator deleted successfully.", "success");
            await loadAdmins();
        } catch (error) {
            console.error("Failed to delete administrator:", error);
            showMessage(error.message || "Failed to delete administrator.");
        }
    }

    async function saveProfile(event) {
        event.preventDefault();

        const fullName = elements.adminFullName.value.trim();
        const email = elements.adminEmail.value.trim();
        const phone = elements.adminPhone.value.trim();
        const username = elements.adminUsername.value.trim();

        if (!fullName || !email) {
            showProfileModalMessage("Full name and email are required.");
            return;
        }

        try {
            showProfileModalMessage("");
            elements.saveAdminProfileButton.disabled = true;
            elements.saveAdminProfileButton.textContent = "Saving...";

            const response = await GasHubAdmin.adminApiRequest("/api/admin/profile", {
                method: "PUT",
                body: { full_name: fullName, email, phone, username }
            });

            const updatedAdmin = response?.admin || response?.data || {
                ...(getStoredAdmin() || {}),
                full_name: fullName,
                email,
                phone,
                username
            };

            updateStoredAdmin(updatedAdmin);
            renderProfileSummary(updatedAdmin);
            closeProfileModal();
            showMessage("Profile updated successfully.", "success");
        } catch (error) {
            console.error("Failed to update profile:", error);
            showProfileModalMessage(error.message || "Failed to update profile.");
        } finally {
            elements.saveAdminProfileButton.disabled = false;
            elements.saveAdminProfileButton.textContent = "Save Profile";
        }
    }

    async function changePassword(event) {
        event.preventDefault();

        const currentPassword = elements.currentPassword.value;
        const newPassword = elements.newPassword.value;
        const confirmPassword = elements.confirmPassword.value;

        if (!currentPassword || !newPassword) {
            showMessage("Please enter your current and new password.");
            return;
        }

        if (newPassword !== confirmPassword) {
            showMessage("The new passwords do not match.");
            return;
        }

        try {
            elements.changePasswordButton.disabled = true;
            elements.changePasswordButton.textContent = "Changing...";

            await GasHubAdmin.adminApiRequest("/api/admin/change-password", {
                method: "POST",
                body: {
                    current_password: currentPassword,
                    new_password: newPassword
                }
            });

            elements.passwordForm.reset();
            showMessage("Password changed successfully.", "success");
        } catch (error) {
            console.error("Failed to change password:", error);
            showMessage(error.message || "Failed to change password.");
        } finally {
            elements.changePasswordButton.disabled = false;
            elements.changePasswordButton.textContent = "Change Password";
        }
    }

    elements.profileForm?.addEventListener("submit", saveProfile);
    elements.passwordForm?.addEventListener("submit", changePassword);
    elements.addAdminButton?.addEventListener("click", () => openAdminModal());
    elements.closeAdminModal?.addEventListener("click", closeAdminModal);
    elements.cancelAdminButton?.addEventListener("click", closeAdminModal);
    elements.adminModalBackdrop?.addEventListener("click", closeAdminModal);
    elements.adminForm?.addEventListener("submit", saveAdmin);

    elements.adminsTableBody?.addEventListener("click", event => {
        const button = event.target.closest("[data-action]");
        if (!button) return;

        const action = button.getAttribute("data-action");
        const adminId = button.getAttribute("data-id");

        if (action === "edit") {
            const admin = state.admins.find(item =>
                String(getAdminId(item)) === String(adminId)
            );
            if (admin) openAdminModal(admin);
        } else if (action === "delete") {
            deleteAdmin(adminId);
        }
    });

    document.addEventListener("keydown", event => {
        if (
            event.key === "Escape" &&
            elements.adminModal?.classList.contains("open")
        ) {
            closeAdminModal();
        }
    });

    // Social media, customer support, coin exchange rate, and platform settings.
    const settingFields = {
        social: {
            facebook: document.getElementById("socialFacebook"),
            instagram: document.getElementById("socialInstagram"),
            tiktok: document.getElementById("socialTikTok"),
            youtube: document.getElementById("socialYouTube"),
            x: document.getElementById("socialX"),
            email: document.getElementById("socialEmail")
        },
        support: {
            whatsapp: document.getElementById("supportWhatsApp"),
            phone: document.getElementById("supportPhone"),
            hours: document.getElementById("supportHours"),
            website: document.getElementById("supportWebsite")
        }
    };

    const coinRateInput = document.getElementById("coinRate");
    const coinRatePreview = document.getElementById("coinRatePreview");
    const singleCoinPreview = document.getElementById("singleCoinPreview");

    const money = value =>
        `KSh ${Number(value).toLocaleString("en-KE", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        })}`;

    function updateCoinPreview() {
        const rate = Number(coinRateInput?.value);
        if (!Number.isFinite(rate) || rate <= 0) return;

        if (coinRatePreview) {
            coinRatePreview.textContent = `100 coins = ${money(rate * 100)}`;
        }
        if (singleCoinPreview) {
            singleCoinPreview.textContent = `1 coin = ${money(rate)}`;
        }
    }

    const minRedeemInput = document.getElementById("coinMinRedeem");
    function updateMinPreview() {
        const rate = Number(coinRateInput?.value), min = Number(minRedeemInput?.value);
        const el = document.getElementById("minRedeemPreview");
        if (el && Number.isFinite(rate) && rate > 0 && Number.isFinite(min) && min > 0) el.textContent = `${min.toLocaleString("en-KE")} coins = ${money(rate * min)}`;
    }
    coinRateInput?.addEventListener("input", () => { updateCoinPreview(); updateMinPreview(); });
    minRedeemInput?.addEventListener("input", updateMinPreview);
    updateCoinPreview(); updateMinPreview();

    const currentAdmin = getStoredAdmin();
    const currentAdminLabel = document.getElementById("settingsCurrentAdmin");

    if (currentAdminLabel) {
        currentAdminLabel.textContent = currentAdmin
            ? `${getAdminName(currentAdmin)} · ${roleLabel(getAdminRole(currentAdmin))}`
            : "Signed-in administrator";
    }

    async function requestSettings(path, options = {}) {
        return GasHubAdmin.adminApiRequest(path, options);
    }

    function assignFields(fields, values = {}) {
        Object.entries(fields).forEach(([key, input]) => {
            if (input) input.value = values[key] == null ? "" : String(values[key]);
        });
    }

    const socialSwitches = {
        facebook: document.getElementById("socialActiveFacebook"),
        instagram: document.getElementById("socialActiveInstagram"),
        tiktok: document.getElementById("socialActiveTikTok"),
        youtube: document.getElementById("socialActiveYouTube"),
        x: document.getElementById("socialActiveX")
    };

    async function loadExtraSettings() {
        try {
            const data = await requestSettings("/api/admin/settings/social");
            const links = data.social_links || data.settings?.social_links || {};
            assignFields(settingFields.social, links);
            /* a link saved before the switch existed has no entry, and stays on */
            Object.keys(socialSwitches).forEach(key => {
                if (socialSwitches[key]) socialSwitches[key].checked = !(links.active && links.active[key] === false);
            });

            const support = data.support || data.settings?.support || {};
            assignFields(settingFields.support, support);
        } catch (error) {
            console.info("Social/contact settings endpoint is not available yet:", error.message);
        }

        try {
            const data = await requestSettings("/api/admin/settings/coins");
            const settings = data.settings || data;

            if (coinRateInput && settings.coin_rate_ksh != null) {
                coinRateInput.value = settings.coin_rate_ksh;
            }

            if (minRedeemInput && settings.min_redeem_points != null) minRedeemInput.value = settings.min_redeem_points;

            updateCoinPreview(); updateMinPreview();

            const history = Array.isArray(data.history) ? data.history : [];
            const tbody = document.getElementById("coinRateHistory");

            if (tbody && history.length) {
                tbody.innerHTML = history.map(item => `
                    <tr>
                        <td>${escapeHtml(money(item.previous_rate_ksh))}</td>
                        <td>${escapeHtml(money(item.new_rate_ksh))}</td>
                        <td>${escapeHtml(item.changed_by || "—")}</td>
                        <td>${escapeHtml(item.created_at ? new Date(item.created_at).toLocaleString() : "—")}</td>
                    </tr>`).join("");
            }
        } catch (error) {
            console.info("Coin settings endpoint is not available yet:", error.message);
        }
    }

    const DEFAULT_MAINT_TITLE = "We\u2019ll be right back";
    const DEFAULT_MAINT_TEXT = "GasHub is down for scheduled maintenance. Please check again in a little while.";

    function updateMaintenancePreview() {
        const t = document.getElementById("maintenanceTitle")?.value.trim();
        const m = document.getElementById("maintenanceText")?.value.trim();
        const pt = document.getElementById("maintenancePreviewTitle");
        const pm = document.getElementById("maintenancePreviewText");
        if (pt) pt.textContent = t || DEFAULT_MAINT_TITLE;
        if (pm) pm.textContent = m || DEFAULT_MAINT_TEXT;
    }
    document.getElementById("maintenanceTitle")?.addEventListener("input", updateMaintenancePreview);
    document.getElementById("maintenanceText")?.addEventListener("input", updateMaintenancePreview);

    async function loadPlatformSettings() {
        try {
            const data = await superRequest("/api/admin/settings/platform");
            const settings = data.settings || data;

            const mt = document.getElementById("maintenanceTitle"), mm = document.getElementById("maintenanceText");
            if (mt) mt.value = settings.maintenance_title || "";
            if (mm) mm.value = settings.maintenance_message || "";
            updateMaintenancePreview();

            ["maintenance_mode", "customer_notifications", "dealer_availability"]
                .forEach((key, index) => {
                    const input = document.getElementById([
                        "maintenanceMode",
                        "customerNotifications",
                        "dealerAvailability"
                    ][index]);

                    if (input && settings[key] != null) {
                        input.checked = Boolean(settings[key]);
                    }
                });
        } catch (error) {
            console.info("Platform settings endpoint is not available yet:", error.message);
        }
    }

    document.getElementById("coinSettingsForm")?.addEventListener("submit", async event => {
        event.preventDefault();

        const rate = Number(coinRateInput?.value);
        if (!Number.isFinite(rate) || rate <= 0) {
            showMessage("Enter an exchange rate greater than zero.");
            return;
        }

        const minRedeem = Number(minRedeemInput?.value);
        if (!Number.isInteger(minRedeem) || minRedeem < 1) {
            showMessage("Enter a whole number of coins (1 or more) for the minimum needed to spend coins.");
            return;
        }

        const button = document.getElementById("saveCoinRateButton");

        try {
            if (button) {
                button.disabled = true;
                button.textContent = "Saving…";
            }

            const result = await requestSettings("/api/admin/settings/coins", {
                method: "PUT",
                body: { coin_rate_ksh: rate, min_redeem_points: minRedeem }
            });

            showMessage(result.message || "GasHub Coin settings saved.", "success");

            if (Array.isArray(result.history)) {
                const tbody = document.getElementById("coinRateHistory");

                if (tbody) {
                    tbody.innerHTML = result.history.map(item => `
                        <tr>
                            <td>${escapeHtml(money(item.previous_rate_ksh))}</td>
                            <td>${escapeHtml(money(item.new_rate_ksh))}</td>
                            <td>${escapeHtml(item.changed_by || "—")}</td>
                            <td>${escapeHtml(item.created_at ? new Date(item.created_at).toLocaleString() : "—")}</td>
                        </tr>`).join("");
                }
            }
        } catch (error) {
            showMessage(error.message || "Could not save the exchange rate. The backend route may need to be added.");
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = "Save Coin Settings";
            }
        }
    });

    document.getElementById("socialLinksForm")?.addEventListener("submit", async event => {
        event.preventDefault();

        const links = Object.fromEntries(
            Object.entries(settingFields.social).map(([key, input]) => [
                key,
                input?.value.trim() || ""
            ])
        );

        links.active = Object.fromEntries(Object.entries(socialSwitches).map(([key, box]) => [key, Boolean(box && box.checked)]));

        const support = Object.fromEntries(
            Object.entries(settingFields.support).map(([key, input]) => [
                key,
                input?.value.trim() || ""
            ])
        );

        const button = document.getElementById("saveSocialSettingsButton");

        try {
            if (button) {
                button.disabled = true;
                button.textContent = "Saving…";
            }

            const result = await requestSettings("/api/admin/settings/social", {
                method: "PUT",
                body: { social_links: links, support }
            });

            showMessage(result.message || "Social media and contact details saved.", "success");
        } catch (error) {
            showMessage(error.message || "Could not save social/contact settings. Check the backend settings route.");
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = "Save Social & Contact Details";
            }
        }
    });

    document.getElementById("platformSettingsForm")?.addEventListener("submit", async event => {
        event.preventDefault();

        const payload = {
            maintenance_mode: Boolean(document.getElementById("maintenanceMode")?.checked),
            customer_notifications: Boolean(document.getElementById("customerNotifications")?.checked),
            dealer_availability: Boolean(document.getElementById("dealerAvailability")?.checked),
            maintenance_title: document.getElementById("maintenanceTitle")?.value.trim() || "",
            maintenance_message: document.getElementById("maintenanceText")?.value.trim() || ""
        };

        const button = document.getElementById("savePlatformSettingsButton");

        try {
            if (button) {
                button.disabled = true;
                button.textContent = "Saving…";
            }

            const result = await superRequest("/api/admin/settings/platform", {
                method: "PUT",
                body: payload
            });

            showMessage(result.message || "Platform settings saved.", "success");
        } catch (error) {
            showMessage(error.message || "Could not save platform settings. Check the backend settings route.");
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = "Save Platform Settings";
            }
        }
    });


    // Earn GasHub Points: points per invited friend and per social follow.
    const earnFields = {
        enabled: document.getElementById("earnEnabled"),
        referralPoints: document.getElementById("earnReferralPoints"),
        referralRequires: document.getElementById("earnReferralRequires"),
        referralMaxFriends: document.getElementById("earnReferralMax"),
        follow: {
            facebook: document.getElementById("earnFollowFacebook"),
            instagram: document.getElementById("earnFollowInstagram"),
            tiktok: document.getElementById("earnFollowTikTok"),
            youtube: document.getElementById("earnFollowYouTube"),
            x: document.getElementById("earnFollowX")
        }
    };

    async function loadEarnSettings() {
        if (!earnFields.enabled) return;
        try {
            const data = await requestSettings("/api/admin/settings/earn");
            const s = data.settings || {};
            earnFields.enabled.checked = s.enabled !== false;
            if (s.referralPoints != null) earnFields.referralPoints.value = s.referralPoints;
            if (s.referralRequires) earnFields.referralRequires.value = s.referralRequires;
            if (s.referralMaxFriends != null) earnFields.referralMaxFriends.value = s.referralMaxFriends;
            Object.entries(earnFields.follow).forEach(([key, input]) => {
                if (input && s.followPoints && s.followPoints[key] != null) input.value = s.followPoints[key];
            });
            const set = Array.isArray(data.accounts_set) ? data.accounts_set : [];
            const hint = document.getElementById("earnAccountsHint");
            if (hint) hint.textContent = set.length
                ? `Pages with a link saved (shown to customers when points are above 0): ${set.join(", ")}.`
                : "No social media links are saved yet. Add them in the Social Media section above so customers can follow.";
        } catch (error) {
            console.info("Earn settings endpoint is not available yet:", error.message);
        }
    }

    /* ---------- points for purchases (online vs cash) ---------- */
    const ppFields = {
        onlineEnabled: document.getElementById("onlinePointsEnabled"),
        cashEnabled: document.getElementById("cashPointsEnabled"),
        onlinePoints: document.getElementById("onlinePointsAmount"),
        cashPoints: document.getElementById("cashPointsAmount")
    };

    function syncPurchasePointsUi() {
        if (ppFields.onlinePoints) ppFields.onlinePoints.disabled = !ppFields.onlineEnabled?.checked;
        if (ppFields.cashPoints) ppFields.cashPoints.disabled = !ppFields.cashEnabled?.checked;
        const hint = (id, on, base) => { const el = document.getElementById(id); if (el) el.textContent = on ? base : "Switched off: customers earn no points for this payment type."; };
        hint("onlinePointsHint", ppFields.onlineEnabled?.checked, "Added once when the payment is confirmed.");
        hint("cashPointsHint", ppFields.cashEnabled?.checked, "Added once when the dealer confirms the cash.");
    }
    ppFields.onlineEnabled?.addEventListener("change", syncPurchasePointsUi);
    ppFields.cashEnabled?.addEventListener("change", syncPurchasePointsUi);

    async function loadPurchasePoints() {
        if (!ppFields.onlineEnabled) return;
        try {
            const data = await requestSettings("/api/admin/settings/purchase-points");
            const s = data.settings || {};
            ppFields.onlineEnabled.checked = s.onlineEnabled !== false;
            ppFields.cashEnabled.checked = s.cashEnabled !== false;
            if (s.onlinePoints != null) ppFields.onlinePoints.value = s.onlinePoints;
            if (s.cashPoints != null) ppFields.cashPoints.value = s.cashPoints;
        } catch (error) {
            console.info("Purchase points endpoint is not available yet:", error.message);
        }
        syncPurchasePointsUi();
    }

    document.getElementById("purchasePointsForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const online = Number(ppFields.onlinePoints.value), cash = Number(ppFields.cashPoints.value);
        if (!Number.isInteger(online) || online < 0 || !Number.isInteger(cash) || cash < 0) {
            showMessage("Enter a whole number of points (0 or more) for both online and cash payments.");
            return;
        }
        const button = document.getElementById("savePurchasePointsButton");
        try {
            if (button) { button.disabled = true; button.textContent = "Saving…"; }
            const result = await requestSettings("/api/admin/settings/purchase-points", {
                method: "PUT",
                body: {
                    onlineEnabled: ppFields.onlineEnabled.checked, onlinePoints: online,
                    cashEnabled: ppFields.cashEnabled.checked, cashPoints: cash
                }
            });
            showMessage(result.message || "Points for purchases saved.", "success");
        } catch (error) {
            showMessage(error.message || "Could not save the purchase points settings.");
        } finally {
            if (button) { button.disabled = false; button.textContent = "Save Purchase Points"; }
        }
    });

    document.getElementById("earnSettingsForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const button = document.getElementById("saveEarnButton");
        const whole = input => Math.max(0, Math.floor(Number(input?.value) || 0));

        try {
            if (button) { button.disabled = true; button.textContent = "Saving…"; }
            const result = await requestSettings("/api/admin/settings/earn", {
                method: "PUT",
                body: {
                    enabled: Boolean(earnFields.enabled.checked),
                    referralPoints: whole(earnFields.referralPoints),
                    referralRequires: earnFields.referralRequires.value,
                    referralMaxFriends: whole(earnFields.referralMaxFriends),
                    followPoints: Object.fromEntries(Object.entries(earnFields.follow).map(([k, input]) => [k, whole(input)]))
                }
            });
            showMessage(result.message || "Earn GasHub Points settings saved.", "success");
        } catch (error) {
            showMessage(error.message || "Could not save the earn settings.");
        } finally {
            if (button) { button.disabled = false; button.textContent = "Save Earn Settings"; }
        }
    });

    /* ---------- lock / unlock UI ---------- */
    const superArea = document.getElementById("superArea");
    const lockCards = [document.getElementById("superLock")];

    function applyLockState() {
        const open = Boolean(superToken);
        if (superArea) superArea.hidden = !open;
        lockCards.forEach(el => { if (el) el.hidden = open; });
    }

    function relock(message) {
        superToken = "";
        /* the payment account is only shown while unlocked, so clear what was loaded */
        ["payAccNumber", "payAccAccountNumber", "payAccName", "payAccInstructions"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
        applyLockState();
        if (message) showMessage(message);
    }

    /* the server says the unlock expired (15 minutes idle) */
    window.addEventListener("unhandledrejection", event => {
        if (String(event.reason && event.reason.message || "").startsWith("This section is locked")) relock("Locked after a period of inactivity. Enter the super admin password to continue.");
    });

    lockCards.forEach(card => {
        card?.querySelector("form")?.addEventListener("submit", async event => {
            event.preventDefault();
            const input = card.querySelector(".super-unlock-input");
            const button = card.querySelector("button[type=submit]");
            try {
                button.disabled = true;
                const result = await GasHubAdmin.adminApiRequest("/api/admin/settings/lock/unlock", { method: "POST", body: { password: input.value } });
                superToken = result.token || "";
                input.value = "";
                applyLockState();
                showMessage("Unlocked. The section locks again after 15 minutes without use, or when you reload.", "success");
                loadAdmins();
                loadPlatformSettings();
                loadPaymentAccount();
            } catch (error) {
                input.value = "";
                showMessage(error.message || "Could not unlock.");
            } finally {
                button.disabled = false;
            }
        });
    });

    document.getElementById("relockButton")?.addEventListener("click", async () => {
        try { await superRequest("/api/admin/settings/lock/lock", { method: "POST", body: {} }); } catch (e) { /* locking locally is enough */ }
        relock("Locked.");
    });

    document.getElementById("superPasswordForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const current = document.getElementById("superCurrentPassword");
        const next = document.getElementById("superNewPassword");
        const confirm = document.getElementById("superConfirmPassword");
        const button = document.getElementById("saveSuperPasswordButton");
        if (next.value !== confirm.value) { showMessage("The new passwords do not match."); return; }
        if (next.value.length < 8) { showMessage("The new password must be at least 8 characters."); return; }
        try {
            button.disabled = true;
            button.textContent = "Changing...";
            await superRequest("/api/admin/settings/lock/password", { method: "PUT", body: { current_password: current.value, new_password: next.value } });
            event.target.reset();
            relock();
            showMessage("Super admin password changed. Unlock again with the new password.", "success");
        } catch (error) {
            showMessage(error.message || "Could not change the super admin password.");
        } finally {
            button.disabled = false;
            button.textContent = "Change Super Admin Password";
        }
    });

    /* sidebar collapse (desktop) + menu button (phones) */
    try { if (localStorage.getItem("gashub_admin_sidebar_collapsed") === "true") document.body.classList.add("sidebar-collapsed"); } catch (e) { }
    document.getElementById("sidebarCollapseButton")?.addEventListener("click", () => {
        const collapsed = document.body.classList.toggle("sidebar-collapsed");
        try { localStorage.setItem("gashub_admin_sidebar_collapsed", String(collapsed)); } catch (e) { }
    });
    document.getElementById("sidebarMobileOverlay")?.addEventListener("click", () => document.body.classList.remove("sidebar-open"));

    applyLockState();
    loadProfile();
    // GasHub payment account: where customers send their M-Pesa money.
    const payAcc = {
        type: document.getElementById("payAccType"),
        number: document.getElementById("payAccNumber"),
        numberLabel: document.getElementById("payAccNumberLabel"),
        accountGroup: document.getElementById("payAccAccountGroup"),
        account: document.getElementById("payAccAccountNumber"),
        name: document.getElementById("payAccName"),
        instructions: document.getElementById("payAccInstructions"),
        preview: document.getElementById("payAccPreview"),
        hint: document.getElementById("payAccPreviewHint")
    };

    function updatePaymentAccountPreview() {
        if (!payAcc.type) return;
        const type = payAcc.type.value;
        const labels = { paybill: "Paybill number", till: "Till number", phone: "M-Pesa phone number" };
        payAcc.numberLabel.textContent = labels[type] || "Number";
        payAcc.accountGroup.hidden = type !== "paybill";
        const number = payAcc.number.value.trim();
        if (!number) {
            payAcc.preview.textContent = "Not set yet";
            payAcc.hint.textContent = "Until this is saved, customers are told to contact support to pay.";
            return;
        }
        const parts = {
            paybill: `Paybill ${number}` + (payAcc.account.value.trim() ? ` · Account ${payAcc.account.value.trim()}` : ""),
            till: `Buy Goods Till ${number}`,
            phone: `Send Money to ${number}`
        };
        payAcc.preview.textContent = parts[type] + (payAcc.name.value.trim() ? ` · ${payAcc.name.value.trim()}` : "");
        payAcc.hint.textContent = "Customers see this after they place an M-Pesa order and are asked for the M-Pesa code.";
    }

    async function loadPaymentAccount() {
        if (!payAcc.type) return;
        try {
            const data = await superRequest("/api/admin/settings/payment-account");
            const s = data.settings || {};
            payAcc.type.value = s.type || "paybill";
            payAcc.number.value = s.number || "";
            payAcc.account.value = s.account_number || "";
            payAcc.name.value = s.account_name || "";
            payAcc.instructions.value = s.instructions || "";
        } catch (error) {
            console.info("Could not load the payment account:", error.message);
        }
        updatePaymentAccountPreview();
    }

    [payAcc.type, payAcc.number, payAcc.account, payAcc.name].forEach(el => {
        el?.addEventListener("input", updatePaymentAccountPreview);
        el?.addEventListener("change", updatePaymentAccountPreview);
    });

    document.getElementById("paymentAccountForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const button = document.getElementById("savePaymentAccountButton");
        try {
            if (button) { button.disabled = true; button.textContent = "Saving…"; }
            const result = await superRequest("/api/admin/settings/payment-account", {
                method: "PUT",
                body: {
                    type: payAcc.type.value,
                    number: payAcc.number.value.trim(),
                    account_number: payAcc.account.value.trim(),
                    account_name: payAcc.name.value.trim(),
                    instructions: payAcc.instructions.value.trim()
                }
            });
            if (result.settings) {
                payAcc.number.value = result.settings.number || "";
                updatePaymentAccountPreview();
            }
            showMessage(result.message || "GasHub payment account saved.", "success");
        } catch (error) {
            showMessage(error.message || "Could not save the payment account.");
        } finally {
            if (button) { button.disabled = false; button.textContent = "Save Payment Account"; }
        }
    });

    // GasHub mobile app (Google Play): link + install points.
    const appFields = {
        packageId: document.getElementById("appPackageId"),
        points: document.getElementById("appPoints"),
        storeUrl: document.getElementById("appStoreUrl"),
        forceLive: document.getElementById("appForceLive")
    };

    function showAppStatus(data) {
        const tag = document.getElementById("appLiveTag"), hint = document.getElementById("appStatusHint");
        if (tag) tag.textContent = data.live ? "Live on Play Store" : "Not live yet";
        if (hint) {
            hint.textContent = data.live
                ? "The app is live, so customers see the Download button at the top of the site and the link in their profile."
                : "Customers do not see a download link yet. It appears automatically once the app is published on Google Play.";
            if (!data.install_key_set) hint.textContent += " Add APP_INSTALL_KEY to the server .env file (and put the same key in the app) so the app can confirm installs; until then no install points can be given.";
        }
    }

    async function loadAppSettings() {
        if (!appFields.packageId) return;
        try {
            const data = await requestSettings("/api/admin/settings/app");
            const s = data.settings || {};
            appFields.packageId.value = s.packageId || "";
            appFields.points.value = s.points != null ? s.points : 50;
            appFields.storeUrl.value = s.storeUrl || "";
            appFields.forceLive.checked = Boolean(s.forceLive);
            showAppStatus(data);
        } catch (error) {
            console.info("App settings endpoint is not available yet:", error.message);
        }
    }

    document.getElementById("appSettingsForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const button = document.getElementById("saveAppButton");
        try {
            if (button) { button.disabled = true; button.textContent = "Saving…"; }
            const result = await requestSettings("/api/admin/settings/app", {
                method: "PUT",
                body: {
                    packageId: appFields.packageId.value.trim(),
                    points: Math.max(0, Math.floor(Number(appFields.points.value) || 0)),
                    storeUrl: appFields.storeUrl.value.trim(),
                    forceLive: Boolean(appFields.forceLive.checked)
                }
            });
            showAppStatus(result);
            showMessage(result.message || "App settings saved.", "success");
        } catch (error) {
            showMessage(error.message || "Could not save the app settings.");
        } finally {
            if (button) { button.disabled = false; button.textContent = "Save App Settings"; }
        }
    });

    loadExtraSettings();
    loadAppSettings();
    loadEarnSettings();
    loadPurchasePoints();
    updatePaymentAccountPreview();   /* the account itself is loaded after the super admin unlock */

    /* ---------- collapsible settings cards ---------- */
    (function setupCollapsibleCards() {
        const cards = document.querySelectorAll(".dashboard-content .content-card:not(.profile-card):not(.super-lock-card)");
        cards.forEach((card) => {
            const header = card.querySelector(":scope > .card-header");
            if (!header) return;
            const chevron = document.createElement("span");
            chevron.className = "card-chevron";
            chevron.setAttribute("aria-hidden", "true");
            header.appendChild(chevron);
            header.setAttribute("role", "button");
            header.setAttribute("tabindex", "0");
            card.classList.add("is-collapsible", "is-collapsed");
            header.setAttribute("aria-expanded", "false");

            const toggle = (open) => {
                const willOpen = typeof open === "boolean" ? open : card.classList.contains("is-collapsed");
                card.classList.toggle("is-collapsed", !willOpen);
                header.setAttribute("aria-expanded", String(willOpen));
            };
            card._toggle = toggle;
            header.addEventListener("click", (e) => { if (e.target.closest("button, a, input, select")) return; toggle(); });
            header.addEventListener("keydown", (e) => {
                if (e.target !== header) return;
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
            });
        });

        const openFromHash = () => {
            const target = location.hash && document.querySelector(location.hash);
            const card = target && target.closest(".is-collapsible");
            if (card && card._toggle) card._toggle(true);
        };
        openFromHash();
        window.addEventListener("hashchange", openFromHash);
    })();
});