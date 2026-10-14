/* Platform gates, applied to every request before the routes:
   - maintenance mode: customers and dealers get a maintenance page / 503 (admins are not affected)
   - dealer availability OFF: customers see no dealers or products and cannot place orders
   Admin requests (signed-in admin token) are never blocked. */
const { getPlatform, resetCache } = require("./platform-settings");
const { adminSessions } = require("../middleware/admin-authentication");

/* customer-facing API areas that are paused by maintenance mode */
/* (and the dealer side: dealer pages, dealer login and every /api/dealers call) */
const CUSTOMER_API = /^\/api\/(products|orders|my|points|customer|customers|rewards|messages|dealers|dealer|login|register|dealer-applications|auth)(\/|$)/;
const DEALER_OWN = /^\/api\/dealers\/(products|profile|working-hours|heartbeat|messages|riders|reviews|orders|login|complete-setup)(\/|$)/;
const PUBLIC_PRODUCTS = /^\/api\/products(\/[^/]+)?\/?$/;
const PUBLIC_DEALERS = /^\/api\/dealers(\/[^/]+)?\/?$/;

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderPage(p) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GasHub - Maintenance</title>
<link rel="icon" type="image/png" href="/Images/favicon.png">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f4f7fb;color:#1e293b;text-align:center;padding:24px}main{max-width:440px}img{width:170px;max-width:60%;height:auto;margin-bottom:22px}h1{font-size:26px;margin:0 0 10px}p{color:#64748b;line-height:1.65;margin:0;white-space:pre-line}</style></head>
<body><main><img src="/Images/logo.png" alt="GasHub"><h1>${esc(p.maintenance_title)}</h1><p>${esc(p.maintenance_message)}</p></main></body></html>`;
}

async function isAdmin(req) {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.substring(7).trim() : "";
    return Boolean(t && await adminSessions.has(t));
}

async function platformGate(req, res, next) {
    try {
        const path = req.path;
        const isPage = req.method === "GET" && (path === "/" || /\.html?$/i.test(path)) && !path.startsWith("/admin");
        const isApi = path.startsWith("/api/");
        if (!isPage && !isApi) return next();
        /* Signed-in administrators are never blocked. The (database) check is only made when something would be blocked. */
        const adminBypass = async () => isApi && await isAdmin(req);

        const p = await getPlatform();

        /* maintenance mode: customers AND dealers are locked out together; admins are not */
        if (p.maintenance_mode && (isPage || CUSTOMER_API.test(path)) && !(await adminBypass())) {
            if (isApi) return res.status(503).json({ success: false, maintenance: true, message: "GasHub is under maintenance. Please try again shortly." });
            return res.status(503).set("Retry-After", "600").type("html").send(renderPage(p));
        }

        /* dealer availability */
        if (!p.dealer_availability && isApi && !(await adminBypass())) {
            const off = "Dealers are not available right now. Please check back later.";
            if (req.method === "GET" && PUBLIC_PRODUCTS.test(path)) {
                return /\/products\/?$/.test(path)
                    ? res.json({ success: true, products: [], dealers_unavailable: true, message: off })
                    : res.status(404).json({ success: false, dealers_unavailable: true, message: off });
            }
            if (req.method === "GET" && PUBLIC_DEALERS.test(path) && !DEALER_OWN.test(path)) {
                return /\/dealers\/?$/.test(path)
                    ? res.json({ success: true, dealers: [], dealers_unavailable: true, message: off })
                    : res.status(404).json({ success: false, dealers_unavailable: true, message: off });
            }
            if (req.method === "POST" && /^\/api\/orders\/?$/.test(path)) {
                return res.status(503).json({ success: false, dealers_unavailable: true, message: off });
            }
        }
        return next();
    } catch (e) { return next(); }
}

module.exports = { maintenanceGate: platformGate, platformGate, resetCache };
