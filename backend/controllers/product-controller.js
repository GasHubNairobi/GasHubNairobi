const productModel = require("../models/product-model");
const { generateCode, normalizeStatus, formatProduct } = require("../utils/assistant");
const { getDealerCommunityStats } = require("./dealer-controller");
const { ensureLastSeenColumn, LAST_SEEN_SQL, ONLINE_SQL } = require("../utils/dealer-presence");

/* Product views are counted on the server (table product_view_events) so every customer, signed in or not,
   sees the same number. Logging out can never reset it because it is not stored in the browser. */
let viewTableReady = null;
function ensureViewTable() {
    if (!viewTableReady) {
        /* No foreign key and a text id on purpose: it works whatever type products.id has, and a problem here
           can never stop the products from loading. */
        viewTableReady = productModel.query(`
            CREATE TABLE IF NOT EXISTS product_view_events (
                id BIGSERIAL PRIMARY KEY,
                product_id TEXT NOT NULL,
                viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`).catch((e) => { viewTableReady = null; throw e; });
    }
    return viewTableReady;
}
/* SQL for the view count column. If the views table cannot be used, products still load (without a count). */
async function viewCountSql() {
    try {
        await ensureViewTable();
        return "(SELECT COUNT(*)::INTEGER FROM product_view_events v WHERE v.product_id::text = p.id::text) AS view_count";
    } catch (e) {
        console.error("Product views unavailable:", e.message);
        return "NULL::INTEGER AS view_count";
    }
}

/* POST /api/products/:id/view  -> adds one view, returns the new total */
async function recordProductView(req, res) {
    try {
        const id = String(req.params.id || "").trim();
        if (!id || id.length > 64) return res.status(400).json({ success: false, message: "Invalid product." });
        await ensureViewTable();
        const exists = await productModel.query("SELECT 1 FROM products WHERE id::text = $1", [id]);
        if (!exists.rows.length) return res.status(404).json({ success: false, message: "Product not found." });
        await productModel.query("INSERT INTO product_view_events (product_id) VALUES ($1::text)", [id]);
        const c = await productModel.query("SELECT COUNT(*)::INTEGER AS n FROM product_view_events WHERE product_id::text = $1", [id]);
        res.json({ success: true, view_count: c.rows[0].n });
    } catch (error) {
        console.error("Record view error:", error);
        res.status(500).json({ success: false, message: "Unable to record view." });
    }
}

async function getProducts(req, res) {
    try {
        await ensureLastSeenColumn();
        const viewSql = await viewCountSql();
        const result = await productModel.query(`
            SELECT
                p.id,
                p.product_code,
                p.name,
                p.category,
                p.cylinder_size,
                p.cylinder_unit,
                p.price,
                p.dealer_id,
                p.description,
                p.image,
                p.status,
                p.stock_quantity,
                p.featured,
                p.created_at,
                p.updated_at,

                d.business_name,
                d.logo AS dealer_logo,
                d.location AS dealer_location,
                d.latitude AS dealer_latitude,
                d.longitude AS dealer_longitude,
                (
                    COALESCE(d.is_verified, FALSE) = TRUE
                    AND d.verification_expires_at IS NOT NULL
                    AND d.verification_expires_at > NOW()
                ) AS dealer_is_verified,
                d.phone AS dealer_phone,
                d.email AS dealer_email,
                d.status AS dealer_status,
                d.verification_expires_at AS dealer_verification_expires_at,
                ${LAST_SEEN_SQL},
                ${ONLINE_SQL},
                ${viewSql}

            FROM products p

            JOIN dealers d
                ON d.id = p.dealer_id

            WHERE d.status = 'active'
              AND (p.status::text IN ('available', 'active') OR p.status IS NULL)
              AND (p.stock_quantity IS NULL OR p.stock_quantity > 0)

            ORDER BY p.created_at DESC
        `);

        // Rating comes from the same reviews data the dealer pages use.
        const stats = await getDealerCommunityStats(result.rows.map((row) => row.dealer_id));
        result.rows.forEach((row) => {
            const entry = stats.get(String(row.dealer_id));
            row.dealer_rating = entry && entry.review_count > 0 ? entry.rating : null;
            row.dealer_follower_count = entry ? entry.follower_count || 0 : 0;
        });

        res.json({
            success: true,
            products: result.rows.map(formatProduct)
        });
    } catch (error) {
        console.error("Get products error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load products.",
            detail: error.message
        });
    }

}

