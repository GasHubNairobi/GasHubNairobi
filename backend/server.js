const path = require("path");

// ============================================================
// LOAD ENVIRONMENT VARIABLES FROM THE MAIN GASHUB ROOT
// ============================================================

const envPath = path.resolve(__dirname, "../.env");

require("dotenv").config({
    path: envPath
});

// Safe diagnostic: confirms whether variables are available
// without printing passwords or other secret values.
console.log("SMTP environment check:", {
    SMTP_HOST: Boolean(process.env.SMTP_HOST?.trim()),
    SMTP_USER: Boolean(process.env.SMTP_USER?.trim()),
    SMTP_PASS: Boolean(process.env.SMTP_PASS?.trim()),
    SMTP_FROM: Boolean(process.env.SMTP_FROM?.trim())
});

// ============================================================
// IMPORTS
// ============================================================

const express = require("express");
const { testDatabaseConnection } = require("./config/database-config");

const authenticationRoutes = require("./routes/authentication-routes");
const adminRoutes = require("./routes/admin-routes");
const productRoutes = require("./routes/product-routes");
const dealerRoutes = require("./routes/dealer-routes");
const orderRoutes = require("./routes/order-routes");
const customerRoutes = require("./routes/customer-routes");
const complaintRoutes = require("./routes/complaint-routes");
const paymentRoutes = require("./routes/payment-routes");
const reviewRoutes = require("./routes/review-routes");
const customerAccountRoutes = require("./routes/customer-account-routes");
const settingsRoutes = require("./routes/settings-routes");
const { purgeDueAccounts } = require("./controllers/customer-account-controller");

const dealerApplicationController = require("./controllers/dealer-application-controller");
const { adminSessions } = require("./middleware/admin-authentication");
const { pool } = require("./config/database-config");
const { rateLimit } = require("./utils/rate-limit");
const { isServerless } = require("./utils/runtime");
const { projectPath } = require("./utils/paths");

// ============================================================
// APP CONFIGURATION
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.TRUST_PROXY || isServerless || process.env.RENDER) {   /* Render sets RENDER=true and puts its proxy in front of the app */
    app.set(
        "trust proxy",
        Number(process.env.TRUST_PROXY) || 1
    );
}

app.disable("x-powered-by");

// Basic security headers for every response
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "geolocation=(self), camera=(self), microphone=()");
    next();
});

// Smaller responses (gzip / brotli) so pages and scripts load faster on mobile data
// (on Netlify the CDN compresses responses itself)
if (!isServerless) app.use(require("./utils/compress").compress());

// Maintenance mode (switched on by the super admin in Admin Settings)
app.use(require("./utils/maintenance").maintenanceGate);

// Netlify Functions accept at most ~6 MB per request, so on Netlify the app answers a clear "too large" message at 5 MB
// instead of Netlify cutting the request off with an unreadable error.
const BODY_LIMIT = isServerless ? "5mb" : "10mb";
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({
    extended: true,
    limit: BODY_LIMIT
}));

/* Netlify safety net: on Netlify the request body can reach Express as a raw Buffer (or string) that the normal body parsers
   skip, or as an empty object. Here it is turned into the usual fields (JSON or form data) so logins and forms work. */
