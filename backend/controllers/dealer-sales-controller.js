/* The dealer's Sales page and dashboard graph.
   A SALE is a COMPLETED order (delivered and paid) that was not refunded - the same orders the payouts are made from.
   Money is worked out with utils/dealer-money.js, so these numbers match Payouts and the admin's dealer page.
   Days are Nairobi days.   GET /api/dealers/sales/mine?period=7days|30days|90days|year */
const { pool } = require("../config/database-config");
const { ensureRefundColumns } = require("../utils/refunds");
const { commissionPct, dealerSale, money, hideCoinDiscount } = require("../utils/dealer-money");

const TZ = "Africa/Nairobi";
const DAY = 86400000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* "YYYY-MM-DD" of a moment in Nairobi (Kenya has no daylight saving: always UTC+3) */
const nairobiDay = (d) => new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 10);
const dayToMs = (key) => Date.parse(key + "T00:00:00Z");
const msToDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/* the chart buckets for a period, oldest first, ending today: [{ key, label, from, to }] (from/to are day keys, inclusive) */
function buildBuckets(period, today) {
    const t = dayToMs(today);
    const out = [];
    if (period === "7days") {
        for (let i = 6; i >= 0; i--) {
            const ms = t - i * DAY;
            out.push({ label: WEEKDAY[new Date(ms).getUTCDay()], from: msToDay(ms), to: msToDay(ms) });
        }
    } else if (period === "90days") {
        /* 13 weeks, each ending on the day shown */
        for (let i = 12; i >= 0; i--) {
            const end = t - i * 7 * DAY, start = end - 6 * DAY;
            const d = new Date(start);
            out.push({ label: `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`, from: msToDay(start), to: msToDay(end) });
        }
    } else if (period === "year") {
        const now = new Date(t);
        for (let i = 11; i >= 0; i--) {
            const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1);
            const last = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 0);
            out.push({ label: MON[new Date(first).getUTCMonth()], from: msToDay(first), to: msToDay(last) });
        }
    } else {
        /* 30 days: 30 daily points, labelled every few days */
        for (let i = 29; i >= 0; i--) {
            const ms = t - i * DAY, d = new Date(ms);
            out.push({ label: `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`, from: msToDay(ms), to: msToDay(ms) });
        }
    }
    return out;
}

const REFILL_RE = /refill|swap/i;
const ACCESSORY_RE = /regulator|hose|burner|grill|stove|accessor|lighter|kit\b/i;
/* The category the dealer picked for the product decides first: Gas Refill, New Gas Cylinders, Gas Cylinder Only (empty),
   Gas Accessories, Commercial Gas. Older products (or a deleted product) fall back to the words in the product name. */
function kindOf(category, name) {
    const c = String(category || "").toLowerCase();
    if (/access/.test(c)) return "accessory";
    if (/commercial|industrial/.test(c)) return "commercial";
    if (/refill/.test(c)) return "refill";
    if (/empty|cylinder only/.test(c)) return "empty";
    if (/cylinder/.test(c)) return "new";
    if (REFILL_RE.test(name)) return "refill";
    if (ACCESSORY_RE.test(name)) return "accessory";
    return "new";
}

