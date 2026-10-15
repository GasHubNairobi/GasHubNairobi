const dealerModel = require("../models/dealer-model");
const { getSessionUser } = require("../utils/session");

/*
|--------------------------------------------------------------------------
| SHARED DEALER RULES (one source of truth for admin, dealer and customer pages)
|--------------------------------------------------------------------------
| - A dealer is "verified" only while is_verified is TRUE and the verification
|   has not expired (same rule the admin pages use).
| - rating / review_count / follower_count always come from the reviews and
|   dealer_followers tables, so every list and details screen shows the same
|   numbers.
*/

const VERIFICATION_ACTIVE_SQL = `(
  COALESCE(d.is_verified, FALSE) = TRUE
  AND d.verification_expires_at IS NOT NULL
  AND d.verification_expires_at > NOW()
)`;

async function getDealerCommunityStats(dealerIds) {
  const stats = new Map();
  const ids = [...new Set((dealerIds || []).filter(Boolean).map(String))];

  ids.forEach((id) => stats.set(id, { rating: 0, review_count: 0, follower_count: 0 }));
  if (!ids.length) return stats;

  try {
    const ratings = await dealerModel.query(
      `
      SELECT
        dealer_id::text AS dealer_id,
        COALESCE(ROUND(AVG(rating)::numeric, 1), 0) AS rating,
        COUNT(*)::INTEGER AS review_count
      FROM reviews
      WHERE dealer_id::text = ANY($1::text[])
        AND rating IS NOT NULL
        AND COALESCE(status::text, '') NOT IN ('rejected', 'hidden', 'deleted')
      GROUP BY dealer_id
      `,
      [ids]
    );

    ratings.rows.forEach((row) => {
      const entry = stats.get(row.dealer_id);
      if (entry) {
        entry.rating = Number(row.rating) || 0;
        entry.review_count = Number(row.review_count) || 0;
      }
    });
  } catch (error) {
    console.error("Dealer rating lookup error:", error.message);
  }

  try {
    await ensureFollowersTable();

    const followers = await dealerModel.query(
      `
      SELECT dealer_id::text AS dealer_id, COUNT(*)::INTEGER AS follower_count
      FROM dealer_followers
      WHERE dealer_id::text = ANY($1::text[])
      GROUP BY dealer_id
      `,
      [ids]
    );

    followers.rows.forEach((row) => {
      const entry = stats.get(row.dealer_id);
      if (entry) entry.follower_count = Number(row.follower_count) || 0;
    });
  } catch (error) {
    console.error("Dealer follower lookup error:", error.message);
  }

  return stats;
}

async function attachDealerCommunityStats(dealers) {
  const stats = await getDealerCommunityStats(dealers.map((dealer) => dealer.id));

  dealers.forEach((dealer) => {
    const entry = stats.get(String(dealer.id)) || {};
    dealer.rating = entry.rating || 0;
    dealer.review_count = entry.review_count || 0;
    dealer.follower_count = entry.follower_count || 0;
  });

  return dealers;
}

/*
|--------------------------------------------------------------------------
| FOLLOWERS + REVIEWS (written by customers, read by admin, dealer and customer pages)
|--------------------------------------------------------------------------
*/

let followersTableReady = false;

async function ensureFollowersTable() {
  if (followersTableReady) return;

  await dealerModel.query(`
    CREATE TABLE IF NOT EXISTS dealer_followers (
      dealer_id   UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (dealer_id, customer_id)
    )
  `);

  followersTableReady = true;
}

