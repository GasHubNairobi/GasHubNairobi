/* GasHub admin reports.
   - GET  /api/admin/reports?start_date&end_date&report_type   the report on screen (all records, nothing cut off)
   - POST /api/admin/reports/seal                              a printed / downloaded copy: the report is worked out again on the server,
                                                               given a secret report code and written to the report register
   - GET  /api/admin/reports/verify?code=GHR-000123-XXXXXXXX   checks a code on a paper or PDF copy against the register
   - GET  /api/admin/reports/history                           the register: every copy that was printed or downloaded
   The report code is made with a secret key that only the server knows (kept in the settings table, created on first use), so a code cannot be
   invented for a forged report. The register keeps who printed it, when, the period and the main figures; the code is tied to all of them.
   Days are worked out in Nairobi time. The table is created on first use (no migration to run). */
const crypto = require("crypto");
const { pool } = require("../config/database-config");
const { getSetting } = require("../utils/gashub-settings");
const { formatOrderStatus, formatPaymentStatus } = require("../utils/assistant");

const TYPES = ["overview", "orders", "payments", "customers", "products"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 5000;                                   /* a list longer than this says so on the report instead of silently dropping rows */

/* start of the first day to the start of the day after the last day, in Nairobi time */
const FROM_TS = "(($1::date)::timestamp AT TIME ZONE 'Africa/Nairobi')";
const TO_TS = "((($2::date + 1))::timestamp AT TIME ZONE 'Africa/Nairobi')";
const inRange = (col) => `${col} >= ${FROM_TS} AND ${col} < ${TO_TS}`;

const todayNairobi = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const monthStartNairobi = () => todayNairobi().slice(0, 8) + "01";
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/* checks the three inputs; returns { start, end, type } or { error } */
function readFilters(src) {
    const start = String((src && src.start_date) || monthStartNairobi());
    const end = String((src && src.end_date) || todayNairobi());
    const type = TYPES.includes(String((src && src.report_type) || "")) ? String(src.report_type) : "overview";
    if (!DATE_RE.test(start) || !DATE_RE.test(end) || isNaN(new Date(start + "T00:00:00Z")) || isNaN(new Date(end + "T00:00:00Z"))) return { error: "Choose a valid start date and end date." };
    if (start > end) return { error: "The start date cannot be after the end date." };
    return { start, end, type };
}

/* Everything the report shows. `registers` adds the full order / payment lists (used by the Orders and Payments reports). */
async function buildReport(start, end, type, registers) {
    const q = (sql) => pool.query(sql, [start, end]);
    const [summary, orders, payments, products, customers] = await Promise.all([
        q(`SELECT
                COUNT(DISTINCT o.id)::INTEGER AS total_orders,
                COALESCE(SUM(CASE WHEN o.status NOT IN ('cancelled', 'rejected') THEN o.total_amount ELSE 0 END), 0) AS total_sales,
                (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE ${inRange("p.created_at")} AND p.status = 'paid' AND NOT EXISTS (SELECT 1 FROM orders ro WHERE ro.id = p.order_id AND ro.status::text IN ('cancelled', 'rejected'))) AS total_payments,
                (SELECT COUNT(*)::INTEGER FROM users u WHERE u.role = 'customer' AND ${inRange("u.created_at")}) AS new_customers,
                (SELECT COUNT(*)::INTEGER FROM users u WHERE u.role = 'customer') AS total_customers
             FROM orders o WHERE ${inRange("o.created_at")}`),
        q(`SELECT o.status, COUNT(*)::INTEGER AS order_count, COALESCE(SUM(o.total_amount), 0) AS total_amount
             FROM orders o WHERE ${inRange("o.created_at")} GROUP BY o.status ORDER BY order_count DESC`),
        q(`SELECT p.method, p.status, COUNT(*)::INTEGER AS payment_count, COALESCE(SUM(p.amount), 0) AS total_amount
             FROM payments p WHERE ${inRange("p.created_at")} GROUP BY p.method, p.status ORDER BY total_amount DESC`),
        q(`SELECT oi.product_id, oi.product_name, COUNT(DISTINCT oi.order_id)::INTEGER AS order_count,
                  COALESCE(SUM(oi.quantity), 0)::INTEGER AS quantity_sold, COALESCE(SUM(oi.total_price), 0) AS total_sales
             FROM order_items oi INNER JOIN orders o ON o.id = oi.order_id
             WHERE ${inRange("o.created_at")} AND o.status NOT IN ('cancelled', 'rejected')
             GROUP BY oi.product_id, oi.product_name ORDER BY total_sales DESC LIMIT ${MAX_ROWS + 1}`),
        q(`SELECT u.id, u.full_name, u.email, u.phone, COUNT(o.id)::INTEGER AS order_count,
                  COALESCE(SUM(CASE WHEN o.status NOT IN ('cancelled', 'rejected') THEN o.total_amount ELSE 0 END), 0) AS total_spent
             FROM users u INNER JOIN orders o ON o.customer_id = u.id AND ${inRange("o.created_at")}
             WHERE u.role = 'customer' GROUP BY u.id, u.full_name, u.email, u.phone ORDER BY total_spent DESC LIMIT ${MAX_ROWS + 1}`)
    ]);

    const s = summary.rows[0] || {};
    const truncated = {};
    const cut = (rows, name) => { if (rows.length > MAX_ROWS) { truncated[name] = true; return rows.slice(0, MAX_ROWS); } return rows; };
    const out = {
        report: { start_date: start, end_date: end, report_type: type, time_zone: "Africa/Nairobi" },
        statistics: {
            totalOrders: num(s.total_orders), totalSales: num(s.total_sales), totalPayments: num(s.total_payments),
            newCustomers: num(s.new_customers), totalCustomers: num(s.total_customers), activeCustomers: customers.rows.length
        },
        orders: orders.rows.map((r) => ({ status: r.status, status_label: formatOrderStatus(r.status), order_count: num(r.order_count), total_amount: num(r.total_amount) })),
        payments: payments.rows.map((r) => ({ method: r.method, status: r.status, status_label: formatPaymentStatus(r.status), payment_count: num(r.payment_count), total_amount: num(r.total_amount) })),
        products: cut(products.rows, "products").map((r) => ({ product_id: r.product_id, product_name: r.product_name, order_count: num(r.order_count), quantity_sold: num(r.quantity_sold), total_sales: num(r.total_sales) })),
        customers: cut(customers.rows, "customers").map((r) => ({ id: r.id, full_name: r.full_name, email: r.email, phone: r.phone, order_count: num(r.order_count), total_spent: num(r.total_spent) }))
    };

    if (registers && type === "orders") {
        const r = await q(`SELECT o.order_number, o.created_at, o.status, o.payment_method, o.payment_status, o.total_amount, u.full_name AS customer_name,
                                  COALESCE(NULLIF(o.dealer_name_snapshot, ''), d.business_name) AS dealer_name
                             FROM orders o LEFT JOIN users u ON u.id = o.customer_id LEFT JOIN dealers d ON d.id::text = o.dealer_id::text
                             WHERE ${inRange("o.created_at")} ORDER BY o.created_at, o.order_number LIMIT ${MAX_ROWS + 1}`);
        out.order_records = cut(r.rows, "order_records").map((x) => ({ order_number: x.order_number, created_at: x.created_at, customer_name: x.customer_name, dealer_name: x.dealer_name,
            payment_method: x.payment_method, payment_status: x.payment_status, status: x.status, status_label: formatOrderStatus(x.status), total_amount: num(x.total_amount) }));
    }
    if (registers && type === "payments") {
        const r = await q(`SELECT p.created_at, p.payment_reference, p.method, p.status, p.amount, p.mpesa_receipt_number, o.order_number, u.full_name AS customer_name
                             FROM payments p LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = p.customer_id
                             WHERE ${inRange("p.created_at")} ORDER BY p.created_at, p.payment_reference LIMIT ${MAX_ROWS + 1}`);
        out.payment_records = cut(r.rows, "payment_records").map((x) => ({ created_at: x.created_at, payment_reference: x.payment_reference, order_number: x.order_number, customer_name: x.customer_name,
            method: x.method, status: x.status, status_label: formatPaymentStatus(x.status), mpesa_receipt_number: x.mpesa_receipt_number, amount: num(x.amount) }));
    }
    if (Object.keys(truncated).length) out.truncated = truncated;
    return out;
}

/* GET /api/admin/reports */
async function getReports(req, res) {
    const f = readFilters(req.query);
    if (f.error) return res.status(400).json({ success: false, message: f.error });
    try {
        const data = await buildReport(f.start, f.end, f.type, f.type === "orders" || f.type === "payments");
        res.json({ success: true, ...data });
    } catch (error) {
        console.error("Reports error:", error);
        res.status(500).json({ success: false, message: "Unable to generate report." });
    }
}

/* ---------- report register + secret codes ---------- */
let ready = null;
function ensureTable() {
    if (!ready) {
        ready = pool.query(`CREATE TABLE IF NOT EXISTS report_records (
            id BIGSERIAL PRIMARY KEY,
            code TEXT UNIQUE NOT NULL,
            report_type TEXT NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            action TEXT NOT NULL DEFAULT 'print',
            generated_by TEXT NOT NULL,
            generated_by_id TEXT,
            content_hash TEXT NOT NULL,
            statistics JSONB NOT NULL DEFAULT '{}'::jsonb,
            row_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`).catch((e) => { ready = null; throw e; });
    }
    return ready;
}

/* the secret key lives only on the server; it is created once and never sent to the browser */
async function signingKey() {
    let s = await getSetting("report_signing", {});
    if (s.key) return s.key;
    const fresh = crypto.randomBytes(32).toString("hex");
    await pool.query(`INSERT INTO gashub_settings (setting_key, setting_value, updated_at) VALUES ('report_signing', $1::jsonb, NOW()) ON CONFLICT (setting_key) DO NOTHING`, [JSON.stringify({ key: fresh })]);
    s = await getSetting("report_signing", {});
    return s.key || fresh;
}

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";      /* no 0, O, 1, I or L, so a code is easy to read out and type */
function codeFor(key, serial, hash, type, start, end) {
    const mac = crypto.createHmac("sha256", key).update([serial, hash, type, start, end].join("|")).digest();
    let tail = "";
    for (let i = 0; i < 8; i++) tail += ALPHABET[mac[i] % ALPHABET.length];
    return `GHR-${String(serial).padStart(6, "0")}-${tail}`;
}
const fingerprint = (hash) => String(hash).slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, "$1-");

