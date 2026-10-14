/* =========================================================
   GASHUB CUSTOMER CHECKOUT
   ========================================================= */


/* =========================================================
   GET ELEMENTS
   ========================================================= */

const checkoutMessage =
    document.getElementById("checkoutMessage");

const placeOrderButton =
    document.getElementById("placeOrderButton");

const productName =
    document.getElementById("productName");

const productDetails =
    document.getElementById("productDetails");

const productQuantity =
    document.getElementById("productQuantity");

const productPrice =
    document.getElementById("productPrice");

const productImage =
    document.getElementById("productImage");

const dealerName =
    document.getElementById("dealerName");

const summaryProductPrice =
    document.getElementById("summaryProductPrice");

const summaryDelivery =
    document.getElementById("summaryDelivery");

const summaryTotal =
    document.getElementById("summaryTotal");

const mpesaDetails =
    document.getElementById("mpesaDetails");


/* =========================================================
   CHECKOUT DATA
   =========================================================
   
   The product can later be loaded from the product page
   or backend using URL parameters / API data.
   ========================================================= */

let checkoutData = {
    productId: null,

    productName: "Gas Product",

    productDetails: "Selected gas product",

    productImage: "Images/logo.png",

    dealerName: "Selected dealer",

    quantity: 1,

    price: 0,

    deliveryFee: 0
};


/* =========================================================
   LOAD PRODUCT FROM URL
   =========================================================

   Example:

   customer-checkout.html?
   productId=15&
   productName=13kg%20Gas&
   price=320&
   dealer=ABC%20Gas

   This allows the product page to send selected
   product information to checkout.
   ========================================================= */

function loadCheckoutFromURL() {

    const params =
        new URLSearchParams(window.location.search);


    const id =
        params.get("productId");

    const name =
        params.get("productName");

    const details =
        params.get("details");

    const image =
        params.get("image");

    const dealer =
        params.get("dealer");

    const quantity =
        params.get("quantity");

    const price =
        params.get("price");

    const delivery =
        params.get("delivery");


    if (id) {
        checkoutData.productId = id;
    }


    if (name) {
        checkoutData.productName = name;
    }


    if (details) {
        checkoutData.productDetails = details;
    }


    if (image) {
        checkoutData.productImage = image;
    }


    if (dealer) {
        checkoutData.dealerName = dealer;
    }


    if (quantity && !isNaN(quantity)) {

        checkoutData.quantity =
            Math.max(
                1,
                parseInt(quantity, 10)
            );

    }


    if (price && !isNaN(price)) {

        checkoutData.price =
            Math.max(
                0,
                parseFloat(price)
            );

    }


    if (delivery && !isNaN(delivery)) {

        checkoutData.deliveryFee =
            Math.max(
                0,
                parseFloat(delivery)
            );

    }

}


/* =========================================================
   FORMAT CURRENCY
   ========================================================= */

function formatCurrency(amount) {

    return (
        "KSh " +
        Number(amount).toLocaleString(
            "en-KE",
            {
                maximumFractionDigits: 0
            }
        )
    );

}


/* =========================================================
   UPDATE ORDER SUMMARY
   ========================================================= */

function updateOrderSummary() {

    const productTotal =
        checkoutData.price *
        checkoutData.quantity;


    const total =
        productTotal +
        checkoutData.deliveryFee;


    if (productName) {

        productName.textContent =
            checkoutData.productName;

    }


    if (productDetails) {

        productDetails.textContent =
            checkoutData.productDetails;

    }


    if (productQuantity) {

        productQuantity.textContent =
            checkoutData.quantity;

    }


    if (productPrice) {

        productPrice.textContent =
            formatCurrency(
                checkoutData.price
            );

    }


    if (productImage) {

        productImage.src =
            checkoutData.productImage;

        productImage.onerror =
            function () {

                /* stop here so a missing logo can't make the page reload images forever */
                this.onerror = null;

                this.src =
                    "Images/logo.png";

            };

    }


    if (dealerName) {

        dealerName.textContent =
            checkoutData.dealerName;

    }


    if (summaryProductPrice) {

        summaryProductPrice.textContent =
            formatCurrency(
                productTotal
            );

    }


    if (summaryDelivery) {

        if (checkoutData.deliveryFee > 0) {

            summaryDelivery.textContent =
                formatCurrency(
                    checkoutData.deliveryFee
                );

        } else {

            /* home delivery: the dealer sets the fee (by distance) when they confirm the order; pickup is free */
            const chosen = document.querySelector('input[name="deliveryOption"]:checked');
            summaryDelivery.textContent =
                chosen && chosen.value === "delivery" ? "Set by dealer" : "Free";

        }

    }


    /* discount, total to pay, points box and earn strip */
    renderRewards();

}


/* =========================================================
   GASHUB POINTS + PAYMENT SETTINGS
   =========================================================

   EARNING   Every payment above KSh 1,000 earns 100 GasHub
             points (change the two numbers below if the rule
             changes).

   REDEEMING A customer with 301 points or more can use them as
             a discount. What one point is worth is the exchange
             rate the admin sets in admin-settings (Exchange rate).
             It is read from the server every time checkout opens:

                 GET /api/rewards/settings   ->  { points: 100, ksh: 10, min_redeem: 301 }
                                                 (or { ksh_per_point } / { points_per_ksh })
                 GET /api/points/config      ->  { pointValueKsh: 1 }   (used if the first is missing)

             The server must re-check everything: the browser only
             shows a preview and sends "points_to_redeem".
   ========================================================= */

const EARN_ABOVE_KSH = 1000;
const EARN_POINTS = 100;
const MIN_REDEEM_POINTS = 301;

const GH = window.GasHubRewards || null;

const rewards = {
    rate: 1,            /* KSh that 1 point is worth (from the admin) */
    min: MIN_REDEEM_POINTS,
    balance: 0,
    signedIn: false,
    ready: false,
    use: false,
    pts: 0,
    locked: false       /* true once the order is placed */
};

let placedOrder = null;


/* the page to come back to after sign-in, without the long picture address */
function checkoutReturnUrl() {
    const q = new URLSearchParams(window.location.search);
    q.delete("image");
    return "customer-checkout.html?" + q.toString();
}


function $id(id) {
    return document.getElementById(id);
}


function clampNum(n, a, b) {
    return Math.min(b, Math.max(a, n));
}


function grossTotal() {
    return checkoutData.price * checkoutData.quantity + checkoutData.deliveryFee;
}


function maxUsablePoints() {
    if (!(rewards.rate > 0)) return 0;
    /* never let points pay the whole bill: keep at least KSh 1 for M-Pesa */
    const cap = Math.max(0, Math.ceil(grossTotal()) - 1);
    return Math.max(0, Math.min(Math.floor(rewards.balance), Math.floor(cap / rewards.rate)));
}


/* GasHub points can only be used as a discount on ONLINE payments (M-Pesa or bank).
   Cash on delivery gets no points discount. */
function pointsAllowedForMethod() {
    return selectedMethod() !== "cash";
}


