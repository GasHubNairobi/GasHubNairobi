document.addEventListener("DOMContentLoaded", () => {

    const orderLoading = document.getElementById("orderLoading");
    const orderError = document.getElementById("orderError");
    const orderContent = document.getElementById("orderContent");

    const menuButton = document.getElementById("menuButton");
    const mobileMenu = document.getElementById("mobileMenu");

    const cancelOrderButton = document.getElementById("cancelOrderButton");
    const actionMessage = document.getElementById("actionMessage");

    /*
        The checkout page currently saves the latest order
        using this localStorage key.
    */
    const STORAGE_KEY = "gasHubLastOrder";

    /*
        Get order ID from the URL.

        Example:
        customer-order-details.html?orderId=GAS-123456
    */
    const params = new URLSearchParams(window.location.search);
    const requestedOrderId = params.get("orderId");


    /* -----------------------------
       MOBILE MENU
    ----------------------------- */

    if (menuButton && mobileMenu) {

        menuButton.addEventListener("click", () => {
            mobileMenu.classList.toggle("open");
        });

        mobileMenu.querySelectorAll("a").forEach(link => {
            link.addEventListener("click", () => {
                mobileMenu.classList.remove("open");
            });
        });
    }


    /* -----------------------------
       HELPER FUNCTIONS
    ----------------------------- */

    function formatCurrency(value) {

        const number = Number(value) || 0;

        return `KSh ${number.toLocaleString("en-KE")}`;
    }


    function safeValue(value, fallback = "—") {

        if (
            value === undefined ||
            value === null ||
            String(value).trim() === ""
        ) {
            return fallback;
        }

        return String(value);
    }


    function setText(id, value, fallback = "—") {

        const element = document.getElementById(id);

        if (!element) return;

        element.textContent = safeValue(value, fallback);
    }


    function getOrderFromStorage() {

        const storedOrder = localStorage.getItem(STORAGE_KEY);

        if (!storedOrder) {
            return null;
        }

        try {
            return JSON.parse(storedOrder);
        } catch (error) {
            console.error("Could not read saved order:", error);
            return null;
        }
    }


    /* -----------------------------
       LOAD ORDER
    ----------------------------- */

    function loadOrder() {

        const order = getOrderFromStorage();

        if (!order) {
            showError();
            return;
        }

        /*
            If an order ID exists in the URL, make sure
            the saved order matches it.
        */
        if (
            requestedOrderId &&
            order.orderId &&
            requestedOrderId !== order.orderId
        ) {
            showError();
            return;
        }

        renderOrder(order);
    }


    /* -----------------------------
       RENDER ORDER
    ----------------------------- */

    function renderOrder(order) {

        setText("orderId", order.orderId, "—");

        setText(
            "orderTitle",
            order.productName || "Your Order",
            "Your Order"
        );


        /* Status */

        const status = normalizeStatus(order.status || "Pending");

        updateStatus(status);
        updateTracking(status);


        /* Date */

        const orderDate =
            order.createdAt ||
            order.date ||
            order.orderDate;

        setText(
            "placedDate",
            formatDate(orderDate),
            "Order placed"
        );


        /* Product */

        const productImage = document.getElementById("productImage");

        if (productImage) {

            const image =
                order.image ||
                order.productImage ||
                "Images/logo.png";

            productImage.src = image;
        }

        setText(
            "productName",
            order.productName || order.name,
            "Gas Cylinder"
        );

        setText(
            "productDetails",
            order.details || order.productDetails,
            "Gas product"
        );

        setText(
            "productQuantity",
            order.quantity || 1,
            "1"
        );

        setText(
            "productPrice",
            formatCurrency(order.price || 0),
            "KSh 0"
        );


        /* Dealer */

        const dealer =
            order.dealer ||
            order.dealerName ||
            "GasHub Dealer";

        setText("dealerName", dealer, "GasHub Dealer");

        setText(
            "dealerLocation",
            order.dealerLocation ||
            order.location ||
            "GasHub dealer",
            "GasHub dealer"
        );

        const dealerInitial = document.getElementById("dealerInitial");

        if (dealerInitial) {
            dealerInitial.textContent =
                String(dealer).charAt(0).toUpperCase() || "G";
        }

        /* Show the dealer's uploaded logo instead of the letter */
        const showDealerLogo = function (logo) {
            const box = dealerInitial && dealerInitial.parentElement;
            if (!box || !logo) return;
            box.style.padding = "0";
            box.style.overflow = "hidden";
            const img = document.createElement("img");
            img.src = logo;
            img.alt = "";
            img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block";
            img.onerror = function () { img.remove(); dealerInitial.style.display = ""; };
            dealerInitial.style.display = "none";
            box.appendChild(img);
        };
        const knownLogo = order.dealerLogo || order.dealer_logo || "";
        const dealerRef = order.dealerId || order.dealer_id || "";
        if (knownLogo) {
            showDealerLogo(knownLogo);
        } else if (dealerRef) {
            fetch("/api/dealers/" + encodeURIComponent(dealerRef), { headers: { Accept: "application/json" } })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) { if (j && j.dealer && j.dealer.logo) showDealerLogo(j.dealer.logo); })
                .catch(function () { });
        }


        /* Delivery */

        const deliveryOption =
            order.deliveryOption ||
            order.delivery ||
            "delivery";

        setText(
            "deliveryOption",
            formatDeliveryOption(deliveryOption),
            "Delivery"
        );

        setText(
            "deliveryCounty",
            order.county ||
            order.deliveryCounty
        );

        setText(
            "deliveryTown",
            order.town ||
            order.deliveryTown
        );

        setText(
            "deliveryAddress",
            order.deliveryAddress ||
            order.address
        );

        setText(
            "deliveryLandmark",
            order.deliveryLandmark ||
            order.landmark
        );


        /* Payment */

        const paymentMethod =
            order.paymentMethod ||
            "mpesa";

        setText(
            "paymentMethod",
            order.paymentMethodChosen === false ? "Not chosen yet" : formatPaymentMethod(paymentMethod),
            "M-Pesa"
        );

        updatePaymentStatus(
            order.paymentStatus ||
            order.payment_state ||
            "Pending"
        );


        /* Price */

        const productTotal =
            Number(order.productTotal) ||
            Number(order.price || 0) *
            Number(order.quantity || 1);

        const deliveryFee =
            Number(order.deliveryFee) ||
            Number(order.deliveryPrice) ||
            0;

        const total =
            Number(order.total) ||
            productTotal + deliveryFee;

        setText(
            "summaryProductPrice",
            formatCurrency(productTotal)
        );

        setText(
            "summaryDelivery",
            formatCurrency(deliveryFee)
        );

        setText(
            "summaryTotal",
            formatCurrency(total)
        );


        /* Customer */

        setText(
            "customerName",
            order.customerName ||
            order.name
        );

        setText(
            "customerPhone",
            order.customerPhone ||
            order.phone
        );

        setText(
            "customerEmail",
            order.customerEmail ||
            order.email
        );


        /* Notes */

        const notes =
            order.orderNotes ||
            order.notes ||
            "";

        const notesCard = document.getElementById("notesCard");
        const notesElement = document.getElementById("orderNotes");

        if (notes.trim()) {

            if (notesElement) {
                notesElement.textContent = notes;
            }

            if (notesCard) {
                notesCard.style.display = "";
            }

        } else {

            if (notesElement) {
                notesElement.textContent =
                    "No additional notes.";
            }

        }


        /*
            Hide loading and show order.
        */
        orderLoading.hidden = true;
        orderError.hidden = true;
        orderContent.hidden = false;
    }


    /* -----------------------------
       STATUS
    ----------------------------- */

    function normalizeStatus(status) {

        return String(status)
            .trim()
            .toLowerCase()
            .replace(/[_-]+/g, " ");
    }


    function updateStatus(status) {

        const statusElement =
            document.getElementById("orderStatus");

        if (!statusElement) return;

        let label = "Pending";

        if (status.includes("cancel")) {
            label = "Cancelled";
        } else if (
            status.includes("complete") ||
            status.includes("delivered")
        ) {
            label = "Completed";
        } else if (
            status.includes("delivery") ||
            status.includes("out")
        ) {
            label = "Out for Delivery";
        } else if (
            status.includes("confirm") ||
            status.includes("approve")
        ) {
            label = "Confirmed";
        } else {
            label = "Pending";
        }

        statusElement.textContent = label;

        statusElement.className = "order-status";

        if (status.includes("cancel")) {
            statusElement.style.background = "#fff0f0";
            statusElement.style.color = "#d64545";
        } else if (
            status.includes("complete") ||
            status.includes("delivered")
        ) {
            statusElement.style.background = "#eaf6ef";
            statusElement.style.color = "#218c58";
        } else {
            statusElement.style.background = "#eaf6ef";
            statusElement.style.color = "#0d6b3f";
        }
    }


    /* -----------------------------
       ORDER TRACKING
    ----------------------------- */

    function updateTracking(status) {

        const steps = {
            placed: document.getElementById("stepPlaced"),
            confirmed: document.getElementById("stepConfirmed"),
            delivery: document.getElementById("stepDelivery"),
            completed: document.getElementById("stepCompleted")
        };

        const lines = {
            confirmed: document.getElementById("lineConfirmed"),
            delivery: document.getElementById("lineDelivery"),
            completed: document.getElementById("lineCompleted")
        };


        Object.values(steps).forEach(step => {

            if (step) {
                step.classList.remove("active", "completed");
            }

        });


        Object.values(lines).forEach(line => {

            if (line) {
                line.classList.remove("completed");
            }

        });


        /*
            Cancelled orders stop at the current stage.
        */
        if (status.includes("cancel")) {

            steps.placed.classList.add("active");

            return;
        }


        /* Order placed */

        steps.placed.classList.add("completed");


        /* Confirmed */

        if (
            status.includes("confirm") ||
            status.includes("approve") ||
            status.includes("delivery") ||
            status.includes("complete") ||
            status.includes("delivered")
        ) {

            steps.confirmed.classList.add("completed");

            lines.confirmed.classList.add("completed");
        }


        /* Out for delivery */

        if (
            status.includes("delivery") ||
            status.includes("out") ||
            status.includes("complete") ||
            status.includes("delivered")
        ) {

            steps.delivery.classList.add("completed");

            lines.delivery.classList.add("completed");
        }


        /* Completed */

        if (
            status.includes("complete") ||
            status.includes("delivered")
        ) {

            steps.completed.classList.add("completed");

            lines.completed.classList.add("completed");

        } else if (
            status.includes("delivery") ||
            status.includes("out")
        ) {

            steps.delivery.classList.add("active");

        } else if (
            status.includes("confirm") ||
            status.includes("approve")
        ) {

            steps.confirmed.classList.add("active");

        } else {

            steps.placed.classList.add("active");
        }
    }


    /* -----------------------------
       PAYMENT STATUS
    ----------------------------- */

    function updatePaymentStatus(status) {

        const element =
            document.getElementById("paymentStatus");

        if (!element) return;

        const normalized = normalizeStatus(status);

        if (
            normalized.includes("paid") ||
            normalized.includes("complete")
        ) {

            element.textContent = "Paid";
            element.classList.add("paid");

        } else {

            element.textContent = "Pending";
            element.classList.remove("paid");
        }
    }


    /* -----------------------------
       FORMATTING
    ----------------------------- */

    function formatPaymentMethod(method) {

        const value = normalizeStatus(method);

        if (value.includes("mpesa") || value.includes("m pesa")) {
            return "M-Pesa";
        }

        if (value.includes("cash")) {
            return "Cash on Delivery";
        }

        if (value.includes("bank")) {
            return "Bank Transfer";
        }

        return method || "M-Pesa";
    }


    function formatDeliveryOption(option) {

        const value = normalizeStatus(option);

        if (value.includes("pickup")) {
            return "Customer Pickup";
        }

        return "Delivery";
    }


    function formatDate(dateValue) {

        if (!dateValue) {
            return "Order placed";
        }

        const date = new Date(dateValue);

        if (Number.isNaN(date.getTime())) {
            return String(dateValue);
        }

        return date.toLocaleString("en-KE", {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit"
        });
    }


    /* -----------------------------
       CANCEL ORDER
    ----------------------------- */

    if (cancelOrderButton) {

        cancelOrderButton.addEventListener("click", () => {

            const order = getOrderFromStorage();

            if (!order) {
                showMessage(
                    "This order could not be found.",
                    true
                );

                return;
            }


            const currentStatus =
                normalizeStatus(order.status || "Pending");


            if (
                currentStatus.includes("complete") ||
                currentStatus.includes("delivered")
            ) {

                showMessage(
                    "A completed order cannot be cancelled.",
                    true
                );

                return;
            }


            if (currentStatus.includes("cancel")) {

                showMessage(
                    "This order has already been cancelled.",
                    true
                );

                return;
            }


            /*
                Update the locally stored order.
                This can later be replaced with:
                PATCH /api/orders/:id/cancel
            */

            order.status = "Cancelled";
            order.cancelledAt = new Date().toISOString();

            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(order)
            );


            updateStatus("cancelled");
            updateTracking("cancelled");

            cancelOrderButton.disabled = true;
            cancelOrderButton.textContent = "Order Cancelled";

            showMessage(
                "Your order has been cancelled."
            );
        });
    }


    function showMessage(message, error = false) {

        if (!actionMessage) return;

        actionMessage.textContent = message;

        actionMessage.style.color =
            error ? "var(--danger)" : "var(--success)";
    }


    /* -----------------------------
       ERROR
    ----------------------------- */

    function showError() {

        orderLoading.hidden = true;
        orderContent.hidden = true;
        orderError.hidden = false;
    }


    /* -----------------------------
       START
    ----------------------------- */

    loadOrder();

});