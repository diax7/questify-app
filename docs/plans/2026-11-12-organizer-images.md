# Photo storage, phase 2: organizer images (A, tier B) and the photo wall (B, tier A)

I checked every file:line below against the phase 1 worktree `/home/deploy/questify-app/.claude/worktrees/agent-a83a50003c4f132a3` (8 commits ahead of the main branch, newest 7324917b). The OTA facts come from main (`apps/app/app.json:7-9`, `apps/app/eas.json:14,23`).

Five things I found that change the section 9 sketch:
1. **The dashboard would get a broken 302.** The web forwarder copies only the response headers in its list, and `location` is not among them (`apps/web/src/lib/forward-headers.ts:20-29`; it fetches with `redirect: "manual"` at `forward.ts:107`).
2. **Signed URLs cannot last 10 minutes.** `signGet` refuses anything over 300 s (`client.ts:46`), so the sketch's 600 s is not possible. It also always sets `response-content-type=image/jpeg` (`client.ts:170`), which breaks PNG logos.
3. **Duplicating an event would copy foreign image ids.** The copy takes `config` and `type_config` whole (`0107:852` `config = src.config`; `0121:1011`), so the copy would point at the source event's images.
4. **Organizer images do not fit the current table.** `media_object.uploaded_by_player` is NOT NULL (`0192:31`), and the key CHECK fixes `.jpg` (`0192:38`). Both need changing.
5. **Pictures in JSON settings cannot be held by a foreign key.** Branding, layout, game and vote settings can only name an image by id, so nothing in the database stops the image being deleted under them. Deleting them needs a sweep that looks for images nothing names (decision 3).

---

Source: T-305b, T-506b, T-507b, T-602b, T-610b, T-613b (`docs/TASKS.md:373,1253,1259,1295,1357,1369`), vote option images (ADR-190, `DECISIONS.md:2470`), T-504b (`TASKS.md:1239-1241`). FRs: 1808, 820, 1301/1303/1305, 1023, 1829, 1835, 635-637 (`SRS.md:753,404,555-559,491,774,780,321-323`). Phase 1 plan sections 9 to 11.

Migrations: **0194** (A) and **0195** (B). New ADRs start at ADR-829 and new questions at Q-767; check the newest numbers again before writing them. No new dependencies. The app uses React Native's own `Image`, as `PhotoField.tsx:3` already does, so no new native module is needed.

**Done when (A):** An owner or editor uploads a logo, banner, map picture, slide, card or page image, game art or vote option image. Players see it through `GET /v1/events/{e}/images/{imageId}`, which answers a 302 to a signed URL that lasts 300 s.
- A layout, branding, game, vote, map or sponsor that names another event's `imageId` is refused with 422.
- An image nothing names any more is deleted within 24 h plus one worker run.
- Without a bucket, every upload field is hidden, uploads answer 503 `photos_off`, reads answer 404, and older apps keep drawing the default art.

**Done when (B):** The photo wall shows only approved photos the organizer picked and the player allowed on screen. A withdrawal, rejection, removal, erasure, hold or ban takes the photo off the wall at the screen's next read. A player can report a wall photo in the app, and Questify can hold it.

**Order:** A: failing tests, then 0194 with the storage changes, then the read door and the forwarder, then the seven holders, then the dashboard and app. One code review, using the strongest model for the read door. B: plan review, failing tests, 0195, the screen, the app, one code review, then mutation.

