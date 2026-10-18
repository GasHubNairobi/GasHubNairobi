# GasHub Payout Planner (Admin > Payout Planner)

## The money flow
- **IN: the Till.** Customers pay with M-Pesa (STK push, Buy Goods). Nothing to schedule.
- **OUT: the Paybill.** Customer withdrawals, dealer payouts (and refunds) are sent from the Paybill with Safaricom B2C.
- **You top the Paybill up by hand** (move money from the Till's settlement account to the Paybill).
  The planner tells you exactly how much, so you never run short.

## Netlify + Supabase settings (Netlify > Site settings > Environment variables)
Customers pay the Till:
    MPESA_SHORTCODE=<Till number>        MPESA_PARTYB=<Till number>
    MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline        MPESA_PASSKEY=<the Till's passkey>
Money goes out of the Paybill:
    MPESA_B2C_SHORTCODE=<Paybill number>
    MPESA_B2C_INITIATOR_NAME=...     MPESA_B2C_SECURITY_CREDENTIAL=...      (see ENV-AUTO-PAYOUT.txt)
Both:
    MPESA_CALLBACK_BASE_URL=https://your-site   MPESA_CALLBACK_SECRET=<24+ random characters>
Nothing else to set up: Netlify's scheduled function "cron-minute" (netlify.toml) runs every minute on the PUBLISHED (production) deploy
and starts the background function that sends the money. Supabase needs no migration: the planner tables/columns are created on first use.
Use the Supabase connection POOLER details for DB_HOST / DB_PORT / DB_USER / DB_PASSWORD.
You do NOT need AUTO_DEALER_PAYOUTS, CRON_SECRET or any Render setting for the planner.

## 1. How much must be in the Paybill
Total = customer withdrawals + dealer payouts sent automatically + M-Pesa charge per payment + safety extra %.
- Customer amount = coins x TODAY's rate, minus the withdrawal charge, rounded to whole shillings (what M-Pesa really sends).
- Confirmed = approved by you. Waiting requests are counted too unless the schedule says "send only approved".
- Dealer amount = completed orders past the hold period: goods - commission + delivery fee; cash orders only subtract commission.
  Money not yet in a payout ("Earned") is included, because the next run turns it into payouts.
- Paybill/Till dealer destinations and payments above the per-payment limit are listed as "by hand" and not in the total.
- Type your Paybill balance (from the M-Pesa portal) and press Save. The page then shows an estimate = that balance minus
  everything sent since, and "Deposit this much more". Update it after each top-up.

## 2. Scheduling (one box per group)
Off / Once on a date / Every day / Every week, at a time in Nairobi time. Plus "Send now".
- Customers: sends every waiting/approved request not yet tried. Customers see "GasHub will send withdrawals on ...".
- Dealers: at the run, a payout is created for every dealer with money ready (their own hold hours and minimum respected)
  and the phone ones are sent. The per-dealer settings (phone/paybill/till, hold, minimum) still apply.
- Saving a weekly/daily schedule never fires for a time that already passed.
- A run missed by more than 12 hours (server off) is skipped, not sent late. Use Send now.

## Safety (unchanged, reused)
Each payment is claimed under a database lock, marked Paid only when Safaricom confirms, never sent twice, and no answer from
M-Pesa is never retried automatically. If the Paybill is short, Safaricom says "insufficient funds": dealer payouts retry
(30 and 60 min), customer ones show "Send again".

## One route, one schedule (no collisions)
- **One account sends money:** the Paybill in MPESA_B2C_SHORTCODE. There is no fallback to the Till (MPESA_SHORTCODE); if they are the
  same number, sending stays switched off. Withdrawals, dealer payouts and refunds all go through this one route.
- **One schedule per group, only in Payout Planner.** Retired: the "Schedule Payouts" box on Point Withdrawals, and the per-dealer
  daily/weekly settings on the dealer page. Those pages now show the same schedule banner (same wording, next run, last result).
- Still on the other pages: per-row Send now / Hold / Release / Mark paid / Cancel (manual actions on the same payouts and statuses),
  each dealer's destination, hold hours and minimum, and "Create this dealer's payout" (it is sent at the next dealer run).
- The dealer's own Payouts page shows the same next-run time.

## Deposits (IN) are separate from payouts (OUT)
| | IN: customer payments | OUT: payouts and refunds |
|---|---|---|
| Account | Till: MPESA_SHORTCODE (+ MPESA_PARTYB) | Paybill: MPESA_B2C_SHORTCODE |
| Safaricom calls | /api/payments/mpesa/callback/<secret>, /c2b/confirmation/<secret> | /api/payments/mpesa/b2c/result/<secret>, /timeout/<secret> |
Guards in the code:
- Same number on both sides (also MPESA_PARTYB = Paybill): BOTH routes switch off and the Payout Planner shows "Fix needed".
- A payment notice (C2B) for any shortcode other than the Till is ignored, so topping up the Paybill can never be read as a customer payment.
- Settings > "customers pay to" cannot be saved as the payout Paybill, and is never shown to customers if it matches.
- Only prompts GasHub itself sent can mark an order paid (unchanged), and each answer is re-checked with Safaricom.
