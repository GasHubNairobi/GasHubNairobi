/* =========================================================
GAS HUB - DEALER SETTINGS
dealer-settings.js

Handles:

* Dealer settings display
* Notification preferences
* Password form UI
* Password validation
* Dealer account information
* Logout confirmation
* Support/contact action
* Local settings storage

No backend endpoints are assumed here.
========================================================= */

(function () {
"use strict";


/* =====================================================
   STATE
   ===================================================== */

const settingsState = {
    dealer: null,
    preferences: {
        orderNotifications: true,
        orderStatusNotifications: true,
        lowStockNotifications: true
    }
};


/* =====================================================
   DOM READY
   ===================================================== */

document.addEventListener(
    "DOMContentLoaded",
    initializeSettings
);


/* =====================================================
   INITIALIZE
   ===================================================== */

function initializeSettings() {
    loadDealerData();

    loadPreferences();

    populateAccountInformation();

    initializeNotificationSettings();

    initializePasswordSettings();

    initializePasswordToggles();

    initializeSupportAction();

    initializeLogout();

    initializeDealerDisplay();
}


/* =====================================================
   LOAD DEALER DATA
   ===================================================== */

function loadDealerData() {
    const keys = [
        "dealer",
        "dealerData",
        "dealerProfile",
        "gasHubDealer"
    ];


    for (const key of keys) {
        try {
            const stored =
                localStorage.getItem(key);


            if (!stored) {
                continue;
            }


            const parsed =
                JSON.parse(stored);


            if (
                parsed &&
                typeof parsed === "object"
            ) {
                settingsState.dealer =
                    parsed;

                return;
            }

        } catch (error) {
            console.warn(
                "Unable to read dealer data from localStorage."
            );
        }
    }
}


/* =====================================================
   LOAD PREFERENCES
   ===================================================== */

function loadPreferences() {
    try {
        const stored =
            localStorage.getItem(
                "gasHubDealerSettings"
            );


        if (!stored) {
            return;
        }


        const parsed =
            JSON.parse(stored);


        if (
            parsed &&
            typeof parsed === "object"
        ) {
            settingsState.preferences = {
                ...settingsState.preferences,
                ...parsed
            };
        }

    } catch (error) {
        console.warn(
            "Unable to load dealer settings."
        );
    }


    setCheckbox(
        "orderNotifications",
        settingsState.preferences
            .orderNotifications
    );


    setCheckbox(
        "orderStatusNotifications",
        settingsState.preferences
            .orderStatusNotifications
    );


    setCheckbox(
        "lowStockNotifications",
        settingsState.preferences
            .lowStockNotifications
    );
}


/* =====================================================
   SAVE PREFERENCES
   ===================================================== */

function savePreferences() {
    try {
        localStorage.setItem(
            "gasHubDealerSettings",
            JSON.stringify(
                settingsState.preferences
            )
        );
    } catch (error) {
        console.warn(
            "Unable to save dealer settings."
        );
    }
}


/* =====================================================
   ACCOUNT INFORMATION
   ===================================================== */

function populateAccountInformation() {
    const dealer =
        settingsState.dealer;


    if (!dealer) {
        return;
    }


    const businessName =
        getDealerValue(
            dealer,
            [
                "businessName",
                "business_name",
                "dealerName",
                "dealer_name",
                "name"
            ]
        );


    const dealerId =
        getDealerValue(
            dealer,
            [
                "dealerId",
                "dealer_id",
                "id"
            ]
        );


    const accountStatus =
        getDealerValue(
            dealer,
            [
                "accountStatus",
                "account_status",
                "status"
            ]
        );


    setText(
        "[data-settings-business-name]",
        businessName || "—"
    );


    setText(
        "[data-settings-dealer-id]",
        dealerId || "—"
    );


    if (accountStatus) {
        setText(
            "[data-settings-account-status]",
            formatAccountStatus(
                accountStatus
            )
        );

        updateAccountStatusClass(
            accountStatus
        );
    }
}


function getDealerValue(
    dealer,
    keys
) {
    for (const key of keys) {
        if (
            dealer[key] !== undefined &&
            dealer[key] !== null &&
            dealer[key] !== ""
        ) {
            return dealer[key];
        }
    }

    return "";
}


function formatAccountStatus(
    status
) {
    const value =
        String(status)
            .trim()
            .toLowerCase();


    if (
        value === "active" ||
        value === "approved"
    ) {
        return "Active";
    }


    if (
        value === "inactive" ||
        value === "disabled"
    ) {
        return "Inactive";
    }


    if (
        value === "pending"
    ) {
        return "Pending";
    }


    if (
        value === "suspended"
    ) {
        return "Suspended";
    }


    return String(status);
}


function updateAccountStatusClass(
    status
) {
    const element =
        document.querySelector(
            "[data-settings-account-status]"
        );


    if (!element) {
        return;
    }


    element.classList.remove(
        "active",
        "inactive",
        "pending",
        "suspended"
    );


    const value =
        String(status)
            .trim()
            .toLowerCase();


    if (
        value === "active" ||
        value === "approved"
    ) {
        element.classList.add(
            "active"
        );
    } else if (
        value === "inactive" ||
        value === "disabled"
    ) {
        element.classList.add(
            "inactive"
        );
    } else if (
        value === "pending"
    ) {
        element.classList.add(
            "pending"
        );
    } else if (
        value === "suspended"
    ) {
        element.classList.add(
            "suspended"
        );
    }
}


/* =====================================================
   NOTIFICATION SETTINGS
   ===================================================== */

function initializeNotificationSettings() {
    const settings = [
        {
            id: "orderNotifications",
            key: "orderNotifications"
        },
        {
            id: "orderStatusNotifications",
            key: "orderStatusNotifications"
        },
        {
            id: "lowStockNotifications",
            key: "lowStockNotifications"
        }
    ];


    settings.forEach(function (setting) {
        const checkbox =
            document.getElementById(
                setting.id
            );


        if (!checkbox) {
            return;
        }


        checkbox.addEventListener(
            "change",
            function () {
                settingsState
                    .preferences[
                        setting.key
                    ] = checkbox.checked;


                savePreferences();


                showSettingsMessage(
                    "Settings updated.",
                    "success"
                );
            }
        );
    });
}


/* =====================================================
   PASSWORD SETTINGS
   ===================================================== */

function initializePasswordSettings() {
    const openButton =
        document.getElementById(
            "changePasswordButton"
        );


    const cancelButton =
        document.getElementById(
            "cancelPasswordChange"
        );


    const panel =
        document.getElementById(
            "passwordPanel"
        );


    const form =
        document.getElementById(
            "changePasswordForm"
        );


    if (
        openButton &&
        panel
    ) {
        openButton.addEventListener(
            "click",
            function () {
                panel.hidden = false;

                openButton.hidden = true;


                const currentPassword =
                    document.getElementById(
                        "currentPassword"
                    );


                if (currentPassword) {
                    currentPassword.focus();
                }
            }
        );
    }


    if (
        cancelButton &&
        panel &&
        openButton
    ) {
        cancelButton.addEventListener(
            "click",
            function () {
                resetPasswordForm();

                panel.hidden = true;

                openButton.hidden = false;
            }
        );
    }


    if (form) {
        form.addEventListener(
            "submit",
            function (event) {
                event.preventDefault();

                handlePasswordChange();
            }
        );


        form.querySelectorAll(
            "input"
        ).forEach(function (input) {
            input.addEventListener(
                "input",
                function () {
                    clearFieldError(this);
                }
            );
        });
    }
}


async function handlePasswordChange() {
    const currentPassword =
        getInputValue(
            "currentPassword"
        );


    const newPassword =
        getInputValue(
            "newPassword"
        );


    const confirmPassword =
        getInputValue(
            "confirmNewPassword"
        );


    clearPasswordErrors();


    let valid = true;


    if (!currentPassword) {
        markFieldError(
            "currentPassword",
            "Enter your current password."
        );

        valid = false;
    }


    if (!newPassword) {
        markFieldError(
            "newPassword",
            "Enter a new password."
        );

        valid = false;
    } else if (
        newPassword.length < 8
    ) {
        markFieldError(
            "newPassword",
            "Password must be at least 8 characters."
        );

        valid = false;
    }


    if (!confirmPassword) {
        markFieldError(
            "confirmNewPassword",
            "Confirm your new password."
        );

        valid = false;
    } else if (
        newPassword !== confirmPassword
    ) {
        markFieldError(
            "confirmNewPassword",
            "Passwords do not match."
        );

        valid = false;
    }


    if (
        currentPassword &&
        newPassword &&
        currentPassword === newPassword
    ) {
        markFieldError(
            "newPassword",
            "New password must be different from your current password."
        );

        valid = false;
    }


    if (!valid) {
        showSettingsMessage(
            "Please correct the highlighted fields.",
            "error"
        );

        return;
    }


    const saveButton = document.getElementById("savePasswordButton");
    const token = (function () {
        try { return localStorage.getItem("gashub_dealer_token") || sessionStorage.getItem("gashub_dealer_token") || ""; } catch (e) { return ""; }
    })();

    if (!token) {
        showSettingsMessage("Your session has expired. Please sign in again.", "error");
        window.setTimeout(function () { window.location.replace("/dealer/dealer-login.html"); }, 1500);
        return;
    }

    if (saveButton) saveButton.disabled = true;

    try {
        const response = await fetch("/api/dealers/change-password", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: "Bearer " + token
            },
            cache: "no-store",
            body: JSON.stringify({
                current_password: currentPassword,
                new_password: newPassword
            })
        });

        let data = {};
        try { data = await response.json(); } catch (e) { data = {}; }

        if (response.status === 401) {
            showSettingsMessage("Your session has expired. Please sign in again.", "error");
            window.setTimeout(function () { window.location.replace("/dealer/dealer-login.html"); }, 1500);
            return;
        }

        if (!response.ok || !data.success) {
            if (data.field) {
                markFieldError(data.field, data.message || "Please check this field.");
            }
            showSettingsMessage(data.message || "The password could not be changed. Please try again.", "error");
            return;
        }

        resetPasswordForm();
        showSettingsMessage(data.message || "Your password has been changed. Please sign in again.", "success");

        // The server ended every session of this dealer, so clear this phone too and go to the login page.
        window.setTimeout(function () {
            try { removeFrontendSession(); } catch (e) { /* ignore */ }
            window.location.replace("/dealer/dealer-login.html");
        }, 2000);
    } catch (error) {
        showSettingsMessage("Could not reach GasHub. Check your connection and try again.", "error");
    } finally {
        if (saveButton) saveButton.disabled = false;
    }
}