/* Adds `following` (true/false) to each dealer when a customer is signed in. */
async function attachFollowingFlag(dealers, req) {
  try {
    const user = await getSessionUser(req);
    if (!user || !dealers.length) return dealers;

    await ensureFollowersTable();

    const result = await dealerModel.query(
      `SELECT dealer_id::text AS dealer_id FROM dealer_followers
       WHERE customer_id = $1 AND dealer_id::text = ANY($2::text[])`,
      [String(user.id), dealers.map((dealer) => String(dealer.id))]
    );

    const followed = new Set(result.rows.map((row) => row.dealer_id));
    dealers.forEach((dealer) => {
      dealer.following = followed.has(String(dealer.id));
    });
  } catch (error) {
    // No followers table yet, or no signed-in customer: the page falls back to its own state.
  }

  return dealers;
}

async function setFollow(req, res, shouldFollow) {
  try {
    const { id } = req.params;

    const dealer = await dealerModel.query("SELECT id FROM dealers WHERE id = $1 LIMIT 1", [id]);
    if (!dealer.rows.length) {
      return res.status(404).json({ success: false, message: "Dealer not found." });
    }

    await ensureFollowersTable();

    if (shouldFollow) {
      await dealerModel.query(
        `INSERT INTO dealer_followers (dealer_id, customer_id) VALUES ($1, $2)
         ON CONFLICT (dealer_id, customer_id) DO NOTHING`,
        [id, String(req.user.id)]
      );
    } else {
      await dealerModel.query(
        "DELETE FROM dealer_followers WHERE dealer_id = $1 AND customer_id = $2",
        [id, String(req.user.id)]
      );
    }

    const stats = await getDealerCommunityStats([id]);
    return res.json({
      success: true,
      following: shouldFollow,
      follower_count: (stats.get(String(id)) || {}).follower_count || 0
    });
  } catch (error) {
    console.error("Follow dealer error:", error);
    return res.status(500).json({ success: false, message: "Unable to update follow." });
  }
}

const followDealer = (req, res) => setFollow(req, res, true);
const unfollowDealer = (req, res) => setFollow(req, res, false);

async function addDealerReview(req, res) {
  try {
    const { id } = req.params;
    const rating = Math.round(Number(req.body && req.body.rating));
    const comment = String((req.body && (req.body.comment || req.body.text)) || "").trim().slice(0, 400);

    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: "Choose a rating from 1 to 5." });
    }

    if (["dealer", "admin", "super_admin"].includes(String(req.user.role || "").toLowerCase())) {
      return res.status(403).json({ success: false, message: "Only customers can review dealers." });
    }

    const dealer = await dealerModel.query("SELECT id FROM dealers WHERE id = $1 LIMIT 1", [id]);
    if (!dealer.rows.length) {
      return res.status(404).json({ success: false, message: "Dealer not found." });
    }

    await dealerModel.query(
      "INSERT INTO reviews (customer_id, dealer_id, rating, comment) VALUES ($1, $2, $3, $4)",
      [req.user.id, id, rating, comment || null]
    );

    const stats = await getDealerCommunityStats([id]);
    const entry = stats.get(String(id)) || {};
    return res.status(201).json({
      success: true,
      rating: entry.rating || 0,
      review_count: entry.review_count || 0
    });
  } catch (error) {
    console.error("Add dealer review error:", error);
    return res.status(500).json({ success: false, message: "Unable to save your review." });
  }
}


/*
|--------------------------------------------------------------------------
| WORKING HOURS (saved by the dealer, read by admin and customer pages)
|--------------------------------------------------------------------------
| Stored in dealers.working_hours (JSONB):
|   { open24: boolean, openTime: "HH:MM", closeTime: "HH:MM", days: [0..6] }
|   open24 = true  -> the shop is ALWAYS open (24 hours, every day).
|   open24 = false -> the shop is open only on `days` between openTime and
|                     closeTime (Kenya time) and shows Closed otherwise.
|   NULL           -> the dealer never set hours, so the shop shows as open.
| days: 0 = Sunday ... 6 = Saturday.
| The column is created automatically the first time it is needed.
*/