app.use((req, res, next) => {
    try {
        const type = String(req.headers["content-type"] || "").toLowerCase();
        const isJson = type.includes("application/json");
        const isForm = type.includes("application/x-www-form-urlencoded");
        const parseRaw = (raw) => {
            raw = String(raw || "");
            if (isJson) return raw.trim() ? JSON.parse(raw) : {};
            if (isForm) return Object.fromEntries(new URLSearchParams(raw));
            return undefined;
        };
        let b = req.body;
        if (Buffer.isBuffer(b) || typeof b === "string") {
            const parsed = b.length === 0 ? {} : parseRaw(Buffer.isBuffer(b) ? b.toString("utf8") : b);
            if (parsed !== undefined) req.body = parsed;
        } else {
            const ev = req.apiGateway && req.apiGateway.event;
            const empty = !b || (typeof b === "object" && !Array.isArray(b) && Object.keys(b).length === 0);
            if (ev && ev.body && empty && (isJson || isForm)) {
                let raw = ev.body;
                if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
                else if (typeof raw === "object") { req.body = raw; return next(); }
                else if (ev.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
                req.body = parseRaw(raw);
            }
        }
    } catch (e) {
        console.error("[body-fallback]", e.message);
    }
    next();
});

// ============================================================
// FRONTEND PATHS
// ============================================================

// (on Netlify the public files are served by the CDN; only the admin pages and the home-page fallback are shipped with the function)
const frontendPath = projectPath("frontend");
const imagesPath = projectPath("Images");
const adminPath = projectPath("admin");
const dealerPath = projectPath("dealer");

// ============================================================
// STATIC FILES
// ============================================================

// Project notes, SQL and shortcut files sit beside the pages: never serve them to the public.
app.use((req, res, next) => {
    if (/\.(md|sql|txt|lnk|env|map)$/i.test(req.path) || /\.\d+css$/i.test(req.path)) {
        return res.status(404).send("Not found");
    }
    next();
});

// Link previews (WhatsApp, Facebook, X ...): adds the app's own logo as the share image to customer pages
app.use(require("./utils/share-meta").shareMeta);

// Caching: images and icons are kept by the phone for a week; pages, scripts and styles are re-checked each visit
// (a quick "not changed" reply, so people never get a stale script that could break the page).
const staticCache = {
    dotfiles: "deny",
    etag: true,
    setHeaders(res, filePath) {
        if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?)$/i.test(filePath)) {
            res.setHeader("Cache-Control", "public, max-age=604800");
        } else {
            res.setHeader("Cache-Control", "no-cache");
        }
    }
};

/* ---- Android app links: lets https links to this site open the GasHub app when it is installed ----
   /.well-known/assetlinks.json is built from the package name saved in Admin > Settings > GasHub Mobile App and the
   ANDROID_SHA256_CERT_FINGERPRINTS setting (comma separated; copy it from Play Console > App integrity > App signing). */
app.get("/.well-known/assetlinks.json", async (req, res) => {
    try {
        const g = require("./utils/gashub-settings");
        const pkg = String(process.env.ANDROID_PACKAGE_NAME || (await g.getAppConfig()).packageId || "").trim();
        const prints = String(process.env.ANDROID_SHA256_CERT_FINGERPRINTS || "").split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(x));
        res.set("Cache-Control", "public, max-age=300").type("application/json");
        if (!pkg || !prints.length) return res.send("[]");
        res.send(JSON.stringify([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints } }]));
    } catch (e) { res.status(200).type("application/json").send("[]"); }
});

/* The install manifest. Once the app is live on Google Play it names the Android app, so Chrome can tell the page whether it is installed. */
app.get("/manifest.webmanifest", async (req, res) => {
    try {
        const m = JSON.parse(require("fs").readFileSync(require("path").join(frontendPath, "manifest.webmanifest"), "utf8"));
        try {
            const g = require("./utils/gashub-settings"), cfg = await g.getAppConfig(), url = g.appLink(cfg);
            if (cfg.packageId && url && (await g.playStoreLive(cfg))) { m.related_applications = [{ platform: "play", url, id: cfg.packageId }]; m.prefer_related_applications = false; }
        } catch (e) { /* keep the plain manifest */ }
        res.set("Cache-Control", "public, max-age=300").type("application/manifest+json").send(JSON.stringify(m));
    } catch (e) { res.status(404).end(); }
});

app.use(express.static(frontendPath, staticCache));

app.use(
    "/Images",
    express.static(imagesPath, staticCache)
);

// ============================================================
// ADMIN PAGE AUTHENTICATION
// ============================================================

const ADMIN_SESSION_COOKIE = "gashub_admin_session";

function readCookie(req, name) {
    const header = req.headers.cookie || "";

    for (const part of header.split(";")) {
        const index = part.indexOf("=");

        if (index < 0) {
            continue;
        }

        if (part.slice(0, index).trim() === name) {
            try {
                return decodeURIComponent(
                    part.slice(index + 1).trim()
                );
            } catch {
                return null;
            }
        }
    }

    return null;
}

