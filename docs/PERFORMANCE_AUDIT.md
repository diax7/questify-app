# Performance audit checklist

Dhia's performance rules (2026-11-06, `docs/INBOX.md`). Use them in two ways:

- **While building:** apply the rule that fits the work in hand (a new list gets pagination, a new image gets a real
  size). No separate task is needed for that.
- **Before launch:** run the whole audit as task T-813, once the features stop changing. It covers the player app, the
  organizer dashboard and the Questify console.

## Ground rules

Inspect the code, architecture, tests and deployment first. Keep all observable behaviour, functionality, data integrity
and accessibility, and make no unrelated changes. Write down each tradeoff. Ask before a risky database migration or a
production change. Say why an item is skipped. **Every performance claim needs a measurement behind it.**

## The twelve items, in order

| # | Item | Rule | In Questify |
|---|---|---|---|
| 1 | Indexes and queries | Find slow queries. Index columns used in WHERE, JOIN and ORDER BY, weighing composite indexes and write overhead. Validate with query plans. Give safe migration scripts. | PostgreSQL with `EXPLAIN`. Hot-path limits are in ADR-734 and T-804. |
| 2 | N+1 queries | Find N+1 patterns and fetch related data in one request with joins or nested selects. Do not assume an ORM's includes run as one query. | Plain SQL over `pg`, no ORM and no Supabase, so this means joins and set-returning functions. |
| 3 | Selective fetching | Fetch only the columns each operation needs, without dropping any it uses. | Applies to API reads and SQL functions. |
| 4 | Pagination | Paginate large sets with a stable ORDER BY and a tie-breaker. | Applies. `docs/rules.md` also says to order by the table's column, never a text cast of it. |
| 5 | Images | Use WebP or AVIF where it fits, correctly sized and responsive, with fallbacks. | Applies to shipped art now; uploads wait on photo storage (Q-149). |
| 6 | Loading strategy | Lazy-load only media below the fold. Never delay the first viewport or the LCP image. | Applies to the web app; the phone app's lists have their own equivalent. |
| 7 | CDN and caching | Serve static assets through a CDN with long-lived headers for immutable files, and invalidate dynamic content precisely. | Check what CranL offers in `riyadh-1` first; personal data stays in Saudi Arabia. |
| 8 | Parallel work | Run independent async requests at once where dependencies and error handling allow. | Applies to pages and app screens that read several things. |
| 9 | Loading states | Show skeletons for operations over one second. No flash on fast answers, and no faked speed. | Applies to the app, dashboard and console. |
| 10 | Optimistic updates | Only for low-risk actions, with a visible pending state and automatic rollback on failure. | Never for points, redemptions or admin powers. |
| 11 | AI streaming | Stream AI responses where supported. This improves perceived latency, not total generation time. | **Not applicable today:** no AI feature exists (checked 2026-11-06). |
| 12 | Measurement | Benchmark before and after in Chrome DevTools with Slow 4G and 4x CPU throttling on identical routes, plus a real low-end phone when possible. Record exact values, conditions and limits. Report missing baselines rather than estimating. | Keep results with the audit. Server timing uses `ops/load/` (T-804). |

## What the audit reports

Run all existing test suites. Then report: the optimizations applied, the files and migrations changed, the checks run,
before-and-after metrics with their conditions, the remaining risks, and anything skipped or not measurable.
