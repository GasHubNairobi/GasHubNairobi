const { pool } = require("../config/database-config");
const { generateCode, formatProduct } = require("../utils/assistant");

/*
 | products.status is a Postgres enum on some databases and plain text on others.
 | Writing a value the enum does not have (for example "inactive") makes the whole
 | sync fail with a 500, so the allowed labels are read from the database first.
*/
async function loadStatusLabels(client) {
  try {
    const result = await client.query(`
      SELECT e.enumlabel
      FROM pg_attribute a
      JOIN pg_enum e ON e.enumtypid = a.atttypid
      WHERE a.attrelid = 'products'::regclass AND a.attname = 'status' AND NOT a.attisdropped
      ORDER BY e.enumsortorder
    `);
    return result.rows.map((row) => row.enumlabel);
  } catch (error) {
    return [];
  }
}
/* products.category may also be an enum on some databases. */
async function loadCategoryLabels(client) {
  try {
    const result = await client.query(`
      SELECT e.enumlabel
      FROM pg_attribute a
      JOIN pg_enum e ON e.enumtypid = a.atttypid
      WHERE a.attrelid = 'products'::regclass AND a.attname = 'category' AND NOT a.attisdropped
      ORDER BY e.enumsortorder
    `);
    return result.rows.map((row) => row.enumlabel);
  } catch (error) {
    return [];
  }
}
function pickCategory(labels, raw) {
  const text = String(raw || "gas").trim();
  if (!labels.length) return text;
  const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
  const exact = labels.find((l) => slug(l) === slug(text));
  if (exact) return exact;
  const isAccessory = /access/i.test(text);
  const fuzzy = labels.find((l) => (isAccessory ? /access/i : /gas|cylinder|refill/i).test(l));
  return fuzzy || labels[0];
}
/* "13kg" -> { size: 13, unit: "kg" }. Words like "Standard Kit" have no numeric size. */
function splitSize(value) {
  const text = String(value || "").trim();
  const m = text.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
  if (!m) return { size: null, unit: null, text };
  return { size: Number(m[1]), unit: m[2] ? m[2].toLowerCase() : "kg", text };
}
function pickStatus(labels, wanted) {
  if (!labels.length) return wanted[0];
  return wanted.find((value) => labels.includes(value)) || labels[0];
}
function productStatus(p, stock, labels) {
  if (p.available === false || stock <= 0) return pickStatus(labels, ["out_of_stock", "unavailable", "inactive", "available"]);
  return pickStatus(labels, ["available", "active"]);
}
async function listMyProducts(req, res) {
  try {
    const result = await pool.query(`SELECT p.*, d.business_name, d.location AS dealer_location FROM products p LEFT JOIN dealers d ON d.id=p.dealer_id WHERE p.dealer_id=$1 ORDER BY p.created_at DESC`, [req.dealer.dealer_id]);
    return res.json({ success:true, products:result.rows.map(formatProduct) });
  } catch (error) {
    console.error("List dealer products error:", error);
    return res.status(500).json({ success:false, message:"Unable to load your products." });
  }
}
/* A product photo is only stored when it is a small PNG / JPG / WebP picture or a link. The dealer page shrinks photos to
   about 40-80 KB; this refuses anything huge or odd (it would slow every customer page and could fill the database). */
const MAX_PRODUCT_IMAGE = 400000, MAX_SYNC_PRODUCTS = 500;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
function checkProductImage(value) {
  const v = String(value == null ? "" : value).trim();
  if (!v) return { image: null, keep: false };                                   /* no photo: remove it */
  if (v.length > MAX_PRODUCT_IMAGE) return { image: null, keep: true };          /* too big: leave the saved photo as it is */
  if (IMAGE_DATA_URL.test(v) || /^https:\/\/[^\s]{1,500}$/i.test(v) || /^\/?[Ii]mages\/[A-Za-z0-9._\/-]{1,200}$/.test(v)) return { image: v, keep: false };
  return { image: null, keep: true };
}
/* With Cloudinary switched on, a new photo (a small data URL from the dealer page) is uploaded there and only its https link is
   saved. Photos that are already Cloudinary links are kept as they are. Without Cloudinary keys the old behaviour is used.
   The uploads run together (5 at a time) BEFORE the database transaction starts, so no database connection is held while waiting. */
