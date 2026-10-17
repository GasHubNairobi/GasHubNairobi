/* One-time move of the photos already saved in the database (base64 text) to Cloudinary.

   Run it on YOUR computer (it needs internet), from the project folder, after the Cloudinary keys and the database settings are in .env:
       node backend/scripts/migrate-images-to-cloudinary.js --dry-run     (only counts what would be moved)
       node backend/scripts/migrate-images-to-cloudinary.js               (moves them)

   Safe to run again: it only touches pictures that are still stored as data URLs, and it never changes the database
   unless the upload worked. Covers products.image and dealers.logo. */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { pool } = require("../config/database-config");
const cloud = require("../config/cloudinary-config");

const DRY = process.argv.includes("--dry-run");

async function moveColumn({ table, column, kind, idColumn = "id" }) {
    const rows = (await pool.query(`SELECT ${idColumn} AS id, ${column} AS value FROM ${table} WHERE ${column} LIKE 'data:image/%' ORDER BY ${idColumn}`)).rows;
    console.log(`${table}.${column}: ${rows.length} picture(s) stored in the database.`);
    if (DRY || !rows.length) return { moved: 0, failed: 0, total: rows.length };
    let moved = 0, failed = 0;
    await cloud.mapLimit(rows, 4, async (row) => {
        try {
            const url = await cloud.uploadDataUrl(row.value, kind);
            await pool.query(`UPDATE ${table} SET ${column} = $1 WHERE ${idColumn} = $2 AND ${column} = $3`, [url, row.id, row.value]);
            moved++;
        } catch (e) {
            failed++;
            console.error(`  ${table} ${row.id}: not moved (${e.message})`);
        }
    });
    console.log(`  moved ${moved}, failed ${failed}.`);
    return { moved, failed, total: rows.length };
}

(async () => {
    if (!cloud.isConfigured()) {
        console.error("Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in .env first.");
        process.exit(1);
    }
    try {
        await moveColumn({ table: "products", column: "image", kind: "product" });
        await moveColumn({ table: "dealers", column: "logo", kind: "logo" });
        console.log(DRY ? "Dry run finished: nothing was changed." : "Done.");
    } catch (e) {
        console.error("Migration stopped:", e.message);
        process.exitCode = 1;
    } finally {
        await pool.end().catch(() => {});
    }
})();
