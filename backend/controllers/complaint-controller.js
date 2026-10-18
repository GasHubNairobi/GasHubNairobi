const complaintModel = require("../models/complaint-model");
const { normalizeStatus, formatComplaintStatus } = require("../utils/assistant");
const complaintService = require("../utils/complaint-service");

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

            const messages =
                await complaintService
                    .listMessages(result.rows[0].id)
                    .catch(() => []);

            res.json({
                success: true,

                complaint: {
                    ...result.rows[0],

                    display_status:
                        formatComplaintStatus(
                            result.rows[0].status
                        )
                },

                messages
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

/* GET /api/admin/complaints/settings/reply */
async function getReplySettings(req, res) {
    try {
        const M = require("../utils/messaging-service");
        res.json({
            success: true,
            settings: await complaintService.getReplySettings(),
            email: { configured: M.emailConfigured() },
            sms: { configured: M.smsConfigured() },
            push: { configured: require("../utils/push-service").configured() }
        });
    } catch (error) {
        console.error("Get complaint reply settings error:", error);
        res.status(500).json({ success: false, message: "Unable to load the reply settings." });
    }
}

/* PUT /api/admin/complaints/settings/reply */
async function putReplySettings(req, res) {
    try {
        const current = await complaintService.getReplySettings();
        const r = complaintService.normalizeReplySettings(req.body || {}, current);
        if (r.error) return res.status(400).json({ success: false, message: r.error });
        await complaintService.saveReplySettings(r.value);
        res.json({
            success: true,
            message: r.value.enabled ? "Saved. Customers will now get this reply automatically." : "Saved. Automatic replies are OFF.",
            settings: r.value
        });
    } catch (error) {
        console.error("Save complaint reply settings error:", error);
        res.status(500).json({ success: false, message: "Unable to save the reply settings." });
    }
}

/* POST /api/admin/complaints/:id/message   body: { channels: ["email","sms","push"], subject, message } */
async function sendComplaintMessage(req, res) {
    try {
        const found = await complaintModel.query("SELECT * FROM complaints WHERE id::text = $1 LIMIT 1", [String(req.params.id)]);
        if (!found.rows.length) return res.status(404).json({ success: false, message: "Complaint not found." });
        const b = req.body || {};
        const sentBy = (req.admin && (req.admin.full_name || req.admin.email)) || "Admin";
        const r = await complaintService.sendReply(found.rows[0], b.channels, { subject: b.subject, message: b.message }, sentBy);
        if (r.error) return res.status(400).json({ success: false, message: r.error });
        const ok = r.results.filter((x) => x.ok).length;
        res.status(ok ? 200 : 502).json({
            success: ok > 0,
            message: ok === r.results.length ? "Message sent."
                : ok ? "Sent on some channels; see the history for what failed."
                : "Nothing was sent: " + r.results.map((x) => x.detail).join(" "),
            results: r.results,
            messages: await complaintService.listMessages(found.rows[0].id)
        });
    } catch (error) {
        console.error("Send complaint message error:", error);
        res.status(500).json({ success: false, message: "Unable to send the message." });
    }
}

/* POST /api/my/complaints   (customer)   body: { orderId, reason, message } */
async function createMyComplaint(req, res) {
    try {
        if (!req.user || req.user.role !== "customer") return res.status(403).json({ success: false, message: "Customer account required." });
        const b = req.body || {};
        if (!b.orderId) return res.status(400).json({ success: false, message: "Choose the order you are reporting." });
        const r = await complaintService.createFromOrder(req.user, b.orderId, { reason: b.reason, message: b.message });
        if (r.error) return res.status(r.status || 400).json({ success: false, message: r.error });

        /* the admin's automatic reply (only when the admin switched it on); a repeated tap sends nothing twice */
        if (!r.existing) await complaintService.sendAutoReply(r.complaint);

        res.status(r.existing ? 200 : 201).json({
            success: true,
            message: r.existing
                ? "We already have your complaint for this order. Our team is looking into it."
                : "Thank you. Your complaint was sent to GasHub and we will follow it up.",
            complaintNumber: r.complaint.complaint_number
        });
    } catch (error) {
        console.error("Create complaint error:", error);
        res.status(500).json({ success: false, message: "We couldn't send your complaint. Please try again." });
    }
}

module.exports = {
    getComplaints,
    getComplaintById,
    updateComplaint,
    getReplySettings,
    putReplySettings,
    sendComplaintMessage,
    createMyComplaint,
};
