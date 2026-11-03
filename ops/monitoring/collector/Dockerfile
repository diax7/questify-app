# Telemetry collector app for CranL (build path ops/monitoring/collector; ADR-620 to ADR-625): the OpenTelemetry
# Collector (contrib build, which has the bearer-token, filter and Prometheus remote-write components) with the config
# next to this file. Pinned by tag and by digest; raise it on purpose (docs/RUNBOOK.md, "Monitoring stack on CranL")
# and run `pnpm monitoring:validate`. The image has no shell: settings come from the app's environment through
# `${env:NAME}` in config.yaml.
FROM otel/opentelemetry-collector-contrib:0.164.0@sha256:340c9ca6a36617084c6661bdc4f0fe92b7cda5a805d61673ec8db375fddc522b

COPY config.yaml /etc/otelcol-contrib/config.yaml

EXPOSE 4318
ENTRYPOINT ["/otelcol-contrib"]
CMD ["--config=/etc/otelcol-contrib/config.yaml"]
