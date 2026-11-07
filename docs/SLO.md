# Service levels, telemetry and alerts

> Written for T-018 (ADR-600 to ADR-605). The targets come from ADR-074 and ADR-082; each is measured, alerted on and
> has an entry in `RUNBOOK.md` ("Telemetry and alerts"). Where a target is not measured yet, this page says so.

## 1. Targets

| ID | Target | Measured as | Window | Alert |
|---|---|---|---|---|
| SLO-1 Availability | 99.9% a month for the player service, dashboard, staff mode and big screen (ADR-074) | the share of requests that do not answer 5xx (`http_server_request_duration_seconds_count`). A 503 `busy` counts: the player saw a failure | 30 days (43 minutes of budget) | `QuestifyAvailabilityFastBurn`, `QuestifyAvailabilitySlowBurn`, `QuestifyTelemetryMissing` |
| SLO-2 Completion speed | 95% of completions confirmed within 1 second, also at the 20,000 a minute peak (ADR-074, NFR-003) | the share of scan requests (`questify_route_class="completion"`) answered within 1 s, from the histogram edge at exactly 1 s | 10 minutes | `QuestifyCompletionSlow` |
| SLO-3 Completion success | 99.9% of scans do not answer 5xx | the same count restricted to the completion class | 30 days | `QuestifyCompletionFastBurn` |
| SLO-4 Ranking freshness | the live ranking shows a change within 5 seconds (ADR-074) | **not measured directly yet.** Guarded by three signals: the repair loop runs (`ranking_repair`, at most 30 s since its last run), the cache and repair do not fail, and the completion speed above. The direct measure (age of the oldest unrepaired mark) needs a database function and is T-018b; the load test (NFR-003) proves the 5 s | continuous | `QuestifyRankingRepairStalled`, `QuestifyRankingStoreFailing` |
| SLO-5 Data loss | at most 5 minutes (point-in-time recovery, ADR-082) | not a runtime metric: proven by the restore rehearsal (T-805, NFR-026). Backup age is a T-018b probe | per incident | none yet |
| SLO-6 Recovery | service back within 1 hour (ADR-082) | the incident record (post-mortem, QUALITY_BASELINE section 4) | per incident | none |
| SLO-7 Background work | every background loop finishes a run at least every 5 minutes (the ranking repair every 30 s); community payouts are never behind | `questify_tick_last_run_seconds`, and the `community.*` events | continuous | `QuestifyLoopStalled`, `QuestifyCommunityPayoutsBehind`, `QuestifyCommunitySettleFailing` |
| SLO-8 Messages | no target number in the ADRs. First guess (Q-562): fewer than 20% of SMS, push and email sends fail over 15 minutes | `questify_outbound_requests_total` by outcome | 15 minutes | `QuestifySmsFailing`, `QuestifyPushFailing`, `QuestifyPushProviderRefusing`, `QuestifyEmailFailing`, `QuestifyEmailBackupInUse`, `QuestifySendBudgetSpent` |

Signals that are not targets of their own: `QuestifyDatabaseBusy` and `QuestifyDatabasePoolWaiting` (the database is the first thing
to run out, ARCHITECTURE "Growth path"), `QuestifyErrorEventRepeating` (any other error event that keeps coming) and
`QuestifySignInThrottleSpike` (the sign-in signals of T-006 and T-107: a throttle spike; email failing is `QuestifyEmailFailing`; which address
key carries the traffic stays a log query until T-018b).

**Error budget.** 99.9% a month is 43 minutes of full failure, or 0.1% of requests. A burn of 14.4 times the budget for an hour spends 2% of
the month and pages; 6 times for six hours spends 5% and opens a ticket (the usual multi-window rule: both a short and a long window must
agree, so a spike that has passed does not page). When a month's budget is spent, only fixes are deployed until the next month, and the
incident gets a short post-mortem (Proposed, ADR-604).

**What is not covered by these numbers.** The server's own count sees only requests that reach it. A dead machine, a broken certificate
or a failed DNS record never arrives, so the page `QuestifyTelemetryMissing` fires after ten silent minutes, and an outside probe of
`/readyz` is the real availability measure (T-018b, Q-561).

