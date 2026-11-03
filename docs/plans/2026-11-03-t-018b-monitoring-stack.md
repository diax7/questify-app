# T-018b - The monitoring stack, prepared (plan note, tier B)

Delivers no FR (quality gate; ARCHITECTURE "Observability", ADR-079). Dhia decided (Q-560, Q-561, 2026-11-03): telemetry goes to CranL
`riyadh-1` (a collector, a Prometheus-compatible store and Grafana as CranL apps; data stays in Saudi Arabia) and alerts go to Dhia by
email, the sending address `MAIL_FROM` for now. This task **prepares** that, with no CranL call and no secret: the container
definitions, the configuration, the runbook and the offline checks. Creating the apps is T-017's scripts or a person following the
RUNBOOK; the rest of T-018b stays open (below). ADR-620 to ADR-625, Q-580 to Q-584, all Proposed.

## What is built

1. **`ops/monitoring/`**, one folder per CranL app, each with a `Dockerfile` (base image pinned by version and digest), because a
   CranL build sees only its own folder.
   - `collector/`: OpenTelemetry Collector contrib 0.164.0. OTLP over HTTP in, bearer token required (two slots for rotation), the
     `transform` processor keeps only the attribute keys of `ATTRIBUTE_RULES` and `RESOURCE_KEYS` and fails closed, metrics out by
     Prometheus remote write with basic auth, traces accepted and dropped (Q-583).
   - `prometheus/`: Prometheus v3.15.1 loading a copy of `ops/alerts/questify.rules.yml`, and Alertmanager v0.34.2 on 127.0.0.1 in the
     same container (`entrypoint.sh` starts both; if the Alertmanager exits the container stops). `render-config.sh` checks the
     settings and fills the Alertmanager files, which cannot read the environment. Remote write receiver on, one basic-auth user,
     30 days and 4 GB of retention on a 5 GB volume.
   - `grafana/`: Grafana 13.2.5, no volume, anonymous view off, the Prometheus data source and the "Questify SLOs" dashboard
     provisioned from files (SLO-1 to SLO-4, SLO-7, SLO-8, capacity, firing alerts, the stack's own health).
2. **Checks.** `pnpm monitoring:validate` (`ops/monitoring/validate.mjs`) builds the images, runs `otelcol validate`, `promtool`,
   `amtool`, `shellcheck`, `shfmt`, then starts the stack on a private Docker network and proves the behaviour (RUNBOOK lists it).
   `apps/api/src/telemetry/monitoring.test.ts` (vitest) keeps the files equal to the API's attribute list, the pinned images, the
   routes and the RUNBOOK's list of settings.
3. **RUNBOOK "Monitoring stack on CranL"**: the three apps, the exact settings of each, how to point the API at the collector, token
   rotation, retention and backups, operating notes, the expected footprint.

## Choices (Proposed ADRs)

- Prometheus, not VictoriaMetrics (ADR-621): the rules' tests are `promtool`'s, and the loop alerts depend on Prometheus' look-back.
- Every CranL app is public with one port, so every link has a credential, and the Alertmanager lives inside the Prometheus container
  (ADR-622).
- One stack per environment (ADR-620, Q-582). Traces dropped for now (ADR-623, Q-583). Alert mail by SMTP, account to be chosen
  (ADR-624, Q-581).

## What the live check found in the first draft

The filter deleted nothing (all `keep_keys` statements in one OTTL group run at the lowest context, an exemplar or span event, of which
there are none); a test password hash that did not match its password; a mail server that cannot be given a password over a connection
without TLS. All three are fixed, and the first is the reason the live check exists.

## Not in this task (T-018b stays open)

Creating the apps and setting the API's `TELEMETRY_*` on staging and production (T-017 and a person with the CranL account, Q-580); the
fired test alert on staging; the outside `/readyz` probe (Q-584); the database function and migration for queue depth, oldest waiting
notice, expired leases and ranking staleness (tier A, own plan review); certificate and key expiry probes; the one-address-key aggregate;
the web app's traces; error tracking. No CI job runs `monitoring:validate` yet (FOLLOWUPS).