async function getProductById(req, res) {
    try {
        await ensureLastSeenColumn();
        const viewSql = await viewCountSql();
        const result = await productModel.query(
            `
            SELECT
                p.id,
                p.product_code,
                p.name,
                p.category,
                p.cylinder_size,
                p.cylinder_unit,
                p.price,
                p.dealer_id,
                p.description,
                p.image,
                p.status,
                p.stock_quantity,
                p.featured,
                p.created_at,
                p.updated_at,

                d.business_name,
                d.logo AS dealer_logo,
                d.location AS dealer_location,
                d.latitude AS dealer_latitude,
                d.longitude AS dealer_longitude,
                (
                    COALESCE(d.is_verified, FALSE) = TRUE
                    AND d.verification_expires_at IS NOT NULL
                    AND d.verification_expires_at > NOW()
                ) AS dealer_is_verified,
                d.phone AS dealer_phone,
                d.email AS dealer_email,
                d.status AS dealer_status,
                d.verification_expires_at AS dealer_verification_expires_at,
                ${LAST_SEEN_SQL},
                ${ONLINE_SQL},
                ${viewSql}

            FROM products p

            LEFT JOIN dealers d
                ON d.id = p.dealer_id

            WHERE p.id = $1
              AND (d.status = 'active' OR p.dealer_id IS NULL)
              AND (p.status::text IN ('available', 'active') OR p.status IS NULL)
            LIMIT 1
            `,
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Product not found."
            });
        }

        const stats = await getDealerCommunityStats([result.rows[0].dealer_id]);
        const entry = stats.get(String(result.rows[0].dealer_id));
        result.rows[0].dealer_rating = entry && entry.review_count > 0 ? entry.rating : null;
        result.rows[0].dealer_follower_count = entry ? entry.follower_count || 0 : 0;

        res.json({
            success: true,
            product: formatProduct(result.rows[0])
        });
    } catch (error) {
        console.error("Get product error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load product."
        });
    }

}

async function createProduct(req, res) {
    try {
        const {
            name,
            product_code,
            category,
            cylinder_size,
            price,
            dealer_id,
            description,
            status,
            image,
            stock_quantity,
            featured
        } = req.body;

        if (
            !name ||
            !category ||
            price === undefined ||
            !dealer_id
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Name, category, price and dealer are required."
            });
        }

        const dealerResult = await productModel.query(
            `
            SELECT id
            FROM dealers
            WHERE id = $1
            LIMIT 1
            `,
            [dealer_id]
        );

        if (dealerResult.rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Selected dealer was not found."
            });
        }

        const productCode =
            product_code &&
            String(product_code).trim()
                ? String(product_code).trim()
                : generateCode("GAS");

        const normalizedProductStatus =
            normalizeStatus(status);

        const productStatus =
            [
                "available",
                "out_of_stock",
                "inactive"
            ].includes(normalizedProductStatus)
                ? normalizedProductStatus
                : "available";

        const result = await productModel.query(
            `
            INSERT INTO products (
                product_code,
                dealer_id,
                name,
                category,
                cylinder_size,
                price,
                description,
                image,
                status,
                stock_quantity,
                featured
            )
            VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11
            )
            RETURNING *
            `,
            [
                productCode,
                dealer_id,
                String(name).trim(),
                String(category).trim(),
                cylinder_size === "" ||
                cylinder_size === undefined
                    ? null
                    : cylinder_size,
                Number(price),
                description || null,
                image || null,
                productStatus,
                stock_quantity === undefined ||
                stock_quantity === ""
                    ? 0
                    : Number(stock_quantity),
                Boolean(featured)
            ]
        );

        const fullProduct = await productModel.query(
            `
            SELECT
                p.*,
                d.business_name,
                d.location AS dealer_location

            FROM products p

            LEFT JOIN dealers d
                ON d.id = p.dealer_id

            WHERE p.id = $1
            `,
            [result.rows[0].id]
        );

        res.status(201).json({
            success: true,
            message: "Product created successfully.",
            product: formatProduct(
                fullProduct.rows[0]
            )
        });
    } catch (error) {
        console.error("Create product error:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                success: false,
                message: "The product code already exists."
            });
        }

        res.status(500).json({
            success: false,
            message: "Unable to create product."
        });
    }

}

