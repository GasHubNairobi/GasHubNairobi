const userModel = require("../models/user-model");
const orderModel = require("../models/order-model");
const { formatOrderStatus, formatPaymentStatus } = require("../utils/assistant");

async function getCustomerOrders(req, res) {
        try {
            const result = await orderModel.query(
                `
                SELECT
                    o.id,
                    o.order_number,
                    o.customer_id,
                    o.dealer_id,
                    o.status,
                    o.payment_method,
                    o.payment_status,
                    o.subtotal,
                    o.delivery_fee,
                    o.total_amount,
                    o.delivery_address,
                    o.delivery_phone,
                    o.delivery_notes,
                    o.customer_notes,
                    o.created_at,
                    o.updated_at,

                    d.business_name AS dealer_name,

                    COALESCE(
                        JSON_AGG(
                            JSON_BUILD_OBJECT(
                                'id', oi.id,
                                'product_id',
                                    oi.product_id,
                                'product_name',
                                    oi.product_name,
                                'cylinder_size',
                                    oi.cylinder_size,
                                'quantity',
                                    oi.quantity,
                                'unit_price',
                                    oi.unit_price,
                                'total_price',
                                    oi.total_price
                            )
                            ORDER BY oi.created_at
                        )
                        FILTER (
                            WHERE oi.id IS NOT NULL
                        ),
                        '[]'
                    ) AS items

                FROM orders o

                LEFT JOIN dealers d
                    ON d.id = o.dealer_id

                LEFT JOIN order_items oi
                    ON oi.order_id = o.id

                WHERE o.customer_id = $1

                GROUP BY o.id, d.business_name

                ORDER BY o.created_at DESC
                `,
                [req.params.id]
            );

            res.json({
                success: true,
                orders: result.rows
            });
        } catch (error) {
            console.error(
                "Customer orders error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load customer orders."
            });
        }
    
}

async function getCustomerProfile(req, res) {
        try {
            const result =
                await userModel.query(
                    `
                    SELECT
                        id,
                        user_code,
                        full_name,
                        phone,
                        email,
                        role,
                        status,
                        profile_image,
                        default_address,
                        city,
                        county,
                        created_at,
                        updated_at,
                        last_login_at

                    FROM users

                    WHERE id = $1
                      AND role = 'customer'

                    LIMIT 1
                    `,
                    [req.params.id]
                );

            if (
                result.rows.length === 0
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Customer not found."
                });
            }

            res.json({
                success: true,
                customer:
                    result.rows[0]
            });
        } catch (error) {
            console.error(
                "Get customer error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load customer."
            });
        }
    
}

module.exports = {
    getCustomerOrders,
    getCustomerProfile,
};
