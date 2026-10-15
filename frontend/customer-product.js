/* GasHub customer products: cards, favourites, distance + delivery time,
   product details, safe dealer chat, checkout link. */

document.addEventListener("DOMContentLoaded", () => {
    "use strict";

    /* ---- settings: change the page names here if yours are different ---- */
    const API_URL = "/api/products";
    const DEALER_PAGE = "customer-dealer.html";
    const CHECKOUT_PAGE = "customer-checkout.html";
    const CHAT_API = "/api/messages";
    const FAV_KEY = "gasHubFavorites";
    const LOC_KEY = "gasHubLocation";
    const FALLBACK_IMG = "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2080%2080%22%3E%3Crect%20width=%2280%22%20height=%2280%22%20fill=%22%23eaf0ff%22/%3E%3Cg%20fill=%22none%22%20stroke=%22%239db3e8%22%20stroke-width=%223%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%3E%3Crect%20x=%2226%22%20y=%2226%22%20width=%2228%22%20height=%2236%22%20rx=%2210%22/%3E%3Cpath%20d=%22M34%2026v-5h12v5M40%2021v-5%22/%3E%3C/g%3E%3C/svg%3E";

    const $ = (s, p = document) => p.querySelector(s);
    const $$ = (s, p = document) => [...p.querySelectorAll(s)];
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));

    const store = {
        get(k) {
            try { return JSON.parse(localStorage.getItem(k)); }
            catch (e) { return null; }
        },
        set(k, v) {
            try { localStorage.setItem(k, JSON.stringify(v)); }
            catch (e) {}
        }
    };

    const els = {
        search: $("#productSearch"),
        size: $("#sizeFilter"),
        avail: $("#availabilityFilter"),
        favFilter: $("#favFilter"),
        chips: $("#typeChips"),
        count: $("#productCount"),
        reset: $("#resetFilters"),
        list: $("#productList"),
        loading: $("#productsLoading"),
        empty: $("#productsEmpty"),
        emptyTitle: $("#emptyTitle"),
        emptyMsg: $("#emptyMessage"),
        emptyReset: $("#emptyResetButton"),
        modal: $("#productModal"),
        modalBody: $("#modalBody")
    };

    const state = {
        all: [],
        shown: [],
        type: "all",
        favOnly: false,
        selected: null
    };

    /* ================= ICONS ================= */
    const HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5 6.4 5c2 0 3.5 1.1 4.3 2.5h.6C12.1 6.1 13.6 5 15.6 5 19 5 20.8 8.6 21.5 11.8 19.5 16.4 12 21 12 21z"/></svg>';
    const CART = '<svg viewBox="0 0 24 24"><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 7H6"/></svg>';
    const PIN = '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';
    const CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

    /* Picture shown when a product has no photo or the photo fails to load. */
    const phHTML = cat => cat === "accessory"
        ? `<div class="ph-art"><svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="42" r="26" fill="#1f4fd8"/><circle cx="40" cy="42" r="17" fill="#eaf0ff"/><path d="M40 42l9-9" stroke="#e03131" stroke-width="3" stroke-linecap="round"/><rect x="34" y="8" width="12" height="12" rx="3" fill="#444"/></svg></div>`
        : `<div class="ph-art"><svg viewBox="0 0 60 90" aria-hidden="true"><rect x="22" y="2" width="16" height="10" rx="3" fill="#444"/><rect x="26" y="10" width="8" height="6" fill="#666"/><rect x="8" y="14" width="44" height="72" rx="16" fill="#e03131"/><rect x="8" y="14" width="14" height="72" rx="10" fill="#b02323" opacity=".45"/><text x="30" y="56" text-anchor="middle" font-family="Arial" font-weight="800" font-size="15" fill="#ffc20e">GAS</text></svg></div>`;

    const swapPh = img => {
        img.insertAdjacentHTML("afterend", phHTML(img.dataset.cat));
        img.remove();
    };

    /* ================= NORMALIZE ================= */
    const clean = (v, d = "") =>
        (v === null || v === undefined) ? d : String(v).trim() || d;

    const money = v => {
        const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
        return isNaN(n) ? 0 : n;
    };

    const num = v =>
        (v === null || v === undefined || v === "" || isNaN(Number(v)))
            ? null : Number(v);

    /* Product rules (gas weight, price, image, rating, views, bought) are shared with the home page
       and the dealer page in customer-product-card.js, so a product always reads the same everywhere.
       Only the extra details the product window needs are added here. */
    const GP = window.GasHubProducts;

    function normOnline(p) {
        const d = p.dealer && typeof p.dealer === "object" ? p.dealer : {};
        const flag = p.online ?? p.dealer_online ?? p.is_online ??
            p.dealerOnline ?? d.online ?? d.is_online;
        const seen = p.dealer_last_seen || p.last_seen || d.last_seen || null;

        let online = flag === true || flag === 1 ||
            flag === "1" || flag === "true";

        if (!online && seen) {
            const t = new Date(seen).getTime();
            if (t && Date.now() - t < 5 * 60 * 1000) online = true;
        }

        return { online, seen };
    }

    function normalize(p, i = 0) {
        const d = p.dealer && typeof p.dealer === "object" ? p.dealer : {};
        const st = normOnline(p);

        return {
            ...GP.normalize(p, i),
            dealerLogo: clean(p.dealer_logo || p.dealerLogo || d.logo, ""),
            online: st.online,
            lastSeen: st.seen,
            location: clean(
                p.location || p.town || p.city || p.dealer_location, "Kenya"
            ),
            description: clean(
                p.description || p.details,
                "Quality gas product available through GasHub."
            )
        };
    }

    /* ================= FORMAT HELPERS (shared) ================= */
    const formatPrice = GP.formatPrice;
    const isAvail = GP.isAvail;
    const dealerHref = GP.dealerHref;

    /* Views: the same number the home page shows (server count first, then this browser's record). */
    const VIEW_KEY = "gasHubProductLocalViews";
    const localViews = () => store.get(VIEW_KEY) || {};
    const getViews = p => GP.viewsOf(p);

    /* The server keeps the count (same number for every customer, signed in or not, and it survives log out).
       The browser copy is only a fallback for when the server cannot be reached. */
    const recordProductView = p => {
        if (p.views === null || p.views === undefined) {
            const counts = localViews();
            counts[p.id] = Number(counts[p.id] || 0) + 1;
            store.set(VIEW_KEY, counts);
        }
        try {
            fetch("/api/products/" + encodeURIComponent(p.id) + "/view", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } })
                .then(r => r.ok ? r.json() : null)
                .then(d => {
                    if (!d || d.view_count == null) return;
                    p.views = Number(d.view_count);
                    if (state.selected && state.selected.id === p.id) {
                        document.querySelectorAll(".detail-row").forEach(row => {
                            const lab = row.querySelector("span");
                            if (lab && lab.textContent.trim() === "Product views") row.querySelector("strong").textContent = p.views.toLocaleString("en-KE");
                        });
                    }
                    render();
                })
                .catch(() => { });
        } catch (e) { }
    };

    const initials = s =>
        s.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();

    const dealerPic = p => p.dealerLogo
        ? `<img src="${esc(p.dealerLogo)}" alt="" loading="lazy" style="width:22px;height:22px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:6px" onerror="this.remove()">`
        : "";
    const distanceKm = GP.distanceKm;
    const fmtKm = GP.fmtKm;
    const etaMinutes = GP.etaMinutes;
    const fmtEta = GP.fmtEta;

    function metaHTML(p) {
        const km = distanceKm(p);

        if (km == null) {
            return `<a class="setloc" href="customer-home.html">Set your location to see distance</a>`;
        }

        return `<span class="pmeta-i dist">${PIN}${fmtKm(km)}</span><span class="pmeta-i">${CLOCK}${fmtEta(etaMinutes(p, km))} away</span>`;
    }

    function ratingHTML(p) {
        if (p.rating == null) return `<span class="rating">New</span>`;

        const r = Math.max(0, Math.min(5, p.rating));

        return `<span class="rating"><span class="stars" style="--r:${(r / 5 * 100).toFixed(0)}%" aria-hidden="true"></span><span class="star1" aria-hidden="true">★</span>${r.toFixed(1)}</span>`;
    }

    function statusText(p) {
        if (p.online) return "Active now";

        if (p.lastSeen) {
            const m = Math.max(
                1,
                Math.round((Date.now() - new Date(p.lastSeen).getTime()) / 60000)
            );

            if (!isNaN(m)) {
                return m < 60
                    ? `Last seen ${m} min ago`
                    : m < 1440
                        ? `Last seen ${Math.round(m / 60)} hr ago`
                        : "Offline";
            }
        }

        return "Offline";
    }

    /* ================= FAVOURITES ================= */
    const getFavs = () => new Set((store.get(FAV_KEY) || []).map(String));

    function toggleFav(id) {
        const f = getFavs();
        f.has(id) ? f.delete(id) : f.add(id);
        store.set(FAV_KEY, [...f]);
        return f.has(id);
    }

    /* ================= LOAD PRODUCTS ================= */
    async function loadProducts() {
        els.loading.hidden = false;
        els.empty.hidden = true;
        els.list.innerHTML = "";

        try {
            const r = await fetch(API_URL, {
                headers: { Accept: "application/json" }
            });

            if (!r.ok) throw new Error("Unable to load products");

            const d = await r.json();
            const list = Array.isArray(d) ? d : d.products || d.data || [];
            state.all = list.map(normalize);
            await GP.enrichVerified(state.all);   /* the blue tick follows the dealer's verified status */
        } catch (e) {
            console.error("Products API unavailable.", e);
            state.all = [];
        }

        els.loading.hidden = true;
        applyFromUrl();
        applyFilters();

        const wanted = new URLSearchParams(location.search).get("id");
        if (wanted) {
            const p = state.all.find(x => x.id === wanted);
            if (p) {
                openModal(p);
                /* arriving from the "dealer replied" pop-up: jump straight to the conversation */
                if (new URLSearchParams(location.search).get("chat")) {
                    setTimeout(() => {
                        const cb = $(".chat-box");
                        if (cb) { cb.scrollIntoView({ block: "center" }); const i = $("#chatInput"); if (i) i.focus({ preventScroll: true }); }
                    }, 250);
                }
            }
        }
    }

    /* Refresh product information quietly so stock changes appear. */
    let refreshing = false;

    async function refreshProducts() {
        if (refreshing || document.hidden) return;

        refreshing = true;

        try {
            const r = await fetch(API_URL, {
                headers: { Accept: "application/json" },
                cache: "no-store"
            });

            if (!r.ok) return;

            const d = await r.json();
            const list = Array.isArray(d) ? d : d.products || d.data || [];
            const next = list.map(normalize);
            await GP.enrichVerified(next);

            const sig = x => JSON.stringify(
                x.map(p => [p.id, p.availability, p.price, p.dealer, p.dealerVerified])
            );

            if (sig(next) !== sig(state.all)) {
                state.all = next;
                applyFilters();
            }
        } catch (e) {
            /* Keep the products already displayed. */
        } finally {
            refreshing = false;
        }
    }

    setInterval(refreshProducts, 20000);

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refreshProducts();
    });

    window.addEventListener("focus", refreshProducts);

    function applyFromUrl() {
        const q = new URLSearchParams(location.search);

        if (q.get("search")) els.search.value = q.get("search");

        const c = (q.get("category") || "").toLowerCase();

        const map = {
            cylinders: "cylinder",
            cylinder: "cylinder",
            accessories: "accessory",
            accessory: "accessory",
            gas: "gas",
            "gas-cylinder": "gas-cylinder"
        };

        if (map[c]) setType(map[c]);
    }

    /* ================= FILTER + RENDER ================= */
    function setType(t) {
        state.type = t;

        $$(".chip", els.chips).forEach(b => {
            b.classList.toggle("active", b.dataset.type === t);
        });
    }

    function applyFilters() {
        const term = clean(els.search.value).toLowerCase();
        const favs = getFavs();
        const size = els.size.value;
        const av = els.avail.value;

        state.shown = state.all.filter(p => {
            const text = [
                p.name, p.brand, p.size, p.dealer, p.location, p.description
            ].join(" ").toLowerCase();

            const sz = p.size.toLowerCase().replace(/\s/g, "");

            return (!term || text.includes(term))
                && (state.type === "all" || p.category === state.type)
                && (size === "all" || sz === size)
                && (av === "all" || (av === "available") === isAvail(p))
                && (!state.favOnly || favs.has(p.id));
        });

        /* Best dealers first: close to the customer, highly rated, most followers. */
        state.shown = GP.rankProducts(state.shown);

        render();
    }

    /* The card is the SAME one the home page belt uses (customer-product-card.js).
       Here "View" opens the product window instead of a page. */
    function cardHTML(p, favs) {
        return GP.cardHTML(p, favs, { locButton: false });
    }

    function render() {
        const n = state.shown.length;

        els.count.textContent = `${n} ${n === 1 ? "product" : "products"}`;

        if (!n) {
            els.list.innerHTML = "";
            els.empty.hidden = false;
            els.emptyTitle.textContent = state.favOnly
                ? "No favourites yet" : "No products found";

            els.emptyMsg.textContent = state.favOnly
                ? "Tap the heart on a product to save it here."
                : "We could not find products matching your search or filters.";

            return;
        }

        els.empty.hidden = true;

        const favs = getFavs();
        els.list.innerHTML = state.shown.map(p => cardHTML(p, favs)).join("");

        GP.watchImages(els.list);   /* a photo that fails to load is replaced by the gas picture */
    }

    /* Clicks on cards: favourite, view details, or checkout. */
    els.list.addEventListener("click", e => {
        const card = e.target.closest(".gcard");
        if (!card) return;

        const p = state.all.find(x => x.id === card.dataset.id);
        if (!p) return;

        const act = e.target.closest("[data-act]");

        if (e.target.closest(".glink")) return;
        if (!act) return;

        if (act.dataset.act === "fav") {
            const on = toggleFav(p.id);

            if (state.favOnly && !on) {
                applyFilters();
            } else {
                act.classList.toggle("on", on);
                act.setAttribute("aria-pressed", on);
            }
        } else if (act.dataset.act === "view") {
            openModal(p);
        } else if (act.dataset.act === "cart") {
            goToCheckout(p);
        }
    });
        /* ================= CHECKOUT ================= */
    /* a long picture address (or an embedded picture) in the link makes the server answer HTTP 431 */
    function shortImage(v) {
        v = String(v || "");
        return v && v.length <= 300 && v.indexOf("data:") !== 0 ? v : FALLBACK_IMG;
    }

    function goToCheckout(p) {
        if (!isAvail(p)) return;

        const q = new URLSearchParams({
            productId: p.id,
            productName: p.name,
            details: p.size || p.brand || "",
            image: shortImage(p.image),
            dealer: p.dealer,
            dealerId: p.dealerId,
            quantity: "1",
            price: p.price
        });

        location.href = `${CHECKOUT_PAGE}?${q.toString()}`;
    }

    /* ================= PRODUCT DETAILS MODAL ================= */
    function openModal(p) {
        state.selected = p;

        recordProductView(p);
        render();

        if (window.recordView) {
            try {
                window.recordView({
                    id: p.id,
                    name: p.name,
                    category: p.category,
                    price: p.price,
                    image: p.image,
                    rating: p.rating ?? "New"
                });
            } catch (e) {}
        }

        const km = distanceKm(p);
        const ok = isAvail(p);
        const fav = getFavs().has(p.id);

        els.modalBody.innerHTML = `
            <div class="m-photo">
                ${p.image
                    ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" data-cat="${esc(p.category)}">`
                    : phHTML(p.category)}
                <button type="button" class="fav-btn${fav ? " on" : ""}" id="mFav" aria-label="Favourite">${HEART}</button>
            </div>

            <div class="m-content">
                <h2>${esc(p.name)}</h2>
                ${p.typeLabel ? `<p class="m-type">${esc(p.typeLabel)}</p>` : ""}
                ${p.brand ? `<p class="m-brand">${esc(p.brand)}</p>` : ""}
                <p class="m-price">${formatPrice(p.price)}</p>

                <div class="m-dealer">
                    ${dealerPic(p)}<a class="dealer-link" href="${esc(dealerHref(p))}">${esc(p.dealer)}</a>${p.dealerVerified ? '<span class="vbadge" title="Verified by GasHub" role="img" aria-label="Verified by GasHub" style="display:inline-flex;flex:none;width:16px;height:16px;margin-left:-3px;vertical-align:middle"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#1d7af3" d="M12 1.8l2.6 1.9 3.2-.2 1.1 3 2.7 1.8-1 3.1 1 3.1-2.7 1.8-1.1 3-3.2-.2-2.6 1.9-2.6-1.9-3.2.2-1.1-3-2.7-1.8 1-3.1-1-3.1 2.7-1.8 1.1-3 3.2.2z"/><path fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M7.8 12.2l3 3 5.6-6"/></svg></span>' : ""}${ratingHTML(p)}
                </div>

                <div class="m-meta pmeta">${metaHTML(p)}</div>

                <h3 class="m-desc-title">About this item</h3>
                <p class="m-desc">${esc(p.description)}</p>

                <div class="m-details">
                    ${p.size ? `<div class="detail-row"><span>Size</span><strong>${esc(p.size)}</strong></div>` : ""}
                    ${p.brand ? `<div class="detail-row"><span>Brand</span><strong>${esc(p.brand)}</strong></div>` : ""}
                    <div class="detail-row"><span>Product views</span><strong>${getViews(p).toLocaleString("en-KE")}</strong></div>
                    <div class="detail-row"><span>Dealer location</span><strong>${esc(p.location)}</strong></div>
                    <div class="detail-row"><span>Availability</span><strong>${esc(p.availability)}</strong></div>
                    ${km != null ? `<div class="detail-row"><span>Delivery</span><strong>${fmtKm(km)} · about ${fmtEta(etaMinutes(p, km))}</strong></div>` : ""}
                </div>

                <button type="button" class="order-main" id="mOrder" ${ok ? "" : "disabled"}>${CART}${ok ? "Order now" : "Currently unavailable"}</button>

                <div class="chat-box">
                    <div class="chat-top">
                        <div class="chat-avatar"${p.dealerLogo ? ' style="padding:0;overflow:hidden"' : ""}>${p.dealerLogo
                            ? `<img src="${esc(p.dealerLogo)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block" onerror="this.replaceWith(document.createTextNode('${esc(initials(p.dealer))}'))">`
                            : esc(initials(p.dealer))}</div>

                        <div class="chat-who">
                            <a href="${esc(dealerHref(p))}">${esc(p.dealer)}</a>
                            <div class="chat-status${p.online ? " on" : ""}"><i></i>${esc(statusText(p))}</div>
                        </div>
                    </div>

                    <div class="chat-msgs" id="chatMsgs"></div>

                    <div class="chat-chips" id="chatChips">
                        <button type="button">Is this available?</button>
                        <button type="button">Can you deliver today?</button>
                        <button type="button">Is the cylinder included?</button>
                    </div>

                    <div class="chat-warn" id="chatWarn" hidden></div>

                    <form class="chat-form" id="chatForm" autocomplete="off">
                        <input id="chatInput" placeholder="Ask about this product..." maxlength="300" aria-label="Message the dealer">
                        <button type="submit">Send</button>
                    </form>

                </div>
            </div>`;

        const img = $(".m-photo img[data-cat]", els.modalBody);

        if (img) {
            img.addEventListener("error", () => swapPh(img), { once: true });
        }

        $("#mFav").addEventListener("click", e => {
            const on = toggleFav(p.id);
            e.currentTarget.classList.toggle("on", on);

            if (state.favOnly) applyFilters();
            else render();
        });

        $("#mOrder").addEventListener("click", () => goToCheckout(p));

        setupChat(p);

        els.modal.hidden = false;
        document.body.classList.add("lock");
        $(".modal-card", els.modal).scrollTop = 0;
    }

    function closeModal() {
        els.modal.hidden = true;
        document.body.classList.remove("lock");
        state.selected = null;

        if (new URLSearchParams(location.search).get("id")) {
            history.replaceState(null, "", location.pathname);
        }
    }

    $("#modalClose").addEventListener("click", closeModal);
    $("#modalOverlay").addEventListener("click", closeModal);

    /* ================= DEALER CHAT: PRODUCT QUESTIONS ONLY ================= */
    const WORDS = "zero|oh|one|two|three|four|five|six|seven|eight|nine|sifuri|moja|mbili|tatu|nne|tano|sita|saba|nane|tisa";

    const BLOCK_RULES = [
        /(?:\+?\d[\s().\-\_*]*){7,}/,
        new RegExp(`\\b(?:(?:${WORDS})[\\s,.\\-]+){5,}(?:${WORDS})\\b`),
        /\S+@\S+/,
        /\b(gmail|yahoo|hotmail|outlook)\b/,
        /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|co\.ke|ke|net|org|io)\b)/,
        /(^|\s)@\w{3,}/,
        /(whats\s?app|whatsap|wasap|wa\.me|telegram|signal app|call me|text me|sms me|my number|my phone|my contact|number yangu|nipigie|nitext|dm me|inbox me|outside (the )?app|off (the )?app|pay me directly|direct payment|send money to)/
    ];

    const hasContactInfo = t => {
        const s = t.toLowerCase();
        return BLOCK_RULES.some(re => re.test(s));
    };

    const chatKey = p => `gasHubChat:${p.dealerId || p.dealer}:${p.id}`;

    const hhmm = iso => {
        try {
            return new Date(iso).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit"
            });
        } catch (e) {
            return "";
        }
    };

    function setupChat(p) {
        const box = $("#chatMsgs");
        const form = $("#chatForm");
        const input = $("#chatInput");
        const warn = $("#chatWarn");
        let history = [];
        let failed = [];      /* messages that were blocked: shown to the sender only, never sent */
        let timer = null;
        const mergeFailed = (server, failed) => { const out = []; for (let i = 0; i <= server.length; i++) { failed.forEach(f => { if (f.after === i || (i === server.length && f.after > server.length)) out.push(f); }); if (i < server.length) out.push(server[i]); } return out; };
        const allMsgs = () => mergeFailed(history, failed);
        const addFailed = (text, reason) => { failed.push({ from: "me", text, t: new Date().toISOString(), failed: true, after: history.length, reason, open: false, fid: failed.length }); paint(); box.scrollTop = box.scrollHeight; };
        box.addEventListener("click", e => { const b = e.target.closest(".failed-why"); if (!b) return; const f = failed[Number(b.dataset.i)]; if (f) { f.open = !f.open; paint(); } });

        const showWarn = html => { warn.hidden = false; warn.innerHTML = html; };

        const paint = () => {
            const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
            const card = `<div style="display:flex;gap:10px;align-items:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px;margin-bottom:8px;">${p.image ? `<img src="${esc(p.image)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:8px;flex:none">` : ""}<div style="min-width:0"><strong style="font-size:13px">${esc(p.name)}</strong><div style="font-size:12px;color:#64748b">${esc([p.size, formatPrice(p.price)].filter(Boolean).join(" · "))}</div></div></div>`;
            box.innerHTML = card +
                `<div class="bubble sys">You are chatting with ${esc(p.dealer)} about ${esc(p.name)}. ${p.online ? "" : "The dealer is offline and will reply when back. "}Keep it about the product.</div>` +
                allMsgs().map(m => m.failed
                    ? `<div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;align-self:flex-end;max-width:100%"><button type="button" class="failed-why" data-i="${m.fid}" aria-label="Why was this not sent?" title="Not sent. Tap to see why" style="border:0;background:none;padding:0;cursor:pointer;line-height:0;flex:none"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#dc2626"/><path d="M6.5 17.5l11-11" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="12" r="6.2" fill="none" stroke="#fff" stroke-width="2"/></svg></button><div class="bubble me" style="opacity:.75;margin:0">${esc(m.text)}<small>Not sent</small></div></div>${m.open ? `<div style="align-self:flex-end;max-width:90%;margin:-2px 0 4px;font-size:12px;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:6px 8px">${esc(m.reason)}</div>` : ""}`
                    : `<div class="bubble ${m.from === "me" ? "me" : "dealer"}">${esc(m.text)}<small>${esc(hhmm(m.t))}</small></div>`
                ).join("");
            if (atBottom) box.scrollTop = box.scrollHeight;
        };

        const csrf = async () => {
            const r = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
            return ((await r.json()) || {}).csrfToken || "";
        };

        const threadUrl = () =>
            `${CHAT_API}?dealer_id=${encodeURIComponent(p.dealerId || "")}&product_id=${encodeURIComponent(p.id || "")}`;

        /* Loads the saved conversation, including any reply from the dealer. */
        const load = async () => {
            if (!p.dealerId) return;
            try {
                const r = await fetch(threadUrl(), { credentials: "same-origin", cache: "no-store" });
                if (r.status === 401) return;                 /* not signed in yet: nothing to load */
                const j = await r.json();
                if (!j.success) return;
                const next = (j.messages || []).map(m => ({ from: m.from === "customer" ? "me" : "dealer", text: m.text, t: m.t }));
                if (next.length !== history.length) { history = next; paint(); }
            } catch (e) { /* try again on the next poll */ }
        };

        const send = async text => {
            text = text.trim();
            if (!text) return false;

            if (hasContactInfo(text)) {
                addFailed(text, "This message appears to go against the user agreement.");
                return true;
            }
            if (!p.dealerId) {
                showWarn("This product has no dealer to message yet.");
                return false;
            }

            warn.hidden = true;
            try {
                const r = await fetch(CHAT_API, {
                    method: "POST",
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json", "X-CSRF-Token": await csrf() },
                    body: JSON.stringify({ dealer_id: p.dealerId, product_id: p.id, message: text })
                });
                const j = await r.json().catch(() => ({}));
                if (r.status === 401) {
                    showWarn('Please <a href="customer-login.html">sign in</a> to message the dealer.');
                    return false;
                }
                if (j.code === "blocked") { addFailed(text, j.message); return true; }
                if (!r.ok || !j.success) {
                    showWarn(esc(j.message || "Your message could not be sent. Please try again."));
                    return false;
                }
                history.push({ from: "me", text, t: j.message?.t || new Date().toISOString() });
                paint();
                box.scrollTop = box.scrollHeight;
                return true;
            } catch (e) {
                showWarn("Your message could not be sent. Check your connection and try again.");
                return false;
            }
        };

        form.addEventListener("submit", async e => {
            e.preventDefault();
            const t = input.value;
            if (!t.trim()) return;

            if (await send(t)) input.value = "";
        });

        input.addEventListener("input", () => {
            warn.hidden = true;
        });

        $$("#chatChips button").forEach(b => {
            b.addEventListener("click", () => send(b.textContent));
        });

        paint();
        load();

        /* Keeps checking for the dealer's reply while this product window is open. */
        clearInterval(window.__gasHubChatTimer);
        window.__gasHubChatTimer = timer = setInterval(() => {
            if (!document.body.contains(box)) { clearInterval(timer); return; }
            load();
        }, 6000);
    }

        /* ================= FILTER EVENTS ================= */
    els.search.addEventListener("input", applyFilters);
    els.size.addEventListener("change", applyFilters);
    els.avail.addEventListener("change", applyFilters);

    els.chips.addEventListener("click", e => {
        const b = e.target.closest(".chip");

        if (b) {
            setType(b.dataset.type);
            applyFilters();
        }
    });

    els.favFilter.addEventListener("click", () => {
        state.favOnly = !state.favOnly;
        els.favFilter.setAttribute("aria-pressed", String(state.favOnly));
        applyFilters();
    });

    function clearFilters() {
        els.search.value = "";
        els.size.value = "all";
        els.avail.value = "all";

        state.favOnly = false;
        els.favFilter.setAttribute("aria-pressed", "false");

        setType("all");
        applyFilters();
    }

    els.reset.addEventListener("click", clearFilters);
    els.emptyReset.addEventListener("click", clearFilters);

    /* ================= MOBILE MENU + LOCATION LABEL ================= */
    const menu = $("#mobileMenu");
    const scrim = $("#menuOverlay");

    const openMenu = () => {
        menu.classList.add("active");
        scrim.classList.add("show");
        menu.setAttribute("aria-hidden", "false");
    };

    const closeMenu = () => {
        menu.classList.remove("active");
        scrim.classList.remove("show");
        menu.setAttribute("aria-hidden", "true");
    };

    $("#menuBtn").addEventListener("click", openMenu);
    $("#closeMenuBtn").addEventListener("click", closeMenu);
    scrim.addEventListener("click", closeMenu);

    document.addEventListener("keydown", e => {
        if (e.key === "Escape") {
            closeMenu();
            if (!els.modal.hidden) closeModal();
        }
    });

    const loc = store.get(LOC_KEY);

    if (loc) {
        $("#customerLocation").textContent = loc.label ||
            `Pinned (${Number(loc.latitude).toFixed(3)}, ${Number(loc.longitude).toFixed(3)})`;
    }

    loadProducts();
});