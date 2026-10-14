/* Customer <-> dealer chat.
   A conversation is one customer + one dealer (+ the product they asked about).
   Customers use /api/messages (signed in as customer). Dealers use /api/dealers/messages/... (signed in as dealer).
   The table is created automatically the first time it is needed. */
const { pool } = require("../config/database-config");

let ready = false;
async function ensureTable() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dealer_messages (
      id BIGSERIAL PRIMARY KEY,
      dealer_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      product_id TEXT NOT NULL DEFAULT '',
      sender TEXT NOT NULL CHECK (sender IN ('customer','dealer')),
      body TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS dealer_messages_thread_idx ON dealer_messages (dealer_id, customer_id, product_id, id)`);
  ready = true;
}

const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const idOf = (v) => clean(v, 64);

/* Blocks phone numbers, emails, links and "talk outside the app" lines, for BOTH customers and dealers.
   Also catches spelled-out numbers, "name at gmail dot com" and spaced-out digits. */
const NUMBER_WORDS = {
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  sifuri: 0, moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6, saba: 7, nane: 8, tisa: 9
};

/* "zero seven one two" -> "0712", keeps everything else as it was */
function wordsToDigits(text) {
  return text.replace(/[a-z]+/g, (w) => (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w) && w !== "for" && w !== "o" ? String(NUMBER_WORDS[w]) : w));
}

const OUTSIDE_APP = /(whats\s?app|whatsap|wasap|wa\.me|telegram|signal app|imo\b|viber|call me|text me|sms me|my number|my phone|my contact|number yangu|nipigie|nitext|dm me|inbox me|outside (the )?app|off (the )?app|pay me directly|direct payment|send money to|facebook|instagram|tiktok|@\w{3,})/;

/* Returns why a message is not allowed ("" when it is fine). */
function contactReason(input) {
  const raw = String(input || "").toLowerCase();
  if (!raw.trim()) return "";

  /* 1. links and email addresses, including "name at gmail dot com" */
  if (/\S+@\S+/.test(raw) || /\b(gmail|yahoo|hotmail|outlook|icloud|proton(mail)?)\b/.test(raw) ||
      /\b\w+\s*[\(\[]?\s*(at|@)\s*[\)\]]?\s*\w+\s*[\(\[]?\s*(dot|\.)\s*[\)\]]?\s*(com|net|org|ke|co)\b/.test(raw)) return "an email address";
  if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|co\.ke|ke|net|org|io|me|app|info)\b)/.test(raw)) return "a link or website";

  /* 2. phone numbers: digits (or spelled-out digits) separated only by spaces and punctuation */
  const asDigits = wordsToDigits(raw);
  const runs = asDigits.match(/\d(?:[\s().,\-_*/\\|+]*\d)*/g) || [];
  if (runs.some((r) => r.replace(/\D/g, "").length >= 7)) return "a phone number";

  /* 3. talking outside the app */
  if (OUTSIDE_APP.test(raw)) return "a way to contact each other outside GasHub";

  return "";
}

const blockedReply = () => ({
  success: false,
  code: "blocked",
  message: "This message appears to go against the user agreement."
});

const shape = (m) => ({ id: Number(m.id), from: m.sender, text: m.body, t: m.created_at, read: !!m.read_at });

/* ---------------- customer side ---------------- */

/* POST /api/messages  { dealer_id, product_id?, message } */
async function customerSend(req, res) {
  try {
    await ensureTable();
    const dealerId = idOf(req.body?.dealer_id), productId = idOf(req.body?.product_id);
    const text = clean(req.body?.message, 500);
    if (!dealerId) return res.status(400).json({ success: false, message: "Missing dealer." });
    if (!text) return res.status(400).json({ success: false, message: "Type a message first." });
    { if (contactReason(text)) return res.status(400).json(blockedReply()); }
    const d = await pool.query(`SELECT id FROM dealers WHERE id::text = $1 LIMIT 1`, [dealerId]);
    if (!d.rows.length) return res.status(404).json({ success: false, message: "Dealer not found." });
    const r = await pool.query(
      `INSERT INTO dealer_messages (dealer_id, customer_id, product_id, sender, body)
       VALUES ($1, $2, $3, 'customer', $4) RETURNING *`,
      [dealerId, String(req.user.id), productId, text]);
    return res.status(201).json({ success: true, message: shape(r.rows[0]) });
  } catch (error) {
    console.error("Customer send message error:", error);
    return res.status(500).json({ success: false, message: "Unable to send your message." });
  }
}

/* GET /api/messages?dealer_id=..&product_id=..  -> the whole thread; marks the dealer's replies as read */
async function customerThread(req, res) {
  try {
    await ensureTable();
    const dealerId = idOf(req.query.dealer_id), productId = idOf(req.query.product_id);
    if (!dealerId) return res.status(400).json({ success: false, message: "Missing dealer." });
    const customerId = String(req.user.id);
    const r = await pool.query(
      `SELECT * FROM dealer_messages
       WHERE dealer_id = $1 AND customer_id = $2 AND product_id = $3
       ORDER BY id DESC LIMIT 100`, [dealerId, customerId, productId]);
    await pool.query(
      `UPDATE dealer_messages SET read_at = NOW()
       WHERE dealer_id = $1 AND customer_id = $2 AND product_id = $3 AND sender = 'dealer' AND read_at IS NULL`,
      [dealerId, customerId, productId]);
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, messages: r.rows.reverse().map(shape) });
  } catch (error) {
    console.error("Customer thread error:", error);
    return res.status(500).json({ success: false, message: "Unable to load the conversation." });
  }
}

/* GET /api/messages/unread -> dealer replies the customer has not opened yet (drives the pop-up on customer pages) */
async function customerUnread(req, res) {
  try {
    await ensureTable();
    const r = await pool.query(
      `SELECT m.dealer_id, m.product_id, COUNT(*)::int AS unread, MAX(m.id) AS last_id,
              (ARRAY_AGG(m.body ORDER BY m.id DESC))[1] AS last_text,
              d.business_name AS dealer_name, p.name AS product_name, p.image AS product_image
       FROM dealer_messages m
       LEFT JOIN dealers d ON d.id::text = m.dealer_id
       LEFT JOIN products p ON p.id::text = m.product_id
       WHERE m.customer_id = $1 AND m.sender = 'dealer' AND m.read_at IS NULL
       GROUP BY m.dealer_id, m.product_id, d.business_name, p.name, p.image
       ORDER BY MAX(m.id) DESC LIMIT 10`, [String(req.user.id)]);
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, items: r.rows.map((x) => ({ ...x, last_id: Number(x.last_id) })) });
  } catch (error) {
    console.error("Customer unread error:", error);
    return res.status(500).json({ success: false, message: "Unable to check your messages." });
  }
}

/* ---------------- dealer side ---------------- */

/* GET /api/dealers/messages/conversations  -> one row per customer + product, newest first */
async function dealerConversations(req, res) {
  try {
    await ensureTable();
    const dealerId = String(req.dealer.dealer_id);
    const r = await pool.query(
      `SELECT DISTINCT ON (m.customer_id, m.product_id)
              m.customer_id, m.product_id, m.body AS last_text, m.sender AS last_from, m.created_at AS last_at,
              COALESCE(u.full_name, 'Customer') AS customer_name,
              p.name AS product_name,
              (SELECT COUNT(*)::int FROM dealer_messages x
                WHERE x.dealer_id = m.dealer_id AND x.customer_id = m.customer_id AND x.product_id = m.product_id
                  AND x.sender = 'customer' AND x.read_at IS NULL) AS unread
       FROM dealer_messages m
       LEFT JOIN users u ON u.id::text = m.customer_id
       LEFT JOIN products p ON p.id::text = m.product_id
       WHERE m.dealer_id = $1
       ORDER BY m.customer_id, m.product_id, m.id DESC`, [dealerId]);
    const rows = r.rows.sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
    res.set("Cache-Control", "no-store");
    return res.json({
      success: true,
      unread_total: rows.reduce((n, c) => n + c.unread, 0),
      conversations: rows
    });
  } catch (error) {
    console.error("Dealer conversations error:", error);
    return res.status(500).json({ success: false, message: "Unable to load your messages." });
  }
}

/* GET /api/dealers/messages/thread?customer_id=..&product_id=..  -> marks the customer's messages as read */
async function dealerThread(req, res) {
  try {
    await ensureTable();
    const dealerId = String(req.dealer.dealer_id);
    const customerId = idOf(req.query.customer_id), productId = idOf(req.query.product_id);
    if (!customerId) return res.status(400).json({ success: false, message: "Missing customer." });
    const r = await pool.query(
      `SELECT * FROM dealer_messages WHERE dealer_id = $1 AND customer_id = $2 AND product_id = $3
       ORDER BY id DESC LIMIT 100`, [dealerId, customerId, productId]);
    await pool.query(
      `UPDATE dealer_messages SET read_at = NOW()
       WHERE dealer_id = $1 AND customer_id = $2 AND product_id = $3 AND sender = 'customer' AND read_at IS NULL`,
      [dealerId, customerId, productId]);
    /* The product the customer is asking about, so the dealer knows exactly which one it is */
    let product = null;
    if (productId) {
      const pr = await pool.query(
        `SELECT id, product_code, name, category, cylinder_size, cylinder_unit, price, description, image, stock_quantity, status
         FROM products WHERE id::text = $1 AND dealer_id::text = $2 LIMIT 1`, [productId, dealerId]);
      if (pr.rows[0]) {
        const x = pr.rows[0];
        product = {
          id: x.id, code: x.product_code || "", name: x.name, category: x.category || "",
          size: x.cylinder_size ? `${x.cylinder_size}${x.cylinder_unit || "kg"}` : "",
          price: x.price != null ? Number(x.price) : null,
          description: x.description || "", image: x.image || "", stock: x.stock_quantity, status: x.status || ""
        };
      }
    }
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, product, messages: r.rows.reverse().map(shape) });
  } catch (error) {
    console.error("Dealer thread error:", error);
    return res.status(500).json({ success: false, message: "Unable to load the conversation." });
  }
}

/* POST /api/dealers/messages  { customer_id, product_id?, message } - a reply; only into a conversation the customer started */
async function dealerSend(req, res) {
  try {
    await ensureTable();
    const dealerId = String(req.dealer.dealer_id);
    const customerId = idOf(req.body?.customer_id), productId = idOf(req.body?.product_id);
    const text = clean(req.body?.message, 500);
    if (!customerId) return res.status(400).json({ success: false, message: "Missing customer." });
    if (!text) return res.status(400).json({ success: false, message: "Type a reply first." });
    if (contactReason(text)) return res.status(400).json({ success: false, code: "blocked", message: "This message appears to go against the user agreement." });
    const started = await pool.query(
      `SELECT 1 FROM dealer_messages WHERE dealer_id = $1 AND customer_id = $2 AND product_id = $3 AND sender = 'customer' LIMIT 1`,
      [dealerId, customerId, productId]);
    if (!started.rows.length) return res.status(403).json({ success: false, message: "You can only reply to customers who messaged you." });
    const r = await pool.query(
      `INSERT INTO dealer_messages (dealer_id, customer_id, product_id, sender, body)
       VALUES ($1, $2, $3, 'dealer', $4) RETURNING *`, [dealerId, customerId, productId, text]);
    return res.status(201).json({ success: true, message: shape(r.rows[0]) });
  } catch (error) {
    console.error("Dealer send message error:", error);
    return res.status(500).json({ success: false, message: "Unable to send your reply." });
  }
}

/* POST /api/dealers/heartbeat - the dealer's open pages ping this so customers see "Active now" */
async function heartbeat(req, res) {
  try {
    await require("../utils/dealer-presence").touchDealer(req.dealer.dealer_id);
    return res.json({ success: true });
  } catch (error) {
    console.error("Heartbeat error:", error);
    return res.status(500).json({ success: false });
  }
}

module.exports = { customerSend, customerThread, customerUnread, dealerConversations, dealerThread, dealerSend, heartbeat };