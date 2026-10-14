const reviewModel = require("../models/review-model");

/*
|--------------------------------------------------------------------------
| DEALER REVIEWS
|--------------------------------------------------------------------------
| Customers rate a dealer once an order is COMPLETED. A popup (frontend/
| customer-review-popup.js) asks for the rating on whatever page the customer
| is on. The same reviews are then shown to the dealer (dealer-reviews.html)
| and to the admin (admin-reviews.html).
|
| Rows live in the existing "reviews" table, one review per order.
| The extra columns are created automatically the first time they are needed
| (the same way the rest of GasHub does it); backend/reviews-migration.sql does
| the same thing if you prefer to run it by hand.
*/

const PENDING_WINDOW_DAYS = 30;     /* only ask about orders completed in the last 30 days */
const HIDDEN_STATUSES = ["rejected", "hidden", "deleted"];

let schemaReady = null;

async function ensureReviewSchema() {
    if (schemaReady) return schemaReady;
    schemaReady = (async () => {
        const t = await reviewModel.query(
            `SELECT data_type FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name = 'id'`
        );
        const type = String((t.rows[0] && t.rows[0].data_type) || "").toLowerCase();
        const sqlType = type === "uuid" ? "UUID" : type === "bigint" ? "BIGINT" : type === "integer" ? "INTEGER" : "UUID";

        await reviewModel.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS order_id ${sqlType}`);
        await reviewModel.query("ALTER TABLE reviews ADD COLUMN IF NOT EXISTS comment TEXT");
        await reviewModel.query("ALTER TABLE reviews ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()");
        await reviewModel.query("ALTER TABLE reviews ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()");
        await reviewModel.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_skipped_at TIMESTAMPTZ");
        try {
            await reviewModel.query(
                "CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_per_order ON reviews (order_id) WHERE order_id IS NOT NULL"
            );
        } catch (error) {
            console.warn("Could not add the one-review-per-order index:", error.message);
        }
    })().catch((error) => {
        schemaReady = null;
        throw error;
    });
    return schemaReady;
}

function needCustomer(req, res) {
    if (!req.user || req.user.role !== "customer") {
        res.status(403).json({ success: false, message: "Customer account required." });
        return false;
    }
    return true;
}

/* GET /api/my/reviews/pending
   The newest completed order that still has no review and was not skipped. */
async function getPendingReview(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        await ensureReviewSchema();
        const r = await reviewModel.query(
            `SELECT o.id, o.order_number, o.dealer_id, o.completed_at, o.delivered_at,
                    d.business_name AS dealer_name,
                    (SELECT oi.product_name FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.created_at ASC LIMIT 1) AS first_product
             FROM orders o
             JOIN dealers d ON d.id = o.dealer_id
             WHERE o.customer_id = $1
               AND o.status::text = 'completed'
               AND o.review_skipped_at IS NULL
               AND COALESCE(o.completed_at, o.delivered_at, o.updated_at) > NOW() - ($2 || ' days')::interval
               AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.id)
             ORDER BY COALESCE(o.completed_at, o.delivered_at, o.updated_at) DESC
             LIMIT 1`,
            [req.user.id, String(PENDING_WINDOW_DAYS)]
        );
        const o = r.rows[0];
        res.set("Cache-Control", "no-store");
        res.json({
            success: true,
            order: o ? {
                id: o.id,
                orderNumber: o.order_number,
                dealerId: o.dealer_id,
                dealerName: o.dealer_name,
                product: o.first_product || "",
                completedAt: o.completed_at || o.delivered_at
            } : null
        });
    } catch (error) {
        console.error("Pending review error:", error);
        res.status(500).json({ success: false, message: "Unable to check for reviews." });
    }
}

/* POST /api/my/reviews   { orderId, rating, comment } */
async function submitReview(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        await ensureReviewSchema();
        const b = req.body || {};
        const rating = Math.round(Number(b.rating));
        const comment = String(b.comment || "").trim().slice(0, 500);

        if (!b.orderId) return res.status(400).json({ success: false, message: "Missing order." });
        if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
            return res.status(400).json({ success: false, field: "rating", message: "Please choose a rating from 1 to 5 stars." });
        }

        const o = (await reviewModel.query(
            "SELECT id, dealer_id, status::text AS status FROM orders WHERE id::text = $1 AND customer_id = $2 LIMIT 1",
            [String(b.orderId), req.user.id]
        )).rows[0];
        if (!o) return res.status(404).json({ success: false, message: "Order not found." });
        if (o.status !== "completed") {
            return res.status(400).json({ success: false, message: "You can review a dealer after the order is completed." });
        }

        const dup = await reviewModel.query("SELECT 1 FROM reviews WHERE order_id = $1 LIMIT 1", [o.id]);
        if (dup.rows.length) return res.status(409).json({ success: false, message: "You have already reviewed this order." });

        await reviewModel.query(
            "INSERT INTO reviews (customer_id, dealer_id, order_id, rating, comment) VALUES ($1, $2, $3, $4, $5)",
            [req.user.id, o.dealer_id, o.id, rating, comment || null]
        );
        res.status(201).json({ success: true, message: "Thank you for your review!" });
    } catch (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "You have already reviewed this order." });
        console.error("Submit review error:", error);
        res.status(500).json({ success: false, message: "Unable to save your review. Please try again." });
    }
}

/* POST /api/my/reviews/skip   { orderId }   ("Maybe later" does not ask again for this order) */
async function skipReview(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        await ensureReviewSchema();
        await reviewModel.query(
            "UPDATE orders SET review_skipped_at = NOW() WHERE id::text = $1 AND customer_id = $2",
            [String((req.body || {}).orderId || ""), req.user.id]
        );
        res.json({ success: true });
    } catch (error) {
        console.error("Skip review error:", error);
        res.status(500).json({ success: false, message: "Unable to save that." });
    }
}

/* GET /api/dealers/reviews/mine   (dealer sees reviews about their own shop) */
async function getMyDealerReviews(req, res) {
    try {
        await ensureReviewSchema();
        const dealerId = req.dealer.dealer_id;
        const rows = (await reviewModel.query(
            `SELECT r.id, r.rating, r.comment, r.created_at, r.admin_response,
                    u.full_name AS customer_name, o.order_number
             FROM reviews r
             LEFT JOIN users u ON u.id = r.customer_id
             LEFT JOIN orders o ON o.id = r.order_id
             WHERE r.dealer_id = $1 AND r.rating IS NOT NULL
               AND COALESCE(r.status::text, '') <> ALL($2::text[])
             ORDER BY r.created_at DESC
             LIMIT 500`,
            [dealerId, HIDDEN_STATUSES]
        )).rows;

        const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        let sum = 0;
        rows.forEach((x) => { const n = Number(x.rating); if (counts[n] !== undefined) counts[n]++; sum += n; });

        res.set("Cache-Control", "no-store");
        res.json({
            success: true,
            summary: { count: rows.length, average: rows.length ? Math.round((sum / rows.length) * 10) / 10 : 0, counts },
            reviews: rows
        });
    } catch (error) {
        console.error("Dealer reviews error:", error);
        res.status(500).json({ success: false, message: "Unable to load your reviews." });
    }
}

/* GET /api/admin/reviews */
async function getReviews(req, res) {
    try {
        await ensureReviewSchema();
        const result = await reviewModel.query(`
            SELECT
                r.id, r.customer_id, r.dealer_id, r.product_id, r.order_id,
                r.rating, r.title, r.comment, r.status, r.admin_response,
                r.created_at, r.updated_at,
                u.full_name AS customer_name,
                u.email AS customer_email,
                d.business_name AS dealer_name,
                p.name AS product_name,
                p.product_code,
                o.order_number
            FROM reviews r
            LEFT JOIN users u ON u.id = r.customer_id
            LEFT JOIN dealers d ON d.id = r.dealer_id
            LEFT JOIN products p ON p.id = r.product_id
            LEFT JOIN orders o ON o.id = r.order_id
            ORDER BY r.created_at DESC
        `);
        res.json({ success: true, reviews: result.rows });
    } catch (error) {
        console.error("Get reviews error:", error);
        res.status(500).json({ success: false, message: "Unable to load reviews." });
    }
}

/* PATCH /api/admin/reviews/:id   { status: "published" | "hidden" } */
async function updateReviewStatus(req, res) {
    try {
        const status = String((req.body || {}).status || "").toLowerCase();
        if (!["published", "hidden"].includes(status)) {
            return res.status(400).json({ success: false, message: "Status must be published or hidden." });
        }
        const r = await reviewModel.query(
            "UPDATE reviews SET status = $1, updated_at = NOW() WHERE id::text = $2 RETURNING id",
            [status, String(req.params.id)]
        );
        if (!r.rows.length) return res.status(404).json({ success: false, message: "Review not found." });
        res.json({ success: true });
    } catch (error) {
        console.error("Update review status error:", error);
        res.status(500).json({ success: false, message: "Unable to update this review." });
    }
}

module.exports = {
    getReviews,
    updateReviewStatus,
    getPendingReview,
    submitReview,
    skipReview,
    getMyDealerReviews,
    ensureReviewSchema
};
