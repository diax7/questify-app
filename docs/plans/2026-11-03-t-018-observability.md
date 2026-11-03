# T-018 - Observability and service levels (plan note, tier B)

Delivers no FR (quality gate; QUALITY_BASELINE section 4, ARCHITECTURE "Observability", ADR-074, ADR-082). Builds the API side:
metrics and traces through OpenTelemetry, logs that carry the trace, written service levels, alert rules and a runbook entry for
every alert. No migration. ADR-600 to ADR-605, Q-560 to Q-562.

## Split (ADR-600)

Everything that needs a place to send telemetry or a database function waits. **T-018b** (after Dhia answers Q-560 and Q-561):
the collector, store and alert manager on CranL, the outside probe, on-call routing, dashboards; queue depth and age and ranking
staleness read from the database (a system-context definer function, a migration, an outsider test); certificate and key expiry;
the web app's traces. Each half delivers value alone: T-018 makes every signal exist and every alert defined and explained, and
turns on with one setting; T-018b makes someone receive it.

## What is built

1. **`apps/api/src/telemetry/`**
   - `config.ts`: `loadTelemetryConfig(env)`. `TELEMETRY_EXPORTER` = `off` (default), `console` or `otlp`; `otlp` needs
     `OTEL_EXPORTER_OTLP_ENDPOINT` (https, or http on localhost; no user, password or query) and takes `OTEL_EXPORTER_OTLP_HEADERS`
     for a bearer token; `TELEMETRY_TRACE_RATIO` (default 0.1), `TELEMETRY_METRIC_INTERVAL_MS` (default 60000). Fails fast and
     names the variable, never the value. `AppConfig` is untouched.
   - `sdk.ts`: installs a tracer provider (async-local-storage context, parent-based ratio sampler, batch processor, 5 s export
     timeout), a meter provider (periodic reader) and a resource of three fixed attributes. Off installs nothing: the API's
     instruments are no-ops. `shutdown()` flushes. An export failure is one rate-limited stderr line, `telemetry.export_failed`.
   - `attributes.ts`: the only door for an attribute. A closed list of keys, each with a value pattern; anything else is dropped.
   - `instruments.ts`: the metric catalog (below) as one object, rebuilt when the provider is installed.
   - `http.ts`: Fastify hooks. One server span and one duration sample per request, labelled by method, route pattern (never the
     URL), status and route class (`completion` for the four scan routes). Unmatched paths are `unmatched`. Incoming trace
     headers are ignored (a client must not choose our trace ids).
   - `logs.ts`: pino `mixin` adds `trace_id` and `span_id`; pino `hooks.logMethod` counts every line that has an `event` field by
     event and level, nothing else. This one counter turns the existing log lines (about 130 events) into the alert signals,
     including the T-711b deploy-window note (`community.settle_failed`: alert on repeats, never on one line).
   - `outbound.ts`: wraps the SMS sender, the email senders and the push providers: a span, a duration and an outcome counter by
     provider and outcome (`sent`, `unknown`, `refused`, `failed`, ...).
   - `runs.ts`: `trackRun(tick, run)` (span, duration, run counter, last-run time) used by the nine background loops; an
     observable gauge reports the age of each loop's last run.
   - `pool.ts`: connection gauges (total, idle, waiting) for the API and push pools.
2. **Wiring.** `server.ts` loads and starts telemetry first and shuts it down last; `app.ts` registers the hooks and the log
   options; the nine loops call `trackRun`; `server.ts` wraps the senders and observes the pools.
3. **Docs.** `docs/SLO.md` (targets, how each is measured, the alert table, the catalog, what is never recorded);
   `ops/alerts/questify.rules.yml` (Prometheus rule format, the common ground of every ruler); `RUNBOOK.md` section "Alerts" with one
   entry per alert; the T-711b and community notes now point at alert names; SECURITY.md deviation note closed.

## Metrics (names are OpenTelemetry; the rules use the Prometheus spelling)

`http.server.request.duration` (s; buckets with a boundary at exactly 1 s) by method, route, status, route class;
`questify.log.events` by event and level; `questify.outbound.requests` and `questify.outbound.duration` by provider, operation,
outcome; `questify.tick.runs`, `questify.tick.duration`, `questify.tick.last_run` by tick; `questify.db.pool.connections` by pool and
state.

## Personal data (the test)

No telemetry attribute can hold a free string: keys are listed with patterns. A test drives the real app with a recording span
exporter and metric reader and with a log stream, sends sentinel values as a username in the path, an email and a phone in the
body and query, a bearer token, a cookie, a forwarded address and a user agent (accepted, refused and failing requests), and
asserts that no sentinel appears in any span, metric or log line, that every attribute key is on the list, and that no listed key
looks like personal data. A second test checks the closed list itself and that every metric label value the code can produce
matches its pattern.

## Consistency checks (tests)

Every alert in `questify.rules.yml` has a runbook entry (a heading with its name in RUNBOOK.md); every metric an expression uses is in
the catalog (names translated the Prometheus way); the four completion routes and every `trackRun` name exist.

## Dependencies (CLAUDE.md hard rule 8)

`@opentelemetry/api` 1.10.0, `sdk-trace` 3.0.0, `sdk-metrics` 3.0.0, `resources` 3.0.0, `context-async-hooks` 3.0.0,
`exporter-trace-otlp-http` and `exporter-metrics-otlp-http` 0.300.0 (released 2026-10-20; the 3.x line removed `sdk-trace-node`
and `sdk-trace-base`, and the API 1.10 peer range excludes the 2.x node package). The smallest set that gives context
propagation, a metric pipeline and OTLP over HTTP; no `sdk-node` (it brings gRPC and every exporter), no auto-instrumentation (it
patches `pg` and `http` and records statements and URLs, which is the personal-data risk). `yaml` as a test-only dependency reads
the rules file (already in the lockfile through vite). Node 22.15 or newer is required by the 3.x line; the image is `node:22`.

## As built (2026-11-03)

- Twenty alerts, not eighteen: `QuestifySignInThrottleSpike` and `QuestifySendBudgetSpent` came from the T-006 and T-107 notes (throttle
  spikes; the sign-in and sending budgets). Email down is `QuestifyEmailFailing`, the backup in use is `QuestifyEmailBackupInUse`. The
  one-address-key aggregate stays a log query (RUNBOOK) and moves to T-018b: a metric label may not hold an address tag.
- `createServer` in `app.ts` holds the Fastify setup, the inventory, the request span and the JSON parser rule, so `buildApp` is shorter
  than before (the function-limit baseline was lowered).
- `countLogEvent` counts a line only if its `event` has the shape of an event name, so a stray string never becomes a label.
- The pii test found a leak that was already there: the request log wrote the path of an unmatched request (anything a caller typed).
  It is written as `unmatched` now (`loggerOptions`, ADR-603).
- `promtool` is not installed; the rules were checked and unit-tested once through the `prom/prometheus` image (RUNBOOK has the commands).
  Mutating a rule's `for` made a unit test fail, as it should.
- Not built, by design: the logs SDK (ADR-602), an inbound `traceparent` (ADR-601), process and event-loop metrics, SQL spans.
