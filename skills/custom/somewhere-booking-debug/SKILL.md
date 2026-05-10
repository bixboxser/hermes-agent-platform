# somewhere-booking-debug

## name
somewhere-booking-debug

## description
Debug runbook for Somewhere Staycation Next.js/Supabase booking, admin, calendar, timezone, and availability bugs.

## When to Use
Use when a task mentions Somewhere Staycation booking bugs, timezone/date issues, availability conflicts, Supabase booking records, admin booking screens, or PRs for booking fixes.

## Required tools/env
- Tools: `git`, Node package manager used by the app, Supabase CLI if configured.
- Env/context: project repo path, Supabase URL/anon key for local or staging only, test booking data.

## Procedure
1. Reproduce with exact property, date, timezone, guest count, and admin/customer path.
2. Inspect date parsing, storage timezone, conflict queries, and display formatting.
3. Check Supabase RLS/policies and generated types if relevant.
4. Write or update tests for the failing booking scenario.
5. Implement the smallest fix and avoid broad schema changes unless required.
6. Create a PR with reproduction, fix, tests, and risk notes.

## Pitfalls
- Timezone bugs can hide when local timezone differs from Vietnam/customer timezone.
- Do not use production Supabase keys in chat.
- Do not mutate production bookings without approval.
- Keep admin permission checks intact.

## Verification
- Booking conflict test passes.
- Date/time display is correct for target timezone.
- Admin and customer flows agree on booking state.
- PR includes screenshots or logs when UI behavior changed.

## Safety/approval notes
Production booking data changes, Supabase migrations, and payment-impacting booking changes require explicit approval.
