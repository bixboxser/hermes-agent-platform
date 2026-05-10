#!/usr/bin/env bash
set -Eeuo pipefail

export GOPATH="${GOPATH:-/root/go}"
export GOBIN="${GOBIN:-${GOPATH}/bin}"
export PATH="${GOBIN}:/usr/local/go/bin:${PATH}"

PRINTING_PRESS_GO_MODULE="${PRINTING_PRESS_GO_MODULE:-github.com/mvanhorn/cli-printing-press/v4/cmd/printing-press@latest}"
PRINTING_PRESS_NPM_PACKAGE="${PRINTING_PRESS_NPM_PACKAGE:-@mvanhorn/printing-press}"
PRINTING_PRESS_CLI_TOOLS="${PRINTING_PRESS_CLI_TOOLS:-company-goat contact-goat flight-goat archive-is apartments hackernews espn}"
export GOPRIVATE="${GOPRIVATE:-github.com/mvanhorn/*}"

log() {
  printf '[printing-press-install] %s\n' "$*" >&2
}

have_any_token() {
  [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GH_TOKEN:-}" ]
}

token_value() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    printf '%s' "$GITHUB_TOKEN"
  else
    printf '%s' "${GH_TOKEN:-}"
  fi
}

setup_git_auth() {
  local token askpass
  token="$(token_value)"
  [ -n "$token" ] || return 0
  askpass="$(mktemp)"
  chmod 700 "$askpass"
  cat >"$askpass" <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) printf '%s\n' "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ;;
  *) printf '%s\n' "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ;;
esac
ASKPASS
  export GIT_ASKPASS="$askpass"
  export GIT_TERMINAL_PROMPT=0
  trap 'rm -f "${GIT_ASKPASS:-}"' EXIT
}

redact_file() {
  local file="$1"
  sed -E \
    -e 's/(token|apikey|api_key|authorization|password|bearer|secret)([=: ]+)[^[:space:]]+/\1\2[REDACTED]/Ig' \
    -e 's#https://[^:@[:space:]]+:[^@[:space:]]+@github.com#https://[REDACTED]@github.com#Ig' \
    "$file" >&2 || true
}

run_redacted() {
  local tmp status
  tmp="$(mktemp)"
  set +e
  "$@" >"$tmp" 2>&1
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    log "command failed: $1 (exit $status)"
    redact_file "$tmp"
  fi
  rm -f "$tmp"
  return "$status"
}

mkdir -p "$GOBIN"
setup_git_auth

if ! command -v go >/dev/null 2>&1; then
  log "Go toolchain is missing; cannot install Printing Press CLIs."
  exit 10
fi

if ! command -v npm >/dev/null 2>&1; then
  log "npm is missing; cannot run the Printing Press installer."
  exit 11
fi

if ! command -v printing-press >/dev/null 2>&1; then
  log "installing printing-press Go binary"
  if ! run_redacted go install "$PRINTING_PRESS_GO_MODULE"; then
    log "printing-press binary install failed; check network and Go module access."
    exit 20
  fi
else
  log "printing-press already installed at $(command -v printing-press)"
fi

missing=""
for tool in $PRINTING_PRESS_CLI_TOOLS; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing="$missing $tool"
  fi
done

if [ -z "${missing# }" ]; then
  log "requested Printing Press CLIs already installed"
  exit 0
fi

if ! have_any_token; then
  log "GITHUB_TOKEN/GH_TOKEN is not set; skipping private catalog CLI install for:${missing}"
  log "Set GITHUB_TOKEN or GH_TOKEN at container runtime and rerun: install-printing-press-clis"
  exit 30
fi

log "installing Printing Press CLIs:${missing}"
if ! run_redacted npx -y "$PRINTING_PRESS_NPM_PACKAGE" install --cli-only $missing; then
  log "Printing Press CLI install failed. Verify GITHUB_TOKEN/GH_TOKEN has catalog access and private Go module access."
  exit 31
fi

still_missing=""
for tool in $PRINTING_PRESS_CLI_TOOLS; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    still_missing="$still_missing $tool"
  fi
done

if [ -n "${still_missing# }" ]; then
  log "installer completed but these binaries are still missing:${still_missing}"
  exit 32
fi

log "all requested Printing Press CLIs are installed"
