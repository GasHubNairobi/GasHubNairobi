/* Netlify build: assembles the website that Netlify's CDN serves (folder "dist") from the existing project folders.
   Nothing in frontend/, admin/ or dealer/ is changed - files are only copied.

     frontend/*  ->  dist/            (customer pages, as before at the site root)
     Images/     ->  dist/Images/
     dealer/     ->  dist/dealer/     EXCEPT the .html pages (only the public dealer-login / dealer-application pages are published);
                                      the other dealer pages stay private and are served by the api function after the dealer login check
     admin/      ->  dist/admin/      EXCEPT the .html pages: those stay private and are served by the api function after the
                                      admin login check (exactly as backend/server.js did). admin-login.html is public, as before.

   Project notes, SQL, shortcuts, dotfiles and "*.22css"-style leftovers are never published (server.js refused to serve them too).
   Customer pages also get the link-preview (WhatsApp / Facebook / X) tags that backend/utils/share-meta.js used to add on every request. */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");

const HIDDEN = /\.(md|sql|txt|lnk|env|map|rej|orig|bak)$/i;   /* .rej / .orig / .bak are leftovers from patching: never published */
const LEFTOVER = /\.\d+css$/i;

function copyDir(from, to, keep) {
    if (!fs.existsSync(from)) return 0;
    let count = 0;
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory()) {
            count += copyDir(src, dst, keep);
        } else if (entry.isFile() && !HIDDEN.test(entry.name) && !LEFTOVER.test(entry.name) && keep(entry.name)) {
            fs.copyFileSync(src, dst);
            count++;
        }
    }
    return count;
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const all = () => true;
const total =
    copyDir(path.join(root, "frontend"), dist, all) +
    copyDir(path.join(root, "Images"), path.join(dist, "Images"), all) +
    copyDir(path.join(root, "dealer"), path.join(dist, "dealer"), (name) => {
        const lower = name.toLowerCase();
        if (/\.html?$/.test(lower)) return lower === "dealer-login.html" || lower === "dealer-application.html";
        return true;
    }) +
    copyDir(path.join(root, "admin"), path.join(dist, "admin"), (name) => {
        const lower = name.toLowerCase();
        if (/\.html?$/.test(lower)) return lower === "admin-login.html";
        return true;
    });

/* ---- link-preview tags on the customer pages (same code the server used) ---- */
const base = [process.env.APP_BASE_URL, process.env.URL, process.env.DEPLOY_PRIME_URL]
    .map((v) => String(v || "").trim().replace(/\/+$/, ""))
    .find((v) => /^https?:\/\//i.test(v));

let tagged = 0;
if (base) {
    process.env.APP_BASE_URL = base;
    const { render } = require("../backend/utils/share-meta");
    for (const name of fs.readdirSync(dist)) {
        if (!/^[A-Za-z0-9._-]+\.html$/.test(name)) continue;
        const file = path.join(dist, name);
        const urlPath = name === "index.html" ? "/" : "/" + name;
        const out = render({ protocol: "https", get: () => "", originalUrl: urlPath }, file);
        if (out) { fs.writeFileSync(file, out); tagged++; }
    }
} else {
    console.log("Link-preview tags skipped: set APP_BASE_URL (or deploy on Netlify, which provides URL).");
}

console.log(`GasHub build: ${total} files copied to dist/, ${tagged} pages given link-preview tags.`);
