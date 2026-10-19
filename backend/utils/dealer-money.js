/* One place that works out what a dealer earns from an order, so the dealer's Sales page, dashboard graph, Payouts,
   the real payout run and the admin's dealer page can never disagree.

   - Commission is charged on the goods the dealer actually sold: subtotal minus any discount the DEALER gave.
     A discount made with GasHub Coins is paid for by GasHub, so it never lowers the dealer's sale
     (a coin discount is the one stored together with points_used > 0).
   - The delivery fee belongs to the dealer and has no commission.
   - Online order: GasHub holds the customer's money, so the dealer is owed  goods - commission + delivery fee.
   - Cash order: the dealer already holds the cash, so only the commission is taken back  (net = -commission). */

const DEFAULT_COMMISSION_RATE = 5;
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

function commissionPct(saved) {
    return saved === null || saved === undefined || saved === "" ? DEFAULT_COMMISSION_RATE : Number(saved);
}

function isCashMethod(method) {
    return String(method || "").toLowerCase() === "cash";
}

/* order needs: subtotal (or total_amount), discount_amount, points_used, delivery_fee, payment_method (missing columns count as 0) */
function dealerSale(order, pct) {
    /* an old order may have no saved subtotal: work it back from the total (total = subtotal + delivery fee - discount) */
    const hasSubtotal = order.subtotal !== null && order.subtotal !== undefined && order.subtotal !== "" && Number.isFinite(Number(order.subtotal));
    const subtotal = hasSubtotal ? money(order.subtotal)
        : Math.max(0, money(Number(order.total_amount || 0) - Number(order.delivery_fee || 0) + Math.max(0, Number(order.discount_amount) || 0)));
    const usedCoins = Number(order.points_used) > 0;
    const dealerDiscount = usedCoins ? 0 : Math.min(subtotal, Math.max(0, money(order.discount_amount)));
    const goods = money(subtotal - dealerDiscount);
    const commission = money(goods * Number(pct) / 100);
    const delivery = money(order.delivery_fee);
    const cash = isCashMethod(order.payment_method);
    return {
        cash, subtotal, dealerDiscount, goods, commission, delivery,
        net: cash ? -commission : money(goods - commission + delivery),   /* what moves in the payout */
        earned: money(goods - commission + delivery)                      /* what the dealer keeps from the order, either way */
    };
}

module.exports = { DEFAULT_COMMISSION_RATE, commissionPct, dealerSale, money, isCashMethod };
