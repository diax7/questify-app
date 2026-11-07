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

## T-813 results

### Part 1: items 1 to 4, the API and SQL (2026-11-07, migrations 0172 to 0175, ADR-816)

Items 5 to 10 are part 2. T-813 stays open until that is in.

**Conditions.** PostgreSQL 17.11, the shared test container: `shared_buffers` 128 MB, `work_mem` 4 MB, `random_page_cost` 4.
The server was in use by other projects and test runs, load average 2.4 to 10. So compare buffers and plan shape; the
milliseconds are only an indication. Two private databases seeded alike, with the migrations through 0171 and then one with
0172 run as written, read by turns; each figure is the second pass, so caches are warm. `EXPLAIN (ANALYZE, BUFFERS)`, with
`TIMING OFF` on single reads. Buffers are `shared hit + read`. Inner plans of functions came from `auto_explain` in one session.
Faked data, generated in sets with triggers off: 40 events (one of 100,000 players, 39 of 2,000), 178,000 enrollments, 1,936,398
completions, 2,000,854 ledger rows (19,962 removals, 44,494 welcomes, 323 rehearsal rows), 1,936,076 XP rows, 1,000,000
audit rows, 600,000 throttle rows, 500,000 invitation rows (100,000 queued), 150,000 notices and notifications, 120,000 push
sends. Rows of real players are not this even, and a real event's history is longer: no figure here predicts production.

**Item 1, indexes and queries. Applied.**

| Read | Before | After | What changed |
|---|---|---|---|
| `member_ledger`, 22 lines of one player (staff) | 2,811,259 buffers, 17.1 s | 3,249 buffers, 59 ms | `ledger_entry_reverses_idx` |
| `manual_awards`, first page | 2,160,935 buffers, 11.9 s | 1,177 buffers, 29 ms | `ledger_entry_reverses_idx` |
| `wipe_rehearsal`, 323 ledger rows | 276.7 s; 968 full table scans, 1.92 billion rows read | 0.27 s; none | the three indexes below |
| `invitation_claim_at`'s read, 100,000 queued in 2 campaigns behind 400,000 finished rows, its first fetch | 1,955 buffers, 13.9 MB sorted on disk, 245 ms | 79 buffers, in memory, 1.3 ms | 0173: `(campaign_id, channel, id)`, read per campaign, locked as fetched |
| The same read inside the function (`auto_explain`) | | 36 buffers for the page | |
| Rows a claim of 5 holds locked (2 campaigns of 200, test database) | 10 | 10 | 0172's first version held 400 |
| A draft of 26 quests deleted (`deleteDraft`) | 7.76 s, the ledger check 7.51 s | 0.23 s | 0174: the ledger's quest key on `(quest_id, event_id)` |
| A category of 10 quests deleted (`deleteQuestsOf`), event of 26,000 ledger rows | 3.13 s | 0.11 s | the same |
| The same, event of 1,100,000 ledger rows | 3.00 s | 2.98 s | none: the check reads that event's rows (Q-753) |
| `data_export_support`'s audit read | 63,713 buffers, parallel scan, 226 ms | 6 buffers, 0.2 ms | `audit_log_player_export_idx` |

- The first two scanned the whole ledger once per EXISTS per line, because `x.reverses = l.id` names no kind and the only
  index on `reverses` was partial on `kind = 'removal'`. No function changed: the new index's predicate is the same rows as
  the old key's (`ledger_entry_removal_shape`), so `session_bulk_targets` and `session_points_held`, which read the same way,
  get it too (inferred from their SQL, not measured).
- The wipe runs on go-live and from the dashboard's erase button. A foreign key's check names no kind, so `ledger_entry.completion_id`,
  `ledger_entry.reverses` and `xp_entry.ledger_entry_id` could not use their partial keys: each deleted row scanned a table.
