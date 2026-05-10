# approval-snapshot-safety

## name
approval-snapshot-safety

## description
Safety guard for preserving Hermes approval snapshot hashing and approval-bound execution.

## When to Use
Use when editing approval, task creation, worker pickup, execution gates, or Telegram approve/reject flows.

## Required tools/env
- Tools: Node.js test runner or targeted scripts.
- Context: approval snapshot payload schema, task status lifecycle, worker validation code.

## Procedure
1. Inspect current snapshot canonicalization and hash comparison before editing.
2. Keep task identity, normalized input, intent, risk, actions, memory IDs, and app env in the canonical payload.
3. Never approve if recomputed hash differs from stored hash.
4. Preserve approval expiry and operator identity checks.
5. Add regression tests before changing behavior.
6. Verify worker still validates approved task execution-time state.

## Pitfalls
- Do not weaken hash canonicalization to make approvals pass.
- Do not bypass pending approval for risky tasks.
- Do not change FSM transitions without a dedicated migration/test plan.
- Do not log secrets inside approval snapshots.

## Verification
- Snapshot mismatch is rejected.
- Expired approval is rejected.
- Approved task transitions remain explicit.
- Existing worker health and approval checks pass.

## Safety/approval notes
Treat approval logic as high-risk. Require code review for any change that affects hashing, status transitions, or execution gates.