async function updateProduct(req, res) {
        try {
            const {
                name,
                product_code,
                category,
                cylinder_size,
                price,
                dealer_id,
                description,
                status,
                image,
                stock_quantity,
                featured
            } = req.body;

            if (
                !name ||
                !category ||
                price === undefined ||
                !dealer_id
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Name, category, price and dealer are required."
                });
            }

            const existing = await productModel.query(
                `
                SELECT id
                FROM products
                WHERE id = $1
                LIMIT 1
                `,
                [req.params.id]
            );

            if (existing.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Product not found."
                });
            }

            const dealer = await productModel.query(
                `
                SELECT id
                FROM dealers
                WHERE id = $1
                LIMIT 1
                `,
                [dealer_id]
            );

            if (dealer.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "Selected dealer was not found."
                });
            }

            const normalizedProductStatus =
                normalizeStatus(status);

            const productStatus =
                [
                    "available",
                    "out_of_stock",
                    "inactive"
                ].includes(normalizedProductStatus)
                    ? normalizedProductStatus
                    : "available";

            const result = await productModel.query(
                `
                UPDATE products
                SET
                    product_code =
                        COALESCE(
                            NULLIF($1, ''),
                            product_code
                        ),
                    dealer_id = $2,
                    name = $3,
                    category = $4,
                    cylinder_size = $5,
                    price = $6,
                    description = $7,
                    image = $8,
                    status = $9,
                    stock_quantity = $10,
                    featured = $11
                WHERE id = $12
                RETURNING *
                `,
                [
                    product_code
                        ? String(product_code).trim()
                        : "",
                    dealer_id,
                    String(name).trim(),
                    String(category).trim(),
                    cylinder_size === "" ||
                    cylinder_size === undefined
                        ? null
                        : cylinder_size,
                    Number(price),
                    description || null,
                    image || null,
                    productStatus,
                    stock_quantity === undefined ||
                    stock_quantity === ""
                        ? 0
                        : Number(stock_quantity),
                    Boolean(featured),
                    req.params.id
                ]
            );

            const fullProduct = await productModel.query(
                `
                SELECT
                    p.*,
                    d.business_name,
                    d.location AS dealer_location

                FROM products p

                LEFT JOIN dealers d
                    ON d.id = p.dealer_id

                WHERE p.id = $1
                `,
                [result.rows[0].id]
            );

            res.json({
                success: true,
                message: "Product updated successfully.",
                product: formatProduct(
                    fullProduct.rows[0]
                )
            });
        } catch (error) {
            console.error(
                "Update product error:",
                error
            );

            if (error.code === "23505") {
                return res.status(409).json({
                    success: false,
                    message:
                        "The product code already exists."
                });
            }

            res.status(500).json({
                success: false,
                message: "Unable to update product."
            });
        }
    
}

async function deleteProduct(req, res) {
        try {
            const result = await productModel.query(
                `
                DELETE FROM products
                WHERE id = $1
                RETURNING id
                `,
                [req.params.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Product not found."
                });
            }

            res.json({
                success: true,
                message: "Product deleted successfully."
            });
        } catch (error) {
            console.error(
                "Delete product error:",
                error
            );

            res.status(500).json({
                success: false,
                message: "Unable to delete product."
            });
        }
    
}

module.exports = {
    recordProductView,
    getProducts,
    getProductById,
    createProduct,
    updateProduct,
    deleteProduct,
};