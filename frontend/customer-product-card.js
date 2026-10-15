/* GasHub shared product helper (used by customer-home.html, customer-product.html and customer-dealer.html).
   Add it BEFORE the page script:  <script src="customer-product-card.js"></script>

   One place decides how a product is read from the API and how its card looks, so the belt,
   "Products near you", the Products page and a dealer's Products tab always show the SAME card
   with the SAME gas weight, views and bought numbers.
   (Which products appear where - the belt ranking, filters, closest first - stays in each page.) */
(function () {
    "use strict";
    if (window.GasHubProducts) return;

    var FAV_KEY = "gasHubFavorites", LOC_KEY = "gasHubLocation";
    var DEALER_PAGE = "customer-dealer.html", PRODUCT_PAGE = "customer-product.html", CHECKOUT_PAGE = "customer-checkout.html";
    var FALLBACK_IMG = "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2080%2080%22%3E%3Crect%20width=%2280%22%20height=%2280%22%20fill=%22%23eaf0ff%22/%3E%3Cg%20fill=%22none%22%20stroke=%22%239db3e8%22%20stroke-width=%223%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%3E%3Crect%20x=%2226%22%20y=%2226%22%20width=%2228%22%20height=%2236%22%20rx=%2210%22/%3E%3Cpath%20d=%22M34%2026v-5h12v5M40%2021v-5%22/%3E%3C/g%3E%3C/svg%3E";

    function read(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
    function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function clean(v, d) { return (v === null || v === undefined) ? (d || "") : (String(v).trim() || d || ""); }
    function num(v) { return (v === null || v === undefined || v === "" || isNaN(Number(v))) ? null : Number(v); }
    function money(v) { var n = Number(String(v == null ? "" : v).replace(/[^\d.]/g, "")); return isNaN(n) ? 0 : n; }
    function first() { for (var i = 0; i < arguments.length; i++) { if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== "") return arguments[i]; } return undefined; }
    function fmtK(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".0", "") + "k" : String(n); }

    /* ---------- reading a product from the API (ONE rule set for every page) ---------- */
    function normCategory(p) {
        var raw = clean(first(p.category, p.product_type, p.type, p.category_name, p.name)).toLowerCase();
        if (/access|regulator|hose|burner|stand|valve|stove/.test(raw)) return "accessory";
        if (raw.indexOf("gas") > -1 && raw.indexOf("cylinder") > -1) return "gas-cylinder";
        if (raw.indexOf("cylinder") > -1) return "cylinder";
        return "gas";
    }
    /* the type the DEALER picked when adding the product (Category / Type), shown as plain text by itself.
       Old products saved as just "gas" or "cylinder" read as "Gas" / "Cylinder". */
    function normTypeLabel(p) {
        var raw = clean(first(p.category, p.product_type, p.type, p.category_name));
        if (!raw) return "";
        return raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/(^|\s)([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
    }
    /* the gas weight, always written the same way: "13 KG" */
    function normSize(p) {
        var v = clean(first(p.size, p.cylinder_size, p.cylinderSize, p.weight, p.weight_kg, p.gas_weight, p.cylinder_weight, p.weightKg));
        if (!v) { var m = clean(first(p.name, p.title, p.product_name)).match(/(\d+(?:\.\d+)?)\s*kg/i); if (m) v = m[1]; }
        if (!v) return "";
        if (!isNaN(Number(v))) return v + " KG";
        return v.replace(/kilograms?/gi, "KG").replace(/\s*kg/gi, " KG").replace(/\s+/g, " ").trim();
    }
    function normAvailability(p) {
        var left = num(first(p.stock_quantity, p.stock));
        if (left !== null && left <= 0) return "Unavailable";
        var raw = clean(first(p.availability, p.status, p.stock_status)).toLowerCase();
        if (["available", "in stock", "instock", "true", "1"].indexOf(raw) > -1) return "Available";
        if (["unavailable", "out of stock", "outofstock", "false", "0"].indexOf(raw) > -1) return "Unavailable";
        if (p.stock !== undefined && p.stock !== null) return Number(p.stock) > 0 ? "Available" : "Unavailable";
        return "Available";
    }
    /* verified only while the admin's verification is active (the server already checks the expiry:
       dealer_is_verified). Same rule as the dealer pages. */
    function isVerified(p, d) {
        var v = first(p.dealer_is_verified, p.dealer_verification_active, p.dealer_verified, d.verification_active, d.is_verified, d.verified);
        if (typeof v === "string") v = ["1", "true", "yes", "verified", "approved"].indexOf(v.toLowerCase()) > -1;
        if (!v) return false;
        var exp = first(p.dealer_verification_expires_at, d.verification_expires_at);
        if (exp) { var t = new Date(exp); if (!isNaN(t.getTime()) && t <= new Date()) return false; }
        return true;
    }
    var BADGE = '<span class="vbadge" title="Verified by GasHub" role="img" aria-label="Verified by GasHub"><svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path fill="#1d7af3" d="M12 1.8l2.6 1.9 3.2-.2 1.1 3 2.7 1.8-1 3.1 1 3.1-2.7 1.8-1.1 3-3.2-.2-2.6 1.9-2.6-1.9-3.2.2-1.1-3-2.7-1.8 1-3.1-1-3.1 2.7-1.8 1.1-3 3.2.2z"/>' +
        '<path fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M7.8 12.2l3 3 5.6-6"/></svg></span>';

    function normalize(p, i) {
        i = i || 0;
        var d = p.dealer && typeof p.dealer === "object" ? p.dealer : {};
        var price = money(first(p.price, p.selling_price, p.amount));
        var rawRating = num(first(p.dealer_rating, p.rating, p.average_rating, d.rating));
        return {
            id: String(first(p.id, p.product_id, "product-" + (i + 1))),
            name: clean(first(p.name, p.title, p.product_name), "Gas product"),
            brand: clean(first(p.brand, p.brand_name, p.gas_brand, p.manufacturer)),
            category: normCategory(p),
            typeLabel: normTypeLabel(p),
            size: normSize(p),
            price: isNaN(price) ? 0 : price,
            dealer: clean(first(p.dealer_business_name, p.business_name, p.dealer_name, p.dealerName, d.business_name, d.name,
                (typeof p.dealer === "string" ? p.dealer : ""), p.supplier), "GasHub Dealer"),
            dealerId: clean(first(p.dealerId, p.dealer_id, d.id), ""),
            dealerVerified: isVerified(p, d),
            rating: rawRating > 0 ? rawRating : null,
            lat: num(first(p.latitude, p.lat, p.dealer_latitude, p.dealer_lat, d.latitude)),
            lng: num(first(p.longitude, p.lng, p.lon, p.dealer_longitude, p.dealer_lng, d.longitude)),
            km: num(first(p.distance_km, p.distance)),
            eta: num(first(p.eta_minutes, p.delivery_minutes)),
            availability: normAvailability(p),
            image: clean(first(p.image, p.image_url, p.imageUrl, p.photo, p.photo_url, p.product_image, p.product_photo, p.product_image_url, p.image_path)),
            sold: Number(first(p.sold, p.total_sold, p.orders_count, 0)) || 0,
            followers: Number(first(p.dealer_follower_count, p.follower_count, d.follower_count, 0)) || 0,
            views: num(first(p.view_count, p.views_count, p.total_views, p.product_views, p.views))
        };
    }

    /* The server already sends whether each dealer is verified (dealer_is_verified), so nothing has to be fetched.
       Home and Products call this after loading; it only fills a blue tick that is still missing.
       It must never throw: if it did, the product list would not show at all. */
    var verifiedCache = null;
    async function enrichVerified(items) {
        try {
            if (!Array.isArray(items) || !items.some(function (p) { return !p.dealerVerified && p.dealerId; })) return items;
            if (!verifiedCache) {
                var r = await fetch("/api/dealers", { headers: { Accept: "application/json" } });
                var j = r.ok ? await r.json() : [];
                var list = Array.isArray(j) ? j : j.dealers || j.data || [];
                verifiedCache = {};
                list.forEach(function (d) { verifiedCache[String(d.id != null ? d.id : d.dealer_id)] = isVerified({}, d); });
            }
            items.forEach(function (p) { if (verifiedCache[p.dealerId]) p.dealerVerified = true; });
        } catch (e) { /* keep the ticks the products already have */ }
        return items;
    }

    var isAvail = function (p) { return String(p.availability).toLowerCase() === "available"; };
    var formatPrice = function (n) { return "KSh " + (Number(n) || 0).toLocaleString("en-KE"); };
    var dealerHref = function (p) { return p.dealerId ? DEALER_PAGE + "?id=" + encodeURIComponent(p.dealerId) : DEALER_PAGE; };
    var productHref = function (p) { return PRODUCT_PAGE + "?id=" + encodeURIComponent(p.id); };

    /* ---------- views and bought: the numbers every card shows ---------- */
    /* The server count wins. Without one, the views this browser recorded are used. */
    function viewsOf(p) {
        if (p.views != null) return Math.max(0, p.views);
        var n = 0, id = String(p.id);
        var list = read("gasHubViews");
        if (Array.isArray(list)) {
            list.forEach(function (v) { if (String(v.id != null && v.id !== "" ? v.id : v.name) === id) n = Math.max(n, Number(v.n) || 1); });
        }
        var local = read("gasHubProductLocalViews");
        if (local && typeof local === "object") n = Math.max(n, Number(local[id]) || 0);
        return n;
    }
    function soldOf(p) { return Math.max(0, Number(p.sold) || 0); }

    /* ---------- distance to the customer's pin ---------- */
    function distanceKm(p) {
        var loc = read(LOC_KEY);
        if (loc && p.lat != null && p.lng != null) {
            var R = 6371, r = function (x) { return x * Math.PI / 180; };
            var dLat = r(p.lat - loc.latitude), dLng = r(p.lng - loc.longitude);
            var a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(r(loc.latitude)) * Math.cos(r(p.lat)) * Math.pow(Math.sin(dLng / 2), 2);
            return 2 * R * Math.asin(Math.sqrt(a));
        }
        return p.km;
    }
    var fmtKm = function (km) { return Math.max(0.1, km).toFixed(1) + " km"; };
    function etaMinutes(p, km) { return p.eta != null ? Math.round(p.eta) : Math.max(5, Math.round(km * 3 + 2)); }
    function fmtEta(min) { return min >= 60 ? Math.floor(min / 60) + " hr" + (min % 60 ? " " + (min % 60) + " min" : "") : min + " min"; }


    /* ---------- ranking: the order every product list uses ----------
       Dealers that are close to the customer, well rated and well followed come first.
       score = 40% closeness + 35% rating + 25% followers (followers are compared with the most followed dealer on the list). */
    function rankProducts(list) {
        var maxF = 0;
        list.forEach(function (p) { maxF = Math.max(maxF, p.followers || 0); });
        var scored = list.map(function (p) {
            var km = distanceKm(p);
            var near = km == null ? 0.3 : 1 / (1 + km / 5);               /* 0 km = 1, 5 km = .5, 20 km = .2; unknown distance ranks low */
            var rate = p.rating == null ? 0 : Math.max(0, Math.min(5, p.rating)) / 5;
            var fol = maxF > 0 ? Math.log(1 + (p.followers || 0)) / Math.log(1 + maxF) : 0;
            return { p: p, s: 0.4 * near + 0.35 * rate + 0.25 * fol };
        });
        scored.sort(function (a, b) { return (b.s - a.s) || ((b.p.followers || 0) - (a.p.followers || 0)); });
        return scored.map(function (x) { return x.p; });
    }

    /* ---------- favourites ---------- */
    function getFavs() { return new Set((read(FAV_KEY) || []).map(String)); }
    function toggleFav(id) {
        var f = getFavs(); id = String(id);
        if (f.has(id)) f.delete(id); else f.add(id);
        write(FAV_KEY, Array.from(f));
        return f.has(id);
    }

    /* ---------- icons + no-photo picture ---------- */
    var HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5 6.4 5c2 0 3.5 1.1 4.3 2.5h.6C12.1 6.1 13.6 5 15.6 5 19 5 20.8 8.6 21.5 11.8 19.5 16.4 12 21 12 21z"/></svg>';
    var CART = '<svg viewBox="0 0 24 24"><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 7H6"/></svg>';
    var PIN = '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';
    var CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

    function phHTML(cat) {
        return cat === "accessory"
            ? '<div class="gph-art"><svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="42" r="26" fill="#1f4fd8"/><circle cx="40" cy="42" r="17" fill="#eaf0ff"/><path d="M40 42l9-9" stroke="#e03131" stroke-width="3" stroke-linecap="round"/><rect x="34" y="8" width="12" height="12" rx="3" fill="#444"/></svg></div>'
            : '<div class="gph-art"><svg viewBox="0 0 60 90" aria-hidden="true"><rect x="22" y="2" width="16" height="10" rx="3" fill="#444"/><rect x="26" y="10" width="8" height="6" fill="#666"/><rect x="8" y="14" width="44" height="72" rx="16" fill="#e03131"/><rect x="8" y="14" width="14" height="72" rx="10" fill="#b02323" opacity=".45"/><text x="30" y="56" text-anchor="middle" font-family="Arial" font-weight="800" font-size="15" fill="#ffc20e">GAS</text></svg></div>';
    }
    function swapPh(img) { img.insertAdjacentHTML("afterend", phHTML(img.dataset.cat)); img.remove(); }
    /* call once on a container: a photo that fails to load is replaced by the picture above */
    function watchImages(container) {
        if (!container || container._gasWatch) return;
        container._gasWatch = true;
        container.addEventListener("error", function (e) { if (e.target.tagName === "IMG" && e.target.dataset.cat) swapPh(e.target); }, true);
    }

    /* ---------- THE product card ---------- */
    /* opts.tag      [label, cssClass] ranking badge (belt only), e.g. ["Most bought","bought"]
       opts.viewHref link for the View button; leave out and View becomes a button (data-act="view")
       opts.locButton true: "Set your location" is a button (home page opens its map); false: a link to the home page */
    function cardHTML(p, favs, opts) {
        opts = opts || {};
        var ok = isAvail(p), fav = favs.has(p.id), tag = opts.tag;
        var badge = !ok ? '<span class="gbadge out">Out of stock</span>'
            : tag ? '<span class="gbadge ' + esc(tag[1]) + '">' + esc(tag[0]) + '</span>' : "";

        var km = distanceKm(p), meta;
        if (km == null) meta = opts.locButton === false
            ? '<a class="setloc" href="customer-home.html">Set your location to see distance</a>'
            : '<button type="button" class="setloc">Set your location to see distance</button>';
        else meta = '<span class="gmeta-i dist">' + PIN + fmtKm(km) + '</span><span class="gmeta-i">' + CLOCK + fmtEta(etaMinutes(p, km)) + ' away</span>';

        var rating = p.rating == null ? '<span class="grating">New</span>'
            : '<span class="grating"><b aria-hidden="true">★</b>' + Math.max(0, Math.min(5, p.rating)).toFixed(1) + '</span>';

        var specs = (p.brand || p.size)
            ? '<div class="gspecs">' + (p.brand ? '<span class="gbrand">' + esc(p.brand) + '</span>' : "") + (p.size ? '<span class="gweight" title="Gas weight">' + esc(p.size) + '</span>' : "") + '</div>'
            : '<div class="gspecs"></div>';

        var v = viewsOf(p), s = soldOf(p);
        var stats = fmtK(v) + " views" + (s ? " · " + fmtK(s) + " bought" : "");

        var view = opts.viewHref
            ? '<a class="gview" href="' + esc(opts.viewHref) + '" data-act="view">View</a>'
            : '<button type="button" class="gview" data-act="view">View</button>';

        return '<article class="gcard" data-id="' + esc(p.id) + '">' +
            '<div class="gphoto">' +
            (p.image ? '<img src="' + esc(p.image) + '" alt="' + esc(p.name) + '" data-cat="' + esc(p.category) + '" loading="lazy">' : phHTML(p.category)) +
            badge +
            '<button type="button" class="gfav' + (fav ? " on" : "") + '" data-act="fav" aria-pressed="' + fav + '" aria-label="' + (fav ? "Remove from favourites" : "Add to favourites") + '">' + HEART + '</button>' +
            '</div><div class="gbody">' +
            '<h3 class="gname">' + esc(p.name) + '</h3>' +
            '<div class="gtype">' + esc(p.typeLabel) + '</div>' + specs +
            '<p class="gprice">' + formatPrice(p.price) + '</p>' +
            '<div class="gdealer"><span class="gdn"><a class="glink" href="' + esc(dealerHref(p)) + '">' + esc(p.dealer) + '</a>' + (p.dealerVerified ? BADGE : "") + '</span>' + rating + '</div>' +
            '<div class="gmeta">' + meta + '</div>' +
            '<div class="gstat"><i></i>' + esc(stats) + '</div>' +
            '<div class="gactions">' + view +
            '<button type="button" class="gcart" data-act="cart" aria-label="Go to checkout" ' + (ok ? "" : "disabled") + '>' + CART + '</button></div>' +
            '</div></article>';
    }

    /* ---------- same checkout link everywhere ---------- */
    /* a long picture address (or an embedded picture) in the link makes the server answer HTTP 431 */
    function shortImage(v) {
        v = String(v == null ? "" : v);
        return v && v.length <= 300 && v.indexOf("data:") !== 0 ? v : FALLBACK_IMG;
    }
    function checkoutUrl(p) {
        var q = new URLSearchParams({
            productId: p.id, productName: p.name, details: p.size || p.brand || "",
            image: shortImage(p.image), dealer: p.dealer, dealerId: p.dealerId, quantity: "1", price: p.price
        });
        return CHECKOUT_PAGE + "?" + q.toString();
    }
    function trackView(p) {
        if (window.recordView) { try { window.recordView({ id: p.id, name: p.name, category: p.category, price: p.price, image: p.image, rating: p.rating == null ? "New" : p.rating }); } catch (e) { } }
    }

    window.GasHubProducts = {
        normalize: normalize, enrichVerified: enrichVerified, normSize: normSize, isAvail: isAvail, formatPrice: formatPrice,
        dealerHref: dealerHref, productHref: productHref, rankProducts: rankProducts, viewsOf: viewsOf, soldOf: soldOf,
        distanceKm: distanceKm, fmtKm: fmtKm, etaMinutes: etaMinutes, fmtEta: fmtEta,
        getFavs: getFavs, toggleFav: toggleFav, cardHTML: cardHTML, phHTML: phHTML, swapPh: swapPh, watchImages: watchImages,
        checkoutUrl: checkoutUrl, trackView: trackView, esc: esc, fmtK: fmtK
    };
})();
/* "The dealer replied" pop-up. Shows on every page that loads this file (home, products, dealer pages).
   Tapping it opens that product with the conversation ready to reply. Silent if the customer is not signed in. */
(function () {
    "use strict";
    if (window.__gasHubReplyPopup) return;
    window.__gasHubReplyPopup = true;

    var SEEN_KEY = "gasHubReplySeen", timer = null, stopped = false;
    var esc = function (v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
    function seen() { try { return JSON.parse(sessionStorage.getItem(SEEN_KEY) || "{}"); } catch (e) { return {}; } }
    function remember(map) { try { sessionStorage.setItem(SEEN_KEY, JSON.stringify(map)); } catch (e) { } }

    function showPopup(item) {
        var old = document.getElementById("gasHubReplyPopup"); if (old) old.remove();
        var href = item.product_id
            ? "customer-product.html?id=" + encodeURIComponent(item.product_id) + "&chat=1"
            : "customer-dealer.html?id=" + encodeURIComponent(item.dealer_id);
        var el = document.createElement("a");
        el.id = "gasHubReplyPopup"; el.href = href;
        el.setAttribute("role", "status");
        el.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;max-width:340px;width:calc(100vw - 32px);display:flex;gap:10px;align-items:center;background:#fff;color:#0f172a;text-decoration:none;border:1px solid #bfdbfe;border-left:4px solid #1d7af3;border-radius:12px;padding:10px 34px 10px 10px;box-shadow:0 10px 30px rgba(15,23,42,.22);font:13px/1.35 system-ui,sans-serif;";
        el.innerHTML =
            (item.product_image ? '<img src="' + esc(item.product_image) + '" alt="" style="width:46px;height:46px;object-fit:cover;border-radius:8px;flex:none">' : '') +
            '<div style="min-width:0"><strong style="display:block">' + esc(item.dealer_name || "A dealer") + ' replied' + (item.unread > 1 ? " (" + item.unread + ")" : "") + '</strong>' +
            (item.product_name ? '<span style="display:block;color:#1d7af3;font-size:12px">About: ' + esc(item.product_name) + '</span>' : '') +
            '<span style="display:block;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(item.last_text) + '</span>' +
            '<span style="font-size:11px;color:#64748b">Tap to open the conversation</span></div>' +
            '<button type="button" aria-label="Dismiss" style="position:absolute;top:4px;right:6px;border:0;background:none;font-size:18px;line-height:1;color:#64748b;cursor:pointer">&times;</button>';
        el.querySelector("button").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); el.remove(); });
        document.body.appendChild(el);
        setTimeout(function () { if (el.parentNode) el.remove(); }, 15000);
    }

    /* Only ask the server about this customer when this browser thinks someone is signed in; otherwise it just answers 401. */
    function signedInHint() { try { var f = localStorage.getItem("gasHubLoggedIn"); return !!f && f !== "false" && f !== "0"; } catch (e) { return true; } }
    async function check() {
        if (stopped || document.hidden || !signedInHint()) return;
        try {
            var r = await fetch("/api/messages/unread", { credentials: "same-origin", cache: "no-store" });
            if (r.status === 401) { stopped = true; clearInterval(timer); return; }   /* not signed in: stay quiet */
            if (!r.ok) return;
            var j = await r.json();
            if (!j.success || !j.items || !j.items.length) return;
            if (document.querySelector(".chat-box")) return;                           /* already chatting: that chat updates itself */
            var map = seen(), fresh = null;
            j.items.forEach(function (it) {
                var key = it.dealer_id + ":" + (it.product_id || "");
                if (!fresh && (map[key] || 0) < it.last_id) { fresh = it; }
            });
            if (fresh) { map[fresh.dealer_id + ":" + (fresh.product_id || "")] = fresh.last_id; remember(map); showPopup(fresh); }
        } catch (e) { /* try again next time */ }
    }

    function start() { if (window.__gasHubNotifier) return; /* customer-notifications.js handles replies now */ check(); timer = setInterval(check, 10000); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();