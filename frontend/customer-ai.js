/* =========================================================
   GASHUB CUSTOMER AI PAGE - behaviour (customer-ai.html)
   Own file so this page can be managed on its own.
   Parts:  1. side menu   2. log out link   3. chat + popup
   The chat asks window.GasHubAssistant (gashub-assistant.js) first
   and falls back to the simple built-in answers below if it is not there.
   ========================================================= */
(function () {
    "use strict";

    var byId = function (id) { return document.getElementById(id); };

    /* ---------- 1. SIDE MENU ---------- */
    (function sideMenu() {
        var openBtn = byId("menuButton"), closeBtn = byId("closeMenu");
        var menu = byId("mobileMenu"), overlay = byId("mobileMenuOverlay");
        if (!menu || !overlay) return;

        function setOpen(open) {
            menu.classList.toggle("active", open);
            overlay.classList.toggle("show", open);
            document.body.classList.toggle("menu-open", open);
            menu.setAttribute("aria-hidden", open ? "false" : "true");
            if (openBtn) openBtn.setAttribute("aria-expanded", open ? "true" : "false");
            if (open && closeBtn) closeBtn.focus();
            if (!open && openBtn) { try { openBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        }

        menu.setAttribute("aria-hidden", "true");
        if (openBtn) { openBtn.setAttribute("aria-expanded", "false"); openBtn.addEventListener("click", function () { setOpen(true); }); }
        if (closeBtn) closeBtn.addEventListener("click", function () { setOpen(false); });
        overlay.addEventListener("click", function () { setOpen(false); });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape" && menu.classList.contains("active")) setOpen(false); });
        /* tapping a link that stays on this page (like the "#" ones) closes the menu too */
        menu.addEventListener("click", function (e) {
            var a = e.target.closest ? e.target.closest("a") : null;
            if (a && (a.getAttribute("href") || "#") === "#") { e.preventDefault(); setOpen(false); }
        });
    })();

    /* ---------- 2. LOG OUT ---------- */
    (function logoutLink() {
        var l = byId("logoutLink");
        if (!l) return;
        l.addEventListener("click", function (e) {
            e.preventDefault();
            if (window.gasHubAskLogout) window.gasHubAskLogout();
            else if (window.gasHubLogout) window.gasHubLogout();
            else window.location.href = "customer-login.html?logged_out=1";
        });
    })();

    /* ---------- 3. CHAT + POPUP ---------- */
    /*
     * GAS HUB CUSTOMER AI
     *
     * This is the basic local version.
     * Later this section can be connected to
     * a real AI API/backend.
     */

    const chatMessages =
        document.getElementById("chatMessages");

    const chatInput =
        document.getElementById("chatInput");

    const sendMessage =
        document.getElementById("sendMessage");

    const suggestedQuestions =
        document.querySelectorAll(".suggested-question");

    const floatingAIButton =
        document.getElementById("floatingAIButton");

    const aiPopup =
        document.getElementById("aiPopup");

    const closeAIPopup =
        document.getElementById("closeAIPopup");

    const startAIChat =
        document.getElementById("startAIChat");


    /*
     * OPEN AI POPUP
     */
    floatingAIButton.addEventListener(
        "click",
        function () {

            aiPopup.classList.add("show");

            aiPopup.setAttribute(
                "aria-hidden",
                "false"
            );

        }
    );


    /*
     * CLOSE AI POPUP
     */
    closeAIPopup.addEventListener(
        "click",
        function () {

            aiPopup.classList.remove("show");

            aiPopup.setAttribute(
                "aria-hidden",
                "true"
            );

        }
    );


    /*
     * START CHAT
     */
    startAIChat.addEventListener(
        "click",
        function () {

            aiPopup.classList.remove("show");

            aiPopup.setAttribute(
                "aria-hidden",
                "true"
            );

            chatInput.focus();

            document.querySelector(
                ".ai-chat-section"
            ).scrollIntoView({
                behavior: "smooth"
            });

        }
    );


    /*
     * CLICK OUTSIDE POPUP
     */
    aiPopup.addEventListener(
        "click",
        function (event) {

            if (event.target === aiPopup) {

                aiPopup.classList.remove("show");

                aiPopup.setAttribute(
                    "aria-hidden",
                    "true"
                );

            }

        }
    );


    /*
     * ADD MESSAGE TO CHAT
     */
    function addMessage(
        message,
        type,
        links
    ) {

        const messageWrapper =
            document.createElement("div");

        messageWrapper.className =
            `message ${type}-message`;

        const avatar =
            document.createElement("div");

        avatar.className =
            "message-avatar";

        if (type === "ai") { avatar.innerHTML = '<img src="images/gashub-flame.png" alt="GasHub" class="ai-flame">'; } else { avatar.textContent = "You"; }


        const content =
            document.createElement("div");

        content.className =
            "message-content";


        const paragraph =
            document.createElement("p");

        paragraph.textContent =
            message;


        const time =
            document.createElement("span");

        time.className =
            "message-time";

        time.textContent =
            "Now";


        content.appendChild(paragraph);

        if (links && links.length) {
            if (typeof links[0] === "string") { links = [links]; }
            const box = document.createElement("div");
            box.className = "ai-links";
            links.forEach(function (l) {
                const a = document.createElement("a");
                a.href = l[1];
                a.textContent = l[0];
                box.appendChild(a);
            });
            content.appendChild(box);
        }

        content.appendChild(time);

        messageWrapper.appendChild(avatar);
        messageWrapper.appendChild(content);

        chatMessages.appendChild(
            messageWrapper
        );

        chatMessages.scrollTop =
            chatMessages.scrollHeight;

    }


    /*
     * GET BASIC GAS HUB ANSWER
     */
    function getAIResponse(question) {

        const text =
            question.toLowerCase().trim();


        if (
            text.includes("order") ||
            text.includes("buy") ||
            text.includes("purchase")
        ) {

            return (
                "To order gas, browse the available "
                + "gas products, select the product or "
                + "cylinder you want, choose your preferred "
                + "dealer where applicable, and continue "
                + "to checkout. You can then provide your "
                + "delivery details and complete the order."
            );

        }


        if (
            text.includes("dealer") ||
            text.includes("seller")
        ) {

            return (
                "You can use the Find a Dealer section "
                + "to view available GasHub dealers. "
                + "You can open a dealer profile to see "
                + "their available products and other "
                + "relevant information."
            );

        }


        if (
            text.includes("pay") ||
            text.includes("payment") ||
            text.includes("mpesa")
        ) {

            return (
                "GasHub can provide payment instructions "
                + "during checkout. Select your preferred "
                + "available payment method and follow "
                + "the instructions shown before confirming "
                + "your order."
            );

        }


        if (
            text.includes("delivery") ||
            text.includes("deliver")
        ) {

            return (
                "Delivery depends on the selected dealer, "
                + "your location and the available delivery "
                + "options. Enter your correct delivery "
                + "details during checkout so the order "
                + "can be processed correctly."
            );

        }


        if (
            text.includes("cylinder") ||
            text.includes("6kg") ||
            text.includes("13kg") ||
            text.includes("50kg")
        ) {

            return (
                "GasHub can help customers find different "
                + "gas and cylinder options. Open the "
                + "Gas & Cylinders section to see the "
                + "available products and their details."
            );

        }


        if (
            text.includes("price") ||
            text.includes("cost") ||
            text.includes("how much")
        ) {

            return (
                "Gas prices can vary depending on the "
                + "product, cylinder size and dealer. "
                + "Open the product listing to view the "
                + "current price before placing an order."
            );

        }


        if (
            text.includes("account") ||
            text.includes("register") ||
            text.includes("sign up")
        ) {

            return (
                "You can create a GasHub customer account "
                + "from the registration page. Enter your "
                + "required details and follow the registration "
                + "steps to create your account."
            );

        }


        if (
            text.includes("login") ||
            text.includes("log in") ||
            text.includes("sign in")
        ) {

            return (
                "If you already have a GasHub account, "
                + "open the customer login page and enter "
                + "your registered account details."
            );

        }


        if (
            text.includes("cancel") ||
            text.includes("cancellation")
        ) {

            return (
                "If you need to cancel an order, open your "
                + "order details and check the available "
                + "order actions. If cancellation is not "
                + "available, contact GasHub support for "
                + "assistance."
            );

        }


        if (
            text.includes("hello") ||
            text.includes("hi") ||
            text.includes("hey")
        ) {

            return (
                "Hello! I'm GasHub AI. How can I help "
                + "you today?"
            );

        }


        if (
            text.includes("what is gashub") ||
            text.includes("about gashub")
        ) {

            return (
                "GasHub is a gas marketplace designed to "
                + "help customers find gas products and "
                + "connect with dealers. GasHub was "
                + "introduced on 26 January 2026."
            );

        }


        return (
            "I'm here to help with GasHub questions. "
            + "You can ask me about ordering gas, "
            + "cylinders, dealers, prices, payments, "
            + "deliveries, registration or your orders. "
            + "For a question I cannot answer, please "
            + "contact GasHub support."
        );

    }


    /*
     * SEND MESSAGE
     */
    function handleSendMessage() {

        const question =
            chatInput.value.trim();


        if (!question) {
            return;
        }


        addMessage(
            question,
            "user"
        );


        chatInput.value = "";


        /*
         * Small AI thinking delay
         */
        const thinking =
            document.createElement("div");

        thinking.className =
            "message ai-message thinking-message";

        thinking.innerHTML = `
            <div class="message-avatar"><img src="images/gashub-flame.png" alt="GasHub" class="ai-flame"></div>

            <div class="message-content">
                <p>Thinking...</p>
            </div>
        `;

        chatMessages.appendChild(thinking);

        chatMessages.scrollTop =
            chatMessages.scrollHeight;


        const started = Date.now();

        const engine = window.GasHubAssistant && window.GasHubAssistant.ask
            ? window.GasHubAssistant.ask(question)
            : Promise.resolve([getAIResponse(question)]);

        engine.then(function (result) {

            setTimeout(
                function () {

                    thinking.remove();

                    addMessage(
                        result[0],
                        "ai",
                        result[1]
                    );

                },
                Math.max(0, 150 - (Date.now() - started))
            );

        });

    }


    /*
     * SEND BUTTON
     */
    sendMessage.addEventListener(
        "click",
        handleSendMessage
    );


    /*
     * ENTER TO SEND
     */
    chatInput.addEventListener(
        "keydown",
        function (event) {

            if (
                event.key === "Enter" &&
                !event.shiftKey
            ) {

                event.preventDefault();

                handleSendMessage();

            }

        }
    );


    /*
     * SUGGESTED QUESTIONS
     */
    suggestedQuestions.forEach(
        function (button) {

            button.addEventListener(
                "click",
                function () {

                    const question =
                        button.dataset.question;

                    chatInput.value =
                        question;

                    handleSendMessage();

                }
            );

        }
    );
})();
