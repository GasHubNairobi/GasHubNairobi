/* GasHub floating assistant ("Ask GasHub") - the ONLY assistant, used on every customer page.
   Files: gashub-assistant.js (answers + behaviour) and gashub-assistant.css (look).
   Add <script src="gashub-assistant.js" defer></script> before </body> on a page to show it.
   From other code: GasHubAssistant.open() / .close().

   What it knows:
   - LIVE PRODUCTS  (GET /api/products)  - search by name, size, category, dealer, "cheapest 13kg", "in Nairobi" ...
   - DEALERS        (built from the same product list) - who sells what, verified ticks, ratings
   - THE CUSTOMER'S OWN ORDERS (GET /api/my/orders, /api/my/orders/:id) - last order, history, pending,
     delivered, cancelled, order number lookup, payment, rider, total spent, usual buys
   - GASHUB POINTS  (GET /api/points/balance)
   - DEALER DIRECTORY + CONTACTS (GET /api/dealers) - phone, WhatsApp, email, address, opening hours, open-now, ratings, followers
   - GASHUB SUPPORT CONTACTS (GET /api/settings/contact, /social) and the mobile-app link (/api/settings/app-download)
   - MEMORY: public data is indexed once and cached in the browser (instant answers on every page); the chat and the
     "who are we talking about" context (e.g. "their number") survive page changes for the session.
   - Understands typos and basic Swahili (bei, mtungi, wauzaji, simu ...).
   - General help (the KB list below): sizes, delivery, payment, safety, accounts ...
   Edit the KB list to change the general answers. */
