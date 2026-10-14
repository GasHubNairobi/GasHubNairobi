/* Remembers which product a signed-in customer opened checkout for.
   The admin's "Selected item reminder" uses this to nudge customers who did not finish the order.
   POST /api/my/selections   body: { product_id } */
const { pool } = require("../config/database-config");

async function recordSelection(req, res) {
    try {
        if (!req.user || String(req.user.role || "customer") !== "customer") return res.json({ success: true });
        const productId = parseInt((req.body || {}).product_id, 10);
        if (!Number.isInteger(productId) || productId < 1) return res.status(400).json({ success: false, message: "Choose a product." });

        /* same product again: refresh the time; a new reminder is only allowed 7 days after the last one */
        await pool.query(
            `INSERT INTO customer_item_selections (user_id, product_id)
             SELECT $1, p.id FROM products p WHERE p.id = $2
             ON CONFLICT (user_id, product_id) DO UPDATE
               SET selected_at = NOW(),
                   reminder_sent_at = CASE WHEN customer_item_selections.reminder_sent_at < NOW() - INTERVAL '7 days'
                                           THEN NULL ELSE customer_item_selections.reminder_sent_at END`,
            [req.user.id, productId]);
        res.json({ success: true });
    } catch (error) {
        /* never get in the customer's way */
        console.error("Record selection error:", error.message);
        res.json({ success: true });
    }
}

module.exports = { recordSelection };