## 2. Alert rules

The rules are `ops/alerts/questify.rules.yml`, in Prometheus rule format, so they load into Prometheus, VictoriaMetrics (`vmalert`), Grafana
Mimir or Grafana's managed rules without change. `ops/alerts/questify.rules.test.yml` holds `promtool` unit tests of the rules that matter
most (a deploy blip does not alert, a sustained failure does, a short spike does not page). Severity `page` goes to the on-call phone and
email (ADR-079); `warning` opens a ticket. Each alert's `runbook` annotation points to its entry in `RUNBOOK.md`.

| Alert | Severity | Fires when | For | Target |
|---|---|---|---|---|
| `QuestifyAvailabilityFastBurn` | page | more than 1.44% of requests answer 5xx, over 5 minutes and over 1 hour | 2 m | SLO-1 |
| `QuestifyAvailabilitySlowBurn` | warning | more than 0.6% answer 5xx, over 30 minutes and over 6 hours | 15 m | SLO-1 |
| `QuestifyCompletionSlow` | page | more than 5% of scans take over 1 s (and more than 0.2 scans a second) | 10 m | SLO-2 |
| `QuestifyCompletionFastBurn` | page | more than 1.44% of scans answer 5xx, over 5 minutes and 1 hour | 2 m | SLO-3 |
| `QuestifyTelemetryMissing` | page | no request has been reported | 10 m | SLO-1 |
| `QuestifyDatabaseBusy` | warning | more than one "busy, retry" answer every 2 seconds | 5 m | capacity |
| `QuestifyDatabasePoolWaiting` | warning | a client has waited for a connection | 5 m | capacity |
| `QuestifyLoopStalled` | page | a background loop has not finished a run for 5 minutes | 2 m | SLO-7 |
| `QuestifyRankingRepairStalled` | page | the ranking repair loop has not run for 30 seconds | 1 m | SLO-4 |
| `QuestifyRankingStoreFailing` | page | a Redis or ranking failure event keeps coming | 10 m | SLO-4 |
| `QuestifyCommunitySettleFailing` | warning | a community settle or pay step keeps failing (never a single line: the deploy window of migration 0141 logs a few) | 10 m | SLO-7 |
| `QuestifyCommunityPayoutsBehind` | page | a goal's settle point is behind, a payout is stuck, or settling is blind | 5 m | SLO-7 |
| `QuestifyErrorEventRepeating` | warning | any other error event is logged more than 10 times in 15 minutes | 5 m | capacity |
| `QuestifyPushFailing` | warning | more than 20% of push sends fail, are lost, requeue or are held | 15 m | SLO-8 |
| `QuestifyPushProviderRefusing` | page | APNs or FCM refuses our requests, a round was mostly invalid tokens, or a notice is parked | 5 m | SLO-8 |
| `QuestifySmsFailing` | page | more than 20% of SMS are refused or lost | 15 m | SLO-8 |
| `QuestifyEmailFailing` | page | more than 60% of email sends fail (the backup is failing too) | 10 m | SLO-8 |
| `QuestifyEmailBackupInUse` | warning | Gmail failed and the backup provider sent | none | SLO-8 |
| `QuestifySignInThrottleSpike` | warning | sign-in, reset or code attempts are throttled more than once every 2 seconds | 10 m | security |
| `QuestifySendBudgetSpent` | warning | the hourly SMS budget or a daily email budget was reached | none | SLO-8 |

Not yet alerted (T-018b): queue depth and the age of the oldest waiting push or alert, database replica lag, certificate and key expiry
(Apple Pass Type ID, APNs and FCM keys), backup age. They need a database function, a probe or the host's own metrics.

## 3. What is recorded

OpenTelemetry names, with the Prometheus spelling the rules use. A store that keeps the dotted names (Prometheus 3 with UTF-8 names) needs
the rules rewritten; the alert test checks the underscore spelling against the code's catalog (`METRICS` in
`apps/api/src/telemetry/instruments.ts`).

