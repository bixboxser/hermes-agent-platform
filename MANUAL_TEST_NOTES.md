# Manual Test Notes (Queue + Approval + Idempotency + PR Agent)

## 1) Two-worker claim race
1. Insert 1 `pending` task.
2. Run two worker processes with different `HERMES_WORKER_ID`.
3. Verify only one worker updates task to `running` with `locked_by` set.
4. Verify second worker does not process same task.

## 2) Stale task recovery
1. Set a task to `running` with `heartbeat_at = now() - interval '11 minutes'`.
2. Call `recoverStaleTasks()`.
3. If `retry_count < max_retries`, verify task returns to `pending` and `retry_count` increments.
4. If `retry_count >= max_retries`, verify task becomes `failed`.

## 3) retry_count behavior
1. Force transient failure path via `failTask(taskId, workerId, err, true)`.
2. Verify only retryable failures increment `retry_count`.
3. Verify permanent failure path marks `failed` without extra retries.

## 4) Approval payload hash mismatch
1. Create approval for payload A.
2. Try consume with payload B.
3. Verify consume returns false and action not executed.

## 5) Approval consume once
1. Approve token and consume once.
2. Consume again with same token/payload.
3. Verify second consume is no-op (false).

## 6) Idempotent PR creation
1. Run `createPullRequest` twice with same idempotency key inputs.
2. Verify second call returns stored result, no second PR.

## 7) Push requires approval
1. Attempt `git push` through worker command path in prod.
2. Verify blocked/approval-required behavior before execution.

## 8) Gate failed PR body
1. Force gate failure.
2. Create PR.
3. Verify PR body includes `PATCH DONE BUT GATE FAILED`.

## 9) waiting_approval not auto-picked
1. Set task status `waiting_approval`.
2. Run claim loop.
3. Verify `claimNextTask` does not pick the task.
