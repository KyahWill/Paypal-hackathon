# Leslie: AI charity reimbursement agent (working name)

## What this is
Built for the PayPal AI Hackathon (Devpost). Submission deadline: Nov 12, 2026, 12:00 PM PT.

Donors give to a specific charity project through a simple donation page. The charity spends first, then files a reimbursement claim by chatting with Leslie, an AI assistant, and uploading a receipt. A verifier agent checks the receipt against the project's donated pool. Approved claims are paid automatically to the charity's PayPal account via Payouts. Anything the system cannot process safely is escalated to a human admin.

Demo hero moment: the charity treasurer uploads a receipt, watches the verifier's checks complete live, and sees the reimbursement arrive in their PayPal account.

## Stack
- Next.js (App Router) + TypeScript, one app, deployed on Render
- Postgres on Neon (free tier) via Prisma
- AI: Gemini through the Vercel AI SDK (`ai`, `@ai-sdk/google`). Model name comes from env `GEMINI_MODEL`; never hardcode it.
- PayPal (sandbox only):
  - Donations: PayPal JS SDK buttons + Orders v2 (create/capture on the server)
  - Agent read tools: `@paypal/agent-toolkit` (ai-sdk entry point)
  - Reimbursements: Payouts API through a small typed client in `lib/paypal/payouts.ts`
- Auth: seeded users, hashed passwords, encrypted cookie session (iron-session). No magic links.

## Roles
- Donor: public, no login
- Charity treasurer: logs in, chats with Leslie, sees their claims
- Admin (platform operator): logs in, works the escalation queue

## Non-negotiable rules
1. The LLM never moves money. Only `executeReimbursement(claimId)` calls Payouts, and it re-runs the guardrail checks inside a DB transaction first.
2. Money is stored as integer minor units with an explicit currency. Currency comes from env `CURRENCY`.
3. Payouts are idempotent: `sender_batch_id` is derived from the claim id. A claim can never be paid twice.
4. Every claim state change writes a row to an append-only `AuditLog`.
5. Secrets only in env. Never log tokens, secrets, or full PayPal responses containing them.
6. If a PayPal or Gemini API behaves differently than this file assumes, stop and report. Do not invent workarounds silently.

## Claim lifecycle
SUBMITTED -> VERIFYING -> APPROVED -> PAYING -> PAID
VERIFYING -> REJECTED (deterministic check failed; charity may resubmit)
VERIFYING -> ESCALATED (model or system could not decide safely)
ESCALATED -> APPROVED or REJECTED (admin decision)
PAYING -> ESCALATED (payout failed)

## Verifier checks
1. Receipt readable and parsed: vendor, date, line items, total, currency, with a confidence score
2. Amount <= project's available balance (captured donations minus paid and in-flight reimbursements)
3. Purchase date within the project's start/end window
4. Line items plausibly serve the project's stated purpose
5. Not a duplicate (same vendor + date + total, or same image hash, as any prior claim)
6. Pool confirmation: the agent uses Agent Toolkit read tools to confirm the donations in our ledger exist as completed captures in PayPal

## Verdict codes
- APPROVED
- REJECTED_OVER_BALANCE, REJECTED_OUTSIDE_WINDOW, REJECTED_DUPLICATE
- ESCALATED_UNREADABLE_RECEIPT, ESCALATED_EXTRACTION_FAILED, ESCALATED_LOW_CONFIDENCE, ESCALATED_ITEM_MISMATCH, ESCALATED_LEDGER_MISMATCH, ESCALATED_MODEL_ERROR, ESCALATED_PAYPAL_ERROR

## Working style
- Work in small steps, commit after each working step
- Run `tsc --noEmit` and tests before declaring a phase done
- End each phase with a short report: what works, what doesn't, what you assumed
- User-facing copy: warm, plain English, no em-dashes
