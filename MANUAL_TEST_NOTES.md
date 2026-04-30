# Manual Test Notes

## Scenario 1: Invalid APP_ENV should fail fast
- Env: `APP_ENV=qa`
- Expected: process throws on startup with `[env] Invalid APP_ENV` and exits.

## Scenario 2: Development default Telegram OFF
- Env: `APP_ENV=development`, `TELEGRAM_ENABLED` unset
- Expected log: `[telegram skipped] env=development reason=env_disabled`

## Scenario 3: Staging explicit Telegram ON
- Env: `APP_ENV=staging`, `TELEGRAM_ENABLED=true`
- Expected: Telegram messages are sent (no skip log).

## Scenario 4: Production override Telegram OFF
- Env: `APP_ENV=production`, `DISABLE_TELEGRAM=true`
- Expected log: `[telegram skipped] env=production reason=DISABLE_TELEGRAM`

## Scenario 5: Production DB guard reply target required
- Call: `validateReplyTarget({}, "production")`
- Expected: throw error JSON with code `INVALID_REPLY_TARGET`.


## Scenario 6: Production write/destructive command blocked before execution
- Env: `APP_ENV=production`
- Call: shell execution path with `git commit -m "x"` or `git push`
- Expected: command does **not** run; error includes `requiresApproval=true` and `[command]` reason.