function resetPasswordForm() {
    [
        "currentPassword",
        "newPassword",
        "confirmNewPassword"
    ].forEach(function (id) {
        setInputValue(
            id,
            ""
        );
    });


    clearPasswordErrors();
}


/* =====================================================
   PASSWORD VISIBILITY
   ===================================================== */

function initializePasswordToggles() {
    document
        .querySelectorAll(
            "[data-password-toggle]"
        )
        .forEach(function (button) {

            button.addEventListener(
                "click",
                function () {

                    const inputId =
                        button.getAttribute(
                            "data-password-toggle"
                        );


                    const input =
                        document.getElementById(
                            inputId
                        );


                    if (!input) {
                        return;
                    }


                    const icon =
                        button.querySelector(
                            "i"
                        );


                    if (
                        input.type ===
                        "password"
                    ) {
                        input.type =
                            "text";

                        button.setAttribute(
                            "aria-label",
                            "Hide password"
                        );


                        if (icon) {
                            icon.className =
                                "fa-regular fa-eye-slash";
                        }

                    } else {
                        input.type =
                            "password";

                        button.setAttribute(
                            "aria-label",
                            "Show password"
                        );


                        if (icon) {
                            icon.className =
                                "fa-regular fa-eye";
                        }
                    }
                }
            );
        });
}


