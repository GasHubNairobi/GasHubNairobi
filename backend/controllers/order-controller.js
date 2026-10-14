const orderModel = require("../models/order-model");
const { pool } = require("../config/database-config");
const { ensureRefundColumns, settleCancelledOrder } = require("../utils/refunds");
const { formatOrderStatus, formatPaymentStatus, normalizeStatus } = require("../utils/assistant");

async function getOrders(req, res) {
    try {
        const result = await orderModel.query(`
            SELECT
                o.id,
                o.order_number,
                o.customer_id,
                o.dealer_id,
                o.status,
                o.payment_method,
                o.payment_method_chosen,
                o.payment_status,
                o.subtotal,
                o.delivery_fee,
                o.total_amount,
                o.delivery_address,
                o.delivery_phone,
                o.delivery_notes,
                o.customer_notes,
                o.confirmed_at,
                o.delivered_at,
                o.completed_at,
                o.cancelled_at,
                o.cancellation_reason,
                o.created_at,
                o.updated_at,

                u.full_name AS customer_name,
                u.phone AS customer_phone,
                u.email AS customer_email,

                d.business_name AS dealer_name,
                d.logo AS dealer_logo,

                (
                    SELECT oi.product_name
                    FROM order_items oi
                    WHERE oi.order_id = o.id
                    ORDER BY oi.created_at ASC
                    LIMIT 1
                ) AS product_name,

                (
                    SELECT COALESCE(
                        SUM(oi.quantity),
                        0
                    )
                    FROM order_items oi
                    WHERE oi.order_id = o.id
                ) AS quantity

            FROM orders o

            LEFT JOIN users u
                ON u.id = o.customer_id

            LEFT JOIN dealers d
                ON d.id = o.dealer_id

            ORDER BY o.created_at DESC
        `);

        res.json({
            success: true,

            orders: result.rows.map((order) => ({
                ...order,
                status_label:
                    formatOrderStatus(
                        order.status
                    ),
                payment_status_label:
                    formatPaymentStatus(
                        order.payment_status
                    )
            }))
        });
    } catch (error) {
        console.error(
            "Get orders error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to load orders."
        });
    }

}

async function getOrderById(req, res) {
        try {
            const orderResult = await orderModel.query(
                `
                SELECT
                    o.*,

                    u.full_name AS customer_name,
                    u.phone AS customer_phone,
                    u.email AS customer_email,

                    d.business_name AS dealer_name,
                d.logo AS dealer_logo,
                    d.phone AS dealer_phone,
                    d.email AS dealer_email

                FROM orders o

                LEFT JOIN users u
                    ON u.id = o.customer_id

                LEFT JOIN dealers d
                    ON d.id = o.dealer_id

                WHERE o.id = $1
                   OR o.order_number = $1

                LIMIT 1
                `,
                [req.params.orderId]
            );

            if (orderResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Order not found."
                });
            }

            const order = orderResult.rows[0];

            const itemsResult = await orderModel.query(
                `
                SELECT
                    oi.id,
                    oi.product_id,
                    oi.product_name,
                    oi.cylinder_size,
                    oi.quantity,
                    oi.unit_price,
                    oi.total_price

                FROM order_items oi

                WHERE oi.order_id = $1

                ORDER BY oi.created_at
                `,
                [order.id]
            );

            const paymentsResult = await orderModel.query(
                `
                SELECT
                    id,
                    payment_reference,
                    transaction_code,
                    amount,
                    method,
                    status,
                    phone_number,
                    mpesa_receipt_number,
                    proof_image,
                    notes,
                    paid_at,
                    created_at

                FROM payments

                WHERE order_id = $1

                ORDER BY created_at DESC
                `,
                [order.id]
            );

            res.json({
                success: true,

                order: {
                    ...order,

                    status_label:
                        formatOrderStatus(
                            order.status
                        ),

                    payment_status_label:
                        formatPaymentStatus(
                            order.payment_status
                        ),

                    items: itemsResult.rows,

                    payments:
                        paymentsResult.rows
                }
            });
        } catch (error) {
            console.error(
                "Get order error:",
                error
            );

            res.status(500).json({
                success: false,
                message: "Unable to load order."
            });
        }
    
}

