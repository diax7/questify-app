# Photo storage, phase 1: shared storage and T-301b photo submissions (plan, tier A: personal data stored outside, tenant isolation)

Source: T-301b (docs/TASKS.md:322-326), ADR-183, ADR-185, ADR-186, Q-149 to Q-155, the T-301 plan's last section
(docs/plans/2026-10-24-t-301-submissions.md:135-143). Q-149 is answered: Dhia upgraded the CranL plan on 2026-11-12, so we
get a second bucket, `questify-media-staging` in `riyadh-1`, and production gets one later. Migrations **0192**
(storage) and **0193** (photo submissions). The newest migration is 0191. New dependencies: `sharp` 0.35.5 and
`aws4fetch` for the API, and `expo-image-picker` for the app. New tables: `media_object` and `media_delete`. Delivers
FR-204 and the photo half of FR-337 (owed here, TASKS.md:325). Phase 2 (section 9) is one tier B batch on the same upload
door.

**Done when:** a player takes or picks a photo for a photo submission quest, and the API stores a re-encoded JPEG with
no EXIF, at most 2,048 px, in the private bucket under `o/<organizer>/e/<event>/`. The team sees the photo in the review
queue (dashboard and operator app) through a signed URL on the bucket's host that expires after 5 minutes. A rejected,
removed, erased or wiped photo, or a photo whose ticket was deleted, is deleted from the bucket within one worker run.
An upload never attached is deleted after 30 minutes. A member of organizer B cannot get a URL for any object of
organizer A. Without storage settings, the API refuses `photo` as it does today.

**Order.** (1) Failing tests (section 5). (2) 0192 and the storage module. (3) 0193, the routes, the app and the
dashboard. (4) Hand mutants (section 6). (5) The coordinator applies `ops/cranl/staging.json` and runs the contract test
against the real bucket. (6) Docs.

## 1. Latest definitions (migrations searched up to 0191)

| Object | Latest | Today |
|---|---|---|
| `submission` table | 0040:20-58 | `kind IN ('text')` (:26); `CHECK (erased_at IS NOT NULL OR body IS NOT NULL)` (:51) |
| `quest_submission_text_only` | 0040:12 | `accepts = ["text"]` only |
| `submit_quest(uuid,text,text,text)` | 0098:972 | text only |
| `queue_rows` / `event_submissions` / `operator_submissions` | 0040:863 / 893 / 908 | return a TABLE with no photo; changing the shape means DROP and CREATE again |
| `own_submissions` | 0055:740 | statuses only |
| `review_core` | 0098:1175 | rejection sets the status (the trigger in 0192 catches it) |
| `remove_award` | 0098:167 | marks the submission `removed` |
| `erase_rows` | 0155:850 | `UPDATE submission` sets erased (:911); `DELETE FROM ticket` (:895) |
| `wipe_rehearsal` | 0166:149 | `DELETE FROM submission` (:213), `ticket` (:223) |
| `purge_ended_tickets` | 0061:777 | deletes tickets 90 days after the event |
| `export_submissions` / data request | 0103:152 / 0129:344 | body text only |
| `content_hold.kind` | 0121:24 | quest, reward, announcement; `target_id uuid` (a submission id is a bigint) |
| builder refusal | apps/api/src/quests/builder.ts:488; packages/shared/src/quests/registry.ts:319-330 | refuses `photo` with `submission_kind_unavailable` |
| HTTP idempotency fingerprint | apps/api/src/conventions.ts:87-92 | `JSON.stringify(request.body)`: a Buffer would turn into a JSON array about 30 MB long |
| CranL buckets | staging.json:22 `[]`; spec.mjs:110; diff.mjs:159-160; apply.mjs:98-99 | create sends `{name, project_id}` with **no region**; `BUDGET = {apps: 3, databases: 2}` (apply.mjs:15) does not count buckets |
| Dependencies | apps/api/package.json | no S3 client. `sharp@0.35.5` is in the lockfile only through Next (next package.json:115); it has no install script, so `strictDepBuilds` is fine. musl binaries are among its optional packages |
| API image | Dockerfile; apps/api/package.json build | esbuild bundles everything except argon2 |
| App | apps/app/package.json:23, 27; app.json:86-88 | `expo-camera` and `expo-file-system` present, no `expo-image-picker`; the camera text names scanning only (STORE_COMPLIANCE.md:676-700) |
| Web CSP | apps/web/src/lib/security-headers.ts:20, 57 | `img-src 'self' data:` (and `blob:`) |
| S3 test double | not in the repo | no MinIO image locally and no CI service (ci.yml:34-46 runs Postgres only). Patterns to follow: scripts/cranl/fake-cranl.ts, src/push/fake.ts |

