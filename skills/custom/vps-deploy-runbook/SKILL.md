# vps-deploy-runbook

## name
vps-deploy-runbook

## description
Safe deploy and debug runbook for the Hermes custom Node.js agent on a VPS using Git, Docker Compose, worker health checks, and Postgres.

## When to Use
Use when a task mentions VPS deploy, production server, Docker Compose deploy/debug, Hermes app/worker health, or Postgres-backed deployment issues.

## Required tools/env
- Tools: `ssh` when remote, `git`, `docker`, Docker Compose plugin or `docker-compose`.
- Env/context: VPS host/user, repo path, app environment name, and read-only access to logs.
- Do not request or store API keys in chat or memory.

## Procedure
1. Classify the target as local, staging, or production before running commands.
2. Inspect state first: `git status`, `docker ps`, app/worker logs, and `/health` if available.
3. Confirm risky actions with the operator before restart, deploy, database migration, or production writes.
4. Pull/build only the intended branch and record commit SHA before changing containers.
5. Prefer `docker compose up -d --build` or service-specific restarts over broad destructive operations.
6. Verify app, worker, database connectivity, queue behavior, and Telegram notifications after deploy.
7. Save new lessons into memory or this skill only after secrets are redacted.

## Pitfalls
- Never run `docker-compose down -v` or any volume removal command.
- Do not assume a tool is available; check it first.
- Avoid changing FSM transitions, approval snapshot hashing, or worker execution-time validation during deploy triage.
- Do not paste tokens, `.env` values, or database URLs into chat.

## Verification
- `git status --short` is clean or expected.
- `docker ps` shows expected app/worker/db containers healthy or running.
- App `/health` returns OK/degraded with clear cause, not down.
- Worker logs show no execution-time validation regression.
- Telegram receives the final deploy summary.

## Safety/approval notes
Production restarts, migrations, branch changes, and commands that can mutate data require explicit approval. Stop with a clear safe-failure message when env/tool access is missing.
