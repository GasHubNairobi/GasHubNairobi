# Database migrations (Supabase SQL Editor)

The base tables (`users`, `dealers`, `products`, `orders`, `payments`, ...) already exist in your Supabase project.
These files add features on top. Each one is safe to run again. Run any you have not run yet, then **always finish with 007**.

| File | Adds |
|---|---|
| `dealer-first-login-migration.sql`, `dealer-application-migration.sql`, `dealer-application-review-columns.sql` | dealer first-login setup and public dealer applications |
| `customer-ban-migration.sql`, `customer-profile-rewards-migration.sql` | customer bans, profile and GasHub points |
| `payment-confirmation-migration.sql`, `payment-after-confirmation-migration.sql`, `refunds-migration.sql` | payment confirmation flow and refunds |
| `order-times-migration.sql`, `live-tracking-migration.sql`, `delivery-messengers-migration.sql`, `messenger-email-and-link-security-migration.sql` | order times, live tracking, messengers |
| `dealer-purchases-migration.sql`, `dealer-verification-migration.sql` | dealer purchases and verification payments |
| `messaging-migration.sql`, `reviews-migration.sql`, `social-settings-and-product-views-migration.sql` | chat, reviews, social settings |
| `migration-006-serverless.sql` | session and rate-limit tables for Netlify (optional: created automatically) |
| **`migration-007-enable-rls.sql`** | **locks every table against Supabase's public REST API. Run it.** |