## 1. Latest definitions (searched up to 0193)
| Object | Latest | Today |
|---|---|---|
| `media_object` | 0192:15-44 | purpose `submission`/`ticket` (:20); `uploaded_by_player` NOT NULL (:31); key CHECK ends `.jpg` (:38) |
| sweep / purge | 0192:309; 0193:394 | sweep takes every purpose that is not `attached`; purge takes all objects 365 days after the event ends |
| upload / sign | `storage/upload.ts`, `routes.ts`, `client.ts:46,170` | player-only (`asPlayer`); `signGet` ≤ 300 s, always `image/jpeg` |
| team gate | 0030:154 `award_event_of`; 0088:135 `sponsor_event_for_write` | scope checked; archived refused (SO409) |
| maps | 0087:17 table, :75 `map_team_item`, :147 `map_save`, :361 `member_maps` | no picture |
| sponsors | 0088:22, :88, :173 `sponsor_save`, :281 `member_sponsors`; 0143:63 `souvenir_presented_by` | lettered mark (`PresentedBy.tsx:21`) |
| branding | `accents.ts:34`; `validate.ts:127` (strictObject); `save-event-config.ts:120` | accent only |
| Home and page content | `home-content.ts:74,153` (`readSlide`); `info-content.ts:52`; `HomeBlocks.tsx:94`; `InfoSections.tsx:99` | text only; the lenient reader drops unknown keys and parts |
| game / vote | 0051:8 `quest_game_shape`; 0052:18 `quest_vote_shape`; `registry.ts:162,272` | strictObject in the builder; the app reads views, not configs |
| player game/vote reads | 0055:1046 `member_game`, :930 `member_vote` (RETURNS TABLE) | use a new side read instead of DROP and CREATE |
| event copy | 0160:279 `event_copy_setup`; 0107:852; 0121:1011; 0166:313 | copies config and type_config whole; the map and sponsor column lists leave out new columns |
| change sets | 0099:41 `change_set_item.body` | staged quest edits may name images |
| forwarder | `forward-timeout.ts:7` PHOTO_PATH; `forward-headers.ts:20` | 8 MB/90 s on photo paths only; no `location` |
| photos flag | `app.ts:454`; `organizers/routes.ts:383` (builder only); `home/routes.ts:110` | the event read has none |
| big screen | 0083:37 `big_screen_scenes_ok` (≤3 of ranking/community/poll), :61, :72 (offered :76), :143; 0114:502 `screen_event`; `screen/scenes.ts:5,11` | no photo scene |
| holds and reports | 0121:22 (kind :24), :83 (target_kind :87), :243 `report_content`, :395 `admin_republish`; 0176:92 `admin_unpublish`; 0171:171 `admin_report_resolve` | no `media` kind |
| masking | 0120:410 `blocked_by_me`; `player-name-reads.int.test.ts:12` (`SCREEN`) | |
| OTA | main `app.json:7-9` runtimeVersion `appVersion`; `eas.json:14,23` channel `demo` | JS updates reach every 1.0.0 binary |

## 2. Decisions (Proposed ADRs)
1. **Image kinds** (TS `IMAGE_PURPOSES` with the same list in a SQL CHECK):
   - `logo`: PNG, ≤ 512 px (event and sponsor logo);
   - `icon`: PNG, ≤ 512 px (memory faces, catch items, vote options);
   - `banner`: JPEG, ≤ 2048 px (event and sponsor banner, Home slide);
   - `picture`: JPEG, ≤ 1600 px (text or featured card, page part, puzzle picture);
   - `map`: JPEG, ≤ 2048 px.

   Each holder takes one kind. `reencodeFor(kind)` reuses the sniff step, the gate, the 32 MP limit, `rotate()` and the metadata strip. PNG keeps alpha (no `flatten`). HEIC is still 415.
