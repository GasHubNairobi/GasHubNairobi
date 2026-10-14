/* One-time: tell Safaricom where to send paybill / till payment notices, so customers' M-Pesa codes can be checked.
   Fill the MPESA_* values in .env first (and set MPESA_C2B_ENABLED=true), then run from the project folder:
       node backend/scripts/register-mpesa-c2b.js
   Safaricom only lets a shortcode register once in production; in the sandbox you can repeat it. */
require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const mpesa = require("../utils/mpesa-service");
if (!mpesa.isConfigured()) { console.error("MPESA_* values are missing in .env (see the M-PESA block)."); process.exit(1); }
mpesa.registerC2bUrls().then((r) => { console.log("Safaricom replied:", JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error("Failed:", e.message); process.exit(1); });
