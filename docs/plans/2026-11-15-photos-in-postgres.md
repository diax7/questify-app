# Photos in a second PostgreSQL database (plan, tier A: personal data storage, tenant isolation)

Source: Dhia, 2026-11-15 (docs/INBOX.md): "Second Postgres DB (Recommended)" in CranL `riyadh-1`, because the CranL
bucket stores files outside Saudi Arabia (Q-768; hard rule 3, PDPL). Builds on ADR-828 to ADR-830, ADR-836 and ADR-837
and the as-built notes of `docs/plans/2026-11-12-photo-storage.md` section 11. Task **T-814** (TASKS.md). Main migration
**0200** (one function); the media database has its own migration series starting at **m0001**. Staging is at 0199.
Proposed **ADR-839 to ADR-841**, **Q-785 to Q-787**. No new dependency; `aws4fetch` is removed.

**Done when:** with `MEDIA_DATABASE_URL`, `MEDIA_ORIGIN` and `MEDIA_URL_SECRET` set, a player's photo and an organizer's
image are stored as bytes in the media database `questify-media-db` in `riyadh-1`; the team, the big screen and the
app's wall load them from `GET /v1/media/<key>?e=…&s=…` on the API, a link that works for at most 5 minutes and names no
person; a rejected, erased, swept or purged photo's bytes are deleted from the media database within one worker run; a
byte row nothing in the main database names is deleted by the daily reconcile; without the three settings photos stay
off exactly as today (503 `photos_off`, builder refuses `photo`, no wall). Nothing is written to the CranL bucket, and the
S3 code is gone.