function canRedeem() {
    /* GasHub Coins are used in the PAYMENT stage now (customer-orders.js, after the dealer confirms the order),
       so checkout never applies a points discount. */
    return false;
}


function pointsApplied() {
    if (rewards.locked && placedOrder) return placedOrder.pointsUsed || 0;
    if (!rewards.use || !canRedeem()) return 0;
    return clampNum(Math.round(rewards.pts) || 0, rewards.min, maxUsablePoints());
}


function discountKsh() {
    return Math.floor(pointsApplied() * rewards.rate);
}


function amountDue() {
    if (rewards.locked && placedOrder) return placedOrder.payable;
    return Math.max(1, Math.ceil(grossTotal() - discountKsh()));
}


function pointsEarned() {
    return amountDue() > EARN_ABOVE_KSH ? EARN_POINTS : 0;
}


function flame(n, big) {
    const f = GH ? GH.FLAME : "";
    return '<span class="gpts' + (big ? " big" : "") + '" role="img" aria-label="' +
        Number(n).toLocaleString("en-KE") + ' GasHub points">' + f +
        "<b>" + Number(n).toLocaleString("en-KE") + "</b></span>";
}


function selectedMethod() {
    const m = document.querySelector('input[name="paymentMethod"]:checked');
    return m ? m.value : "mpesa";
}


/* ---------- read the exchange rate the admin set ---------- */

function numOrNull(v) {
    const n = Number(v);
    return v !== null && v !== undefined && v !== "" && isFinite(n) ? n : null;
}


function rateFromSettings(s) {
    if (!s || typeof s !== "object") return null;
    s = s.data && typeof s.data === "object" ? s.data : s;
    const pick = function (keys) {
        for (const k of keys) { const v = numOrNull(s[k]); if (v !== null) return v; }
        return null;
    };
    let points = pick(["points", "conversion_points", "points_required"]);
    let ksh = pick(["ksh", "value", "conversion_value", "amount"]);
    const perPoint = pick(["ksh_per_point", "value_per_point", "point_value", "pointValueKsh"]);
    const perKsh = pick(["points_per_ksh"]);
    if (perPoint !== null) { points = 1; ksh = perPoint; }
    else if (perKsh !== null && perKsh > 0) { points = perKsh; ksh = 1; }
    if (!points || points <= 0 || ksh === null || ksh < 0) return null;
    return { rate: ksh / points, min: pick(["min_redeem", "minimum_points", "min_points"]) };
}


async function getJson(path) {
    try {
        const ctl = new AbortController();
        const t = setTimeout(function () { ctl.abort(); }, 5000);
        const r = await fetch("/api" + path, {
            credentials: "same-origin",
            headers: Object.assign({ Accept: "application/json" }, GH && GH.token() ? { Authorization: "Bearer " + GH.token() } : {}),
            signal: ctl.signal
        });
        clearTimeout(t);
        if (!r.ok) return { status: r.status, data: null };
        return { status: r.status, data: await r.json().catch(function () { return null; }) };
    } catch (e) {
        return { status: 0, data: null };
    }
}


async function loadRewards() {
    /* 1. exchange rate */
    let found = null;
    const a = await getJson("/rewards/settings");
    found = rateFromSettings(a.data);
    if (!found) {
        const b = await getJson("/settings/rewards");
        found = rateFromSettings(b.data);
    }
    if (!found) {
        const c = await getJson("/points/config");
        const v = c.data && (c.data.config || c.data.data || c.data);
        const pv = v ? numOrNull(v.pointValueKsh != null ? v.pointValueKsh : v.point_value_ksh) : null;
        if (pv !== null && pv >= 0) found = { rate: pv, min: null };
    }
    if (!found && GH) {
        /* offline: last rate this phone saw */
        found = rateFromSettings(GH.read("gasHubRewardSettings", null));
        if (!found) { const cfg = GH.config(); found = { rate: cfg.pointValueKsh, min: null }; }
    }
    if (found) {
        rewards.rate = found.rate;
        /* the admin can ask for more than 301, never less */
        rewards.min = Math.max(MIN_REDEEM_POINTS, Math.ceil(found.min || 0));
    }

    /* 2. the customer's points */
    let bal = null;
    const r = await getJson("/customer/rewards");
    if (r.status === 401) {
        rewards.signedIn = false;
    } else if (r.data) {
        const d = r.data;
        const n = numOrNull(d.points != null ? d.points : (d.total_points != null ? d.total_points : (d.totalPoints != null ? d.totalPoints : (d.balance != null ? d.balance : d.total))));
        if (n !== null) bal = n;
    }
    if (bal === null && GH) bal = await GH.balance();
    if (bal !== null) { rewards.signedIn = true; rewards.balance = Math.max(0, Math.floor(bal)); }

    rewards.ready = true;
    updateOrderSummary();
}


/* ---------- draw the points box, discount row, total and earn strip ---------- */

function money(n) {
    return formatCurrency(n);
}


function renderRewards() {
    const box = $id("pointsBox");
    const due = amountDue();
    const disc = discountKsh();

    /* totals */
    if (summaryTotal) summaryTotal.textContent = money(due);
    const dRow = $id("discountRow");
    if (dRow) {
        dRow.hidden = disc <= 0;
        $id("summaryDiscount").textContent = "- " + money(disc);
    }

    updatePayButton();

    /* points box */
    if (!box || !rewards.ready) return;
    box.hidden = false;
    const wrap = $id("pointsToggleWrap"), sliderWrap = $id("pointsSliderWrap"), locked = $id("pointsLocked");
    $id("pointsBalanceChip").innerHTML = rewards.signedIn ? flame(rewards.balance) : "";
    $id("pointsRate").textContent = rewards.rate > 0
        ? "1 coin = KSh " + rewards.rate.toLocaleString("en-KE", { maximumFractionDigits: 4 }) + ". Use " + rewards.min.toLocaleString("en-KE") + " coins or more for a discount."
        : "Coin discounts are not available right now.";

    wrap.hidden = true; sliderWrap.hidden = true; locked.hidden = true;

    if (!rewards.signedIn) {
        locked.hidden = false;
        locked.innerHTML = '<a href="customer-login.html?next=' + encodeURIComponent(checkoutReturnUrl()) + '">Sign in</a> to earn and use your GasHub Coins.';
        return;
    }
    if (rewards.rate <= 0) return;

    if (!pointsAllowedForMethod() && !(rewards.locked && pointsApplied() > 0)) {
        locked.hidden = false;
        locked.textContent = "GasHub Coins can only be used for a discount when you pay online (M-Pesa or bank). Choose an online payment method to use them.";
        return;
    }

    if (rewards.balance < rewards.min) {
        locked.hidden = false;
        locked.textContent = "You need " + (rewards.min - rewards.balance).toLocaleString("en-KE") + " more coins to unlock a discount.";
        return;
    }
    if (maxUsablePoints() < rewards.min) {
        locked.hidden = false;
        locked.textContent = "This order is too small to use " + rewards.min.toLocaleString("en-KE") + " coins on.";
        return;
    }

    const mx = maxUsablePoints();
    wrap.hidden = false;
    const cb = $id("usePoints");
    cb.checked = rewards.use && !rewards.locked ? true : (rewards.locked ? pointsApplied() > 0 : false);
    cb.disabled = rewards.locked;
    wrap.classList.toggle("disabled", rewards.locked);

    const sl = $id("pointsSlider");
    sliderWrap.hidden = !(rewards.use || (rewards.locked && pointsApplied() > 0));
    sl.min = rewards.min; sl.max = mx; sl.disabled = rewards.locked || mx <= rewards.min;
    sl.value = pointsApplied() || rewards.min;
    $id("pointsSliderMin").textContent = rewards.min.toLocaleString("en-KE");
    $id("pointsSliderMax").textContent = mx.toLocaleString("en-KE");
    $id("pointsSliderNow").textContent = pointsApplied().toLocaleString("en-KE") + " coins = " + money(disc) + " off";
    $id("pointsToggleText").textContent = rewards.use || (rewards.locked && pointsApplied() > 0)
        ? "Using my GasHub Coins"
        : "Use my GasHub Coins for a discount (up to " + money(Math.floor(mx * rewards.rate)) + " off)";
}


