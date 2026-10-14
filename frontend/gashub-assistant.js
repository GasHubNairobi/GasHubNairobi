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
    var QUICK = ["Show my last order", "Cheapest 13kg gas", "What do I usually buy?", "My pending orders", "Which dealers are verified?", "I smell gas"];
    var STOP = "a an and any are as at be by can could do does for from get give have how i in is it me my of on or our please show tell that the there this to want we what which who with you your find search looking look need got sell selling buy price prices cost much available availability stock stocked list all some gas products product item items".split(" ");

    /* ================= SMALL HELPERS ================= */
    var SELF = document.currentScript && document.currentScript.src;
    function sibling(file) { return SELF ? SELF.replace(/[^\/]*(\?.*)?$/, file) : file; }
    var FLAME = sibling("images/gashub-flame.png");
    function loadCss() { var l = document.createElement("link"); l.rel = "stylesheet"; l.href = sibling("gashub-assistant.css"); document.head.appendChild(l); }
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
        return [L.join("\n"), orderLink(o)];
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
                    if (kind === "rider") return o.rider && o.rider.name ? ["Your rider for " + o.orderId + " is " + o.rider.name + (o.rider.vehicle ? " (" + o.rider.vehicle + ")" : "") + (o.rider.phone ? ", " + o.rider.phone : "") + ".", orderLink(o)] : ["No rider has been assigned to " + o.orderId + " yet (status: " + (o.status_label || o.status) + ").", orderLink(o)];
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

        return loadProducts().then(function (products) {
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
            var head = (label || "Top ") + "matches (" + r.list.length + " found):";
            if (opts.cheap && top[0]) head += " best price is " + money(top[0].price) + " at " + (top[0].dealer_name || "a dealer") + ".";
            return [head + "\n" + top.map(pLine).join("\n") + (r.list.length > top.length ? "\n…and " + (r.list.length - top.length) + " more." : ""), pLinks(top)];
        });
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
        var t = q.toLowerCase().trim(), safety = /leak|smell|fire|explod|burning/.test(t);
        if (safety || /^(hi|hello|hey|habari|mambo|sasa|good (morning|afternoon|evening))\b[\s!.]*$/.test(t) || /^(thank|asante)/.test(t)) return Promise.resolve(kbAnswer(t));
        return Promise.resolve(orderAnswer(t, q)).then(function (a) {
            if (a) return a;
            return Promise.resolve(productAnswer(t, q)).then(function (b) {
                if (b) return b;
                var k = kbAnswer(t);
                if (k) return k;
                /* last try: treat the words as a product search */
                return loadProducts().then(function (products) {
                    if (products) {
                        var r = searchProducts(products, t, {});
                        if (r.words.length && r.list.length && r.list.length < products.length) return ["Here's what I found:\n" + r.list.slice(0, 5).map(pLine).join("\n"), pLinks(r.list)];
                    }
                    return ["I'm not sure about that one yet. Try asking about a product (\"13kg cylinder\", \"cheapest regulator\"), a dealer, your orders (\"show my last order\"), delivery, payments or safety."];
                });
            });
        }).catch(function () {
            return ["Sorry, something went wrong while looking that up. Please try again."];
        });
    }

    /* ================= UI ================= */
    function linkHtml(links) {
        if (!links) return "";
        if (typeof links[0] === "string") links = [links];
        return '<div class="gha-links">' + links.map(function (l) { return '<a href="' + esc(l[1]) + '">' + esc(l[0]) + "</a>"; }).join("") + "</div>";
    }
    function say(text, links, who) {
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
    function open() { $("ghaChat").classList.add("active"); document.body.classList.add("gha-open"); setTimeout(function () { $("ghaInput").focus(); }, 120); }
    function close() { $("ghaChat").classList.remove("active"); document.body.classList.remove("gha-open"); }

    function build() {
        loadCss();

        var fab = document.createElement("button");
        fab.type = "button"; fab.className = "gha-fab"; fab.setAttribute("aria-label", "Ask GasHub Assist");
        fab.innerHTML = '<i><img src="' + esc(FLAME) + '" alt=""></i>Ask GasHub';
        fab.addEventListener("click", open);
        document.body.appendChild(fab);

        var chat = document.createElement("div");
        chat.className = "gha-chat"; chat.id = "ghaChat";
        chat.innerHTML = '<div class="gha-card" role="dialog" aria-label="GasHub Assist">' +
            '<div class="gha-head"><div><i><img src="' + esc(FLAME) + '" alt="GasHub"></i><span><b>GasHub Assist</b><small>Products · Orders · Help</small></span></div><button type="button" class="gha-x" id="ghaX" aria-label="Close">×</button></div>' +
            '<div class="gha-msgs" id="ghaMsgs"></div>' +
            '<div class="gha-chips">' + QUICK.map(function (q) { return '<button type="button">' + esc(q) + "</button>"; }).join("") + "</div>" +
            '<form class="gha-form" id="ghaForm"><input id="ghaInput" placeholder="Search a product or ask about your orders..." autocomplete="off" aria-label="Your question"><button type="submit">Send</button></form></div>';
        document.body.appendChild(chat);
        say("Hi, I'm GasHub Assist. I can search products and dealers, look up your past orders, check payments and points, and answer questions about gas and delivery.", null, "bot");

        $("ghaX").addEventListener("click", close);
        chat.addEventListener("click", function (e) { if (e.target === chat) close(); });
        var busy = false;
        function ask(q) {
            if (busy) return; busy = true;
            say(q, null, "user");
            var dots = typing(), started = Date.now();
            answer(q).then(function (r) {
                var wait = Math.max(0, 350 - (Date.now() - started));
                setTimeout(function () { dots.remove(); say(r[0], r[1], "bot"); busy = false; }, wait);
            });
        }
        $("ghaForm").addEventListener("submit", function (e) { e.preventDefault(); var i = $("ghaInput"), q = i.value.trim(); if (q) { i.value = ""; ask(q); } });
        Array.prototype.forEach.call(chat.querySelectorAll(".gha-chips button"), function (b) { b.addEventListener("click", function () { ask(b.textContent); }); });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    }

    if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
})();