let workingHoursColumnReady = false;
async function ensureWorkingHoursColumn() {
  if (workingHoursColumnReady) return;
  await dealerModel.query("ALTER TABLE dealers ADD COLUMN IF NOT EXISTS working_hours JSONB");
  workingHoursColumnReady = true;
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeWorkingHours(raw) {
  let src = raw;
  if (typeof src === "string") {
    try { src = JSON.parse(src); } catch (error) { src = null; }
  }
  if (!src || typeof src !== "object") return null;

  const days = Array.isArray(src.days)
    ? [...new Set(src.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))]
    : [0, 1, 2, 3, 4, 5, 6];

  return {
    open24: src.open24 === true || String(src.open24).toLowerCase() === "true",
    openTime: TIME_PATTERN.test(String(src.openTime || "")) ? src.openTime : "08:00",
    closeTime: TIME_PATTERN.test(String(src.closeTime || "")) ? src.closeTime : "18:00",
    days
  };
}

function minutesOf(time) {
  const parts = String(time).split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function formatClock(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return (h % 12 === 0 ? 12 : h % 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h >= 12 ? "PM" : "AM");
}

function summarizeDays(days) {
  if (days.length === 7) return "Every day";
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).map((d) => DAY_SHORT[d]).join(", ");
}

/* Current weekday + minutes in Kenya time, whatever the server's own timezone is. */
function nowInKenya(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const pick = (type) => (parts.find((p) => p.type === type) || {}).value || "0";
  let h = parseInt(pick("hour"), 10);
  if (h === 24) h = 0;
  return { day: DAY_SHORT.indexOf(pick("weekday")), minutes: h * 60 + parseInt(pick("minute"), 10) };
}

/* Returns { is_open, always_open, configured, label, detail, hours_text, days_text } */
function computeOpenStatus(rawHours, date = new Date()) {
  const hours = normalizeWorkingHours(rawHours);

  if (!hours) {
    return { is_open: true, always_open: true, configured: false, label: "Open", detail: "", hours_text: "Not listed", days_text: "" };
  }
  if (hours.open24) {
    return { is_open: true, always_open: true, configured: true, label: "Open 24 hours", detail: "", hours_text: "Open 24 hours", days_text: "Every day" };
  }

  const open = minutesOf(hours.openTime);
  const close = minutesOf(hours.closeTime);
  const hoursText = formatClock(open) + " – " + formatClock(close);
  const daysText = hours.days.length ? summarizeDays(hours.days) : "No working days";

  if (!hours.days.length) {
    return { is_open: false, always_open: false, configured: true, label: "Closed", detail: "Temporarily closed", hours_text: hoursText, days_text: daysText };
  }

  const now = nowInKenya(date);
  const works = (d) => hours.days.includes(d);
  let isOpen;

  if (open === close) {
    isOpen = works(now.day);
  } else if (open < close) {
    isOpen = works(now.day) && now.minutes >= open && now.minutes < close;
  } else {
    // overnight shift, e.g. 8:00 PM to 2:00 AM
    isOpen = (works(now.day) && now.minutes >= open) || (works((now.day + 6) % 7) && now.minutes < close);
  }

  if (isOpen) {
    return { is_open: true, always_open: false, configured: true, label: "Open now", detail: "Closes at " + formatClock(close), hours_text: hoursText, days_text: daysText };
  }

  let detail = "";
  for (let i = 0; i < 8; i++) {
    const d = (now.day + i) % 7;
    if (!works(d)) continue;
    if (i === 0 && now.minutes >= open) continue;
    detail = "Opens " + (i === 0 ? "today" : i === 1 ? "tomorrow" : DAY_FULL[d]) + " at " + formatClock(open);
    break;
  }
  return { is_open: false, always_open: false, configured: true, label: "Closed", detail, hours_text: hoursText, days_text: daysText };
}