function initRewards() {
    const cb = $id("usePoints"), sl = $id("pointsSlider");
    cb.addEventListener("change", function () {
        rewards.use = cb.checked;
        if (rewards.use) rewards.pts = maxUsablePoints();
        updateOrderSummary();
    });
    sl.addEventListener("input", function () {
        rewards.pts = Number(sl.value);
        updateOrderSummary();
    });
    loadRewards();
}


/* ---------- the pay / place order button ---------- */

let checkoutBusy = false;

function updatePayButton() {
    if (checkoutBusy) return;
    const due = amountDue();
    /* no payment now: the customer pays after the dealer confirms the order */
    placeOrderButton.textContent = "Place order \u00B7 " + money(due);
}


/* =========================================================
   M-PESA PHONE NUMBER
   ========================================================= */

const mpesaPhoneInput = $id("mpesaPhone");
const mpesaSame = $id("mpesaSame");
const mpesaHint = $id("mpesaHint");


/* keep only the 9 digits after +254 and show them as 712 345 678 */
function localDigits(v) {
    let d = String(v || "").replace(/\D/g, "");
    if (d.indexOf("254") === 0) d = d.slice(3);
    else if (d.charAt(0) === "0") d = d.slice(1);
    return d.slice(0, 9);
}


function groupDigits(d) {
    return d.replace(/(\d{3})(?=\d)/g, "$1 ").trim();
}


function mpesaNumber() {
    const d = localDigits(mpesaPhoneInput.value);
    return /^[17]\d{8}$/.test(d) ? "254" + d : null;
}


function syncMpesaPhone() {
    if (mpesaSame.checked) {
        mpesaPhoneInput.value = groupDigits(localDigits(phoneInput.value));
    }
    mpesaPhoneInput.readOnly = mpesaSame.checked;
    showMpesaHint();
}


function showMpesaHint() {
    const d = localDigits(mpesaPhoneInput.value);
    mpesaHint.classList.remove("bad", "good");
    if (!d) {
        mpesaHint.textContent = "Use a Safaricom number, e.g. 0712 345 678.";
    } else if (mpesaNumber()) {
        mpesaHint.textContent = "You will pay from +254 " + groupDigits(d) + ".";
        mpesaHint.classList.add("good");
    } else {
        mpesaHint.textContent = "That doesn't look like a valid Safaricom number.";
        mpesaHint.classList.add("bad");
    }
}


function initMpesaPhone() {
    mpesaPhoneInput.addEventListener("input", function () {
        this.value = groupDigits(localDigits(this.value));
        showMpesaHint();
    });
    mpesaSame.addEventListener("change", syncMpesaPhone);
    phoneInput.addEventListener("input", syncMpesaPhone);
    syncMpesaPhone();
}



/* =========================================================
   DELIVERY OPTION
   ========================================================= */

const deliveryOptions =
    document.querySelectorAll(
        'input[name="deliveryOption"]'
    );


deliveryOptions.forEach(
    function (input) {

        input.addEventListener(
            "change",
            function () {

                document
                    .querySelectorAll(
                        ".checkout-option"
                    )
                    .forEach(
                        function (option) {

                            option.classList.remove(
                                "selected"
                            );

                        }
                    );


                const selectedOption =
                    input.closest(
                        ".checkout-option"
                    );


                if (selectedOption) {

                    selectedOption.classList.add(
                        "selected"
                    );

                }


                /*
                 * Delivery fee can later come from
                 * the backend based on the customer's
                 * location and selected dealer.
                 */

                if (
                    input.value === "delivery"
                ) {

                    checkoutData.deliveryFee = 0;

                } else {

                    checkoutData.deliveryFee = 0;

                }


                syncFulfilment(true);

                updateOrderSummary();

            }
        );

    }
);


/* =========================================================
   PAYMENT METHOD
   ========================================================= */

const paymentOptions =
    document.querySelectorAll(
        'input[name="paymentMethod"]'
    );


paymentOptions.forEach(
    function (input) {

        input.addEventListener(
            "change",
            function () {

                document
                    .querySelectorAll(
                        ".payment-option"
                    )
                    .forEach(
                        function (option) {

                            option.classList.remove(
                                "selected"
                            );

                        }
                    );


                const selectedOption =
                    input.closest(
                        ".payment-option"
                    );


                if (selectedOption) {

                    selectedOption.classList.add(
                        "selected"
                    );

                }


                /*
                 * Show M-Pesa information only
                 * when M-Pesa is selected.
                 */

                if (
                    input.value === "mpesa"
                ) {

                    mpesaDetails.style.display =
                        "block";

                } else {

                    mpesaDetails.style.display =
                        "none";

                }

                /* cash orders get no points discount: switch the coins off and refresh the totals */
                if (input.value === "cash") {
                    rewards.use = false;
                }

                updateOrderSummary();

            }
        );

    }
);


/* =========================================================
   SHOW MESSAGE
   ========================================================= */

function showCheckoutMessage(
    message,
    type = "info"
) {

    checkoutMessage.textContent =
        message;

    checkoutMessage.className =
        "checkout-message show " + type;

}


/* =========================================================
   CLEAR MESSAGE
   ========================================================= */

function clearCheckoutMessage() {

    checkoutMessage.textContent = "";

    checkoutMessage.className =
        "checkout-message";

}


/* =========================================================
   VALIDATE CHECKOUT
   ========================================================= */

