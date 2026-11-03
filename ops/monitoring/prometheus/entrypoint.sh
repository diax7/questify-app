#!/bin/sh
# Starts the Alertmanager beside Prometheus in one container (ADR-621): CranL gives an app one public port, so the
# Alertmanager listens on this machine only and nothing outside can send or silence an alert. Prometheus is the main
# process (it receives the stop signal of a redeploy); if the Alertmanager ever exits, it is told to stop, the container
# ends and CranL starts it again. The data directory is the app's volume.
set -eu
# shellcheck disable=SC3040 # BusyBox ash (this image) supports pipefail.
set -o pipefail

/usr/local/bin/render-config.sh

(
  /bin/alertmanager \
    --config.file=/tmp/alertmanager.yml \
    --storage.path=/data/alertmanager \
    --web.listen-address=127.0.0.1:9093 \
    --cluster.listen-address=
  echo "entrypoint: the Alertmanager stopped; stopping Prometheus so the container restarts" >&2
  kill -TERM "$$"
) &

# The 5 minute look-back is what the loop alerts (ADR-605) are written against; it is stated here so a new default
# in a later Prometheus cannot change them. Retention keeps the 30-day budget window; the size cap is below the
# 5 GB volume so Prometheus drops its oldest blocks before the disk fills.
exec /bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --web.config.file=/tmp/web.yml \
  --web.listen-address=0.0.0.0:9090 \
  --web.enable-remote-write-receiver \
  --query.lookback-delta=5m \
  --storage.tsdb.path=/data/prometheus \
  --storage.tsdb.retention.time=30d \
  --storage.tsdb.retention.size=4GB
