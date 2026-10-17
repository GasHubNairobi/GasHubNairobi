/* Cloudinary image storage (https://cloudinary.com).
   Product photos and dealer logos used to be saved inside the database as huge base64 text, which made /api/products enormous
   (Netlify answers at most ~6 MB) and slowed every page. They are now uploaded to Cloudinary and only the short link is stored.

   Settings (Netlify -> Site configuration -> Environment variables; locally in .env):
       CLOUDINARY_CLOUD_NAME   your cloud name (not secret)
       CLOUDINARY_API_KEY      from Cloudinary -> Settings -> API Keys
       CLOUDINARY_API_SECRET   same page. SECRET: tick "Contains secret values" in Netlify, never put it in a web page.

   If these are empty the site keeps working exactly as before (images stay in the database), so you can deploy first and add the keys later.
   No extra npm package is needed: the upload is one signed HTTPS call using Node's built-in fetch and crypto. */
const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const env = (k) => String(process.env[k] || "").trim();
const cloudName = () => env("CLOUDINARY_CLOUD_NAME");
const isConfigured = () => Boolean(cloudName() && env("CLOUDINARY_API_KEY") && env("CLOUDINARY_API_SECRET"));

/* Only pictures made by this site's own Cloudinary account are accepted as image links (blocks tracking pixels / hot-linked images). */
function isCloudinaryUrl(url) {
    const name = cloudName();
    if (!name || typeof url !== "string") return false;
    return url.startsWith(`https://res.cloudinary.com/${name}/`) && !/\s/.test(url) && url.length <= 600;
}

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const FOLDERS = { product: "gashub/products", logo: "gashub/logos" };
const MAX_BYTES = 1500000;       /* hard ceiling for one picture (the pages already shrink photos to well under 400 KB) */
const UPLOAD_TIMEOUT_MS = 20000;

/* Signs the upload parameters (Cloudinary: SHA-1 of "a=1&b=2" sorted by name, followed by the API secret) */
function sign(params) {
    const text = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== "")
        .sort().map((k) => `${k}=${params[k]}`).join("&");
    return crypto.createHash("sha1").update(text + env("CLOUDINARY_API_SECRET")).digest("hex");
}

/* Uploads one data-URL picture. Returns the https link. Throws when Cloudinary is not set up or refuses the picture.
   The same picture always gets the same name (a hash of its bytes), so uploading it twice does not make two copies. */
async function uploadDataUrl(dataUrl, kind = "product") {
    if (!isConfigured()) throw new Error("Cloudinary is not configured.");
    if (typeof dataUrl !== "string" || !DATA_URL.test(dataUrl)) throw new Error("Not a PNG, JPG or WebP picture.");
    if (dataUrl.length > MAX_BYTES * 1.4) throw new Error("Picture too large.");

    const folder = FOLDERS[kind] || FOLDERS.product;
    const publicId = crypto.createHash("sha256").update(dataUrl).digest("hex").slice(0, 24);
    const params = {
        allowed_formats: "jpg,png,webp",       /* Cloudinary itself refuses anything that is not really one of these */
        folder,
        overwrite: "false",
        public_id: publicId,
        timestamp: Math.floor(Date.now() / 1000),
        unique_filename: "false"
    };
    const form = new FormData();
    Object.entries(params).forEach(([k, v]) => form.append(k, String(v)));
    form.append("api_key", env("CLOUDINARY_API_KEY"));
    form.append("signature", sign(params));
    form.append("file", dataUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
        const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName())}/image/upload`, { method: "POST", body: form, signal: controller.signal });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.secure_url) {
            /* an already-uploaded identical picture is fine: rebuild its link */
            if (res.status === 400 && data && data.error && /already exists/i.test(String(data.error.message))) {
                return `https://res.cloudinary.com/${cloudName()}/image/upload/${folder}/${publicId}`;
            }
            throw new Error((data && data.error && data.error.message) || `Cloudinary answered ${res.status}`);
        }
        return String(data.secure_url);
    } finally { clearTimeout(timer); }
}

/* Smaller, faster copy for lists and cards: Cloudinary resizes and picks WebP/AVIF per phone.
   Works on the stored link without re-uploading. Other values (data URLs, /Images/... paths) pass through unchanged. */
function optimizeUrl(url, width = 600) {
    if (!isCloudinaryUrl(url)) return url;
    const marker = "/image/upload/";
    const i = url.indexOf(marker);
    if (i < 0) return url;
    const rest = url.slice(i + marker.length);
    if (/^(?:[a-z]{1,3}_[^/]+,?)+\//.test(rest) && !/^v\d+\//.test(rest)) return url;   /* already has a transformation */
    return `${url.slice(0, i + marker.length)}f_auto,q_auto,c_limit,w_${Math.max(50, Math.min(2000, width | 0))}/${rest}`;
}

/* Undoes optimizeUrl(): a page that got the small copy and sends it back must not save the small copy as the original */
function stripTransformation(url) {
    return typeof url === "string" ? url.replace("/image/upload/f_auto,q_auto,c_limit,w_", "/image/upload/\u0000").replace(/\/image\/upload\/\u0000\d+\//, "/image/upload/") : url;
}

/* Runs `worker` over `items` with at most `limit` at the same time */
async function mapLimit(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    const run = async () => { while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return out;
}

module.exports = { isConfigured, isCloudinaryUrl, uploadDataUrl, optimizeUrl, stripTransformation, mapLimit, sign, DATA_URL };