const cloud = require("../config/cloudinary-config");
const MAX_UPLOADS_PER_SYNC = 25;
async function prepareProductImages(input) {
  const results = input.map((p) => checkProductImage(p && p.image));
  if (!cloud.isConfigured()) return { results, pending: 0 };
  let budget = MAX_UPLOADS_PER_SYNC, pending = 0;
  const jobs = [];
  input.forEach((p, i) => {
    const v = cloud.stripTransformation(String((p && p.image) == null ? "" : p.image).trim());
    if (!v) { results[i] = { image: null, keep: false }; return; }
    if (v.length <= MAX_PRODUCT_IMAGE && cloud.DATA_URL.test(v)) {
      if (budget-- > 0) jobs.push({ i, v }); else { results[i] = { image: null, keep: true }; pending++; }
      return;
    }
    if (cloud.isCloudinaryUrl(v) || /^\/?[Ii]mages\/[A-Za-z0-9._\/-]{1,200}$/.test(v)) { results[i] = { image: v, keep: false }; return; }
    results[i] = { image: null, keep: true };      /* oversized, odd, or a link from another website: leave the saved photo alone */
  });
  await cloud.mapLimit(jobs, 5, async (job) => {
    try { results[job.i] = { image: await cloud.uploadDataUrl(job.v, "product"), keep: false }; }
    catch (e) { console.error("Cloudinary upload failed:", e && e.message); results[job.i] = { image: null, keep: true }; pending++; }
  });
  return { results, pending };
}
async function syncMyProducts(req, res) {
  const input=req.body && req.body.products;
  if (!Array.isArray(input)) return res.status(400).json({success:false,message:"products must be an array."});
  if (input.length > MAX_SYNC_PRODUCTS) return res.status(400).json({success:false,message:`You can publish up to ${MAX_SYNC_PRODUCTS} products at a time.`});
  const prepared=await prepareProductImages(input);
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const dealerId=req.dealer.dealer_id, codes=[];
    const labels=await loadStatusLabels(client);
    const categoryLabels=await loadCategoryLabels(client);
    const hiddenStatus=pickStatus(labels,["inactive","unavailable","discontinued","out_of_stock"]);
    for (const [pi, p] of input.entries()) {
      const name=String(p.name||"").trim(), category=String(p.type||p.category||"gas").trim(), price=Number(p.price);
      if (!name || !Number.isFinite(price) || price<0) continue;
      const code=String(p.sku||p.product_code||"").trim()||generateCode("GAS");
      codes.push(code);
      const parsed=/access/i.test(category) ? { size: null, unit: null, text: "" } : splitSize(p.size||p.cylinder_size);   /* accessories have no cylinder size */
      const stock=Math.max(0,Number.parseInt(p.stock??p.stock_quantity??0,10)||0);
      const cat=pickCategory(categoryLabels,category);
      const status=productStatus(p,stock,labels);
      const desc=p.description?String(p.description).slice(0,2000):null, chk=prepared.results[pi], img=chk.image, keepImg=chk.keep;
      const existing = await client.query(`SELECT id FROM products WHERE product_code=$1 AND dealer_id=$2 LIMIT 1`, [code, dealerId]);
      // The size column may be numeric (13) or text ("13kg") depending on the database,
      // so try the numeric+unit form first and fall back to plain text, then to no size.
      const attempts=[
        { size: parsed.size, unit: parsed.unit },
        { size: parsed.text||null, unit: null },
        { size: null, unit: null }
      ];
      let saved=false, lastError=null;
      for (let i=0;i<attempts.length && !saved;i++) {
        const a=attempts[i];
        if (i>0 && a.size===attempts[i-1].size && a.unit===attempts[i-1].unit) continue;
        await client.query("SAVEPOINT product_row");
        try {
          if (existing.rows.length) {
            await client.query(`UPDATE products SET name=$1,category=$2,cylinder_size=$3,cylinder_unit=$4,price=$5,description=$6,image=CASE WHEN $12::boolean THEN image ELSE $7 END,status=$8,stock_quantity=$9,updated_at=NOW() WHERE id=$10 AND dealer_id=$11`, [name,cat,a.size,a.unit,price,desc,img,status,stock,existing.rows[0].id,dealerId,keepImg]);
          } else {
            await client.query(`INSERT INTO products (product_code,dealer_id,name,category,cylinder_size,cylinder_unit,price,description,image,status,stock_quantity,featured) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,FALSE)`, [code,dealerId,name,cat,a.size,a.unit,price,desc,img,status,stock]);
          }
          await client.query("RELEASE SAVEPOINT product_row");
          saved=true;
        } catch (rowError) {
          lastError=rowError;
          await client.query("ROLLBACK TO SAVEPOINT product_row");
          console.error(`Sync product "${name}" attempt ${i+1} failed:`, rowError.message);
        }
      }
      if (!saved) throw lastError;
    }
    if (codes.length) await client.query(`UPDATE products SET status=$3,updated_at=NOW() WHERE dealer_id=$1 AND NOT (product_code=ANY($2::text[]))`,[dealerId,codes,hiddenStatus]);
    else await client.query(`UPDATE products SET status=$2,updated_at=NOW() WHERE dealer_id=$1`,[dealerId,hiddenStatus]);
    const result=await client.query(`SELECT p.*,d.business_name,d.location AS dealer_location FROM products p LEFT JOIN dealers d ON d.id=p.dealer_id WHERE p.dealer_id=$1 ORDER BY p.created_at DESC`,[dealerId]);
    await client.query("COMMIT");
    return res.json({success:true,message:prepared.pending?`Inventory synced. ${prepared.pending} photo(s) could not be uploaded yet - save again to retry them.`:"Inventory synced.",images_pending:prepared.pending,products:result.rows.map(formatProduct)});
  } catch(error) {
    await client.query("ROLLBACK").catch(()=>{}); console.error("Sync dealer products error:",error);
    return res.status(500).json({success:false,message:"Unable to save dealer inventory."});
  } finally { client.release(); }
}
module.exports={listMyProducts,syncMyProducts};