| Metric (Prometheus name) | Kind | Labels | Meaning |
|---|---|---|---|
| `http.server.request.duration` (`http_server_request_duration_seconds_*`) | histogram, seconds | method, route pattern, status, route class | every request; buckets 5 ms to 10 s with an edge at 1 s |
| `questify.log.events` (`questify_log_events_total`) | counter | event, level | every log line that names an event: `community.settle_failed`, `push.notice_parked`, ... |
| `questify.outbound.requests` (`questify_outbound_requests_total`) and `.duration` | counter, histogram | operation (`sms`, `email`, `push`), provider, outcome | calls to Msegat, Gmail, Resend, APNs, FCM |
| `questify.tick.runs`, `.duration`, `.last_run` | counter, histogram, gauge | loop, outcome | the nine background loops: `lifecycle`, `community`, `souvenir`, `invitation`, `rank_push`, `organizer_alerts`, `team_alerts`, `ranking_repair`, `push_worker` |
| `questify.db.pool.connections` (`questify_db_pool_connections`) | gauge | pool (`api`, `push`), state (`total`, `idle`, `waiting`) | connections held and clients waiting |

Route class `completion` is the four scan routes: `POST /v1/quests/:questId/complete`, `POST /v1/taps`, `POST /v1/operator/scan`,
`POST /v1/device/kiosk-scans`. A new route that confirms a scan joins `COMPLETION_ROUTES` in `apps/api/src/telemetry/http.ts`.

Traces: one server span per request, one span per outside call and one per background run, linked as parent and child. A fraction is kept
(`TELEMETRY_TRACE_RATIO`, 0.1 by default, 0 with `otlp`); metrics count every request. Logs stay JSON on standard output and carry `trace_id` and
`span_id` inside a request or a run, so a log line finds its trace. A request's incoming `traceparent` header is ignored.

Cardinality: about 600 route patterns times a few statuses; the label values are fixed lists or code constants, so the series count
cannot be raised from outside (an unknown path is `unmatched`).

## 4. What is never recorded

Telemetry holds no personal data (rules.md hard rule 3; SECURITY.md V16). By construction, not by care:

- An attribute must be on a closed list with a value shape (`ATTRIBUTE_RULES`); anything else is dropped at the door. No attribute takes
  free text, so none can hold a username, a phone, an email, an address, a name or a token.
- A request is labelled by its route **pattern** (`/v1/players/:username`), never the URL, the query, a header or a body. An unmatched path is
  `unmatched`, in the span, the metric and the request log.
- No SQL text, no error message, no span event, no exception record, no baggage. The resource is the service name, the build, a random
  instance id and the deployment name; no host or process detector runs.
- The test `apps/api/src/telemetry/pii.test.ts` drives the real server with sentinel usernames, emails, phones, tokens, cookies and
  addresses in paths, queries, headers and bodies (accepted, refused and failing requests, outside providers) and fails if any of them
  appears in a span, a metric or a log line, or if any attribute key is off the list.

Telemetry could therefore leave Saudi Arabia without carrying personal data, but the default is to keep it in the region (Q-560).

## 5. Turning it on

Off by default: with no setting the server installs nothing and sends nothing. Set on the API (CranL secret store for the headers):