## 2. Decisions (Proposed ADRs; the coordinator accepts them after review)

- **Q-149 resolved:** a second CranL bucket, one per environment, not shared with `b7r-media`. ADR-183 is carried out.
- **Q-150: the recommended answer.** Uploads up to 8 MB; stored as JPEG, quality 82, at most 2,048 px on the long side.
- **Q-151: the recommended answer** (`sharp` and `aws4fetch`; through the API, re-encoded). **Change to ADR-185:** the
  server refuses HEIC with 415. Prebuilt libvips cannot decode HEVC, and the app already sends JPEG (T-301 plan :137).
  Accepted inputs are JPEG, PNG and WebP, checked by their magic bytes.
- **Q-152: the recommended answer.** Rejected and removed photos, and those of erased accounts, wiped rehearsals and
  deleted tickets, are deleted at once through `media_delete`. Approved photos follow event retention. Q-075 is still
  with counsel, so an interim purge removes them **365 days after the event ends** (`media_purge_due`), recorded in Q-075.
- **Q-153, Q-154, Q-155: the recommended answers, unchanged** (ADR-187 to ADR-189 as built in T-301). An auto-approved
  photo pays at once and waits in the queue as "unseen". There is one pending submission per quest. Removal is for the
  owner and editors.
- **Keys:** `o/<organizer_id>/e/<event_id>/<purpose>/<uuid>.jpg`. The server makes them from database rows, never from
  client input. A CHECK in `media_object` forces the prefix to match the row's own organizer and event. The bucket is
  private. Signed URLs come only from keys returned by a definer that checked the caller. Like ADR-195 for votes,
  erasure deletes.
- **Hold and report kinds wait for T-504b.** In phase 1, no player sees another player's photo (FR-205), so there is
  nothing to unpublish. This is a deliberate deviation from the note at TASKS.md:323, recorded on T-504b.
- **Without storage settings the feature is off:** the `S3_*` variables are set all together or not at all (the Msegat
  pattern, config.ts:295-311). When they are not set, the builder keeps refusing `photo` and the upload door answers
  503 `storage_off`.

## 3. Changes

### 3.1 Storage module `apps/api/src/storage/` (new)
- `client.ts`: an `ObjectStore` interface with `put`, `delete` and `signGet(key, ttl)`. It is built on `aws4fetch`
  `AwsClient` with path-style URLs and its own `fetch`. Each call has a 10 s timeout (`AbortSignal.timeout`). It retries
  twice with jitter on network errors, 5xx and 429; PUT and DELETE are safe to repeat on the same key. Fallback: 503
  `storage_unavailable` to the client, and the worker keeps the row and backs off. Logs carry the key's purpose and the
  status only, never the key or a URL.
- `images.ts`: `reencode(buf)`. Magic-byte sniffing, then `sharp(buf, {limitInputPixels: 50_000_000, failOn: "error",
  sequentialRead: true}).rotate().resize(2048, 2048, {fit: "inside", withoutEnlargement: true}).flatten({background:
  "#fff"}).jpeg({quality: 82})`. sharp drops metadata unless asked to keep it, so EXIF and GPS go. Set
  `sharp.concurrency(1)` and `sharp.cache(false)`. A process-wide semaphore runs one image at a time with at most 4
  waiting; above that it answers 503 `busy` with Retry-After.
