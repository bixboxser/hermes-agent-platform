# docker-compose-v1-safety

## name
docker-compose-v1-safety

## description
Safety checklist for Docker Compose v1/v2 operations, especially around Hermes and Postgres containers.

## When to Use
Use for Docker Compose deploys, container logs, restart loops, Postgres container issues, or any command proposal involving compose.

## Required tools/env
- Tools: `docker`; optionally `docker compose` plugin or `docker-compose` binary.
- Env/context: compose file path, project name, service names, target environment.

## Procedure
1. Detect available compose command: prefer `docker compose`, fallback to `docker-compose`.
2. Inspect before changing: `docker ps`, `docker compose ps`, and targeted `docker compose logs --tail`.
3. For config validation, run `docker compose config` before restart/build.
4. Use service-scoped commands when possible: `up -d --build <service>`, `restart <service>`, `logs <service>`.
5. If Postgres is involved, confirm backups before migration/recovery actions.
6. After changes, verify app, worker, db, and queue health.

## Pitfalls
- Never run `docker-compose down -v` or `docker compose down -v`.
- Avoid broad `down` in production unless approved and non-destructive.
- Do not remove named volumes, images, or databases during routine troubleshooting.
- Do not claim compose is available without checking.

## Verification
- Compose config validates.
- Target services are running and not flapping.
- Logs do not contain new fatal errors.
- Health endpoints and worker checks pass.

## Safety/approval notes
Ask for explicit approval before restarts in production, image rebuilds, migrations, or any command that can interrupt service. Fail safely if Docker/Compose is missing.
