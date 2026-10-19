
/* GasHub customer home: one self-contained script (menu, location, search,
   most-bought belt, dealers, floating AI assistant). */
"use strict";

const API_BASE = "/api";
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { localStorage.setItem(k, JSON.stringify(v)); } };

/* ---------- MENU ---------- */
const menu = $("#mobileMenu"), scrim = $("#menuOverlay");
const openMenu = () => { menu.classList.add("active"); scrim.classList.add("show"); menu.setAttribute("aria-hidden", "false"); };
const closeMenu = () => { menu.classList.remove("active"); scrim.classList.remove("show"); menu.setAttribute("aria-hidden", "true"); };
$("#menuBtn").addEventListener("click", openMenu);
$("#closeMenuBtn").addEventListener("click", closeMenu);
scrim.addEventListener("click", closeMenu);

/* ---------- CUSTOMER ---------- */
function showCustomer() {
    let c = null;
    for (const k of ["customer", "user", "customerData", "currentUser"]) {
        c = store.get(k);
        if (c) break;
    }
    if (!c) return;

    const name = c.name || c.full_name || c.fullName ||
        `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Customer";

    $("#hello").textContent = `Hello, ${name.split(" ")[0]} 👋`;
    $("#menuCustomerName").textContent = name;
    $("#avatar").textContent = name[0].toUpperCase();
}

$("#logoutLink").addEventListener("click", e => {
    e.preventDefault();
    if (window.gasHubAskLogout) window.gasHubAskLogout();
    else if (confirm("Are you sure you want to log out?")) { if (window.gasHubLogout) window.gasHubLogout(); else location.href = "customer-login.html?logged_out=1"; }
});

$("#helpLink").addEventListener("click", e => {
    e.preventDefault();
    closeMenu();
    openChat();
});

/* ---------- SEARCH ---------- */
$("#customerSearchForm").addEventListener("submit", e => {
    e.preventDefault();

    const q = $("#customerSearch").value.trim();
    if (!q) return $("#customerSearch").focus();

    location.href = `customer-product.html?search=${encodeURIComponent(q)}`;
});

/* ---------- LOCATION ---------- */
const modal = $("#locationModal");
const pad = $("#pinPad");
const pinMark = $("#pinMark");
const status = $("#locationStatus");
const confirmBtn = $("#confirmLocationBtn");

let picked = null;

const NAIROBI = { lat: -1.2864, lng: 36.8172 };

function setPick(lat, lng, label, px, py) {
    picked = { latitude: lat, longitude: lng };
    status.textContent = label;
    confirmBtn.disabled = false;
    pad.classList.add("has");
    pinMark.style.left = (px ?? 50) + "%";
    pinMark.style.top = (py ?? 55) + "%";
}

const openLoc = () => {
    modal.classList.add("active");
    modal.setAttribute("aria-hidden", "false");
};

const closeLoc = () => {
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
};

$("#locationBtn").addEventListener("click", openLoc);
$("#closeLocationModal").addEventListener("click", closeLoc);

modal.addEventListener("click", e => {
    if (e.target === modal) closeLoc();
});

pad.addEventListener("click", e => {
    const r = pad.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;

    const lat = NAIROBI.lat + (0.5 - y) * 0.08;
    const lng = NAIROBI.lng + (x - 0.5) * 0.08;

    setPick(lat, lng, "Pin placed. Confirm to save.", x * 100, y * 100);
});

$("#useCurrentLocationBtn").addEventListener("click", () => {
    if (!navigator.geolocation) {
        status.textContent = "Location is not supported on this device.";
        return;
    }

    status.textContent = "Waiting for permission...";

    navigator.geolocation.getCurrentPosition(
        p => setPick(
            p.coords.latitude,
            p.coords.longitude,
            "Current location found. Confirm to save.",
            50,
            55
        ),
        () => {
            status.textContent = "Location blocked. Allow access or tap the map to drop a pin.";
        },
        { enableHighAccuracy: true, timeout: 15000 }
    );
});

confirmBtn.addEventListener("click", () => {
    if (!picked) return;

    store.set("gasHubLocation", {
        ...picked,
        savedAt: new Date().toISOString()
    });

    showLocation();
    closeLoc();
});

function showLocation() {
    const s = store.get("gasHubLocation");

    if (s) {
        $("#customerLocation").textContent =
            `Pinned (${s.latitude.toFixed(3)}, ${s.longitude.toFixed(3)})`;
    }
}

/* ---------- PURCHASE HISTORY ---------- */
const HKEY = "gasHubPurchases";

/* Call from checkout after a paid order:
   recordPurchase([{id: 2, name: "13kg Cooking Gas", qty: 1}])
*/
window.recordPurchase = items => {
    const h = store.get(HKEY) || [];

    items.forEach(i => h.push({
        id: i.id,
        name: i.name,
        qty: i.qty || 1,
        date: new Date().toISOString()
    }));

    store.set(HKEY, h.slice(-300));
};

async function purchaseCounts() {
    const counts = {};

    const add = (id, name, q) => {
        const k = String(id ?? name);
        counts[k] = counts[k] || { n: 0, name };
        counts[k].n += Number(q) || 1;
    };

    try {
        const t = localStorage.getItem("token") ||
            localStorage.getItem("customerToken") ||
            localStorage.getItem("authToken");

        const r = await fetch(`${API_BASE}/orders`, {
            headers: t ? { Authorization: `Bearer ${t}` } : {}
        });

        if (r.ok) {
            const d = await r.json();

            (Array.isArray(d) ? d : d.orders || d.data || [])
                .forEach(o => (o.items || o.products || []).forEach(i =>
                    add(
                        i.product_id ?? i.id,
                        i.name || i.product_name,
                        i.quantity ?? i.qty
                    )
                ));
        }
    } catch {
        /* Use local history if order history is unavailable. */
    }

    if (!Object.keys(counts).length) {
        (store.get(HKEY) || []).forEach(h => add(h.id, h.name, h.qty));
    }

    return counts;
}

/* ---------- MOST BOUGHT BELT: REAL PRODUCTS ONLY ---------- */

const pName = p => p.name || p.title || p.product_name || "Gas product";

async function loadProducts() {
    const container = $("#popularProducts");

    container.innerHTML =
        '<p class="empty-state">Loading available products…</p>';

    let list = [];

    try {
        const response = await fetch(`${API_BASE}/products`);

        if (!response.ok) {
            throw new Error("Unable to load products");
        }

        const data = await response.json();

        list = Array.isArray(data)
            ? data
            : data.products || data.data || [];

        if (!Array.isArray(list)) {
            list = [];
        }
    } catch (error) {
        console.error("Unable to load products:", error);

        container.innerHTML =
            '<p class="empty-state">Products are temporarily unavailable. Please try again later.</p>';

        return;
    }

    // Do not display example or hardcoded products.
    if (list.length === 0) {
        container.innerHTML =
            '<p class="empty-state">No products are available yet. Please check back soon.</p>';

        return;
    }

    // Preserve purchase-based ranking.
    const counts = await purchaseCounts();

    const mine = p =>
        (counts[String(p.id ?? p.product_id)] ||
            counts[pName(p)] ||
            { n: 0 }).n;

    const sold = p =>
        Number(p.sold ?? p.total_sold ?? p.orders_count ?? 0);

    const ranked = list.slice().sort((a, b) =>
        mine(b) - mine(a) ||
        sold(b) - sold(a) ||
        Number(b.rating ?? 0) - Number(a.rating ?? 0)
    );


    container.innerHTML = ranked.slice(0, 12).map((p, i) => {
        const n = mine(p);
        const img = p.image_url || p.image || p.photo_url || "";
        const cat = p.category || p.product_category || "Gas";
        const acc = /access/i.test(cat);
        const price = Number(p.price ?? p.selling_price ?? 0);

        const badge = n
            ? `<span class="pbadge mine">Bought ${n}×</span>`
            : i === 0
                ? '<span class="pbadge">Most bought</span>'
                : "";

        return `
            <a class="pcard"
               href="customer-product.html?id=${encodeURIComponent(p.id ?? p.product_id ?? "")}">
                <div class="pimg">
                    ${badge}
                    ${img
                        ? `<img src="${esc(img)}" alt="${esc(pName(p))}" loading="lazy">`
                        : `<div class="gas${acc ? " acc" : ""}">${acc ? "" : "GAS"}</div>`
                    }
                </div>

                <div class="pinfo">
                    <span class="pcat">${esc(cat)}</span>
                    <h3>${esc(pName(p))}</h3>

                    <div class="prow">
                        <b>KSh ${price.toLocaleString()}</b>
                        <span>★ ${esc(p.rating ?? "New")}</span>
                    </div>

                    <div class="psold">
                        <i></i>
                        ${sold(p) ? sold(p) + "+ bought" : "Available from dealers"}
                    </div>
                </div>
            </a>
        `;
    }).join("");

    // Preserve the original belt scrolling and navigation logic.
    startBelt(container);
}

function startBelt(belt) {
    let pos = 0, dir = 1, paused = false, t;

    const hold = ms => {
        paused = true;
        clearTimeout(t);
        t = setTimeout(() => paused = false, ms);
    };

    ["pointerdown", "touchstart", "wheel", "mouseenter"].forEach(e =>
        belt.addEventListener(e, () => hold(4000), { passive: true })
    );

    belt.addEventListener("mouseleave", () => hold(800));

    $$(".belt-btn").forEach(b =>
        b.addEventListener("click", () => {
            hold(5000);

            belt.scrollBy({
                left: (b.classList.contains("next") ? 1 : -1) *
                    belt.clientWidth * 0.8,
                behavior: "smooth"
            });
        })
    );

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    (function tick() {
        const max = belt.scrollWidth - belt.clientWidth;

        if (paused || max <= 0) {
            pos = belt.scrollLeft;
        } else {
            pos += dir * 0.6;

            if (pos >= max) dir = -1;
            else if (pos <= 0) dir = 1;

            belt.scrollLeft = pos;
        }

        requestAnimationFrame(tick);
    })();
}

/* ---------- DEALERS: ONLY BACKEND RECORDS ---------- */
async function loadDealers() {
    const container = $("#featuredDealers");

    container.innerHTML =
        '<p class="empty-state">Loading available dealers…</p>';

    let list = [];

    try {
        const response = await fetch(`${API_BASE}/dealers`);

        if (!response.ok) {
            throw new Error("Unable to load dealers");
        }

        const data = await response.json();

        list = Array.isArray(data)
            ? data
            : data.dealers || data.data || [];

        if (!Array.isArray(list)) {
            list = [];
        }
    } catch (error) {
        console.error("Unable to load dealers:", error);

        container.innerHTML =
            '<p class="empty-state">Dealers are temporarily unavailable. Please try again later.</p>';

        return;
    }

    if (!list.length) {
        container.innerHTML =
            '<p class="empty-state">No dealers are listed yet. Check back soon, or <a href="dealer-application.html">apply to become a dealer</a>.</p>';

        return;
    }

    container.innerHTML = list.slice(0, 6).map(d => {
        const name = d.name || d.business_name || d.dealer_name || "Dealer";
        const logo = d.logo || d.logo_url || "";

        return `
            <a class="dcard"
               href="customer-dealer.html?id=${encodeURIComponent(d.id ?? d.dealer_id ?? "")}">
                <div class="dlogo">
                    ${logo
                        ? `<img src="${esc(logo)}" alt="">`
                        : esc(name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase())
                    }
                </div>

                <div class="dbody">
                    <h3>${esc(name)}${d.verified ? "<em>✓</em>" : ""}</h3>
                    <p>
                        ${esc(d.location || d.address || d.city || "Kenya")}
                        · ★ ${esc(d.rating ?? d.average_rating ?? "New")}
                        ${d.orders ? " · " + esc(d.orders) + "+ orders" : ""}
                    </p>
                </div>

                <span class="dgo">›</span>
            </a>
        `;
    }).join("");
}

/* ---------- FLOATING AI ASSISTANT ---------- */
const KB = [
    [/^(hi|hello|hey|habari|mambo|sasa|good (morning|afternoon|evening))\b/, "Hello! I'm GasHub Assist. Ask me about cylinders, prices, delivery, payments, orders or safety."],
    [/leak|smell|fire|explod|burning/, "If you smell gas:\n1. Don't light flames or use switches.\n2. Close the cylinder valve if it is safe.\n3. Open doors and windows and move everyone outside.\n4. Call 999 or 112, then your dealer.\nDon't use the cylinder again until it is checked."],
    [/usual|last order|reorder|re-order|my (past )?(orders|purchases)|what (do|did) i (usually )?(buy|order)|bought before/, "__HISTORY__"],
    [/which (gas|cylinder|size)|what size|choose|recommend|how big|family/, "Rough guide:\n• 6kg: 1-2 people or light cooking\n• 13kg: a family of 3-5, the most common\n• 22kg: large families\n• 50kg: restaurants and businesses\nTell me how many people you cook for and I'll narrow it down.", ["See cylinders", "customer-product.html?category=cylinders"]],
    [/how long|last|lasts|finish|duration/, "It depends on how much you cook. As a rough guide, a 6kg cylinder lasts a small household a few weeks, and 13kg lasts a family of 4-5 about one to two months."],
    [/refill|exchange|swap|new cylinder|empty|deposit|own cylinder/, "You can usually refill your own cylinder or buy a new filled one. The dealer shows the exact options, and any cylinder deposit, before you confirm."],
    [/accessor|regulator|hose|burner|stand|pipe|stove|cooker|valve/, "We have regulators, hoses, burners, stands and more. Use a regulator and hose that fit your cylinder type.", ["Browse accessories", "customer-product.html?category=accessories"]],
    [/price|cost|cheap|how much|expensive|discount|offer/, "Prices depend on the size, brand and dealer. Open a product to compare dealers and see the exact price before you order.", ["View products", "customer-product.html"]],
    [/deliver|how fast|how soon|arrive|fee|charge|shipping/, "Your dealer delivers to the location you pin. Delivery time and any fee are shown before you confirm. Set your location with the pin button at the top.", ["Find a dealer", "customer-dealer.html"]],
    [/area|location|where|pin|address|nairobi|mombasa|kisumu|nakuru|rongai|kiambu|eldoret/, "Tap \"Deliver to\" at the top, allow location access or drop a pin, and you'll see dealers who deliver to you."],
    [/pay|mpesa|m-pesa|card|cash|paybill|till/, "Available payment options are shown at checkout before you confirm your order."],
    [/track|where is my|status|rider|late|delay|not arrived/, "Open My Orders to see your order status. If it is late, contact the dealer from the order details page.", ["My orders", "customer-orders.html"]],
    [/cancel|change|edit|wrong (item|order)|mistake/, "You can manage an order from My Orders. Check whether it can still be changed or cancelled. If it has already been dispatched, contact the dealer directly.", ["My orders", "customer-orders.html"]],
    [/refund|return|damaged|faulty|complain|poor|not full|underweight/, "I'm sorry about that. Open the order in My Orders, report the problem and contact the dealer. Keep your receipt and take a photo of the issue if you can.", ["My orders", "customer-orders.html"]],
    [/verified|trust|legit|licen|genuine|fake|scam/, "Dealers with a green tick are verified by GasHub. Check a dealer's rating and number of orders on their profile before you order.", ["View dealers", "customer-dealer.html"]],
    [/dealer|seller|shop|near me|nearby/, "Browse dealers near you, compare what they sell and order from their profile.", ["Find a dealer", "customer-dealer.html"]],
    [/become|sell|join.*dealer|partner/, "Want to sell on GasHub? Submit a dealer application with your business details and map pin. Our admin team reviews applications and emails one-time login details if approved.", ["Apply as a dealer", "dealer-application.html"]],
    [/login|log in|sign in|password|forgot|account|register|sign up|profile/, "Manage your account from your profile. If you forgot your password, use the reset option on the login page.", ["My profile", "customer-profile.html"]],
    [/how.*(order|buy)|place an order|checkout|buy/, "1. Search or pick a product.\n2. Choose a dealer and quantity.\n3. Confirm your delivery pin.\n4. Pay and track the order in My Orders.", ["Start shopping", "customer-product.html"]],
    [/safe|safety|storage|tips|indoor|kitchen/, "Safety basics: keep the cylinder upright in a ventilated place away from heat, check hoses for cracks, turn the valve off after cooking, and never use a damaged cylinder."],
    [/contact|support|help|phone|call|email|whatsapp|human|agent/, "Reach support from Help & Support in the menu. For a specific order, contact the dealer from the order page."],
    [/about|gashub|who are you|what is/, "GasHub connects you with trusted gas dealers near you for fast delivery of gas, cylinders and accessories.", ["About GasHub", "customer-about.html"]],
    [/thank|asante|great|cool|^ok/, "You're welcome! Ask me anything else about gas, orders or delivery."]
];

const QUICK = [
    "What do I usually buy?",
    "Which cylinder should I choose?",
    "How does delivery work?",
    "How do I pay?",
    "I smell gas",
    "Track my order"
];

const sparkle = '<svg viewBox="0 0 24 24"><path d="M12 2l2.2 6.3L21 10l-6.8 1.7L12 18l-2.2-6.3L3 10l6.8-1.7z"/></svg>';

function buildAssistant() {
    const fab = document.createElement("button");

    fab.className = "fab";
    fab.setAttribute("aria-label", "Ask GasHub Assist");
    fab.innerHTML = `<i>${sparkle}</i>Ask GasHub`;
    fab.addEventListener("click", openChat);

    document.body.appendChild(fab);

    const chat = document.createElement("div");
    chat.className = "chat";
    chat.id = "chat";

    chat.innerHTML = `
        <div class="chat-card" role="dialog" aria-label="GasHub Assist">
            <div class="chat-head">
                <div>
                    <i>${sparkle}</i>
                    <span><b>GasHub Assist</b><small>Ask me anything</small></span>
                </div>
                <button class="icon-btn" id="chatX" aria-label="Close">×</button>
            </div>

            <div class="msgs" id="msgs"></div>

            <div class="chips">
                ${QUICK.map(q => `<button type="button">${esc(q)}</button>`).join("")}
            </div>

            <form class="cform" id="cform">
                <input id="cinput" placeholder="Type your question..." autocomplete="off" aria-label="Your question">
                <button type="submit">Send</button>
            </form>
        </div>
    `;

    document.body.appendChild(chat);

    say(
        "Hi, I'm GasHub Assist. Ask about cylinder sizes, prices, delivery, payments, your orders or gas safety.",
        null,
        "bot"
    );

    $("#chatX").addEventListener("click", closeChat);

    chat.addEventListener("click", e => {
        if (e.target === chat) closeChat();
    });

    const ask = q => {
        say(q, null, "user");

        setTimeout(async () => {
            const [t, l] = await answer(q);
            say(t, l, "bot");
        }, 350);
    };

    $("#cform").addEventListener("submit", e => {
        e.preventDefault();

        const i = $("#cinput");
        const q = i.value.trim();

        if (q) {
            i.value = "";
            ask(q);
        }
    });

    $$(".chips button", chat).forEach(b =>
        b.addEventListener("click", () => ask(b.textContent))
    );
}

async function answer(q) {
    const hit = KB.find(([re]) => re.test(q.toLowerCase()));

    if (!hit) {
        return [
            "I'm not sure about that one yet. I can help with cylinder sizes, prices, delivery, payments, orders, accessories and safety. You can also reach support from Help & Support in the menu."
        ];
    }

    if (hit[1] === "__HISTORY__") {
        const c = Object.values(await purchaseCounts())
            .sort((a, b) => b.n - a.n);

        if (!c.length) {
            return [
                "I don't see any past orders yet. Once you order, I'll remember your usual size and show it first.",
                ["Start shopping", "customer-product.html"]
            ];
        }

        return [
            `You usually buy:\n${c.slice(0, 3).map(x => `• ${x.name} (${x.n}×)`).join("\n")}\nYour top pick shows first in Most bought.`,
            ["Reorder", "customer-orders.html"]
        ];
    }

    return [hit[1], hit[2]];
}

function say(text, link, who) {
    const box = $("#msgs");
    const el = document.createElement("div");

    el.className = "msg " + who;
    el.innerHTML = esc(text) +
        (link ? `<br><a href="${esc(link[1])}">${esc(link[0])}</a>` : "");

    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
}

/* the chat itself now lives in gashub-assistant.js (one assistant for every page) */
function openChat() { if (window.GasHubAssistant) window.GasHubAssistant.open(); }
function closeChat() { if (window.GasHubAssistant) window.GasHubAssistant.close(); }

document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
        closeMenu();
        closeLoc();
        closeChat();
    }
});

/* ---------- START ---------- */
showCustomer();
showLocation();
/* buildAssistant() removed: gashub-assistant.js builds the chat */
loadProducts();
loadDealers();
