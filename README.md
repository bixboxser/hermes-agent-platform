# Hermes Agent Platform

## Environment Configuration

Hermes v5 now supports a thin environment-separation config layer via `config/env.js`.

- `APP_ENV` supports: `development`, `staging`, `production`.
- Startup fails fast when `APP_ENV` is invalid.
- Telegram behavior is controlled by `effectiveTelegramEnabled`:
  - `development`: disabled unless `TELEGRAM_ENABLED=true`
  - `staging`: disabled unless `TELEGRAM_ENABLED=true`
  - `production`: enabled unless `TELEGRAM_ENABLED=false`
  - `DISABLE_TELEGRAM=true` always forces Telegram off.
- Command guard mode is derived from env:
  - `development` => `safe-block`
  - `staging` => `approval-required`
  - `production` => `strict-approval`

### Logging prefixes

The environment guard layer uses consistent prefixes:

- `[env]`
- `[telegram]`
- `[command]`
- `[db guard]`
