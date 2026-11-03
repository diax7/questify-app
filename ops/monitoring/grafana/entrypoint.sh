#!/bin/sh
# Stops with the name of the setting (never its value) when the app's environment is incomplete, so Grafana never starts
# with its default signing key, an empty admin password or a data source that points nowhere; then starts Grafana.
set -eu
# shellcheck disable=SC3040 # BusyBox ash (this image) supports pipefail.
set -o pipefail

fail() {
  echo "entrypoint: $1" >&2
  exit 1
}

# check NAME PATTERN SHAPE: the variable is set and matches the extended regular expression.
check() {
  eval "value=\${$1:-}"
  [ -n "$value" ] || fail "$1 is not set; it must be $3"
  printf '%s' "$value" | grep -Eq "$2" || fail "$1 is not in the expected shape; it must be $3"
}

check GF_SECURITY_ADMIN_PASSWORD '^[^[:space:]]{24,}$' "at least 24 characters, no spaces"
check GF_SECURITY_SECRET_KEY '^[^[:space:]]{32,}$' "at least 32 characters, no spaces"
check GF_SERVER_ROOT_URL '^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$' "the public https address of this app"
check PROMETHEUS_URL '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$' "the address of the Prometheus app, without a path"
check METRICS_PASSWORD '^[^[:space:]]{24,}$' "the password of the Prometheus app's questify-metrics user"

exec /run.sh
