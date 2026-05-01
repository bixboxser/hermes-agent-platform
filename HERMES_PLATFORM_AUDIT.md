# HERMES AI AGENT PLATFORM AUDIT

## 1. Executive Summary
- Hermes is **partially functional** as a single-node automation bot, but currently shows major coupling, schema drift, and operational fragility for a production-grade general-purpose platform.
- Biggest confirmed risks are: env model inconsistency (`APP_ENV` vs `HERMES_ENV`), schema/model mismatch in approvals and sessions, hardcoded repo/domain behavior, and weak runtime safety boundaries around command/file execution.
- What is working: queue locking (`FOR UPDATE SKIP LOCKED`), heartbeat/recovery patterns, basic health endpoint, and explicit approval insertion paths.
- Biggest blockers to becoming a super-agent platform: generalized workspace abstraction is missing, migrations are fragmented and contradictory, Telegram logic is tightly mixed with domain-specific behavior, and dispatcher has JS/TS split with no build/test pipeline proving correctness.

---

## 2. Critical Issues

### Issue: Environment contract split (`APP_ENV` docs vs `HERMES_ENV` code)
Severity: P1
Status: CONFIRMED

Evidence:
- `README.md` defines `APP_ENV` with `development/staging/production` semantics.
- `config/env.js` validates only `HERMES_ENV` with `dev|prod` and derives `APP_ENV` internally.
- `.env.example` exposes only `APP_ENV=development`, not `HERMES_ENV`.

Why it matters:
- Operator configuration can be silently wrong or crash startup depending on which variable is set.

Fix:
- Adopt one authoritative env variable. Prefer validating `APP_ENV`, map legacy `HERMES_ENV` with deprecation warning.

Verification:
- `node -e "process.env.APP_ENV='staging'; require('./config/env')"`
- `node -e "process.env.HERMES_ENV='dev'; require('./config/env')"`

---

### Issue: Approval schema drift breaks write paths
Severity: P1
Status: CONFIRMED

Evidence:
- `schema.sql` defines `hermes_approvals(action_type, risk_level, approval_token, expires_at)`.
- `dev_schema.sql` defines different structure: `hermes_approvals(action_name, command, requested_at, approved_at, rejected_at)`.
- `worker.js` inserts into `hermes_approvals(task_id, action_name, command, status)`.

Why it matters:
- Depending on which schema was applied, approval inserts will fail at runtime.

Fix:
- Consolidate to one migration chain and one canonical approval table contract used by all code paths.

Verification:
- `psql "$DATABASE_URL" -c "\d+ hermes_approvals"`
- Run approval-creation flow and confirm insert succeeds.

---

### Issue: Session table shape mismatch between SQL and runtime expectations
Severity: P1
Status: CONFIRMED

Evidence:
- `schema.sql` first creates `hermes_sessions(task_id,... )`.
- `gbrain.js` also creates `hermes_sessions(telegram_user_id primary key, state, updated_at)`.
- `index.js` daily report queries `hermes_sessions where state is not null`.
- `dispatcher/session.js` reads/writes sessions via `task_id`.

Why it matters:
- This creates ambiguous ownership of `hermes_sessions`; queries can fail or produce invalid behavior.

Fix:
- Split into separate tables (`hermes_task_sessions`, `telegram_user_sessions`) or standardize one schema and update all call sites.

Verification:
- `psql "$DATABASE_URL" -c "\d+ hermes_sessions"`
- `node -e "require('./dispatcher/session').getOrCreateSession(1)"`

---

### Issue: General platform identity is hardcoded to one operator/context
Severity: P2
Status: CONFIRMED

Evidence:
- `gbrain.js` prompt contains hardcoded operator name and VPS paths (`/root/hermes`, specific service commands).
- `index.js` issue body injects fixed guidance and references local file set for one repo.
- `docker-compose.yml` hardcodes owner chat id and developer identity envs.

Why it matters:
- Prevents Hermes from being a reusable agent core across workspaces and operators.

Fix:
- Move identity/prompt/profile into workspace config and template variables.

Verification:
- Search for hardcoded operator/path strings and assert none remain in core runtime.

---

### Issue: Safety policy inconsistent and partially bypassable
Severity: P2
Status: CONFIRMED

Evidence:
- `worker.js` has `isSafeCommand` denylist/allowlist logic.
- `dispatcher/safety.js` has separate classifier with different safe/risky/dangerous patterns.
- `worker.js` `execAsync` uses dispatcher decision, while `runSafeCommand` uses its own gate.

Why it matters:
- Different command paths can classify the same command differently, creating enforcement gaps.

Fix:
- Centralize command policy in one module and enforce in all execution paths.

Verification:
- Unit-test same command across all execution entrypoints and compare policy outcomes.

---

### Issue: No declared automated tests for critical queue/approval/schema logic
Severity: P2
Status: CONFIRMED

Evidence:
- `package.json` has only `app` and `worker` scripts; no test/lint/build scripts.

Why it matters:
- Regressions in task lifecycle, schema contracts, and routing are likely.

Fix:
- Add minimal CI checks (schema smoke test, queue integration test, approval flow test).

Verification:
- `npm test` and CI required checks.

