/* Link-share previews (WhatsApp, Facebook, X, Telegram, iMessage ...).
   Those apps read <meta property="og:..."> tags from the page and need an ABSOLUTE image address, so the tags are added
   here, when a customer page is served, using the real address of the site. The image is the app's own logo, untouched.
   Pages that already define og:image are left alone. Admin and dealer pages are not touched. */
const fs = require("fs");
const path = require("path");

const frontendPath = path.join(__dirname, "..", "..", "frontend");
const cache = new Map(); // file -> { mtime, html }

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function originOf(req) {
    return require("./site-url").siteUrl(req);
}

function tagsFor(html, origin, pageUrl) {
    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
    const title = (titleMatch && titleMatch[1].trim()) || "GasHub";
    const desc = (descMatch && descMatch[1].trim()) || "GasHub: find gas dealers near you, order and get it delivered.";
    const img = `${origin}/Images/logo.png`;
    return [
        `<meta property="og:site_name" content="GasHub">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:title" content="${esc(title)}">`,
        `<meta property="og:description" content="${esc(desc)}">`,
        `<meta property="og:url" content="${esc(pageUrl)}">`,
        `<meta property="og:image" content="${esc(img)}">`,
        `<meta property="og:image:type" content="image/png">`,
        `<meta property="og:image:width" content="768">`,
        `<meta property="og:image:height" content="512">`,
        `<meta property="og:image:alt" content="GasHub logo">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:title" content="${esc(title)}">`,
        `<meta name="twitter:description" content="${esc(desc)}">`,
        `<meta name="twitter:image" content="${esc(img)}">`,
        `<link rel="apple-touch-icon" href="${esc(origin)}/Images/favicon.png">`
    ].join("\n    ");
}

/* Returns the page with share tags added, or null when the page should be served the normal way. */
function render(req, file) {
    let entry = cache.get(file);
    let stat;
    try { stat = fs.statSync(file); } catch (e) { return null; }
    if (!entry || entry.mtime !== stat.mtimeMs) {
        entry = { mtime: stat.mtimeMs, html: fs.readFileSync(file, "utf8") };
        cache.set(file, entry);
    }
    const html = entry.html;
    if (/property=["']og:image["']/i.test(html)) return null;
    const m = html.match(/<head[^>]*>/i);
    if (!m) return null;
    const origin = originOf(req);
    const pageUrl = origin + req.originalUrl.split("#")[0];
    const at = m.index + m[0].length;
    return html.slice(0, at) + "\n    " + tagsFor(html, origin, pageUrl) + html.slice(at);
}

/* Express middleware: customer pages only (files directly inside /frontend). */
function shareMeta(req, res, next) {
    if (req.method !== "GET") return next();
    let name = req.path;
    if (name === "/") name = "/index.html";
    if (!/^\/[A-Za-z0-9._-]+\.html$/.test(name)) return next();
    const file = path.join(frontendPath, name);
    if (!file.startsWith(frontendPath + path.sep)) return next();
    let out = null;
    try { out = render(req, file); } catch (e) { out = null; }
    if (!out) return next();
    res.set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.send(out);
}

module.exports = { shareMeta, render };
