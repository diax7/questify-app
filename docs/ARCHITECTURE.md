# Architecture — Questify

> How the system is structured and how data flows. Stage 6, 2026-10-17. Accepted with ADR-101 and
> ADR-102 (2026-10-17).

## Overview

Questify is a **modular monolith**: one deployable server application split into clean modules,
talking to one PostgreSQL database and one Redis-compatible store, with a thin set of worker
processes started from the same code. Three kinds of client call it: the player app (Expo, iOS,
Android and a web bonus), the web app (event page, station page, big screen, organizer dashboard,
Questify console) and wallet/push providers calling back.

Why this fits: one developer needs one thing to run and debug. The hardest load is a burst of about
330 quest completions a second, which a single well-built server with PostgreSQL absorbs. Separate
services would add network failures and deployment work for scale that may never arrive. The module
borders below are where a split would happen if the numbers ever demand it.

## Components

```mermaid
graph TD
  App[Player app - Expo] --> API[API server - Fastify]
  Web[Web app - Next.js: event page, dashboard, console, big screen] --> API
  Wallet[Apple / Google Wallet] --> API
  API --> DB[(PostgreSQL - Saudi region)]
  API --> Cache[(Redis-compatible: rankings, rate limits)]
  API --> Files[(Object storage - Saudi region)]
  Worker[Workers - jobs from PostgreSQL] --> DB
  Worker --> Cache
  Worker --> SMS[Saudi SMS gateway]
  Worker --> Email[Email provider]
  Worker --> Push[APNs / FCM]
  API --> Attest[App Attest / Play Integrity]
```

| Component | Responsibility | Interface | Depends on |
|---|---|---|---|
| Player app | All player and operator screens; scanning; mini-games; keeps the last working configuration | HTTPS JSON `/v1`, server-sent events for live updates | API |
| Web app | Event page, station (rotating QR) page, big screen, deletion page, organizer dashboard, Questify console | Same API; staff cookie session | API |
| API server | Authentication, authorization, all rules; the modules below | REST `/v1`, event stream | PostgreSQL, Redis, storage |
| Workers | Sends SMS, email, push; scheduled jobs (daily word, reports, reservation expiry, flag checks); wallet pass updates | pg-boss queues in PostgreSQL | PostgreSQL, providers |
| PostgreSQL | The only source of truth, including the append-only points record | SQL | none |
| Redis-compatible store | Live rankings, rate limits, short-lived login/QR windows. **Rebuildable** from PostgreSQL | Redis protocol | none |
| Object storage | Photos, organizer art, exports | Signed URLs | none |
| Providers | SMS, email, push, wallet, device integrity | See `INTEGRATIONS.md` | none |

### Modules inside the API server

| Module | Owns |
|---|---|
| identity | Players, staff users, login codes, sessions, devices, bans, deletion |
| tenancy | Organizers, members, events, activation, limits, add-ons |
| config | Platform settings, event configuration, feature switches, translations (see `CONFIGURABILITY.md`) |
| quests | Categories, quests, quest types, schedules, community goals, polls, sessions (agenda) |
| verification | Quest QR codes, My QR, NFC tags, operator scans, kiosk, mini-game rounds, flags |
| ledger | The points record (event layer) and Questify XP/gems (Questify layer) |
| ranking | Scores to ranks, ties, seasons, big-screen scenes |
| rewards | Shop, reservations, uploaded codes, prize desk, handover |
| notifications | Templates, push/SMS/email, campaigns, notification center, consent checks |
| content | Announcements, maps, sponsors, surveys, daily word and bank |
| reporting | Participation analytics, exports, one-page report |
| admin | Console tools, player lookup, legal documents, health |
| audit | Append-only action logs (who, what, when) |
| wallet | Pass generation, signing, update notifications |

Rule: a module talks to another only through its exported functions, never into its tables. This
keeps the later split cheap.

## Primary flow — a player scans a quest QR

```mermaid
sequenceDiagram
  actor P as Player
  participant A as App
  participant S as API
  participant D as PostgreSQL
  participant R as Redis
  P->>A: scan quest QR
  A->>A: "Scanned! checking..." within 300 ms
  A->>S: POST /v1/quests/{id}/complete (Idempotency-Key, signed code, location)
  S->>S: check session, enrollment, event open, code signature, limits
  S->>D: one transaction: completion + ledger entry + score + XP
  D-->>S: committed
  S->>R: add points to the event ranking
  S-->>A: 200 confirmed (points, new rank)
  A->>P: celebration, coin to balance
  Note over S,A: Rejected: 409 already completed, 403 paused/closed, 422 bad or expired code, 429 busy (retry)
  Note over A,S: Timeout: the app retries with the same Idempotency-Key, so a retry never pays twice
```

1. The app shows the instant "Scanned" beat from local state (NFR-001), then sends the completion.
2. The request carries an idempotency key made on the phone. The server stores it with the
   completion, so a retry after a dropped connection returns the first result.
