# PLANNER EXECUTOR AUDIT

## 1. Executive Summary
- Planner implemented? **PARTIAL**.
- Executor implemented? **PARTIAL**.
- Worker integration? **YES** (via `runWithRoles` call path).
- Risk level: **P1**.

---

## 2. Findings

### Issue: Required planner function name `createPlanForTask(...)` not found
Severity: P2
Status: CONFIRMED

Evidence:
- Planner module exports `createPlan(task)` and `taskType`, no `createPlanForTask` symbol.

Why it matters:
- Checklist asks for `createPlanForTask(...)`; implementation uses a differently named function.

Fix:
- UNKNOWN

---

### Issue: Planner module exists and persists plan + steps
Severity: P3
Status: CONFIRMED

Evidence:
- `dispatcher/planner.js` exists and defines `createPlan(task)`.
- Existing-plan check: `select * from hermes_plans where plan_key=$1 limit 1`.
- Plan insert: `insert into hermes_plans (task_id,plan_key,status) ...`.
- Step insert: `insert into hermes_plan_steps (plan_id,step_id,type,status,result,updated_at) ...`.

Why it matters:
- Confirms real plan persistence layer exists.

Fix:
- None for existence check.

---

### Issue: Executor module path/name mismatch vs checklist
Severity: P2
Status: CONFIRMED

Evidence:
- Runtime worker imports JS executor as `./dispatcher/planExecutor`.
- `dispatcher/executor.js` is not present in file list; TypeScript `dispatcher/executor.ts` exists but is different flow.

Why it matters:
- Checklist expected `dispatcher/executor.js` with `executePlan(...)`.

Fix:
- UNKNOWN

---

### Issue: `executePlan(...)` exists and processes DB steps sequentially
Severity: P3
Status: CONFIRMED

Evidence:
- `dispatcher/planExecutor.js` defines `async function executePlan(plan, task, session, ctx)`.
- Loads steps ordered by `step_id asc` from `hermes_plan_steps`.
- Uses `runStep` to lock pending step -> `running`, then `completed`/`failed` updates.

Why it matters:
- Confirms real executor with per-step status transitions.

Fix:
- None for existence check.

---

### Issue: Step taxonomy does not match required `inspect_context`, `classify_risk`, `respond/require_approval`
Severity: P2
Status: CONFIRMED

Evidence:
- Default step types are `analyze`, `locate`, `patch`, `test`, `pr`.
- Executor handles `analyze`, `locate`, `patch`, `test`, `commit`, `pr`.

Why it matters:
- Requested minimal planner structure differs from implemented step set.

Fix:
- UNKNOWN

---

### Issue: Schema tables exist, but required columns are missing
Severity: P1
Status: CONFIRMED

Evidence:
- `hermes_plans` columns: `id`, `task_id`, `plan_key`, `status`, `created_at`.
- `hermes_plan_steps` columns: `id`, `plan_id`, `step_id`, `type`, `status`, `result`, `updated_at`.
- Missing requested columns:
  - `hermes_plans.summary`
  - `hermes_plans.risk_level`
  - `hermes_plan_steps.step_order` (uses `step_id`)
  - `hermes_plan_steps.step_type` (uses `type`)
  - `hermes_plan_steps.requires_approval`

Why it matters:
- Checklist schema contract is not fully satisfied.

Fix:
- UNKNOWN

---

### Issue: Approval gating inside `executePlan` not found
Severity: P1
Status: CONFIRMED

Evidence:
- `executePlan` has no `requires_approval` check and no `waiting_approval` plan status branch.
- It supports `pending/running/completed/failed` plus timeout failure path.

Why it matters:
- Checklist requires executor-side approval stop behavior when a step requires approval.

Fix:
- UNKNOWN

---

### Issue: Unknown step handling is safe-skip
Severity: P3
Status: CONFIRMED

Evidence:
- For unmatched step type, executor returns `{ skipped: true }` from step function and completes step.

Why it matters:
- Unknown types do not crash execution loop.

Fix:
- None.

---

### Issue: Worker integration path exists (planner then executor via role controller)
Severity: P3
Status: CONFIRMED

Evidence:
- `worker.js` calls `runWithRoles(task, session, ctx)` after task claim.
- `dispatcher/roleController.js` calls `createPlan(task)` then `executePlan(resolvedPlan, task, session, ctx)` when plan exists.

