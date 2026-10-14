/**
 * Safely create the initial GasHub admin and dealer accounts.
 * Run from the backend directory: node scripts/create-initial-accounts.js
 * Passwords are entered in the terminal with input hidden; never logged.
 */
const crypto = require("crypto");
const readline = require("readline");
const bcrypt = require("bcryptjs");
const { pool } = require("../config/database-config");

function ask(question, defaultValue = "") {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(`${question}${suffix}: `, (answer) => {
        rl.close();
        resolve((answer || defaultValue).trim());
    }));
}

function askHidden(question) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
            reject(new Error("Hidden password input requires a real terminal. Run this command directly in PowerShell or Command Prompt, not through an IDE task or piped input."));
            return;
        }
        const stdin = process.stdin;
        const stdout = process.stdout;
        let value = "";
        stdout.write(`${question}: `);
        stdin.resume();
        stdin.setRawMode(true);
        stdin.setEncoding("utf8");
        const onData = (key) => {
            if (key === "\u0003") {
                cleanup();
                stdout.write("\nCancelled.\n");
                reject(new Error("Cancelled by user."));
                return;
            }
            if (key === "\r" || key === "\n") {
                cleanup();
                stdout.write("\n");
                resolve(value);
                return;
            }
            if (key === "\u007f" || key === "\b") {
                value = value.slice(0, -1);
                return;
            }
            if (key >= " ") value += key;
        };
        function cleanup() {
            stdin.removeListener("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
        }
        stdin.on("data", onData);
    });
}

function makeCode(prefix) {
    return `${prefix}-${Date.now().toString().slice(-8)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

async function main() {
    console.log("\nGasHub initial account setup");
    console.log("Passwords are hidden as you type. Existing accounts will never be changed.\n");

    const adminName = await ask("Admin full name", "Victor Nyamai");
    const adminEmail = (await ask("Admin email", "victornyamai5962@gmail.com")).toLowerCase();
    const dealerName = await ask("Dealer contact name", "Victor Nyamai");
    let dealerEmail = (await ask("Dealer email (must differ from admin email)", "")).toLowerCase();
    if (!dealerEmail || dealerEmail === adminEmail) {
        console.log("\nThe users table requires each account to have a unique email address.");
        dealerEmail = (await ask("Enter a DIFFERENT email for the dealer account")).toLowerCase();
    }
    const businessName = await ask("Dealer business name", "baoma gas");
    const dealerPhone = await ask("Dealer phone", "0742210239");
    const county = await ask("Dealer county/area", "rongai");

    for (const [label, value] of Object.entries({ adminName, adminEmail, dealerName, dealerEmail, businessName, dealerPhone, county })) {
        if (!value) throw new Error(`${label} is required.`);
    }
    if (adminEmail === dealerEmail) throw new Error("Admin and dealer emails must be different because users.email is unique.");
    if (adminEmail.length > 255 || dealerEmail.length > 255) throw new Error("Email address is too long.");

    const adminPassword = await askHidden("Create admin password (minimum 8 characters)");
    if (adminPassword.length < 8) throw new Error("Admin password must contain at least 8 characters.");
    const adminConfirm = await askHidden("Confirm admin password");
    if (adminPassword !== adminConfirm) throw new Error("Admin passwords do not match.");
    const dealerPassword = await askHidden("Create dealer password (minimum 8 characters)");
    if (dealerPassword.length < 8) throw new Error("Dealer password must contain at least 8 characters.");
    const dealerConfirm = await askHidden("Confirm dealer password");
    if (dealerPassword !== dealerConfirm) throw new Error("Dealer passwords do not match.");

    const adminHash = await bcrypt.hash(adminPassword, 12);
    const dealerHash = await bcrypt.hash(dealerPassword, 12);
    // Drop references to cleartext passwords before database work.
    // (JavaScript strings cannot be securely zeroed in memory.)

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const existing = await client.query(
            `SELECT email, phone, role FROM users
             WHERE LOWER(email) IN (LOWER($1), LOWER($2))
                OR phone = $3
             FOR UPDATE`,
            [adminEmail, dealerEmail, dealerPhone]
        );
        if (existing.rows.length) {
            const conflicts = existing.rows.map((row) => `${row.role}: ${row.email}${row.phone ? ` / ${row.phone}` : ""}`).join("; ");
            throw new Error(`No accounts were created. An email or phone already belongs to an existing user (${conflicts}). Check the database first; this script will not overwrite accounts.`);
        }

        const adminCode = makeCode("ADM");
        const dealerUserCode = makeCode("DEL");
        const dealerCode = makeCode("DTR");

        const adminResult = await client.query(
            `INSERT INTO users (user_code, full_name, email, password_hash, role, status)
             VALUES ($1, $2, $3, $4, 'admin', 'active')
             RETURNING id, user_code, full_name, email, role, status`,
            [adminCode, adminName, adminEmail, adminHash]
        );

        const dealerUserResult = await client.query(
            `INSERT INTO users (user_code, full_name, phone, email, password_hash, role, status, county)
             VALUES ($1, $2, $3, $4, $5, 'dealer', 'active', $6)
             RETURNING id, user_code, full_name, phone, email, role, status`,
            [dealerUserCode, dealerName, dealerPhone, dealerEmail, dealerHash, county]
        );

        const dealerResult = await client.query(
            `INSERT INTO dealers (dealer_code, user_id, business_name, contact_person, phone, email, county, town, status, availability)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'active', TRUE)
             RETURNING id, dealer_code, user_id, business_name, contact_person, phone, email, county, status`,
            [dealerCode, dealerUserResult.rows[0].id, businessName, dealerName, dealerPhone, dealerEmail, county]
        );

        await client.query("COMMIT");
        console.log("\nAccounts created successfully:");
        console.table([adminResult.rows[0], dealerUserResult.rows[0]]);
        console.log("Dealer business record:");
        console.table([dealerResult.rows[0]]);
        console.log("\nAdmin login: use the admin email and the password you just set.");
        console.log("Dealer login: use the separate dealer email and the password you just set.");
        console.log("No passwords or password hashes were printed.");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(async (error) => {
    console.error(`\nAccount setup stopped: ${error.message}`);
    await pool.end().catch(() => {});
    process.exitCode = 1;
});
