const crypto = require("crypto");

function generateCode(prefix) {
    const random = crypto.randomBytes(4).toString("hex").toUpperCase();
    return `${prefix}-${Date.now().toString().slice(-8)}-${random}`;
}

function generateToken() {
    return crypto.randomBytes(48).toString("hex");
}

function normalizeStatus(value) {
    if (value === null || value === undefined) return null;
    return String(value).trim().toLowerCase();
}

function normalizeAdminRole(role) {
    return normalizeStatus(role) === "super_admin" ? "super_admin" : "admin";
}

function databaseAdminRole() { return "admin"; }

function formatCurrency(value) {
    const number = Number(value || 0);
    return `KSh ${number.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatProduct(row) {
    let availability = "Unavailable";
    if (row.status === "available" || row.status === "active") availability = "Available";
    else if (row.status === "out_of_stock") availability = "Out of Stock";
    const lat = row.dealer_latitude !== undefined ? row.dealer_latitude : (row.latitude !== undefined ? row.latitude : null);
    const lng = row.dealer_longitude !== undefined ? row.dealer_longitude : (row.longitude !== undefined ? row.longitude : null);
    const verified = Boolean(row.dealer_is_verified !== undefined ? row.dealer_is_verified : row.is_verified);
    return {
        id: row.id,
        product_code: row.product_code,
        name: row.name,
        category: row.category,
        cylinder_size: row.cylinder_size,
        cylinder_unit: row.cylinder_unit,
        price: row.price,
        dealer_id: row.dealer_id,
        dealer_name: row.business_name || row.dealer_name || null,
        dealer_business_name: row.business_name || row.dealer_name || null,
        dealer_location: row.dealer_location || row.location || null,
        dealer_latitude: lat !== null && !isNaN(Number(lat)) ? Number(lat) : null,
        dealer_longitude: lng !== null && !isNaN(Number(lng)) ? Number(lng) : null,
        latitude: lat !== null && !isNaN(Number(lat)) ? Number(lat) : null,
        longitude: lng !== null && !isNaN(Number(lng)) ? Number(lng) : null,
        dealer_is_verified: verified,
        is_verified: verified,
        dealer_phone: row.dealer_phone || row.phone || null,
        dealer_email: row.dealer_email || row.email || null,
        dealer_status: row.dealer_status || null,
        dealer_rating: row.dealer_rating !== undefined ? row.dealer_rating : (row.rating || null),
        dealer_follower_count: Number(row.dealer_follower_count) || 0,
        description: row.description,
        image: row.image,
        status: row.status,
        availability,
        stock_quantity: row.stock_quantity,
        featured: row.featured,
        view_count: row.view_count !== undefined && row.view_count !== null ? Number(row.view_count) || 0 : undefined,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function formatOrderStatus(status) {
    switch (status) { case "pending": return "Pending"; case "confirmed": return "Confirmed"; case "processing": return "Processing"; case "out_for_delivery": return "Out for Delivery"; case "delivered": return "Delivered"; case "completed": return "Completed"; case "cancelled": return "Cancelled"; case "rejected": return "Rejected"; default: return status || "Unknown"; }
}

function formatPaymentStatus(status) {
    switch (status) { case "pending": return "Pending"; case "paid": return "Completed"; case "failed": return "Failed"; case "refunded": return "Refunded"; case "partial": return "Partial"; default: return status || "Unknown"; }
}

function formatComplaintStatus(status) {
    switch (status) { case "open": return "Pending"; case "in_progress": return "In Progress"; case "resolved": return "Resolved"; case "closed": return "Closed"; default: return status || "Unknown"; }
}

function formatAdmin(admin) {
    return { id: admin.id, full_name: admin.full_name, email: admin.email, phone: admin.phone, username: admin.user_code, user_code: admin.user_code, role: normalizeAdminRole(admin.frontend_role || admin.role), status: admin.status, profile_image: admin.profile_image, created_at: admin.created_at, updated_at: admin.updated_at, last_login_at: admin.last_login_at };
}

function getBearerToken(req) {
    const header = req.headers.authorization || "";
    return header.startsWith("Bearer ") ? header.substring(7).trim() : null;
}

module.exports = { generateCode, generateToken, normalizeStatus, normalizeAdminRole, databaseAdminRole, formatCurrency, formatProduct, formatOrderStatus, formatPaymentStatus, formatComplaintStatus, formatAdmin, getBearerToken };
