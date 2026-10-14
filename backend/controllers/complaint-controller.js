const complaintModel = require("../models/complaint-model");
const { normalizeStatus, formatComplaintStatus } = require("../utils/assistant");

async function getComplaints(req, res) {
        try {
            const result = await complaintModel.query(`
                SELECT
                    c.id,
                    c.complaint_number,
                    c.customer_id,
                    c.dealer_id,
                    c.order_id,
                    c.subject,
                    c.description,
                    c.status,
                    c.admin_response,
                    c.resolved_at,
                    c.created_at,
                    c.updated_at,

                    u.full_name AS customer_name,
                    u.phone AS customer_phone,
                    u.email AS customer_email,

                    d.business_name AS dealer_name,

                    o.order_number

                FROM complaints c

                LEFT JOIN users u
                    ON u.id = c.customer_id

                LEFT JOIN dealers d
                    ON d.id = c.dealer_id

                LEFT JOIN orders o
                    ON o.id = c.order_id

                ORDER BY c.created_at DESC
            `);

            const complaints =
                result.rows.map((row) => ({
                    ...row,
                    display_status:
                        formatComplaintStatus(
                            row.status
                        )
                }));

            res.json({
                success: true,
                complaints
            });
        } catch (error) {
            console.error(
                "Get complaints error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load complaints."
            });
        }
    
}

async function getComplaintById(req, res) {
        try {
            const result = await complaintModel.query(
                `
                SELECT
                    c.*,

                    u.full_name AS customer_name,
                    u.phone AS customer_phone,
                    u.email AS customer_email,

                    d.business_name AS dealer_name,

                    o.order_number

                FROM complaints c

                LEFT JOIN users u
                    ON u.id = c.customer_id

                LEFT JOIN dealers d
                    ON d.id = c.dealer_id

                LEFT JOIN orders o
                    ON o.id = c.order_id

                WHERE c.id = $1

                LIMIT 1
                `,
                [req.params.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Complaint not found."
                });
            }

            res.json({
                success: true,

                complaint: {
                    ...result.rows[0],

                    display_status:
                        formatComplaintStatus(
                            result.rows[0].status
                        )
                }
            });
        } catch (error) {
            console.error(
                "Complaint details error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load complaint details."
            });
        }
    
}

async function updateComplaint(req, res) {
        try {
            let status =
                normalizeStatus(
                    req.body.status
                );

            if (status === "pending") {
                status = "open";
            }

            /*
             * Frontend:
             * pending
             * in_progress
             * resolved
             * rejected
             *
             * Database:
             * open
             * in_progress
             * resolved
             * closed
             */

            if (status === "rejected") {
                status = "closed";
            }

            const validStatuses = [
                "open",
                "in_progress",
                "resolved",
                "closed"
            ];

            if (
                !validStatuses.includes(status)
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid complaint status."
                });
            }

            const adminResponse =
                req.body.admin_response ||
                req.body.response ||
                null;

            const result = await complaintModel.query(
                `
                UPDATE complaints

                SET
                    status = $1,

                    admin_response =
                        COALESCE(
                            $2,
                            admin_response
                        ),

                    resolved_at =
                        CASE
                            WHEN $1 IN (
                                'resolved',
                                'closed'
                            )
                            THEN COALESCE(
                                resolved_at,
                                NOW()
                            )
                            ELSE resolved_at
                        END

                WHERE id = $3

                RETURNING *
                `,
                [
                    status,
                    adminResponse,
                    req.params.id
                ]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Complaint not found."
                });
            }

            res.json({
                success: true,
                message:
                    "Complaint status updated successfully.",
                complaint: result.rows[0]
            });
        } catch (error) {
            console.error(
                "Update complaint error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to update complaint."
            });
        }
    
}

module.exports = {
    getComplaints,
    getComplaintById,
    updateComplaint,
};
