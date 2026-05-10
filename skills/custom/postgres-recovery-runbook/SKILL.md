# postgres-recovery-runbook

## name
postgres-recovery-runbook

## description
Postgres recovery and debug runbook for Hermes and app deploy incidents, with backup-first safety.

## When to Use
Use for Postgres connection failures, migration failures, missing tables, corrupt data symptoms, failed backups/restores, or database container incidents.

## Required tools/env
- Tools: `psql`; `pg_dump`/`pg_restore` for backup and restore work.
- Env/context: `DATABASE_URL` or safe connection method, database host, target environment.

## Procedure
1. Confirm environment and whether the database is production.
2. Check connectivity using non-destructive reads only.
3. Take or locate a recent backup before schema/data mutation.
4. Inspect migrations, locks, disk usage, and container logs.
5. Apply the smallest reversible fix; prefer migrations over ad-hoc manual edits.
6. Re-run app/worker health checks and the specific failed workflow.
7. Document cause, backup location, fix, and follow-up tests.

## Pitfalls
- Do not paste database URLs or credentials into chat.
- Do not run destructive SQL without backup and explicit approval.
- Avoid `drop`, `truncate`, `delete`, or volume removal during first-pass triage.
- Do not weaken worker execution-time validation to bypass DB issues.

## Verification
- `select 1` succeeds.
- Required tables/migrations exist.
- App and worker can connect.
- Failed workflow is reproduced as fixed.
- Backup/restore path is documented when recovery occurred.

## Safety/approval notes
Production writes, schema migrations, restores, and destructive SQL require explicit approval. Missing database env/tools must produce a safe failure.
