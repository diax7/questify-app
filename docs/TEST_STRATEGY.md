# Test Strategy — Questify

> How correctness is verified, sized to the stakes. Drafted in Stage 8, 2026-10-17. Quality bar:
> Max on the core, Standard elsewhere (ADR-104, `rules.md`). Last updated: 2026-10-17.

The stakes: personal data of the public, prizes with real value, live events where an outage is public,
and a points record that must be trusted. So the core gets more levels of testing, and the rest gets
the standard set.

## Levels

| Level | Covers | Tooling |
|---|---|---|
| Unit | Rules in pure functions: tie-breaking, XP once per quest, caps, reservation expiry, code signing, config merge, placeholder protection | `vitest` |
| Integration | Server modules against a real PostgreSQL and Redis-compatible store: the completion transaction, ledger append-only, row-level security, idempotency, ranking rebuild, jobs | `vitest` with disposable databases |
| Outsider suite | What a stranger holding only the public credential can do: nothing | `vitest` against a running API |
| Cross-tenant suite | An editor, operator or player of organizer A against every organizer B route and object | `vitest`, generated from the route list |
| Web end-to-end | Dashboard and console flows, event page, big screen, in Arabic and English | Playwright |
| App flows | Join, sign-in, scan, reserve, hand over, language switch and RTL on real phones | An open-source mobile flow-test tool (confirm the current choice when installing) plus manual device passes |
| Property tests | Mini-game replay checker, username and word filters, config schema merging | `fast-check` with `vitest` |
| Load | 20,000 completions per minute per event; ten events together; push of 50,000 | An open-source load tool (confirm when installing) |
| Recovery drill | Restore to 5 minutes earlier; failover to the second Saudi region | Scripted runbook |

## Must be tested

- **Critical paths:** sign-in; join; scan a quest and see points and rank; reserve and collect a prize;
  operator scan of My QR; prize desk hand-over; rank prizes; account deletion.
- **Error paths (what users see when things fail):** wrong or expired code; SMS not arriving (email
  fallback after 30 s); duplicate scan; expired or regenerated QR; paused or closed event; reward out of
  stock; poor connection during a mini-game (result retry); server busy (429 with a retry message);
  maintenance mode; app too old (426); unreadable configuration (last-working copy).
- **Authorization:** each role sees and changes only what it may (`SECURITY.md` matrix); an operator
  cannot act outside abilities or booth; editors limited to chosen events; sponsors have no access;
  admin reads are logged.
- **Money-like integrity:** score and balance equal the sum of the ledger; removing an award adjusts the
  balance legally; nothing in the ledger can be edited; XP is given once per quest and never spent.
- **Language:** every screen in Arabic and English, mirrored layouts, Western digits, renamed words in
  singular and plural.
- **Compliance:** the demo-only login works only in the demo tenant (NFR-017); every feature is on in the
  review build (NFR-022); no personal data in logs.

## CI gates (block a merge)

1. Lint, format and type checks clean with zero warnings.
2. Unit, integration, outsider and cross-tenant suites pass.
3. Secret scan and dependency audit (at moderate level) pass.
4. Build succeeds for `api`, `web` and the app's JavaScript bundle.
5. Playwright smoke flow passes on pull requests that touch `web`; the full end-to-end set and app flows run
   locally before a release (`ci:full`).

Heavy checks (load, recovery drills, real-device runs, Lighthouse-type checks) are run by hand or on a
schedule, not on every pull request.

### T-502 announcement evidence (2026-10-29)

Unit: shared announcements (all four fields, clean-up, code-point cut/bounds and all filter issues), push templates
(safe fallback/no push for invalid frozen copy), web announcement draft/time conversion, app member DTO and
happeningNow (full flash/boost duration, deduplicated boosts, expiry). DB: announcements.int covers replay, rolling
windows, concurrent last-slot presses, state/clock rechecks, cancel races, immutability, every role/audience,
rehearsal, mute and table-by-table channel footprint. HTTP: test/announcements/routes.int covers compose/read,
schedule/cancel, every filter per field, extra channels, refusals, unavailable kind, roles and revoked-scope replay.
Outsider/cross-tenant/route inventories include the table and all five doors. rehearsal's status guard allows the two
new volatile writers: announcement_send and push_due_announcement; announcement_phase itself is STABLE, not a third
volatile writer. Browser announcements.spec covers English/Arabic RTL, bilingual previews, validation, event-zone
schedule, cancellation and send-now on desktop and phone. The full browser suite runs after a fresh web build.
Timing: PUSH_TIMING=<local-log> with test/perf/push-announcement-timing.int.test.ts seeds 50,000 members/devices and an
exclusion entry; count 732 ms, press 337 ms, slowest fan-out 430 ms; both call/statement gates pass. No mutation needed
for tier B (ADR-355). Real phone checks and the push go-live checklist remain release gates, not simulated delivery.
