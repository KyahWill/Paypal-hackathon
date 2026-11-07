# Running the demo

> The chat and payout flow are not built yet, and the verifier has not read a receipt with a real model. This is the planned script, and the data for it is ready. Update this page once the flow runs for real.

## The story

Samahang Kabataan ng Bagong Tanaw is a fictional youth org raising money for school supplies at Bagong Tanaw Elementary School. Its treasurer has already been reimbursed once, and now files a new claim.

The moment to land: the treasurer uploads a receipt, watches the checks complete live, and sees the reimbursement arrive in PayPal.

## Logins

| Role | Credentials |
| --- | --- |
| Treasurer | `SEED_TREASURER_EMAIL` and `SEED_TREASURER_PASSWORD` |
| Admin | `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` |
| Donor | None needed. Give at `/p/balik-eskwela` as the sandbox buyer |
| PayPal receiver | The sandbox Personal account, to show the money arriving |

## Demo receipts

They are in `seed/receipts/`. The available balance starts at PHP 18,262.00.

| File | Store | Total | Expected outcome |
| --- | --- | --- | --- |
| `clean-valid.png` | Tala at Lapis School Supplies | PHP 3,915.00 | `APPROVED`, then paid |
| `over-balance.png` | Bukang-Liwayway Wholesale | PHP 22,162.50 | `REJECTED_OVER_BALANCE` |
| `duplicate-of-paid.png` | Kaibigan Paper & Pen Center | PHP 5,988.00 | `REJECTED_DUPLICATE` |
| `blurry-unreadable.png` | Aninag Variety Store | Unreadable | `ESCALATED_UNREADABLE_RECEIPT` |

Upload the files exactly as they are. The duplicate matches the paid claim by image hash, as well as by vendor, date and total.

No real model has read these images yet, because the Gemini key is blocked. Test all four before relying on them, especially the blurry one.

## Before presenting

1. Reset the demo, see [deploy.md](deploy.md). Each run of the clean receipt counts as a duplicate of the last one until you do.
2. Open the site a few minutes early, because the Free plan takes about a minute to wake.
3. Check `/api/health`.
4. Log in to the sandbox receiver account in another tab.
5. Keep a recording ready in case the sandbox is slow. Payouts took about 30 seconds in the one run measured.

Test donations raise the pool. After about PHP 3,900 of them, `over-balance.png` is no longer over the balance, so reset the demo after trying out donations.

Keep an eye on the sandbox sender's balance. Payouts draw from it, and a reset does not refill it.
