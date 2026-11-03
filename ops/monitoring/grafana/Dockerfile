# Grafana app for CranL (build path ops/monitoring/grafana; ADR-620 to ADR-625): Grafana with its one data source and the
# SLO dashboard provisioned from files, no volume (the dashboards are in the image; sessions and preferences are not
# worth keeping). Pinned by tag and by digest; raise it on purpose (docs/RUNBOOK.md, "Monitoring stack on CranL") and
# run `pnpm monitoring:validate`. Secrets and addresses come from the app's environment; the entrypoint checks them.
FROM grafana/grafana:13.2.5@sha256:9f7aa1e1e3246aade5792d35a738049f7f32f89cd51d1956cf426a4e86268a84

# Nothing here is secret. Login is required for everything; there is no sign-up, no organization creation, no outside
# call (updates, news, plugin catalog, gravatar, analytics, external snapshots), and the cookie is https only.
ENV GF_SERVER_HTTP_PORT=3000 \
    GF_AUTH_ANONYMOUS_ENABLED=false \
    GF_USERS_ALLOW_SIGN_UP=false \
    GF_USERS_ALLOW_ORG_CREATE=false \
    GF_SECURITY_COOKIE_SECURE=true \
    GF_SECURITY_DISABLE_GRAVATAR=true \
    GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_ANALYTICS_CHECK_FOR_UPDATES=false \
    GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false \
    GF_PLUGINS_PLUGIN_ADMIN_ENABLED=false \
    GF_NEWS_NEWS_FEED_ENABLED=false \
    GF_SNAPSHOTS_EXTERNAL_ENABLED=false \
    GF_METRICS_ENABLED=false

COPY --chown=root:root provisioning /etc/grafana/provisioning
COPY --chown=root:root dashboards /etc/questify/dashboards
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
