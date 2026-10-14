/* Finds project folders / files both when running normally (npm start) and inside a Netlify Function,
   where the bundled code lives in a different folder from the files shipped with it (netlify.toml "included_files"). */
const fs = require("fs");
const path = require("path");

const roots = () => [
    path.join(__dirname, "..", ".."),                                   /* normal: <project>/backend/utils -> <project> */
    process.env.LAMBDA_TASK_ROOT,                                        /* Netlify / AWS Lambda */
    process.cwd(),
    path.join(__dirname, "..", "..", ".."),
    path.join(__dirname, "..")
].filter(Boolean);

/* rel = path relative to the project root, e.g. "admin" or "backend/assets/email/gashub-logo.png". Returns an absolute path. */
function projectPath(rel) {
    for (const root of roots()) {
        const candidate = path.join(root, rel);
        if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(roots()[0], rel);   /* not found: the normal location, so errors name a sensible path */
}

module.exports = { projectPath };