(function () {
    "use strict";
    if (window.GasHubAssistant) return;
    window.GasHubAssistant = { ask: function (q) { return answer(q); }, open: function () { var c = document.getElementById("ghaChat"); if (c) open(); }, close: function () { close(); } };

    /* ================= GENERAL KNOWLEDGE ================= */
    var KB = [
        [/^(hi|hello|hey|habari|mambo|sasa|good (morning|afternoon|evening))\b/, "Hello! I'm GasHub Assist. I can find products, check your orders and answer questions about cylinders, delivery, payments and safety."],
        [/leak|smell|fire|explod|burning/, "If you smell gas:\n1. Don't light flames or use switches.\n2. Close the cylinder valve if it is safe.\n3. Open doors and windows and move everyone outside.\n4. Call 999 or 112, then your dealer.\nDon't use the cylinder again until it is checked."],
        [/withdraw|cash ?out|payout/, "Open the Withdraw page to see your GasHub Coins balance and request a withdrawal. The page shows the status of each request.", ["Withdraw", "customer-withdraw.html"]],
        [/follow (a |the )?dealer|how.*follow|unfollow/, "Open a dealer's profile and tap Follow to keep up with them.", ["Find a dealer", "customer-dealer.html"]],
        [/review|rate (a |the )?dealer|leave a (review|rating)|feedback/, "Open a dealer's profile to read their reviews and leave your own.", ["Find a dealer", "customer-dealer.html"]],
        [/privacy|my data|personal (data|information)|terms/, "You can read how GasHub handles your data in the privacy policy.", ["Privacy policy", "privacy-policy.html"]],
        [/which (gas|cylinder|size)|what size|choose|recommend|how big|family|how many people/, "Rough guide:\n• 6kg: 1-2 people or light cooking\n• 13kg: a family of 3-5, the most common\n• 22kg: large families\n• 50kg: restaurants and businesses\nTell me a size (for example \"13kg\") and I'll show what is available.", ["See cylinders", "customer-product.html?category=cylinders"]],
        [/how long|lasts?\b|finish|duration/, "It depends on how much you cook. As a rough guide, a 6kg cylinder lasts a small household a few weeks, and 13kg lasts a family of 4-5 about one to two months."],
        [/refill|exchange|swap|new cylinder|empty|deposit|own cylinder/, "You can usually refill your own cylinder or buy a new filled one. The dealer shows the exact options, and any cylinder deposit, before you confirm."],
        [/deliver|how fast|how soon|arrive|fee|charge|shipping/, "Your dealer delivers to the location you pin. Delivery time and any fee are shown before you confirm.", ["Find a dealer", "customer-dealer.html"]],
        [/pay|mpesa|m-pesa|card|cash|paybill|till/, "Available payment options are shown at checkout before you confirm your order."],
        [/cancel|change|edit|wrong (item|order)|mistake/, "You can manage an order from My Orders. If it has already been dispatched, contact the dealer directly.", ["My orders", "customer-orders.html"]],
        [/refund|return|damaged|faulty|complain|poor|not full|underweight/, "I'm sorry about that. Open the order in My Orders, report the problem and contact the dealer. Keep your receipt and take a photo of the issue if you can.", ["My orders", "customer-orders.html"]],
        [/verified|trust|legit|licen|genuine|fake|scam/, "Dealers with a tick are verified by GasHub. Check a dealer's rating and number of orders on their profile before you order.", ["View dealers", "customer-dealer.html"]],
        [/become|sell on|join.*dealer|partner/, "Want to sell on GasHub? Submit a dealer application with your business details and map pin.", ["Apply as a dealer", "dealer-application.html"]],
        [/login|log in|sign in|password|forgot|account|register|sign up|profile/, "Manage your account from your profile. If you forgot your password, use the reset option on the login page.", ["My profile", "customer-profile.html"]],
        [/how.*(order|buy)|place an order|checkout/, "1. Search or pick a product.\n2. Choose a dealer and quantity.\n3. Confirm your delivery pin.\n4. Pay and track the order in My Orders.", ["Start shopping", "customer-product.html"]],
        [/area|where do you deliver|pin|address/, "Set your delivery location with the pin button on the home page and you'll see dealers who deliver to you.", ["Go to home", "customer-home.html"]],
        [/safe|safety|storage|tips|indoor|kitchen/, "Safety basics: keep the cylinder upright in a ventilated place away from heat, check hoses for cracks, turn the valve off after cooking, and never use a damaged cylinder."],
        [/contact|support|help|phone|call|email|whatsapp|human|agent/, "For a specific order, contact the dealer from the order page. For anything else, email hello@gashub.co.ke."],
        [/about|gashub|who are you|what is/, "GasHub connects you with trusted gas dealers near you for fast delivery of gas, cylinders and accessories.", ["About GasHub", "customer-about.html"]],
        [/thank|asante|great|cool|^ok/, "You're welcome! Ask me anything else about products, your orders or delivery."]
    ];
    var QUICK = ["Show my last order", "Cheapest 13kg gas", "GasHub support number", "Dealers open now", "Call my dealer", "I smell gas"];
    var STOP = "a an and any are as at be by can could do does for from get give have how i in is it me my of on or our please show tell that the there this to want we what which who with you your find search looking look need got sell selling buy price prices cost much available availability stock stocked list all some gas products product item items".split(" ");

    /* ================= SMALL HELPERS ================= */
    var SELF = document.currentScript && document.currentScript.src;
    function sibling(file) { return SELF ? SELF.replace(/[^\/]*(\?.*)?$/, file) : file; }
    var FLAME = sibling("images/gashub-flame.png");
    /* The stylesheet loads after the page has drawn. Until it arrives the button and chat window have no styling, so their
       flame logos showed at the bottom-left of the page for a second on every refresh. Keep them hidden until it is ready. */
    /* No <style> element is used here: pages with a strict Content-Security-Policy (customer-login / customer-register) block
       every inline <style>, even an empty one. Setting element.style from script is allowed, so the button and chat window are
       hidden that way until the stylesheet has loaded. */
    var held = [], cssReady = false;
    function holdUntilStyled(el) { if (cssReady) return; el.style.setProperty("display", "none", "important"); held.push(el); }
    function loadCss() {
        var done = false, tries = 0;
        function release() { if (done) return; done = true; cssReady = true; held.forEach(function (el) { el.style.removeProperty("display"); }); held = []; }
        /* Reveal ONLY once the stylesheet has really loaded: on a slow connection the old 4-second timeout showed the big
           unstyled flame pictures at the bottom of the page. A failed request is retried; it is never shown without styling. */
        function loadIt() {
            var l = document.createElement("link"); l.rel = "stylesheet";
            l.href = sibling("gashub-assistant.css") + (tries ? "?r=" + tries + "-" + Date.now() : "");
            l.onload = release;
            l.onerror = function () { if (l.parentNode) l.parentNode.removeChild(l); if (++tries <= 5) setTimeout(loadIt, 800 * tries); };
            document.head.appendChild(l);
        }
        loadIt();
    }
    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function $(id) { return document.getElementById(id); }
    function money(n) { return "KSh " + (Number(n) || 0).toLocaleString("en-KE"); }
    function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
    function when(v) { var t = v ? new Date(v) : null; return t && !isNaN(t) ? t.toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }) : ""; }
    function token() { try { return localStorage.getItem("token") || localStorage.getItem("customerToken") || localStorage.getItem("authToken"); } catch (e) { return null; } }
    function readJson(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }

    var cache = {};
    function api(path, ttl) {
        var hit = cache[path];
        if (hit && Date.now() - hit.t < (ttl || 30000)) return hit.p;
        var p = (function () {
            var ctl = window.AbortController ? new AbortController() : null, timer = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
            var h = { Accept: "application/json" }, tk = token(); if (tk) h.Authorization = "Bearer " + tk;
            return fetch(path, { headers: h, credentials: "same-origin", cache: "no-store", signal: ctl ? ctl.signal : undefined })
                .then(function (r) { clearTimeout(timer); return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, json: j }; }); })
                .catch(function () { clearTimeout(timer); return { ok: false, status: 0, json: {} }; });
        })();
        cache[path] = { t: Date.now(), p: p };
        p.then(function (r) { if (!r.ok) delete cache[path]; });
        return p;
    }
    function loadProducts() { return api("/api/products", 120000).then(function (r) { return r.ok && Array.isArray(r.json.products) ? r.json.products : null; }); }
    function loadOrders() {
        if (!token()) return Promise.resolve({ signedOut: true });
        return api("/api/my/orders", 20000).then(function (r) {
            if (r.status === 401 || r.status === 403) return { signedOut: true };
            return r.ok && Array.isArray(r.json.orders) ? { orders: r.json.orders } : { error: true };
        });
    }
    function loadOrder(id) {
        return api("/api/my/orders/" + encodeURIComponent(id), 20000).then(function (r) { return r.ok && r.json.order ? r.json.order : null; });
    }

    /* ================= ORDERS ================= */
    var SIGN_IN = ["I can only see your orders when you're signed in. Please log in and ask again.", ["Log in", "customer-login.html"]];
    var NO_ORDERS = ["You haven't placed any orders yet. When you do, I can show them here.", ["Start shopping", "customer-product.html"]];
    var ORDER_ERR = ["I couldn't load your orders just now. Please try again in a moment, or open My Orders.", ["My orders", "customer-orders.html"]];
    function orderLink(o) { return ["Open " + o.orderId, "customer-orders.html?orderId=" + encodeURIComponent(o.orderId)]; }
    function isDone(o) { return /deliver|complete/i.test(o.status || ""); }
    function isCancelled(o) { return /cancel|reject|fail/i.test(o.status || ""); }
    function isActive(o) { return !isDone(o) && !isCancelled(o); }
    function orderLine(o) {
        var what = o.firstProduct || "Gas order";
        if (o.itemCount > 1) what += " +" + (o.itemCount - 1) + " more";
        return "• " + o.orderId + " - " + what + " - " + money(o.total) + " - " + (o.status_label || o.status) + (o.createdAt ? " (" + when(o.createdAt) + ")" : "");
    }
    function orderList(list, title) {
        if (!list.length) return ["I couldn't find any " + title + ".", ["My orders", "customer-orders.html"]];
        var shown = list.slice(0, 5);
        return [plural(list.length, "order") + " - " + title + ":\n" + shown.map(orderLine).join("\n") + (list.length > shown.length ? "\n…and " + (list.length - shown.length) + " more in My Orders." : ""),
            list.length === 1 ? orderLink(list[0]) : ["See all orders", "customer-orders.html"]];
    }
    function orderDetail(o) {
        var L = ["Order " + o.orderId + " - " + (o.status_label || o.status)];
        if (o.createdAt) L.push("Placed: " + when(o.createdAt));
        if (o.items && o.items.length) L.push("Items:\n" + o.items.map(function (i) { return "• " + i.quantity + "× " + i.name + (i.details ? " (" + i.details + ")" : "") + " - " + money(i.total || i.price * i.quantity); }).join("\n"));
        L.push("Dealer: " + o.dealerName + (o.dealerLocation ? ", " + o.dealerLocation : "") + (o.dealerVerified ? " ✓" : ""));
        var parts = ["Subtotal " + money(o.productTotal)];
        if (o.deliveryFee) parts.push("delivery " + money(o.deliveryFee));
        if (o.discount) parts.push("discount -" + money(o.discount));
        L.push("Total: " + money(o.total) + (parts.length > 1 ? " (" + parts.join(", ") + ")" : ""));
        L.push("Payment: " + (o.payment_status_label || o.paymentStatus || "Unknown") + (o.paymentMethod ? " via " + o.paymentMethod : "") + (o.mpesaReceipt ? " - receipt " + o.mpesaReceipt : ""));
        var where = [o.address, o.town, o.county].filter(Boolean).join(", ");
        if (where) L.push("Delivery to: " + where);
        if (o.rider && o.rider.name) L.push("Rider: " + o.rider.name + (o.rider.vehicle ? " (" + o.rider.vehicle + ")" : "") + (o.rider.phone ? " - " + o.rider.phone : ""));
        if (o.deliveredAt && isDone(o)) L.push("Delivered: " + when(o.deliveredAt));
        if (isCancelled(o) && o.cancellationReason) L.push("Reason: " + o.cancellationReason);
        if (o.pointsAwarded) L.push("GasHub points earned: " + o.pointsAwarded);
        var dd = dealerByName(o.dealerName); if (dd) remember({ dealerId: dd.id, dealerName: dd.name });
        return [L.join("\n"), (o.dealerPhone ? [["Call dealer", telHref(o.dealerPhone)], orderLink(o)] : orderLink(o))];
    }
    function withDetail(o) {
        return loadOrder(o.orderId).then(function (full) { return orderDetail(full || o); });
    }
    function orderAnswer(t, q) {
        var m = q.match(/\b([A-Za-z]{2,5}-[A-Za-z0-9-]{4,})\b/) || q.match(/order\s*(?:number|no\.?|#)?\s*#?\s*([A-Za-z0-9-]{4,})/i);
        var asksOrder = /order|purchase|bought|buy|delivery|delivered|receipt|rider|paid|payment|spent|spend|points|reward|coins|usual|usually|favou?rite|reorder|re-order|track/.test(t);
        if (!asksOrder && !m) return null;
        var ref = m && /\d/.test(m[1]) ? m[1] : null;
        var kind = null;
        if (ref) kind = "ref";
        else if (/points|rewards?|coins/.test(t)) kind = "points";
        else if (/spent|spend|how much (have|did) i|total (amount|spent)/.test(t)) kind = "spent";
        else if (/usual|usually|favou?rite|most (bought|ordered)|bought before|re-?order|what (do|did) i (usually )?(buy|order)/.test(t)) kind = "usual";
        else if (/how many (orders|times)|number of orders|order count/.test(t)) kind = "count";
        else if (/(last|latest|recent|previous|newest)\b.*(order|purchase)|(order|purchase).*\b(last|latest)\b|\bshow my last\b/.test(t)) kind = "last";
        else if (/rider|who delivered|driver|delivery man/.test(t)) kind = "rider";
        else if (/receipt|mpesa (code|receipt)|did (my|the) payment|have i paid|payment status|paid/.test(t) && /order|payment|receipt|paid/.test(t)) kind = "payment";
        else if (/pending|active|ongoing|current|undelivered|not (yet )?delivered|in progress|on the way|where is my|track|status/.test(t)) kind = "active";
        else if (/cancel+ed|rejected|failed/.test(t) && /order/.test(t)) kind = "cancelled";
        else if (/delivered|completed|received/.test(t) && /order|purchase/.test(t)) kind = "done";
        else if (/(my|past|previous|all|recent|order) (orders|purchases|history)|order history|what did i (buy|order)|my orders/.test(t)) kind = "all";
        if (!kind) return null;

        if (kind === "points") {
            return api("/api/points/balance", 20000).then(function (r) {
                if (r.status === 401 || r.status === 403 || !token()) return SIGN_IN;
                var n = Number(r.json.balance != null ? r.json.balance : (r.json.points != null ? r.json.points : r.json.total));
                if (!r.ok || !isFinite(n)) return ["I couldn't load your GasHub points right now. Check your profile page.", ["My profile", "customer-profile.html"]];
                return ["You have " + n.toLocaleString("en-KE") + " GasHub points. You earn more each time an order is completed.", ["My profile", "customer-profile.html"]];
            });
        }
        return loadOrders().then(function (res) {
            if (res.signedOut) return SIGN_IN;
            if (res.error) return ORDER_ERR;
            var all = res.orders;
            if (kind === "ref") {
                var hit = all.filter(function (o) { return String(o.orderId).toLowerCase() === ref.toLowerCase() || String(o.orderId).toLowerCase().indexOf(ref.toLowerCase()) >= 0 || String(o.id) === ref; })[0];
                return hit ? withDetail(hit) : ["I couldn't find an order " + ref + " on your account. Check the number in My Orders.", ["My orders", "customer-orders.html"]];
            }
            if (!all.length) return NO_ORDERS;
            if (kind === "last") return withDetail(all[0]);
            if (kind === "all") return orderList(all, "your most recent");
            if (kind === "count") {
                var d = all.filter(isDone).length, a = all.filter(isActive).length, c = all.filter(isCancelled).length;
                return ["You've placed " + plural(all.length, "order") + ": " + d + " delivered, " + a + " in progress, " + c + " cancelled.", ["My orders", "customer-orders.html"]];
            }
            if (kind === "spent") {
                var paid = all.filter(function (o) { return !isCancelled(o); });
                var sum = paid.reduce(function (s, o) { return s + (Number(o.total) || 0); }, 0);
                return ["Across " + plural(paid.length, "order") + " (cancelled ones not counted) you've spent " + money(sum) + " on GasHub. Your biggest order was " + money(Math.max.apply(null, paid.map(function (o) { return Number(o.total) || 0; }).concat([0]))) + ".", ["My orders", "customer-orders.html"]];
            }
            if (kind === "usual") {
                var c2 = {};
                all.filter(function (o) { return !isCancelled(o) && o.firstProduct; }).forEach(function (o) { var k = o.firstProduct; c2[k] = (c2[k] || 0) + 1; });
                var top = Object.keys(c2).sort(function (a, b) { return c2[b] - c2[a]; }).slice(0, 3);
                if (!top.length) return NO_ORDERS;
                var dealers = {};
                all.forEach(function (o) { if (o.dealerName) dealers[o.dealerName] = (dealers[o.dealerName] || 0) + 1; });
                var fav = Object.keys(dealers).sort(function (a, b) { return dealers[b] - dealers[a]; })[0];
                return ["You usually buy:\n" + top.map(function (k) { return "• " + k + " (" + c2[k] + "×)"; }).join("\n") + (fav ? "\nYour most-used dealer is " + fav + "." : ""), ["Reorder", "customer-orders.html"]];
            }
            if (kind === "active") {
                var act = all.filter(isActive);
                if (!act.length) return ["You have no orders in progress. Your last order was " + all[0].orderId + " (" + (all[0].status_label || all[0].status) + ").", orderLink(all[0])];
                return act.length === 1 ? withDetail(act[0]) : orderList(act, "in progress");
            }
            if (kind === "cancelled") return orderList(all.filter(isCancelled), "cancelled");
            if (kind === "done") return orderList(all.filter(isDone), "delivered");
            if (kind === "rider" || kind === "payment") {
                var target = all.filter(function (o) { return kind === "rider" ? !isCancelled(o) : true; })[0];
                return loadOrder(target.orderId).then(function (o) {
                    o = o || target;
                    if (kind === "rider") return o.rider && o.rider.name ? ["Your rider for " + o.orderId + " is " + o.rider.name + (o.rider.vehicle ? " (" + o.rider.vehicle + ")" : "") + (o.rider.phone ? ", " + o.rider.phone : "") + ".", (o.rider.phone ? [["Call rider", telHref(o.rider.phone)], orderLink(o)] : orderLink(o))] : ["No rider has been assigned to " + o.orderId + " yet (status: " + (o.status_label || o.status) + ").", orderLink(o)];
                    return ["Order " + o.orderId + ": payment " + (o.payment_status_label || o.paymentStatus || "unknown") + ", total " + money(o.total) + (o.amountPaid ? ", paid " + money(o.amountPaid) : "") + (o.mpesaReceipt ? ", receipt " + o.mpesaReceipt : "") + ".", orderLink(o)];
                });
            }
            return null;
        });
    }

    /* ================= PRODUCTS + DEALERS ================= */
    function pText(p) { return [p.name, p.category, p.cylinder_size && (p.cylinder_size + (p.cylinder_unit || "")), p.dealer_name, p.dealer_location, p.description].join(" ").toLowerCase(); }
    function sizeOf(p) { var n = parseFloat(p.cylinder_size); return isFinite(n) ? n : null; }
    function pLabel(p) { var s = p.cylinder_size ? " " + p.cylinder_size + (p.cylinder_unit || "") : ""; var n = String(p.name || "Product"); return /\d\s*kg/i.test(n) || !s ? n : n + " (" + s.trim() + ")"; }
    function pLine(p) {
        return "• " + pLabel(p) + " - " + money(p.price) + " - " + (p.dealer_name || "Dealer") + (p.dealer_is_verified ? " ✓" : "") + (p.dealer_location ? ", " + p.dealer_location : "") + (p.availability && p.availability !== "Available" ? " [" + p.availability + "]" : "");
    }
    function pLinks(list) { return list.slice(0, 3).map(function (p) { return ["View " + (p.name || "product"), "customer-product.html?id=" + encodeURIComponent(p.id)]; }); }
    function tokens(t) {
        return t.replace(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilo|kilos)\b/g, " $1kg ").replace(/[^a-z0-9. ]/g, " ").split(/\s+/).filter(function (w) { return w && STOP.indexOf(w) < 0 && !/^(cheap\w*|lowest|expensive|highest|best|verified|near|nearby|available|cheapest)$/.test(w); });
    }
    function userPoint() { var l = readJson("gasHubLocation", null); var a = l && (l.lat != null ? l.lat : l.latitude), b = l && (l.lng != null ? l.lng : (l.lon != null ? l.lon : l.longitude)); return a != null && b != null && isFinite(a) && isFinite(b) ? [Number(a), Number(b)] : null; }
    function km(a, b) { var r = Math.PI / 180, dx = (b[1] - a[1]) * r * Math.cos((a[0] + b[0]) / 2 * r), dy = (b[0] - a[0]) * r; return Math.sqrt(dx * dx + dy * dy) * 6371; }

    function searchProducts(products, t, opts) {
        var words = tokens(t), list = products.slice(), sizeWords = [], textWords = [];
        words.forEach(function (w) { if (/^\d+(\.\d+)?kg$/.test(w)) sizeWords.push(parseFloat(w)); else if (w.length > 1) textWords.push(w); });
        if (sizeWords.length) list = list.filter(function (p) { var s = sizeOf(p); return s != null ? sizeWords.indexOf(s) >= 0 : sizeWords.some(function (z) { return new RegExp("\\b" + z + "\\s*kg", "i").test(p.name || ""); }); });
        var needs = textWords.length;
        if (needs) {
            list = list.map(function (p) { var h = pText(p), sc = 0; textWords.forEach(function (w) { if (h.indexOf(w) >= 0) sc++; else if (w.length > 3 && h.indexOf(w.replace(/s$/, "")) >= 0) sc++; }); return { p: p, sc: sc }; })
                .filter(function (x) { return x.sc > 0; });
            var best = list.reduce(function (m, x) { return Math.max(m, x.sc); }, 0);
            list = list.filter(function (x) { return x.sc === best; }).map(function (x) { return x.p; });
        }
        if (opts.verified) list = list.filter(function (p) { return p.dealer_is_verified; });
        if (opts.cheap) list.sort(function (a, b) { return a.price - b.price; });
        else if (opts.pricey) list.sort(function (a, b) { return b.price - a.price; });
        else if (opts.near) { var u = userPoint(); if (u) list.sort(function (a, b) { return (a.latitude != null ? km(u, [a.latitude, a.longitude]) : 1e9) - (b.latitude != null ? km(u, [b.latitude, b.longitude]) : 1e9); }); }
        return { list: list, hasFilter: !!(words.length || opts.verified), words: words };
    }

    function dealersFrom(products) {
        var d = {};
        products.forEach(function (p) {
            var k = p.dealer_id || p.dealer_name; if (!k) return;
            var e = d[k] = d[k] || { id: p.dealer_id, name: p.dealer_name || "Dealer", location: p.dealer_location, verified: !!p.dealer_is_verified, rating: p.dealer_rating, lat: p.latitude, lng: p.longitude, n: 0, min: Infinity };
            e.n++; if (p.price < e.min) e.min = p.price;
        });
        return Object.keys(d).map(function (k) { return d[k]; });
    }
    function dealerLine(d) { return "• " + d.name + (d.verified ? " ✓" : "") + (d.location ? " - " + d.location : "") + (d.rating ? " - ★ " + Number(d.rating).toFixed(1) : "") + " - " + plural(d.n, "product") + " from " + money(d.min); }

    function productAnswer(t, q) {
        var wantsDealers = /dealers?|sellers?|shops?|vendors?/.test(t) && !/become|apply|join/.test(t);
        var searchy = /cheap|lowest|expensive|highest|price|cost|how much|available|in stock|do you have|have you got|show|find|search|list|sell|looking|need|want|buy|get me|any |which|categor|what .*(have|sell)|\d+\s*(kg|kilo)|regulator|hose|burner|stove|cylinder|accessor|refill|gas\b/.test(t);
        if (!wantsDealers && !searchy) return null;

        return productsNow().then(function (products) {
            if (!products) return ["I couldn't load the product list just now. Please try again, or browse the products page.", ["View products", "customer-product.html"]];
            if (!products.length) return ["There are no products listed right now. Please check back soon.", ["View products", "customer-product.html"]];
            var opts = { cheap: /cheap|lowest|affordable|budget|least/.test(t), pricey: /expensive|highest|premium|most costly/.test(t), verified: /verified|trusted/.test(t), near: /near|nearby|closest|close to me/.test(t) };

            if (/categor|what (do you|can i|are you).*(sell|have|buy)|what.*available|types of/.test(t) && !tokens(t).length || /categor/.test(t)) {
                var c = {}; products.forEach(function (p) { var k = p.category || "Other"; c[k] = (c[k] || 0) + 1; });
                return ["We have " + plural(products.length, "product") + " from " + plural(dealersFrom(products).length, "dealer") + ":\n" + Object.keys(c).map(function (k) { return "• " + k + ": " + c[k]; }).join("\n") + "\nAsk me for a size or item, like \"13kg\" or \"regulator\".", ["Browse products", "customer-product.html"]];
            }

            var ds = dealersFrom(products);
            if (wantsDealers) {
                var named = ds.filter(function (d) { return tokens(t).some(function (w) { return w.length > 2 && d.name.toLowerCase().indexOf(w) >= 0; }); });
                if (named.length === 1) {
                    remember({ dealerId: named[0].id, dealerName: named[0].name });
                    var mine = products.filter(function (p) { return (p.dealer_id || p.dealer_name) === (named[0].id || named[0].name); }).sort(function (a, b) { return a.price - b.price; });
                    return [named[0].name + (named[0].verified ? " ✓" : "") + (named[0].location ? " (" + named[0].location + ")" : "") + " sells:\n" + mine.slice(0, 6).map(function (p) { return "• " + pLabel(p) + " - " + money(p.price); }).join("\n") + (mine.length > 6 ? "\n…and " + (mine.length - 6) + " more." : ""), named[0].id ? ["Open dealer", "customer-dealer.html?id=" + encodeURIComponent(named[0].id)] : ["Find a dealer", "customer-dealer.html"]];
                }
                var pool = opts.verified ? ds.filter(function (d) { return d.verified; }) : ds;
                var u = opts.near ? userPoint() : null;
                if (u) pool.sort(function (a, b) { return (a.lat != null ? km(u, [a.lat, a.lng]) : 1e9) - (b.lat != null ? km(u, [b.lat, b.lng]) : 1e9); });
                else pool.sort(function (a, b) { return (b.verified - a.verified) || ((b.rating || 0) - (a.rating || 0)) || b.n - a.n; });
                if (!pool.length) return ["No verified dealers are listed right now.", ["Find a dealer", "customer-dealer.html"]];
                return [(opts.verified ? "Verified dealers" : (u ? "Dealers closest to you" : "Top dealers")) + " (" + pool.length + "):\n" + pool.slice(0, 5).map(dealerLine).join("\n") + (opts.near && !u ? "\nSet your location on the home page and I can sort by distance." : ""), ["Find a dealer", "customer-dealer.html"]];
            }

            var r = searchProducts(products, t, opts);
            if (!r.hasFilter && !opts.cheap && !opts.pricey) return null;
            if (!r.list.length) {
                return ["I couldn't find a match for \"" + r.words.join(" ") + "\"" + (opts.verified ? " from verified dealers" : "") + ". Try a size like 13kg, or an item like regulator, hose or burner.", ["Browse products", "customer-product.html"]];
            }
            var top = r.list.slice(0, 5), label = opts.cheap ? "Cheapest " : opts.pricey ? "Most expensive " : "";
            if (top[0]) remember({ dealerId: top[0].dealer_id, dealerName: top[0].dealer_name });
            var head = (label || "Top ") + "matches (" + r.list.length + " found):";
            if (opts.cheap && top[0]) head += " best price is " + money(top[0].price) + " at " + (top[0].dealer_name || "a dealer") + ".";
            return [head + "\n" + top.map(pLine).join("\n") + (r.list.length > top.length ? "\n…and " + (r.list.length - top.length) + " more." : ""), pLinks(top)];
        });
    }

    /* ================= KNOWLEDGE INDEX (the assistant's memory) =================
       Everything public is loaded ONCE, indexed, and cached in the browser (localStorage, 30 min) so answers are
       instant and the next page opens already "knowing" the platform. It refreshes quietly in the background.
       Sources: /api/products, /api/dealers (contacts, hours, ratings), /api/settings/contact, /api/settings/social.
       Private data (orders, points, rider phone) is NEVER cached - it is fetched live and only when signed in. */
    var K = { products: null, dealers: null, contact: null, social: null, at: 0, p: null, D: [], PLACES: [] };
    var VOC = {}, CTX = readSession("gha:ctx", {});
    var CORE = "contact contacts phone number whatsapp email address location dealer dealers cylinder cylinders regulator delivery payment orders order cheapest cheap verified nearest nearby available hours open closed rating ratings reviews followers support refund points rewards withdraw withdrawal track tracking rider driver price prices burner stove hose balance history receipt cancel cancelled pending delivered customer care safety leak town county website facebook instagram twitter tiktok download".split(" ");
    var PROTECT = "house home hours there their where when which would about after again could every first found great large might never other place right small still such those three under water while world write years phone phones price prize order border cooker cooking nairobi mombasa".split(" ");
    var STOPSET = {}, PROTSET = {};
    STOP.forEach(function (w) { STOPSET[w] = 1; }); PROTECT.forEach(function (w) { PROTSET[w] = 1; });
    var GENERIC = {}; "gas gass energy ltd limited enterprises enterprise supplies supply and the co company lpg distributors distributor dealers dealer services service shop center centre traders trading station cylinders cylinder of".split(" ").forEach(function (w) { GENERIC[w] = 1; });
    var SYN = { bei: "price", gharama: "price", mtungi: "cylinder", mitungi: "cylinders", gesi: "gas", simu: "phone", nambari: "number", namba: "number", wauzaji: "dealers", muuzaji: "dealer", duka: "shop", karibu: "near", wapi: "where", agizo: "order", maagizo: "orders", malipo: "payment", lipa: "pay", msaada: "help", saa: "hours", imefunguliwa: "open", mahali: "location", barua: "email", bora: "best", rahisi: "cheap", jirani: "near", phon: "phone", fone: "phone", numbr: "number", nmber: "number", numba: "number", cntact: "contact", contakt: "contact", emial: "email", delivry: "delivery", cylindr: "cylinder", regulater: "regulator", adress: "address", wher: "where" };

    function readSession(k, d) { try { var v = JSON.parse(sessionStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
    function writeSession(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
    function words(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean); }
    function addVocab(s) { words(s).forEach(function (w) { if (w.length >= 4 && !/\d/.test(w)) VOC[w] = 1; }); }
    function lev(a, b, max) {
        if (Math.abs(a.length - b.length) > max) return max + 1;
        var prev = [], i, j, cur, c, rowMin;
        for (j = 0; j <= b.length; j++) prev[j] = j;
        for (i = 1; i <= a.length; i++) {
            cur = [i]; rowMin = i;
            for (j = 1; j <= b.length; j++) { c = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1; cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c); if (cur[j] < rowMin) rowMin = cur[j]; }
            if (rowMin > max) return max + 1;
            prev = cur;
        }
        return prev[b.length];
    }
    function expand(t) { return t.replace(/[a-z]+/g, function (w) { return SYN[w] || w; }); }
    function fixTypos(t) {
        return t.replace(/[a-z]{5,}/g, function (w) {
            if (VOC[w] || STOPSET[w] || PROTSET[w]) return w;
            var max = w.length >= 8 ? 2 : 1, best = null, bd = max + 1, k, d;
            for (k in VOC) { if (k.charAt(0) !== w.charAt(0) || Math.abs(k.length - w.length) > max) continue; d = lev(w, k, max); if (d < bd) { bd = d; best = k; if (d === 0) break; } }
            return best && bd <= max ? best : w;
        });
    }
    function remember(o) { for (var k in o) if (o[k] != null) CTX[k] = o[k]; writeSession("gha:ctx", CTX); }

    function telHref(p) { var d = String(p || "").replace(/[^\d+]/g, ""); if (/^0\d{9}$/.test(d)) d = "+254" + d.slice(1); else if (/^254\d{9}$/.test(d)) d = "+" + d; return "tel:" + d; }
    function waHref(p) { var d = String(p || "").replace(/\D/g, ""); if (/^0\d{9}$/.test(d)) d = "254" + d.slice(1); return "https://wa.me/" + d; }
    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    function index() {
        var ds = [], seen = {}, prods = K.products || [];
        VOC = {}; CORE.forEach(function (w) { VOC[w] = 1; });
        (K.dealers || []).forEach(function (d) {
            var e = {
                id: d.id, name: d.business_name || "Dealer", phone: d.phone || "", email: d.email || "", person: d.contact_person || "",
                county: d.county || "", town: d.town || "", location: d.location || "", address: d.address || "",
                hours: d.hours_text || "", days: d.working_days_text || "", open: d.is_open_now, status: d.open_status || "", detail: d.open_status_detail || "",
                rating: Number(d.rating) || 0, reviews: Number(d.review_count) || 0, followers: Number(d.follower_count) || 0,
                verified: d.verification_active != null ? !!d.verification_active : !!d.is_verified,
                lat: d.latitude != null && isFinite(d.latitude) ? Number(d.latitude) : null, lng: d.longitude != null && isFinite(d.longitude) ? Number(d.longitude) : null,
                n: Number(d.product_count) || 0, min: Infinity
            };
            seen[String(d.id)] = e; ds.push(e);
        });
        prods.forEach(function (p) {
            var key = String(p.dealer_id), e = seen[key];
            if (!e && p.dealer_id != null) { e = seen[key] = { id: p.dealer_id, name: p.dealer_name || "Dealer", phone: p.dealer_phone || "", email: p.dealer_email || "", person: "", county: "", town: "", location: p.dealer_location || "", address: "", hours: "", days: "", open: undefined, status: "", detail: "", rating: Number(p.dealer_rating) || 0, reviews: 0, followers: Number(p.dealer_follower_count) || 0, verified: !!p.dealer_is_verified, lat: p.latitude, lng: p.longitude, n: 0, min: Infinity }; ds.push(e); }
            if (e) { e.seenN = (e.seenN || 0) + 1; if (p.price < e.min) e.min = p.price; }
            addVocab(p.name); addVocab(p.category);
        });
        ds.forEach(function (e) { if (e.seenN) e.n = e.seenN; });
        var places = {};
        ds.forEach(function (d) {
            addVocab(d.name); addVocab(d.town); addVocab(d.county); addVocab(d.location);
            [d.town, d.county].concat(String(d.location || "").split(",")).forEach(function (s) { var p = words(s).join(" "); if (p.length > 2 && p.length < 30) places[p] = 1; });
        });
        K.D = ds; K.PLACES = Object.keys(places);
    }
    function save() { try { localStorage.setItem("gha:kb:v2", JSON.stringify({ at: K.at, products: K.products, dealers: K.dealers, contact: K.contact, social: K.social })); } catch (e) { } }
    function seed() {
        try {
            var s = JSON.parse(localStorage.getItem("gha:kb:v2"));
            if (s && s.at && Date.now() - s.at < 1800000) { K.products = s.products; K.dealers = s.dealers; K.contact = s.contact; K.social = s.social; K.at = s.at; index(); K.p = Promise.resolve(K); }
        } catch (e) { }
    }
    function fetchAll() {
        return Promise.all([
            loadProducts(),
            api("/api/dealers", 120000).then(function (r) { return r.ok && Array.isArray(r.json.dealers) ? r.json.dealers : null; }),
            api("/api/settings/contact", 300000).then(function (r) { return r.ok && r.json.success ? r.json : null; }),
            api("/api/settings/social", 300000).then(function (r) { return r.ok && r.json.social_links ? r.json.social_links : null; })
        ]).then(function (a) {
            if (a[0]) K.products = a[0]; if (a[1]) K.dealers = a[1]; if (a[2]) K.contact = a[2]; if (a[3]) K.social = a[3];
            if (a[0] || a[1] || a[2]) { K.at = Date.now(); index(); save(); }
            return K;
        });
    }
    /* Returns instantly when memory is fresh or stale-but-present; refreshes in the background. */
    function knowledge() {
        if (K.p && Date.now() - K.at < 300000) return K.p;
        var fresh = fetchAll();
        if (K.products || K.dealers) { K.p = Promise.resolve(K); K.at = Date.now() - 240000; fresh.then(function () { K.p = Promise.resolve(K); }); return K.p; }
        K.p = fresh; return fresh;
    }
    function productsNow() { return knowledge().then(function (k) { return k.products; }); }

    /* ---------- dealer lookups ---------- */
    function nameWords(s) { return words(s).filter(function (w) { return w.length > 2 && !GENERIC[w]; }); }
    function findDealers(t) {
        var ws = words(t).filter(function (w) { return w.length > 2 && !STOPSET[w] && !GENERIC[w]; }), best = [], bs = 0;
        K.D.forEach(function (d) {
            var sc = 0;
            nameWords(d.name).forEach(function (nw) { if (ws.some(function (w) { return w === nw || (w.length > 3 && nw.length > 3 && lev(w, nw, 1) <= 1); })) sc++; });
            if (sc > bs) { bs = sc; best = [d]; } else if (sc === bs && sc > 0) best.push(d);
        });
        return best;
    }
    function dealerById(id) { for (var i = 0; i < K.D.length; i++) if (String(K.D[i].id) === String(id)) return K.D[i]; return null; }
    function dealerByName(n) {
        if (!n) return null; var l = String(n).toLowerCase();
        for (var i = 0; i < K.D.length; i++) if (K.D[i].name.toLowerCase() === l) return K.D[i];
        var f = findDealers(l); return f.length === 1 ? f[0] : null;
    }
    function placeIn(t) { var h = " " + words(t).join(" ") + " "; return K.PLACES.filter(function (p) { return h.indexOf(" " + p + " ") >= 0; }); }
    function dealersInPlaces(pl) { return K.D.filter(function (d) { var h = " " + words([d.town, d.county, d.location, d.address].join(" ")).join(" ") + " "; return pl.some(function (p) { return h.indexOf(" " + p + " ") >= 0; }); }); }
    function rank(list) { return list.slice().sort(function (a, b) { return (b.verified - a.verified) || (b.rating - a.rating) || (b.n - a.n); }); }

    function dealerCard(d, prefix) {
        remember({ dealerId: d.id, dealerName: d.name });
        var L = [d.name + (d.verified ? " ✓" : "")], where = [d.address, d.town, d.county].filter(Boolean).join(", ") || d.location;
        if (where) L.push("Location: " + where);
        if (d.person) L.push("Contact person: " + d.person);
        if (d.phone) L.push("Phone: " + d.phone);
        if (d.email) L.push("Email: " + d.email);
        if (d.status || d.hours) L.push("Hours: " + [d.status, d.hours].filter(Boolean).join(" - "));
        if (d.rating) L.push("★ " + d.rating.toFixed(1) + (d.reviews ? " (" + plural(d.reviews, "review") + ")" : "") + (d.followers ? " · " + plural(d.followers, "follower") : ""));
        if (!d.phone && !d.email) L.push("No contact details are listed - open the profile or message them there.");
        var links = [];
        if (d.phone) links.push(["Call", telHref(d.phone)], ["WhatsApp", waHref(d.phone)]);
        if (d.email) links.push(["Email", "mailto:" + d.email]);
        if (d.lat != null && d.lng != null) links.push(["Map", "https://www.google.com/maps?q=" + d.lat + "," + d.lng]);
        if (d.id != null) links.push(["Profile", "customer-dealer.html?id=" + encodeURIComponent(d.id)]);
        return [(prefix || "") + L.join("\n"), links];
    }
    function dealerList(list, title, withPhone) {
        if (!list.length) return [title + ": none found.", ["Find a dealer", "customer-dealer.html"]];
        var top = rank(list).slice(0, 5);
        remember({ dealerId: top[0].id, dealerName: top[0].name });
        return [title + " (" + list.length + "):\n" + top.map(function (d) {
            return withPhone ? "• " + d.name + (d.verified ? " ✓" : "") + (d.town || d.location ? " - " + (d.town || d.location) : "") + (d.phone ? " - " + d.phone : "") + (d.status ? " - " + d.status : "")
                : "• " + d.name + (d.verified ? " ✓" : "") + (d.location ? " - " + d.location : "") + (d.rating ? " - ★ " + d.rating.toFixed(1) : "") + (d.followers ? " - " + plural(d.followers, "follower") : "");
        }).join("\n") + (list.length > top.length ? "\n…and " + (list.length - top.length) + " more." : "") + "\nAsk \"call <dealer name>\" for full details.",
        top.slice(0, 2).map(function (d) { return ["Open " + d.name, "customer-dealer.html?id=" + encodeURIComponent(d.id)]; }).concat([["All dealers", "customer-dealer.html"]])];
    }
    function supportCard() {
        var c = K.contact || {}, L = ["GasHub support"], links = [], email = c.email || "hello@gashub.co.ke";
        if (c.phone) { L.push("Phone: " + c.phone); links.push(["Call", telHref(c.phone)]); }
        if (c.whatsapp) { L.push("WhatsApp: +" + String(c.whatsapp).replace(/\D/g, "")); links.push(["WhatsApp", waHref(c.whatsapp)]); }
        L.push("Email: " + email); links.push(["Email", "mailto:" + email]);
        if (c.hours) L.push("Hours: " + c.hours);
        if (c.website) { L.push("Website: " + c.website); links.push(["Website", /^https?:/i.test(c.website) ? c.website : "https://" + c.website]); }
        var soc = K.social || {}, names = Object.keys(soc);
        if (names.length) { L.push("Social: " + names.map(cap).join(", ")); names.slice(0, 3).forEach(function (n) { if (/^https?:/i.test(soc[n])) links.push([cap(n), soc[n]]); }); }
        L.push("For a specific order, contact the dealer - ask \"call my dealer\".");
        return [L.join("\n"), links];
    }

    function cardFor(d, t) {
        var c = dealerCard(d), miss = [];
        if (/\b(email|e-?mail)\b/.test(t) && !d.email) miss.push("email");
        if (/\b(phone|call|whatsapp|number|mobile)\b/.test(t) && !d.phone) miss.push("phone number");
        if (miss.length) c[0] = "No " + miss.join(" or ") + " is listed for " + d.name + ".\n" + c[0];
        return c;
    }
    var PRON = /\b(their|his|her|them|its|that dealer|this dealer|the dealer|that one|same dealer|they|there|it)\b/;
    function orderDealerContact() {
        return loadOrders().then(function (res) {
            if (res.signedOut) return SIGN_IN;
            if (res.error) return ORDER_ERR;
            if (!res.orders.length) return NO_ORDERS;
            var o = res.orders[0], d = dealerByName(o.dealerName);
            if (d) return dealerCard(d, "Dealer for your latest order " + o.orderId + ":\n");
            return loadOrder(o.orderId).then(function (full) {
                full = full || o;
                if (full.dealerPhone) return ["Dealer for " + full.orderId + ": " + (full.dealerName || "GasHub dealer") + "\nPhone: " + full.dealerPhone, [["Call", telHref(full.dealerPhone)], ["WhatsApp", waHref(full.dealerPhone)], orderLink(full)]];
                return ["I couldn't find contact details for " + (full.dealerName || "that dealer") + ". Open the order to message them.", orderLink(full)];
            });
        });
    }

    /* ---------- CONTACT intent: GasHub support, dealers, "call my dealer", follow-ups like "their number" ---------- */
    function contactAnswer(t) {
        var ask = /\b(contact|contacts|call|phone|telephone|mobile|whatsapp|email|e-?mail|reach|hotline|helpline|customer (care|service)|talk to|speak to|sms)\b/.test(t) ||
            (/\bnumber\b/.test(t) && !/order\s*(number|no)|number of|house number|account number|how many/.test(t));
        var addr = /\b(address|located|where is|where are|location of|directions?)\b/.test(t) && !/\b(order|deliver\w*|my address|rider|nearest|near)\b/.test(t);
        if ((!ask && !addr) || /\b(rider|driver|delivery man|messenger)\b/.test(t)) return null;
        return knowledge().then(function () {
            if (/\b(my|last|previous)\b.*\bdealer\b|dealer (of|from) my|the dealer i (ordered|bought)/.test(t)) return orderDealerContact();
            var named = findDealers(t);
            if (named.length === 1) return cardFor(named[0], t);
            if (named.length > 1) return dealerList(named, "Dealers matching that name", true);
            if (PRON.test(t) && CTX.dealerId && dealerById(CTX.dealerId)) return cardFor(dealerById(CTX.dealerId), t);
            var places = placeIn(t);
            if (/\bdealers?\b|\bshops?\b|\bsellers?\b/.test(t) || places.length) {
                if (!ask && !addr) return null;
                return dealerList(places.length ? dealersInPlaces(places) : K.D, places.length ? "Dealers in " + places.map(cap).join(", ") : "Dealer contacts", true);
            }
            if (!ask) return null;
            return supportCard();
        });
    }

    /* ---------- DEALER info: hours / open now / ratings / followers / counts / dealers in a place ---------- */
    function dealerAnswer(t) {
        var hours = /\b(open|opening|closing|closes?|hours|closed)\b/.test(t) && /\b(now|today|tonight|late|hours|opening|closing|closes?|closed|open)\b/.test(t),
            rating = /\b(ratings?|rated|reviews?|stars?|best dealer|top dealer|best rated|top rated)\b/.test(t),
            fol = /\b(followers?|most followed)\b/.test(t),
            count = /how many (dealers|shops|outlets)|number of dealers/.test(t),
            dealerish = /\b(dealers?|shops?|sellers?|outlets?|vendors?|who|which)\b/.test(t);
        var places = null;
        if (!(hours || rating || fol || count)) { places = null; if (!dealerish) return null; }
        return knowledge().then(function () {
            if (!K.D.length) return null;
            places = placeIn(t);
            var verified = /\bverified\b/.test(t), named = findDealers(t), d = named.length === 1 ? named[0] : (named.length === 0 && PRON.test(t) && CTX.dealerId ? dealerById(CTX.dealerId) : null);
            if (!(hours || rating || fol || count)) {
                if (!places.length) return null;
                var inPlace = dealersInPlaces(places); if (verified) inPlace = inPlace.filter(function (x) { return x.verified; });
                return dealerList(inPlace, (verified ? "Verified dealers in " : "Dealers in ") + places.map(cap).join(", "), false);
            }
            if (count) { var v = K.D.filter(function (x) { return x.verified; }).length; return ["GasHub has " + plural(K.D.length, "dealer") + " listed, " + v + " verified.", ["Find a dealer", "customer-dealer.html"]]; }
            if (d) {
                remember({ dealerId: d.id, dealerName: d.name });
                if (hours) return [d.name + ": " + (d.status || "opening hours not set") + (d.detail ? " - " + d.detail : "") + (d.hours ? "\nHours: " + d.hours : "") + (d.days ? "\nDays: " + d.days : ""), [["Open profile", "customer-dealer.html?id=" + encodeURIComponent(d.id)]].concat(d.phone ? [["Call", telHref(d.phone)]] : [])];
                if (rating || fol) return [d.name + (d.verified ? " ✓" : "") + ": " + (d.rating ? "★ " + d.rating.toFixed(1) + " from " + plural(d.reviews, "review") : "no ratings yet") + " · " + plural(d.followers, "follower") + ".", [["Reviews & profile", "customer-dealer.html?id=" + encodeURIComponent(d.id)]]];
            }
            if (!dealerish) return null;
            var pool = places.length ? dealersInPlaces(places) : K.D;
            if (verified) pool = pool.filter(function (x) { return x.verified; });
            if (hours) {
                var known = pool.filter(function (x) { return x.open !== undefined && x.open !== null; }), open = known.filter(function (x) { return x.open; });
                if (!known.length) return ["Dealer opening hours aren't available right now. Open a dealer's profile to see their hours.", ["Find a dealer", "customer-dealer.html"]];
                return dealerList(open, "Dealers open now", true);
            }
            if (fol) return dealerList(pool.slice().sort(function (a, b) { return b.followers - a.followers; }), "Most followed dealers", false);
            var rated = pool.filter(function (x) { return x.rating > 0; }).sort(function (a, b) { return (b.rating - a.rating) || (b.reviews - a.reviews); });
            return rated.length ? dealerList(rated, "Top rated dealers", false) : ["No dealer ratings are available yet.", ["Find a dealer", "customer-dealer.html"]];
        });
    }

    function appAnswer(t) {
        if (!/\b(app|play ?store|google play|download|android|apk)\b/.test(t) || /receipt|invoice|statement|report/.test(t)) return null;
        return api("/api/settings/app-download", 300000).then(function (r) {
            return r.ok && r.json.live && r.json.url ? ["The GasHub app is live on Google Play.", [["Get the app", r.json.url]]] : ["The GasHub mobile app isn't available yet. You can keep using GasHub in your browser."];
        });
    }

    /* Last resort: look through EVERYTHING the assistant knows (dealers, places, products) before giving up. */
    function globalSearch(t) {
        var f = findDealers(t);
        if (f.length === 1) return dealerCard(f[0]);
        if (f.length > 1) return dealerList(f, "Dealers matching that", true);
        var pl = placeIn(t);
        if (pl.length) return dealerList(dealersInPlaces(pl), "Dealers in " + pl.map(cap).join(", "), true);
        var products = K.products;
        if (products) {
            var r = searchProducts(products, t, {});
            if (r.words.length && r.list.length && r.list.length < products.length) return ["Here's what I found:\n" + r.list.slice(0, 5).map(pLine).join("\n"), pLinks(r.list)];
        }
        return ["I'm not sure about that one yet. Try a product (\"13kg cylinder\", \"cheapest regulator\"), a dealer (\"call <dealer name>\", \"dealers open now\", \"dealers in Westlands\"), contacts (\"GasHub support number\"), your orders (\"show my last order\"), delivery, payments or safety."];
    }

    /* ================= ANSWER ================= */
    function kbAnswer(t) {
        for (var i = 0; i < KB.length; i++) if (KB[i][0].test(t)) return [KB[i][1], KB[i][2]];
        return null;
    }
    function localHistory() {
        var c = {};
        (readJson("gasHubPurchases", []) || []).forEach(function (h) { var k = String(h.id != null ? h.id : h.name); c[k] = c[k] || { name: h.name, n: 0 }; c[k].n += Number(h.qty) || 1; });
        return Object.keys(c).map(function (k) { return c[k]; }).sort(function (a, b) { return b.n - a.n; });
    }
    function answer(q) {
        var t0 = q.toLowerCase().trim(), safety = /leak|smell|fire|explod|burning/.test(t0);
        if (safety || /^(hi|hello|hey|habari|mambo|sasa|good (morning|afternoon|evening))\b[\s!.]*$/.test(t0) || /^(thank|asante)/.test(t0)) return Promise.resolve(kbAnswer(t0));
        return knowledge().then(function () {
            var t = fixTypos(expand(t0));
            return Promise.resolve(contactAnswer(t))
                .then(function (a) { return a || orderAnswer(t, q); })
                .then(function (a) { return a || dealerAnswer(t); })
                .then(function (a) { return a || productAnswer(t, q); })
                .then(function (a) { return a || appAnswer(t); })
                .then(function (a) { return a || kbAnswer(t) || globalSearch(t); });
        }).catch(function () {
            return ["Sorry, something went wrong while looking that up. Please try again."];
        });
    }

    /* ================= UI ================= */
    function linkHtml(links) {
        if (!links) return "";
        if (typeof links[0] === "string") links = [links];
        return '<div class="gha-links">' + links.map(function (l) { return '<a href="' + esc(l[1]) + '"' + (/^https?:/i.test(l[1]) ? ' target="_blank" rel="noopener"' : "") + ">" + esc(l[0]) + "</a>"; }).join("") + "</div>";
    }
    var HIST = [];
    function saveHist(text, links, who) { HIST.push({ t: text, l: links || null, w: who }); if (HIST.length > 40) HIST.shift(); writeSession("gha:hist", { signed: !!token(), msgs: HIST }); }
    function loadHist() { var h = readSession("gha:hist", null); if (!h || !h.msgs || (h.signed && !token())) { try { sessionStorage.removeItem("gha:hist"); sessionStorage.removeItem("gha:ctx"); } catch (e) { } CTX = {}; return []; } return h.msgs; }
    function say(text, links, who, noSave) {
        if (!noSave) saveHist(text, links, who);
        var box = $("ghaMsgs"), row = document.createElement("div");
        row.className = "gha-row " + who;
        var body = '<div class="gha-msg ' + who + '">' + esc(text) + linkHtml(links) + "</div>";
        row.innerHTML = who === "bot" ? '<span class="gha-av"><img src="' + esc(FLAME) + '" alt=""></span>' + body : body;
        box.appendChild(row); box.scrollTop = box.scrollHeight;
        return row;
    }
    function typing() {
        var row = document.createElement("div"); row.className = "gha-row bot gha-typing";
        row.innerHTML = '<span class="gha-av"><img src="' + esc(FLAME) + '" alt=""></span><div class="gha-msg bot"><span class="gha-dots"><i></i><i></i><i></i></span></div>';
        var box = $("ghaMsgs"); box.appendChild(row); box.scrollTop = box.scrollHeight; return row;
    }
    function open() { knowledge(); $("ghaChat").classList.add("active"); document.body.classList.add("gha-open"); setTimeout(function () { $("ghaInput").focus(); }, 120); }
    function close() { $("ghaChat").classList.remove("active"); document.body.classList.remove("gha-open"); }

    function build() {
        loadCss();

        var fab = document.createElement("button");
        fab.type = "button"; fab.className = "gha-fab"; fab.setAttribute("aria-label", "Ask GasHub Assist");
        fab.innerHTML = '<i><img src="' + esc(FLAME) + '" alt=""></i>Ask GasHub';
        fab.addEventListener("click", open);
        holdUntilStyled(fab);
        document.body.appendChild(fab);

        var chat = document.createElement("div");
        chat.className = "gha-chat"; chat.id = "ghaChat";
        chat.innerHTML = '<div class="gha-card" role="dialog" aria-label="GasHub Assist">' +
            '<div class="gha-head"><div><i><img src="' + esc(FLAME) + '" alt="GasHub"></i><span><b>GasHub Assist</b><small>Products · Dealers · Contacts · Orders</small></span></div><button type="button" class="gha-x" id="ghaX" aria-label="Close">×</button></div>' +
            '<div class="gha-msgs" id="ghaMsgs"></div>' +
            '<div class="gha-chips">' + QUICK.map(function (q) { return '<button type="button">' + esc(q) + "</button>"; }).join("") + "</div>" +
            '<form class="gha-form" id="ghaForm"><input id="ghaInput" placeholder="Ask about products, dealers, contacts, orders..." autocomplete="off" aria-label="Your question"><button type="submit">Send</button></form></div>';
        holdUntilStyled(chat);
        document.body.appendChild(chat);
        var past = loadHist();
        if (past.length) { HIST = past.slice(); past.forEach(function (m) { say(m.t, m.l, m.w, true); }); }
        else say("Hi, I'm GasHub Assist. I can search products and dealers, find phone numbers and opening hours, look up your orders, points and payments, and answer questions about gas and delivery.", null, "bot");

        $("ghaX").addEventListener("click", close);
        chat.addEventListener("click", function (e) { if (e.target === chat) close(); });
        var busy = false;
        function ask(q) {
            if (busy) return; busy = true;
            say(q, null, "user");
            var dots = typing(), started = Date.now();
            answer(q).then(function (r) {
                var wait = Math.max(0, 150 - (Date.now() - started));
                setTimeout(function () { dots.remove(); say(r[0], r[1], "bot"); busy = false; }, wait);
            });
        }
        $("ghaForm").addEventListener("submit", function (e) { e.preventDefault(); var i = $("ghaInput"), q = i.value.trim(); if (q) { i.value = ""; ask(q); } });
        Array.prototype.forEach.call(chat.querySelectorAll(".gha-chips button"), function (b) { b.addEventListener("click", function () { ask(b.textContent); }); });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    }

    seed();
    function warm() { knowledge(); }
    if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 2500 }); else setTimeout(warm, 1200);
    if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
})();