/* =====================================================
   SUPPORT ACTION
   ===================================================== */

function initializeSupportAction() {
    const button =
        document.getElementById(
            "deactivateAccountButton"
        );


    if (!button) {
        return;
    }


    button.addEventListener(
        "click",
        function () {
            showSettingsMessage(
                "Please contact GAS HUB administration to request account deactivation.",
                "info"
            );
        }
    );
}


/* =====================================================
   LOGOUT
   ===================================================== */

function initializeLogout() {
    document
        .querySelectorAll(
            "[data-dealer-logout]"
        )
        .forEach(function (button) {

            button.addEventListener(
                "click",
                async function (event) {
                    /*
                     * Prevent dealer-main.js from performing
                     * a second action if it has already been
                     * attached to this button.
                     */
                    event.preventDefault();


                    const confirmed =
                        await GasHubDialog.confirm({
                            title: "Log out?",
                            message: "You will need to sign in again to manage your dealer account.",
                            confirmText: "Log out", tone: "primary", icon: "logout"
                        });


                    if (!confirmed) {
                        return;
                    }


                    /*
                     * We only remove frontend dealer session
                     * information if it exists.
                     *
                     * Actual authentication logout will be
                     * connected to the backend later.
                     */

                    removeFrontendSession();


                    window.location.href =
                        "dealer-login.html";
                }
            );
        });
}


function removeFrontendSession() {
    const sessionKeys = [
        "dealerSession",
        "gasHubDealerSession"
    ];


    sessionKeys.forEach(function (key) {
        try {
            localStorage.removeItem(key);
        } catch (error) {
            console.warn(
                "Unable to remove session:",
                key
            );
        }
    });
}