async function requireAdminPage(req, res, next) {
    try {
        const token = readCookie(
            req,
            ADMIN_SESSION_COOKIE
        );

        const session = token
            ? await adminSessions.get(token)
            : null;

        const sessionExpired =
            !session ||
            !session.createdAt ||
            Date.now() - session.createdAt >
                8 * 60 * 60 * 1000;

        if (sessionExpired) {
            if (token) {
                await adminSessions.delete(token);
            }

            res.clearCookie(
                ADMIN_SESSION_COOKIE,
                {
                    path: "/admin",
                    sameSite: "strict",
                    httpOnly: true,
                    secure:
                        process.env.NODE_ENV === "production"
                }
            );

            return res.redirect(
                302,
                "/admin/admin-login.html"
            );
        }

        const result = await pool.query(
            `SELECT id
             FROM users
             WHERE id = $1
               AND role = 'admin'
               AND status = 'active'
             LIMIT 1`,
            [session.adminId]
        );

        if (!result.rows.length) {
            await adminSessions.delete(token);

            res.clearCookie(
                ADMIN_SESSION_COOKIE,
                {
                    path: "/admin",
                    sameSite: "strict",
                    httpOnly: true,
                    secure:
                        process.env.NODE_ENV === "production"
                }
            );

            return res.redirect(
                302,
                "/admin/admin-login.html"
            );
        }

        res.setHeader(
            "Cache-Control",
            "no-store, private"
        );

        return next();
    } catch (error) {
        console.error(
            "Admin page authentication error:",
            error
        );

        return res.redirect(
            302,
            "/admin/admin-login.html"
        );
    }
}

// ============================================================
// ADMIN STATIC FILES
// ============================================================

app.use(
    "/admin",
    (req, res, next) => {
        let pathname;

        try {
            pathname = decodeURIComponent(
                req.path || "/"
            );
        } catch {
            return res.status(400).send("Invalid path");
        }

        // Public admin login page.
        if (
            pathname.toLowerCase() === "/admin-login.html"
        ) {
            return next();
        }

        // Protect all other admin HTML pages.
        if (/\.html?$/i.test(pathname)) {
            return requireAdminPage(req, res, next);
        }

        return next();
    },
    express.static(adminPath, {
        index: false,
        dotfiles: "deny",
        setHeaders(res, filePath) {
            if (/\.html?$/i.test(filePath) && !/admin-login\.html$/i.test(filePath)) res.setHeader("Cache-Control", "no-store, private");
        }
    })
);

// ============================================================
// DEALER PAGE AUTHENTICATION
// ============================================================
// Same idea as the admin pages: every dealer .html page except the public login / application pages is only
// served to a browser holding a valid dealer session cookie (set at dealer login). On Netlify these pages are NOT on the CDN
// (scripts/build-netlify.js leaves them out), so this function is the only way to reach them.

const { dealerSessions, DEALER_SESSION_COOKIE, dealerCookieOptions } = require("./middleware/dealer-authentication");
const PUBLIC_DEALER_PAGES = new Set(["/dealer-login.html", "/dealer-application.html"]);

async function requireDealerPage(req, res, next) {
    const toLogin = () => {
        res.clearCookie(DEALER_SESSION_COOKIE, dealerCookieOptions());
        res.setHeader("Cache-Control", "no-store, private");
        return res.redirect(302, "/dealer/dealer-login.html");
    };
    try {
        const token = readCookie(req, DEALER_SESSION_COOKIE);
        const session = token ? await dealerSessions.get(token) : null;
        if (!session) return toLogin();

        const result = await pool.query(
            `SELECT u.status AS user_status, u.must_change_password, u.onboarding_completed, d.status AS dealer_status
             FROM users u INNER JOIN dealers d ON d.user_id = u.id
             WHERE u.id = $1 AND d.id = $2 AND u.role = 'dealer' LIMIT 1`,
            [session.userId, session.dealerId]
        );
        const a = result.rows[0];
        const pendingFirstLogin = Boolean(a && a.must_change_password && !a.onboarding_completed);
        if (!a || a.user_status !== "active" || (a.dealer_status !== "active" && !pendingFirstLogin)) {
            await dealerSessions.delete(token);
            return toLogin();
        }
        res.setHeader("Cache-Control", "no-store, private");
        return next();
    } catch (error) {
        console.error("Dealer page authentication error:", error);
        return toLogin();
    }
}

// ============================================================
// DEALER STATIC FILES
// ============================================================

