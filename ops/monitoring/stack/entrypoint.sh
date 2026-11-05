#!/bin/sh
# Starts the four programs of the monitoring app in one container (ADR-626): the Alertmanager, Prometheus, Grafana and
# Caddy, which is the only one that listens outside this machine. CranL gives an app one public port, so the others
# listen on 127.0.0.1 and nothing outside can reach them except through Caddy's two routes.
#
# This script is the supervisor: if any of the four exits for any reason, it stops the other three and exits with an
# error, so the container ends and CranL starts it again; a half-working stack (rules evaluated and nobody to hear them,
# or a dashboard without data) is never left running. A stop signal (a redeploy) stops all four and exits cleanly; a
# program that has not ended 20 seconds after its TERM is killed, so a stuck program cannot hold the container open.
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

# is_dead PID: true when the program is gone or is a zombie (it has exited and nobody has collected its status yet; kill -0
# still succeeds on a zombie). A /proc file that cannot be read means the program is gone.
is_dead() {
  kill -0 "$1" 2>/dev/null || return 0
  found=0
  grep -q '^State:[[:space:]]*Z' "/proc/$1/status" 2>/dev/null || found=$?
  [ "$found" -ne 1 ]
}

# all_dead: true when every program has exited.
all_dead() {
  for entry in $processes; do
    is_dead "${entry#*:}" || return 1
  done
}

# How long the programs have to end after a TERM before they are killed. CranL waits about 30 seconds after its stop
# signal before it kills the container, so this stays below that.
STOP_GRACE_SECONDS=20

# stop_all: sends TERM to every program, waits up to STOP_GRACE_SECONDS for them to end, then sends KILL to any that are
# left and collects them all.
stop_all() {
  for entry in $processes; do
    kill -TERM "${entry#*:}" 2>/dev/null || true
  done
  waited=0
  until all_dead || [ "$waited" -ge "$STOP_GRACE_SECONDS" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  for entry in $processes; do
    is_dead "${entry#*:}" || kill -KILL "${entry#*:}" 2>/dev/null || true
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

# The programs are polled once a second. `wait -n` is not used: in this image's BusyBox 1.37 it does not return when a
# program exits with an error or is killed by a signal, which would leave the container running half-broken.
stopped=""
while [ -z "$stopped" ]; do
  sleep 1
  for entry in $processes; do
    if is_dead "${entry#*:}"; then
      stopped=${entry%%:*}
      break
    fi
  done
done
echo "entrypoint: $stopped stopped; stopping the other programs so the container restarts" >&2
stop_all
exit 1
