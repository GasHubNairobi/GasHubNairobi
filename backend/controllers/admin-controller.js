const bcrypt = require("bcryptjs");
const adminModel = require("../models/user-model");
const { normalizeStatus, normalizeAdminRole, formatAdmin, formatOrderStatus, formatPaymentStatus, formatComplaintStatus, formatCurrency, generateCode, generateToken, getBearerToken } = require("../utils/assistant");
const { adminSessions } = require("../middleware/admin-authentication");
const { pool } = require("../config/database-config");
const { ensureRefundColumns, settleCancelledOrder } = require("../utils/refunds");

async function adminLogin(req, res) {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: "Username/email and password are required."
            });
        }

        const result = await adminModel.query(
            `
            SELECT
                id,
                user_code,
                full_name,
                phone,
                email,
                password_hash,
                role,
                status,
                profile_image,
                created_at,
                updated_at,
                last_login_at
            FROM users
            WHERE role = 'admin'
              AND (
                    LOWER(email) = LOWER($1)
                    OR LOWER(user_code) = LOWER($1)
              )
            LIMIT 1
            `,
            [String(username).trim()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid administrator credentials."
            });
        }

        const admin = result.rows[0];

        if (admin.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "This administrator account is not active."
            });
        }

        const passwordMatches = await bcrypt.compare(
            password,
            admin.password_hash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                success: false,
                message: "Invalid administrator credentials."
            });
        }

        await adminModel.query(
            `
            UPDATE users
            SET last_login_at = NOW()
            WHERE id = $1
            `,
            [admin.id]
        );

        const token = generateToken();

        await adminSessions.set(token, {
            adminId: admin.id,
            createdAt: Date.now()
        });

        // HttpOnly cookie lets the server protect admin HTML documents as well as APIs.
        res.cookie("gashub_admin_session", token, {
            httpOnly: true,
            sameSite: "strict",
            secure: process.env.NODE_ENV === "production",
            path: "/admin",
            maxAge: 8 * 60 * 60 * 1000
        });

        const frontendAdmin = formatAdmin({
            ...admin,
            frontend_role: "admin"
        });

        res.json({
            success: true,
            message: "Login successful.",
            token,
            admin: frontendAdmin
        });
    } catch (error) {
        console.error("Admin login error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to log in."
        });
    }

}

async function adminLogout(req, res) {
    try {
        const bearer = getBearerToken(req);
        if (bearer) await adminSessions.delete(bearer);
        if (req.adminToken) await adminSessions.delete(req.adminToken);
        res.clearCookie("gashub_admin_session", {
            httpOnly: true,
            sameSite: "strict",
            secure: process.env.NODE_ENV === "production",
            path: "/admin"
        });

        res.json({
            success: true,
            message: "Logged out successfully."
        });
    } catch (error) {
        console.error("Admin logout error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to log out."
        });
    }

}