function validateCheckout() {

    openIncompleteSections();

    const customerName =
        document.getElementById(
            "customerName"
        );

    const customerPhone =
        document.getElementById(
            "customerPhone"
        );

    const customerEmail =
        document.getElementById(
            "customerEmail"
        );

    const county =
        document.getElementById(
            "county"
        );

    const town =
        document.getElementById(
            "town"
        );

    const deliveryAddress =
        document.getElementById(
            "deliveryAddress"
        );


    if (
        !customerName.value.trim()
    ) {

        showCheckoutMessage(
            "Please enter your full name.",
            "error"
        );

        customerName.focus();

        return false;

    }


    if (
        !customerPhone.value.trim()
    ) {

        showCheckoutMessage(
            "Please enter your phone number.",
            "error"
        );

        customerPhone.focus();

        return false;

    }


    if (
        !customerEmail.value.trim()
    ) {

        showCheckoutMessage(
            "Please enter your email address.",
            "error"
        );

        customerEmail.focus();

        return false;

    }


    if (isDelivery()) {

        /* a pinned place gives the area; fill it if the place name was missing */
        if (readPin()) {
            if (!county.value) county.value = "Other";
            if (!town.value.trim()) town.value = readPin().label || "Pinned location";
        }

    if (
        !county.value
    ) {

        showCheckoutMessage(
            "Please select your county.",
            "error"
        );

        county.focus();

        return false;

    }


    if (
        !town.value.trim()
    ) {

        showCheckoutMessage(
            "Please enter your town or area.",
            "error"
        );

        town.focus();

        return false;

    }


    if (
        !deliveryAddress.value.trim()
    ) {

        showCheckoutMessage(
            "Please enter your delivery address.",
            "error"
        );

        deliveryAddress.focus();

        return false;

    }


    }


    /* the payment method and M-Pesa number are asked for after the dealer confirms the order */


    if (
        checkoutData.price <= 0
    ) {

        showCheckoutMessage(
            "The selected product does not have a valid price.",
            "error"
        );

        return false;

    }


    return true;

}


/* =========================================================
   COLLECT CHECKOUT DATA
   ========================================================= */

function collectCheckoutData() {

    const selectedDelivery =
        document.querySelector(
            'input[name="deliveryOption"]:checked'
        );

    const selectedPayment =
        document.querySelector(
            'input[name="paymentMethod"]:checked'
        );


    return {

        customer: {

            name:
                document.getElementById(
                    "customerName"
                ).value.trim(),

            phone:
                document.getElementById(
                    "customerPhone"
                ).value.trim(),

            email:
                document.getElementById(
                    "customerEmail"
                ).value.trim()

        },


        delivery: {

            county:
                !isDelivery() ? "" : document.getElementById(
                    "county"
                ).value,

            town:
                !isDelivery() ? "" : document.getElementById(
                    "town"
                ).value.trim(),

            address:
                !isDelivery() ? "" : document.getElementById(
                    "deliveryAddress"
                ).value.trim(),

            landmark:
                !isDelivery() ? "" : document.getElementById(
                    "deliveryLandmark"
                ).value.trim(),

            notes:
                !isDelivery() ? "" : document.getElementById(
                    "deliveryNotes"
                ).value.trim(),

            option:
                selectedDelivery
                    ? selectedDelivery.value
                    : null

        },


        payment: {

            method:
                selectedPayment
                    ? selectedPayment.value
                    : null,

            mpesaPhone:
                mpesaNumber(),

            pointsToRedeem:
                pointsApplied(),

            amountDue:
                amountDue()

        },


        orderNotes:
            document.getElementById(
                "orderNotes"
            ).value.trim(),


        product: {

            id:
                checkoutData.productId,

            name:
                checkoutData.productName,

            details:
                checkoutData.productDetails,

            quantity:
                checkoutData.quantity,

            price:
                checkoutData.price,

            deliveryFee:
                checkoutData.deliveryFee

        }

    };

}


/* =========================================================
   PLACE ORDER
   ========================================================= */

placeOrderButton.addEventListener(
    "click",
    async function () {

        clearCheckoutMessage();

        /*
         * The order is already saved (the customer closed the prompt
         * or changed the number): only the payment is sent again.
         */
        if (placedOrder) {

            if (!mpesaNumber()) {
                showCheckoutMessage("Please enter a valid M-Pesa number.", "error");
                mpesaPhoneInput.focus();
                return;
            }

            startPayment();
            return;

        }


        if (
            !validateCheckout()
        ) {

            return;

        }


        const orderData =
            collectCheckoutData();

        /* Pay-after-confirmation: nothing is paid (or chosen) at checkout. */
        const wantsMpesa = false;


        /*
         * Disable button while processing.
         */

        checkoutBusy = true;

        placeOrderButton.disabled =
            true;

        placeOrderButton.textContent =
            "Processing...";


        function resetButton() {
            checkoutBusy = false;
            placeOrderButton.disabled = false;
            updatePayButton();
        }


        try {

            /*
             * Save the order on the GasHub server (it belongs to the signed-in customer).
             * The server works out the dealer, the prices and the points discount.
             */
            const csrf = await csrfToken();

            const loc = (function () { try { return JSON.parse(localStorage.getItem("gasHubLocation")) || {}; } catch (e) { return {}; } })();

            const response = await fetch("/api/my/orders", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
                body: JSON.stringify({
                    product_id: orderData.product.id,
                    quantity: orderData.product.quantity,
                    /* no payment_method: the customer chooses it after the dealer confirms the order */
                    points_to_redeem: orderData.payment.pointsToRedeem > 0 ? orderData.payment.pointsToRedeem : undefined,
                    delivery_fee: orderData.product.deliveryFee,
                    phone: orderData.customer.phone,
                    notes: orderData.orderNotes,
                    delivery: {
                        option: orderData.delivery.option,
                        county: orderData.delivery.county,
                        town: orderData.delivery.town,
                        address: orderData.delivery.address,
                        landmark: orderData.delivery.landmark,
                        notes: orderData.delivery.notes,
                        latitude: orderData.delivery.option === "pickup" ? undefined : loc.latitude,
                        longitude: orderData.delivery.option === "pickup" ? undefined : loc.longitude
                    }
                })
            });

            if (response.status === 401) {
                window.location.href = "customer-login.html?next=" + encodeURIComponent(checkoutReturnUrl());
                return;
            }

            const result = await response.json().catch(function () { return {}; });

            if (!response.ok || !result.order) {
                console.error("Order request failed:", response.status, result);
                showCheckoutMessage(result.message || "We couldn't place your order. Please try again.", "error");
                resetButton();
                return;
            }

            const placed = result.order;


            /*
             * Keep a copy on this phone too, so the order page can open it straight away.
             */

            const temporaryOrder = {

                ...orderData,

                orderId:
                    placed.orderId,

                status:
                    "Pending",

                createdAt:
                    placed.createdAt || new Date().toISOString()

            };


            localStorage.setItem(
                "gasHubLastOrder",
                JSON.stringify(
                    temporaryOrder
                )
            );


            saveToProfile();


            /*
             * Cash or bank: nothing to pay now, go to the order page.
             * M-Pesa: the customer pays into the GasHub account (set by the admin) and sends the M-Pesa code
             * on the order page; GasHub confirms the money. (The automatic STK push below is switched off
             * until the server has the Safaricom Daraja endpoints: set USE_STK_PUSH to true then.)
             */

            if (!wantsMpesa || !USE_STK_PUSH) {

                showCheckoutMessage(
                    "Your order has been placed. The dealer will confirm it, then we SMS and email you so you can pay.",
                    "success"
                );

                setTimeout(
                    function () {

                        window.location.href =
                            "customer-orders.html?orderId=" +
                            encodeURIComponent(placed.orderId);

                    },
                    1000
                );

                return;

            }


            /*
             * M-Pesa: use the amount and points the server worked out,
             * then send the payment prompt to the customer's phone.
             */

            const serverDue = Number(
                placed.payable != null ? placed.payable :
                    (placed.amountDue != null ? placed.amountDue : placed.total_payable)
            );

            const used = placed.pointsUsed != null ? Number(placed.pointsUsed) : orderData.payment.pointsToRedeem;
            const disc = placed.discount != null ? Number(placed.discount) : discountKsh();

            placedOrder = {
                orderId: placed.orderId,
                payable: isFinite(serverDue) && serverDue > 0 ? Math.ceil(serverDue) : orderData.payment.amountDue,
                pointsUsed: isFinite(used) ? used : 0,
                discount: isFinite(disc) ? disc : 0,
                pointsEarned: 0
            };

            rewards.locked = true;
            placedOrder.pointsEarned = pointsEarned();
            updateOrderSummary();

            resetButton();

            startPayment();


        } catch (error) {

            console.error(
                "Checkout error:",
                error
            );


            showCheckoutMessage(
                "Something went wrong while processing your order. Please try again.",
                "error"
            );

            resetButton();

        }

    }
);


