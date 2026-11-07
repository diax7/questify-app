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

- **Before:** 48 PNG and 3 JPEG files. The shipped art without the app icons was 1,710,486 bytes (web 360,088, phone 1,350,398):
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
- **Not changed:** the 134 `common.loading` lines in panels are plain text that appears at once; replacing them is a sweep of 134
  sites, left for a shared "Loading" component when one is needed. The phone has one skeleton (the Journey) and 53 "Loading…"
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
  5); the skeleton's 0.4 s delay relies on CSS animation running (with animations removed by the system the skeleton does not
  draw, and the screen-reader line still does).
- **Files changed:** `apps/web/next.config.ts`, `apps/web/src/lib/static-cache.ts` (and its test), 13 web and 32 phone art files
  with their references, `apps/web/src/ui/skeleton.module.css`, `apps/web/src/components/SubmissionsPanel.tsx`,
  `apps/web/src/lib/submissions.ts`, `apps/web/src/components/useQuestBuilder.ts`, `apps/app/src/home/home-reads.ts`,
  `apps/app/src/i18n/provider.tsx`, `apps/app/app/index.tsx`. No migration, no dependency, no new user-facing string.
- **Checks run:** the test counts and the four closing checks are in `docs/_blueprint/STATE.md`, "T-813 part 2".