async function getDashboard(req, res) {
    try {
        const statisticsResult = await adminModel.query(`
            SELECT
                (SELECT COUNT(*) FROM products) AS "totalProducts",
                (SELECT COUNT(*) FROM orders) AS "totalOrders",
                (
                    SELECT COUNT(*)
                    FROM users
                    WHERE role = 'customer'
                ) AS "totalCustomers",
                (
                    SELECT COUNT(*)
                    FROM orders
                    WHERE status = 'pending'
                ) AS "pendingOrders"
        `);

        const statusResult = await adminModel.query(`
            SELECT
                COUNT(*) FILTER (
                    WHERE status = 'pending'
                ) AS pending,

                COUNT(*) FILTER (
                    WHERE status = 'confirmed'
                ) AS confirmed,

                COUNT(*) FILTER (
                    WHERE status IN (
                        'processing',
                        'out_for_delivery'
                    )
                ) AS delivery,

                COUNT(*) FILTER (
                    WHERE status IN (
                        'delivered',
                        'completed'
                    )
                ) AS completed,

                COUNT(*) FILTER (
                    WHERE status IN (
                        'cancelled',
                        'rejected'
                    )
                ) AS cancelled

            FROM orders
        `);

        const recentOrdersResult = await adminModel.query(`
            SELECT
                o.id,
                o.order_number,
                o.status,
                o.payment_method,
                o.payment_status,
                o.total_amount,
                o.delivery_address,
                o.created_at,

                u.id AS customer_id,
                u.full_name AS customer_name,
                u.phone AS customer_phone,

                (
                    SELECT oi.product_name
                    FROM order_items oi
                    WHERE oi.order_id = o.id
                    ORDER BY oi.created_at ASC
                    LIMIT 1
                ) AS product_name,

                (
                    SELECT COALESCE(SUM(oi.quantity), 0)
                    FROM order_items oi
                    WHERE oi.order_id = o.id
                ) AS quantity

            FROM orders o

            LEFT JOIN users u
                ON u.id = o.customer_id

            ORDER BY o.created_at DESC
            LIMIT 10
        `);

        res.json({
            success: true,

            statistics: {
                totalProducts: Number(
                    statisticsResult.rows[0].totalProducts || 0
                ),
                totalOrders: Number(
                    statisticsResult.rows[0].totalOrders || 0
                ),
                totalCustomers: Number(
                    statisticsResult.rows[0].totalCustomers || 0
                ),
                pendingOrders: Number(
                    statisticsResult.rows[0].pendingOrders || 0
                )
            },

            orderStatus: {
                pending: Number(
                    statusResult.rows[0].pending || 0
                ),
                confirmed: Number(
                    statusResult.rows[0].confirmed || 0
                ),
                delivery: Number(
                    statusResult.rows[0].delivery || 0
                ),
                completed: Number(
                    statusResult.rows[0].completed || 0
                ),
                cancelled: Number(
                    statusResult.rows[0].cancelled || 0
                )
            },

            recentOrders: recentOrdersResult.rows
        });
    } catch (error) {
        console.error("Dashboard error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load dashboard."
        });
    }

}

async function updateAdminOrder(req, res) {
        try {
            const requestedStatus =
                normalizeStatus(
                    req.body.status
                );

            const validStatuses = [
                "pending",
                "confirmed",
                "processing",
                "out_for_delivery",
                "delivered",
                "completed",
                "cancelled",
                "rejected"
            ];

            if (
                !validStatuses.includes(
                    requestedStatus
                )
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid order status."
                });
            }

            const closing = ["cancelled", "rejected"].includes(requestedStatus);
            const before = closing
                ? (await adminModel.query("SELECT id, status FROM orders WHERE id = $1", [req.params.id])).rows[0]
                : null;
            if (closing) await ensureRefundColumns().catch((e) => console.error("Refund columns:", e.message));

            const result = await adminModel.query(
                `
                UPDATE orders

                SET
                    status = $1::text::order_status,

                    confirmed_at =
                        CASE
                            WHEN $1::text = 'confirmed'
                                 AND confirmed_at IS NULL
                            THEN NOW()
                            ELSE confirmed_at
                        END,

                    dispatched_at =
                        CASE
                            WHEN $1::text = 'out_for_delivery'
                                 AND dispatched_at IS NULL
                            THEN NOW()
                            ELSE dispatched_at
                        END,

                    delivered_at =
                        CASE
                            WHEN $1::text IN (
                                'delivered',
                                'completed'
                            )
                            AND delivered_at IS NULL
                            THEN NOW()
                            ELSE delivered_at
                        END,

                    completed_at =
                        CASE
                            WHEN $1::text = 'completed'
                                 AND completed_at IS NULL
                            THEN NOW()
                            ELSE completed_at
                        END,

                    cancelled_at =
                        CASE
                            WHEN $1::text IN (
                                'cancelled',
                                'rejected'
                            )
                            AND cancelled_at IS NULL
                            THEN NOW()
                            ELSE cancelled_at
                        END,

                    updated_at = NOW()

                WHERE id = $2

                RETURNING *
                `,
                [
                    requestedStatus,
                    req.params.id
                ]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Order not found."
                });
            }

            /* an admin cancelling / rejecting an open order: stock back, points settled, refund started if it was paid */
            let refund = null;
            if (closing && before && !["cancelled", "rejected"].includes(String(before.status))) {
                const client = await pool.connect();
                try {
                    await client.query("BEGIN");
                    refund = await settleCancelledOrder(client, { id: before.id }, { restock: true, reason: "Cancelled by GasHub admin." });
                    await client.query("COMMIT");
                } catch (e) {
                    try { await client.query("ROLLBACK"); } catch (x) { /* ignore */ }
                    console.error("Settle cancelled order error:", e);
                } finally {
                    client.release();
                }
            }

            res.json({
                success: true,
                message:
                    refund && refund.refundPending
                        ? `Order status updated. A refund of KSh ${refund.amount.toLocaleString("en-KE")} was added to Payments > Refunds.`
                        : "Order status updated successfully.",
                refund: refund && refund.refundPending ? { status: "pending", amount: refund.amount } : null,
                order: result.rows[0]
            });
        } catch (error) {
            console.error(
                "Update order status error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to update order status."
            });
        }
    
}

