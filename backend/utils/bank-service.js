/* GasHub's bank account for "Pay by bank", and the place to plug in the bank's API later.
   Everything comes from the .env file (BANK_*). The details shown to customers are NOT secret (they are where to send money);
   the API key never leaves the server. */
const env = (k) => String(process.env[k] || "").trim();

function details() {
    return {
        bank_name: env("BANK_NAME"), account_name: env("BANK_ACCOUNT_NAME"), account_number: env("BANK_ACCOUNT_NUMBER"),
        branch: env("BANK_BRANCH"), paybill: env("BANK_PAYBILL"), instructions: env("BANK_INSTRUCTIONS")
    };
}
function isConfigured() { const d = details(); return Boolean(d.bank_name && d.account_number); }

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
