# somewhere-payment-admin-debug

## name
somewhere-payment-admin-debug

## description
Debug runbook for Somewhere Staycation payOS payments, QR generation, webhook handling, and admin payment state.

## When to Use
Use for payOS QR/payment failures, webhook signature issues, payment polling, admin payment status bugs, or Supabase payment records.

## Required tools/env
- Tools: `git`, Node package manager used by the app.
- Env/context: payOS sandbox credentials in environment only, webhook URL, Supabase staging access.

## Procedure
1. Identify payment path: QR creation, redirect, polling, webhook, or admin reconciliation.
2. Reproduce with sandbox/test order and record IDs, never real customer secrets.
3. Validate webhook signature/checksum behavior without logging secret material.
4. Compare payOS status, Supabase payment row, booking row, and admin UI state.
5. Add regression coverage for idempotency and duplicate webhook delivery.
6. Verify customer and admin views after the fix.

## Pitfalls
- Do not paste payOS keys or checksum secrets into chat or memory.
- Do not mark real payments paid manually without approval and audit trail.
- Webhooks can be duplicated or delayed; keep idempotency.
- Payment fixes can affect booking confirmation logic.

## Verification
- Sandbox payment flow reaches the expected terminal state.
- Webhook idempotency test passes.
- Admin payment screen reflects Supabase/payOS state.
- Logs redact payment credentials and customer-sensitive data.

## Safety/approval notes
Real payment changes, webhook endpoint changes, and admin reconciliation require explicit approval and post-change verification.