async function getCustomers(req, res) {
        try {
            const listSql = (extra) => `
                SELECT
                    id,
                    user_code,
                    full_name,
                    phone,
                    email,
                    status,${extra}
                    default_address,
                    city,
                    county,
                    created_at,
                    updated_at,
                    last_login_at

                FROM users

                WHERE role = 'customer'

                ORDER BY created_at DESC
            `;
            let result;
            try {
                result = await adminModel.query(listSql(" banned_at, ban_reason,"));
            } catch (e) {
                if (e.code !== "42703") throw e;     /* customer-ban-migration.sql not run yet */
                result = await adminModel.query(listSql(""));
            }

            res.json({
                success: true,
                customers: result.rows
            });
        } catch (error) {
            console.error(
                "Get admin customers error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load customers."
            });
        }
    
}

async function getCustomerById(req, res) {
        try {
            const detailSql = (extra) => `
                    SELECT
                        id,
                        user_code,
                        full_name,
                        phone,
                        email,
                        role,
                        status,${extra}
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
                    `;
            let customerResult;
            try {
                customerResult = await adminModel.query(detailSql(" banned_at, ban_reason,"), [req.params.id]);
            } catch (e) {
                if (e.code !== "42703") throw e;     /* customer-ban-migration.sql not run yet */
                customerResult = await adminModel.query(detailSql(""), [req.params.id]);
            }

            if (
                customerResult.rows.length === 0
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Customer not found."
                });
            }

            const orderResult =
                await adminModel.query(
                    `
                    SELECT
                        COUNT(*)::INTEGER
                            AS total_orders,

                        COUNT(*) FILTER (
                            WHERE status = 'completed'
                        )::INTEGER
                            AS completed_orders,

                        COALESCE(
                            SUM(total_amount) FILTER (
                                WHERE status::text NOT IN ('cancelled', 'rejected')
                                  AND COALESCE(payment_status::text, '') <> 'refunded'
                                  AND to_jsonb(orders)->>'refund_status' IS NULL
                            ),
                            0
                        ) AS total_spent

                    FROM orders

                    WHERE customer_id = $1
                    `,
                    [req.params.id]
                );

            let pointsBalance = 0;
            try {
                const pts = await adminModel.query(
                    "SELECT COALESCE(SUM(points), 0)::int AS balance FROM points_ledger WHERE user_id = $1",
                    [req.params.id]
                );
                pointsBalance = pts.rows[0].balance;
            } catch (e) {
                console.error("Customer points error:", e.message);
            }

            /* everything the admin needs to manage this one customer: their orders, coins and withdrawals */
            const uid = String(req.params.id);
            let orders = [];
            try {
                const o = await adminModel.query(
                    `SELECT o.id, o.order_number, o.status, o.payment_status, o.total_amount, o.created_at,
                            d.business_name AS dealer_name,
                            (SELECT oi.product_name FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.created_at ASC LIMIT 1) AS product_name
                       FROM orders o LEFT JOIN dealers d ON d.id = o.dealer_id
                      WHERE o.customer_id::text = $1
                      ORDER BY o.created_at DESC LIMIT 200`, [uid]);
                orders = o.rows;
            } catch (e) { console.error("Customer orders error:", e.message); }

            let coins = { earned: 0, spent: 0, history: [] };
            try {
                const l = await adminModel.query(
                    `SELECT points, reason, note, created_at FROM points_ledger WHERE user_id::text = $1 ORDER BY created_at DESC LIMIT 100`, [uid]);
                coins.history = l.rows;
                const t = await adminModel.query(
                    `SELECT COALESCE(SUM(points) FILTER (WHERE points > 0), 0)::int AS earned,
                            COALESCE(-SUM(points) FILTER (WHERE points < 0), 0)::int AS spent
                       FROM points_ledger WHERE user_id::text = $1`, [uid]);
                coins.earned = t.rows[0].earned; coins.spent = t.rows[0].spent;
            } catch (e) { console.error("Customer coins error:", e.message); }

            let withdrawals = [];
            let withdrawn = { coins: 0, ksh: 0, pending_coins: 0, pending_ksh: 0 };
            try {
                const w = await adminModel.query(
                    `SELECT id, reference, points, amount_ksh, fee_ksh, net_ksh, status, phone, admin_note, created_at, processed_at
                       FROM points_withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [uid]);
                withdrawals = w.rows;
                for (const r of withdrawals) {
                    const pts = Number(r.points) || 0, amt = Number(r.amount_ksh) || 0;
                    if (r.status === "paid") { withdrawn.coins += pts; withdrawn.ksh += amt; }
                    else if (r.status === "pending" || r.status === "approved") { withdrawn.pending_coins += pts; withdrawn.pending_ksh += amt; }
                }
            } catch (e) { /* the withdrawals table is created the first time a customer withdraws */ }

            res.json({
                success: true,
                customer:
                    customerResult.rows[0],
                statistics: {
                    ...orderResult.rows[0],
                    points_balance: pointsBalance,
                    points_earned: coins.earned,
                    points_used: coins.spent,
                    withdrawn_coins: withdrawn.coins,
                    withdrawn_ksh: withdrawn.ksh,
                    pending_withdrawal_coins: withdrawn.pending_coins,
                    pending_withdrawal_ksh: withdrawn.pending_ksh
                },
                orders,
                coin_history: coins.history,
                withdrawals
            });
        } catch (error) {
            console.error(
                "Customer details error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load customer details."
            });
        }
    
}

async function getReports(req, res) {
        try {
            const startDate =
                req.query.start_date ||
                new Date(
                    new Date().getFullYear(),
                    new Date().getMonth(),
                    1
                )
                    .toISOString()
                    .slice(0, 10);

            const endDate =
                req.query.end_date ||
                new Date()
                    .toISOString()
                    .slice(0, 10);

            const reportType =
                req.query.report_type ||
                "overview";

            const summaryResult =
                await adminModel.query(
                    `
                    SELECT
                        COUNT(
                            DISTINCT o.id
                        )::INTEGER AS total_orders,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN o.status NOT IN (
                                        'cancelled',
                                        'rejected'
                                    )
                                    THEN o.total_amount
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS total_sales,

                        (
                            SELECT COALESCE(
                                SUM(p.amount),
                                0
                            )
                            FROM payments p

                            WHERE p.created_at >= $1::date
                              AND p.created_at <
                                  (
                                      $2::date +
                                      INTERVAL '1 day'
                                  )

                              AND p.status = 'paid'
                              AND NOT EXISTS (SELECT 1 FROM orders ro WHERE ro.id = p.order_id AND ro.status::text IN ('cancelled', 'rejected'))
                        ) AS total_payments,

                        (
                            SELECT COUNT(*)::INTEGER

                            FROM users u

                            WHERE u.role = 'customer'

                              AND u.created_at >= $1::date
                              AND u.created_at <
                                  (
                                      $2::date +
                                      INTERVAL '1 day'
                                  )
                        ) AS new_customers

                    FROM orders o

                    WHERE o.created_at >= $1::date
                      AND o.created_at <
                          (
                              $2::date +
                              INTERVAL '1 day'
                          )
                    `,
                    [startDate, endDate]
                );

            const ordersResult =
                await adminModel.query(
                    `
                    SELECT
                        o.status,
                        COUNT(*)::INTEGER
                            AS order_count,

                        COALESCE(
                            SUM(o.total_amount),
                            0
                        ) AS total_amount

                    FROM orders o

                    WHERE o.created_at >= $1::date
                      AND o.created_at <
                          (
                              $2::date +
                              INTERVAL '1 day'
                          )

                    GROUP BY o.status

                    ORDER BY order_count DESC
                    `,
                    [startDate, endDate]
                );

            const paymentsResult =
                await adminModel.query(
                    `
                    SELECT
                        p.method,
                        p.status,
                        COUNT(*)::INTEGER
                            AS payment_count,

                        COALESCE(
                            SUM(p.amount),
                            0
                        ) AS total_amount

                    FROM payments p

                    WHERE p.created_at >= $1::date
                      AND p.created_at <
                          (
                              $2::date +
                              INTERVAL '1 day'
                          )

                    GROUP BY
                        p.method,
                        p.status

                    ORDER BY total_amount DESC
                    `,
                    [startDate, endDate]
                );

            const productsResult =
                await adminModel.query(
                    `
                    SELECT
                        oi.product_id,
                        oi.product_name,

                        COALESCE(
                            SUM(oi.quantity),
                            0
                        )::INTEGER AS quantity_sold,

                        COALESCE(
                            SUM(oi.total_price),
                            0
                        ) AS total_sales

                    FROM order_items oi

                    INNER JOIN orders o
                        ON o.id = oi.order_id

                    WHERE o.created_at >= $1::date
                      AND o.created_at <
                          (
                              $2::date +
                              INTERVAL '1 day'
                          )

                      AND o.status NOT IN (
                          'cancelled',
                          'rejected'
                      )

                    GROUP BY
                        oi.product_id,
                        oi.product_name

                    ORDER BY total_sales DESC

                    LIMIT 20
                    `,
                    [startDate, endDate]
                );

            const customersResult =
                await adminModel.query(
                    `
                    SELECT
                        u.id,
                        u.full_name,
                        u.email,
                        u.phone,

                        COUNT(o.id)::INTEGER
                            AS order_count,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN o.status NOT IN (
                                        'cancelled',
                                        'rejected'
                                    )
                                    THEN o.total_amount
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS total_spent

                    FROM users u

                    LEFT JOIN orders o
                        ON o.customer_id = u.id

                       AND o.created_at >= $1::date

                       AND o.created_at <
                           (
                               $2::date +
                               INTERVAL '1 day'
                           )

                    WHERE u.role = 'customer'

                    GROUP BY
                        u.id,
                        u.full_name,
                        u.email,
                        u.phone

                    ORDER BY total_spent DESC

                    LIMIT 20
                    `,
                    [startDate, endDate]
                );

            const summary =
                summaryResult.rows[0];

            res.json({
                success: true,

                report: {
                    start_date: startDate,
                    end_date: endDate,
                    report_type: reportType
                },

                statistics: {
                    totalOrders:
                        Number(
                            summary.total_orders || 0
                        ),

                    totalSales:
                        Number(
                            summary.total_sales || 0
                        ),

                    totalPayments:
                        Number(
                            summary.total_payments || 0
                        ),

                    newCustomers:
                        Number(
                            summary.new_customers || 0
                        )
                },

                orders:
                    ordersResult.rows.map(
                        (row) => ({
                            ...row,
                            status_label:
                                formatOrderStatus(
                                    row.status
                                )
                        })
                    ),

                payments:
                    paymentsResult.rows.map(
                        (row) => ({
                            ...row,
                            status_label:
                                formatPaymentStatus(
                                    row.status
                                )
                        })
                    ),

                products:
                    productsResult.rows,

                customers:
                    customersResult.rows
            });
        } catch (error) {
            console.error(
                "Reports error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to generate report."
            });
        }
    
}

async function getAdmins(req, res) {
        try {
            const result = await adminModel.query(`
                SELECT
                    id,
                    user_code,
                    full_name,
                    phone,
                    email,
                    role,
                    status,
                    profile_image,
                    created_at,
                    updated_at,
                    last_login_at

                FROM users

                WHERE role = 'admin'

                ORDER BY created_at DESC
            `);

            res.json({
                success: true,

                admins:
                    result.rows.map(
                        (admin) =>
                            formatAdmin({
                                ...admin,
                                frontend_role:
                                    "admin"
                            })
                    )
            });
        } catch (error) {
            console.error(
                "Get administrators error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load administrators."
            });
        }
    
}

async function createAdmin(req, res) {
        try {
            const {
                full_name,
                email,
                phone,
                username,
                role,
                status,
                password
            } = req.body;

            if (
                !full_name ||
                !email ||
                !password
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Full name, email and password are required."
                });
            }

            if (
                String(password).length < 6
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Password must contain at least 6 characters."
                });
            }

            const emailExists =
                await adminModel.query(
                    `
                    SELECT id
                    FROM users

                    WHERE LOWER(email) =
                        LOWER($1)
                      AND role = 'admin'

                    LIMIT 1
                    `,
                    [String(email).trim()]
                );

            if (
                emailExists.rows.length > 0
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "An account with this email already exists."
                });
            }

            const usernameValue =
                username &&
                String(username).trim()
                    ? String(username).trim()
                    : generateCode("ADMIN");

            const usernameExists =
                await adminModel.query(
                    `
                    SELECT id
                    FROM users

                    WHERE LOWER(user_code) =
                        LOWER($1)

                    LIMIT 1
                    `,
                    [usernameValue]
                );

            if (
                usernameExists.rows.length > 0
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "This username already exists."
                });
            }

            const passwordHash =
                await bcrypt.hash(
                    password,
                    12
                );

            const normalizedAdminStatus =
                normalizeStatus(status);

            const adminStatus =
                [
                    "active",
                    "inactive"
                ].includes(
                    normalizedAdminStatus
                )
                    ? normalizedAdminStatus
                    : "active";

            const frontendRole =
                normalizeAdminRole(role);

            const result =
                await adminModel.query(
                    `
                    INSERT INTO users (
                        user_code,
                        full_name,
                        phone,
                        email,
                        password_hash,
                        role,
                        status
                    )

                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        'admin',
                        $6
                    )

                    RETURNING
                        id,
                        user_code,
                        full_name,
                        phone,
                        email,
                        role,
                        status,
                        profile_image,
                        created_at,
                        updated_at,
                        last_login_at
                    `,
                    [
                        usernameValue,
                        String(
                            full_name
                        ).trim(),
                        phone || null,
                        String(
                            email
                        ).trim(),
                        passwordHash,
                        adminStatus
                    ]
                );

            res.status(201).json({
                success: true,
                message:
                    "Administrator created successfully.",

                admin:
                    formatAdmin({
                        ...result.rows[0],
                        frontend_role:
                            frontendRole
                    })
            });
        } catch (error) {
            console.error(
                "Create administrator error:",
                error
            );

            if (
                error.code === "23505"
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "An administrator with these details already exists" +
                        (error.constraint ? " (" + error.constraint + ")." : ".")
                });
            }

            res.status(500).json({
                success: false,
                message:
                    "Unable to create administrator: " +
                    String(error.detail || error.message || "database error").slice(0, 200)
            });
        }
    
}

async function updateAdmin(req, res) {
        try {
            const {
                full_name,
                email,
                phone,
                username,
                role,
                status,
                password
            } = req.body;

            if (
                !full_name ||
                !email
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Full name and email are required."
                });
            }

            const existing =
                await adminModel.query(
                    `
                    SELECT *
                    FROM users

                    WHERE id = $1
                      AND role = 'admin'

                    LIMIT 1
                    `,
                    [req.params.id]
                );

            if (
                existing.rows.length === 0
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Administrator not found."
                });
            }

            const usernameValue =
                username &&
                String(username).trim()
                    ? String(username).trim()
                    : existing.rows[0]
                        .user_code;

            const duplicate =
                await adminModel.query(
                    `
                    SELECT id
                    FROM users

                    WHERE id <> $1

                      AND (
                          LOWER(email) =
                              LOWER($2)

                          OR LOWER(user_code) =
                              LOWER($3)
                      )

                    LIMIT 1
                    `,
                    [
                        req.params.id,
                        String(
                            email
                        ).trim(),
                        usernameValue
                    ]
                );

            if (
                duplicate.rows.length > 0
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "The email or username is already in use."
                });
            }

            const normalizedAdminStatus =
                normalizeStatus(status);

            const adminStatus =
                [
                    "active",
                    "inactive"
                ].includes(
                    normalizedAdminStatus
                )
                    ? normalizedAdminStatus
                    : existing.rows[0].status;

            const frontendRole =
                normalizeAdminRole(role);

            let query;
            let values;

            if (
                password &&
                String(password).trim()
            ) {
                if (
                    String(password).length < 6
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Password must contain at least 6 characters."
                    });
                }

                const passwordHash =
                    await bcrypt.hash(
                        password,
                        12
                    );

                query = `
                    UPDATE users

                    SET
                        user_code = $1,
                        full_name = $2,
                        phone = $3,
                        email = $4,
                        password_hash = $5,
                        status = $6

                    WHERE id = $7
                      AND role = 'admin'

                    RETURNING
                        id,
                        user_code,
                        full_name,
                        phone,
                        email,
                        role,
                        status,
                        profile_image,
                        created_at,
                        updated_at,
                        last_login_at
                `;

                values = [
                    usernameValue,
                    String(
                        full_name
                    ).trim(),
                    phone || null,
                    String(
                        email
                    ).trim(),
                    passwordHash,
                    adminStatus,
                    req.params.id
                ];
            } else {
                query = `
                    UPDATE users

                    SET
                        user_code = $1,
                        full_name = $2,
                        phone = $3,
                        email = $4,
                        status = $5

                    WHERE id = $6
                      AND role = 'admin'

                    RETURNING
                        id,
                        user_code,
                        full_name,
                        phone,
                        email,
                        role,
                        status,
                        profile_image,
                        created_at,
                        updated_at,
                        last_login_at
                `;

                values = [
                    usernameValue,
                    String(
                        full_name
                    ).trim(),
                    phone || null,
                    String(
                        email
                    ).trim(),
                    adminStatus,
                    req.params.id
                ];
            }

            const result =
                await adminModel.query(
                    query,
                    values
                );

            if (
                result.rows.length === 0
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Administrator not found."
                });
            }

            res.json({
                success: true,
                message:
                    "Administrator updated successfully.",

                admin:
                    formatAdmin({
                        ...result.rows[0],
                        frontend_role:
                            frontendRole
                    })
            });
        } catch (error) {
            console.error(
                "Update administrator error:",
                error
            );

            if (
                error.code === "23505"
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "The email or username is already in use."
                });
            }

            res.status(500).json({
                success: false,
                message:
                    "Unable to update administrator."
            });
        }
    
}

async function deleteAdmin(req, res) {
        try {
            if (
                String(req.admin.id) ===
                String(req.params.id)
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "You cannot delete the administrator account currently in use."
                });
            }

            const result =
                await adminModel.query(
                    `
                    DELETE FROM users

                    WHERE id = $1
                      AND role = 'admin'

                    RETURNING id
                    `,
                    [req.params.id]
                );

            if (
                result.rows.length === 0
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Administrator not found."
                });
            }

            await adminSessions.deleteWhere("adminId", req.params.id);

            res.json({
                success: true,
                message:
                    "Administrator deleted successfully."
            });
        } catch (error) {
            console.error(
                "Delete administrator error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to delete administrator."
            });
        }
    
}

async function updateAdminProfile(req, res) {
        try {
            const {
                full_name,
                email,
                phone,
                username
            } = req.body;

            if (
                !full_name ||
                !email
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Full name and email are required."
                });
            }

            const usernameValue =
                username &&
                String(username).trim()
                    ? String(username).trim()
                    : req.admin.user_code;

            const duplicate =
                await adminModel.query(
                    `
                    SELECT id
                    FROM users

                    WHERE id <> $1

                      AND (
                          LOWER(email) =
                              LOWER($2)

                          OR LOWER(user_code) =
                              LOWER($3)
                      )

                    LIMIT 1
                    `,
                    [
                        req.admin.id,
                        String(
                            email
                        ).trim(),
                        usernameValue
                    ]
                );

            if (
                duplicate.rows.length > 0
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "The email or username is already in use."
                });
            }

            const result =
                await adminModel.query(
                    `
                    UPDATE users

                    SET
                        full_name = $1,
                        email = $2,
                        phone = $3,
                        user_code = $4

                    WHERE id = $5
                      AND role = 'admin'

                    RETURNING
                        id,
                        user_code,
                        full_name,
                        phone,
                        email,
                        role,
                        status,
                        profile_image,
                        created_at,
                        updated_at,
                        last_login_at
                    `,
                    [
                        String(
                            full_name
                        ).trim(),
                        String(
                            email
                        ).trim(),
                        phone || null,
                        usernameValue,
                        req.admin.id
                    ]
                );

            if (
                result.rows.length === 0
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Administrator account not found."
                });
            }

            res.json({
                success: true,
                message:
                    "Administrator profile updated successfully.",

                admin:
                    formatAdmin({
                        ...result.rows[0],
                        frontend_role:
                            "admin"
                    })
            });
        } catch (error) {
            console.error(
                "Admin profile error:",
                error
            );

            if (
                error.code === "23505"
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "The email or username is already in use."
                });
            }

            res.status(500).json({
                success: false,
                message:
                    "Unable to update administrator profile."
            });
        }
    
}

async function changeAdminPassword(req, res) {
        try {
            const {
                current_password,
                new_password
            } = req.body;

            if (
                !current_password ||
                !new_password
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Current and new passwords are required."
                });
            }

            if (
                String(new_password).length < 6
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "New password must contain at least 6 characters."
                });
            }

            const result =
                await adminModel.query(
                    `
                    SELECT password_hash
                    FROM users

                    WHERE id = $1
                      AND role = 'admin'

                    LIMIT 1
                    `,
                    [req.admin.id]
                );

            if (
                result.rows.length === 0
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Administrator account not found."
                });
            }

            const passwordMatches =
                await bcrypt.compare(
                    current_password,
                    result.rows[0]
                        .password_hash
                );

            if (!passwordMatches) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Current password is incorrect."
                });
            }

            const passwordHash =
                await bcrypt.hash(
                    new_password,
                    12
                );

            await adminModel.query(
                `
                UPDATE users

                SET password_hash = $1

                WHERE id = $2
                  AND role = 'admin'
                `,
                [
                    passwordHash,
                    req.admin.id
                ]
            );

            res.json({
                success: true,
                message:
                    "Password changed successfully."
            });
        } catch (error) {
            console.error(
                "Change password error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to change password."
            });
        }
    
}

module.exports = {
    adminLogin,
    adminLogout,
    getDashboard,
    updateAdminOrder,
    getCustomers,
    getCustomerById,
    getReports,
    getAdmins,
    createAdmin,
    updateAdmin,
    deleteAdmin,
    updateAdminProfile,
    changeAdminPassword,
};