app.use(
    "/dealer",
    (req, res, next) => {
        let pathname;
        try {
            pathname = decodeURIComponent(req.path || "/");
        } catch {
            return res.status(400).send("Invalid path");
        }
        if (/\.html?$/i.test(pathname) && !PUBLIC_DEALER_PAGES.has(pathname.toLowerCase())) {
            return requireDealerPage(req, res, next);
        }
        // "/dealer" or "/dealer/" opens the login page
        if (pathname === "/" || pathname === "") return res.redirect(302, "/dealer/dealer-login.html");
        return next();
    },
    express.static(dealerPath, {
        ...staticCache,
        index: false,
        setHeaders(res, filePath) {
            // signed-in pages must never be kept by the browser or a shared cache
            if (/\.html?$/i.test(filePath) && !/dealer-(login|application)\.html$/i.test(filePath)) res.setHeader("Cache-Control", "no-store, private");
            else staticCache.setHeaders(res, filePath);
        }
    })
);

// ============================================================
// API ROUTES
// ============================================================

app.use(
    "/api",
    authenticationRoutes
);

// Public form: limited per IP so it cannot be used to spam the admin inbox
app.post(
    "/api/dealer-applications",
    rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }),
    dealerApplicationController.submitApplication
);

app.use(
    "/api/admin",
    adminRoutes
);

app.use(
    "/api/products",
    productRoutes
);

app.use(
    "/api/dealers",
    dealerRoutes
);

app.use(
    "/api/orders",
    orderRoutes
);

// Customer's own orders + GasHub points
app.use("/api/payments/bank", require("./routes/bank-routes"));
app.use("/api/payments/mpesa", require("./routes/mpesa-routes"));   /* before the admin payments router */
const customerOrderRoutes = require("./routes/customer-order-routes");
app.use("/api/my", customerOrderRoutes.my);
app.use("/api/points", customerOrderRoutes.points);

// Live order tracking: the messenger's phone sends GPS with a secret link token (no login)
app.use("/api/track", require("./routes/tracking-routes"));
app.use("/api/customer", customerOrderRoutes.customerRewards);
app.use("/api/rewards", customerOrderRoutes.rewardsSettings);

// Profile save, Earn GasHub Points (invite + follow) and delayed account deletion
app.use("/api/customer", customerAccountRoutes);

// Public settings (contact numbers, social accounts)
app.use("/api/settings", settingsRoutes);

app.use(
    "/api/customers",
    customerRoutes
);

// Customer <-> dealer chat
const messageRoutes = require("./routes/message-routes");
app.use("/api/messages", messageRoutes);
app.use("/api/push", require("./routes/push-routes"));   /* phone push notifications */
app.use("/api/cron", require("./routes/cron-routes"));       /* lets an outside pinger run the minute jobs (keeps Render free awake) */

app.use(
    "/api/admin/complaints",
    complaintRoutes
);

app.use(
    "/api/admin/payments",
    paymentRoutes
);

app.use(
    "/api/admin/reviews",
    reviewRoutes
);

// ============================================================
// API 404 HANDLER
// ============================================================

app.use(
    "/api",
    (req, res) => {
        return res.status(404).json({
            success: false,
            message: "API endpoint not found."
        });
    }
);

// ============================================================
// FRONTEND ENTRY POINT
// ============================================================

app.get("/", (req, res) => {
    return res.redirect("/customer-home.html");
});

// ============================================================
// FRONTEND FALLBACK
// ============================================================

app.use(
    (req, res, next) => {
        if (req.path.startsWith("/api")) {
            return res.status(404).json({
                success: false,
                message: "API endpoint not found."
            });
        }

        // A missing .js / .css / image / page must be a real 404, not the home page with a 200
        if (path.extname(req.path) || (req.method !== "GET" && req.method !== "HEAD")) {
            return res.status(404).send("Not found");
        }

        return res.sendFile(
            path.join(
                frontendPath,
                "customer-home.html"
            ),
            (error) => {
                if (error) {
                    next(error);
                }
            }
        );
    }
);

// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
    (error, req, res, next) => {
        if (res.headersSent) {
            return next(error);
        }

        // Bad or oversized request bodies are the caller's mistake, not a server crash
        if (error && error.type === "entity.parse.failed") {
            return res.status(400).json({ success: false, message: "The request body is not valid JSON." });
        }
        if (error && error.type === "entity.too.large") {
            return res.status(413).json({ success: false, message: "The request is too large. Use smaller photos (or fewer at a time) and try again." });
        }

        console.error(
            "Unhandled server error:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "An unexpected server error occurred."
        });
    }
);

// ============================================================
// START SERVER
// ============================================================

