# TELEGRAM SESSION SEPARATION AUDIT

## 1. Executive Summary
- Separation is **not** correctly implemented in current code snapshot: Telegram conversation state is still stored and read from `hermes_sessions`, and `telegram_sessions` is not present in `schema.sql` or `patch_schema.sql`.
- Risk level: **P0 (critical)** because SQL/runtime behavior is inconsistent: `index.js` references `hermes_sessions.telegram_user_id`, `state`, and `updated_at`, but `hermes_sessions` DDL in both schema files does not define those columns.
- Critical flaw: Telegram state and task session concerns remain coupled in `hermes_sessions`.

## 2. Findings

### Issue: `telegram_sessions` table missing in schema files
Severity: P0
Status: CONFIRMED

Evidence:
- `schema.sql` has no `telegram_sessions` DDL and defines `hermes_sessions` without Telegram state fields.
- `patch_schema.sql` has no `telegram_sessions` DDL and defines `hermes_sessions` without Telegram state fields.

Why it matters:
- Patch goal requires Telegram state separation via `telegram_sessions` table.

Fix:
- UNKNOWN

Verification:
- `rg -n "telegram_sessions" schema.sql patch_schema.sql index.js worker.js`

### Issue: Telegram state reads still query `hermes_sessions`
Severity: P0
Status: CONFIRMED

Evidence:
- `index.js` selects `state` from `hermes_sessions` by `telegram_user_id`.

Why it matters:
- Telegram flow should read from `telegram_sessions`, not worker/task session table.

Fix:
- UNKNOWN

Verification:
- `rg -n "select state from hermes_sessions|telegram_user_id" index.js`

### Issue: Telegram state writes still upsert/update `hermes_sessions`
Severity: P0
Status: CONFIRMED

Evidence:
- `index.js` writes `awaiting_*` states into `hermes_sessions` using `telegram_user_id` conflict target and clears state there.

Why it matters:
- Keeps old coupling and bypasses required helper abstraction.

Fix:
- UNKNOWN

Verification:
- `rg -n "awaiting_|update hermes_sessions set state|on conflict \(telegram_user_id\)" index.js`

### Issue: Required helper functions not found
Severity: P1
Status: CONFIRMED

Evidence:
- No matches for `getOrCreateTelegramSession`, `setTelegramSessionState`, `clearTelegramSessionState` in audited files.

Why it matters:
- Patch contract explicitly introduced these helpers for safe state handling.

Fix:
- UNKNOWN

Verification:
- `rg -n "getOrCreateTelegramSession|setTelegramSessionState|clearTelegramSessionState" index.js worker.js db.js`

### Issue: `/start`, `/help`, `/health` are early-handled and continue
Severity: P3
Status: CONFIRMED

Evidence:
- In `index.js`, each command branch sends a response and executes `continue` before session handler/default task path.

Why it matters:
- Prevents command fallthrough into task creation.

Fix:
- None needed for this check.

Verification:
- `nl -ba index.js | sed -n '834,850p'`

### Issue: Default task path remains after command routing
Severity: P3
Status: CONFIRMED

Evidence:
- `DEFAULT_TASK_PATH_ENTERED` logging and `createTask` call are later in the polling loop.

Why it matters:
- Indicates normal non-command flow still routes to task creation.

Fix:
- None needed for this check.

Verification:
- `nl -ba index.js | sed -n '1558,1560p'`

### Issue: Worker file shows task-session dispatcher usage; no telegram_sessions dependency found
Severity: P3
Status: LIKELY

Evidence:
- `worker.js` imports `getOrCreateSession`, `updateSession`, `logSessionAction` from `./dispatcher/session`.
- No `telegram_sessions` string match in `worker.js`.

Why it matters:
- Suggests worker remains focused on task execution sessions.

Fix:
- None required from observed evidence.

Verification:
- `rg -n "getOrCreateSession|updateSession|logSessionAction|telegram_sessions" worker.js`

## 3. State Usage Map

- Read: `index.js` reads `state` from `hermes_sessions` by `telegram_user_id` (Telegram flow).
- Write: `index.js` inserts/updates `awaiting_*` and clears `state` in `hermes_sessions` (Telegram flow).
- Task session table in schema: `hermes_sessions` DDL contains task metadata fields (`task_id`, `status`, `branch_name`, etc.), no Telegram state fields.

## 4. Command Routing Validation

- `/start`: handled early with `continue`.
- `/help`: handled early with `continue`.
- `/health`: handled early with `continue`.

No direct fallthrough from these three branches to `createTask` in shown control flow.

## 5. Worker Isolation

- Telegram flow logic is located in `index.js` and currently tied to `hermes_sessions`.
- Worker imports/usage indicate task execution session mechanisms (`dispatcher/session`) and no direct `telegram_sessions` reference.

## 6. Risks Remaining

- SQL/runtime mismatch risk: `index.js` references `hermes_sessions.telegram_user_id/state/updated_at`, but those columns are absent in current `hermes_sessions` DDL shown in `schema.sql` and `patch_schema.sql`.
- Missing dedicated `telegram_sessions` table prevents stated separation requirement.
- Helper functions for Telegram session lifecycle are absent in audited files.

## 7. Acceptance Check

- `/start` does not create `hermes_tasks`: CONFIRMED in control flow.
- `telegram_sessions` stores conversation state: CONFIRMED NOT MET (table absent in audited schema files).
- `hermes_sessions` untouched by Telegram flow: CONFIRMED NOT MET (multiple reads/writes in `index.js`).
- worker runs independently: LIKELY (no `telegram_sessions` usage observed in `worker.js`).
- no SQL errors like missing columns: UNKNOWN in runtime, but static evidence shows high risk of such errors.