| Setting | Meaning |
|---|---|
| `TELEMETRY_EXPORTER` | `off` (default), `otlp` (OTLP/HTTP to Prometheus's receiver), or `console` (development only; refused in production) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | with `otlp`: the receiver's base address (`https://<monitoring app>/api/v1/otlp`), https (http only to localhost), no user, password or query. The API adds `/v1/traces` and `/v1/metrics` |
| `OTEL_EXPORTER_OTLP_HEADERS` | with `otlp`, optional: `authorization=Basic%20<base64 of user:password>,other=value` (values percent-encoded; the RUNBOOK says how to make the credential) |
| `TELEMETRY_TRACE_RATIO` | 0 to 1; default 0.1, but 0 with `TELEMETRY_EXPORTER=otlp` (Prometheus's receiver has no trace endpoint); an explicit value is always used |
| `TELEMETRY_METRIC_INTERVAL_MS` | 5000 to 600000, default 60000; keep it under 120000, or the two loop alerts never fire (they ignore an instance that has not reported for 120 s) |

An export has a 5-second timeout and is dropped on failure; the request path never waits for it. A failing receiver writes one line a
minute to standard error (`telemetry.export_failed`) and nothing else changes. Where the store and the pager live is
Q-560 and Q-561 (decided: one CranL app in `riyadh-1`, ADR-626, alerts by email once a sender exists); its files are `ops/monitoring/stack/` and RUNBOOK "Monitoring stack on CranL"
(ADR-620 to ADR-626), prepared and not yet created. The dashboard "Questify SLOs" shows the targets of section 1.

## 6. Log inventory: every layer (T-810; ASVS V16.1.1)

Read from the code and `ops/` on 2026-11-06. Section 3 is the metric catalog and section 4 what telemetry never holds;
this section lists every place something is recorded, with who can read it and how long it is kept. "Not set" means the
repository sets no period and the owner of the store is CranL or a provider, not Questify. Logs go to standard output
only (`docs/QUALITY_BASELINE.md` §4); nothing copies them to another store (Q-664).

| Layer | What it records | Format | Where it is stored | Who can read it | How long it is kept | Source |
|---|---|---|---|---|---|---|
| CranL edge, in front of the web and API apps | Each request with the client address | CranL's own | CranL | CranL, and the members of the CranL project; exactly who is unconfirmed (Q-664) | Not set; unknown (Q-443) | RUNBOOK `QuestifySignInThrottleSpike` ("find its address in CranL's edge log") |
| Web app (Next.js server, `questify-web`) | One warning when the event words cannot be read: the event id and the status, never a person. The repository sets up no request log of its own; the framework writes its own start-up and error output | Text lines | Standard output of the web app, in CranL's log view | As the edge | Not set; unknown (Q-443) | `apps/web/src/lib/event-terms.ts` |
| API request log | One line per request: method, path with the query dropped, status, request id, and `trace_id` and `span_id` inside a request or a run. A path no route answers is written `unmatched`; `/v1/players/:username` and `/v1/me/blocks/:username` are written as patterns. Never the client address, a body, or the values of `authorization`, `cookie`, `idempotency-key` and `set-cookie` | JSON lines (pino), UTC time in milliseconds; level `info` in production, `debug` elsewhere | Standard output of the API app, in CranL's log view | As the edge | Not set; unknown (Q-443) | `apps/api/src/app.ts` (`loggerOptions`), `apps/api/src/app.test.ts`, `apps/api/src/telemetry/logs.ts` |
| API event lines | A line that names an `event`, with ids, reasons and counts: sign-in, sign-up and reset steps and their throttles (`staff.*`, `player.*`, with a keyed 12-character tag of the client address and the user or player id when known); refused access (`authz.denied`: method, route pattern, status, code, actor kind and id); refused scans (`quest.refused`, with the reason); device alarms (`device.*`, `kiosk.*`); reward code faults (`reward.code_unreadable`, ids only); provider failures; background loop failures (`event.*`, `community.*`, `push.*`, `ranking.*`, `ticket.*` and the others in `apps/api/src`); `player.deleted` (the player id); `review_demo.code_guessing`; `telemetry.export_failed`. Never an email, a phone number, the address itself, a password, a code or a token. Every named event is also counted (`questify_log_events_total`, section 3) | The same JSON lines | The same | The same | Not set; unknown (Q-443). The store must keep `player.deleted` lines at least as long as the oldest backup, because a restore re-applies erasures from them (RUNBOOK "Re-apply erasures after a restore") | `docs/SECURITY.md` ("Staff sign-in controls", V16 row), RUNBOOK ("Staff sign-in", "Player sign-in and SMS"), `apps/api/test/auth/edges.int.test.ts` |
| Metrics and traces (section 3) | Counts and durations with the closed attribute list; traces are not exported with `otlp` (ratio 0) | OTLP over HTTPS | The monitoring app's Prometheus on its `/data` volume | Holders of `METRICS_PASSWORD` and the Grafana `admin` | 30 days, capped at 4 GB; no backup (RUNBOOK "Retention and backups"). RUNBOOK records the monitoring app as prepared and not yet created; STATE.md says whether an environment has one. Without it the exporter drops its data and writes `telemetry.export_failed` once a minute | Sections 3 and 5 |
| Monitoring app's own output (Caddy, Prometheus, Alertmanager, Grafana) | Start-up, errors, failed alert mail (`Notify attempt failed`), `alert email off: no ALERT_SMTP_HOST`; Alertmanager silences | Text lines | Standard output of the monitoring app; silences on its volume | CranL project members | Not set (Q-443); Grafana keeps nothing between deploys | RUNBOOK "Monitoring stack on CranL" |
| PostgreSQL server log (CranL's) | Statements and their parameters are not logged: `log_statement` none, `log_min_duration_statement` -1, `log_parameter_max_length_on_error` 0 (read 2026-10-23) | CranL's own | CranL | CranL | Not set; unknown (Q-443) | RUNBOOK "Database and deploy" (the location switch) |
| `audit_log` table | Every state-changing call by staff, an admin or the system, written in the same transaction as the change: actor, action, target, organizer, event, the keys that changed before and after, request id, a time set by the database. Also a platform admin's reads of players, staff emails, sessions, organizers and tickets (ids only), support views (`support.viewed`, one per minute), sign-in success and session end. Never a secret, an email, a phone number, an address or a user agent (refused in code by key name). Failed sign-ins are in the server log, not here | Rows; append-only for every role, the owner included | PostgreSQL (CranL, `riyadh-1`), so backups hold it | The database owner connection; an organizer reads its own entries within its event limit; a platform admin reads all | No purge exists, so it is kept; a period waits for counsel (Q-084, Q-075) | `docs/DATA_MODEL.md` ("flag, ticket, audit_log"), `docs/SECURITY.md` ("Audit log (T-004)"), RUNBOOK ("Audit log") |
| Points ledger and operator records | `ledger_entry`: every change of points, with the actor kind and, for an operator's scan or award, the operator id. Operators are players and `audit_log` has no player actor, so their reviews and answers carry `reviewed_by_operator`, `answered_by_operator` and the like on the row they change | Rows; the ledger is append-only for every role | PostgreSQL | The player their own; the event's team within its limit; a platform admin through the console | With the event's data (Q-075); the ledger stays after an erasure and names no one | `docs/SECURITY.md` ("Points ledger and completions", "Audit log (T-004)") |
| Command-line tools (`migrate.cjs`, `staff.cjs`, `reward-codes.cjs`) | What they did, as counts and ids; a migration retry writes the file, the SQLSTATE and the attempt. Never a password, code or secret. Commands that change accounts or codes also write an `audit_log` entry (`staff.create`, `staff.invite`, `staff.platform_role`, `reward.codes.reseal`) | Text lines | The terminal of the CranL run session | The operator | Not stored | RUNBOOK ("Staff sign-in", "Database and deploy") |
| Providers: Msegat, Gmail, Resend, APNs, FCM | What was sent to them: the SMS number and text (the text carries the sign-in code), the email address and text, a device token and a fixed push text | Each provider's own | Each provider's own account | The people who hold those accounts | Each provider's own; neither set nor read by Questify | `docs/INTEGRATIONS.md` ("Personal data crosses?"), `docs/legal/` (sub-processors) |
| CI (GitHub Actions) | Test, build and audit output; a Playwright report on failure. CI runs against a throwaway PostgreSQL container and holds no Questify secret | Text logs, artifacts | GitHub | The repository's collaborators | GitHub's own setting; artifacts 5 days (14 for mutation reports) | `.github/workflows/ci.yml`, `full.yml`, `mutation.yml` |

**Not built.** An error tracker (INTEGRATIONS "Error tracking", status Open; the alerts on error events come from the
counted log lines above), shipping log lines to a store apart from the API host so a breached host cannot rewrite them
(Q-664), and any log-retention setting of Questify's own for the CranL rows (Q-443). ASVS V16.4.2 and V16.4.3 stay
Partly for that reason.
