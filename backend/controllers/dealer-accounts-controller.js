/* The dealer's DAILY ACCOUNTS: everything a dealer needs to "close the day".

   GET /api/dealers/accounts/daily?date=YYYY-MM-DD      (a Nairobi day; default = today)

   For the chosen day it separates the money by HOW it was paid, because that decides who holds it:
     - CASH on delivery  : the dealer already holds the cash. GasHub's commission on those orders is taken from a later payout.
     - ONLINE (M-Pesa / bank): GasHub holds the money and pays the dealer later (goods - commission + delivery fee).
   plus orders cancelled or refunded that day (not counted), payouts the dealer received that day, and the last 7 days side by side.

   The numbers come from utils/dealer-money.js (the same rules as the Sales page, the Payouts page and the real payout run),
   so this page can never disagree with them. A SALE is a COMPLETED order that was not refunded, counted on the day it was completed. */
const { pool } = require("../config/database-config");
const { ensureRefundColumns } = require("../utils/refunds");
const { commissionPct, dealerSale, money } = require("../utils/dealer-money");

const TZ = "Africa/Nairobi";
const DAY = 86400000;
const nairobiDay = (d) => new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 10);
const dayMs = (key) => Date.parse(key + "T00:00:00Z");
const msDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const sum = (list, f) => money(list.reduce((t, x) => t + (Number(f(x)) || 0), 0));

async function safeRows(sql, params) {
    try { return (await pool.query(sql, params)).rows; } catch (e) { console.error("Daily accounts query:", e && e.message); return []; }
}

