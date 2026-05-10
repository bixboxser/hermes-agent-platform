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

## External CLI runtime layer

The `app` and `worker` Compose services build the local Hermes image from `Dockerfile` instead of running the plain `node:20-bullseye` image. The image keeps Node 20 and adds only the runtime tools needed by Printing Press CLIs: `git`, `curl`, `ca-certificates`, `bash`, and a Go toolchain. The image sets `GOPATH=/root/go`, `GOBIN=/root/go/bin`, and prepends `/root/go/bin` to `PATH` so Go-installed binaries are executable by `hermes_worker`.

At container start, `hermes-entrypoint` runs `install-printing-press-clis` unless `HERMES_INSTALL_PRINTING_PRESS_CLIS=false`. The installer uses runtime `GITHUB_TOKEN` or `GH_TOKEN` from the container environment; tokens are not copied into Docker image layers and installer error output is redacted before logging.

Installed by default:

- `printing-press`
- `company-goat`
- `contact-goat`
- `flight-goat`
- `archive-is`
- `apartments`
- `hackernews`
- `espn`

Manual safe install/retry inside a running container:

```sh
docker exec hermes_worker bash -lc 'install-printing-press-clis'
```

If private catalog or Go module access is missing, the script exits non-zero with a redacted diagnostic and asks for runtime `GITHUB_TOKEN`/`GH_TOKEN` access. It does not run enrichment commands; verification should use `command -v` and `--help` only.
