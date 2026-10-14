const crypto = require("crypto");
function generateOrderNumber() { return `ORD-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`; }
module.exports = { generateOrderNumber };
