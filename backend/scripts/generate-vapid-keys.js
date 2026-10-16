/* Creates the two keys phone push notifications need. Run ONCE on your computer (no internet and no extra packages needed):
       node backend/scripts/generate-vapid-keys.js
   Then put the three lines it prints into Netlify (Site configuration -> Environment variables) and into your local .env.
   Keep VAPID_PRIVATE_KEY secret (tick "Contains secret values" in Netlify). If you ever change these keys, every phone
   quietly re-subscribes the next time it opens GasHub. */
const crypto = require("crypto");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const b64u = (b) => Buffer.from(b).toString("base64url");
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
console.log("Add these to Netlify environment variables and your .env:\n");
console.log("VAPID_PUBLIC_KEY=" + b64u(pub));
console.log("VAPID_PRIVATE_KEY=" + jwk.d);
console.log("VAPID_SUBJECT=mailto:YOUR-SUPPORT-EMAIL@YOURDOMAIN");
console.log("\n(VAPID_SUBJECT must be a real email written as mailto:..., or your https site address.)");