const rowCounts = (d) => ({ orders: d.orders.length, payments: d.payments.length, products: d.products.length, customers: d.customers.length,
    order_records: d.order_records ? d.order_records.length : 0, payment_records: d.payment_records ? d.payment_records.length : 0 });

/* POST /api/admin/reports/seal   body: { start_date, end_date, report_type, action: "print" | "pdf" } */
async function sealReport(req, res) {
    const f = readFilters(req.body);
    if (f.error) return res.status(400).json({ success: false, message: f.error });
    try {
        await ensureTable();
        const data = await buildReport(f.start, f.end, f.type, true);
        const hash = crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
        const by = (req.admin && (req.admin.full_name || req.admin.email)) || "Admin";
        const action = String((req.body || {}).action) === "pdf" ? "pdf" : "print";
        const ins = await pool.query(
            `INSERT INTO report_records (code, report_type, start_date, end_date, action, generated_by, generated_by_id, content_hash, statistics, row_counts)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb) RETURNING id, created_at`,
            ["pending-" + crypto.randomBytes(8).toString("hex"), f.type, f.start, f.end, action, by, req.admin && req.admin.id ? String(req.admin.id) : null, hash,
             JSON.stringify(data.statistics), JSON.stringify(rowCounts(data))]);
        const serial = ins.rows[0].id;
        const code = codeFor(await signingKey(), serial, hash, f.type, f.start, f.end);
        await pool.query("UPDATE report_records SET code = $2 WHERE id = $1", [serial, code]);
        res.json({ success: true, ...data, seal: { code, serial, generated_at: ins.rows[0].created_at, generated_by: by, fingerprint: fingerprint(hash), action } });
    } catch (error) {
        console.error("Seal report error:", error);
        res.status(500).json({ success: false, message: "Unable to prepare the report for printing." });
    }
}

