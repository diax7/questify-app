# Quality and Security Baseline — Questify

> The standards every phase and release is checked against. Written 2026-10-19 (ADR-108). It sets the
> bar; `rules.md` says how code is written; `TASKS.md` holds the work. Tool versions are looked up at
> install time. Sources are named so nothing here rests on memory.

## How it is used

1. **Per change:** the Definition of Done in `rules.md` plus the "every change" gates below.
2. **Per phase:** the "phase gate" list runs before a phase is called done.
3. **Before launch:** the "release gate" list, including an independent penetration test.
4. Anything we decide not to meet is written down with a reason (ADR) and an owner. Nothing is skipped silently.

## 1. Security (OWASP)

| Standard | What it covers | Our target |
|---|---|---|
| **OWASP ASVS 5.0** (May 2025) | Security requirements for web apps and APIs, in three levels: L1 about 20% of requirements, L2 about 70% in total (L1 + L2), L3 the rest | **L2 for the core**: ledger and points, sign-in and sessions, tenant isolation, prize handover, wallet signing, admin powers. **L1 for everything else.** Revisit after the first events |
| **OWASP MASVS** (mobile) | Eight control groups: STORAGE, CRYPTO, AUTH, NETWORK, PLATFORM, CODE, RESILIENCE, PRIVACY | Use the MAS L1 profile plus PRIVACY; no RESILIENCE (anti-tamper) targets in v1. MASVS covers only the app; the server is checked against ASVS |
| **OWASP Top 10** | The most common web risks | Used as a review checklist for every route |
| **Threat model** | STRIDE | `SECURITY.md` (done); revisit each phase for new trust boundaries |
| **Independent penetration test** | An outside tester with open-book access, against ASVS L2 (core) and MASVS L1 | Before the first public event (T-809). OWASP states a tool run alone is not enough evidence |

Evidence for each ASVS/MASVS control is a test, a CI check or a short written note, listed in a verification sheet that T-810 builds.

## 2. Code quality

- Strict TypeScript, linter and formatter with zero warnings (`rules.md`).
- Small changes merged often; every change reviewed (a second read for the core, ADR-104).
- Functions short and simple (100 lines, complexity 8); absolute imports; no dead code.
- Every design choice that is hard to reverse is an ADR before code is written.
- Dependencies: justified, current, licensed; lockfile committed; audit on every change.

## 3. Tests

- **Pyramid:** many fast unit tests, fewer integration tests against a real PostgreSQL and cache, a few end-to-end flows.
- **Core extras:** property tests (mini-game replay checker, username and word filters, configuration merge); **mutation testing on the core** (for example Stryker) so the tests are proven to catch real breakage; contract tests against the generated OpenAPI file.
  Mutation scope today (`stryker.config.json`): `apps/api/src/{audit,auth,db,organizers,events,quests,completions,
  players,join,moderation}`, the conventions, idempotency and route-access modules, `packages/shared/src/{quests,
  players,time,join}`, and the app's session core `apps/app/src/api/{client,session}.ts` (T-111 app half) (target 90%,
  break 80%).
- **Security tests:** the outsider suite and the cross-tenant suite on every pull request.
- **Non-functional:** a load test (for example k6) at 20,000 completions per minute per event before launch (NFR-003); a restore rehearsal (NFR-026); a failover drill.
- **Mobile:** flow tests on real iPhone and Android devices, Arabic and English, RTL.
- Coverage is a signal, not a goal; the core must have meaningful tests and passing mutation checks.
- Mutation scope (**core only**, user decision 2026-10-19, ADR-111): sign-in and sessions (`apps/api/src/auth`), the database helpers that carry tenant isolation (`apps/api/src/db`), the API conventions and idempotency (`conventions.ts`, `idempotency-store.ts`), and route access (`route-access.ts`), and the organizer team and sign-up (`apps/api/src/organizers`, T-101); the ledger, prize handover, wallet signing and signed QR/NFC proofs join as they are built. Everything else is covered by ordinary tests. The run fails below 80%; the target for core files is 90%. **Where it runs (ADR-174, 2026-10-24):** only on GitHub (`mutation.yml`), never on the developer PC (about 18 GB, it can crash it); one run per batch of 2 or 3 core tasks, scoped to the core files those tasks changed; survivors are chased only while a file is under 90%. The pull-request gate (`ci:changed`) runs lint, the function-limit ratchet (`pnpm lint:limits`, T-023), format, types and all tests.

## 4. Infrastructure and operations

- **Everything by script:** environments, databases, buckets and settings are created through the CranL CLI or API and kept in the repository, so a new environment can be rebuilt (T-017). No hand-made settings.
- **12-factor basics:** configuration in environment variables, one build for all environments, logs to standard output, stateless app servers.
- **Staging mirrors production** (same region, same services, fake data).
- **Backups:** automatic backups on the host plus our own nightly copy to a second place in Saudi Arabia that we control (ADR-107, T-019). A backup that has not been restored is not a backup: restore rehearsal before launch (T-805).
- **Secrets:** in the host's secret store; rotated on a schedule and when someone leaves; secret scan on every change.
- **Observability:** structured logs without personal data, metrics and traces through OpenTelemetry (T-018).
- **Service levels:** written targets (99.9% availability, completion confirmed within 1 s for 95%, ranking within 5 s, 5-minute data loss, 1-hour recovery; ADR-074, ADR-082) with alerts and a runbook for each alert (T-018).
- **Incidents:** a short written post-mortem for every outage, with fixes added to `TASKS.md`.
- **Supply chain:** pinned CI actions, least-privilege CI permissions, a software bill of materials (SBOM) produced at release, build provenance where the platform offers it.

## 5. Privacy and compliance

- Saudi PDPL, the data map (NFR-020), retention periods once counsel answers (Q-075), and the store rules in `STORE_COMPLIANCE.md` as a gate.
- No personal data in logs, error reports or push text (rule 3).
- The lawyer batch (T-807) happens before launch; items the user stated as "yes" without checking stay marked unverified until then.

## 6. Delivery health (measured, not worshipped)

Track the four standard delivery measures (change lead time, deploy frequency, change failure rate, time to restore). They show whether the process is working; they are not targets to game.

## Gates

**Every change:** lint, format, types clean; unit, integration, outsider and cross-tenant suites pass; secret scan and dependency audit pass; docs and ADRs updated; no personal data in logs.

**Phase gate:** phase tasks done with their done-conditions; ASVS/MASVS controls touched by the phase have evidence; mutation checks pass on the core code added; runbook entries added for new alerts; `TASKS.md` ticked; a short review by `cto-cycle` for core phases.

**Release gate (before real players):** load test passed; restore rehearsal passed (T-805); independent penetration test done and its findings fixed or accepted in writing (T-809); ASVS L2 verification sheet complete for the core (T-810); CranL written answers received or production moved (T-811); counsel batch answered or the open items accepted in writing (T-807); both stores' requirements met; second backup copy proven.
