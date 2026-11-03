#!/bin/sh
# Writes the files Prometheus and Alertmanager read at start from this app's environment (docs/RUNBOOK.md, "Monitoring
# stack on CranL"). Neither program expands environment variables in its configuration, so the values are checked here
# for their shape (a value outside the shape stops the container with the variable's name, never its value) and then
# written: passwords to their own files, everything else into the @NAME@ places of the templates.
#
# Alert email is optional (Q-581). With ALERT_SMTP_HOST unset or empty the Alertmanager gets a configuration that
# sends nothing (alerts are still evaluated and show on the Grafana dashboard); with it set, all five ALERT_* settings
# are required and checked.
set -eu
# shellcheck disable=SC3040 # BusyBox ash (this image) supports pipefail.
set -o pipefail

TEMPLATES=/etc/questify
OUT=/tmp

fail() {
  echo "render-config: $1" >&2
  exit 1
}

# check NAME PATTERN SHAPE: the variable is set and matches the extended regular expression.
check() {
  eval "value=\${$1:-}"
  [ -n "$value" ] || fail "$1 is not set; it must be $3"
  printf '%s' "$value" | grep -Eq "$2" || fail "$1 is not in the expected shape; it must be $3"
}

# Another ALERT_* setting left over without the host is a half-finished email setup, not a choice: it stops the app.
render_without_email() {
  for name in ALERT_SMTP_USER ALERT_SMTP_PASSWORD ALERT_MAIL_FROM ALERT_MAIL_TO; do
    eval "value=\${$name:-}"
    [ -z "$value" ] || fail "ALERT_SMTP_HOST is not set but $name is; set all five ALERT_* settings to turn alert email on, or remove them all"
  done
  cp "$TEMPLATES/alertmanager.nomail.yml" "$OUT/alertmanager.yml"
  echo "render-config: alert email off: no ALERT_SMTP_HOST; alerts show on the Grafana dashboard only"
}

render_with_email() {
  check ALERT_SMTP_PASSWORD '^[^[:cntrl:]]+$' "the SMTP password, on one line"
  check ALERT_SMTP_HOST '^[A-Za-z0-9.-]+:[0-9]{2,5}$' "host:port, like smtp.example.com:587"
  check ALERT_SMTP_USER '^[A-Za-z0-9._@+-]{1,128}$' "the SMTP user name"
  check ALERT_MAIL_FROM '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' "an email address"
  check ALERT_MAIL_TO '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' "an email address"
  check MONITORING_ENVIRONMENT '^[a-z][a-z0-9-]{1,23}$' "a short lower-case name, like staging"
  printf '%s' "$ALERT_SMTP_PASSWORD" >"$OUT/smtp-password"
  sed \
    -e "s|@ALERT_SMTP_HOST@|$ALERT_SMTP_HOST|g" \
    -e "s|@ALERT_SMTP_USER@|$ALERT_SMTP_USER|g" \
    -e "s|@ALERT_MAIL_FROM@|$ALERT_MAIL_FROM|g" \
    -e "s|@ALERT_MAIL_TO@|$ALERT_MAIL_TO|g" \
    "$TEMPLATES/alertmanager.yml.in" >"$OUT/alertmanager.yml"
  sed -e "s|@MONITORING_ENVIRONMENT@|$MONITORING_ENVIRONMENT|g" \
    "$TEMPLATES/questify.email.tmpl.in" >"$OUT/questify.email.tmpl"
}

check METRICS_PASSWORD '^[^[:space:]]{24,}$' "at least 24 characters, no spaces"
# shellcheck disable=SC2016 # the pattern is a regular expression; its dollar signs are literal.
check METRICS_PASSWORD_HASH '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' "the bcrypt hash of METRICS_PASSWORD"

umask 077
if [ -n "${ALERT_SMTP_HOST:-}" ]; then
  render_with_email
else
  render_without_email
fi
printf '%s' "$METRICS_PASSWORD" >"$OUT/metrics-password"
printf "basic_auth_users:\n  questify-metrics: '%s'\n" "$METRICS_PASSWORD_HASH" >"$OUT/web.yml"