/* =====================================================
   DEALER HEADER DISPLAY
   ===================================================== */

function initializeDealerDisplay() {
    const dealer =
        settingsState.dealer;


    if (!dealer) {
        return;
    }


    const businessName =
        getDealerValue(
            dealer,
            [
                "businessName",
                "business_name",
                "dealerName",
                "dealer_name",
                "name"
            ]
        );


    const contactName =
        getDealerValue(
            dealer,
            [
                "contactName",
                "contact_name",
                "contactPerson",
                "contact_person"
            ]
        );


    const displayName =
        businessName ||
        contactName ||
        "Dealer";


    const initials =
        getInitials(
            displayName
        );


    document
        .querySelectorAll(
            "[data-dealer-avatar]"
        )
        .forEach(function (element) {
            if (element.classList.contains("has-logo")) {
                return;     /* a business picture is showing: leave it alone */
            }

            const letter =
                element.querySelector("#dealerAvatarInitial") ||
                element;

            letter.textContent =
                displayName
                    .trim()
                    .charAt(0)
                    .toUpperCase() || "D";
        });


    document
        .querySelectorAll(
            "[data-dealer-contact-name]"
        )
        .forEach(function (element) {
            element.textContent =
                displayName;
        });
}


function getInitials(name) {
    const value =
        String(name || "")
            .trim();


    if (!value) {
        return "D";
    }


    const parts =
        value
            .split(/\s+/)
            .filter(Boolean);


    if (parts.length === 1) {
        return parts[0]
            .substring(0, 2)
            .toUpperCase();
    }


    return (
        parts[0].charAt(0) +
        parts[parts.length - 1].charAt(0)
    ).toUpperCase();
}


/* =====================================================
   FIELD HELPERS
   ===================================================== */

function getInputValue(id) {
    const input =
        document.getElementById(id);


    if (!input) {
        return "";
    }


    return String(
        input.value || ""
    ).trim();
}


function setInputValue(
    id,
    value
) {
    const input =
        document.getElementById(id);


    if (!input) {
        return;
    }


    input.value =
        value === null ||
        value === undefined
            ? ""
            : value;
}


function setCheckbox(
    id,
    value
) {
    const checkbox =
        document.getElementById(id);


    if (!checkbox) {
        return;
    }


    checkbox.checked =
        Boolean(value);
}


function setText(
    selector,
    value
) {
    document
        .querySelectorAll(selector)
        .forEach(function (element) {
            element.textContent =
                value || "—";
        });
}


/* =====================================================
   FIELD ERRORS
   ===================================================== */

function markFieldError(
    inputId,
    message
) {
    const input =
        document.getElementById(
            inputId
        );


    if (!input) {
        return;
    }


    input.classList.add(
        "dealer-settings-input-error"
    );


    input.setAttribute(
        "aria-invalid",
        "true"
    );


    const error =
        document.querySelector(
            `[data-error-for="${inputId}"]`
        );


    if (error) {
        error.textContent =
            message;
    }
}


function clearFieldError(input) {
    if (!input) {
        return;
    }


    input.classList.remove(
        "dealer-settings-input-error"
    );


    input.removeAttribute(
        "aria-invalid"
    );


    const error =
        document.querySelector(
            `[data-error-for="${input.id}"]`
        );


    if (error) {
        error.textContent = "";
    }
}


function clearPasswordErrors() {
    document
        .querySelectorAll(
            ".dealer-settings-input-error"
        )
        .forEach(function (input) {

            input.classList.remove(
                "dealer-settings-input-error"
            );

            input.removeAttribute(
                "aria-invalid"
            );
        });


    document
        .querySelectorAll(
            ".dealer-settings-field-error"
        )
        .forEach(function (error) {
            error.textContent = "";
        });
}


/* =====================================================
   SETTINGS MESSAGE
   ===================================================== */

function showSettingsMessage(
    message,
    type
) {
    const element =
        document.getElementById(
            "settingsMessage"
        );


    if (!element) {
        return;
    }


    element.textContent =
        message;


    element.className =
        "dealer-settings-message visible " +
        (type || "info");


    window.clearTimeout(
        showSettingsMessage.timeout
    );


    showSettingsMessage.timeout =
        window.setTimeout(
            function () {
                element.classList.remove(
                    "visible"
                );
            },
            6000
        );
}


/* =====================================================
   PUBLIC API
   ===================================================== */

window.DealerSettings = {
    loadDealerData,
    loadPreferences,
    savePreferences,
    populateAccountInformation,
    handlePasswordChange,
    resetPasswordForm,
    showSettingsMessage
};


})();