/* =========================================================
   M-PESA PAYMENT PROMPT (STK push)
   =========================================================

   What the server must provide:

   POST /api/my/orders
        body adds:  payment_method, mpesa_phone ("2547XXXXXXXX"),
                    points_to_redeem (whole number, 0 if none)
        returns:    { order: { orderId, payable, pointsUsed, discount, ... } }
        The server re-checks the points balance, the admin exchange rate
        and the 301-point minimum, and works out the real "payable".
        Points should only be taken off the customer once the payment
        is confirmed (or held and given back if the payment fails).

   POST /api/payments/mpesa/stk-push
        body:       { order_id, phone, amount }
        returns:    { checkoutRequestId }       (Safaricom Daraja STK push)

   GET  /api/payments/mpesa/status?order_id=..&checkout_request_id=..
        returns:    { status: "pending" | "paid" | "failed" | "cancelled" | "timeout",
                      message, receipt, pointsAwarded, balance }

   When Safaricom calls the server's callback URL with a successful
   payment, the SERVER (not this page) must:
     - mark the order paid and credit the 100 points (payments above KSh 1,000)
     - take off the points the customer redeemed
     - forward the payment details (order, amount, M-Pesa receipt,
       customer, delivery address) to the dealer and to the admin.
   This page only shows the result.
   ========================================================= */

/* false = customers pay into GasHub's M-Pesa account and send the code on the order page (works today).
   true  = send an M-Pesa STK push to the customer's phone: needs POST /api/payments/mpesa/stk-push on the server. */
let USE_STK_PUSH = false;   /* switched on automatically when the server has the Daraja keys in .env */
fetch("/api/payments/mpesa/config", { cache: "no-store", credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { USE_STK_PUSH = !!(j && j.enabled); })
    .catch(function () { USE_STK_PUSH = false; });

const payModal = $id("payModal");
const paySheet = payModal.querySelector(".pay-sheet");
const PAY_TIMEOUT_SECONDS = 120;
const PAY_POLL_MS = 3000;

let payRun = 0;          /* bumps every attempt so old polls stop */
let payClock = null;


async function csrfToken() {
    if (GH) return GH.csrf();
    try {
        const c = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
        return ((await c.json()) || {}).csrfToken || "";
    } catch (e) { return ""; }
}


function payButtons(show) {
    ["payRetry", "payDone", "payChange", "payLater"].forEach(function (id) {
        $id(id).hidden = show.indexOf(id) === -1;
    });
}


function payScreen(state, o) {
    o = o || {};
    paySheet.dataset.state = state;
    $id("payTitle").textContent = o.title || "";
    $id("payText").textContent = o.text || "";
    $id("payAmount").textContent = o.amount || "";
    $id("payPhone").textContent = o.phone || "";
    $id("paySteps").hidden = state !== "waiting";
    $id("payTimer").textContent = "";
    $id("payReward").hidden = true;
    $id("payReward").innerHTML = "";
    $id("payIcon").innerHTML = {
        sending: '<span class="spin"></span>',
        waiting: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle class="ring" cx="12" cy="9.5" r="2.2" fill="currentColor"/></svg>',
        success: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.4l3 3 6-6.4" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        failed: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>'
    }[state] || "";
}


function openPayModal() {
    payModal.hidden = false;
    document.body.classList.add("pay-open");
    paySheet.focus();
}


function closePayModal() {
    payRun++;
    clearInterval(payClock);
    payModal.hidden = true;
    document.body.classList.remove("pay-open");
}


function finishWithError(text, title) {
    clearInterval(payClock);
    payScreen("failed", { title: title || "Payment not completed", text: text });
    payButtons(["payRetry", "payChange", "payLater"]);
}


function paidStatus(s) { return /^(paid|success|successful|completed|confirmed)$/i.test(String(s || "")); }
function failedStatus(s) { return /^(failed|cancelled|canceled|declined|timeout|timed_out|expired|rejected)$/i.test(String(s || "")); }


async function startPayment() {
    const myRun = ++payRun;
    const phone = mpesaNumber();
    const amount = placedOrder.payable;

    openPayModal();
    payScreen("sending", {
        title: "Sending payment prompt",
        text: "One moment, we are sending the M-Pesa prompt to your phone.",
        amount: money(amount),
        phone: "+" + phone.replace(/(\d{3})(\d{3})(\d{3})(\d{3})/, "$1 $2 $3 $4")
    });
    payButtons([]);

    let checkoutId = "";
    try {
        const token = await csrfToken();
        const r = await fetch("/api/payments/mpesa/stk-push", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
            body: JSON.stringify({ order_id: placedOrder.orderId, phone: phone, amount: amount })
        });
        if (myRun !== payRun) return;
        if (r.status === 401) {
            window.location.href = "customer-login.html?next=" + encodeURIComponent(checkoutReturnUrl());
            return;
        }
        const j = await r.json().catch(function () { return {}; });
        checkoutId = j.checkoutRequestId || j.checkout_request_id || j.CheckoutRequestID || (j.payment && j.payment.id) || "";
        if (!r.ok || !checkoutId) {
            finishWithError(j.message || "We couldn't send the prompt to that number. Check it and try again.", "Prompt not sent");
            return;
        }
    } catch (e) {
        if (myRun !== payRun) return;
        finishWithError("We couldn't reach the payment service. Check your connection and try again.", "Prompt not sent");
        return;
    }

    /* the prompt is on the customer's phone now */
    payScreen("waiting", {
        title: "Check your phone",
        text: "We sent a prompt to your phone. Enter your M-Pesa PIN to pay.",
        amount: money(amount),
        phone: "+" + phone.replace(/(\d{3})(\d{3})(\d{3})(\d{3})/, "$1 $2 $3 $4")
    });
    payButtons(["payChange"]);

    const started = Date.now();
    const tick = function () {
        const left = Math.max(0, PAY_TIMEOUT_SECONDS - Math.floor((Date.now() - started) / 1000));
        $id("payTimer").textContent = "Waiting for confirmation... " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
    };
    tick();
    clearInterval(payClock);
    payClock = setInterval(tick, 1000);

    while (myRun === payRun && Date.now() - started < PAY_TIMEOUT_SECONDS * 1000) {
        await new Promise(function (res) { setTimeout(res, PAY_POLL_MS); });
        if (myRun !== payRun) return;
        let j = null;
        try {
            const r = await fetch("/api/payments/mpesa/status?order_id=" + encodeURIComponent(placedOrder.orderId) +
                "&checkout_request_id=" + encodeURIComponent(checkoutId), { credentials: "same-origin", cache: "no-store" });
            if (r.ok) j = await r.json().catch(function () { return null; });
        } catch (e) { /* keep trying until the time is up */ }
        if (myRun !== payRun) return;
        if (!j) continue;

        if (paidStatus(j.status)) { paymentSucceeded(j); return; }
        if (failedStatus(j.status)) {
            const st = String(j.status).toLowerCase();
            finishWithError(j.message ||
                (/cancel/.test(st) ? "The payment was cancelled on your phone." :
                    /time|expir/.test(st) ? "The prompt expired before it was paid." :
                        "The payment didn't go through. You have not been charged."));
            return;
        }
    }
    if (myRun === payRun) {
        finishWithError("We didn't get a confirmation. If M-Pesa already took the money, it will show on your order within a few minutes. Otherwise try again.", "No confirmation yet");
    }
}


