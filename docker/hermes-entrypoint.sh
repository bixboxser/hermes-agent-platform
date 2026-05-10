#!/usr/bin/env bash
set -Eeuo pipefail

export GOPATH="${GOPATH:-/root/go}"
export GOBIN="${GOBIN:-${GOPATH}/bin}"
export PATH="${GOBIN}:/usr/local/go/bin:${PATH}"

if [ "${HERMES_INSTALL_PRINTING_PRESS_CLIS:-true}" != "false" ]; then
  set +e
  install-printing-press-clis
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "[hermes-entrypoint] Printing Press CLI install did not complete (exit ${status}); starting Hermes anyway." >&2
  fi
fi

exec "$@"
