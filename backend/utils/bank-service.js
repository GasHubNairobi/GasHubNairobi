/* GasHub's bank account for "Pay by bank", and the place to plug in the bank's API later.
   The details come from the Super Admin area of the admin Settings page (or, until saved there, the .env file BANK_*). The details shown to customers are NOT secret (they are where to send money);
   the API key never leaves the server. */
const env = (k) => String(process.env[k] || "").trim();

function envDetails() {
    return {
        bank_name: env("BANK_NAME"), account_name: env("BANK_ACCOUNT_NAME"), account_number: env("BANK_ACCOUNT_NUMBER"),
        branch: env("BANK_BRANCH"), paybill: env("BANK_PAYBILL"), instructions: env("BANK_INSTRUCTIONS")
    };
}

/* The bank details come from Admin > Settings > Super Admin Area > Bank Account (saved in the database).
   Until the super admin saves them there, the older BANK_* values in .env are used. */
async function details() {
    try {
        const b = await require("./gashub-settings").getBankAccount();
        if (b.saved) return { bank_name: b.bank_name, account_name: b.account_name, account_number: b.account_number, branch: b.branch, paybill: b.paybill, instructions: b.instructions };
    } catch (e) { /* settings table missing: fall back to .env */ }
    return envDetails();
}
async function isConfigured() { const d = await details(); return Boolean(d.bank_name && d.account_number); }

/* Automatic check of a bank reference. Turn it on with BANK_API_ENABLED=true and write the call to YOUR bank inside
   lookupTransaction() below (it is the only place that has to change). Until then verification is "unavailable" and the
   reference is sent to GasHub to confirm by hand, exactly as before.
   lookupTransaction(reference) must resolve to  { found: true, amount: 1500, reference: "ABC123" }  or  { found: false }. */
function apiEnabled() { return env("BANK_API_ENABLED").toLowerCase() === "true" && Boolean(env("BANK_API_BASE_URL") && env("BANK_API_KEY")); }
async function lookupTransaction(reference) {
    /* EXAMPLE (replace with your bank's real endpoint and response fields):
       const res = await fetch(env("BANK_API_BASE_URL") + "/transactions/" + encodeURIComponent(reference), { headers: { Authorization: "Bearer " + env("BANK_API_KEY") } });
       if (res.status === 404) return { found: false };
       const j = await res.json();
       return { found: true, amount: Number(j.amount), reference: String(j.reference) }; */
    throw new Error("BANK_API_ENABLED is on but lookupTransaction() in backend/utils/bank-service.js has not been written yet.");
}

module.exports = { details, isConfigured, apiEnabled, lookupTransaction };