Why it matters:
- Confirms planner/executor are wired in live task path.

Fix:
- None for wiring check.

---

### Issue: Safety check failed for planner/executor modules (external commands/APIs present)
Severity: P1
Status: CONFIRMED

Evidence:
- `dispatcher/planExecutor.js` calls `runGate(ctx.projectRoot)`, `commitChanges(...)`, and `createPullRequest(...)`.
- `dispatcher/executor.ts` executes shell commands via `execFile("bash", ["-lc", command])`.
- `dispatcher/planner.ts` calls OpenAI API via `ai.chat.completions.create(...)`.

Why it matters:
- Checklist asked for no shell/git/fs writes/external API in planner/executor; current implementation includes these behaviors (in the broader dispatcher planner/executor fileset).

Fix:
- UNKNOWN

---

### Issue: Required PLAN_* logging keys not found
Severity: P2
Status: CONFIRMED

Evidence:
- No occurrences found for `PLAN_CREATED`, `PLAN_EXISTS`, `PLAN_EXECUTE_START`, `PLAN_STEP_DONE`, `PLAN_WAITING_APPROVAL`, `PLAN_FAILED`.

Why it matters:
- Checklist-specific observability markers are absent.

Fix:
- UNKNOWN

---

### Issue: Task result handling exists post-plan execution
Severity: P3
Status: CONFIRMED

Evidence:
- `runWithRoles` returns final status based on review and includes executor output.
- `worker.js` updates session, then releases/fails task via `releaseTask(...)` / `failTask(...)` after `runWithRoles`.

Why it matters:
- Confirms execution result affects final task lifecycle.

Fix:
- None for this check.

---

## 3. Planner Design

- Plan creation function in JS runtime path: `createPlan(task)`.
- Idempotency/reuse by `plan_key` lookup before insert.
- New plans persisted to `hermes_plans`; steps persisted to `hermes_plan_steps` with incremental `step_id`.
- Step structure source:
  - Reused from `decision_log` memory when available.
  - Else defaults to `['analyze','locate','patch','test','pr']`.

---

## 4. Executor Design

- `executePlan(plan, task, session, ctx)` marks plan `running`, iterates DB steps ordered by `step_id`.
- Per-step transition: pending -> running -> completed/failed via `runStep`.
- Timeout guard fails plan after 10 minutes.
- Patch step retry path exists using `handleTaskFailure` and one retry.
- Final status set to `completed` on success; plan set `failed` on timeout/fatal step error.

---

## 5. Worker Integration

- Worker task loop calls `runWithRoles(...)`.
- `runWithRoles(...)` calls planner then executor when plan exists.
- Fallback path executes `ctx.runAction(task)` if planner returns null.

---

## 6. Safety Review

- `planExecutor.js` includes PR/commit/gate integrations (not pure no-side-effect planner/executor).
- `executor.ts` includes shell command execution.
- `planner.ts` includes external OpenAI API request.

Conclusion for checklist safety requirement: **NOT MET (CONFIRMED)**.

---

## 7. Schema Validation

- `hermes_plans` and `hermes_plan_steps` tables exist in both `schema.sql` and `patch_schema.sql`.
- Required additional columns from checklist (`summary`, `risk_level`, `step_order`, `step_type`, `requires_approval`) are not present.

---

## 8. Risks Remaining

- Approval blocking at executor step level is not evidenced.
- Required checklist schema shape does not match implemented DB schema.
- Required PLAN_* logging markers are absent.
- Multiple planner/executor implementations exist (`.js` and `.ts`) with different behaviors, increasing ambiguity risk.

---

## 9. Acceptance Check

System is correct if:

- plan created per task → **PARTIAL** (created when `taskType(...)` matches; otherwise planner returns null).
- steps executed sequentially → **MET** (`order by step_id asc` and per-step state transitions).
- approval blocks execution → **NOT MET** (no `requires_approval`/`waiting_approval` in `executePlan`).
- no unsafe actions → **NOT MET** (shell/API/git integration present in audited planner/executor files).
- no regression → **UNKNOWN** for Telegram command instant behavior in this audit scope; worker integration path itself is present.
