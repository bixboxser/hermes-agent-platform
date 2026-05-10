# telegram-operator-flow

## name
telegram-operator-flow

## description
Routing flow for Telegram operator messages so Hermes loads only matching skills and avoids heavy execution for small talk.

## When to Use
Use when changing Telegram commands, task routing, approval UX, operator messages, or skill matching behavior.

## Required tools/env
- Env: `TELEGRAM_TOKEN`, `ALLOWED_USER_IDS` for live Telegram operation.
- Tools: database access for persisted sessions/tasks when debugging live flow.

## Procedure
1. Classify message intent: command, small talk, unclear, or task-like.
2. For task-like messages, match only the top 1-3 skills by metadata.
3. Check required tools/env before loading full skill content or executing.
4. Plan the action and request approval for risky/prod operations.
5. Execute only after requirements and approvals pass.
6. Verify and send a concise operator summary.
7. Save new lessons into memory or custom skills after redaction.

## Pitfalls
- Do not load all skills into every Telegram task.
- Do not trigger heavy task flow for greetings or small talk.
- Do not change FSM transitions casually.
- Do not pretend Telegram or external tools are connected when env is missing.

## Verification
- `/skills list` shows curated and custom skills only.
- `/skills match <text>` returns the expected top skills.
- Small talk replies with lightweight help and creates no task.
- Missing env/tool messages are clear and non-destructive.

## Safety/approval notes
Any command that touches prod, deploys, restarts services, writes DB rows, or calls external APIs must require explicit approval.