---

## 3. Architecture Problems
- Core runtime is **not repo-agnostic**: prompts and flows embed Hermes VPS-specific operational assumptions (`/root/hermes`, docker log commands, domain-specific payment troubleshooting). (CONFIRMED)
- Dispatcher surface is fragmented (JS + TS files side-by-side without proven compile/runtime wiring). (LIKELY)
- Telegram transport, orchestration, and product/domain response logic are mixed in monolithic files (`index.js`, `gbrain.js`, `worker.js`) rather than cleanly layered agent core vs channel adapters. (CONFIRMED)

## 4. Schema / Migration Problems
- Multiple independent schema files define conflicting contracts (`schema.sql`, `patch_schema.sql`, `dev_schema.sql`). (CONFIRMED)
- Runtime code mutates schema on boot (`ensureGBrainSchema` does `ALTER TABLE`) which hides migration hygiene issues. (CONFIRMED)
- Approval/session/memory table semantics are inconsistent between schema and code paths. (CONFIRMED)
- UNKNOWN: presence of migration version table / migration runner.

## 5. Telegram Flow Problems
- Telegram routing and task intake logic appear intertwined with periodic reporting and issue automation in `index.js`, increasing /start command fragility. (LIKELY)
- `effectiveTelegramEnabled` in `config/env.js` ignores `TELEGRAM_ENABLED` semantics described in README. (CONFIRMED)
- UNKNOWN: exact `/start` route behavior and early-return logic (not fully visible in sampled file section).

## 6. Worker / Queue Problems
- Positive: queue claim uses transactional lock with `FOR UPDATE SKIP LOCKED`. (CONFIRMED)
- Potential duplication: stale-task recovery exists in both `dispatcher/queue.js` and `dispatcher/monitor.js`. (CONFIRMED)
- Timeout constants are hardcoded in multiple places (10m heartbeat window), risking drift. (LIKELY)
- UNKNOWN: end-to-end idempotency enforcement at task creation ingress.

## 7. Safety / Approval Problems
- Approval schema mismatch risks total failure of approval persistence depending on DB state. (CONFIRMED)
- Two command safety models produce inconsistent policy decisions. (CONFIRMED)
- File protection policy in worker is pattern-based and may be bypassed via indirect write operations not passing `assertCanEditFile`. (LIKELY)
- UNKNOWN: cryptographic verification of approval payload before execution.

## 8. Memory / GBrain Problems
- GBrain stores both structured and unstructured memory but with mixed tables (`gbrain_memories` and `hermes_memories`) and overlapping meaning. (CONFIRMED)
- Learning filter/category logic is hardcoded to specific business words and Vietnamese phrases, not general-purpose memory extraction. (CONFIRMED)
- UNKNOWN: retrieval quality metrics, deduplication, and memory decay policy.

---

## 9. Roadmap to Super Agent

Phase 1 — Stabilize Core
- Unify env contract and fail-fast validation.
- Freeze one canonical schema migration chain; remove runtime schema patching.
- Unify command/approval enforcement in one policy module.

Phase 2 — Production Agent
- Separate channel adapters (Telegram) from orchestration core.
- Add deterministic task state machine tests and schema contract tests.
- Add worker/queue observability dashboards (heartbeat age, stuck tasks, approval latency).

Phase 3 — General Platform
- Introduce workspace abstraction (`workspace_id`, `workspace_root`, provider profiles).
- Externalize prompts/operator identity into per-workspace config.
- Add capability registry/plugin interface for tools and policies.

Phase 4 — Autonomous Agent
- Persistent planning graph with resumable long-running workflows.
- Safer autonomy boundaries: scoped credentials, action budgets, policy proofs.
- Memory scoring loop tied to measurable execution outcomes.

---

## 10. Immediate Fix Plan (PRIORITIZED)
1. Canonicalize schema + migrations (resolve approvals/sessions drift first).
2. Unify env loading (`APP_ENV`/`HERMES_ENV`) and Telegram enablement logic.
3. Consolidate command safety + approval paths into one executable policy surface.

---

## 11. Suggested File Changes
- `config/env.js`: adopt single env model + backward compatibility shim.
- `.env.example`: include required authoritative vars (`DATABASE_URL`, env mode, telegram flags).
- `schema.sql`, `patch_schema.sql`, `dev_schema.sql`: replace with ordered migration set and remove conflicting definitions.
- `gbrain.js`: remove runtime schema patching and hardcoded operator/workspace instructions.
- `worker.js`: remove duplicate command safety logic; consume centralized policy only.
- `index.js`: isolate Telegram command router from reporting/issue-automation branches.
- `dispatcher/session.js` + schema: split telegram state from task session model.

---

## 12. Acceptance Criteria
System is stable when:
- /health ok
- /start instant
- Telegram commands not blocking
- tasks processed correctly
- approval flow works
- memory works
- schema bootstraps cleanly
- no manual DB patching
- no Somewhere coupling in core

---

FINAL NOTE:
Hermes should evolve into a general agent platform with:
- agent core (reasoning + execution)
- tool/capability system
- workspace abstraction
- memory + learning loop
- safe automation engine

and not remain a single-context bot bound to one repo/operator.