function paymentSucceeded(j) {
    clearInterval(payClock);
    payRun++;

    const earned = j.pointsAwarded != null && isFinite(Number(j.pointsAwarded)) ? Number(j.pointsAwarded) : placedOrder.pointsEarned;
    payScreen("success", {
        title: "Payment received",
        text: "Thank you! Your payment details have been sent to your dealer and to GasHub." +
            (j.receipt ? " M-Pesa receipt: " + j.receipt + "." : ""),
        amount: money(placedOrder.payable)
    });
    if (earned > 0 && GH) {
        const box = $id("payReward");
        box.hidden = false;
        box.innerHTML = GH.chip(earned, "credited", "big") +
            '<span class="pay-reward-text">GasHub points added' +
            (j.balance != null && isFinite(Number(j.balance)) ? " &middot; you now have " + Number(j.balance).toLocaleString("en-KE") : "") + "</span>";
    }
    if (placedOrder.pointsUsed > 0) {
        const note = document.createElement("p");
        note.className = "pay-used";
        note.textContent = placedOrder.pointsUsed.toLocaleString("en-KE") + " points used for " + money(placedOrder.discount) + " off.";
        $id("payReward").hidden = false;
        $id("payReward").appendChild(note);
    }
    payButtons(["payDone"]);

    try {
        const last = JSON.parse(localStorage.getItem("gasHubLastOrder") || "{}");
        last.status = "Paid";
        localStorage.setItem("gasHubLastOrder", JSON.stringify(last));
    } catch (e) { }
}


function ordersUrl() {
    return "customer-orders.html?orderId=" + encodeURIComponent(placedOrder.orderId);
}


function initPayModal() {
    $id("payRetry").addEventListener("click", function () {
        if (!mpesaNumber()) { closePayModal(); showCheckoutMessage("Please enter a valid M-Pesa number.", "error"); mpesaPhoneInput.focus(); return; }
        startPayment();
    });
    $id("payDone").addEventListener("click", function () { window.location.href = ordersUrl(); });
    $id("payLater").addEventListener("click", function () { window.location.href = ordersUrl(); });
    $id("payChange").addEventListener("click", function () {
        closePayModal();
        mpesaSame.checked = false;
        syncMpesaPhone();
        mpesaPhoneInput.readOnly = false;
        placeOrderButton.disabled = false;
        checkoutBusy = false;
        updatePayButton();
        showCheckoutMessage("Enter the M-Pesa number you want to pay with, then tap Pay again. Your order is saved.", "info");
        mpesaPhoneInput.focus();
        mpesaPhoneInput.scrollIntoView({ behavior: "smooth", block: "center" });
    });
}



/* =========================================================
   PRE-FILL FROM THE CUSTOMER'S PROFILE
   =========================================================
   The customer never retypes what GasHub already knows:
     name, phone, email, address  <- profile (saved on sign-in / Profile page)
     area (town + county)         <- the location they pinned on the home page
     map pin (latitude/longitude) <- sent with the order as before
   "Change" opens the fields; "Save" writes the changes back to the
   same places the Profile page reads. If the profile is missing
   something, only that part is shown for the customer to fill in.
   ========================================================= */

const PROFILE_KEYS = ["gasHubCustomer", "gasHubCustomerProfile", "customer", "user", "customerData", "currentUser"];
const COUNTY_LIST = ["Nairobi", "Kiambu", "Machakos", "Kajiado", "Murang'a"];


function readStored(k) {
    try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; }
}


function readProfile() {
    for (const k of PROFILE_KEYS) {
        const c = readStored(k);
        if (c && typeof c === "object") {
            return {
                name: c.fullName || c.name || c.full_name || ((c.first_name || "") + " " + (c.last_name || "")).trim() || "",
                phone: c.phone || c.phoneNumber || c.phone_number || "",
                email: c.email || "",
                address: c.address || c.deliveryAddress || c.delivery_address || ""
            };
        }
    }
    return { name: "", phone: "", email: "", address: "" };
}


function readPin() {
    const l = readStored("gasHubLocation");
    if (!l || !isFinite(l.latitude) || !isFinite(l.longitude)) return null;
    const label = l.label && !/^Pinned \(/.test(l.label) ? String(l.label) : "";
    return { latitude: l.latitude, longitude: l.longitude, label: label };
}


function guessCounty(text) {
    const t = String(text || "").toLowerCase().replace(/’/g, "'");
    return COUNTY_LIST.find(function (c) { return t.indexOf(c.toLowerCase()) > -1; }) || "";
}


function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim()); }


function setShown(el, show) {
    el.hidden = !show;
    el.style.display = show ? "" : "none";
}


function showInfoSummary() {
    $id("sumName").textContent = $id("customerName").value.trim();
    $id("sumPhone").textContent = $id("customerPhone").value.trim();
    $id("sumEmail").textContent = $id("customerEmail").value.trim();
}


function showDeliverySummary() {
    const town = $id("town").value.trim(), county = $id("county").value;
    $id("sumArea").textContent = [town, county].filter(Boolean).join(", ");
    $id("sumAddress").textContent = $id("deliveryAddress").value.trim();
    renderPinBar();
}


function openInfo() {
    setShown($id("infoSummary"), false);
    setShown($id("infoFields"), true);
    setShown($id("infoSaveWrap"), true);
}


function openDelivery() {
    setShown($id("deliverySummary"), false);
    setShown($id("deliveryFields"), true);
    setShown($id("deliverySaveWrap"), true);
}


