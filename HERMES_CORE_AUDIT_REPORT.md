# HERMES CORE AUDIT REPORT

## 1. Current Capabilities

- **Server entrypoint**: `index.js` acts as the application server (requested `app.js` does not exist; server entry is `index.js`).
- **Ingress model**: Telegram long-polling + session-state handlers + allowlist checks (`ALLOWED_USER_IDS`) in app runtime.
- **Persistence model**: PostgreSQL with task/event/action/approval/session/plan/idempotency/worker-status tables (`schema.sql`, `patch_schema.sql`).
- **Worker execution core**: task claim/heartbeat/release/failure handling in `dispatcher/queue.js`.
- **Safety controls**: command risk classification in `dispatcher/safety.js`, plus local path/command restrictions in `worker.js`.
- **Memory subsystem**: dual stores (`gbrain_memories`, `hermes_memories`) with keyword recall and lightweight recency usage.
- **Observability baseline**: `/health` endpoint + worker status table + alert checks for stuck tasks/failure bursts/approval stalls.

## 2. Real Execution Flow

1. **User sends Telegram message** to bot.
2. **`index.js` polls updates** and maps sender/chat/session context.
3. **Session-state short path** (`AWAITING_*`) can execute direct logic immediately (not always queued).
4. **Task path** inserts row in `hermes_tasks` (typically `pending`).
5. **Worker claims task** using `SELECT ... FOR UPDATE SKIP LOCKED` inside `claimNextTask` and sets `status='running'`, lease metadata, heartbeat window.
6. **Worker executes action flow** (intent/safety/approval/memory dependent).
7. **Risky action path** attempts approval creation and Telegram approval interaction.
8. **Completion path**: `running -> completed`.
9. **Failure path**: `running -> pending` (retry) or `running -> failed` (exhausted retries).
10. **Timeline logging** occurs via `hermes_task_events` + `hermes_action_logs`.

### FSM enforcement audit vs expected lifecycle
Expected lifecycle: `pending → planned → pending_approval → approved → running → completed / failed`.

Current enforcement reality:
- **Illegal transitions possible**: runtime queue bypasses `planned` and `approved`; direct `pending -> running` exists.
- **Skipping states possible**: approval states are not mandatory for all non-safe actions.
- **Re-run after completed possible**: duplicate ingress can create new task rows for same semantic request.
- **Multiple running states possible**: one task row is lock-protected, but same intent can exist as multiple rows all `running` on different workers.
- **Stuck states possible**: `running` and `waiting_approval` can stall until monitor/recovery logic intervenes.

## 3. Failure Simulation Results

### 1) Duplicate Telegram message
- **Current behavior**: likely creates duplicate tasks if repeated message/update is not deduped at ingress.
- **Failure point**: missing hard uniqueness enforcement on task-level idempotency key.
- **Risk level**: **P1** (can escalate to P0 if duplicated side effects are destructive).

### 2) Worker crash mid-task
- **Current behavior**: task stays `running` until heartbeat timeout; recovery attempts set back to `pending` or `failed` by retry count.
- **Failure point**: recovery latency + repeated execution risk after restart.
- **Risk level**: **P1**.

### 3) DB temporarily unavailable
- **Current behavior**: task ingestion/execution updates fail; `/health` reports DB down path.
- **Failure point**: no durable fallback queue, no explicit circuit-breaker/backpressure protocol.
- **Risk level**: **P1**.

### 4) Task stuck in running
- **Current behavior**: stale-task logic exists in more than one place (queue + monitor), both may mutate status/retry counters.
- **Failure point**: race/inconsistent state mutations.
- **Risk level**: **P1**.

### 5) Malicious command input
- **Current behavior**: blocked by pattern checks in many cases, but string-pattern safety is bypass-prone and duplicated.
- **Failure point**: non-canonical command policy implementation.
- **Risk level**: **P0** (uncontrolled execution potential).

## 4. Critical Risks (P0 / P1 / P2)

### P0
1. **Unenforced canonical FSM**: runtime statuses diverge from expected enforcement lifecycle.
2. **Approval contract mismatch risk**: runtime approval-write path and schema-required fields can drift/fail.
3. **Malicious-command bypass surface**: string-pattern allow/block logic is not a deterministic parser-level guard.
4. **Bot-token compromise blast radius**: attacker with token can drive privileged bot interactions.
5. **Unsafe action containment is incomplete**: destructive domains (db/docker/env) do not appear universally blocked by one authoritative gate.

### P1
1. **Ingress idempotency gap**: duplicate updates can create duplicate task rows.
2. **Crash recovery repeats execution** without idempotent side-effect guard.
3. **No exponential backoff + dead-letter channel** for terminal operational control.
4. **Stale-recovery ownership split** between modules can cause inconsistent retry accounting.
5. **Memory scope/conflict governance weak** for production autonomous behavior.
6. **Deployment race** (`depends_on` without readiness gate) can start app/worker before DB is ready.

### P2
1. **Observability not implementation-complete** for throughput/error-rate SLOs.
2. **Structured log normalization incomplete** (cross-module correlation consistency).
3. **Environment contract clarity** can be strengthened (`APP_ENV`/`HERMES_ENV` interplay + container parity checks).

## 5. Broken Architecture Pieces