async function getMySales(req, res) {
    try {
        await ensureRefundColumns();
        const dealerId = req.dealer.dealer_id;
        const period = ["7days", "30days", "90days", "year"].includes(String(req.query.period)) ? String(req.query.period) : "30days";
        const today = nairobiDay(new Date());
        const buckets = buildBuckets(period, today);
        const periodFrom = buckets[0].from;
        /* the previous stretch of the same length, so the page can say "vs last period" (and today vs yesterday) */
        const spanDays = Math.round((dayToMs(today) - dayToMs(periodFrom)) / DAY) + 1;
        const prevFrom = msToDay(dayToMs(periodFrom) - spanDays * DAY);

        const rate = (await pool.query("SELECT commission_rate FROM dealers WHERE id = $1", [dealerId])).rows[0];
        const pct = commissionPct(rate ? rate.commission_rate : null);

        /* completed, paid, not refunded; counted on the day the order was completed */
        const r = await pool.query(
            `SELECT o.id, o.order_number, o.payment_method, o.subtotal, o.discount_amount, o.points_used, o.delivery_fee, o.total_amount,
                    o.completed_at, o.status::text AS status, o.fulfilment, u.full_name AS customer_name,
                    to_char(o.completed_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day,
                    COALESCE((SELECT json_agg(json_build_object('name', oi.product_name, 'size', oi.cylinder_size, 'qty', oi.quantity, 'category', (SELECT p.category::text FROM products p WHERE p.id::text = oi.product_id::text LIMIT 1)) ORDER BY oi.created_at)
                                FROM order_items oi WHERE oi.order_id = o.id), '[]'::json) AS items
               FROM orders o LEFT JOIN users u ON u.id = o.customer_id
              WHERE o.dealer_id = $1 AND o.status::text = 'completed' AND o.completed_at IS NOT NULL
                AND o.refund_status IS NULL AND COALESCE(o.payment_status::text, '') <> 'refunded'
                AND o.completed_at >= (($2::date)::timestamp AT TIME ZONE '${TZ}')
              ORDER BY o.completed_at DESC
              LIMIT 5000`, [dealerId, prevFrom]);

        const sales = r.rows.map((o) => {
            const s = dealerSale(o, pct);
            const items = Array.isArray(o.items) ? o.items : [];
            const units = { refill: 0, new: 0, empty: 0, accessory: 0, commercial: 0 };
            items.forEach((i) => { units[kindOf(i.category, `${i.name || ""} ${i.size || ""}`)] += Number(i.qty) || 0; });
            return { ...hideCoinDiscount(o), sale: s, units, qty: items.reduce((t, i) => t + (Number(i.qty) || 0), 0) };
        });

        const inRange = (o, from, to) => o.day >= from && o.day <= to;
        const sum = (list, f) => money(list.reduce((t, o) => t + f(o), 0));
        const current = sales.filter((o) => inRange(o, periodFrom, today));
        const previous = sales.filter((o) => inRange(o, prevFrom, msToDay(dayToMs(periodFrom) - DAY)));
        const todayList = sales.filter((o) => o.day === today);
        const yesterday = msToDay(dayToMs(today) - DAY);
        const yesterdayList = sales.filter((o) => o.day === yesterday);

        const revenueOf = (list) => sum(list, (o) => o.sale.goods);                 /* goods sold, after the dealer's own discounts */
        const marginOf = (list) => sum(list, (o) => o.sale.goods - o.sale.commission); /* goods minus GasHub commission */

        /* the chart: revenue per bucket */
        const values = buckets.map((b) => revenueOf(current.filter((o) => inRange(o, b.from, b.to))));
        const cylinders = (list) => list.reduce((t, o) => t + o.units.refill + o.units.new + o.units.empty + o.units.commercial, 0);

        /* completion rate: of the orders that ended in this period (completed + cancelled/rejected), how many were completed */
        const closed = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE status::text = 'completed')::int AS done,
                    COUNT(*) FILTER (WHERE status::text IN ('cancelled', 'rejected'))::int AS lost
               FROM orders
              WHERE dealer_id = $1 AND COALESCE(completed_at, cancelled_at, updated_at) >= (($2::date)::timestamp AT TIME ZONE '${TZ}')`,
            [dealerId, periodFrom]);
        const done = closed.rows[0].done, lost = closed.rows[0].lost;

        const pctChange = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : (now > 0 ? null : 0));
        const revenue = revenueOf(current);

        res.set("Cache-Control", "no-store");
        res.json({
            success: true,
            period, commission_rate: pct,
            chart: { labels: buckets.map((b) => b.label), values },
            period_summary: {
                revenue, orders: current.length, cylinders: cylinders(current),
                completion_rate: done + lost > 0 ? Math.round((done / (done + lost)) * 1000) / 10 : null,
                revenue_change_pct: pctChange(revenue, revenueOf(previous))
            },
            today: {
                revenue: revenueOf(todayList), yesterday_revenue: revenueOf(yesterdayList),
                change_pct: pctChange(revenueOf(todayList), revenueOf(yesterdayList))
            },
            totals: {
                refills_sold: current.reduce((t, o) => t + o.units.refill, 0),
                new_cylinders_sold: current.reduce((t, o) => t + o.units.new, 0),
                empty_cylinders_sold: current.reduce((t, o) => t + o.units.empty, 0),
                accessories_sold: current.reduce((t, o) => t + o.units.accessory, 0),
                commercial_sold: current.reduce((t, o) => t + o.units.commercial, 0),
                gross_sales: revenue,
                commission: sum(current, (o) => o.sale.commission),
                delivery_fees: sum(current, (o) => o.sale.delivery),
                net_margin: marginOf(current),
                margin_pct: revenue > 0 ? Math.round((marginOf(current) / revenue) * 1000) / 10 : 0
            },
            all_time: { revenue: revenueOf(sales), orders: sales.length },
            transactions: current.slice(0, 200).map((o) => ({
                id: o.id, order_number: o.order_number, customer_name: o.customer_name || "Customer",
                items: o.items, payment_method: o.payment_method, fulfilment: o.fulfilment, status: o.status,
                goods: o.sale.goods, commission: o.sale.commission, delivery_fee: o.sale.delivery, earned: o.sale.earned,
                total_paid: Number(o.total_amount) || 0, completed_at: o.completed_at
            }))
        });
    } catch (error) {
        console.error("Dealer sales error:", error);
        res.status(500).json({ success: false, message: "Unable to load your sales." });
    }
}

module.exports = { getMySales, buildBuckets };
