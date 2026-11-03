# Prometheus app for CranL (build path ops/monitoring/prometheus; ADR-620 to ADR-625): Prometheus with the Questify
# alert rules, and the Alertmanager that mails them, in one container. The versions below are pinned by tag and by
# digest; raise them on purpose (docs/RUNBOOK.md, "Monitoring stack on CranL") and run `pnpm monitoring:validate`.
FROM prom/alertmanager:v0.34.2@sha256:39d8bb3966c694a124428a3a88fbcffd40bd069129ecd47c059f8a3f17c55f3b AS alertmanager

FROM prom/prometheus:v3.15.1@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2
COPY --from=alertmanager /bin/alertmanager /bin/amtool /bin/

USER root
# /data is where the app's volume is mounted: Prometheus writes /data/prometheus, the Alertmanager /data/alertmanager.
RUN mkdir -p /data && chown nobody:nobody /data
COPY --chmod=0755 entrypoint.sh render-config.sh /usr/local/bin/
COPY prometheus.yml questify.rules.yml /etc/prometheus/
COPY alertmanager.yml.in questify.email.tmpl.in /etc/questify/
USER nobody

EXPOSE 9090
# Prometheus answers 401 to anything without the password, so the check only asks whether the port is open.
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s CMD nc -z 127.0.0.1 9090 || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