/* customer details already complete? */
function infoComplete() {
    return $id("customerName").value.trim().length > 1 &&
        $id("customerPhone").value.trim().length >= 9 &&
        validEmail($id("customerEmail").value);
}


function deliveryComplete() {
    return !!$id("county").value && !!$id("town").value.trim() && !!$id("deliveryAddress").value.trim();
}


/* if a required part is empty, open its fields (used before checking the form) */
function openIncompleteSections() {
    if (!infoComplete()) openInfo();
    if (isDelivery() && !deliveryComplete()) openDelivery();
}


function applyProfile() {
    const prof = readProfile();
    const pin = readPin();

    const setIfEmpty = function (id, v) {
        const el = $id(id);
        if (v && !el.value.trim()) el.value = v;
    };

    setIfEmpty("customerName", prof.name);
    setIfEmpty("customerPhone", prof.phone);
    setIfEmpty("customerEmail", prof.email);
    setIfEmpty("deliveryAddress", prof.address);

    /* area from the pinned place name, e.g. "Rongai, Nairobi" */
    if (pin && pin.label) {
        const parts = pin.label.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
        setIfEmpty("town", parts[0] || "");
        const c = guessCounty(pin.label) || guessCounty(prof.address);
        if (c && !$id("county").value) $id("county").value = c;
    } else if (!$id("county").value) {
        const c = guessCounty(prof.address);
        if (c) $id("county").value = c;
    }

    /* show the saved summary when complete, otherwise ask only for what is missing */
    if (infoComplete()) { showInfoSummary(); setShown($id("infoSummary"), true); setShown($id("infoFields"), false); }
    else { setShown($id("infoSummary"), false); setShown($id("infoFields"), true); }

    if (deliveryComplete()) { showDeliverySummary(); setShown($id("deliverySummary"), true); setShown($id("deliveryFields"), false); }
    else { setShown($id("deliverySummary"), false); setShown($id("deliveryFields"), true); }
}


/* the account may know more than this phone does: fill gaps from the server */
async function refreshProfileFromServer() {
    if (infoComplete()) return;
    try {
        const r = await fetch("/api/auth/me", { credentials: "same-origin", headers: { Accept: "application/json" } });
        if (!r.ok) return;
        const j = await r.json();
        const c = j && (j.customer || j.user || j);
        if (!c) return;
        const fill = function (id, v) { const el = $id(id); if (v && !el.value.trim()) el.value = v; };
        fill("customerName", c.fullName || c.name);
        fill("customerPhone", c.phone);
        fill("customerEmail", c.email);
        fill("deliveryAddress", c.address);
        phoneInput.dispatchEvent(new Event("input"));
        if (infoComplete()) { showInfoSummary(); setShown($id("infoSummary"), true); setShown($id("infoFields"), false); setShown($id("infoSaveWrap"), false); }
        if (deliveryComplete()) { showDeliverySummary(); setShown($id("deliverySummary"), true); setShown($id("deliveryFields"), false); setShown($id("deliverySaveWrap"), false); }
    } catch (e) { /* the customer can still type their details */ }
}


/* write the changes back where the Profile page reads them */
function saveToProfile() {
    const infoOpen = !$id("infoSaveWrap").hidden && $id("saveInfo").checked;
    const delOpen = isDelivery() && !$id("deliverySaveWrap").hidden && $id("saveDelivery").checked;
    if (!infoOpen && !delOpen) return;

    try {
        const base = readStored("gasHubCustomer") || {};
        const next = Object.assign({}, base);
        if (infoOpen) {
            next.fullName = $id("customerName").value.trim();
            next.phone = $id("customerPhone").value.trim();
            next.email = $id("customerEmail").value.trim().toLowerCase();
        }
        if (delOpen) next.address = $id("deliveryAddress").value.trim();
        localStorage.setItem("gasHubCustomer", JSON.stringify(next));
        localStorage.setItem("gasHubCustomerProfile", JSON.stringify({
            fullName: next.fullName || "", phone: next.phone || "", email: next.email || "", address: next.address || ""
        }));

        if (delOpen) {
            /* keep the same map pin, update the place name shown with it */
            const pin = readStored("gasHubLocation");
            const area = [$id("town").value.trim(), $id("county").value].filter(Boolean).join(", ");
            if (pin && isFinite(pin.latitude) && area) {
                pin.label = area;
                localStorage.setItem("gasHubLocation", JSON.stringify(pin));
            }
        }
    } catch (e) { /* saving is a convenience, never block the order */ }
}



/* =========================================================
   DELIVERY LOCATION = THE PINNED LOCATION
   =========================================================
   The same pin the home page uses ("gasHubLocation"). Pinning again
   here saves it to that one place, so the home, products, dealers,
   orders and profile pages all show the new location when they open
   (and other open tabs get the browser's "storage" event).
   ========================================================= */

function renderPinBar() {
    const pin = readPin();
    $id("pinName").textContent = pin ? (pin.label || "Pinned on the map") : "No location pinned yet";
    $id("repinBtn").textContent = pin ? "Pin again" : "Pin location";
    $id("pinBar").classList.toggle("empty", !pin);
}


const locModal = $id("locModal");
const locStatus = $id("locStatus");
const locConfirm = $id("locConfirm");
const locMapMsg = $id("locMapMsg");
const NAIROBI_CENTER = [-1.2864, 36.8172];
let locMap = null, locMarker = null, locPicked = null;


function loadLeaflet() {
    if (window.L) return Promise.resolve(true);
    return new Promise(function (resolve) {
        const sc = document.createElement("script");
        sc.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
        sc.onload = function () { resolve(!!window.L); };
        sc.onerror = function () { resolve(false); };
        document.head.appendChild(sc);
    });
}


function setPick(lat, lng, msg) {
    locPicked = { latitude: lat, longitude: lng };
    locStatus.textContent = msg || "Pin placed. Confirm to save.";
    locConfirm.disabled = false;
}


function putMarker(lat, lng) {
    if (!locMap) return;
    if (!locMarker) {
        locMarker = L.marker([lat, lng], {
            draggable: true,
            icon: L.divIcon({ className: "map-pin", html: "<i></i>", iconSize: [24, 24], iconAnchor: [12, 28] })
        }).addTo(locMap);
        locMarker.on("dragend", function () {
            const q = locMarker.getLatLng();
            setPick(q.lat, q.lng, "Pin moved. Confirm to save.");
        });
    } else {
        locMarker.setLatLng([lat, lng]);
    }
}


