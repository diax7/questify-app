#!/bin/sh
# Starts the four programs of the monitoring app in one container (ADR-626): the Alertmanager, Prometheus, Grafana and
# Caddy, which is the only one that listens outside this machine. CranL gives an app one public port, so the others
# listen on 127.0.0.1 and nothing outside can reach them except through Caddy's two routes.
#
# This script is the supervisor: if any of the four exits for any reason, it stops the other three and exits with an
# error, so the container ends and CranL starts it again; a half-working stack (rules evaluated and nobody to hear them,
# or a dashboard without data) is never left running. A stop signal (a redeploy) stops all four and exits cleanly.
# The data directory is the app's volume.
set -eu
# shellcheck disable=SC3040 # BusyBox ash (this image) supports pipefail.
set -o pipefail

/usr/local/bin/render-config.sh

processes=""

# launch NAME COMMAND...: starts the command in the background and remembers it as NAME:PID.
launch() {
  name=$1
  shift
  "$@" &
  processes="$processes $name:$!"
}

stop_all() {
  for entry in $processes; do
    kill -TERM "${entry#*:}" 2>/dev/null || true
  done
  wait || true
}

# shellcheck disable=SC2329 # the trap below invokes it.
stop_on_signal() {
  echo "entrypoint: stop signal received; stopping all programs" >&2
  stop_all
  exit 0
}
trap stop_on_signal TERM INT

launch alertmanager /usr/local/bin/alertmanager \
  --config.file=/tmp/alertmanager.yml \
  --storage.path=/data/alertmanager \
  --web.listen-address=127.0.0.1:9093 \
  --cluster.listen-address=

# The 5 minute look-back is what the loop alerts (ADR-605) are written against; it is stated here so a new default
# in a later Prometheus cannot change them. Retention keeps the 30-day budget window; the size cap is below the
# 5 GB volume so Prometheus drops its oldest blocks before the disk fills. The OTLP receiver is the way in for the API;
# the remote-write receiver, the admin API and the lifecycle API stay off.
launch prometheus /usr/local/bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --web.config.file=/tmp/web.yml \
  --web.listen-address=127.0.0.1:9090 \
  --web.enable-otlp-receiver \
  --query.lookback-delta=5m \
  --storage.tsdb.path=/data/prometheus \
  --storage.tsdb.retention.time=30d \
  --storage.tsdb.retention.size=4GB

launch grafana /run.sh

launch caddy /usr/local/bin/caddy run --config /etc/questify/Caddyfile --adapter caddyfile

# shellcheck disable=SC3045 # BusyBox ash (this image) supports wait -n.
wait -n || true
for entry in $processes; do
  if ! kill -0 "${entry#*:}" 2>/dev/null; then
    echo "entrypoint: ${entry%%:*} stopped; stopping the other programs so the container restarts" >&2
  fi
done
stop_all
exit 1