- `config.ts`: `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
- `worker.ts`: `startMediaWorker`, every 30 s, on the push worker's pool pattern (server.ts:70). It claims up to 50
  `media_delete` rows with `SKIP LOCKED` and a lease and deletes them **outside the transaction**. A 404 counts as done.
  It then calls `media_delete_done(ids)`. On failure, `media_delete_failed(id, code)` backs off from 1 minute to 1 hour.
  Every run also calls `media_sweep_uploads()` and `media_purge_due(500)`.
- `conventions.ts:87-92`: when the body is a Buffer, hash its bytes. The upload route can then use `idempotent: true`.
- `scripts/cranl`: add `buckets: 1` to `BUDGET`, with `live.buckets` counted in the project (observe.mjs:98-100), and
  send `region: spec.region` on `bucket.create`. If CranL ignores the region, `plan` reports a manual difference. Tests
  in infra.test.ts.
- `ops/cranl/staging.json`: `"buckets": ["questify-media-staging"]`. API variables: `S3_ENDPOINT`, `S3_BUCKET` and
  `S3_REGION` as plain values, the two keys as `{"secret": "operator"}`. Web: `MEDIA_HOST`, added to `img-src`
  (security-headers.ts:20, 57). Production stays `[]`.

### 3.2 Migration 0192 (storage; `SET LOCAL lock_timeout = '10s'`)
- `media_object`: `id` (uuid), `organizer_id`, `event_id`, `purpose` (`submission` or `ticket`; phase 2 widens this),
  `key` (unique, with a prefix CHECK), `state` (`reserved`, `stored`, `attached`), `bytes`, `width`, `height`,
  `uploaded_by_player`, `created_at`, `attached_at`. Composite tenant foreign key to `event (id, organizer_id)`. RLS
  forced, no grant.
- `media_delete`: `key`, `organizer_id`, `due_at`, `attempts`, `lease_until`, `last_code`. RLS forced, no grant.
- Internal `media_forget(key)` moves a key to `media_delete` and deletes its `media_object` row.
- Doors, each REVOKEd from PUBLIC and granted to `questify_app` alone, each calling `ensure_rehearsal_wiped`:
  - `media_reserve(event, purpose, request_key)`: the caller's seat must be valid for that purpose. At most 5 reserved
    or stored objects per player and event in 30 minutes (`MD429`). Returns the id and the key.
  - `media_stored(id, bytes, w, h)`.
  - `media_delete_claim`, `media_delete_done`, `media_delete_failed`.
  - `media_sweep_uploads()`: objects not attached after 30 minutes.
  - `media_purge_due(batch)`: approved photos 365 days after the event ends.

### 3.3 Migration 0193 (photo submissions)
- `submission`:
  - add `photo` (uuid foreign key to `media_object`, nullable, unique) and widen `kind` to `('text', 'photo')`;
  - CHECK `(erased_at IS NOT NULL OR kind = 'photo' OR body IS NOT NULL)` replaces :51;
  - an optional caption (≤ 300 characters) goes in `body`.
- `quest_submission_text_only` becomes `quest_submission_kinds`: `accepts` is `["text"]`, `["photo"]` or
  `["text","photo"]`. Changing `accepts` while the quest has submissions is refused (`submitters_of`, 0189:22).
- `submit_quest(target, body, guidelines, request_key, photo uuid)`, the new one: it re-checks that the photo is the
  caller's, `stored`, of this event and not yet attached, and that the kind is allowed (`SK422`). Then it sets
  `attached`. Same lock order as 0098:972. The 4-argument version stays, as a wrapper that passes NULL (older API during
  a deploy).
- One `BEFORE UPDATE OR DELETE` trigger on `submission` calls `media_forget(photo)` and sets `photo` to NULL when:
  - the status turns `rejected` or `removed`;
  - `erased_at` is set;
  - the row is deleted.
  This covers review, removal, `close_pending_submissions`, `erase_rows` and `wipe_rehearsal` without restating them.
  `ticket` gets `photo` too, with the same trigger on DELETE, which covers erasure, the wipe and
  `purge_ended_tickets`.
- DROP and CREATE again `queue_rows`, `event_submissions` and `operator_submissions` with `kind` and `photo_key`, plus
  `own_submissions` with `has_photo`. The exports (0103:152, 0129:344) gain `kind` only, never a key.

### 3.4 API, app, dashboard
- `POST /v1/quests/{id}/photo` (player, `Content-Type: image/jpeg|png|webp`, `bodyLimit` 8 MiB, Idempotency-Key, 20
  per player per 10 minutes). The order is: reserve, re-encode, PUT, then `media_stored`, answering `201 {photoId}`.
  Errors: 413, 415 `photo_type`, 422 `photo_unreadable`, 429, 503. `POST …/submit` takes `{text?, photoId?}`.
  `POST /v1/tickets` takes `photoId?` (purpose `ticket`).
- The queue reads add `photoUrl` and `photoExpiresAt`. The URL is signed only for rows the definer returned, with
  `response-content-type=image/jpeg`.
- App: `SubmissionEntry.tsx` gets a camera (`takePictureAsync`, quality 0.8) and the system picker (`expo-image-picker`
  with `photosPermission: false`; `blockedPermissions` keeps `READ_MEDIA_*`). Upload goes through
  `FileSystem.uploadAsync` as BINARY_CONTENT with the session's token, and through `fetch(Blob)` on web. The screen has
  preview, retake and progress states. Older apps get `submission_kind` and show "update the app". Also: operator
  `review.tsx`, and Get help's optional photo.
- Dashboard: `SubmissionsPanel.tsx` shows a thumbnail with a plain `<img>` (not `next/image`, which would serve the
  photo from our origin). A URL that expires is fetched again.
- Copy: Arabic and English through `ux-araby`. The camera text widens (app.json:88, locales, STORE_COMPLIANCE §2.7).

## 4. Phases inside phase 1
1a is 0192, storage and the fake. 1b is 0193, the routes, the app and the dashboard. There is one code review at the
end, then mutation on `storage/*` and the definers.

## 5. Tests (written first)
- `test/storage/fake-s3.ts`: an in-process `node:http` server for PUT, GET, DELETE and HEAD.
  - It checks SigV4 headers and presigned queries itself with `node:crypto`, not with `aws4fetch`, and refuses an
    expired or wrong signature with 403.
  - It can be told to be slow, to answer 500 or 503, or to drop the connection.
  - It is used by unit and integration tests in CI with no new service.
- `client.test.ts`: covers the timeout, two retries then a final failure, no retry on 403, DELETE treating 404 as
  done, and a signed URL refused after its expiry.
- `images.test.ts`, with fixtures:
  - a JPEG with GPS EXIF comes out with none;
  - orientation 6 is rotated;
  - 8,000 px becomes 2,048;
  - PNG with alpha is flattened;
  - HEIC gives 415, and a zip renamed `.jpg` gives 415;
  - a decompression bomb over the pixel limit gives 422;
  - semaphore overflow gives 503.
- `test/db/media.int.test.ts`:
  - the prefix CHECK;
  - reserve caps;
  - the sweep after 30 minutes;
  - the trigger queues a delete on rejection, removal, a system close, `erase_player`, `wipe_rehearsal`,
    `purge_ended_tickets` and a ticket delete;
  - `submit_quest` refuses another player's photo, another event's photo, an attached one and the wrong kind;
  - the purge at 365 days.
- `test/submissions/photo.int.test.ts`, end to end on the fake:
  - upload, submit, queue shows `photoUrl`, the fake serves it;
  - after a rejection the object is gone after one worker run;
  - an idempotent repeat stores one object.
- Security:
  - `outsider`: the new tables and functions are closed;
  - `cross-tenant`: organizer B's member and operator get no row and no URL for A's photo, and an A player cannot
    attach B's `photoId`;
  - `routes.int`: every new route declares `config.access`.
- `infra.test.ts`: covers the bucket budget and the region on create.
- Contract test (`S3_CONTRACT=1`, run by the coordinator): put, signed get, unsigned get returning 403, delete,
  against `questify-media-staging`.

## 6. Hand mutants (each must turn a test red)
- drop the prefix CHECK;
- remove the photo-owner check in `submit_quest`;
- trigger without the `erased_at` branch;
- trigger without DELETE;
- the worker deletes before the claim's transaction commits;
- remove `rotate()` or the metadata strip (add `withMetadata()`);
- `limitInputPixels` back to the default;
- the client retries on 403;
- the URL is signed for 3,600 s;
- the queue signs a key passed by the client.

## 7. Risks
- **CranL's S3 behaviour is unknown:** path-style versus virtual-host URLs, the signing region string, presigned
  queries, and whether new buckets are private by default. The contract test is the gate; the client keeps a
  virtual-host switch.
- **Bucket region:** apply.mjs:99 sends no region. Check `riyadh-1` in CranL before any real photo (PDPL), and record
  it in the RUNBOOK.
- **The budget may count account-wide:** if CranL bucket objects carry no project id, the bucket count includes
  `b7r-media`. Production then needs a plan check first.
- **Memory:** a 50 MP decode is about 200 MB with one image at a time. Measure the API container's RAM limit; drop to
  24 MP if it is tight.
- **Alpine image:** sharp must stay `--external:sharp` in esbuild, `pnpm deploy` must copy `@img/sharp-linuxmusl-x64`,
  and a smoke test in the image must re-encode a fixture.
- **Mobile uploads** of up to 8 MB on venue networks: the app sends at quality 0.8 (typically 1 to 3 MB) and a retry
  keeps its idempotency key.
- **Auto-approved photos** can show unmoderated content to the team only. A flag on photo quests asking for review is a
  product question; it goes to OPEN_QUESTIONS.

## 8. Docs
- ARCHITECTURE: object storage row and the media worker.
- SECURITY: threat 8, the secrets table (`S3_*`), the deny-by-default rows.
- API.md: the photo routes, errors and fields.
- DATA_MODEL: the two tables and the new columns.
- RUNBOOK: the bucket check, key rotation, a stuck `media_delete`.
- INTEGRATIONS and the data map: CranL buckets now store photos.
- STORE_COMPLIANCE §2.7.
- DECISIONS: Q-149 resolved, the change to ADR-185, ADR-186's interim purge.
- OPEN_QUESTIONS: Q-075 note, the auto-approve question.
- SRS FR-204 and FR-337; TASKS; STATE.

## 9. Phase 2: organizer images (one tier B batch on the same door)

There is one shared organizer door: `POST /v1/organizers/{o}/events/{e}/images?purpose=…` for owners and editors. It
reuses `reencode`, with PNG or WebP output for logos so transparency survives. Migration **0194** adds the `purpose`
kinds and the columns.

Players read organizer images through `GET /v1/events/{id}/images/{imageId}`. It answers a 302 to a 10-minute signed
URL (`Cache-Control: private, max-age=300`), so the app's image cache works on the stable `imageId`. Configuration and
layout keep only `imageId`s, never URLs. Deleting or replacing an image goes through `media_forget`.

- **T-305b (FR-1808):** `type_config.images` on a game quest (card faces, puzzle picture, falling items), checked by
  shared `quest_game_shape`. The engines take image ids and keep the default art when none are given.
- **T-504b (FR-635 to 637):**
  - migration **0195** (a scene kind is a migration): `submission.on_screen` (the player's choice per photo, FR-636);
    the organizer's picker of approved and allowed photos (FR-637); the `photo` scene in `big_screen_scenes_ok`
    (0083:50);
  - the `media` kind in `content_hold` and `content_report`, which holds by `media_object.id` (uuid);
  - `blocked_by_me` masking, and an entry in `player-name-reads.int.test.ts`;
  - the screen is a device seat, so this needs a new reader rule. This part touches tier A tenant isolation: review it
    as such.
- **T-506b (FR-820):** `event_map.image`, `width` and `height` (0087:17). The Maps page uploads the picture, and the
  board takes its aspect from it. Pins stay in thousandths.
- **T-507b (FR-1301, 1303, 1305):** `sponsor.logo` and `sponsor.banner` (0088:22). The logo replaces the lettered mark
  on "presented by", the strip and the category header.
- **T-602b (FR-1023):** `logo` and `banner` ids in `event.config.branding` (`readBranding`, accents.ts:34;
  `validateEventBranding`, validate.ts:127). They show on Home, the event card and the preview.
- **T-610b (FR-1829):** an optional `image` on slides and cards in `home-content.ts` (older apps drop the field),
  the dashboard field, and the app's `SlideFace`.
- **T-613b (FR-1835):** an `image` part kind in `info-content.ts`, `PageEditor.tsx` and the app's `PagePart`.
- **Not listed, now unblocked:** organizer images for vote options (ADR-190). Add it to TASKS.
- Common tests: outsider and cross-tenant on the image read (organizer B's id gives 404), an image of a suspended or
  archived event, and a layout that names an `imageId` from another event is refused with 422.

### Critical Files for Implementation
- /home/deploy/questify-app/apps/api/migrations/0040_submissions.sql (with 0098_live_points.sql:972, 0155:850, 0166:149)
- /home/deploy/questify-app/apps/api/src/submissions/routes.ts
- /home/deploy/questify-app/apps/api/src/conventions.ts
- /home/deploy/questify-app/scripts/cranl/apply.mjs (with ops/cranl/staging.json, observe.mjs)
- /home/deploy/questify-app/apps/app/src/event/SubmissionEntry.tsx

## 10. Plan review (CTO, 84) and decisions

The coordinator's decisions on the review; where they differ from sections 1 to 9, they win. Section 9 is a sketch, not approved scope.

1. **Delete by construction.** A BEFORE DELETE trigger on `media_object` inserts its key into `media_delete`; `media_object.event_id` is ON DELETE CASCADE; the `submission` and `ticket` triggers only delete the `media_object` row. `submission.photo` and `ticket.photo` are NO ACTION (or SET NULL), never RESTRICT. Test: a draft event with an unattached upload and a ticket photo is deleted, and both keys are queued.
2. **Purge everything.** `media_purge_due` purges every `media_object` (any status, any purpose) 365 days after its event ends. CHECK `(kind <> 'photo' OR status <> 'pending' OR photo IS NOT NULL OR erased_at IS NOT NULL)`. Specify the "photo deleted" state in the queue, the dashboard and the player history.
3. **Tickets.** Keep `ticket.photo` and its trigger in 0193. Ticket attach and reads become step 1c of this plan: `POST /v1/events/:eventId/tickets` (tickets/routes.ts:346) through `open_ticket`, shown by `event_tickets`, `operator_ticket`, `operator_inbox` (tickets.ts:512, 574, 651) and the escalated-ticket console view. Platform tickets (`/v1/me/tickets`) get no photo.
4. Definitions: the latest `export_submissions` is 0182:165 (paged, 4 arguments); 0129:344 already returns `kind`.
5. A Fastify content-type parser for `image/jpeg|png|webp` (`parseAs: 'buffer'`) in an encapsulated plugin. The contract test PUTs an 8 MB body through CranL's ingress.
6. App: `new File(uri).upload(...)` or `createUploadTask` (with progress), not `FileSystem.uploadAsync`. `expo-image-picker` loads through `requireOptionalNativeModule` (as `data-export-native.ts`), so `native-guards.test.ts` passes and OTA updates do not crash older binaries. Refresh the token before uploading.
7. HEIC: the picker uses `quality: 0.8` and, on iOS, `preferredAssetRepresentationMode: 'compatible'`. Check `asset.mimeType` before uploading, with clear copy. The server still answers 415 for anything else.
8. Races: the sweep locks with `FOR UPDATE SKIP LOCKED`; `submit_quest` locks the `media_object` row and re-checks its age under the lock; when `media_stored` finds the row swept, the route queues the key for deletion; on 415 or 422 after a reserve, the slot is released.
9. Scopes: a cross-tenant test with an editor scoped to event X gets no URL for event Y of the same organizer. The recreated readers keep `in_event_scope` and the admin re-checks of 0189 and 0191 (`(SELECT app_admin_id()) IS NOT NULL` in policies; the 0191 catalog test must stay green).
10. Bucket region: `observe.mjs` reads the bucket's region if the API exposes it; otherwise a manual check in the RUNBOOK.
11. Credentials gate before production: per-bucket or per-environment keys (CranL keys are probably account-wide). The contract test adds an unsigned list-bucket request that must answer 403.
12. Image: `pnpm deploy` copies `@img/sharp-libvips-linuxmusl-x64` too; `limitInputPixels` starts at 32 MP until the container's memory limit is measured.
13. The API tells the dashboard builder whether photos are available, so the shared `unavailableSubmissionKind` stops refusing `photo` unconditionally.
14. OPEN_QUESTIONS: whether a player's data request includes their photos (PDPL access right), and photos from players aged 13 to 17 (Q-042). A RUNBOOK procedure for Questify to delete one photo until T-504b adds the hold.
15. One per-player rate limit: the database cap `MD429` (drop the route's 20 per 10 minutes).
16. `response-content-disposition=inline`, `referrerpolicy="no-referrer"` on the dashboard `<img>`, and `Cache-Control: no-store` on queue reads that carry URLs.
17. Lock order, written in the migration header: `submission` → `media_object` → `media_delete`.