async function getDailyAccounts(req, res) {
    try {
        await ensureRefundColumns();
        const dealerId = req.dealer.dealer_id;
        const today = nairobiDay(new Date());
        let date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? String(req.query.date) : today;
        if (date > today) date = today;                                  /* the future has no accounts */
        const from = msDay(dayMs(date) - 6 * DAY);                       /* 7 days ending on the chosen day */

        const rate = (await pool.query("SELECT commission_rate FROM dealers WHERE id = $1", [dealerId])).rows[0];
        const pct = commissionPct(rate ? rate.commission_rate : null);

        /* completed, not refunded, in the 7-day window: counted on the day they were completed */
        const r = await pool.query(
            `SELECT o.id, o.order_number, o.payment_method, o.subtotal, o.discount_amount, o.points_used, o.delivery_fee, o.total_amount,
                    o.completed_at, u.full_name AS customer_name,
                    to_char(o.completed_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day,
                    COALESCE((SELECT string_agg(oi.quantity || ' x ' || oi.product_name || COALESCE(' ' || oi.cylinder_size, ''), ', ' ORDER BY oi.created_at)
                                FROM order_items oi WHERE oi.order_id = o.id), '') AS items
               FROM orders o LEFT JOIN users u ON u.id = o.customer_id
              WHERE o.dealer_id = $1 AND o.status::text = 'completed' AND o.completed_at IS NOT NULL
                AND o.refund_status IS NULL AND COALESCE(o.payment_status::text, '') <> 'refunded'
                AND o.completed_at >= (($2::date)::timestamp AT TIME ZONE '${TZ}')
                AND o.completed_at <  ((($3::date) + 1)::timestamp AT TIME ZONE '${TZ}')
              ORDER BY o.completed_at`, [dealerId, from, date]);

        const all = r.rows.map((o0) => {
            const o = o0;      /* an old order with no saved subtotal is handled inside dealerSale (utils/dealer-money.js), so every page agrees */
            const s = dealerSale(o, pct);
            /* what the customer handed over: the order total (a coin discount is already taken off it) */
            const paid = money(o.total_amount != null ? o.total_amount : s.goods + s.delivery);
            return { ...o, sale: s, customerPaid: paid };
        });

        /* has each online order been paid out to the dealer yet? */
        const ids = all.filter((o) => !o.sale.cash).map((o) => String(o.id));
        const payoutRows = ids.length ? await safeRows(
            `SELECT i.order_id, p.reference, p.status, p.paid_at
               FROM dealer_payout_orders i JOIN dealer_payouts p ON p.id = i.payout_id
              WHERE i.order_id = ANY($1::text[])`, [ids]) : [];
        const payoutOf = {};
        payoutRows.forEach((p) => { payoutOf[String(p.order_id)] = p; });

        const dayList = all.filter((o) => o.day === date);
        const cashOrders = dayList.filter((o) => o.sale.cash);
        const onlineOrders = dayList.filter((o) => !o.sale.cash);

        const orders = dayList.map((o) => {
            const p = payoutOf[String(o.id)];
            let payoutState = "cash";
            if (!o.sale.cash) payoutState = p ? (p.status === "paid" ? "paid" : p.status === "failed" ? "failed" : "scheduled") : "waiting";
            return {
                order_number: o.order_number, customer: o.customer_name || "Customer", items: o.items || "-",
                method: o.sale.cash ? "cash" : String(o.payment_method || "mpesa").toLowerCase(),
                completed_at: o.completed_at, customer_paid: o.customerPaid,
                goods: o.sale.goods, commission: o.sale.commission, delivery: o.sale.delivery, keep: o.sale.earned,
                payout_state: payoutState, payout_reference: p ? p.reference : null, payout_paid_at: p ? p.paid_at : null
            };
        });

        /* cancelled / rejected / refunded that day: shown for the dealer's records, never counted as a sale */
        const lost = await safeRows(
            `SELECT order_number, total_amount, payment_method, status::text AS status, refund_status
               FROM orders
              WHERE dealer_id = $1
                AND (status::text IN ('cancelled', 'rejected') OR refund_status IS NOT NULL)
                AND to_char(COALESCE(cancelled_at, updated_at) AT TIME ZONE '${TZ}', 'YYYY-MM-DD') = $2
              ORDER BY COALESCE(cancelled_at, updated_at) DESC LIMIT 100`, [dealerId, date]);

        /* payouts GasHub sent this dealer on the chosen day */
        const payouts = await safeRows(
            `SELECT reference, amount, sent_amount, mpesa_receipt, paid_at, destination
               FROM dealer_payouts
              WHERE dealer_id = $1 AND status = 'paid'
                AND to_char(paid_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') = $2
              ORDER BY paid_at`, [dealerId, date]);

        const summarise = (list) => {
            const cash = list.filter((o) => o.sale.cash), online = list.filter((o) => !o.sale.cash);
            return {
                orders: list.length,
                goods: sum(list, (o) => o.sale.goods),
                delivery: sum(list, (o) => o.sale.delivery),
                commission: sum(list, (o) => o.sale.commission),
                keep: sum(list, (o) => o.sale.earned),
                cash: { orders: cash.length, collected: sum(cash, (o) => o.customerPaid), commission: sum(cash, (o) => o.sale.commission), keep: sum(cash, (o) => o.sale.earned) },
                online: { orders: online.length, paid: sum(online, (o) => o.customerPaid), commission: sum(online, (o) => o.sale.commission), owed: sum(online, (o) => o.sale.net) }
            };
        };

        /* the 7 days side by side */
        const week = [];
        for (let i = 6; i >= 0; i--) {
            const key = msDay(dayMs(date) - i * DAY);
            const s = summarise(all.filter((o) => o.day === key));
            week.push({ day: key, orders: s.orders, goods: s.goods, cash: s.cash.collected, online: s.online.paid, commission: s.commission, keep: s.keep });
        }

        const day = summarise(dayList);
        const paidOutToday = sum(payouts, (p) => (p.sent_amount != null ? p.sent_amount : p.amount));
        const outstanding = sum(onlineOrders.filter((o) => { const p = payoutOf[String(o.id)]; return !p || p.status !== "paid"; }), (o) => o.sale.net);

        res.set("Cache-Control", "no-store");
        res.json({
            success: true, date, today, commission_rate: pct,
            summary: day,
            /* the end-of-day sheet: the three numbers a dealer reconciles against */
            close: {
                cash_in_hand: day.cash.collected,              /* cash the dealer should have collected from customers today */
                cash_commission_owed: day.cash.commission,     /* GasHub takes this from a later payout */
                cash_you_keep: day.cash.keep,
                online_owed_by_gashub: day.online.owed,        /* GasHub pays this out later */
                online_not_yet_paid_out: outstanding
            },
            orders, cancelled: lost.map((c) => ({ order_number: c.order_number, amount: money(c.total_amount), method: String(c.payment_method || "").toLowerCase(), status: c.status, refund_status: c.refund_status })),
            payouts_today: payouts.map((p) => ({ reference: p.reference, amount: money(p.sent_amount != null ? p.sent_amount : p.amount), receipt: p.mpesa_receipt, paid_at: p.paid_at, destination: p.destination })),
            payouts_today_total: paidOutToday,
            week
        });
    } catch (error) {
        console.error("Daily accounts error:", error);
        res.status(500).json({ success: false, message: "Unable to load your daily accounts. Please try again." });
    }
}

module.exports = { getDailyAccounts };