- **One figure went the wrong way:** `quest_bulk_targets` on a quest with 100,000 credits touches more buffers, 482,919 to 643,699.
  Its generic plan now does 200,000 cached index probes in place of a hash; the time did not move (1.11 s to 1.19 s under this load).
  The same statement run with its values went from 92,801 to 49,664. Left as it is: a rare bulk action.
- **The claim's read (0173).** The first version of 0172 locked each campaign's page inside the read, and the sort above it
  pulled every page before the first row came back: a claim of 5 over two campaigns of 200 locked all 400, a lock written to each
  heap tuple and to WAL on every round, and a wider net for a player erasure (2 s lock_timeout) to wait on. 0173 reads the page with no
  lock and locks rows as the loop fetches them, 10 for a claim of 5, as 0073 did; a page row another session holds is skipped, not
  waited on (both in `performance-indexes.int.test.ts`). The page bounds `campaign_id` by a range: with `=`, the planner walked the
  primary key past the 400,000 finished rows (14,582 buffers) whenever it read the visibility map as unset, and `channel` is in the key
  so the page is read from the index alone. The 431 and 209 buffers first recorded here were that first version on the first seed.
- **Quest deletes (0174, 0175).** Each quest deleted runs the ledger's foreign-key check once, so a delete costs one check times its
  quests. On `quest_id` alone the check scanned the ledger, 290 ms a quest at 2.1 million rows. On `(quest_id, event_id)` it reads
  `ledger_entry_event_idx` for that event only, with no new index: 5.2 ms for 26 draft quests, 87 ms for 10 quests of a 26,000-row
  event, but 2,961 ms for 10 of the 1.1-million-row event (480 ms and 28,441 buffers for one quest read cold). Measured on a second seed
  of the same shape (2,114,000 ledger rows, 1,936,000 completions; E0 100,000 players and 1,100,000 ledger rows), by
  `EXPLAIN (ANALYZE, BUFFERS)` in a rolled-back transaction, second run. `VALIDATE` took 0.72 s under SHARE UPDATE EXCLUSIVE.