**Order.** Phase 1 (code, photos still off on staging), phase 2 (staging on, Dhia's database), phase 3 (live event load),
phase 4 (backups, restore and the release gate). Each phase below says what it delivers alone.

## 1. What exists today (read 2026-11-15)

| Piece | Where | Today |
|---|---|---|
| Store interface | `apps/api/src/storage/client.ts` | `ObjectStore {put, delete, signGet}`, built on `aws4fetch`, 3 attempts, 10 s each, `MAX_SIGNED_SECONDS = 300` |
| Settings | `storage/config.ts`, `config.ts:318` | five `S3_*` all or none; none means photos off |
| Upload | `storage/upload.ts` `storeUpload` | reserve (main) → re-encode → `put` outside any transaction → `media_stored` (main); a swept slot answers false and the database queues the key |
| Organizer images | `storage/organizer-upload.ts`, `read-routes.ts` | same `storeUpload`; reads answer a 302 (or JSON `{url}`) to a 300 s signed URL, `private, max-age=240`, `no-referrer` |
| Signing | `storage/signed.ts` | team 300 s (`signedPhoto`); wall 120 s from the minute's start (`stableWallUrl`) |
| Readers | `submissions.ts:376`, `tickets.ts:488, 608`, `tickets/console.ts:243`, `console/moderation/doors.ts:101`, `screen/photo-wall.ts:53-80` | sign only keys a seat-checked definer returned |
| Worker | `storage/worker.ts` | sweeps, purges (365 days), claims `media_delete` with a lease, deletes per key outside the claim, `media_delete_done` / `_failed` |
| Main tables | 0192 to 0196 | `media_object` (key CHECK ties org, event, purpose, id), `media_delete`; deletion by construction (ADR-828) |
| Pools | `server.ts:117-125` | `pool` (API) and `pushPool` (3); `watchPool` per pool |
| Web | `security-headers.ts:24, 43`, `proxy.ts:85`, `forward-headers.ts:138-200`, `RemotePhoto.tsx` | `img-src 'self' data: https://<MEDIA_HOST>`; the forwarder passes an image read's 302 only to the `MEDIA_HOST` origin |
| App | `organizer-images.ts:16`, `PhotoWall.tsx:64`, `operator/review.ts:53` | takes only `https://` URLs; RN `Image` by `uri` |
| CranL | `ops/cranl/staging.json`, `scripts/cranl/apply.mjs:18` | `databases: postgres, redis`; `BUDGET = {apps: 3, databases: 2, buckets: 1}`; DBs adopted by name (`observe.mjs:71`) |
| Tests | `test/storage/fake-s3.ts`, `client.test.ts`, `contract.int.test.ts`, `worker.int`, `image-routes.int`, `photo.int`, `photo-wall.int` | an in-process S3 fake; each test file gets its own database `questify_test_<ts>_<hex>` (`test/support/test-db.ts`) |
| Logs | `app.ts:207-210` | request lines carry the route template, not the URL |

Staging has never stored a photo: the `S3_*` operator secrets were not set while Q-768 was open. No bytes need to move.

## 2. Decisions (Proposed; the coordinator accepts after the plan review)

### 2.1 ADR-839: the media database is a dumb byte store; the main database stays the source of truth

- **What moves: the bytes only.** `media_object` and `media_delete` stay in the main database, unchanged. Who owns a
  photo, its event, its state, consent, picks, holds, retention and every deletion rule stay where tenant isolation and
  the triggers of ADR-828 already prove them. The media database knows a key and its bytes, nothing else: no player,
  no organizer row, no event row. Moving `media_object` would split the deletion triggers across two databases with no
  transaction between them; nothing gained is worth that.
- **One table** in the media database:
  `media_blob (key text PRIMARY KEY, content_type text, bytes int, sha256 bytea, body bytea, created_at timestamptz)`.
  - CHECKs: the same key shape as `media_object_key_prefix` (`^o/<uuid>/e/<uuid>/<purpose>/<uuid>\.(jpg|png)$`);
    `content_type` agrees with the extension (`.jpg` ↔ `image/jpeg`, `.png` ↔ `image/png`);
    `bytes = octet_length(body)` and at most 4 MiB (a 2,048 px JPEG 82 is far under it);
    `octet_length(sha256) = 32`.
  - `ALTER COLUMN body SET STORAGE EXTERNAL`: JPEG and PNG are already compressed, so TOAST stores them out of line
    without trying to compress them again.
  - `bytea`, not large objects: no `lo_unlink` bookkeeping, plain `pg_dump`, row-level deletes.
- **Its own pool and settings.** `MEDIA_DATABASE_URL` (the runtime role), `MEDIA_ORIGIN` (the public https origin that
  serves `/v1/media/*`: the API's own public host) and `MEDIA_URL_SECRET` (32 or more characters): all three or none (the
  Msegat pattern). None means photos off, as `config.storage === undefined` does today; every photos-off path is reused
  untouched. `MEDIA_ORIGIN` must be https in production and an origin only. A `mediaPool` (`max` 4,
  `connectionTimeoutMillis` 5,000, `statement_timeout` 10 s for writes and 5 s for reads, set per role in m0001) is
  watched as `media` by `watchPool`. The API starts even when the media database is unreachable: uploads answer 503
  `storage_unavailable`, links load nothing, `/readyz` stays green (an event runs without photos).
- **Migrations kept apart.** `apps/api/media-migrations/m0001_media_blob.sql` and later files, run by the same runner
  (`migrate(client, directory)`) with its own `schema_migration` table in the media database and its own advisory lock
  key. `node migrate.cjs --media` uses `MEDIA_DATABASE_ADMIN_URL`; `--media --roles` creates the role the first time;
  `--media --verify` proves its limits. Exit codes and the deploy loop are the same as the main series (RUNBOOK). The
  file name pattern is `m\d{4}_…` so a media file can never be copied into the main series by mistake (the main
  runner's `FILE_NAME` refuses it, and the media runner refuses a plain `\d{4}_` file).
- **Roles and least privilege** (deny by default, hard rule 2):
  - `questify_media_app`: `CONNECT` on the media database only; `CONNECT` revoked from `PUBLIC`; no right on
    `media_blob` (RLS forced, no policy, no grant); `EXECUTE` on four definers only, each `SECURITY DEFINER` with a
    pinned `search_path`:
    - `blob_put(key, content_type, sha256, body)`: insert, or on the same key with the same `sha256` do nothing (a
      retried PUT); a different `sha256` on an existing key is refused (`MB409`): keys are never reused.
    - `blob_get(key)`: returns `content_type`, `bytes`, `sha256`, `body`.
    - `blob_delete(keys text[])`: deletes, returns the count; a key already gone is fine.
    - `blob_keys_page(after text, older_than timestamptz, n int)`: keys only, for the reconcile.
  - The owner (CranL `admin`) runs migrations only; its URL is removed from the app environment afterwards.
  - `questify_app` (the main role) has no right in the media database, and `questify_media_app` none in the main one. On
    CranL they are separate database servers, so this holds by construction; locally and in CI they share one server,
    and the outsider test proves both directions.
- **Consistency without a cross-database transaction.**
  - **Write order:** main first, bytes second, main again: `media_reserve` (main) → re-encode → `blob_put` (media,
    outside any transaction) → `media_stored` (main). A byte row is therefore always written after its `media_object`
    row exists. Every failure in between already has an owner: a slot never stored is swept after 30 minutes and its key
    queued; a slot swept while the put ran makes `media_stored` answer false, and the database queues the key (as today).
  - **Delete queue:** unchanged in the main database. The worker claims a round (commits), calls `blob_delete(keys)`
    once for the round (one statement, not one per key), then `media_delete_done`. A crash between the two repeats the
    delete, which finds nothing: idempotent. A media-database failure is `media_delete_failed(id, 'media_unavailable')`
    for the round and backs off as today.
  - **Orphan sweep (reconcile):** once a day, and on demand after a restore, the worker pages `blob_keys_page` (500 keys
    a page, only rows older than 1 hour) and asks the main database `media_keys_known(keys)` (migration 0200, system seat
    only, returns the keys that still have a `media_object` row). Unknown keys are deleted with `blob_delete`. This also
    removes bytes a restore of the media database brought back for photos that were deleted since (PDPL erasure).
  - **The other way round** (a `media_object` stored but no bytes, after a media restore): the link answers 404, the
    team sees "photo unavailable", and the reconcile logs `media.missing {count}` (no keys). Nothing is invented.
- **The S3 backend is removed, not kept behind configuration.** Keeping it would keep a code path that sends personal
  data outside Saudi Arabia one setting away (rule 3), plus `aws4fetch`, the fake, the contract test and the CranL bucket
  tooling to maintain. The `ObjectStore` interface stays (readers and the upload code keep their shape) with one
  implementation, `createMediaStore(pool, {origin, secret})`. `delete(key)` becomes `deleteMany(keys)`. The `S3_*`
  variables are no longer read; when one is still set the API logs `storage.s3_ignored` once at start (it does not
  refuse, so a forgotten secret cannot block a deploy). If a provider in Saudi Arabia offering S3 appears later, a second
  implementation of the same interface is a small, separate change with its own ADR.

### 2.2 ADR-840: photos are served by the API behind short signed links (supersedes ADR-837's "not through the API")

- **Route:** `GET /v1/media/o/<org>/e/<event>/<purpose>/<id>.<jpg|png>?e=<unix expiry>&s=<signature>`, `access:
  "public"` (the link is the authorization), `HEAD` too. The path must match the key pattern exactly or it is a 404
  before anything else runs.
- **Signature:** `s` = base64url of the first 16 bytes of HMAC-SHA256 under a key derived from `MEDIA_URL_SECRET`
  (HKDF, label `questify-media-get-v1`) over `"<key>\n<e>"`. Checked with `timingSafeEqual` before any database read.
  `e` must be in the future and at most `now + 300 + 5` seconds (clock slack); a link minted for longer is refused, so a
  coding mistake cannot hand out a long-lived link. `signGet(key, ttl, type, at)` keeps its contract (at most 300 s;
  the wall's 120 s from the minute's start stays stable within a minute). The URL names an opaque key (organizer, event
  and object uuids) and an expiry, never a person, as ADR-837 already accepts. Signing is pure computation: readers no
  longer make an outside call.
- **Answers:** every refusal (bad path, bad or old signature, no such bytes) is one `404` with no body detail; the
  media database unreachable or the read gate full is `503` with `Retry-After: 1`. A good read answers `200` with:
  - `Content-Type` from the stored row (`image/jpeg` or `image/png`), `X-Content-Type-Options: nosniff`,
    `Content-Disposition: inline`, `Content-Length`;
  - `Cache-Control: private, max-age=<seconds left, at most 300>, immutable` (bytes at a key never change; `private` so
    no shared cache or edge keeps a photo);
  - `ETag: "<sha256 base64url>"` and `304` on `If-None-Match` (only after the signature passed);
  - `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: cross-origin` (the dashboard on
    `questify.nafes.com` and the screen load it from the API's host), the API's usual `Content-Security-Policy:
    default-src 'none'` (harmless on an image, blocks an SVG trick even if one ever got in).
  - **No ranges:** `Accept-Ranges: none`. A stored image is at most a few hundred KB to 2 MB; ranges add parsing and
    edge cases for no gain.
- **Limits on a public route:** valid links are never limited by address (a venue's phones share one NAT). Bad
  signatures count per address bucket (60 a minute, then 429), so the route is not an oracle to hammer. A read gate
  (16 media reads at a time, 128 waiting, then 503) keeps the API's event loop and the 4-connection pool from being
  swamped. An in-process cache of hot objects (LRU, 64 MB, entries up to 4 MB, 5-minute life) serves the wall's repeats
  without the database; a deleted photo cannot be served from it past its links, because no reader signs a link for a
  key that no longer exists, and the worker evicts keys it deletes on its own replica.
- **The web.** `MEDIA_HOST` keeps its name and its check (`mediaSource`), and becomes the API's public host (staging:
  `questify-api-staging-3ez01s.cranl.net`), so `img-src` names exactly that one host. `RemotePhoto`, `PhotoScene` and
  `ImageField` keep `referrerPolicy="no-referrer"`. The forwarder's image-read 302 rule (`imageLocation`) is unchanged:
  the organizer image doors now redirect to a `/v1/media/…` link on `MEDIA_ORIGIN`, which is the `MEDIA_HOST` origin.
  Bytes go browser → API directly, never through the web app.
- **The app** keeps working without a release: every URL stays an absolute `https://` URL (`organizer-images.ts:16`
  accepts it), and RN `Image` loads it with no token (the link is the authorization).
- **Logs:** the request line already carries the route template (`/v1/media/*`), never the key or the signature; the
  route adds one counter by outcome (`ok`, `not_modified`, `refused`, `busy`, `unavailable`). Traces carry the route
  only.

### 2.3 ADR-841: the media database's size, retention and recovery

- **Retention unchanged:** unattached uploads swept after 30 minutes, the deletions of ADR-828, everything purged 365
  days after its event ends (Q-075 still with counsel). The media database follows the main one by the delete queue and
  the reconcile; it keeps nothing on its own.
- **Size growth.** A stored photo is about 0.2 to 0.8 MB (to measure on the fixtures in phase 1 and on staging in phase
  2); organizer images are small. A guess for year one: 30 events × 500 players × 2 photos ≈ 30,000 photos ≈ 12 GB,
  flat after a year because of the 365-day purge. PostgreSQL reuses the space of deleted rows (autovacuum); no `VACUUM
  FULL` on a schedule. The worker reads `pg_database_size()` every 10 minutes into `questify_media_db_bytes`; an alert
  fires at 70 % of the plan's disk (the figure goes in the rule once CranL gives it, Q-786).
- **Backups:** CranL daily backups for `questify-media-db`, kept 7 (declared in `ops/cranl/staging.json`, like the main
  database), plus the media database in T-019's nightly second copy in Saudi Arabia.
- **Recovery targets (Proposed, Q-787):** NFR-026 (5 minutes of loss, back within 1 hour) stays the target of the main
  database and of the service: an event runs with the media database down (no photos shown, uploads 503). The media
  database gets its own target: back within 4 hours, losing at most the photos since its last backup (a day with daily
  backups; 5 minutes once CranL's point-in-time restore is confirmed, T-811). Keeping the bytes in their own database is
  what keeps the main restore fast: a 12 GB media restore would not fit inside the main database's hour.
- **Restore order** (RUNBOOK, phase 4): main restore first and erasures re-applied (T-708) → media restore → the
  reconcile `--all` (deletes bytes of anything deleted after the media backup, logs what is missing) → traffic.

## 3. Changes

### 3.1 Media database (m0001)
- `media_blob` as 2.1, RLS forced, no grant; the four definers; `REVOKE CONNECT … FROM PUBLIC`, `GRANT CONNECT` to
  `questify_media_app`; `ALTER ROLE questify_media_app SET statement_timeout = '10s'`. Header names the lock order (one
  table, one row per statement) and says no function reads more than one key's body.
- Personal-data catalog (T-708): `media_blob.body` is listed as a photo (personal data) for the erasure proof.

### 3.2 Main migration 0200
- `media_keys_known(keys text[]) RETURNS SETOF text`: system seat only (refuses every player, team, device and admin
  seat, as the worker's doors do), at most 500 keys a call, reads `media_object` by its unique key index.
- `media_delete_failed` takes the new code `media_unavailable` (codes are free text today; check, and widen a CHECK only
  if one exists).
- Outsider and route inventories updated.

### 3.3 API
- `storage/media-store.ts` (new): `createMediaStore` (`put` → `blob_put` with one retry on a connection error or
  `57014`, as both are safe to repeat on the same key and hash; `deleteMany` → `blob_delete`; `get` → `blob_get`; `signGet`
  → HMAC). Timeouts from the pool and the role; logs carry the operation, the key's purpose and a code, never a key.
- `storage/media-link.ts` (new): `signLink`, `checkLink` (pure, unit-tested).
- `storage/media-route.ts` (new): the route of 2.2, the read gate, the LRU, the bad-signature limiter.
- `storage/config.ts`: the three `MEDIA_*` settings; `S3_*` ignored with the start-up log.
- `storage/client.ts`: keeps `ObjectStore`, `StoredType`, `SignedUrl`, `StorageError` (renamed codes: `unavailable`,
  `timeout`); the aws4fetch client is deleted. `upload.ts`, `organizer-upload.ts`, `read-routes.ts`, `signed.ts`, the
  readers: no change beyond types.
- `storage/worker.ts`: one `deleteMany` a round (the 31 s per-key budget becomes one 10 s statement; the lease stays 5
  minutes); the daily reconcile (`media_reconcile` lease row, so one replica runs it); the size gauge; eviction from the
  LRU.
- `server.ts`: `mediaPool` and the store when the settings exist; `stop` ends the pool.
- `migrate-cli.ts`: `--media`.
- `package.json`: drop `aws4fetch`.

### 3.4 Web and app
- Phase 1: none (same `MEDIA_HOST` mechanism, new value set in phase 2).
- Phase 3: `PhotoScene`, `RemotePhoto` (wall uses) and the app's `PhotoWall` keep a picture that has loaded while its
  `mediaId` stays in the list, and change `src` only when the photo changes, so a new minute's link does not reload it.

### 3.5 CranL and docs
- `scripts/cranl/apply.mjs`: `BUDGET.databases` 3 (Dhia's plan has room: he is creating the database). `buckets` stays
  in the tooling, at 0 in both files.
- `ops/cranl/staging.json`: `databases.media = {name: "questify-media-db", type: "postgresql", backups: daily 00:43 UTC,
  keep 7}` (adopted by name once Dhia creates it, `observe.mjs:71`); API env `MEDIA_DATABASE_URL` as an operator secret
  (the runtime role, not the owner), `MEDIA_ORIGIN` plain, `MEDIA_URL_SECRET` `{"secret": "generate"}`; the five `S3_*`
  removed; `buckets: []`; web `MEDIA_HOST` stays an operator secret (set to the API host). Production stays without.
  `infra.test.ts` updated.

## 4. Tests (written first)

- **Unit**
  - `media-link.test.ts`: a link round-trips; a changed key, expiry or signature byte fails; expired fails; `e` beyond
    `now + 305` fails; the compare is constant-time (`timingSafeEqual` is called with equal lengths; a short `s` fails
    before it).
  - `media-store.test.ts` (fake pool): retry once on a connection error, never on `MB409`; the log has no key.
  - `config.test.ts`: all three or none; https only in production; `S3_*` ignored with one log line.
  - `media-route.test.ts` (fake store): every header of 2.2; `304`; 404 for each refusal and the same body for all;
    503 when the gate is full; the bad-signature limiter; HEAD.
- **Media database** (`test/db/media-blob.int.test.ts`, the second database of 4.1): key CHECK, type and extension,
  size cap, `blob_put` idempotent on the same hash and `MB409` on another, `blob_delete` of absent keys, paging.
- **Both databases** (`test/storage/*.int`, `test/submissions/photo.int`, `test/screen/photo-wall.int`, moved off the
  S3 fake):
  - upload, submit, the queue's link loads the bytes through the route;
  - a rejection, an erasure, a rehearsal wipe and the 365-day purge each leave no byte row after one worker run;
  - a put that lands after its slot was swept leaves no byte row (the existing race test, now on the media DB);
  - the reconcile deletes a byte row nothing names and keeps one that is named; it skips rows younger than an hour;
  - the media database stopped (a pool to a closed port): upload 503 `storage_unavailable`, readers still answer,
    links 503, the worker backs off with `media_unavailable`, `/readyz` green.
- **Security**
  - `test/security/media-outsider.int.test.ts` (new): a role with no rights and `questify_app` cannot connect to the
    media database or read `media_blob`; `questify_media_app` cannot read the table directly, cannot connect to the main
    database, can only run the four definers.
  - `outsider` (main): `media_keys_known` refuses every seat but the system's.
  - `cross-tenant`: organizer B's member gets no link for A's photo (unchanged), and a link signed for A's key does not
    open another key by editing the path (404).
  - `routes.int`: `/v1/media/*` declares `access: "public"`; the inventory lists it.
  - An **outsider HTTP test** for the route: no query, a query from another key, an expired link, a link with `e` an
    hour away, a path that is not a key (`../`, `%2f`, an extra segment) are all one 404; nothing in the answer names a
    player.
- **Contract** (`MEDIA_CONTRACT=1`, run by the coordinator in phase 2, replaces the S3 contract test): against
  `questify-media-db` as `questify_media_app`: direct `SELECT` refused, put / get / delete through the definers, an 8 MB
  upload through the API's public host, a signed link served, a tampered one 404.
- **Load** (phase 3, `test/perf`): 1,000 simulated members and 4 screens on a 20-photo wall for 10 minutes against a
  local API with one media pool; p95 of the route under 150 ms, no 503 beyond 0.1 %, API RSS under its limit.
- **Hand mutants:** skip the signature check; accept `e` beyond 305 s; compare with `===`; serve without `nosniff`;
  `public` instead of `private`; worker marks done before `blob_delete`; reconcile without the 1-hour age filter;
  `blob_put` overwrites a different hash; `media_keys_known` open to a player seat.

### 4.1 Local and CI databases
- `test/support/test-db.ts` gains `createMediaTestDatabase()`: a second throw-away database on the same server as
  `TEST_DATABASE_URL` (`questify_test_media_<ts>_<hex>`), media migrations applied, `questify_media_app` created once
  under the role lock. The leftover sweep's pattern covers the new prefix. No new setting and no new CI service: the CI
  Postgres container already serves both.
- The list-style guards (`rehearsal.int`, the main outsider catalog) see only the main database, plus 0200's function.

## 5. Phases

1. **Code, photos still off on staging.** 4's failing tests, m0001, 0200, the media store, the route, the worker, the
   settings, S3 removed, CranL files. Deploy 0200 and the code to staging with no `MEDIA_*` set: nothing changes for
   anyone, and no code path can send a photo outside Saudi Arabia any more. *Value:* the outside-KSA path is gone; the
   photo feature is ready behind one switch. One code review (tier A), mutation on `storage/media-*.ts` and
   `storage/worker.ts`.
2. **Staging on (needs Dhia).** Dhia creates `questify-media-db` in the Nafes project, `riyadh-1` (AskUserQuestion; he
   said he would). The coordinator: `pnpm infra plan staging` shows it adopted; confirm the region is `riyadh-1` in the
   dashboard; `MEDIA_DATABASE_ADMIN_URL=… node migrate.cjs --media --roles`, then `--media --verify`; set
   `MEDIA_DATABASE_URL` (runtime role), `MEDIA_ORIGIN`, `MEDIA_URL_SECRET`, the web's `MEDIA_HOST`; before turning on,
   `SELECT state, count(*) FROM media_object GROUP BY 1` must show no `stored` or `attached` row (staging never stored a
   photo; if one exists it is fake data: delete it as the owner and let the worker run); deploy; run the contract
   test; a photo quest on the demo event from a phone. Then Dhia deletes the `questify-media` bucket and its keys
   (dashboard only), and the bucket keys file on this PC is removed. *Value:* photo quests, ticket photos, organizer
   images and the wall work on staging with every byte in `riyadh-1`. Unblocks Q-774 (store forms).
3. **Live event load.** The client change of 3.4, the load test, the LRU and gate tuned from its numbers. If the API's
   egress or CPU is the limit, a smaller wall copy (1,280 px, JPEG 75, stored at pick time as `…/wall/<id>.jpg`) is the
   next step, decided on the measurement, not built ahead. *Value:* the wall is safe at a 1,000-player event.
4. **Backups and restore.** The RUNBOOK restore order of 2.3, the reconcile `--all` command
   (`node staff-cli.cjs media-reconcile`), the media database in T-019's second copy and in T-805's rehearsal (the main
   database restored within the hour with the media database down, then the media database restored and reconciled).
   *Value:* the release gate covers photos.

Migration order on any environment: 0200 (main) and m0001 (media) are independent; both go before the settings are set.
The main code deploy may go before or after either: without the settings it does not touch the media database, and
0200 adds a function only.

## 6. ADRs and questions

- **ADR-828** (Proposed): its "Bucket" bullet is replaced by ADR-839; keys, upload, deletion by construction and the
  rest stand. Status line gains "amended by ADR-839 (Proposed, 2026-11-15)".
- **ADR-837** (Accepted): its decision "not served through the API" is superseded by ADR-840 once ADR-840 is accepted;
  until then a note on its status line. The reasoning that stays: no person in the URL, ≤5 minutes, no referrer.
- **ADR-829 and ADR-830:** unchanged in substance; their "bucket" wording means "the media store" (a note on each).
- **ADR-836:** unchanged (re-encode, no scan).
- **ADR-839, ADR-840, ADR-841:** Proposed, written in DECISIONS.md with this plan.
- **Q-768:** resolved by Dhia (2026-11-15): the bucket is not used for photos.
- **Q-785** (ADR-839): S3 removed rather than kept behind a setting. **Q-786** (ADR-840 and 841): CranL's facts for the
  media database (separate server or not, disk size, egress limits of the API's host, PostgreSQL version). **Q-787**
  (ADR-841): the media database's own recovery target (4 hours, a day of photos) against NFR-026.

## 7. Risks

- **API egress and CPU at live events.** Every photo byte now leaves through the API. The 1-minute link change made
  clients reload wall photos each minute; 3.4 fixes it, and the load test is the gate before a large event.
- **CranL database budget and disk.** A third database must fit the plan, and its disk is not known (Q-786). Without
  room, the fallback is a separate schema in the main database server with its own role, which loses the restore
  separation; recorded, not planned.
- **Same server locally, different servers on CranL.** Tests run both databases on one server; a cross-database
  mistake (a query sent to the wrong pool) is caught by the outsider test's role rights, not by the network.
- **bytea over the wire.** node-pg receives `bytea` as hex text (twice the bytes, a decode on the event loop). With
  images under 2 MB and the LRU this is small; if the profile shows it, read `blob_get` in binary result format.
- **Restore mismatch.** Two databases restored to different moments: the reconcile handles deleted-but-restored bytes
  (PDPL), and missing bytes are shown as unavailable, never as someone else's photo (keys are never reused, `MB409`).
- **A leaked `MEDIA_URL_SECRET`** lets anyone who also knows a key mint a link. Keys are 3 uuids that only seat-checked
  readers return; rotate by changing the secret (links last 5 minutes, nothing stored depends on it).

## 8. Docs (with the build)

ARCHITECTURE (object storage row becomes the media database; the route), DATA_MODEL (media database section), API.md
(`/v1/media/*`, headers, errors), SECURITY (threat 8, photo storage table, secrets: `MEDIA_URL_SECRET`, roles),
RUNBOOK ("Photo storage" rewritten: settings, `--media` migrations, a stuck delete, deleting one photo, reconcile,
restore order; remove the bucket steps), INTEGRATIONS and the data map (photos stay in `riyadh-1`; the CranL bucket is
not used), STORE_COMPLIANCE and `docs/store/` (photo storage location), TASKS (T-814, T-019 and T-805 notes), STATE.