3. The server checks the QR's signature (a regenerated code makes old ones fail), the player's
   enrollment, the event window, the quest's limits and schedule, and raises flags without
   blocking (ADR-041).
4. One database transaction writes the completion, the append-only ledger entry and the cached
   score/balance, and the Questify XP if it is the player's first completion of that quest. Nothing is
   half-applied.
5. After commit, the ranking store is updated. If that step fails, a job repairs it from the
   ledger; the player still sees the confirmed result, and the rank catches up within the 5-second
   target (NFR-005).
6. A rejected request tells the player why; nothing is stored. Under overload the server answers
   "busy, retry" rather than losing the request (NFR-003).

Other verification paths (operator scans My QR; wallet-pass fixed code; NFC tap; mini-game round
with replay) end in the same `complete` transaction, differing only in the proof checked in step 3.

## Cross-cutting concerns

- **Errors:** one error envelope (`API.md`). Fail fast with a clear message; no silent failures; a
  failed network action is never half-applied (NFR-007, ADR-029).
- **Logging:** structured logs with request id, organizer id and event id; **no personal data in
  logs** (phone, email, free text, photos are never logged). Action logs for people go to the audit
  module, not to log files (NFR-019).
- **Configuration and secrets:** environment variables or the cloud's secret store; never in code
  or git; separate values for development, staging and production. Wallet and signing keys live in
  the secret store with restricted access.
- **Multi-tenancy:** every tenant table has `organizer_id`; row-level security is switched on in
  PostgreSQL as a second wall behind the application checks. Every table and function is closed to
  the public by default and each grant is explicit and tested from an outsider's seat (NFR-016,
  NFR-018).
- **Time:** all times stored in UTC; each event has a time zone and a "day starts at" hour (default
  4 am).
- **Environments:** development, staging (a copy in the Saudi region), production. "Rehearsal mode"
  (ADR-080) and the review demo tenant (ADR-009) are data flags inside production, not separate
  systems.

## Consistency — the three hard cases

| Case | What happens |
|---|---|
| Two scans of the same quest at once | A unique constraint on (enrollment, quest) for one-time quests. The second request returns "already completed" |
| A request dies halfway | There is no halfway: the database transaction either commits everything or nothing. The ranking store is updated after commit and repaired by a job |
| The ranking store is lost | It is rebuilt from the ledger. During the rebuild the app shows the last known ranking |
| The database is restored to 5 minutes earlier | Multi-node PostgreSQL with replicas means a node failure loses nothing; only a logical disaster needs a point-in-time restore, which can lose up to 5 minutes (ADR-082). Players confirmed in that window are told their last minutes were rolled back through a banner; the post-event report notes it. Accepted risk, rehearsed before launch (NFR-026) |
| Two editors change the same record | Last save wins (ADR-088); every change is in the audit log |

## Observability

- Health endpoints for the API, workers and each dependency.
- Alerts (to the on-call phone and email, ADR-079) on: error rate, 95th-percentile completion time
  above 1 second, queue depth, SMS delivery rate falling, database replica lag, ranking staleness
  above 5 seconds, certificate expiry (Apple Pass Type ID, push keys).
- The platform health view in the console (F-291) reads from the same numbers.
- Error tracking must not send personal data abroad: a self-hosted tracker, or a hosted one with
  scrubbing, decided in `INTEGRATIONS.md`.

## Growth path

What changes first if usage grows tenfold: **ranking reads and live-update fan-out** (50,000 phones
asking "where am I" every few seconds). The first answer is caching the top-10 per event and
serving "around me" from Redis; the second is moving live updates into their own small service. The
ranking and notifications modules are built behind exported functions precisely so either can leave
the monolith without touching quest logic. Second bottleneck: sending 50,000 pushes in one
announcement, solved by more worker processes, not a redesign. PostgreSQL read replicas take the
dashboard and report load.

## Grill findings (2026-10-17)

- **Load plan (user: recommended).** A load test at 20,000 completions per minute per event is a
  launch gate (NFR-003). If one primary is too slow, scale the database up first and add read replicas
  for reports; the API answers `429 busy, retry` rather than losing a request. A burst queue or one
  database per event are not built unless the test proves they are needed.
- **Restore story (user: recommended).** After a rare point-in-time restore, players confirmed in the
  lost minutes are told by a banner and the report notes it. Receipt re-sending and a second durable
  log were declined. Node failures lose nothing because of replicas.
- **Riskiest dependency: the SMS gateway.** See `INTEGRATIONS.md`: one gateway at launch (the user
  declined automatic failover to a second one), with the email code as the only fallback.

## Key decisions

ADR-101 (framework, accepted), ADR-102 (technical shape, **one-way doors flagged**: PostgreSQL
with a shared schema and row-level security; TypeScript everywhere), ADR-103 (SMS shortlist),
ADR-086 (reuse), ADR-070 (residency), ADR-082 (capacity and recovery).