async function initLocMap() {
    if (locMap) return true;
    const ok = await loadLeaflet();
    if (!ok) {
        locMapMsg.hidden = false;
        locMapMsg.textContent = "The map could not load. Check your internet connection. You can still use your current location.";
        return false;
    }
    const s = readStored("gasHubLocation");
    const has = s && isFinite(s.latitude) && isFinite(s.longitude);
    const c = has ? [s.latitude, s.longitude] : NAIROBI_CENTER;
    locMap = L.map("locMap", { zoomControl: true }).setView(c, has ? 15 : 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(locMap);
    locMap.on("click", function (e) { putMarker(e.latlng.lat, e.latlng.lng); setPick(e.latlng.lat, e.latlng.lng); });
    if (has) putMarker(c[0], c[1]);
    return true;
}


async function openLocModal() {
    locPicked = null;
    locConfirm.disabled = true;
    locStatus.textContent = "No location selected.";
    locModal.hidden = false;
    document.body.classList.add("pay-open");
    if (await initLocMap()) setTimeout(function () { locMap.invalidateSize(); }, 150);
}


function closeLocModal() {
    locModal.hidden = true;
    document.body.classList.remove("pay-open");
    /* cancelled without a pin: let the customer type the location instead */
    if (isDelivery() && !readPin()) {
        syncFulfilment(false);
        openDelivery();
        showCheckoutMessage("No pin set. Please enter your location details below.", "info");
        const first = $id("county");
        if (first && !first.value) first.focus();
    }
}


async function placeName(lat, lng) {
    try {
        const ctl = new AbortController();
        const t = setTimeout(function () { ctl.abort(); }, 4000);
        const r = await fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=" + lat + "&lon=" + lng, { signal: ctl.signal });
        clearTimeout(t);
        if (!r.ok) return null;
        const a = (await r.json()).address || {};
        return [a.neighbourhood || a.suburb || a.village || a.road, a.city || a.town || a.county].filter(Boolean).slice(0, 2).join(", ") || null;
    } catch (e) { return null; }
}


async function confirmLocation() {
    if (!locPicked) return;
    locConfirm.disabled = true;
    locConfirm.textContent = "Saving...";
    const label = await placeName(locPicked.latitude, locPicked.longitude);

    /* the one saved location every customer page reads */
    try {
        localStorage.setItem("gasHubLocation", JSON.stringify({
            latitude: locPicked.latitude, longitude: locPicked.longitude, label: label,
            savedAt: new Date().toISOString()
        }));
    } catch (e) { }

    /* a new pin means a new place: refresh the area shown at checkout */
    if (label) {
        const parts = label.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
        $id("town").value = parts[0] || "";
        $id("county").value = guessCounty(label) || "Other";
    }

    locConfirm.textContent = "Confirm location";
    closeLocModal();
    renderPinBar();
    if (deliveryComplete()) {
        showDeliverySummary();
        setShown($id("deliverySummary"), true);
        setShown($id("deliveryFields"), false);
    } else {
        openDelivery();
    }
    syncFulfilment(false);
    showCheckoutMessage("Delivery location updated. It is now your location on all GasHub pages.", "success");
}


function selectedFulfilment() {
    const r = document.querySelector('input[name="deliveryOption"]:checked');
    return r ? r.value : "delivery";
}

function isDelivery() { return selectedFulfilment() !== "pickup"; }

/* Home delivery: pinned location + house details (county/town only when nothing is pinned).
   Dealer pickup: no location questions at all. */
function syncFulfilment(askForPin) {
    const delivery = isDelivery();
    const pin = readPin();
    const card = $id("deliveryCard");
    if (card) card.style.display = delivery ? "" : "none";

    ["county", "town", "deliveryAddress"].forEach(function (id) {
        const el = $id(id);
        if (el) el.required = delivery && (id === "deliveryAddress" || !pin);
    });
    setShown($id("countyGroup"), !pin);
    setShown($id("townGroup"), !pin);
    renderPinBar();

    if (delivery && !pin && askForPin && locModal && locModal.hidden) openLocModal();
}


function initLocation() {
    renderPinBar();
    syncFulfilment(true);
    $id("repinBtn").addEventListener("click", openLocModal);
    $id("locClose").addEventListener("click", closeLocModal);
    $id("locBackdrop").addEventListener("click", closeLocModal);
    $id("locConfirm").addEventListener("click", confirmLocation);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !locModal.hidden) closeLocModal(); });

    $id("locCurrent").addEventListener("click", function () {
        if (!navigator.geolocation) { locStatus.textContent = "Location is not supported on this device."; return; }
        locStatus.textContent = "Finding your location...";
        navigator.geolocation.getCurrentPosition(function (p) {
            const lat = p.coords.latitude, lng = p.coords.longitude;
            if (locMap) { putMarker(lat, lng); locMap.setView([lat, lng], 16); }
            setPick(lat, lng, "Current location found. Confirm to save.");
        }, function (err) {
            locStatus.textContent = err.code === 1
                ? "Location is blocked. Allow access in your browser, or tap the map to drop a pin."
                : "Couldn't get your location. Tap the map to drop a pin.";
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
    });

    /* the pin was changed on another page or tab */
    window.addEventListener("storage", function (e) {
        if (e.key === "gasHubLocation") { renderPinBar(); syncFulfilment(false); }
    });
}

function initProfile() {
    applyProfile();
    initLocation();

    $id("infoChange").addEventListener("click", function () {
        openInfo();
        $id("customerName").focus();
    });

    $id("deliveryChange").addEventListener("click", function () {
        openDelivery();
        (readPin() ? $id("deliveryAddress") : $id("town")).focus();
    });

    refreshProfileFromServer();
}



/* =========================================================
   FORM INPUT CLEANUP
   ========================================================= */

const phoneInput =
    document.getElementById(
        "customerPhone"
    );


phoneInput.addEventListener(
    "input",
    function () {

        this.value =
            this.value.replace(
                /[^0-9+\s-]/g,
                ""
            );

    }
);


/* =========================================================
   EMAIL VALIDATION
   ========================================================= */

const emailInput =
    document.getElementById(
        "customerEmail"
    );


emailInput.addEventListener(
    "blur",
    function () {

        if (
            !this.value.trim()
        ) {

            return;

        }


        const emailPattern =
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


        if (
            !emailPattern.test(
                this.value.trim()
            )
        ) {

            showCheckoutMessage(
                "Please enter a valid email address.",
                "error"
            );

        }

    }
);


/* =========================================================
   REMOVE MESSAGE WHEN CUSTOMER STARTS EDITING
   ========================================================= */

document
    .querySelectorAll(
        ".checkout-card input, .checkout-card select, .checkout-card textarea"
    )
    .forEach(
        function (field) {

            field.addEventListener(
                "input",
                function () {

                    if (
                        checkoutMessage.classList.contains(
                            "error"
                        )
                    ) {

                        clearCheckoutMessage();

                    }

                }
            );


            field.addEventListener(
                "change",
                function () {

                    if (
                        checkoutMessage.classList.contains(
                            "error"
                        )
                    ) {

                        clearCheckoutMessage();

                    }

                }
            );

        }
    );


/* =========================================================
   INITIALIZE CHECKOUT
   ========================================================= */

loadCheckoutFromURL();

updateOrderSummary();


/* =========================================================
   INITIAL PAYMENT STATE
   ========================================================= */

const initialPayment =
    document.querySelector(
        'input[name="paymentMethod"]:checked'
    );


if (
    initialPayment &&
    initialPayment.value !== "mpesa"
) {

    mpesaDetails.style.display =
        "none";

}


/* =========================================================
   START POINTS, M-PESA PHONE AND PAYMENT PROMPT
   ========================================================= */

initProfile();

initMpesaPhone();

initPayModal();

initRewards();