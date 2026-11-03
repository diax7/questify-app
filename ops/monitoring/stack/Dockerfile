# The one CranL monitoring app (build path ops/monitoring/stack; ADR-626): Caddy on the public port, Prometheus with its
# OTLP receiver and the Questify alert rules, the Alertmanager that mails them, and Grafana with the SLO dashboard, in one
# container. The base is Grafana's image (it has the shell Grafana's start script needs); the other three programs are
# static binaries copied from their own official images. Every image is pinned by version and by digest; raise them on
# purpose (docs/RUNBOOK.md, "Monitoring stack on CranL") and run `pnpm monitoring:validate`.
FROM prom/alertmanager:v0.34.2@sha256:39d8bb3966c694a124428a3a88fbcffd40bd069129ecd47c059f8a3f17c55f3b AS alertmanager
FROM prom/prometheus:v3.15.1@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2 AS prometheus
FROM caddy:2.11.7@sha256:36c24ad91a7ff7bc4c87fe22bfa8df3c4b18da0773d73fc12ee2c52b98c0bb7e AS caddy

FROM grafana/grafana:13.2.5@sha256:9f7aa1e1e3246aade5792d35a738049f7f32f89cd51d1956cf426a4e86268a84

COPY --from=prometheus /bin/prometheus /bin/promtool /usr/local/bin/
COPY --from=alertmanager /bin/alertmanager /bin/amtool /usr/local/bin/
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy

# Nothing here is secret. Grafana listens on this machine only, under /grafana behind Caddy; login is required for
# everything; there is no sign-up, no organization creation, no outside call (updates, news, plugin catalog, the
# plugins Grafana would otherwise download at every start, gravatar, analytics, external snapshots); the cookie is
# https only and Grafana's own /metrics is closed. Caddy keeps its state in /tmp (nothing of it is worth keeping).
ENV GF_SERVER_HTTP_ADDR=127.0.0.1 \
    GF_SERVER_HTTP_PORT=3000 \
    GF_SERVER_SERVE_FROM_SUB_PATH=true \
    GF_AUTH_ANONYMOUS_ENABLED=false \
    GF_USERS_ALLOW_SIGN_UP=false \
    GF_USERS_ALLOW_ORG_CREATE=false \
    GF_SECURITY_COOKIE_SECURE=true \
    GF_SECURITY_DISABLE_GRAVATAR=true \
    GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_ANALYTICS_CHECK_FOR_UPDATES=false \
    GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false \
    GF_PLUGINS_PLUGIN_ADMIN_ENABLED=false \
    GF_PLUGINS_PREINSTALL_DISABLED=true \
    GF_NEWS_NEWS_FEED_ENABLED=false \
    GF_SNAPSHOTS_EXTERNAL_ENABLED=false \
    GF_METRICS_ENABLED=false \
    XDG_DATA_HOME=/tmp \
    XDG_CONFIG_HOME=/tmp

USER root
# /data is where the app's volume is mounted: Prometheus writes /data/prometheus, the Alertmanager /data/alertmanager.
RUN mkdir -p /data && chown grafana:root /data
COPY --chmod=0755 entrypoint.sh render-config.sh /usr/local/bin/
COPY prometheus.yml questify.rules.yml /etc/prometheus/
COPY alertmanager.yml.in alertmanager.nomail.yml questify.email.tmpl.in Caddyfile /etc/questify/
COPY --chown=root:root grafana/provisioning /etc/grafana/provisioning
COPY --chown=root:root grafana/dashboards /etc/questify/dashboards
USER grafana

EXPOSE 8080
# Every program listens on its own port; the entrypoint stops the container when any of them exits, so an open port
# on all four is the whole check (Prometheus and Grafana answer 401 to anyone without a password).
HEALTHCHECK --interval=30s --timeout=3s --start-period=90s CMD nc -z 127.0.0.1 8080 && nc -z 127.0.0.1 9090 && nc -z 127.0.0.1 9093 && nc -z 127.0.0.1 3000 || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