async function createOrder(req, res) {
    const client = await orderModel.getClient();

    try {
        const {
            customer_id,
            product_id,
            quantity,
            items,
            dealer_id,
            payment_method,
            delivery_address,
            delivery_phone,
            delivery_notes,
            customer_notes
        } = req.body;

        if (!customer_id || !delivery_address) {
            return res.status(400).json({
                success: false,
                message:
                    "Customer and delivery address are required."
            });
        }

        await client.query("BEGIN");

        const customerResult = await client.query(
            `
            SELECT
                id,
                phone,
                default_address

            FROM users

            WHERE id = $1
              AND role = 'customer'

            LIMIT 1
            `,
            [customer_id]
        );

        if (customerResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                success: false,
                message: "Customer not found."
            });
        }

        let requestedItems = [];

        if (
            Array.isArray(items) &&
            items.length > 0
        ) {
            requestedItems = items;
        } else if (product_id) {
            requestedItems = [
                {
                    product_id,
                    quantity: quantity || 1
                }
            ];
        }

        if (requestedItems.length === 0) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message:
                    "At least one product is required."
            });
        }

        let subtotal = 0;
        let selectedDealerId =
            dealer_id || null;

        const orderItems = [];

        for (const item of requestedItems) {
            const productResult =
                await client.query(
                    `
                    SELECT
                        id,
                        dealer_id,
                        name,
                        cylinder_size,
                        price,
                        status,
                        stock_quantity

                    FROM products

                    WHERE id = $1

                    LIMIT 1
                    `,
                    [item.product_id]
                );

            if (
                productResult.rows.length === 0
            ) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    success: false,
                    message:
                        "One of the selected products was not found."
                });
            }

            const product =
                productResult.rows[0];

            const itemQuantity = Math.max(
                1,
                Number(item.quantity || 1)
            );

            if (product.status !== "available") {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message:
                        `${product.name} is not currently available.`
                });
            }

            if (
                Number(product.stock_quantity) > 0 &&
                itemQuantity >
                    Number(product.stock_quantity)
            ) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message:
                        `Insufficient stock for ${product.name}.`
                });
            }

            if (!selectedDealerId) {
                selectedDealerId =
                    product.dealer_id;
            }

            const itemTotal =
                Number(product.price) *
                itemQuantity;

            subtotal += itemTotal;

            orderItems.push({
                product_id: product.id,
                product_name: product.name,
                cylinder_size:
                    product.cylinder_size,
                quantity: itemQuantity,
                unit_price:
                    Number(product.price),
                total_price: itemTotal
            });
        }

        const deliveryFee = 0;
        const totalAmount =
            subtotal + deliveryFee;

        const orderResult = await client.query(
            `
            INSERT INTO orders (
                customer_id,
                dealer_id,
                status,
                payment_method,
                payment_status,
                subtotal,
                delivery_fee,
                total_amount,
                delivery_address,
                delivery_phone,
                delivery_notes,
                customer_notes
            )
            VALUES (
                $1,
                $2,
                'pending',
                $3,
                'pending',
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10
            )
            RETURNING *
            `,
            [
                customer_id,
                selectedDealerId,
                payment_method || "mpesa",
                subtotal,
                deliveryFee,
                totalAmount,
                delivery_address,
                delivery_phone ||
                    customerResult.rows[0].phone ||
                    null,
                delivery_notes || null,
                customer_notes || null
            ]
        );

        const order =
            orderResult.rows[0];

        for (const item of orderItems) {
            await client.query(
                `
                INSERT INTO order_items (
                    order_id,
                    product_id,
                    product_name,
                    cylinder_size,
                    quantity,
                    unit_price,
                    total_price
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7
                )
                `,
                [
                    order.id,
                    item.product_id,
                    item.product_name,
                    item.cylinder_size,
                    item.quantity,
                    item.unit_price,
                    item.total_price
                ]
            );

            await client.query(
                `
                UPDATE products

                SET
                    stock_quantity =
                        GREATEST(
                            stock_quantity - $1,
                            0
                        ),

                    status =
                        CASE
                            WHEN stock_quantity - $1 <= 0
                            THEN 'out_of_stock'::product_status
                            ELSE status
                        END

                WHERE id = $2
                `,
                [
                    item.quantity,
                    item.product_id
                ]
            );
        }

        await client.query("COMMIT");

        res.status(201).json({
            success: true,
            message:
                "Order created successfully.",
            order
        });
    } catch (error) {
        await client.query("ROLLBACK");

        console.error(
            "Create order error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to create order."
        });
    } finally {
        client.release();
    }

}

/* PATCH /api/orders/:orderId/cancel  (admin only)
   Cancels an order from the admin Orders page. Puts the stock back, settles the customer's points and, if GasHub already
   holds the customer's money, starts a refund for GasHub to send back. */
async function cancelOrder(req, res) {
    await ensureRefundColumns().catch((e) => console.error("Refund columns:", e.message));
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const reason = String((req.body && req.body.cancellation_reason) || "").trim().slice(0, 300) || "Cancelled by GasHub admin.";
        const found = (await client.query(
            "SELECT * FROM orders WHERE (id::text = $1 OR order_number = $1) FOR UPDATE", [String(req.params.orderId)])).rows[0];
        if (!found || ["completed", "delivered", "cancelled", "rejected"].includes(String(found.status))) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "Order cannot be cancelled or was not found." });
        }
        const upd = (await client.query(
            "UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancellation_reason = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
            [reason, found.id])).rows[0];
        const refund = await settleCancelledOrder(client, found, { restock: true, reason });
        await client.query("COMMIT");
        res.json({
            success: true,
            message: refund.refundPending
                ? `Order cancelled. A refund of KSh ${refund.amount.toLocaleString("en-KE")} was added to Payments > Refunds.`
                : "Order cancelled successfully.",
            refund: refund.refundPending ? { status: "pending", amount: refund.amount, phone: refund.phone } : null,
            order: upd
        });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        console.error("Cancel order error:", error);
        res.status(500).json({ success: false, message: "Unable to cancel order." });
    } finally {
        client.release();
    }
}

module.exports = {
    getOrders,
    getOrderById,
    createOrder,
    cancelOrder,
};