/* GET /api/admin/reports/verify?code=GHR-000123-XXXXXXXX */
async function verifyReport(req, res) {
    const raw = String(req.query.code || "").toUpperCase().replace(/\s+/g, "");
    const m = /^GHR-(\d{1,12})-([0-9A-Z]{8})$/.exec(raw);
    if (!m) return res.status(400).json({ success: false, genuine: false, message: "That is not a GasHub report code. It looks like GHR-000123-ABCD2345." });
    try {
        await ensureTable();
        const row = (await pool.query("SELECT * FROM report_records WHERE id = $1", [m[1]])).rows[0];
        let genuine = false;
        if (row) {
            const expected = codeFor(await signingKey(), row.id, row.content_hash, row.report_type, row.start_date, row.end_date);
            genuine = expected.length === raw.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(raw)) && row.code === raw;
        }
        if (!genuine) return res.json({ success: true, genuine: false, message: "This code is NOT in the GasHub report register. The copy may be forged." });
        res.json({
            success: true, genuine: true,
            record: { code: row.code, report_type: row.report_type, start_date: row.start_date, end_date: row.end_date, action: row.action, generated_by: row.generated_by,
                      generated_at: row.created_at, fingerprint: fingerprint(row.content_hash), statistics: row.statistics, row_counts: row.row_counts }
        });
    } catch (error) {
        console.error("Verify report error:", error);
        res.status(500).json({ success: false, message: "Unable to check that code right now." });
    }
}

/* GET /api/admin/reports/history  -> the register, newest first */
async function history(req, res) {
    try {
        await ensureTable();
        const r = await pool.query("SELECT code, report_type, start_date, end_date, action, generated_by, created_at, statistics FROM report_records ORDER BY id DESC LIMIT 100");
        res.json({ success: true, records: r.rows });
    } catch (error) {
        console.error("Report register error:", error);
        res.status(500).json({ success: false, message: "Unable to load the report register." });
    }
}

module.exports = { getReports, sealReport, verifyReport, history, buildReport, codeFor };