// Work the server used to do once at start-up. On Netlify it runs on the first request of each new function instance
// (everything here is idempotent and skips quickly when the database is already prepared).
let warmedUp = null;
function warmup() {
    if (!warmedUp) {
        const withTimeout = (promise, ms) => Promise.race([Promise.resolve(promise).catch((e) => console.error("Start-up task:", e && e.message)), new Promise((r) => setTimeout(r, ms).unref())]);
        warmedUp = Promise.all([
            withTimeout(require("./utils/payment-flow").ensurePaymentFlowColumns(), 6000),
            withTimeout(require("./utils/order-times").ensureOrderTimeColumns(), 6000),
            withTimeout(require("./utils/account-indexes").ensureRoleScopedAccountIndexes(), 6000),
            withTimeout(require("./utils/rls-guard").ensureRowLevelSecurity(), 6000)
        ]);
    }
    return warmedUp;
}
app.warmup = warmup;

async function startServer() {
    try {
        console.log(
            "Loading environment from:",
            envPath
        );

        const smtpVariables = [
            "SMTP_HOST",
            "SMTP_PORT",
            "SMTP_USER",
            "SMTP_PASS",
            "SMTP_FROM"
        ];

        const missingSmtpVariables =
            smtpVariables.filter(
                (key) => !process.env[key]?.trim()
            );

        if (missingSmtpVariables.length > 0) {
            console.warn(
                "Email configuration is incomplete. Missing:",
                missingSmtpVariables.join(", ")
            );
        } else {
            console.log(
                "SMTP environment variables are present."
            );
        }

        const databaseConnected =
            await testDatabaseConnection();

        if (!databaseConnected) {
            console.error(
                "Server will start, but the database connection failed."
            );
        }

        const server = app.listen(
            PORT,
            () => {
                console.log(
                    "======================================"
                );

                console.log(
                    "GasHub server started."
                );

                console.log(`Port: ${PORT}`);

                console.log(
                    `http://localhost:${PORT}`
                );

                console.log(
                    "======================================"
                );
            }
        );

        // Pay-after-confirmation columns (orders.payment_method_chosen etc.): prepared in the background so a slow or locked
        // database can never stop the server from starting. The order code also makes sure they exist before it needs them.
        if (databaseConnected) {
            require("./utils/payment-flow").ensurePaymentFlowColumns()
                .catch((e) => console.error("Payment flow columns:", e.message));
        }

        // Exact order times (placed / confirmed / paid / delivery started / delivered / completed): columns + back-fill, in the background
        if (databaseConnected) {
            require("./utils/order-times").ensureOrderTimeColumns()
                .catch((e) => console.error("Order time columns:", e.message));
        }

        // Keep Supabase's public REST API locked out of every table (idempotent)
        if (databaseConnected) {
            require("./utils/rls-guard").ensureRowLevelSecurity().catch(() => {});
        }

        // One email may be both a customer and a dealer: make the database allow it (idempotent, runs in the background)
        if (databaseConnected) {
            Promise.resolve(require("./utils/account-indexes").ensureRoleScopedAccountIndexes())
                .catch((e) => console.error("Account indexes:", e.message));
        }

        // Delete customer accounts whose 7-day wait is over (checked on start, then every hour)
        purgeDueAccounts();
        setInterval(purgeDueAccounts, 60 * 60 * 1000).unref();

        // Automated customer reminders (selected item, restock) - the admin sets the timing
        require("./utils/messaging-scheduler").start();

        // Every minute: automatic dealer payouts + M-Pesa prompts whose callback never arrived (always-on server only)
        require("./utils/background").start();

        server.on("error", (error) => {
            if (error && error.code === "EADDRINUSE") {
                console.error(`Port ${PORT} is already in use. Stop the other GasHub server (or change PORT in .env) and start again.`);
                process.exit(1);
            }
            console.error(
                "HTTP server error:",
                error
            );
        });
    } catch (error) {
        console.error(
            "Unable to start GasHub server:",
            error
        );

        process.exit(1);
    }
}

// A dropped database connection (ECONNRESET / ETIMEDOUT) must not shut the whole server down.
process.on("uncaughtException", (error) => {
    if (error && ["ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(error.code)) {
        console.error("Connection dropped (server keeps running):", error.code);
        return;
    }
    console.error("Uncaught exception:", error);
    process.exit(1);
});
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));

// "npm start" runs this file directly. Netlify (netlify/functions/api.js) only imports the app.
if (require.main === module) {
    startServer();
}

module.exports = app;