- **Other foreign keys on `quest`.** Each quest delete checks 26 more tables. Every one but three has a full index led by its quest
  column (`quest_completion`, `quiz_attempt`, `quest_vote`, `submission`, `survey_response`, `game_round`, `meeting`,
  `passport_stamp`, `quest_points_change`, `ticket` and the rest, some partial on `IS NOT NULL`, which the check can use) or by
  `event_id` (`bulk_award`). Without one: `meet_pass` (CASCADE; indexes lead by `enrollment_id`, `token_hash`, `id`),
  `souvenir_target` (NO ACTION; its key is `(rule_id, quest_id)`) and `nfc_tag` (RESTRICT; both quest and event indexes are partial on
  `status = 'active'`, though `quest_delete_nfc_tags` deletes a quest's tags first). All three already key on `(quest_id,
  event_id)`, so the 0174 change has nothing to give; only a new index would, with a write cost. Not changed and not measured at
  size: the seed holds none of their rows.
- **Migration safety.** The runner holds each file in one transaction, so `CREATE INDEX CONCURRENTLY` cannot run (ADR-580). 0172
  does what 0162 does: `lock_timeout` 10 s, every table locked up front in one order. The whole file took 2.9 s on the data above
  (with the invitation index then still in it), 1.15 s of it the largest index. For that time writers to `ledger_entry`, `xp_entry`
  and `audit_log` are stopped: an API writer waits its 2 s `lock_timeout` and fails with 55P03, and every audited write fails
  because `audit_log` is locked SHARE. Safe on staging; production needs a quiet window. 0173 holds `invitation_recipient` ACCESS
  EXCLUSIVE for one small rebuild, 0174 holds `quest` and `ledger_entry` ACCESS EXCLUSIVE for two catalog changes, and 0175 lets
  reads and writes through.

**Item 1, write cost.** Bulk inserts of 20,000 rows with triggers off, rolled back, old and new by turns:

| Table, rows | Buffers | WAL records | WAL bytes |
|---|---|---|---|
| `ledger_entry`, quest | 259,000 to 319,000 (+23%) | 101,800 to 122,000 (+20%) | 10.4 to 12.0 MB (+15%) |
| `xp_entry`, quest | 395,000 to 455,000 (+15%) | 161,700 to 182,000 (+13%) | 14.0 to 16.5 MB (+18%) |
| `audit_log`, an action outside the new index | 61,000, no change | 40,661, no change | 3.6 MB, no change |

So a quest row costs one more index entry on each of the two tables: about 3 buffers and 80 to 125 bytes of WAL. A completion also
writes other rows, so the gate is the number that counts. `node ops/load/profile.mjs --big-event-players 50000` (ADR-734), 2,000
first completions, old, new, old, new: **10.16, 10.51, 9.68, 9.27 ms** of database time a completion, so 9.92 and 9.89 on average. The
difference between runs is larger than the difference between schemas, on this server. New index sizes at these rows:
`ledger_entry_completion_idx` 42 MB, `xp_entry_ledger_idx` 41 MB, `audit_log_player_export_idx` 8.7 MB, `ledger_entry_reverses_idx`
0.5 MB, `invitation_recipient_queued` 4 MB after its rebuild. The ledger's other 25 indexes hold 188 MB. ADR-816 has the tradeoff.

**Item 1, insert cost of the three T-617 partial indexes (2026-11-07, FOLLOWUPS batch 21).** Migration 0111's
`ledger_entry_operator_event_idx`, `submission_operator_reviewed_idx` and `ticket_operator_answered_idx`, each on its table at the
size the T-617 timing used (150,000 operator ledger entries, 6,000 reviews, 2,000 answers, 20,000 enrollments, 20 operators;
vacuumed). The shared test PostgreSQL on port 55432, a private database through `questifyFixture`, triggers on. One statement per
measure, 1,000 rows, `EXPLAIN (ANALYZE, BUFFERS)` inside a transaction that is rolled back, with the index and with the index dropped
in that transaction, two passes. Buffers are `shared hit` of the whole statement, source rows and triggers included:

| Index | With | Without | Difference | Per row |
|---|---|---|---|---|
| `ledger_entry_operator_event_idx`, award rows | 33,801 and 36,605 | 33,412 and 33,766 | +389 and +2,839 | about 0.4 to 2.8 (+1% to +8%) |
| `submission_operator_reviewed_idx`, reviews | 14,790 and 15,720 | 13,509 and 13,692 | +1,281 and +2,028 | about 1.3 to 2.0 (+9% to +15%) |
| `ticket_operator_answered_idx`, answers | 22,795 and 22,732 | 20,729 and 20,701 | +2,066 and +2,031 | about 2.0 (+10%) |

Pages dirtied and written differed by at most 17, in either direction, so the index adds no pages to flush at this size. Read: an
operator row costs one more tree descent, about two buffers, and the two small tables show it steadily; the ledger figure is noisy
because its statement is dominated by its own triggers and the descent lands on a different leaf each pass. A row with no operator
is outside every predicate, so it writes no entry: only the submission case was run (10,287 and 10,326 buffers), the ledger and
ticket rows with no operator could not be built under their shape checks without more fixture. Milliseconds were not recorded: the
server was shared. A by-hand measurement, not a CI test; the script is not kept.

**Item 1, measured and left.**

- **`ledger_entry (quest_id)`: built, measured, taken out.** On the first seed, deleting one quest nobody played scanned the ledger
  once for the foreign key: about 2,000,000 rows, 280 to 350 ms, against 28 ms with the index. That figure is per quest, and a draft
  or category delete removes many (above): 0174 took the no-write-cost part of the cure, and the index stays out because it would
  cost every quest row one more entry while helping only deletes in the largest events. It did nothing for `delete_played_quest`
  (43,000 buffers either way, as that quest's rows fill the heap). Q-753 asks when to revisit.
- **Throttle sweep:** 6,187 pages per run, at most once in 10 minutes and only on a staff sign-in. An index on `at` would add a
  write to every attempt during a sign-in rush, so no.
- **Control room and analytics, on the 100,000-player event:** `control_done` 1,531 buffers, `control_counts` 13,899,
  `analytics_quests` 88,105, `analytics_participation` 404,844 (947 ms). Each is bounded by one event and already reads by index.
  Nothing was changed: a cheaper answer needs stored counters, a behaviour change this task rules out.
- **Already good, no change:** `console_player_ledger` 9 buffers, `awarded_today` 67, `control_feed` 320, `member_activity` 176,
  `own_notifications` 452.

**Item 2, N+1 queries. Nothing to apply.** Routes reach PostgreSQL through set-returning doors, so a loop over a query is rare. The
loops in `apps/api/src` (`quests/store.ts`, `join/setup.ts`, `change-sets/store.ts`, `privacy/reapply.ts`, `deletion/deletion.ts`) are
small ordered writes over a form's rows, one call per due event in a tick, or a two-item retry. `member_event_quests` calls helpers per quest, which is the shape to look at: 3,020 buffers,
63 ms for 60 quests and a player with 22 lines. Those helpers hold the category, boost and lock rules, so merging them risks
behaviour for a read that is not slow. The per-line scans above were the real N+1, and an index cured them.

**Item 3, selective fetching. Nothing to apply.** `SELECT *` in `apps/api/src` reads a door's declared columns, not a table.
`SELECT x.*` inside a sub-select costs nothing: on `console_player_legal` and `console_player_ledger`, `EXPLAIN VERBOSE` shows the
planner replacing unused columns with NULL, so the sort carries none of `before`, `after` or the rest. Whole-row reads into PL/pgSQL
variables are passed on to functions that take the row type, so narrowing them means changing those signatures with no number to
justify it.

**Item 4, pagination. One tie-breaker applied.** Every paged list orders by a unique key or ends in `id`, and page sizes are clamped.
`readOwnerOthers` (`ORDER BY lower(o.name) LIMIT 50`) now ends in `o.id`, so two organizers of one name cannot swap at the
limit. Left: `console_player_record` and `console_report` take one row by a timestamp, so a tie needs two rows of one target
in one microsecond, and restating either function is not worth that. `export_players` answers all 100,000 rows at once (8,146
buffers, 1.5 s, 13 MB spilled to disk): it is a download of the whole list, not a page.

**Tests.** New `apps/api/test/db/performance-indexes.int.test.ts` (8): each read reaches its index, the ledger's quest key is the
validated composite RESTRICT key and its check reads `ledger_entry_event_idx`, the claim keeps its campaign and row order, a claim of 5
left open holds at most 10 rows, and a row another session holds is skipped without waiting. The `readOwnerOthers` tie-breaker has no
test: the read returns names only, so two organizers of one name give the same answer in either order. With `apps/api/test/security` and the touched suites: 1,284 passed in 35 files. `pg_get_functiondef` before and after 0173
differs in `invitation_claim_at`'s one statement, and its grants are unchanged.

## T-813 results, part 2 (items 5 to 12; apps/web and apps/app)

2026-11-07. Items 1 to 4 (apps/api and migrations) are reported by the other worker under "T-813 results". Conditions of every
number below: this shared PC (12 cores, load average about 2.7 while measuring), Next 16.4.3 (Turbopack) and Expo SDK 57, the
tree at commit 2a30776c plus this change. The numbers are byte sizes, request counts and bundle sizes, which do not move with
the load; no timing is claimed except the one named under item 9.

| # | Item | Result |
|---|---|---|
| 5 | Images | **Applied** to the shipped art. |
| 6 | Loading strategy | **Nothing to change**, measured below. |
| 7 | CDN and caching | **Applied** (cache headers); the CDN is CranL's edge and was left alone. |
| 8 | Parallel work | **Applied** at four places; the rest already ran together or waits on its first answer. |
| 9 | Loading states | **Applied** to the web page skeleton; the phone app skipped, with the reason. |
| 10 | Optimistic updates | **Applied** to one action; two others already were. |
| 11 | AI streaming | **Not applicable.** |
| 12 | Measurement | **Partly.** Bytes, requests and bundles measured; throttled-Chrome timings not taken. |

### 5. Images

- **Before:** 48 PNG and 4 JPEG files (the three puzzle photos, and the Open Graph card `opengraph-image.jpg`, which was left alone). The shipped art without the app icons was 1,710,486 bytes (web 360,088, phone 1,350,398):
  avatars, currency, the souvenir chest, the wordmark, achievement badges, memory-game cards, icons and three 768 px puzzle photos.
- **Applied:** that art (45 files) became lossy WebP (quality 85 with the alpha at 100; the puzzle photos at quality 80), made with
  `sharp` from the pnpm store as a one-off, so no dependency was added. **After:** 626,804 bytes (web 107,684, phone 519,120),
  63% smaller. The pictures keep their pixel sizes (128, 192, 365 by 96, 768). Compared with the PNG over the page colour the
  mean absolute difference is 2.2 to 3.5 of 255 (three pictures looked at side by side at three times size: no visible
  difference); the puzzle photos differ from their JPEG by 2.2 to 3.0.
- **On the web** the header wordmark, the one picture in every first viewport, went from 51,898 to 15,864 bytes on every page.
  `public-images.test.ts` now checks the WebP signature for the art and the PNG signature for the icons.
- **Phone bundle:** `expo export --platform android`, asset folder 10,205,424 to 9,374,146 bytes (97 files both times), 831,278
  smaller; the Hermes bytecode 6,527,467 to 6,527,503 (36 bytes, the longer file names). React Native reads WebP natively on
  Android and on iOS 14 and later; Expo SDK 57 starts at iOS 16.
- **No PNG fallback** is shipped. Every browser the pages target decodes WebP (Safari since version 14, 2020), and a second copy of
  every picture would cost more than it protects. If one turns up that cannot, `<picture>` with the old PNG is the way back (the
  files are in git history).
- **Left as PNG, on purpose:** `icon.png` (1,229,447 bytes; the store needs it, as asked), `adaptive-background.png`,
  `adaptive-foreground.png` and `splash.png` (the stores and the splash screen ask for PNG; written again without loss they were
  no smaller: 558,779 to 559,804, 228,953 to 228,240 and 211,941 to 212,157 bytes, so they stay as they are), and the web's
  `icon-192.png`, `apple-touch-icon.png` and `favicon.ico`. Making `icon.png` and the adaptive background lighter means
  redrawing them (a smooth gradient stored as a bitmap), which is art and a store decision; skipped.
- **Uploads** (organizer photos) wait on photo storage (Q-149, Later). When it exists, the server should store a WebP at a size
  that fits the screen. `images: { unoptimized: true }` in `next.config.ts` stays: no image goes through `next/image`.

### 6. Loading strategy

- Every web page has one picture in its first viewport, the header wordmark: a plain `<img>` with width and height set (122 by
  32) and no `loading="lazy"`, so it is never delayed and cannot shift the layout. Item 5 made it 36 KB lighter.
- The other pictures are 32 to 96 px avatars and currency icons in lists, forms, the kiosk and the Big screen, from 6 avatar and
  5 currency files. The browser fetches each file once per page whatever the row count, so lazy loading could save only the
  files below the fold: 6 to 8 KB each after item 5, about 80 KB at the very most on a page showing all eleven, and usually far
  less. That does not justify a change that can make a picture pop in on the Big screen, so none was made.
- The zxing decoder (946,860 bytes) is already loaded by `import()` on the kiosk page alone.
- **Bundle per route** (`next build`, `.next/diagnostics/route-bundle-stats.json`, 93 routes, uncompressed first-load JS): the
  floor is 1,290,195 bytes for a plain page (332,859 gzipped: three shared chunks of 805,205, 229,821 and 163,055 bytes, which
  are React and Next); `/_not-found` is 456,287. The heaviest route, event setup, is 1,401,400, so a route's own code is at most
  111,205 bytes (median 44,788 over the 83 routes that have any). After this change every route is within 29 bytes of that, except
  submissions (+181): the change did not move the bundle. The largest client panels (setup, quests, event page, control) are what
  their pages need to work; splitting them would move bytes, not remove any. No change.
- **Server and client components:** the 92 `page.tsx` files are server components that check the session and render one client
  panel (T-599); the session is read once per request (`cache`) and shared by a layout and its page. Nothing to move.
- **The phone's lists** are read a page at a time with a "More" button (notification center, event history, announcements); there
  is no long scrolling list and no `FlatList` to window. Skipped.

### 7. CDN and caching

- **Measured on staging** (`curl -I`, 2026-11-07, the staging web app, public URLs only): `_next/static/...` files already carry
  `cache-control: public, max-age=31536000, immutable`. Everything in `public/` (wordmark, avatars, currency, favicon, the zxing
  decoder) came back `cache-control: public, max-age=0` with a weak ETag, so each page view sent one conditional request per
  picture. The edge (openresty, `x-ggp-cache`, HTTP/2 and HTTP/3) gzips the wasm and passes the app's headers through, so a
  header set in the app reaches the browser. Nothing on CranL was touched.
- **Applied** (`apps/web/next.config.ts` `headers()`, rules in `src/lib/static-cache.ts`): the decoder, whose file name carries its
  version, `public, max-age=31536000, immutable`; the art, the icons and `favicon.ico`, `public, max-age=86400,
  stale-while-revalidate=604800`. Checked on the standalone server the Docker image runs (`pnpm start` on a loopback port after
  `next build`): each of those files answers with its header, and a page still answers `cache-control: no-store`.
  `static-cache.test.ts` fails when a file lands in `public/` that no rule covers, or that two rules cover.
- **Effect:** a returning visitor makes 0 conditional requests for that art within the day, instead of one per picture per page
  view (a page with the wordmark and five avatars: 6 requests, now 0).
- **Tradeoff:** a picture changed under the same name stays up to a day in a browser (a week at the outside, shown stale while it
  is checked). A picture that changes gets a new name, as the move to WebP did.
- **Pages stay `no-store`** (they carry personal data, `security-headers.ts`). No second CDN was added: personal data stays in
  Saudi Arabia, and the art needs nothing beyond headers behind CranL's edge in `riyadh-1`.

### 8. Parallel work

Read through the 92 server pages, the 262 web components and the phone's screens for reads that run one after another.

- **Applied (a request that waited for another it does not depend on):**
  - `useQuestBuilder.reload` (the quests page) asked for `/quests` and then `/quest-items`; both now go at once, so one wait of
    two requests instead of two waits.
  - The phone's `loadMyEvents` (Home) and its launch screen read the server's list and then the phone's "opened last" note; now at
    once.
  - The phone's boot read of the stored language and the restart note, which gate the first screen; now at once.
- **Already parallel:** 23 `Promise.all` calls in the web (event layout, sessions, sponsors, maps, announcements, finale and
  more) and the phone's interests and help screens.
- **Left, because the second read depends on the first:** the event Home reads the ranking only after its Home answer says the
  ranking is on and the player is active; `consentVersions` re-reads only when the first copy lacks the terms; the word import
  sends its chunks one after another on purpose.
- Evidence is the call order in the code, and `quests.spec.ts` and `quest-items.spec.ts` passing; no timings.

### 9. Loading states

- The web already has page-shaped skeletons (`loading.tsx`, T-599c) and a "Loading…" line in panels. The skeleton drew on the
  first frame, so a page that answered in 100 ms flashed grey bars. **Applied:** it now appears after 0.4 s, in CSS only
  (`skeleton.module.css`); the words for a screen reader are there at once. **Measured** in Chromium on the built CSS: opacity 0 at
  108 ms and 307 ms, 1 at 508 ms and 1,024 ms, so a wait over a second always shows it and one under 0.4 s never does. It is
  still the shape of the page, with no faked progress. Tradeoff: for 0.4 s after a click the content area is empty beside the
  shell that stays.
- **Not changed:** the 132 `common.loading` lines in panels (76 in the web, 56 in the app) are plain text that appears at once; replacing
  them is a sweep of 132 sites, left for a shared "Loading" component when one is needed. The phone has one skeleton (the Journey) and those 56 "Loading…"
  texts; the app has no render-test harness, so a delay there could not be tested; skipped.

### 10. Optimistic updates

- **Already optimistic and kept:** the phone's notification topics (the switch moves, a failed save puts it back) and "mark as
  read" in the notification center; the organizer's event switches (saved as the box changes, `aria-busy`).
- **Applied:** "Mark these as read" on the web submissions page (auto-approved submissions). The rows leave the list at once, the
  button shows `aria-busy` and stays until the server answers, and on a refusal the rows come back with the problem. A read mark
  pays nothing and grants nothing. Before, the list changed after two round trips (the mark, then the list again); now it changes
  at once and the same two requests follow. `submissions.spec.ts` has a new test that holds the server's answer to prove the
  first state and the rollback; `withoutItems` has a unit test.
- **Never optimistic, and not touched:** points, redemptions and prize handover, admin powers, and approving or rejecting a
  submission (approval pays).

### 11. AI streaming

**Not applicable.** Checked again on 2026-11-07: no model SDK in any `package.json`, no call to a model service and no streaming
response (`text/event-stream`, `EventSource`) in `apps` or `packages`.

### 12. Measurement

- **Taken:** byte sizes of every changed file; the `next build` route bundle report (93 routes, before and after); the phone
  bundle with `expo export --platform android` before and after; response headers on staging and on the local standalone server;
  the skeleton's opacity over time in Chromium; request order in the code.
- **Not taken:** Chrome DevTools with Slow 4G and 4x CPU throttling on identical routes, and a real low-end phone. There is no
  earlier baseline of that kind, the server is shared and loaded, and the changes are in bytes and request counts, so a timing
  would measure the load more than the change. A missing baseline is reported, not estimated, so none is given. Server timing
  stays with `ops/load/` (T-804).
- **Remaining risks:** art changed under the same name shows stale for up to a day in a browser; WebP has no PNG fallback (item
  5); the skeleton's 0.4 s reveal is a CSS animation. The Reduce Motion rule stops only the pulse
  (`skeleton.module.css`), and the 0 s reveal still runs; only a user stylesheet forcing `animation: none` would leave the
  skeleton hidden (the screen-reader line still shows).
- **Files changed:** `apps/web/next.config.ts`, `apps/web/src/lib/static-cache.ts` (and its test), 13 web and 32 phone art files
  with their references, `apps/web/src/ui/skeleton.module.css`, `apps/web/src/components/SubmissionsPanel.tsx`,
  `apps/web/src/lib/submissions.ts`, `apps/web/src/components/useQuestBuilder.ts`, `apps/app/src/home/home-reads.ts`,
  `apps/app/src/i18n/provider.tsx`, `apps/app/app/index.tsx`. No migration, no dependency, no new user-facing string.
- **Checks run:** the test counts and the four closing checks are in `docs/_blueprint/STATE.md`, "T-813 part 2".