/* Adds working_hours, is_open_now, hours_text, open_status and open_status_detail to each dealer row. */
function attachWorkingHours(dealers) {
  dealers.forEach((dealer) => {
    const hours = normalizeWorkingHours(dealer.working_hours);
    const status = computeOpenStatus(hours);
    dealer.working_hours = hours;
    dealer.is_open_now = status.is_open;
    dealer.open_status = status.label;
    dealer.open_status_detail = status.detail;
    dealer.hours_text = status.hours_text;
    dealer.working_days_text = status.days_text;
  });
  return dealers;
}

async function getMyWorkingHours(req, res) {
  try {
    await ensureWorkingHoursColumn();
    const result = await dealerModel.query(
      "SELECT working_hours FROM dealers WHERE id = $1 LIMIT 1",
      [req.dealer.dealer_id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Dealer not found." });
    }
    const hours = normalizeWorkingHours(result.rows[0].working_hours);
    return res.json({ success: true, working_hours: hours, status: computeOpenStatus(hours) });
  } catch (error) {
    console.error("Get working hours error:", error);
    return res.status(500).json({ success: false, message: "Unable to load working hours." });
  }
}

async function updateMyWorkingHours(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const open24 = body.open24 === true || String(body.open24).toLowerCase() === "true";
    const hours = normalizeWorkingHours({
      open24,
      openTime: body.openTime,
      closeTime: body.closeTime,
      days: Array.isArray(body.days) ? body.days : []
    });

    if (!open24) {
      if (!hours.days.length) {
        return res.status(400).json({ success: false, message: "Select at least one working day." });
      }
      if (!TIME_PATTERN.test(String(body.openTime || "")) || !TIME_PATTERN.test(String(body.closeTime || ""))) {
        return res.status(400).json({ success: false, message: "Enter a valid opening and closing time." });
      }
      if (body.openTime === body.closeTime) {
        return res.status(400).json({ success: false, message: "Closing time must be different from opening time. Choose Open 24 hours instead." });
      }
    }

    await ensureWorkingHoursColumn();
    const result = await dealerModel.query(
      "UPDATE dealers SET working_hours = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING working_hours",
      [JSON.stringify(hours), req.dealer.dealer_id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Dealer not found." });
    }

    const saved = normalizeWorkingHours(result.rows[0].working_hours);
    return res.json({
      success: true,
      message: "Working hours saved.",
      working_hours: saved,
      status: computeOpenStatus(saved)
    });
  } catch (error) {
    console.error("Update working hours error:", error);
    return res.status(500).json({ success: false, message: "Unable to save working hours. Check the backend logs." });
  }
}


/*
|--------------------------------------------------------------------------
| BUSINESS PROFILE (dealer edits their own business information)
|--------------------------------------------------------------------------
| The business NAME can be changed only once every 30 days
| (dealers.business_name_changed_at). Location and address can be changed freely.
| The column is created automatically the first time it is needed.
*/

const NAME_CHANGE_DAYS = 30;
let profileColumnsReady = false;
async function ensureProfileColumns() {
  if (profileColumnsReady) return;
  await dealerModel.query("ALTER TABLE dealers ADD COLUMN IF NOT EXISTS business_name_changed_at TIMESTAMPTZ");
  profileColumnsReady = true;
}

function nameChangeInfo(changedAt) {
  if (!changedAt) return { can_change: true, last_changed_at: null, next_change_at: null, days_left: 0 };
  const last = new Date(changedAt);
  const next = new Date(last.getTime() + NAME_CHANGE_DAYS * 24 * 60 * 60 * 1000);
  const msLeft = next.getTime() - Date.now();
  return {
    can_change: msLeft <= 0,
    last_changed_at: last.toISOString(),
    next_change_at: next.toISOString(),
    days_left: msLeft > 0 ? Math.ceil(msLeft / (24 * 60 * 60 * 1000)) : 0
  };
}

const PROFILE_COLUMNS = "id, dealer_code, business_name, contact_person, phone, email, county, town, location, address, latitude, longitude, business_name_changed_at";

async function getMyProfile(req, res) {
  try {
    await ensureProfileColumns();
    const result = await dealerModel.query(`SELECT ${PROFILE_COLUMNS} FROM dealers WHERE id = $1 LIMIT 1`, [req.dealer.dealer_id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: "Dealer not found." });
    const row = result.rows[0];
    return res.json({ success: true, dealer: row, name_change: nameChangeInfo(row.business_name_changed_at) });
  } catch (error) {
    console.error("Get dealer profile error:", error);
    return res.status(500).json({ success: false, message: "Unable to load your business profile." });
  }
}

async function updateMyProfile(req, res) {
  try {
    await ensureProfileColumns();
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const current = await dealerModel.query(`SELECT ${PROFILE_COLUMNS} FROM dealers WHERE id = $1 LIMIT 1`, [req.dealer.dealer_id]);
    if (!current.rows.length) return res.status(404).json({ success: false, message: "Dealer not found." });
    const row = current.rows[0];

    const businessName = String(body.businessName ?? body.business_name ?? row.business_name ?? "").trim().replace(/\s+/g, " ");
    const location = String(body.location ?? row.location ?? "").trim();
    const address = String(body.address ?? row.address ?? "").trim();

    if (!businessName) return res.status(400).json({ success: false, message: "Business name is required." });
    if (businessName.length > 120) return res.status(400).json({ success: false, message: "Business name must be 120 characters or fewer." });
    if (!location) return res.status(400).json({ success: false, message: "Business location is required." });

    const nameChanged = businessName.toLowerCase() !== String(row.business_name || "").trim().toLowerCase()
      || businessName !== String(row.business_name || "").trim();

    if (nameChanged) {
      const info = nameChangeInfo(row.business_name_changed_at);
      if (!info.can_change) {
        const when = new Date(info.next_change_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Nairobi" });
        return res.status(429).json({
          success: false,
          message: `You can change your business name only once every ${NAME_CHANGE_DAYS} days. You can change it again on ${when} (${info.days_left} day${info.days_left === 1 ? "" : "s"} left).`,
          name_change: info
        });
      }
    }

    let lat = row.latitude;
    let lng = row.longitude;
    if (body.latitude !== undefined && body.longitude !== undefined && body.latitude !== null && body.longitude !== null && body.latitude !== "" && body.longitude !== "") {
      const nLat = Number(body.latitude);
      const nLng = Number(body.longitude);
      if (Number.isFinite(nLat) && Number.isFinite(nLng) && Math.abs(nLat) <= 90 && Math.abs(nLng) <= 180) {
        lat = nLat;
        lng = nLng;
      }
    }

    const result = await dealerModel.query(
      `UPDATE dealers
       SET business_name = $1,
           location = $2,
           address = $3,
           latitude = $4,
           longitude = $5,
           business_name_changed_at = CASE WHEN $6::boolean THEN NOW() ELSE business_name_changed_at END,
           updated_at = NOW()
       WHERE id = $7
       RETURNING ${PROFILE_COLUMNS}`,
      [businessName, location, address || null, lat, lng, nameChanged, req.dealer.dealer_id]
    );

    const saved = result.rows[0];
    return res.json({
      success: true,
      message: nameChanged
        ? `Business name changed. You can change it again in ${NAME_CHANGE_DAYS} days.`
        : "Business information saved.",
      dealer: saved,
      name_change: nameChangeInfo(saved.business_name_changed_at)
    });
  } catch (error) {
    console.error("Update dealer profile error:", error);
    return res.status(500).json({ success: false, message: "Unable to save business information. Check the backend logs." });
  }
}


/*
|--------------------------------------------------------------------------
| BUSINESS LOGO (saved on the server so customers and admin see it too)
|--------------------------------------------------------------------------
| Stored in dealers.logo as a small image data URL (the page shrinks it first)
| or an https image link. An empty value removes the logo.
*/

const LOGO_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO_LENGTH = 600000;   /* the page shrinks logos to 512px (about 50 KB); this is a safety cap */

async function updateMyLogo(req, res) {
  try {
    const raw = req.body && typeof req.body === "object" ? req.body.logo : "";
    let logo = String(raw == null ? "" : raw).trim();

    if (logo) {
      const okData = LOGO_DATA_URL.test(logo);
      const okLink = /^https:\/\/[^\s]+$/i.test(logo);
      if (!okData && !okLink) {
        return res.status(400).json({ success: false, message: "Choose a PNG, JPG or WebP image." });
      }
      if (logo.length > MAX_LOGO_LENGTH) {
        return res.status(413).json({ success: false, message: "That image is too large. Choose a smaller one." });
      }
    }

    /* With Cloudinary switched on the logo is uploaded there and only its link is saved (keys empty = old behaviour). */
    const cloud = require("../config/cloudinary-config");
    if (logo && cloud.isConfigured()) {
      if (LOGO_DATA_URL.test(logo)) {
        try { logo = await cloud.uploadDataUrl(logo, "logo"); }
        catch (e) {
          console.error("Cloudinary logo upload failed:", e && e.message);
          return res.status(502).json({ success: false, message: "We could not upload the logo right now. Please try again." });
        }
      } else if (!cloud.isCloudinaryUrl(logo)) {
        return res.status(400).json({ success: false, message: "Choose a PNG, JPG or WebP image." });
      }
    }

    const result = await dealerModel.query(
      "UPDATE dealers SET logo = $1, updated_at = NOW() WHERE id = $2 RETURNING id, logo",
      [logo || null, req.dealer.dealer_id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: "Dealer not found." });

    return res.json({
      success: true,
      message: logo ? "Business logo saved." : "Business logo removed.",
      logo: result.rows[0].logo || ""
    });
  } catch (error) {
    console.error("Update dealer logo error:", error);
    return res.status(500).json({ success: false, message: "Unable to save the logo. Check the backend logs." });
  }
}

/*
|--------------------------------------------------------------------------
| GET ALL DEALERS
|--------------------------------------------------------------------------
*/

async function getDealers(req, res) {
  try {
    await ensureWorkingHoursColumn();
    const result = await dealerModel.query(`
      SELECT
        d.id,
        d.dealer_code,
        d.user_id,
        d.business_name,
        d.contact_person,
        d.phone,
        d.email,
        d.county,
        d.town,
        d.location,
        d.address,
        d.description,
        d.logo,
        d.availability,
        d.working_hours,
        d.status,
        d.latitude,
        d.longitude,
        d.created_at,
        d.updated_at,
        COALESCE(d.is_verified, FALSE) AS is_verified,
        d.verification_started_at,
        d.verification_expires_at,
        ${VERIFICATION_ACTIVE_SQL} AS verification_active,
        COUNT(p.id)::INTEGER AS product_count
      FROM dealers d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN products p
        ON p.dealer_id = d.id
      WHERE COALESCE(u.onboarding_completed, TRUE) = TRUE AND d.status = 'active'
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `);

    await attachDealerCommunityStats(result.rows);
    await attachFollowingFlag(result.rows, req);
    attachWorkingHours(result.rows);

    return res.json({
      success: true,
      dealers: result.rows
    });
  } catch (error) {
    console.error("Get dealers error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load dealers."
    });
  }
}

/*
|--------------------------------------------------------------------------
| GET ONE DEALER
|--------------------------------------------------------------------------
*/

async function getDealerById(req, res) {
  try {
    const { id } = req.params;

    await ensureWorkingHoursColumn();
    const dealerResult = await dealerModel.query(
      `
      SELECT
        d.id,
        d.dealer_code,
        d.user_id,
        d.business_name,
        d.contact_person,
        d.phone,
        d.email,
        d.county,
        d.town,
        d.location,
        d.address,
        d.description,
        d.logo,
        d.availability,
        d.working_hours,
        d.status,
        d.latitude,
        d.longitude,
        d.created_at,
        d.updated_at,
        COALESCE(d.is_verified, FALSE) AS is_verified,
        d.verification_started_at,
        d.verification_expires_at,
        ${VERIFICATION_ACTIVE_SQL} AS verification_active,
        COUNT(p.id)::INTEGER AS product_count
      FROM dealers d
      LEFT JOIN products p
        ON p.dealer_id = d.id
      WHERE d.id = $1
      GROUP BY d.id
      LIMIT 1
      `,
      [id]
    );

    if (dealerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Dealer not found."
      });
    }

    const dealer = dealerResult.rows[0];

    // If dealer is suspended or inactive, take down storefront from public customers
    const authHeader = req.headers.authorization || "";
    const isPublicCustomer = !authHeader;
    if (isPublicCustomer && dealer.status !== "active") {
      return res.status(404).json({
        success: false,
        message: "This dealer outlet is currently inactive or suspended."
      });
    }

    // product_status is an enum with no 'active' value, so it is not compared here.
    const productsResult = await dealerModel.query(
      `
      SELECT *
      FROM products
      WHERE dealer_id = $1
        AND (status = 'available' OR status IS NULL)
      ORDER BY created_at DESC
      `,
      [id]
    );

    // Same rating / review / follower numbers as every dealer list.
    await attachDealerCommunityStats([dealer]);
    await attachFollowingFlag([dealer], req);
    attachWorkingHours([dealer]);

    return res.json({
      success: true,
      dealer,
      products: productsResult.rows
    });
  } catch (error) {
    console.error("Get dealer details error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load dealer details."
    });
  }
}