1. **FSM fragmentation**: expected lifecycle is not the same as runtime queue lifecycle.
2. **Approval enforcement fragmentation**: no single mandatory gate for medium/risky/dangerous classes.
3. **Safety-policy duplication**: `worker.js` and `dispatcher/safety.js` each enforce different command safety surfaces.
4. **Memory authority split**: no canonical source-of-truth or conflict resolver across memory stores.
5. **Recovery-control split**: stale-running recovery handled in multiple components.
6. **Ingress coupling**: conversational UX path and production orchestration are tightly coupled in server entry.

## 6. Files That Must Change

- **`worker.js`**
  - **Problem**: mixed safety logic, approval flow fragility, structural complexity risking inconsistent enforcement.
  - **Fix direction**: reduce to deterministic orchestrator; all command execution through one policy gate; all transitions through canonical FSM guard.

- **`dispatcher/fsm.ts` + `dispatcher/queue.js`**
  - **Problem**: state vocabulary and transition behavior differ from required lifecycle.
  - **Fix direction**: single shared status enum + transition map used by all runtime modules.

- **`schema.sql` + `patch_schema.sql`**
  - **Problem**: runtime invariants are not strongly enforced at DB boundary.
  - **Fix direction**: CHECK/ENUM transition constraints, unique ingress idempotency constraint, dead-letter representation.

- **`index.js` (server entry; replaces missing `app.js`)**
  - **Problem**: enqueue path not guaranteed idempotent; heavy path may be reachable from permissive intent fallback.
  - **Fix direction**: centralized enqueue API with deterministic dedupe key and explicit `/start` hard short-circuit.

- **`dispatcher/safety.js`**
  - **Problem**: pattern-only command classification and environment coupling are insufficient for high-risk operations.
  - **Fix direction**: deterministic command grammar + explicit action class policy matrix with mandatory approvals.

- **`gbrain.js`**
  - **Problem**: memory retrieval/scoping/conflict protections are not strong enough for autonomous execution safety.
  - **Fix direction**: scope keys, freshness TTL, conflict detector, and risk-aware memory gating before execution.

- **`docker-compose.yml` + `.env.example` + `config/env.js`**
  - **Problem**: env parity/readiness/secrets discipline not production-hard.
  - **Fix direction**: readiness checks, strict APP_ENV contract (`development|staging|production`), DATABASE_URL verification, remove hardcoded sensitive values.

## 7. Production Build Roadmap

1. **Lock runtime contract**: publish canonical FSM + action-risk policy matrix + idempotency contract.
2. **Enforce at DB boundary**: add constraints/triggers for FSM legality and dedupe uniqueness.
3. **Enforce at app boundary**: centralize task creation with deterministic idempotency key and `/start` short-circuit.
4. **Enforce at worker boundary**: one command execution gateway with required approval checks and lease ownership verification.
5. **Introduce dead-letter + replay controls**: terminal failure queue with operator workflow.
6. **Add exponential backoff/jitter scheduler** for retries.
7. **Unify stale recovery ownership** into one subsystem.
8. **Harden memory pipeline** with scope/freshness/conflict enforcement.
9. **Upgrade observability** with structured correlation logs and fail-rate/throughput metrics.
10. **Harden deployment** with DB readiness gates and env consistency checks across app/worker.

## 8. Enforceable Anti-Failure Rules

RULE:
`[Task status update requested] → [MANDATORY: reject unless transition exists in canonical FSM map shared by app+worker+DB trigger].`

RULE:
`[New task creation request arrives] → [MANDATORY: compute deterministic idempotency_key from source/update/message and upsert atomically].`

RULE:
`[Idempotency key already exists] → [MANDATORY: return existing task_id/result and skip new execution].`

RULE:
`[Worker claims task] → [MANDATORY: claim via row lock + set lease_owner + lease_expires_at in same transaction].`

RULE:
`[Worker mutates running task] → [MANDATORY: require matching lease_owner (and lease token if present) or fail update].`

RULE:
`[Action classified as medium] → [MANDATORY: require reversible plan + test evidence before state can move to running].`

RULE:
`[Action classified as risky] → [MANDATORY: require approval row (task_id, payload_hash, approver_id, expires_at) before execution].`

RULE:
`[Action classified as dangerous] → [MANDATORY: require dual approval + immutable audit event + explicit deny-by-default fallback].`

RULE:
`[Approval missing/expired/payload mismatch] → [MANDATORY: block execution and set task to pending_approval (not running)].`

RULE:
`[Intent is unknown or low-confidence] → [MANDATORY: route to safe clarification path; never auto-route to heavy execution].`

RULE:
`[Incoming command not matching formal allowlist grammar] → [MANDATORY: reject command and log security_event].`

RULE:
`[Target path matches protected policy (.env, docker, migrations, VCS, secrets)] → [MANDATORY: deny write/delete operations].`

RULE:
`[Memory read before execution] → [MANDATORY: filter by same user/project scope and freshness TTL].`

RULE:
`[Memory conflict detected for same scope/key] → [MANDATORY: downgrade trust and require human confirmation for risky/dangerous actions].`

RULE:
`[Retryable failure occurs] → [MANDATORY: schedule retry with exponential backoff + jitter + max_retries cap].`

RULE:
`[max_retries exceeded] → [MANDATORY: move task to dead-letter state/table with root_cause and replay_hint].`

RULE:
`[/health requested] → [MANDATORY: include app_status, db_status, worker_heartbeat_freshness, queue_depth, fail_rate_window].`

RULE:
`[Unauthorized Telegram sender detected] → [MANDATORY: deny execution, emit security audit event, and do not create task row].`

RULE:
`[APP_ENV invalid or mismatched across containers] → [MANDATORY: fail startup before accepting ingress or claiming tasks].`
