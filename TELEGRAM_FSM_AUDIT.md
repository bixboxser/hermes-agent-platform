# TELEGRAM FSM AUDIT

## 1. Executive Summary
- FSM correctly implemented? **No**.
- Risk level: **P1**.
- Biggest flaw: no `TELEGRAM_STATES` constant and no `handleTelegramState(...)` centralized handler; Telegram state handling remains scattered in inline `if (sessionState === ...)` blocks.

---

## 2. Findings

### Issue: `TELEGRAM_STATES` constant not found
Severity: P1
Status: CONFIRMED

Evidence:
- No `TELEGRAM_STATES` symbol in `index.js` or `worker.js` (search evidence).

Why it matters:
- Checklist requires explicit FSM constant with standardized states.

Fix:
- UNKNOWN

Verification:
- `rg -n "TELEGRAM_STATES" index.js worker.js`

---

### Issue: `handleTelegramState(...)` function not found
Severity: P1
Status: CONFIRMED

Evidence:
- No `handleTelegramState` function definition or invocation in `index.js`.

Why it matters:
- FSM centralization requirement is not satisfied.

Fix:
- UNKNOWN

Verification:
- `rg -n "handleTelegramState" index.js`

---

### Issue: Scattered Telegram state branches remain in main loop
Severity: P1
Status: CONFIRMED

Evidence:
- Inline branches still check state directly:
  - `if (sessionState === "awaiting_deploy_check")`.
  - `if (sessionState === "awaiting_codex")`.
  - `if (sessionState === "awaiting_review")`.
  - `if (sessionState === "awaiting_recall")`.
  - `if (sessionState === "awaiting_learn")`.
  - `if (sessionState === "awaiting_audit")`.
  - duplicate `if (sessionState === "awaiting_codex")` appears later.

Why it matters:
- Violates “centralized FSM handler” objective and introduces duplicate handling risk.

Fix:
- UNKNOWN

Verification:
- `rg -n "if \(sessionState === \"awaiting_" index.js`

---

### Issue: FSM-specific logging keys absent (`FSM_HANDLED`, `FSM_TRANSITION`)
Severity: P2
Status: CONFIRMED

Evidence:
- No matches for `FSM_HANDLED` or `FSM_TRANSITION` in `index.js` / `worker.js`.

Why it matters:
- Requested observability markers are absent.

Fix:
- UNKNOWN

Verification:
- `rg -n "FSM_HANDLED|FSM_TRANSITION" index.js worker.js`

---

### Issue: Command routing safety for `/start`, `/help`, `/health` remains intact
Severity: P3
Status: CONFIRMED

Evidence:
- `/start`, `/help`, `/health` each sends response and `continue` immediately.
- Session logic begins later after these checks.

Why it matters:
- Confirms no regression in early command bypass behavior.

Fix:
- None.

Verification:
- `nl -ba index.js | sed -n '847,863p'`

---

### Issue: Default task path still reachable for non-command text
Severity: P3
Status: CONFIRMED

Evidence:
- `DEFAULT_TASK_PATH_ENTERED` log followed by `createTask(...)` remains in main loop tail.

Why it matters:
- Confirms default flow still exists; however this is not mediated by a centralized FSM handler.

Fix:
- UNKNOWN

Verification:
- `nl -ba index.js | sed -n '1556,1558p'`

---

### Issue: Worker isolation from FSM artifacts
Severity: P3
Status: CONFIRMED

Evidence:
- No `TELEGRAM_STATES` or `handleTelegramState` symbols in `worker.js`.

Why it matters:
- Worker has no dependency on FSM symbols.

Fix:
- None.

Verification:
- `rg -n "TELEGRAM_STATES|handleTelegramState" worker.js`

---

## 3. FSM Structure

- States constant list via `TELEGRAM_STATES`: **UNKNOWN** (not found).
- Observed raw transitions via `setTelegramSessionState(...)` calls:
  - `'awaiting_deploy_check'`
  - `'awaiting_codex'`
  - `'awaiting_review'`
  - `'awaiting_recall'`
  - `'awaiting_learn'`
  - `'awaiting_audit'`
- Observed clear transition: `clearTelegramSessionState(userId)` after each inline state handler.

Evidence:
- `index.js` callback state setters and inline state handlers.

---

## 4. Integration Validation

- `getOrCreateTelegramSession(userId)` is called in message flow.
- No `handleTelegramState(...)` call exists.
- No `const handled = await handleTelegramState(...)` / `if (handled) continue;` pattern found.

Evidence:
- `index.js` session retrieval and direct inline state checks.

---

## 5. Remaining Legacy Logic

Leftover inline logic (not centralized):
- `if (sessionState === "awaiting_deploy_check")`
- `if (sessionState === "awaiting_codex")` (appears twice)
- `if (sessionState === "awaiting_review")`
- `if (sessionState === "awaiting_recall")`
- `if (sessionState === "awaiting_learn")`
- `if (sessionState === "awaiting_audit")`

Status: **CONFIRMED**.

---

## 6. Command Flow Safety

- `/start`: reply + immediate continue.
- `/help`: reply + immediate continue.
- `/health`: reply + immediate continue.

These branches occur before session-state handling in current control flow.

---

## 7. Risks Remaining

- Centralized FSM contract not implemented (missing constant + handler).
- Duplicate `awaiting_codex` handler branch introduces duplicate path risk.
- Missing FSM logging keys (`FSM_HANDLED`, `FSM_TRANSITION`) reduces traceability for state handling verification.

All above are evidence-based from current source.

---

## 8. Acceptance Check

System is correct if:

- FSM handles all Telegram states → **NOT MET (CONFIRMED)**.
- No scattered state logic remains → **NOT MET (CONFIRMED)**.
- Commands bypass FSM → **PARTIAL**: commands bypass state logic via early continue, but no FSM exists.
- Default flow works → **MET (CONFIRMED)** via default task path log + task creation.
- No duplicate handling → **NOT MET (CONFIRMED)** due duplicate `awaiting_codex` inline branch.