/*
|--------------------------------------------------------------------------
| UPDATE DEALER VERIFICATION
|--------------------------------------------------------------------------
*/

async function setDealerVerification(req, res) {
  try {
    const { id } = req.params;
    const { verified, expiresAt } = req.body || {};

    const isVerifiedBool = verified === true || String(verified).toLowerCase() === "true";

    let expiryDate = null;

    if (isVerifiedBool) {
      if (expiresAt) {
        expiryDate = new Date(expiresAt);
      }
      if (!expiryDate || Number.isNaN(expiryDate.getTime()) || expiryDate.getTime() <= Date.now()) {
        expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 365);
      }
    }

    const result = await dealerModel.query(
      `
      UPDATE dealers
      SET
        is_verified = $1,
        verification_started_at = CASE
          WHEN $1 = TRUE THEN NOW()
          ELSE NULL
        END,
        verification_expires_at = $2,
        updated_at = NOW()
      WHERE id = $3
      RETURNING
        id,
        dealer_code,
        business_name,
        is_verified,
        verification_started_at,
        verification_expires_at,
        updated_at
      `,
      [isVerifiedBool, expiryDate, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Dealer not found."
      });
    }

    return res.json({
      success: true,
      message: verified
        ? "Dealer verification saved successfully."
        : "Dealer verification revoked successfully.",
      dealer: result.rows[0]
    });
  } catch (error) {
    console.error("Update dealer verification error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update dealer verification."
    });
  }
}

/*
|--------------------------------------------------------------------------
| EXPORT CONTROLLER METHODS
|--------------------------------------------------------------------------
*/

module.exports = {
  VERIFICATION_ACTIVE_SQL,
  getDealerCommunityStats,
  attachDealerCommunityStats,
  ensureWorkingHoursColumn,
  normalizeWorkingHours,
  computeOpenStatus,
  attachWorkingHours,
  getMyWorkingHours,
  updateMyWorkingHours,
  getMyProfile,
  updateMyProfile,
  updateMyLogo,
  followDealer,
  unfollowDealer,
  addDealerReview,
  getDealers,
  getDealerById,
  setDealerVerification
};