2. **One upload door and two read doors, all event-scoped.**
   - **Upload:** `POST /v1/organizers/{o}/events/{e}/images?purpose=` (access `member`, so owners and editors), raw body, Idempotency-Key, answering `201 {imageId, width, height}`.
   - **Player read:** `GET /v1/events/{e}/images/{id}` (`player`).
   - **Team read:** `GET /v1/organizers/{o}/events/{e}/images/{id}` (`member`, for the dashboard's previews).
   - **How a read answers:** a 302 to `signGet(key, 300, type)` with `Cache-Control: private, max-age=240` and `Referrer-Policy: no-referrer`. Every refusal (another event, organizer, scope, a missing row, a suspended or archived event, no bucket) is one 404.
   - **Why the ids are stable:** a replacement is always a new `imageId`. The app's image cache keys on the stable API URL, and settings store ids only, never URLs.
3. **Deletion has two halves.** Map and sponsor pictures are columns with a composite foreign key to `media_object (id, event_id)`, `ON DELETE SET NULL (col)`. JSON holders are covered by `media_sweep_images()`: it deletes an organizer image whose `coalesce(used_at, stored_at)` is more than 24 h old and that `event_image_refs(event)` does not list.
   - `event_image_refs` takes every uuid-shaped string in `event.config`, the event's `quest.type_config` and pending `change_set_item.body`, plus the columns. Listing too much only keeps an image longer.
   - **The save race:** every save first calls `media_images_use(event, ids, purpose)`, which locks `FOR KEY SHARE`, sets `used_at` and refuses unknown ids with MI422, all inside the save's own transaction (`withRequestContext`). The sweep takes rows `FOR UPDATE SKIP LOCKED`, so a save in flight wins.
4. **Duplicating an event strips the image ids** with `media_refs_strip_event(tgt)`, called from a restated `event_copy_setup` (0160:279). The new event shows default art. Copying the objects goes to FOLLOWUPS.
5. **No bucket means everything is off:** `photos` is added to the dashboard's event read (`events/routes.ts:132`), and the fields hide. There are no rows, so `media_images_use` refuses any id. If a bucket is later removed, reads answer 404 and the art falls back.
6. **Older apps:**
   - Every change is JS only, so `eas update --channel demo` reaches all 1.0.0 demo binaries, and `native-guards` is unchanged.
   - A bundle that has not updated simply does not show the images: Zod `z.object` drops unknown keys, the layout readers drop unknown keys and parts, the game and vote views add fields, and organizer text stays required (vote option text and slide titles stay, and they are the alt text).
   - B: an old app sends no `onScreen`, which counts as false (the private choice).

## 3. Part A: tier B batch (migration 0194; `SET LOCAL lock_timeout='10s'`; lock order is holder, then `media_object`, then `media_delete`)

**0194 storage:**
- `media_object` changes:
  - widen the purpose CHECK with the five kinds;
  - add `format` (`jpeg`/`png`, default `jpeg`);
  - rebuild the key CHECK: `.jpg` or `.png` from `format`;
  - `uploaded_by_player` DROP NOT NULL; add `uploaded_by_staff` (staff_user, ON DELETE SET NULL) and `used_at`;
  - CHECK `(purpose IN ('submission','ticket')) = (uploaded_by_player IS NOT NULL)`;
  - UNIQUE `(id, event_id)`, and a unique index on `(uploaded_by_staff, request_key)`.
- New definers (PL/pgSQL, REVOKE PUBLIC, GRANT questify_app):
  - `media_image_reserve(event, purpose, key)`: `award_event_of`, refuses archived and suspended. Caps: 30 a staff member in 10 minutes, and 200 unreferenced images in an event (MD429).
  - `media_image_stored`, `media_image_release`: the staff seat, the caller's own slot; the swept-slot regex covers the organizer key shape.
  - `media_images_use`.
  - `event_image_key(event, id)`: `session_member` (0086:328), not suspended, row of this event, organizer kind, stored.
  - `team_image_key(event, id)`: `award_event_of`.
- Internal: `event_image_refs`, `media_refs_strip_event`.
- `media_sweep_uploads` restated to player purposes only. `media_sweep_images(500)` is new and called by `worker.ts:101`.

**API:**
- `storage/client.ts`: `put` and `signGet` take a content type.
- `storage/images.ts`: `reencodeFor`.
- New `storage/organizer-upload.ts`: shares the reserve, encode, put and stored steps with `upload.ts`, factored into one `storeUpload`.
- New `storage/read-routes.ts`: the two read doors.
- `storage/routes.ts`: the organizer upload under `ORGANIZER_PREFIX`.
- New `storage/image-refs.ts`: `useImages(client, event, refs)` maps MI422 to 422 `image_unknown {field}`.
- Errors in `auth/http-errors.ts`.

**Web forwarder:**
- `forward-timeout.ts`: PHOTO_PATH adds `/v1/organizers/[^/]+/events/[^/]+/images`.
- `forward-headers.ts`: pass `location` only on the two image read paths, and only when it starts with `https://${MEDIA_HOST}/`, which stops an open redirect.

**Dashboard:** one `components/ImageField.tsx`: file input (jpeg/png/webp), an 8 MB check, POST with a key, a preview through the team read door, Remove and Replace, and Arabic and English errors. It shows only when `photos` is true.

**App:** one `src/event/OrganizerImage.tsx`: React Native `Image` with `{uri: api/v1/events/{e}/images/{id}, headers: auth}`, `fallback` on error. Its accessibility text comes from the holder's text.

| Task | Schema and config | API | Dashboard | App |
|---|---|---|---|---|
| **T-602b** FR-1023 | `config.branding.logo/banner` (uuid, optional) | `validateEventBranding` and `readBranding` add them; `saveBranding` calls `useImages` (logo, banner); the composed config carries them | `EventBranding.tsx` (two ImageFields), `PreviewScreens.tsx` | `EventContext.tsx` exposes them; Home header logo and banner (`HomeBlocks.tsx`), `EventPill.tsx` logo |
| **T-610b** FR-1829 | `image?` on `BannerSlide`, `TextCard` and `featured` (`home-content.ts`; `readKeys` lists add `image`) | `saveLayout` (`save-event-config.ts:167`) collects them (banner for slides, picture for cards); the console's `questifyHome` refuses `image` (it has no event) | `BannerSlidesEditor.tsx`, `EventLayoutEditor.tsx`, `LayoutPreviewPane.tsx` | `SlideFace` (`HomeBlocks.tsx:94`): image behind a scrim with the title over it; cards |
| **T-613b** FR-1835 | part `{kind:"image", image, alt}` with alt required (`info-content.ts:52`) | same `saveLayout` path (picture) | `PageEditor.tsx` "Add image" | `PagePart` (`InfoSections.tsx:99`) |
| **T-506b** FR-820 | `event_map.image` with composite FK; restate `map_save` (0087:147; key absent keeps it), `map_team_item` (:75), `member_maps` (:361) adding `image {id,width,height}` | `maps` routes pass `image` through | `MapEditor.tsx`, `MapBoard.tsx` (aspect from width and height) | `MapsView.tsx:99`: the picture is the board, pins stay in thousandths |
| **T-507b** FR-1301/1303/1305 | `sponsor.logo`, `sponsor.banner` with FKs; restate `sponsor_save` (0088:173), `sponsor_team_item` (:88), `member_sponsors` (:281), `souvenir_presented_by` (0143:63, + `logo`, `eventId`) | `sponsors` schemas (`memberSponsorSchema`, `presentedBySchema`) | `SponsorsPanel.tsx` | `SponsorMark` (`PresentedBy.tsx:21`) shows the logo or keeps the letter; `SponsorStrip.tsx`; category header banner |
| **T-305b** FR-1808 | `type_config.images {faces≤10 \| picture \| items≤5}` by game; CHECK `quest_images_shape` (none for tap_rush) | registry `game` config; builder calls `useImages` (icon, picture); new `member_quest_images(quest, type)` (gate `play_quest`, 0042:215) merged into the game sheet | `GameFields.tsx` | `MemoryGame`, `SlideGame`, `CatchGame`: organizer art where given, default for the rest; labels "Picture N" |
| **Vote images** (ADR-190) | `options[].image?`; CHECK by jsonpath (uuid or absent) | registry `vote`; `useImages` (icon); `plays/votes.ts` merges `member_quest_images` | `QuestTypeFields.tsx` | `ChoiceList.tsx` (`VoteEntry`, `PollEntry`): thumbnail beside the text. Screen poll stays text only (FOLLOWUPS) |

The change-set apply path (`change-sets/quest-kind.ts`) calls the same `useImages`, and also clears the phase 1 FOLLOWUP about checking `photos` there.

**Tests (A):**
- `images.test` per kind (PNG keeps alpha, logo ≤ 512).
- `test/db/organizer-images.int`:
  - the key CHECK with `.png`;
  - the staff/player CHECK;
  - reserve caps; release; archived and suspended refused;
  - the sweep keeps a named image (config, type_config, pending change set, column) and deletes it 24 h after it is no longer named;
  - `SKIP LOCKED` against a save in flight;
  - the FK `SET NULL` on purge;
  - the copy strips ids.
- `test/storage/image-routes.int` on the fake S3:
  - upload and 302 (`Location` on the bucket host, signature valid, 300 s);
  - an idempotent repeat stores one object;
  - 503 without storage, and 404 on read without storage.
- Per holder in `events/layout`, `maps`, `sponsors`, `quests`, `plays/votes`: save, then the player reads it, then a replace leaves the old id unnamed.
- Security:
  - outsider: new functions closed, no table grants;
  - cross-tenant:
    - organizer B's member gets 404 on A's image through either path;
    - an editor scoped to X gets 404 for Y;
    - a player of X gets 404 for Y's image under X's path and Y's;
  - **a layout, branding, game, vote, map or sponsor naming another event's `imageId` (same organizer, and another organizer) gets 422**, and a direct database insert breaks the composite FK;
  - `routes.int`: `config.access` on every new route.
- Web: `forward-headers.test` (`location` passed only for the bucket host).
- App: `OrganizerImage` fallback.
- `e2e/layout-editor.spec` gains an image.
- Catalog suites: `personal-data-catalog` (`uploaded_by_staff`), `hot-path-plpgsql`, the SQL allowlist (no new `LANGUAGE sql` definer).

## 4. Part B: T-504b photo wall (tier A; migration 0195)

**0195:**
- `submission.on_screen boolean NOT NULL DEFAULT false`, with CHECK `kind='photo' OR NOT on_screen`.
- `submit_quest(..., photo_id, on_screen)` with 6 arguments; the 5-argument version becomes a wrapper that passes false.
- `own_photo_on_screen(submission, allowed)`: the player's own photo submission only. A withdrawal deletes its `photo_wall` row in the same transaction.
- `own_submissions` (0193:416) DROP and CREATE with `on_screen`.
- `photo_wall (event_id, organizer_id, submission_id PK → submission ON DELETE CASCADE, position, picked_by, picked_at)`:
  - composite tenant FK, RLS forced, no grant, at most 50.
- Internal `photo_wall_ok(s)`: all of the following, checked on every read:
  - approved, photo kind, `photo` set, `on_screen`, not erased;
  - enrollment active, player active;
  - not `content_held('media', s.photo)` and not `content_held('quest', s.quest_id)`.
- `event_wall_candidates(event, cursor, page)` (`award_event_of`, returns keys) and `set_photo_wall(event, ids, request)` (PW422 if not eligible; audited `photo_wall.update`, ids only).
- `big_screen_scenes_ok` (0083:37): add `photo`, at most 4. `big_screen_json` offers `photo` (:76). No row still means the three old scenes.
- **The device seat's reader rule:** `screen_photos()`, built on `screen_event()` (0114:502) and `screen_shut`. Up to 20 picked, eligible photos in order: `{mediaId, key, name}`, the name under the screen's name rule (as `screen_finale`). Never a player seat; never another event.
- `member_photo_wall(event)` (`session_member`; only while the photo scene is picked and the big screen is on): the same rows, leaving out `blocked_by_me(owner)` (0120:410).
- **Holds and reports:**
  - `content_hold.kind` adds `media` (`target_id` is the `media_object` uuid);
  - `content_report.target_kind` adds `media`;
  - restate `report_content` (0121:243): a photo currently on the reporter's event wall; the snapshot holds the quest title, no key;
  - restate `admin_unpublish` (0176:92), `admin_republish` (0121:395) and `admin_report_resolve` (0171:171) to accept `media`;
  - new `admin_report_media_key(report)` for the console.

**API:**
- `screen/scenes.ts` adds `photo`. After the database read, the cache fill signs each key for 120 s and removes the key from the answer.
- `GET/PUT …/events/{e}/photo-wall` (member).
- `GET /v1/events/{e}/photo-wall` (player).
- `PUT /v1/submissions/{id}/on-screen` (player).
- `POST …/submit` takes `onScreen`.
- The console report view signs the key.

**Web:**
- `[lang]/screen/page.tsx` and `BigScreen.tsx`: the photo scene; it drops any photo missing from the latest answer.
- `BigScreenPanel.tsx`: the picker (grid, pick, order, save).
- `SubmissionsPanel.tsx`: an "allowed on screen" badge.
- The console's reports page: `<img referrerpolicy=no-referrer>`.

**App:**
- `SubmissionEntry.tsx`: a "Show on the big screen" switch, off by default, shown only when the event's wall is on (`photoWall` on Home).
- The submission history lets the player withdraw.
- A new `PhotoWall.tsx` sheet from Home: the wall's photos, with Report (the UGC report path STORE_COMPLIANCE needs).

**Tests (B):** `test/db/photo-wall.int`:
- each `photo_wall_ok` branch removes the photo (pending, rejected, declined, withdrawn, erased, banned, held, quest held);
- the picker refuses ineligible ids.

Security:
- outsider;
- cross-tenant: a screen of event B reads none of A's photos; a station device gets DV401; organizer B's member gets no candidates;
- `player-name-reads`: `screen_photos` is `SCREEN`, `member_photo_wall` is `MASKED`, with a test that a blocker does not see the blocked player's photo;
- report, then hold, then gone from the screen and the app, then republish.

Also `screen/scenes.test` (keys never leave the API, URLs are 120 s), and the browser `big-screen.spec`.

**Hand mutants:**
- drop `on_screen` from `photo_wall_ok`;
- drop the hold check;
- drop `blocked_by_me`;
- `screen_photos` without `screen_event`;
- `set_photo_wall` without its eligibility check;
- the scene answer keeps `key`.

**Mutation targets:** `apps/api/src/screen/*.ts` and the new `storage/read-routes.ts`.

## 5. Risks
- **The app's token reaching the bucket:** if iOS sends `Authorization` on to the bucket after the 302, S3 refuses a request that carries both kinds of auth. The contract test adds a signed GET with a stray `Authorization` header. A device check is needed on both phones. Fallback: the read door also answers `Accept: application/json` with `{url, expiresAt}`, and only `OrganizerImage` switches to it.
- `ON DELETE SET NULL (col)` needs PostgreSQL 15 or later. CI runs 17; check CranL's version.
- The sweep reads every event's config; batch by events that have candidates, using an index on `(purpose, used_at)`.
- **A withdrawal on the wall:** a signed URL cannot be revoked. The 120 s URLs and the screen dropping missing photos keep its life short. Recorded.
- **Minors on a public screen (Q-042):** OPEN_QUESTIONS, with Dhia asked through AskUserQuestion; the default is the player's own choice. Also: whether data requests include photos (still open from phase 1).
- An audit revert can restore a reference to an image already deleted; the read answers 404 and the art falls back (documented).

## 6. Docs
- API.md: the three image routes, the photo-wall routes, errors.
- DATA_MODEL: the new columns and tables.
- SECURITY: the device reader rule, the open-redirect guard.
- RUNBOOK: the sweep, holding a photo (this replaces the phase 1 manual procedure).
- STORE_COMPLIANCE: UGC on the screen.
- SRS rows, TASKS (add the vote images task), FOLLOWUPS (object copy on duplicate, poll scene images, join-card logo), DECISIONS, STATE.

### Critical Files for Implementation
- /home/deploy/questify-app/.claude/worktrees/agent-a83a50003c4f132a3/apps/api/migrations/0192_media_storage.sql (with 0193_photo_submissions.sql)
- /home/deploy/questify-app/.claude/worktrees/agent-a83a50003c4f132a3/apps/api/src/storage/upload.ts (with client.ts, images.ts, routes.ts, worker.ts)
- /home/deploy/questify-app/.claude/worktrees/agent-a83a50003c4f132a3/apps/api/src/settings/save-event-config.ts
- /home/deploy/questify-app/.claude/worktrees/agent-a83a50003c4f132a3/apps/web/src/lib/forward-headers.ts (with forward-timeout.ts)
- /home/deploy/questify-app/.claude/worktrees/agent-a83a50003c4f132a3/apps/api/migrations/0083_big_screen.sql (with 0121_content_reports.sql, 0176_followups_batch.sql)
## 7. Part B plan review (CTO, 79) and decisions

The coordinator's decisions; where they differ from section 4, they win. Part B is built after Part A is merged (0195 after 0194).

1. **B1, tie a pick to its event.** 0195: `CREATE UNIQUE INDEX submission_id_event ON submission (id, event_id)`; `photo_wall` has `FOREIGN KEY (submission_id, event_id) REFERENCES submission (id, event_id) ON DELETE CASCADE`; `photo_wall_ok` checks `s.event_id = ev.id`. Tests: `set_photo_wall` with another event's id (same organizer, other organizer) is PW422, and a direct insert breaks the FK. Mutant: drop the event match.
2. **M1, holds and reports at the real switch points.** Restate with a `media` branch: `hold_target` (0121:329; locks the `media_object` row FOR UPDATE), `report_event` (:155), `report_snapshot` (:126; the quest title only), `report_target_seen` (:172; the photo is on the reader's current wall), `console_report` (0130:640ff), `admin_report_resolve` (0171:186), and `report_content`, `admin_unpublish`, `admin_republish`. Code: `packages/shared/src/reports/reports.ts` (`REPORT_KINDS`, `HOLD_KINDS`), `apps/web/src/lib/console-reports.ts:122`. Test: unpublish a media target, gone from screen and app, republish.
3. **M2, stable URLs.** Sign against a time floored to the minute with a 120 s TTL, so a URL is identical within the minute; answers carry `expiresAt`; the screen keys photos by `mediaId` and keeps a loaded image until its id leaves the answer. Test: two reads in one minute give identical URLs.
4. **M3, the app's read.** `GET /v1/events/{e}/photo-wall` signs each key (≤ 120 s, floored as above), drops `key`, `Cache-Control: no-store`. Mutant: the answer keeps `key`. Mutation targets add the photo-wall routes.
5. **M4, the in-app wall (Proposed ADR amending ADR-054 and ADR-068; Dhia may override).** Keep the sheet (it is the report path), but: the switch copy names both places ("on the big screen and on the event's photo wall in the app", ux-araby for Arabic); each photo offers Report and Block (`BlockButton` by username, as `PublicProfileScreen.tsx:61`); `member_photo_wall` refuses when `screen_shut(ev)` is not null; STORE_COMPLIANCE note and the age-rating social answer re-checked (§1.14).
6. **M5, no full names.** The photo wall never shows a full name whatever the event's name rule: the screen shows no name; the app shows the username only (for Block). `screen_photos` leaves the name map; `member_photo_wall` stays MASKED. Reopen Q-766 with the new premise; the interim rule is the player's own per-photo choice (ADR-084); ask Dhia and counsel.
7. **M6, consent door tests.** `own_photo_on_screen` on another player's or another event's submission is 404; a text submission is refused; off deletes the `photo_wall` row; on again does not restore it without a new pick; a submit from an old app stores false. Mutant: no ownership check.
8. Minors: lock order (`set_photo_wall` locks submissions FOR SHARE in id order then writes; `own_photo_on_screen` locks FOR UPDATE then writes; in the header); one cap of 20 picks; list-style suites (personal-data-catalog, hot-path-plpgsql, definer allowlist, routes.int access for the four routes, rehearsal-wipe classification of `photo_wall`; `on_screen` in `data_export_account`); `report_content` for media takes the `media_object` id and answers RP404 once off the reader's wall (API.md); with no bucket the photo scene answers an empty list (test). Name the test branch "not allowed"; FOLLOWUP to drop the 4- and 5-argument `submit_quest` once no old API can call them.

## 8. As built (Part A, 2026-11-12)

**Built:** sections 2 and 3: migration 0194 (kinds, format, uploader, `used_at`, the composite keys on `event_map` and
`sponsor`, `quest_images_shape`, the upload, naming, read and sweep doors, the restated map, sponsor, souvenir and copy
functions, `media_stored` and `photo_to_attach` with `IS DISTINCT FROM`), `storage/organizer-upload.ts` over a shared
`storeUpload`, `storage/read-routes.ts`, `storage/image-refs.ts`, the forwarder's `location` guard, the seven holders
in the API, the dashboard (`ImageField`, `ImageScope` from the event's frame) and the app (`OrganizerImage`). Part B
(section 4, 0195) is not built.

**Deviations from sections 2 and 3:**
- The read doors also answer `Accept: application/json` (without `image/`) with `{url, expiresAt}`, and the app uses
  that form from the start (section 5's fallback): its client always asks for JSON, `fetch` follows a redirect with its
  headers, and the session does not expose the token for `Image` headers.
- `media_images_use(event, ids, kinds, fields)` takes the field names, so MI422's detail is the field the API answers
  with; it UPDATEs `used_at` (the row lock the sweep's SKIP LOCKED sees) rather than taking `FOR KEY SHARE`.
- The sweep marks a still-named image used, so it is looked at again a day later instead of every run.
- `media_image_reserve` answers the stored size too, so a repeated key answers `{imageId, width, height}`.
- The quest CHECK's pure helpers are granted to the API role (the builder writes quests in its seat).
- Branding's `logo` and `banner` keys are left out when empty, so stored and composed branding without images is
  unchanged for older readers.
- The dashboard's previews and the live poll card draw no pictures (FOLLOWUPS); the event banner shows at the top of
  Home, the logo in the event pill.

## 9. As built (Part B, T-504b photo wall, 2026-11-12) and hand mutants

**The Part B plan** is section 4 with section 7's decisions (which win), both above and unchanged.

**Built:** migration 0195 (`submission.on_screen` with its CHECK, the unique `(id, event_id)` key, `photo_wall` with the
composite key to it, `photo_wall_ok`, the release trigger `submission_wall_forget`, `submit_quest` with six arguments and
the five-argument wrapper storing false, `own_photo_on_screen`, `own_submissions` with `on_screen`, the team's
`event_wall_candidates`, `event_photo_wall` and `set_photo_wall`, `screen_photos`, `member_photo_wall`,
`member_photo_wall_on`, the `photo` scene (`big_screen_scenes_ok` up to four, offered by `big_screen_json`), the `media`
hold and report kind through `hold_target`, `report_event`, `report_snapshot`, `report_target_seen`, `report_content` and
`admin_report_resolve`, `admin_report_media_key`, and `data_export_event_play` with `onScreen`); the API
(`src/screen/photo-wall.ts`, the photo scene signed in the scene reader, the picker and the player routes,
`stableWallUrl`, `photoWall` on Home and on the player's submissions, the console's reported photo); the web (the
`PhotoScene`, the `PhotoWallPanel` picker on the Big screen page, the console report's photo); the app
(`OnScreenSwitch` at the send and afterwards, `PhotoWallEntry` on Home with Report and Block). ADR-830; Q-766 reopened.

**Deviations from sections 4 and 7:**
- The consent door is `PUT /v1/events/{e}/submissions/{id}/on-screen` (event-scoped, so the suspension wall needs no new
  derived param) and `own_photo_on_screen(event, submission, allowed)` takes the event; another event's id is PW404.
- `admin_unpublish`, `admin_republish` and `console_report` are not restated: their only kind rule is `hold_target`'s,
  and `console_report` reads the snapshot, event and hold through the restated helpers. `admin_report_media_key(media)`
  takes the media id (it answers a key only for a photo someone reported).
- The cap is one: 20 picks, and the screen and the app show at most 20 (section 4's 50 dropped, section 7 (8)).
- Without a bucket the dashboard is not offered the photo scene (`offered` drops it) and the scene answers
  `{shut: null, photos: []}`; Home's and the send form's `photoWall` are false and read nothing.
- The dashboard's queue does not show an "allowed on screen" badge yet (it needs `queue_rows` restated; FOLLOWUPS); the
  picker lists only allowed photos.
- Section 7 M2: the screen keeps a photo's first loaded URL while its id stays in the answer (`keptPhotos`); the
  member read is `no-store`, each URL lasts 60 to 120 seconds (signed from the minute's start).

**Hand mutants** (`.scratch`-style runner: each edit alone, its suite, then restored):

| Mutant | File | Result | Test |
|---|---|---|---|
| drop `on_screen` from `photo_wall_ok` | 0195 | killed | `test/db/photo-wall` "refuses a photo that is not eligible" |
| drop the `media` hold check | 0195 | killed | "the photo held by Questify, back after a republish" |
| drop the quest hold check | 0195 | killed | "the quest held by Questify" |
| drop the active enrollment and player check | 0195 | killed | "banned player", "left the event" |
| drop `blocked_by_me` | 0195 | killed | "hides a photo of a player the reader blocked" |
| `screen_photos` without `screen_event` | 0195 | killed | "reads its own event only" and the rule cases |
| `set_photo_wall` without its eligibility check | 0195 | killed | "pending is never eligible", "ties a pick to its event" |
| `own_photo_on_screen` without the ownership check (M6) | 0195 | killed | "is the player's own photo submission of that event only" |
| a withdrawal keeps the pick | 0195 | killed | "not allowed: the player withdrew" |
| `member_photo_wall` without `photo_wall_live` | 0195 | killed | "refuses while the photo scene is not running" |
| a `media` report without the on-wall rule | 0195 | killed | "reports a photo on the reader's wall ... RP404 once it is off" |
| the scene answer keeps `key` (M3) | `screen/photo-wall.ts` | killed | `photo-wall.test` "drops each key" |
| wall URLs signed from now, not the minute (M2) | `storage/signed.ts` | killed | `photo-wall.test` "one URL within a minute" |
| drop the event match in `photo_wall_ok` alone (B1) | 0195 | survived (equivalent: every caller also matches the event, `set_photo_wall`'s lookup and the readers' `w.event_id`) | - |
| drop the event match in `set_photo_wall`'s lookup alone | 0195 | survived (equivalent: `photo_wall_ok` refuses it) | - |
| drop both event matches (B1) | 0195 | killed | "ties a pick to its event" |

14 of 16 killed; the two survivors each stand in for the other (defence in depth), and dropping both is killed.

**Mutation targets for `mutation.yml`:** `apps/api/src/screen/*.ts`, `apps/api/src/storage/signed.ts`,
`apps/api/src/storage/read-routes.ts`. The SQL is held by the database tests above.
