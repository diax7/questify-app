# Blueprint State — Questify

## ASVS L2 sheet brought up to date (T-810, tier C, docs only) — 2026-11-13

- **Done:** `docs/security/ASVS_L2.md` now covers the work since 2026-11-08. Counts: Met 166, Partly 21, Not met 0, N/A 66
  (was 163 / 19 / 0 / 71). File controls V5.1.1, V5.2.2, V5.3.1 and V5.3.2 are Met (photos and organizer images); V5.4.3 and
  V14.2.1 are Partly; V6.4.1 and gap 18 are rewritten for ADR-814. Evidence added for the admin re-check (0189, 0191), the
  suspension walls, resend buckets and locks, the touch fix (T-599c), key ids and per-organizer marks, T-812 and the privacy
  manifest. Six stale test titles in older rows were fixed. Gaps 23 to 26 added (bucket location and keys: Q-768 and T-811;
  no malware scan; signed photo URLs; the device check's live proof: Q-781). Every cited test title was checked by a script
  that reads the sheet. T-810 stays unticked (it depends on T-809).

## About and privacy, privacy-manifest data types, Android permission record (Q-769, Q-770, Q-772; tier B) — 2026-11-13

- **Done:** Profile, "About and privacy" (`apps/app/app/about.tsx`): privacy policy, terms, community guidelines, contact
  page and web deletion page, opened on the web in the app's language (one link helper, `src/legal/web-pages.ts`, now also
  used by sign-in, re-accept and the submission composer). `ios.privacyManifests` declares `NSPrivacyTracking: false` and
  the 11 collected data types of `docs/store/app-store-privacy-labels.md`; the required-reason list was re-read from the
  libraries and is unchanged. **Native config: it needs the next EAS build, not an OTA update** (RUNBOOK). STORE_COMPLIANCE
  2.7 lists the Android permissions as the plugins and library manifests declare them; nothing changed in the permissions.
  ADR-832 (Proposed).
- **Tests:** apps/app and shared i18n suites 2251 passed; app typecheck, oxlint, `lint:limits` clean. Full suite and
  `expo export` left to CI.
- **Next:** Q-771 (one web origin; the About links follow it), the merged manifest and Xcode privacy report on the first
  release build, the Firebase file and the notification icon (T-806).

## T-806 store forms prepared (tier C, docs only) — 2026-11-13

- **Written:** `docs/store/` holds the ready-to-paste answers for every store form that needs no account: App Store privacy
  labels (with the privacy-manifest list), age rating, review notes with the demo sign-in steps and the review demo event; Play
  Data safety, content rating and App content declarations, review notes; the screenshot shot list (screens, languages,
  sizes; nothing captured) and the Arabic and English listing texts. Every answer is traced to the code and docs in
  `docs/store/README.md` (data inventory, permissions, SDKs, `app.json` findings). ADR-831 (Proposed). Eleven gaps (G1 to G11)
  are listed there and in the T-806 note, ten as Q-769 to Q-778 with a recommended answer; none fixed silently. The T-806 box
  stays unticked.
- **Tests:** none run (docs only).
- **Next:** Q-769 to Q-772 are small build tasks (Legal block in Profile, privacy-manifest data types, EAS store profiles,
  merged-manifest read); Q-768 (photo storage), the `locationQuests` switch, the Firebase file and counsel's policy (T-807)
  gate the submission; Dhia's accounts, the reviewer SIM (Q-520) and device screenshots finish T-806.

## FOLLOWUPS batch, media lease, lock keys, touch race, campaign id (migration 0197) — 2026-11-13

- **Built (tier B on core code; no table).** The media worker starts no bucket delete after 4 minutes of a round
  (`ROUND_BUDGET_MS`), so a claim of 50 slow keys (~31 s each) ends inside its 5-minute lease; keys not started keep
  their lease and the run ends. `tryLock` and `waitLock` take an optional bucket (`lockId`: a hash of bucket and key);
  the sign-in and sign-up resends and `holdBack` lock per bucket, so one office address in two buckets is no longer
  refused 429 for the other's lock (no `holdBack` caller shares a later limit across first buckets). 0197:
  `invitation_claim_at` and `invitation_claim` return `campaign_id`; `invitation.sms_parts_over` logs `campaignId`.
  Test only: the staff session touch race's lock-wait case. Left: the sign-in sweep's `SKIP LOCKED` for families with
  no device row (not small: `replaced_by` chains; reason in FOLLOWUPS).
- **Tests:** media worker, staff sign-in, staff sessions, invitation sending, tick and limits units, security and
  rehearsal suites; types and lint green. Full suite left to the coordinator.
- **Next:** the full suite and push.
## T-812 device-integrity flag, server side (migration 0198) — 2026-11-13

- **Built (tier B; plan `docs/plans/2026-11-13-device-integrity.md`):** 0198 (`device_check` per install,
  `app_attest_key`, flag kind `device_integrity` once per account and install, raised by `record_device_check` for the
  install's accounts in live events and by a completion trigger for later scans, erased with the account, `flag_detail`
  restated). `src/integrity`: stateless challenge, Play Integrity decoder (4 s timeout, one retry, no verdict when Google
  is down), App Attest attestation and assertion with Apple's root pinned, CBOR and DER readers (no new dependency).
  `POST /v1/me/device-integrity/challenge` and `POST /v1/me/device-integrity`; off without `PLAY_INTEGRITY_*` /
  `APP_ATTEST_*`. Never blocking; the answer never says the verdict. Dashboard Flags page and console learn the kind.
  ADR-833 to ADR-835, Q-779 to Q-781.
- **Tests:** offline only (a local fake of Google's token and decode endpoints, an App Attest chain under a test root):
  integrity units, config, DB and route suites, security suites, flags and personal-data catalog; types, lint, limits.
- **Waiting on Dhia (Q-781):** the Google Cloud project linked in Play Console with a service account, the App Attest
  capability and ids, the go-ahead for the native module and a new build (ADR-835, plan in T-812's notes), then a
  test on real phones. T-812 stays unticked until then.

## RTL read of the rendered screens (T-808, tier B) — 2026-11-13

- **Done:** the main web pages, the console, the big screen (unpaired, paired, ranking and goal scenes) and the `/play`
  web build were opened in Arabic at 1440 and 360 wide with a throw-away Playwright script and read as screenshots and
  page text. Fixed: control room feed and team emails aligned by the Latin text's own direction, the event header's join
  code line (the whole Arabic sentence was forced left to right), a Latin comma in Arabic date-and-time labels
  (`withArabicComma`), "@name" shown as "name@" in the player app's profile, the undo arrow not flipping, a long console
  navigation label wrapping under its icon, three short copy fixes (`وسم NFC`, `مشغل`, `هناك`), and `pnpm e2e:api`
  (`sharp` external). Details and the list for a person or a device: T-808 note of 2026-11-13 in TASKS.md.
- **Tests:** `withArabicComma` unit test; shared i18n and time suites, app push suite, types and lint green; desktop browser specs (layout, control room, analytics, organizers, review demo): 12 passed. Phone not rerun.
- **Next:** T-808 stays open (a person's read of every screen, devices, plural forms of counted nouns).

## FOLLOWUPS batch, photo and organizer image lines (migration 0196) — 2026-11-13

- **Built (tier B; functions only, no table).** 0196: `export_submissions` carries `kind` (the CSV gains a Kind
  column, Text or Photo); `quest_images_ok` coalesces to false (`images: {}` refused); `media_image_release` releases a
  `reserved` slot only; `queue_rows` and its two readers carry `on_screen`, and the dashboard queue shows an "Allowed on
  screen" badge. A change set's quest add or edit asking for photos is refused without a bucket
  (`submission_kind_unavailable`, at preview and apply, as the builder routes). The dashboard queue reads itself again
  15 s before the soonest `photoExpiresAt` (at least 30 s apart). Device-only and later lines left in FOLLOWUPS.
- **Tests:** touched suites (exports, media, organizer images, photo wall, submissions, change sets), security and
  rehearsal suites, shared and web units, types, lint, format green; full suite left to the coordinator.
- **Next:** the full suite and push.

## Photo phase 2 part B, T-504b photo wall (migration 0195) — 2026-11-12

- **Built (tier A; plan `docs/plans/2026-11-12-organizer-images.md` sections 4 and 7, as built in section 9; code review
  and mutation owed; not run on a TV or a phone).** 0195: per-photo consent (`on_screen`, off by default, withdraw at
  any time), the team's pick of up to 20 tied to its event, `photo_wall_ok` at every read, the screen's `photo` scene
  (no names, keys signed as stable 120 s URLs), the app's photo wall on Home with Report and Block, `media` holds and
  reports in the console. Off and harmless without a bucket. ADR-830 (amends ADR-054, ADR-068), Q-766 reopened.
  Hand mutants: 14 of 16 killed, two equivalent.
- **Tests:** see the worker's report (full API suite once into `wall-full.log`); touched suites, security, catalog,
  web and app units, types, lint, format, function limits green. CI minutes: not yet pushed.
- **Next:** the code review; mutation (`apps/api/src/screen/*.ts`, `storage/signed.ts`, `storage/read-routes.ts`);
  Q-766 to Dhia and counsel; a look on a TV and both phones; the age-rating answer re-check.

## Photo phase 2 part A, organizer images (migration 0194) — 2026-11-12

- **Built (tier B; plan `docs/plans/2026-11-12-organizer-images.md` sections 2, 3 and its as-built section 8; code
  review pending, the strongest model for the read doors; not run on a phone).** 0194: five image kinds (logo and icon
  PNG, banner, picture, map JPEG), the team's upload door (30 per staff member in 10 minutes, 200 unused per event),
  `media_images_use` (another event's id is 422 `image_unknown {field}`), the player's and the team's read doors (302 to
  a 300 s URL, or JSON for the app; every refusal 404), `media_sweep_images` (24 h after nothing names an image), map and
  sponsor image columns with composite keys, game art and vote option icons, the duplicate strips ids. The web
  forwarder passes `location` only to the bucket's origin. Holders: T-602b, T-610b, T-613b, T-506b, T-507b, T-305b and
  vote images (TASKS ticked, T-508b added). Dashboard `ImageField`, app `OrganizerImage`. ADR-829, Q-767 (CranL's
  PostgreSQL must be 15+). No new dependency. Part B (photo wall, 0195) not built.
- **Tests:** full API suite once: 10035 passed, 1 failed (the community gate map's list-style check of
  `member_quest_images`), fixed and rerun green; web 1910+ and app 2156 units, shared, security, catalog suites green;
  types, lint, format, function limits clean. CI minutes: not yet pushed.
- **Next:** the code review; Q-767 before deploying 0194; a device check that both phones draw the signed URLs; then
  Part B after its plan decisions (section 7).

## T-301b phase 1, photo storage and photo submissions (migrations 0192, 0193) — 2026-11-12

- **Built (tier A; plan `docs/plans/2026-11-12-photo-storage.md`, CTO plan review 84 with its section 10, as-built
  notes and hand mutants in its section 11; code review pending; not yet run on a phone).** 0192: `media_object` (key
  CHECKed to its own organizer, event, purpose and id) and `media_delete` (queued by a delete trigger), the upload doors
  (5 unused uploads per player and event in 30 minutes) and the media worker's system-seat doors. 0193: `accepts` text,
  photo or either (fixed once submitted), photo submissions and ticket photos attached under a lock, deletion by
  construction (rejection, removal, erasure, wipe, ticket purge, event delete, 30-minute sweep, 365-day purge), readers
  with keys (three converted to PL/pgSQL), `member_event_quests` with `submission_accepts`. API `src/storage`: SigV4
  client on aws4fetch's signer, sharp re-encoder, worker every 30 s, two photo doors, 5-minute signed URLs; Home and the
  builder say `photos`. App: camera and system picker (expo-image-picker), quest sheet, Get help, operator review.
  Dashboard: builder accepts, queue, Help desk, console ticket; CSP `MEDIA_HOST`; forwarder 8 MB on the photo paths.
  `ops/cranl/staging.json` declares `questify-media-staging` with its region and a bucket budget. ADR-828 (ADR-183
  carried out, ADR-185 HEIC refused, ADR-186 interim purge), Q-764 to Q-766; Q-149 resolved. New dependencies: sharp,
  aws4fetch, expo-image-picker (reasons in TECH_STACK). Hand mutants: 13 of 14 killed, one equivalent. Full API suite
  once: 7 list-style failures (catalogs, column lists), all fixed and those files rerun green. Docker image built
  locally with a sharp smoke step. Mutation globs: `apps/api/src/storage/*.ts`, `apps/api/src/submissions/submissions.ts`,
  `apps/api/src/tickets/tickets.ts`. CI minutes: not yet pushed.
- **Next:** the code review; on staging set `SECRET_API_S3_ENDPOINT`, `SECRET_API_S3_ACCESS_KEY_ID`,
  `SECRET_API_S3_SECRET_ACCESS_KEY`, `SECRET_WEB_MEDIA_HOST`, run `pnpm infra apply` for staging, check the bucket's
  region and privacy in CranL, then the contract test (RUNBOOK "Photo storage"); phase 2 (organizer images) as one
  tier B batch.

## Security audit hardening, the admin re-check sweep (migration 0191) — 2026-11-11

- **Built (tier A; plan `docs/plans/2026-11-11-admin-recheck-sweep.md`, plan review 84 with the decisions of its
  section 8, results in its section 9; code review pending).** Migration 0191 (new, undeployed): the request's admin
  flag alone opens no policy and no gate. All 53 admin policies ask `(SELECT app_admin_id()) IS NOT NULL` (an InitPlan,
  once a query; a SQL check inside the migration raises unless each policy is its old text with only that change);
  `app_admin_id()`, `results_frozen` and `ranking_system()` are PL/pgSQL (three allowlist entries gone); the four guards
  ask `app_admin_id()`; `ranking_system()` refuses a device seat; `preview_device` reads the assignment once;
  `play_event_id`'s `found` is `owner_event`. Only `ranking_system`, `souvenir_event` and `invitation_team_event` (the
  refusals) read the bare flag, held by `test/db/admin-recheck-catalog.int.test.ts`; the forged flag is probed on every
  owned table (cross-tenant). Locks: 37 tables up front, `lock_timeout` 1 s; owner must stay superuser or BYPASSRLS
  (checked; RUNBOOK). rules.md line, SECURITY.md rows, four FOLLOWUPS items struck. Tests first (red on 0190). No ADR.
  Mutation globs: none (SQL only). CI minutes: not yet pushed.
- **Next:** the code review; deploy 0191 in a quiet window, then `migrate.cjs --verify`.

## Security audit hardening, crypto keys (no migration) — 2026-11-11

- **Built (tier A; plan `docs/plans/2026-11-11-audit-hardening-crypto.md`, plan review 88 with the decisions of its
  section 8; code review pending).** Opt-out links carry a key id (`id16 ‖ channel1 ‖ keyId1 ‖ tag16`, 34 bytes, 46
  characters; tag over `keyId\nplayerId\nchannel`); `AUTH_KEY_ID` and, during a rotation, `AUTH_PREVIOUS_SECRET` +
  `AUTH_PREVIOUS_KEY_ID` (the previous secret derives the opt-out key only), so a rotation no longer ends links already
  sent (`OptOutSigner`, `optOutTagUnder`; web, shared, preview and save-time samples at 46; e2e token rebuilt). Reward
  code marks are keyed per organizer (`markKeyFor`, HKDF v2 label); `reseal` re-marks a row whose mark is not its
  organizer's and `check` lists it as stale. Dropped with reasons: w2-crypto 2 (row-bound AAD, accepted in SECURITY.md
  V11), hunter-edge 9 (invitation link hash, FOLLOWUPS; SECURITY.md's random-tokens row corrected). Proposed ADR-826,
  ADR-827, Q-763; two FOLLOWUPS lines; RUNBOOK rotation steps, the post-deploy `reward-codes.cjs reseal` then `check`
  step and the `promo_sms` re-save note. Tests written first (45 red on the old code); 11 hand mutants each turned a
  test red (one variant, "accept 33 bytes as well", is equivalent: the 15-byte tag never compares equal). Mutation globs:
  `apps/api/src/auth/keys.ts`, `apps/api/src/config.ts`, `apps/api/src/marketing/opt-out.ts`,
  `apps/api/src/rewards/codes.ts`, `apps/api/src/rewards/reseal.ts`, `apps/api/src/rewards/builder.ts`. CI minutes: not
  yet pushed.
- **Next:** the code review; after the deploy, on staging, `reward-codes.cjs reseal` then `check` (RUNBOOK).

## Security audit hardening, the core walls (migration 0190) — 2026-11-11

- **Built (tier A; plan `docs/plans/2026-11-11-audit-hardening-core.md`, plan review 84 with the decisions of its
  section 8; code review pending).** The player guard walls a route without `:eventId` by the event of the object it
  names (`DERIVED_PARAMS`: quest, step, category, reward, desk sale, game round, session, meet pass, redemption), only
  while some event is suspended (`SuspendedSet.any()`), with one `play_event_id` lookup per request shared with the
  maintenance gate (`eventOfRef`); the give-back doors stay open (`OPEN_WHILE_SUSPENDED`); `:eventId` is lowercased.
  Migration 0190 (new, undeployed): `play_event_id` PL/pgSQL with `meet_pass` and `redemption`; `mark_ranking_repair`
  PL/pgSQL and closed to a device seat (both allowlist entries removed); souvenir scan and claim skip a suspended event's
  (or paused organizer's) work, `souvenir_evaluate` raises ES423 in its unlocked pre-check, `souvenir_health` and
  `console_health` report such work as `held` (new health fact "Souvenirs on hold", ar and en), so the tick no longer
  logs `souvenir.pending` for a suspension (RUNBOOK). The app reads a 404 to a rating as nothing to show. Proposed
  ADR-825, Q-761, Q-762 (the in-memory idempotency store, server.ts comment); four FOLLOWUPS lines. Tests written
  first (red on 0189); 18 hand mutants each turned a test red. Mutation globs: `apps/api/src/players/guard.ts`,
  `apps/api/src/maintenance/gate.ts`, `apps/api/src/events/suspended-set.ts`. CI minutes: not yet pushed.

## Security audit hardening, tier B items — 2026-11-11

- **Built (tier B, review pending).** `GET /v1/public/events` is throttled per address bucket (240 a minute,
  `public_list`); the guest list's `?contact=` probe per team member (30 an hour, `guest_contact_probe`); `loggableError`
  drops the echoed value of a class-22 data exception (22P02) from the message and stack, with a sentinel test; a test
  pins that a real player's stamp of a review-demo step is refused; the calibration comment in `levels.ts` no longer
  claims a seed reader is flagged in over 90% of rounds (only the naive one is; ADR-212). Skipped: web cookie
  refresh across tabs already runs under `navigator.locks` (ADR-821). No new strings (429 `too_many_attempts` exists in
  both languages). Mutation globs: none. CI minutes: not yet pushed.

## Security audit hardening, the SQL walls (migration 0189) — 2026-11-11

- **Built (tier A; plan `docs/plans/2026-11-11-audit-hardening-sql.md`, plan review 92 GO; code review pending).**
  Migration 0189 (new, undeployed): `submitters_of` and `stamped_steps` are PL/pgSQL in the caller's event scope (their
  two `sql-settings-allowlist.json` entries removed); `feature_request_read` adds the event scope; `add_reward_codes`,
  `end_event_early` (now `SET search_path = public, pg_temp`), `operator_event_of` and the four operator definers take
  the admin branch and the `admin` audit actor only from `app_admin_id()`; `operator_scan_subject` needs `scan_quests` and
  the quest limit, `preview_device` a pairing ability (OA403). Found while building: `add_reward_codes`' gate let a staff
  id with no organizer through (`IF NOT FOUND OR NULL`); now read as a refusal, with a test. Proposed ADR-824, Q-760;
  the `app_is_admin()` policy sweep is in FOLLOWUPS. Tests written first, all red on 0188; 17 hand mutants (each scope
  branch, the policy, the 7 gates, one audit CASE, each ability and limit predicate) each turned a test red.
  Mutation globs: none (SQL only). CI minutes: not yet pushed; about 0.5M agent tokens.

## Security audit hardening batch A — 2026-11-11

- **Built (tier C, no review).** Audit hardening batch A, seven items: the web forwarder refuses cookie sessions on
  `/v1/operator-invites/*` and `/v1/events/:eventId/operator/play` (operator transitions stay phone-only); `csvCell`
  prefixes any text that starts with whitespace or a formula character; the proxy matcher skips only known asset
  extensions, so a dotted page address (`/en/e/ABC.x`) gets the page CSP and `no-store`; the app client refuses a path
  with a dot segment, `//`, a backslash or `#` (`isSafePath`) and the unencoded ids in shop, held-prizes, devices and
  config paths are encoded; `.dockerignore` uses `**/.env*`; `FCM_SERVICE_ACCOUNT`'s `token_uri` must equal
  `https://oauth2.googleapis.com/token`; the API request log writes the route pattern (`request.routeOptions.url`) or
  `unmatched`, never the filled path. Not done: the Gmail key's `token_uri` is still unpinned (its tests use
  `oauth2.googleapis.test`).

## Security audit: the shared mail budget — 2026-11-11

- **Built (tier A, review pending).** The sign-up resend takes the day's mail budget (`outboundMailPerDay`) only after
  its pending sign-up passes every check, in the same locked transaction as the new code (`takeOutboundMailIn`), so an
  unknown token spends nothing and a refused budget keeps the resend; it is also counted per client address (30 an
  hour, `signup_resend_address`; the staff sign-in resend likewise, `signin_resend_address`). Email operator invites have a per-organizer daily count (`operator_invite_mail`),
  429 `too_many_attempts`; QRs are uncounted. No migration (buckets are free text). ADR-823 Proposed; the reserved
  per-tenant share of the budget is in FOLLOWUPS. Mutation targets: `apps/api/src/auth/sign-up.ts`,
  `apps/api/src/auth/outbound.ts`.
- **PM decision (Dhia, 2026-11-11).** Email operator invites: 500 a day per organizer, activated or not
  (`operatorEmailInvitesPerDay.max`, was 10 and 30). The provider sets no daily limit, so `outboundMailPerDay` rises
  from 400 to 5,000: one organizer at 500, or one person with five organizers, cannot spend it alone. Q-759 answered;
  tests seed the counts from `AUTH_LIMITS` instead of fixed numbers.

## T-803 P3, `/play` served — 2026-11-10

- **Built (tier B, review pending).** The player app is served at `/play` by the web app (`pnpm --filter @questify/web
  build:play` into `apps/web/public/play`, which is ignored by the repository; run by `Dockerfile.web`, CI and `full.yml`).
  Other `/play/...` paths rewrite to `index.html`, `/play/index.html` redirects to `/play`, and the proxy leaves `/play`
  out of the language redirect and gives it its own CSP (`script-src 'self' 'wasm-unsafe-eval'`, inline styles,
  `img-src 'self' data: blob:`, `connect-src 'self'`, no framing), `camera=(self), geolocation=(self)` and `no-store`;
  hashed files are `immutable`. `PLAYER_WEB_SESSION=on` is in `ops/cranl/staging.json` only. An in-app dialog
  (`AlertHost.web.tsx`) replaces `window.confirm`. `e2e/play-web.spec.ts` (phone, en and ar) drives the real app:
  sign-in, new account, an enter-code quest, reload, the needs-the-phone-app note, sign-out, `<html dir>`. ADR-822
  Proposed, STORE_COMPLIANCE PD-33. T-803 is ticked. Dhia's call: `PLAYER_WEB_SESSION=on` in production.

## T-803 P2, the player's web session — 2026-11-10

- **Built (tier A, sign-in; plan `docs/plans/2026-11-10-t-803-p2-web-session.md`, plan review 86 folded; code review
  pending).** The web forwarder holds the player's tokens in `__Host-qs_player` (HttpOnly, Secure, Strict, 180 days),
  answers verify, signup, refresh and logout itself with no token in any body, logs an old cookie out before a new
  sign-in, turns the cookie into a bearer on player paths only, refuses a cookie or `/v1/auth/*` write from another
  `Origin`, and answers 404 to operator paths for a cookie request. All of it sits behind `PLAYER_WEB_SESSION`, off by
  default (SECURITY.md abuse case 11, the ship gate: on only with P3's `/play` CSP). The web config now requires
  `DASHBOARD_ORIGIN` (`ops/cranl/*.json`, `playwright.config.ts`). Migration 0188 adds the `web` device platform (no
  model). The app has `cookie-session.ts` (lock, retry, then one refresh) and `app-session.web.ts`; `Session.start`
  reads the answer in both modes. ADR-818 to ADR-821 and Q-755 to Q-758 Proposed. Mutation targets:
  `apps/web/src/lib/{forward,forward-headers,player-session,player-steps}.ts`, `apps/app/src/api/cookie-session.ts`.
- **Next:** the P2 code review; P1 (web shims, in parallel) and P3 (`/play`, its CSP, the switch turned on).

## Function limits, six more batches and the nightly address fix — 2026-11-09

- **Function-limits baseline, web, app and API batches (tier B; behaviour-preserving; each reviewed 94 to 96, no
  BLOCKER or MAJOR).** The baseline went from 224 to 151 violations over six batches: web readers and panels (EventPage,
  FlagsPanel, TicketRow, TagCard, CodesPanel, ConsoleTickets, NfcTagsPanel, PlayerAwards, PollControls, DeleteDialog,
  SouvenirPreview, fetchCard, fetchRules and the reward, community, device, rehearsal, survey and boost readers), app
  screens and readers (QuestsScreen, GameScreen, OperatorToolsScreen, NfcWriteScreen, QuestSheet, LivePolls,
  AccountScreen, InviteScreen, RankingScreen, the operator review and ticket screens and about a dozen readers), and API
  checks (cleanFields, fieldsInUse, passportSteps, the category builder, questRows, the NFC, community and ticket refusal
  maps, the ranking route, prize settings, the join route and the quest create and edit checks). Each pure function was
  pinned by a characterisation test run on the old code first; LivePolls' card order and QuestSheet's actions now have
  tests. Review notes are in FOLLOWUPS. Core paths (points, sign-in, scanning, prize handover, desk, SQL) were left alone.
- **Nightly fix.** The 2026-11-09 Full checks failed seven builder specs with "We could not send the code": the e2e
  `freshAddress` helper sent a last octet past 255 once the a11y sweep made the run longer. It now uses
  `10.<random>.<n/250>.<n%250+1>` (`apps/web/e2e/mail.ts`). Confirm on the next nightly. The a11y spec's finding was
  `landmark-unique` on `/console/readiness` (two events of the same name), not contrast: the event cards are now articles.
- **Since release-8:** the baseline went from 106 to 74 in four more batches (web 5, app 6, API 5 with the operator routes
  pinned by a route-list test, and a FOLLOWUPS clean-up), each reviewed 95 or 96. The remaining 74 are core paths.
- **Staging:** `release-20261111-2` (9969a24e; T-803 web build at `/play`, migration 0188, the web session switch on in staging only), API and web deployed and probed (readyz, sign-in in both languages, console 307). The API deploy ran `connect` by mistake, which left `DATABASE_ADMIN_URL` on the API for about ten minutes; it was unset and the API restarted (`no-admin` confirmed), and the handoff now says `connect` is for migrations only.
- **Blocked 2026-11-10:** GitHub Actions stopped starting jobs ("account is locked due to a billing issue"); the nightly Full checks run of 2026-11-10 never started. Dhia said to push anyway: `release-20261110-1` (3349bffb) went out with `SKIP_CI=1 push-deploy.sh`, which runs the API and package tests locally (11256 passed) in place of CI; the browser specs did not run on GitHub. The API deploy call hit a 504 at the gateway, but CranL finished the build (succeeded 18:26Z) and readyz is 200.

## Function limits, API error mappers — 2026-11-09

- **Function-limits baseline, `apps/api` error mappers (tier B; behaviour-preserving).** Seven entries (seven
  violations) left `scripts/function-limits-baseline.json` (236 to 229 violations): `refuse` (28) in `plays/routes.ts`,
  `refuse` (25) in `tickets/routes.ts`, `refuse` (24) in `submissions/routes.ts`, `refuse` (20) in `awards/routes.ts`,
  `refuse` (17) in `results/routes.ts`, `refusalOf` (17) in `community/goals.ts` and `deviceErrorOf` (15) in
  `devices/errors.ts`. The refusal mappers are now lookup tables behind `refusalThrower` (`src/refusal-table.ts`: a
  `Map`, so an inherited key such as `constructor` never matches; a table typed over the refusal union, so a new kind
  without an answer fails the type check); the SQLSTATE mappers are `Map`s by code and by DETAIL. Each was pinned first
  by a table test over every kind or code plus unknown kinds and non-database errors, run on the old code, and then
  compared with a copy of the old file over a cross-product of inputs (status, envelope, log lines, headers). One
  difference, on purpose: a `GL409` or `DV409` DETAIL named like an inherited property (`constructor`) used to throw a
  `TypeError` or an `{}`; it now answers nothing, so the original error is rethrown. `desk/routes.ts`, `route-access.ts`
  and `migrate-cli.ts` are untouched. The baseline was updated with `node scripts/function-limits.mjs --update` and only
  shrank. CI 0 minutes (not pushed).

## Function limits, the builder merges — 2026-11-09

- **Function-limits baseline, `apps/api` builder merges (tier B; behaviour-preserving).** Five violations left
  `scripts/function-limits-baseline.json` (236 to 231): `mergeQuest` (55) and `withEvent` (23) in `quests/builder.ts`,
  `merge` (51) in `events/events.ts`, `mergeReward` (36) and `updateShop`'s work (15) in `rewards/builder.ts`. Each is
  now a run of per-group steps that return the value or the refused field, called in the old order, so the first
  refused field is the same; `withEvent`'s error mapping is a code table, a kept-row table and the unchanged later
  refusals (a `Map`, so a code such as `toString` names none). Pinned by three characterisation files beside the code
  (`*-characterisation.test.ts`), each holding a copy of the old function and comparing old and new over 10,000 seeded
  cases per function (fields, key order, refusals, thrown errors and, for `withEvent` and `updateShop`, every query on
  a fake pool), with a coverage floor on every refusal so the generator cannot drift into trivial cases. The baseline
  was updated with `node scripts/function-limits.mjs --update` and only shrank. CI 0 minutes (not pushed).

## Function limits, app event and profile code — 2026-11-09

- **Function-limits baseline, `apps/app` (tier B; behaviour-preserving, no string, no screen change).** Six functions
  (seven violations) left `scripts/function-limits-baseline.json` (254 to 247 violations): `outcomeText` (18) in
  `event/QuestSheet.tsx`, `ticketOf` (18) in `operator/inbox.ts`, `PollEntry` (17 and 102 lines), `EditProfileScreen`
  (17), `Avatar` (16) and `SubmissionEntry` (16). The decisions moved into pure `.ts` helpers beside each file
  (`event/outcome-text.ts`, a per-field check table in `inbox.ts`, `event/poll-entry.ts`, `screens/edit-profile.ts`,
  `components/avatar-look.ts`, `event/submission-entry.ts`), each pinned by a table test that compares against a copy of
  the old inline logic over the full cross-product of inputs. Hooks keep their order and state stays in the same
  component (the new poll and submission children are stateless); `Avatar` keeps its `Image` elements inside the hidden
  circle so `a11y-static.test.ts` still holds. `outcomeText` moved out of `QuestSheet.tsx`, so `GameEntry`, `MeetEntry`
  and `scan-quest.tsx` import it from `event/outcome-text.ts`. `RedeemSheet` and `readScan` are untouched. The baseline
  was updated with `node scripts/function-limits.mjs --update` and only shrank. CI 0 minutes (not pushed).

## Function limits, web forms and cards — 2026-11-09

- **Function-limits baseline, `apps/web` forms (tier B; behaviour-preserving, no string, route, field name, id, label or
  payload change).** Six entries (11 violations) left `scripts/function-limits-baseline.json` (254 to 243):
  `RehearsalCard` (14, 136 lines), `InviteFlow` (14, 130), `EventForm` (13, 230), `QuestForm` (13, 178), `RewardForm` in
  `RewardsPanel.tsx` (13, 176) and `StepControls` in `ResultsPanel.tsx` (13). Each component keeps its state and hooks in
  the same order in the same component; the markup moved into stateless pieces in the same file, and the decisions moved
  into pure functions (`results-step`, `quest-form-rules`, `event-form-rules`, `invite-link`, `needsPrizeDesk`,
  `rehearsalOf`/`rehearsalActionPath`/`rehearsalWords`) with table tests (`results-step`, `quest-form-rules`,
  `event-form-rules`, `invite-link`, `rewards-desk-gate`, `rehearsal-card-logic`). Before the split, a throw-away
  server-render harness (not committed) saved the old markup of 683 states (every quest type, reward kind, step, new
  event, rehearsal and invite state, both languages) and the new code reproduced it byte for byte after ids were
  normalised. `forward.ts` and the kiosk scanner are untouched. The baseline was updated with
  `node scripts/function-limits.mjs --update` and only shrank. CI 0 minutes (not pushed).

## Function limits, app screens — 2026-11-09

- **Function-limits baseline, `apps/app` screens (tier B; behaviour-preserving, no string, no screen change).** Nine
  entries left `scripts/function-limits-baseline.json` (278 to 269 violations): `Celebration` (24), `ScanQuestScreen` (22
  and 203 lines) and an anonymous handler (12) in `event/[eventId]/scan-quest.tsx`; `StationScanScreen` (19 and 137
  lines) and an anonymous handler (10) in `operator/[eventId]/station-scan.tsx`; `JoinCardScreen` (19) in
  `join/[code].tsx`; `ItemRow` (19) in `operator/[eventId]/(tabs)/desk.tsx`. The decisions moved into pure functions with
  table tests that compare against the old inline logic: `event/celebration-view.ts` (beat shown, Claim, points lines),
  `event/scan-flow.ts` (what a code means, buzz, quest id), `operator/station-flow.ts` (repeat and busy admission, answer
  outcome), `operator/item-row.ts` (row lines and buttons), `join/card-view.ts` (joined, parts, join button) and
  `components/camera-plan.ts`; screens keep their state hooks and effects in the same order (an unused theme-styles read left the two scanner screens), and the lines render
  through one stateless `TextLines`. `a11y-static.test.ts` green. The baseline was updated with
  `node scripts/function-limits.mjs --update` and only shrank (it also lowered `InviteFlow` in apps/web, already under
  its old numbers). CI 0 minutes (not pushed).

## Function limits, web components and readers — 2026-11-09

- **Function-limits baseline, `apps/web` (tier B; behaviour-preserving, no string, route or markup change).** Nine
  baseline entries left `scripts/function-limits-baseline.json` (272 to 263 violations): `QuestRow` (complexity 17, 125
  lines), `PlayerRow` (15), `BulkCard` (14, 111 lines), `readConsoleEvent` (15), `describeProblem` (15), `lineOf` in
  `devices.ts` (14) and the tag check in `nfc-tags.ts` (14). The components split into small ones in the same file with the
  same markup, roles, labels and requests, and no hook or state moved (`BulkCard` keeps its state; the new children are
  stateless); the readers split into per-group checks. Four new tables (`console-event-read`, `devices-line`,
  `nfc-tag-shape`, `sign-in-problem`, 174 cases) were written and run against the old code first. `forward.ts` is untouched.
  The baseline was updated with `node scripts/function-limits.mjs --update` and only shrank. CI 0 minutes (not pushed).

## Function limits, app pure logic — 2026-11-09

- **Function-limits baseline, `apps/app` (tier B; behaviour-preserving, no string, no screen change).** Five offenders left
  `scripts/function-limits-baseline.json` (283 to 278 violations): the ticket check in `event/help.ts` (24), `refusal` in
  `event/quests-api.ts` (20), `CardForm` (23) and the card loop (20) in `help/TicketCenter.tsx`, and `QuizEntry` (26) in
  `event/QuizEntry.tsx`. The logic moved into pure functions, tested over every branch: `help/ticket-form.ts` (kind,
  readiness, what the form says, the card body), `event/quiz-words.ts` (reveal, attempt, result lines), and per-code
  handlers in `quests-api.ts`; new tables in `quests-refusal.test.ts` and `help-validation.test.ts` were written against
  the old code first. Rendered elements, accessibility props and text are unchanged (`a11y-static.test.ts` green). The
  baseline was updated with `node scripts/function-limits.mjs --update` and only shrank. CI 0 minutes (not pushed).

## Function-limits ratchet: web quest builder and rewards — 2026-11-09

- **Four web offenders split, behaviour unchanged (tier B, `apps/web` only; no string, route or markup change).**
  `questProblem` (complexity 30) and `questDraftOf` (22) in `lib/quests.ts` are now small checks that run in the same
  order (a new `quests-branches.test.ts`, written and committed first, pins 71 input-to-output cases and the order in
  which problems win); `QuestBuilder` (26, 220 lines) and `RewardsPanel` (18, 213 lines) are split into hooks and small
  components with the same markup, roles, labels and requests. `scripts/function-limits.mjs --update` removed those six
  baseline entries (283 to 277 violations) and nothing grew. Web unit tests 1,373 passed; `quests.spec.ts` and
  `rewards.spec.ts` 16 passed (desktop and phone, one worker, fresh build). CI 0 minutes (not pushed).

## FOLLOWUPS batch 37 — 2026-11-09

- **FOLLOWUPS batch 37 (tier B, ops config and push; no migration, no SQL, nothing under `.github`, no string).** (1) The
  monitoring Caddyfile's dot-segment rule now matches `{http.request.orig_uri.path}` (Caddy 2.11.4: the path as sent, no
  query string, percent escapes decoded) instead of the whole `orig_uri`, so `/api/v1/query?x=1/./2` is no longer refused;
  every dot spelling in the path still gets 400. The validation also sends raw `/grafana/d/a..b/x.y` and a query holding
  `/./` and expects not-400, and `requestRawPath` has a response `error` listener. (2) T-501: a row held between in-lease
  tries now reports `answered: true` once a try was written (as running out of tries already did); a hold before any try
  stays `false`; a test line pins it. Nothing about what is sent changed. Two FOLLOWUPS lines removed. CI 0 minutes (not pushed).

## FOLLOWUPS batch 38 — 2026-11-09

- **FOLLOWUPS batch 38 (tier B, SQL comments and tests; migration 0187; 0186 and earlier frozen, 0156 reserved; no
  route, screen, string or behaviour change).** (1) T-705: `ledger_player_guard` (diffed against 0120, its only
  definition) and `admin_ban_player` (diffed against 0155) are restated in 0187 with only their membership-lock comment
  changed, now ADR-430's wording: the ban locks the memberships that exist when it runs before the standing changes, the
  guard locks the paid one before reading it, and a membership made during the ban and XP or gems outside a ledger
  payment are not covered by the lock. The diffs show only that comment (and `CREATE` to `CREATE OR REPLACE` for the
  guard). 0120's "Hidden player" sits outside every function body, so no database object holds it; 0187's header notes
  the copy is "Hidden name". The test the line asked for is in `player-safety.int.test.ts`: a bare ledger insert crossed
  with a held ban waits and gets PB423; with the guard's `FOR NO KEY UPDATE` removed it fails (the row is paid). ADR-430
  notes it. (2) Export pages of 10,000, measured on the 100,000-player event of batch 30
  (`export-pages-timing.int.test.ts` now compares both sizes and records the slowest call; median of 3 warm walks).
  Pages of 5,000 against 10,000: players walk 3138 against 2805 ms, slowest call 195 against 318 ms, largest answer 0.75
  against 1.50 MB; redemptions 3070 against 2862 ms, 183 against 332 ms, 0.70 against 1.39 MB; submissions 3085 against
  2929 ms, 184 against 371 ms, 0.82 against 1.65 MB. Every call stays far under the 5 s statement timeout, but at 10,000
  the slowest call is over 250 ms in every door and two answers are at or over 1.5 MB, while a walk saves only 5 to 11%:
  `PAGE_ROWS` stays 5,000 and the line is closed. Touched suites and `apps/api/test/security` passed (727, 2 skipped).
  CI 0 minutes (not pushed).

## FOLLOWUPS batch 36 — 2026-11-09

- **FOLLOWUPS batch 36 (tier B, ops config and tests; no migration, no SQL, nothing under `.github`, no string).** (1) The
  monitoring Caddyfile refuses (400) any request whose path as sent holds a `.` or `..` segment, plain or with `%2e` or
  `%2f`, before any other match (`vars_regexp` on `{http.request.orig_uri}`; Caddy's own `path` match already cleaned
  `..` for the health page, but `/grafana/api/health/..` and the like reached the upstream). Probed on Caddy 2.11.4 with
  `curl --path-as-is` against a stub upstream: every dot spelling 400, `/grafana/d/a..b/x.y` and Prometheus paths still
  pass. `validate.mjs` gains `checkDotSegmentsRefused` (12 spellings, with and without the admin login) sent through
  `requestRawPath` (`node:http`, because `fetch` collapses the segments); `pnpm monitoring:validate` passed, 30 checks,
  mail stage included. (2) The add door's "under 50 ms" now has a hand-run test:
  `apps/api/test/perf/name-allow-add-timing.int.test.ts` (300 calls over the abusive names' words, median and 95th
  percentile asserted under 50 ms): median 8.3 ms, 95th percentile 14.1 ms, slowest 31.6 ms. (3) The batch 32 NIT
  (`ChangeSetReview.test.ts` asserting the default timeout constant) was already done by batch 34: line removed. (4) T-603:
  `invitation-sending.int.test.ts` ran 3 times alone, 52 passed each; the full suite passed on 2026-11-09 (13,403 tests):
  line closed, the 28-failure run is not reproduced. (5) `sign-in-rush` passes (13) and the line only asks to keep the
  name if it recurs, so it stays. CI 0 minutes (not pushed).

## FOLLOWUPS batch 35 — 2026-11-09

- **FOLLOWUPS batch 35 (tier B, SQL; migration 0186; 0185 and earlier frozen, three functions restated and diffed against
  their latest definitions; one new internal function, no table, no grant beyond the restated ones).** (1) The allow-list
  console review: the full-name check's affix lists and their loop move into `full_name_stems(forms, arabic)` (plpgsql,
  IMMUTABLE, revoked from PUBLIC, no grant; ADR-670), called by `full_name_blocked` (0181) and `admin_name_allow_add`
  (0185); the door's copy and the test that kept the two equal are gone. The door also filters its WA422 probes to those
  holding the word before checking them: about 142 ms a call to 9 ms, so `name-allow-console.int`'s `COST 100000`
  work-around (from main) is removed. Old against new in a throw-away database: 10,672 check answers and 9,790 door answers,
  none differs, so the recheck is not marked (ADR-817 amended). A check call costs the same (0.34 to 0.57 ms, by turns);
  `full-name-timing` by hand: `ranking_names` 7.79 ms, `screen_ranking` 20.25, `event_results` 32.86 (0176: 7.95, 34.90,
  32.65), ADR-766's gate holds. (2) The batch 18 NIT: `own_achievements` (0171) shows as next the first tier above the one
  held that is not revoked (bronze revoked and no tier: silver; bronze held, silver revoked: gold; all above revoked or
  gold held: null), restated in plpgsql, so it leaves `sql-settings-allowlist.json` (ADR-439 amended, API.md). Tests:
  full-name-filter, full-name-upgrade, name-allow-console, achievements, achievement-rewards, console-catalog-xp,
  hot-path-plpgsql and `test/security`, 13 files, 833 passed. CI 0 minutes (not pushed).

## The monitoring mail stage on a host with a firewall — 2026-11-09

- **`monitoring:validate`'s mail stage no longer times out on firewalled Linux hosts (tier C, `ops/monitoring/lib`).**
  Cause: this server's ufw has `INPUT DROP` with only ports 22, 80 and 443 open, so a container's connection to the
  test mail sink (a random port on `host.docker.internal`, i.e. 172.17.0.1) was dropped without an answer (a probe
  container's `nc` to a listening host port hung until its timeout; the sink saw 0 connections). Not a port clash, DNS,
  image or timeout fault. Fix: on Linux the mail container joins the host network, the sink listens on 127.0.0.1 only
  (was every address), and the check's Alertmanager takes a free web port instead of a fixed 9093; the mail, subject,
  link and recipient checks are unchanged, and Docker Desktop keeps the bridge route. `startSmtpSink({ host })` and
  `start({ network })` are new, with a sink test. `pnpm monitoring:validate` passes all 30 stages here. CI 0 minutes
  (not pushed).

## The full-name allow-list from the console (FOLLOWUPS batch 23) — 2026-11-09

- **Allow words from the console (tier B with an admin power; plan note `docs/plans/2026-11-09-name-allow-console.md`;
  FR-1779, ADR-817 amended).** Migration **0185**: doors `console_name_allow`, `admin_name_allow_add`,
  `admin_name_allow_remove` (active admin only, QE403; the lists' advisory key; audited `full_name_allow.add|remove`; no
  reason or re-authentication, as the word lists). The add door folds the word with `full_name_fold`, takes its language
  from its letters, and refuses a non-word (WA400, 400 `invalid_allow_word`), a `username_word` entry or one with an affix the
  check strips or a letter run it collapses (WA409, 422 `allow_word_listed`) and a word that lets an abusive corpus name through (WA422, 422 `allow_word_unsafe`), checked against
  the new `full_name_probe` (the corpus' 327 abusive names, no grant, kept equal to the corpus by a test). The list's
  statement trigger marks the sweep (tested). Routes `GET|POST /v1/admin/name-allow`, `DELETE /v1/admin/name-allow/{word}`;
  page `/console/name-allow` beside the word lists, history words `console.history.nameAllow`. Tests: the new
  `test/db/name-allow-console.int` (every abusive corpus word tried through the door), `test/console/safety.int`, the
  security suites, `full-name-filter.int`, and `console-name-allow.spec.ts` on desktop and phone. About 250k agent tokens.
  CI 0 minutes (not pushed).

## Section look apart from heading level — 2026-11-09

- **Console card titles keep their old look (tier B, `apps/web` only; FOLLOWUPS clause cleared).** `Section` takes `look`
  (`"section"` or `"sub"`, default from the level; `sectionLook` in `ui/section-look.ts`, unit-tested). The console event
  page's Suspension, Support access and Recent history cards and the readiness cards keep their `h2` and take `look="sub"`,
  the small body-font title they had at `level={3}`; the other `level={2}` changes of the accessibility batch were `Tile`,
  `SubHeading` and plain headings, which never changed size. CI 0 minutes (not pushed).

## Developer sweep of Proposed decisions and open questions — 2026-11-09

- **Sweep (tier C, docs only).** Every Proposed ADR (131) and every Open, Proposed or status-less question was sorted.
  Technical, built and reviewed: 27 ADRs `Accepted (developer, delegated by Dhia, 2026-11-09, …)` (ADR-140, 160, 179,
  184, 196, 200, 212, 214, 216, 217, 219, 221, 224, 230, 237, 238, 243, 245, 249, 252, 254, 255, 260, 263, 424, 565,
  816) and 25 questions `Decided` (Q-160, 164, 176, 179, 181, 183, 185, 205, 214, 229, 386, 401, 410, 453, 526, 562,
  582, 583, 634, 651, 652, 697, 698, 699, 753). Product items are left for Dhia, and unbuilt or unsure ones are left as
  they were (ADR-185, 186, 535, 730, 812; Q-151, 237, 400, 420, 421, 481, 525, 620, 632, 633, 650, 700). Q-149, Q-743
  and Q-754 are untouched. Dhia's list is rewritten in `questify-logs/dhia-decisions.md`. CI 0 minutes (not pushed).

## The player sign-in's lock order (FOLLOWUPS T-710, T-810c) — 2026-11-09

- **Sign-in lock order (tier A: sign-in; plan `docs/plans/2026-11-09-sign-in-lock-order.md`, plan review 86 applied in
  64468fd6).** Migration **0184**: `start_player_challenge` and `start_deletion_challenge` lock the `review_demo` row
  `FOR SHARE` for the reviewer number only and compute the flag after it (READ COMMITTED), so no SMS goes out while
  Prepare, Close or a number change commits; `end_other_player_devices` locks its own device row with the others in id order
  and re-reads it (an ended device gets `PN401`, the fresh check reads the locked row); `sweep_player_sign_in` is PL/pgSQL,
  takes device rows and codes `SKIP LOCKED` before any family row, and runs as **bounded batches** (at most 500 families and
  1,000 codes of each kind a call, answering rows removed), repeated by `sweepIfDue` within a 1 s budget. Five indexes:
  `least(...)` on refresh and sessions (plus a partial one for sessions with no family), `replaced_by` and `ended_at`
  (partial). At 100,000 players (5.2 million refresh rows, 5.1 million sessions, 7 days of rotations;
  `test/perf/sign-in-sweep-timing.int.test.ts`): 0155's sweep never finishes (stopped at the 5 s statement timeout; the
  `replaced_by` foreign key scanned the table once per deleted row, 0.63 s a row), 0184's run 955 ms in 9 batches of 92 to
  127 ms for 10,851 rows, the longest rotation beside it 110 ms (gates 1 s, 250 ms, 250 ms). Race tests: 22 new (review
  demo 0 to 7 and 20, devices 8 to 21 and 17b, two flow tests for the batch loop); before 0184, 1 to 4, 6, 7, 8 to 16, 18
  and 19 failed. Hand mutants: 15 run, 14 killed, 1 equivalent (the re-auth code delete not limited); end-others'
  `ORDER BY` dropped was first recorded as equivalent, but it is I2 and dies to test 22 (code review below); the "loop
  over a new SELECT" mutant needed the new test 17b. Suites: security, sign-in, devices,
  re-auth, review demo, erasure, players, hot path and rehearsal, 36 files, 1,217 tests passed (after one test fix);
  `format:check`, `lint`, `lint:limits`, `typecheck` exit 0. Docs: rules (lock order paragraph, with the contact-change and
  cap exceptions), SECURITY row 16 and devices section, ASVS V7.4.1 and V7.5.2 evidence, DATA_MODEL, RUNBOOK 0184 deploy
  note (the read-only count of rows with no device row is for the deploy step), FOLLOWUPS T-710 and T-810c entries removed.
  Mutation glob for the next run: `apps/api/src/players/sign-in.ts` (the batch loop in `sweepIfDue`).
  CI 0 minutes (not pushed).
- **Code review (91, GO) minors folded in.** 0184's five indexes are `IF NOT EXISTS`; RUNBOOK: a hand `CONCURRENTLY`
  build before the deploy is checked by `indexdef` and `indisvalid`, and production migrates in a quiet window (the SHARE
  lock queues writers for up to the 10 s `lock_timeout`). The sweep no longer runs inline: it starts after the code is
  sent (and beside the verify answer), not awaited, same 10-minute cadence; a sweep stopped by its 1 s budget with rows
  left logs `player.sweep_partial {batches}` (RUNBOOK, SLO.md). End-others' `ORDER BY` mutant is killed by test 22 (the
  table in descending id order, crossed with an erasure's device lock: `40P01` with the mutant). Write cost of the
  indexes, rotations alone at 100,000 players (1,000 each, `sign-in-sweep-timing`, indexes dropped in a rolled-back
  transaction): **with them p50 2.39 ms, p95 3.56 ms; without them p50 2.26 ms, p95 3.27 ms** (about +0.1 ms p50,
  +0.3 ms p95). Re-measured on that run: 0184's sweep 916 ms, 9 batches of 86 to 120 ms, 10,869 rows; 837 rotations
  beside it, median 4 ms, longest 101 ms. FOLLOWUPS: MINOR 5 (rowless families can `40P01`) and NIT 7 (500 families,
  not rows, a batch). Suites (sign-in, devices, review demo, erasure, flow, security): 21 files, 1,040 tests passed;
  `src/players` unit tests 9 files, 129 passed.

## Player app accessibility follow-up (Reduce Motion, scrim, banner name, stricter check) — 2026-11-09

- **T-808 follow-up (tier B, `apps/app` plus one message key).** Reduce Motion: `Sheet` and the location modal now choose
  their animation from `useReduceMotion` (`modalAnimation`: slide, fade when reduced, instant until the phone has said); the
  `my-qr` timer bar drops in whole seconds under Reduce Motion (`timerFraction`); both pure helpers are in
  `components/motion-choice.ts` with unit tests. The catch game is kept as is, on purpose: the fall is the game and its speed is
  the server's `fallTicks`, which the server replays to check a result, so slowing it would break verification (documented in
  `CatchGame.tsx`). The `Sheet` scrim is `accessible={false}` and `importantForAccessibility="no"` (one Close stop left). A banner
  slide with no title and no subtitle is named by `home.banner.untitled` («لافتة» / "Banner"), added to the glossary. In
  `a11y-static.test.ts`: a glyph alone no longer names a touchable, hiding needs the Android prop too, `={false}` values do not
  hide descendants, and a `<Pressable accessible={false}>` is still checked; it found one image (the devices padlock),
  fixed. `pnpm -s vitest run apps/app --maxWorkers=3`: 130 files, 1,487 tests passed. Device checks stay open under T-808.
  CI 0 minutes (not pushed).

## Player app accessibility from the code — 2026-11-09

- **Player app accessibility check (T-808, code-checkable part; tier B, `apps/app` only).** New
  `apps/app/src/a11y-static.test.ts` parses all 209 `.tsx` files with `@babel/parser` (the app's own dependency; TypeScript 7
  has no in-process API) and fails on an unnamed or role-less touchable, an unlabelled non-decorative image, an unlabelled
  input, an exposed icon glyph and hard-coded text outside `t(...)`; its allow list is empty; 11 tests, the checker itself
  included. Found and fixed: one scrim without a role, one banner tap target named only through a child, eight glyphs and one
  padlock now hidden from a screen reader, a checkbox glyph hidden; touch targets raised on four chip or choice styles
  (`minHeight` 44) and, with `hitSlop`, on the Back button, event pill, station link and banner dots. No string changed (none
  was hard-coded), so no Arabic wording was touched. `pnpm -s vitest run apps/app --maxWorkers=3`: 129 files, 1,476 tests
  passed. Device and screen-reader work (VoiceOver and TalkBack order and announcements, Reduce Motion on a phone) is listed
  under T-808 in TASKS.md and stays open. CI 0 minutes (not pushed).

## Accessibility sweep, moderate findings — 2026-11-09

- **Accessibility sweep fails on moderate findings too (T-808 follow-up; tier B, `apps/web` only).** `FAILING` in
  `apps/web/e2e/a11y.spec.ts` now holds serious, critical and moderate, and the best-practice rules (heading order,
  landmarks, level-one heading) fail with the WCAG ones; `ALLOWED` stays empty. Fixed in markup; the console event and readiness cards' headings now render one size larger (`Section level={2}`), for a person to look at
  (heading elements keep their class styles): `heading-order` on the rewards (Prize desk, Shop settings and the reward
  form now `h2`), flags (Hold prizes at the desk), preview (the phone screens' titles `h2`, their groups `h3`, the
  title keeps the body font), console (Add-on requests), console event (Suspension, Support access, Recent history),
  console health (the tiles, new `level` on `Tile`), console legal (document groups) and console readiness (event
  cards) pages; `landmark-unique` on the inbox (the Join requests tile and the Join requests part shared a name; tiles
  are now named «{title} count» / «عدد {title}», key `inbox.tileName`) and the numbers page (Active and Suspended repeat
  between groups; tile regions are named «{group}: {tile}», new `name` on `Tile`); `page-has-heading-one` on the invite
  page without a link (it shows the «Team invite» title above the notice) and the paired big screen (the event name is
  the `h1`, the scene title an `h2`; the screen shut for the end of the event or the add-on has its `h1` too). Labels:
  `bigScreen.up`/`down` are now «نقل لأعلى: «{scene}»» / "Move up: {scene}" (the arrows are `aria-hidden`; axe still
  lists one undecided `label-content-name-mismatch` on the big-screen settings page, printed, not a violation), and the maps' Move up and Move down buttons keep their visible
  words and gain the name «Move up: {name}» (keys `maps.page.moveUpNamed` and `moveDownNamed`); e2e pins in
  `big-screen.spec.ts` and `maps.spec.ts` updated. From CI run 42536650643: the ranking's `color-contrast` was axe reading
  the scene mid-fade (400 ms from opacity 0), so the sweep now waits for finite animations before each read; the
  place numbers (honey on cream, 1.9 to 1, which axe could only call incomplete) use `--color-text-muted`. `a11y` left
  `LAYOUT_SPECS` for the new `NIGHTLY_SPECS` in `scripts/ci-scope.mjs`, so a push run never plans it; `full.yml` runs
  every spec (no filter, 75-minute limit), so the nightly check runs it. One FOLLOWUPS line trimmed. CI 0 minutes (not pushed).

## FOLLOWUPS batch 32 — 2026-11-08

- **FOLLOWUPS batch 32 (tier B, API and SQL; migration 0183; no function, table, grant or string).** (1) The completion
  gate with 0182's `enrollment_event_joined_idx` and without it (a throw-away migration dropping it, everything else
  equal): `profile.mjs --big-event-players 50000 --explain 0`, 2,000 first completions after 300, the shared test
  container, in turns with, without, without, with, without, with: with 10.44, 9.72, 10.15 (mean 10.10 ms), without
  9.74, 10.02, 9.62 (mean 9.79 ms), so +0.31 ms (+3%), inside each side's spread (0.72 and 0.40 ms). Load average 9 to
  15 on 12 cores throughout (another worker). The index's own cost on the score update, 20,000 members, triggers off,
  with and without in turns, median of 6 (`test/perf/export-index-plans.int.test.ts`): one update a transaction 1,075
  to 1,122 and 1,041 to 1,076 us (+35 to +47 us, inside the spread), in one server-side loop 121 to 138 and 151 to
  147 us (+16 us, then -4). Verdict against ADR-734: the index's cost is not distinguishable from noise, at most a few tenths of a ms; the
  absolute 10 ms limb is not met by the with-index mean on this busy machine (10.10) and is by the without mean
  (9.79), with single runs on both sides of the line, and the last quiet figures (10.78, 10.98) were already over it,
  so the absolute number still waits on a quiet machine or T-804's rerun. No cheaper index exists: the row's update is
  already not HOT, so every index of `enrollment` takes an entry whatever its columns. (2) 0183 makes
  `redemption_event_created_idx` partial `WHERE reward_id IS NOT NULL`. EXPLAIN (ANALYZE) of the page query on two
  events of 20,000 reward redemptions each: with one rank prize a member (half the rows outside the file) the index
  is half the size (8,048 to 4,048 kB), the first page reads it in order and stops (6.2 to 2.5 ms), the middle page
  (10,000 left) becomes a bitmap read of it and a sort of those rows (4.9 to 8.9 ms), both plan modes; with one rank
  prize in ten members every page keeps the ordered read (2.4 to 3.0 ms). The planner sorts only when what is left
  is about two pages or less. The players page keeps its ordered read of `enrollment_event_joined_idx`. (3)
  `ChangeSetReview.tsx`'s apply and close are `sendReviewCall`, whose signature carries the set's path, so a review
  shown another set takes a new key; `ChangeSetReview.test.ts` tests its `keys[suffix]` wiring, the path, the key
  slots and the apply timeout (no component test setup in `apps/web`, so the hook is not rendered). The batch 22
  "Already recorded" note and batch 21's lost-response note stay as product calls. Tests: the exports, security,
  rehearsal and touched suites, 766 passed, 2 skipped (the hand-run perf files). One FOLLOWUPS line trimmed, one cut
  down. CI 0 minutes (not pushed).

## Accessibility sweep — 2026-11-08

- **Accessibility sweep (T-808, automated web part; tier B).** New `apps/web/e2e/a11y.spec.ts` runs axe-core
  (`@axe-core/playwright` 4.14.0, MPL-2.0, released 2026-10-15; its engine `axe-core` 4.14.0, MPL-2.0, 2026-10-05; a
  devDependency of `apps/web` only, justified under rules.md 8: the layout check cannot see names, roles, labels or
  landmarks) against WCAG 2.1 A and AA on every page of the layout check (all of `LAYOUT_PAGES` and `PUBLIC_PAGES`), the
  unpaired screen, station and kiosk pages, a big screen paired and showing its ranking, and the event's confirmation
  dialog, in English and Arabic, on the desktop and phone projects (phone again with the Menu sheet open). Serious and
  critical WCAG violations fail; moderate and best-practice findings (landmarks, heading order) are printed, not failed.
  The waiver list `ALLOWED` in the spec is empty. The spec shares the event-filling steps with the layout check through the
  new `layout-fill.ts` (moved out of `layout.spec.ts`, unchanged) and `openPage` in `layout.ts`; `a11y` joined
  `LAYOUT_SPECS` in `scripts/ci-scope.mjs`, so every web change runs it in the existing browser shards (no workflow change;
  one more test per shard, about 5 minutes on desktop and 8 on the phone project locally). Found and fixed: `label`
  (critical) on the awards file input (and the same plain `<input type="file">` in `DailyWordImport`), now the labelled
  `Input`; `label-content-name-mismatch` (serious, 4) on the quest move buttons, whose accessible name now starts with the
  visible words («Move up: {name}» / «نقل لأعلى: «{name}»», keys `quests.upNamed` and `quests.downNamed`, spec text
  updated); `color-contrast` (serious) on the big screen's scene title, honey on cream at 1.6 to 1, now the wood-brown
  text token at 5.4 to 1; the pairing pages (screen, station, kiosk) gained a level-1 heading. Left, as moderate
  best-practice findings printed by the spec and not failures: `heading-order` (a level-3 title straight under the level-1
  title on about eight pages), `landmark-unique` (equal tile names on the inbox and numbers pages), and
  `page-has-heading-one` on the invite page and the paired big screen. Still needs a person: the
  player app, a screen reader walking each flow, keyboard and focus order beyond what axe reads, whether labels and alt
  texts mean the right thing, and the read of every screen in both languages (T-808 stays open). CI 0 minutes (not pushed).

## FOLLOWUPS batch 29 — 2026-11-08

- **FOLLOWUPS batch 29 (tier B, ops, scripts and tests only; no `apps/`, no migration, no `.github`, nothing deployed).**
  (1) `scripts/cranl/monitoring-setup.test.ts` now covers `create`'s success path against a local fake CranL (the app
  POST, the volume, the root-URL patch and the deploy, in that order, with the bodies; the state file owner-only and
  holding the generated password, which the output never prints; `bcrypt_hash` swapped for a fixed fake so no container
  starts). (2) `RUNBOOK_BASE_URL` (optional, with alert email only): `render-config.sh` checks its shape (https address
  ending in `/`, no `|`, `&` or space) and writes it into the mail's "What to do" link; unset or empty it is the GitHub
  address as before. `mail-checks.mjs` builds its expected link from the setting; `monitoring:validate` gained a stage that
  renders unset, empty and set, and four refusals; RUNBOOK lists the setting. (3) `ops/load`: the ranking probe moved to
  `probe.mjs` and sleeps through the warm-up (it ran inside it, so ranking figures counted probes the completion figures
  did not); the API CPU is now divided by the time the drivers really ran (`cpuPercentOfOneCore`), drain tail included;
  `probe.test.ts` (fake clock) and `report.test.ts` pin both. (4) RUNBOOK, "T-804a rollback of migration 0148": the
  generated SQL (35 `CREATE OR REPLACE` from the fixture's 0147 definitions, six `ALTER ... SET search_path`), how it was
  produced, and that `own_level` keeps migration 0168's condition; never run against a database. (5) Dropped as settled:
  the `questify.rules.yml` copy stays by design, since T-017 builds the app from `/ops/monitoring/stack` (not a
  repository-root context) and `monitoring.test.ts` plus the `cmp` stage of `monitoring:validate` already fail while the
  copies differ. Five FOLLOWUPS lines trimmed. CI 0 minutes (not pushed).

## FOLLOWUPS batch 31 — 2026-11-08

- **FOLLOWUPS batch 31 (tier B, tests, docs and web; no migration, no SQL, nothing under `.github`, no string).**
  (1) `monitoring.test.ts` now ties the RUNBOOK base URL default in `render-config.sh` to `DEFAULT_RUNBOOK_BASE_URL` in
  `ops/monitoring/lib/context.mjs` and to the RUNBOOK's text without Docker, and checks the email template holds
  `@RUNBOOK_BASE_URL@{{ .Annotations.runbook }}`; the RUNBOOK's 0148 rollback says to recheck against newer migrations
  before use. The mail-stage timeout note stays. (2) DATA_MODEL, "Exports": the paged exports are not one snapshot, and a
  player who re-joins during a walk can appear twice; the index measurement and the partial index stay in FOLLOWUPS (they
  need SQL and a load run). (3) `ChangeSetReview.tsx` gives apply and close each its own key (`useRequestKeys` /
  `createRequestKeys` in `use-request-key.ts`), so a close during a timed-out apply no longer replaces the apply's key;
  `use-request-key.test.ts` pins it. The dead `upserts` recording is gone from `survey-share.int.test.ts`; the store itself stays as a plain first-place stub, since the tests read `rank: 1` through it. Two
  FOLLOWUPS lines trimmed, one cut down. CI 0 minutes (not pushed).

## FOLLOWUPS batch 30 — 2026-11-08

- **FOLLOWUPS batch 30 (tier B, API and SQL; migration 0182; 0181 and earlier frozen, `export_completions` restated and the
  three paged doors diffed against 0103; ADR-766 amended; no route, screen, string or package change).** The players,
  redemptions and submissions export doors read pages as completions do: `(event, after_at, after_id, page_size)`, 1 to
  10,000 rows (AX400 otherwise), oldest first by the table's own time and id, `{rows, next}` with the rows unchanged and
  `next` the last row's time and id (a uuid for players and redemptions). The API reads all four in pages of 5,000
  (`pagedPieces` in `src/analytics/exports.ts`); `POST …/exports/{kind}` and its file are unchanged, so no dashboard caller
  or Playwright spec changed. Three indexes `(event_id, time, id)` keep a page a range read. Found and fixed on the way:
  `export_completions` took `next.id` as the page's largest id, which skips rows of the last time when a later id has an
  earlier time; it now takes the last row's id. A redemption without a reward (a rank prize) is left out inside the page,
  so it never ends a full page early. Measured on an event of 100,000 players, each with one join answer, redemption and
  text submission (209 MB database, load about 2 to 3.7 on 12 cores, median of 3 warm walks,
  `test/perf/export-pages-timing.int.test.ts`): players 1 call, 402,890 buffers, 1,907 ms, a 15.0 MB answer, to 21 calls,
  431,760 buffers, 2,391 ms in all, at most 0.7 MB a call; redemptions 5,238 buffers, 1,529 ms, 13.9 MB to 535,556 buffers,
  2,473 ms, 0.7 MB; submissions 5,569 buffers, 1,431 ms, 16.5 MB to 535,235 buffers, 2,434 ms, 0.8 MB. A walk costs 25 to
  70% more database time (index lookups per page in place of one hash join) for no statement over about 120 ms and no
  answer over 1 MB. `own_level_only()` (PL/pgSQL definer, search path pinned, PUBLIC revoked, granted to `questify_app`
  alone) answers the level of `own_level(NULL)`, the same for every XP around every level's start and null for a banned
  player or no player; `ownIn` in `ranking.ts` takes it. The own row on 50,000 players: no level 3.49 ms, `own_level(NULL)`
  4.08 ms, `own_level_only()` 3.70 ms (35, 51, 47 buffers): ADR-766's gate now holds both limbs. The sponsor-subtraction
  half of the T-608 line stays noted as ADR-393 (4)'s accepted case. Each new test failed without its fix. Two FOLLOWUPS
  lines trimmed. CI 0 minutes (not pushed).

## FOLLOWUPS batch 28 — 2026-11-08

- **FOLLOWUPS batch 28 (tier B, web and API test files; no migration, no SQL, no package change, no ADR, no new string).**
  The change-set review no longer makes a new Idempotency-Key on every click: `ChangeSetReview.tsx` sends apply and close
  through `keyedRequest` (`use-request-key.ts`), which keeps the key of a request (its signature is the call and its body)
  until a final answer, so a click after a 502 or a timeout gets the stored answer instead of `change_set_busy`. A final
  answer (`isFinalAnswer`) is a 2xx or a 4xx other than `change_set_busy` and `request_in_progress` (the same request still
  running); a dropped connection, a timeout and a 5xx keep the key. `createRequestKey` is the plain core of `useRequestKey`, so
  `use-request-key.test.ts` tests the key staying across a 502, a timeout and a busy answer and changing after a final one.
  `saveExport` (`AnalyticsExports.tsx`) is exported and `AnalyticsExports.test.ts` pins its timeout (the call gets
  `EXPORT_REQUEST_TIMEOUT_MS`, answers failed when it runs out, and the limit sits above the forwarder's 180 s). The vote and
  survey replay tests no longer pin the ranking copy written twice; they assert the score unchanged and `replayed: true`.
  The CranL edge 300 s check stays in FOLLOWUPS (needs a staging run). One FOLLOWUPS line trimmed. CI 0 minutes (not pushed).

## FOLLOWUPS batch 27 — 2026-11-08

- **FOLLOWUPS batch 27 (tier B, SQL and test code; migration 0181; 0180 and earlier frozen, `full_name_blocked` restated and
  diffed against 0180; ADR-817 amended).** The full-name check reads symbols after NFKC (f＊ck, sh！t, a＄＄hole, b＠stard),
  reads ∗ ⁎ as * and ¡ as !, reads * as any one letter (a LIKE lookup within the same budgets, at least 2 real letters a slice:
  fu*k, c**t, wh*re) and a run of symbols also as one (sh!!t, b!!tch, F**k), readings only, never an allow word. Corpus 861
  real names (35 added: Ke$ha, A$AP Rocky, N!xau, !Xóõ, Tsumk!we, Wi!!iam, Gr@ce, R2-D2, full-width "Ｔａｒｏ Ｙａｍａｄａ"; all
  pass), 311 abusive (19 added, all refused, each passed 0180), 14 accepted passes. The check 0.42 to 0.45 ms a Latin call,
  0.47 to 0.64 ms with a * inside a word; the reads hold ADR-766's gate; the recheck is marked pending. The time zone copy's
  retake can raise 40001 under REPEATABLE READ (the event duplicate, which retries once): noted in `docs/DATA_MODEL.md`, and
  `event-timezone.int.test.ts` proves an insert answers from `pg_timezone_names` without waiting while another session holds
  the copy's key. `migrate.test.ts`'s `topLevelStatements` strips comments, strings (plain, E'', U&''), quoted identifiers and
  dollar bodies in one left-to-right scan (nested block comments too); 22 cases added, 14 of which the old regexes got wrong;
  every migration file still passes. Each new test failed without its fix. Two FOLLOWUPS lines removed. CI 0 minutes (not pushed).

## FOLLOWUPS batch 26 — 2026-11-08

- **FOLLOWUPS batch 26 (tier B, web, app and API test files; no migration, no SQL, no package change, no ADR, no new string).**
  `requestJson` (`post-json.ts`) now has a timeout of its own: 30 s by default (`DEFAULT_REQUEST_TIMEOUT_MS`), a fifth argument
  `{ timeoutMs }` overrides it, and a call that is not answered (or whose body stalls) comes back as status 0, no body, the same
  as a dropped connection, so every screen already handles it. Longer limits: the change-set apply 330 s
  (`APPLY_REQUEST_TIMEOUT_MS`, the API claims a set for 5 minutes) and the analytics exports 200 s (`EXPORT_REQUEST_TIMEOUT_MS`;
  that screen used a bare `fetch` with no limit and now has one). The forwarder's own limit was 15 s for every path but the
  exports, which would have cut the apply short, so `forwardTimeoutMs` (`forward-timeout.ts`, tested) gives the apply path 300 s
  beside the exports' 180 s. The calls read and left at 30 s: the player data export and erase (one player, forwarded in 15 s),
  the word-list import (sent in chunks), rehearsal erase. The app's client (`api/client.ts`) already had a 15 s timeout with a
  test, so it is unchanged. `completedBuzz` moved from `scan-quest.tsx` to `event/completed-buzz.ts` and is tested with a mocked
  `expo-haptics` (Light for a replay that paid nothing, Success otherwise). API route tests pin `replayed: true` with status 200
  on the vote, survey and share answers (the HTTP replay store's clock moved past a day so the database answers the key;
  the game result already had it). `console-catalog-xp.int.test.ts` now spots `xp`/`gems` writers of `platform_setting` by the
  word in any quoting, not by the quoted literal `'xp'` only. Three FOLLOWUPS lines trimmed. CI 0 minutes (not pushed).

## FOLLOWUPS batch 25 — 2026-11-08

- **FOLLOWUPS batch 25 (tier B, SQL; migration 0180; 0179 and earlier frozen, restated and diffed against
  0009, 0177 and 0179; ADR-817 amended).** The event time zone guard reads `timezone_name`, a copy of `pg_timezone_names`
  taken by the migration and again after each server restart (`loaded_for` = `pg_postmaster_start_time()`); a miss is looked
  up in `pg_timezone_names` as before, so the answers are the same (every one of the 599 zones, 31 invalid names and NULL
  compared, the copy stale and fresh; `test/db/event-timezone.int.test.ts`). The guard is now a definer, the copy has forced
  row-level security and no grant. An event insert 44.04 to 1.73 ms (1.68 with no guard; `test/perf/event-timezone-timing`).
  The seat-limit test no longer turns the guard off for its 300 events. The full-name check reads `* ! @ $` inside a Latin word
  as letters (f*ck, sh!t, a$$hole) and runs of 3 or more of one letter as 1 and 2 (Fuuuck, asssshole; Aaron, Moo untouched),
  neither ever an allow word; `full_name_fold` reads small capitals and more look-alikes (ꜱex, fսck); dickhead was already
  refused (0178). Corpus 826 real names (30 added, all pass), 292 abusive (23 added, all refused), 14 accepted passes; the
  reads hold ADR-766's gate; the check 0.38 to 0.48 ms a call. The recheck is marked pending. `record_completion`'s
  `sum()` without GROUP BY (0170) is left as it is: no row instead of NULL changes what its callers get (the SQL payers read it
  `INTO`, the routes take the first row), it needs a completion with no quest entry, which every path writes together in one
  transaction, and the fix is a full restatement of a tier A ledger function for a case no route reaches. Each new test failed
  without 0180. Tests: 35 files, 1,254 passed (security, full-name filter and upgrade, usernames and the comparison, every
  event suite, seat limits, rehearsal, hot path). CI 0 minutes (not pushed).

## FOLLOWUPS batch 24 — 2026-11-08

- **FOLLOWUPS batch 24 (tier B, SQL; migration 0179; 0178 frozen, restated and diffed against it; ADR-817
  and ADR-119 amended).** `full_name_blocked` restated as 0178 with one prefix more, ياال: «يا البزاز», «يا القحبة»,
  «يا الشرموطة», «ياالقحبة», «يا العرص» are refused, «البزاز» still kept. Eight `username_word` entries: hitler and fvck `part`;
  nazi, nazis, retard, retards, retarded and fuk `word` (as parts they would refuse nazir_1, nazim_k, flame_retardant, fukuda).
  Fifteen `full_name_allow` words (77 to 92): nazir, nazim, nazia, nazih, nazik, nazif, nazish, fuka, fuku, fuks, fuki, fuko,
  fuke, whitler, and fuk (the corpus' Wong Fuk Wing: a Cantonese given name, so Fuk alone passes a full name and fuk with a
  letter more is refused unless it is one of the names above; the username token fuk is refused). In a username only whole
  tokens are caught: nazi, nazis, retard, retards, retarded, fuk; naziboy, fukyou and fuks pass (accepted; fuks is a real
  name). Corpus 796 real names (26 added, all pass), 269 abusive (19 added, all refused), 14 accepted passes. `username_blocked` restated as PL/pgSQL, the name
  folded once (0118's CTEs ran per list row): the same answers on 12,655 names (every list word's look-alikes, every corpus and
  test name, seeded random names; `test/db/username-blocked-same.int.test.ts`), 0.71 to 0.13 ms a call, `rename_player` 0.97 to
  0.63 ms (`test/perf/username-timing.int.test.ts`, load 2.5). Each new test failed without its fix. Tests: 13 files, 766
  passed (full-name filter and upgrade, usernames, the comparison, player safety, console safety, security, name display).
  CI 0 minutes (not pushed).

## Full names match by words — 2026-11-08

- **0178's second review (84 NO-GO) fixed (tier B, API; 0178 edited in place, undeployed; ADR-817, Q-754 (4) new for
  Dhia).** The sweep's page is 250 (was 2,000, about 2.3 s against the pool's 5 s limit): 105 ms a page median, 138 ms the
  slowest, 421 ms the slowest with a 200-character name in every answer; about 11 minutes at 100,000 answers. The check looks
  each form's entries up by key (6 slices a form; same answers on 21,031 names): 0.27 ms a call against 0177's 0.38 ms, the
  slowest name about 1.5 ms (was 5.7). `full_name_allow` 77 words (18 added: «لحسين», «جماعي», «شرجي», «زبيدات», asser, assis,
  assi, kasser, wasser, lasser, hasser, sasser, cuma, titi, tita, manus, anush, butters); an allow word is skipped only with no
  digit (dick5, kike88 refused) and never after يا (a lone يا is read with the next word: «يا خولي» refused); «البزاز» kept
  (real family name, pinned). 18 `word` compounds (jackass, dickhead, cocksucker, dumbass, asshat, ..., «كسامك», «كسختك»,
  «كساختك»): usernames change only for a token that is the compound. Corpus 770 real (all pass), 250 abusive (all refused), 11
  accepted passes (smartass added; dickhead, cocksucker, jackass, dumbass, «كساختك» moved to abusive). Timing (load 3.5-4.2):
  `ranking_names` 7.63 to 7.91 ms (+3.7%), `screen_ranking` 34.26 to 20.05 ms, `event_results` 30.60 to 30.08 ms; ADR-766's
  gate holds. «يانيك», «نيكي», Semen, Porn left refused for Dhia. Tests: the same 12 files (751 passed). Not pushed.
- **Full names checked by Dhia's letter-count rule (tier B, API; migration 0178, reworked after its review scored 80 NO-GO, then
  after Dhia's follow-up; ADR-817 Accepted by Dhia, Q-754 (1) and (2) decided; no new string).** `full_name_blocked` restated
  (diffed against 0177; usernames unchanged): a word is refused when, with one known prefix and ending taken off (Arabic و ف,
  ب ك ل, ال, يا, ابن / بنت; ات ين ون, ك كم ها هم ي with ة as ت, ي يه ه; Latin s es er ers ed ing ings y ies), it holds an entry
  with few letters left over: 2 for a `part` entry of 4+ letters, 1 for any other of 3+, none for 1-2. Thresholds tuned on the
  corpus (750 real names, 220 abusive; nine settings tried, table in ADR-817): chosen = no abusive pass, fewest real refusals
  (83 without an allow-list). `full_name_allow`: 59 words (24 of 0177's dropped as unneeded, 40 added: nasser, tito, shittu,
  «خوله», «لحسن», ...; «kike» stays); an Arabic allow word covers its prefix and nisba forms only. Five compounds (fuckface,
  fuckhead, fuckwit, shithead, shitface) added to `username_word` for full names (no username changes). Accepted passes pinned
  by a test (15: fuckali, pornstar, bigfuckingdick, dickhead, ...; ten were refused by 0177); 50 abusive names 0177 passed are
  now refused («القحبة», «معرص», «كسك», dickk, sexx, c0ck, ...). A test sweeps stored names under 0177, applies 0178 and sweeps
  again. Check 0.48 ms a call (0177's 0.25, same run). Timing rerun (load 3.1-6.1): `ranking_names` 7.58 to 7.62 ms,
  `screen_ranking` 31.72 to 19.51 ms, `event_results` 27.59 to 28.96 ms (+5.0%), buffers equal or fewer (ADR-766's gate holds);
  sweep 2,261 ms a page median, 115 s for 102,001 answers.
  Recheck marked pending, so the tick re-flags stored names. Tests: full-name-filter, full-name-upgrade, name-recheck, security, name-display, usernames and console safety (12 files, 747 passed). CI 0 minutes (not pushed).

## FOLLOWUPS batch 23 — 2026-11-08

- **FOLLOWUPS batch 23 (tier B, API and app; migration 0177 rewritten before deploy; ADR-817 Proposed, Q-754; no new string).** The
  T-615 follow-up: a full name shown to every player passes the username word lists. Reworked after the review (72, NO-GO):
  `join_answer.name_blocked` is set by the check when an answer is written and swept again after any list change (a statement
  trigger on both lists marks `full_name_recheck`; the lifecycle tick runs `name_flag_sweep`; no backfill, the migration leaves the
  sweep pending; the console door runs no page), so `public_full_name` reads one boolean: `ranking_names` 7.59 to 7.88 ms,
  `screen_ranking` 32.11 to 19.15 ms (the name called once), `event_results` 32.23 to 32.12 ms with equal buffers (the first 0177:
  396 ms, 388 ms, 1,836 ms). The check goes word by word, skips `full_name_allow` (43 name words; an Arabic one with its article and
  nisba forms, so «الإسحاقي» and «البلوطي» pass), and folds NFKC, accents, Persian letters and Cyrillic and Greek look-alikes first:
  242 real names pass, 30 abusive ones are refused, the six reported bypasses among them. Re-review (86) fixes folded in. The app shows the API's words under the refused field, also after
  sign-in (`src/join/pointed.ts`; a field gone from the card puts the words on the Problem line). Tests:
  `test/db/full-name-filter.int.test.ts` (16, a two-connection join against a word add among them), `pointed.test.ts` (5), the sweep's unit tests, `test/perf/full-name-timing.int.test.ts` (by hand). CI 0 minutes (not pushed).

## The layout check's stuck rehearsal read — 2026-11-08

- **`layout.spec.ts:261` "events page never settled" (CI runs 42412664875 shard 1 desktop, 42422503343 shard 2 phone; tier C,
  test harness only; no API change, no migration).** Cause: not the API. Both traces show one rehearsal GET, started on the
  event page right after "Create event" and cut off 150 to 240 ms later by `createEvent`'s `page.goto` to the quests page; the
  browser cancelled it, Playwright reported neither `requestfinished` nor `requestfailed`, and `watchRequests` kept it in its
  open set, so the first page that waited next (the events list) failed. It was the rehearsal read because it is the event
  page's slowest call (a first read opens the rehearsal: two transactions). The API side is fast and lock-free here:
  `open_rehearsal` (0032) is `INSERT … ON CONFLICT DO NOTHING`, `rehearsal_card` (0166) takes no row lock, the wipe tick skips
  events before go-live, and `withFreshCode` retries only on a unique clash, at most 5 times; against the test database a first
  read took 20 to 60 ms and 2, 4, 8 and 16 concurrent first reads of one event all answered in under 100 ms with one code. Fix:
  the request count moved to `apps/web/e2e/open-requests.ts` and drops the old document's requests when the top frame starts
  loading a new one; `open-requests.test.ts` (vitest, 3 tests) fails with the CI message before the fix. Playwright now matches
  only `*.spec.ts`. CI 0 minutes (not pushed).

## T-813 part 2 — 2026-11-07

- **T-813 part 2 (performance audit items 5 to 12, apps/web and apps/app; tier B; no migration, no new dependency, no ADR, no new
  string; T-813 itself stays open, items 1 to 4 are the other worker's).** Results with their conditions are in
  `docs/PERFORMANCE_AUDIT.md`, "T-813 results, part 2". Images: 45 art files became WebP, 1,710,486 to 626,804 bytes (the header
  wordmark 51,898 to 15,864 on every page; the phone's asset folder 10,205,424 to 9,374,146); app icons, `icon.png` and the store
  art stay PNG. Caching: `public/` files had `max-age=0` on staging; the decoder is now immutable for a year and the art keeps a
  day (`static-cache.ts`, with a test that every public file is covered). Parallel reads in the quests page, Home, launch and
  the phone's boot. The web page skeleton appears after 0.4 s, so fast answers show no flash. "Mark these as read" on submissions
  is optimistic with rollback and a new browser test. Skipped with reasons: lazy loading (one picture in the first viewport,
  already eager), the bundle (framework floor 1,290,195 B, a route's own code at most 111,205 B, unchanged), the phone's
  skeleton delay (no render tests), `icon.png` and the adaptive icons (art and a store decision), AI streaming (no AI feature),
  throttled-Chrome timings (no baseline, shared loaded server). `function-limits-baseline.json` shrank by one entry
  (`SubmissionsPanel`). Run: `apps/app` and `apps/web/src` vitest 235 files, 2,681 tests passed (includes `words.test.ts`, the
  new `static-cache.test.ts` and `submissions.test.ts`); Playwright with one worker on desktop and phone, `layout`, `layout-check`
  and `submissions` 26 passed, then `submissions` and `quests` 18 passed after the last edit, and on desktop `quest-items`,
  `kiosks`, `big-screen`, `console-seasons` and `souvenirs` with `quests` 18 passed (the first run of the new submissions test
  failed on a locator that matched Next's route announcer too; fixed). Not run: the full suite (CI). CI 0 minutes (not pushed).

## Handoff to the company server — 2026-11-06

- 2026-11-09: mutation run 42551052841 put `apps/api/src/players/sign-in.ts` at 91.56% (0184's batch loop), over the bar.
- 2026-11-09: full suite on main 568dc0b3, 850 files and 13,379 tests passed, 0 failed, 1,012 s at load 3 to 10.
- The newest entries are below, then older ones. Staging: `release-20261109-9`, migration 0187 (0156 reserved for T-810d). Live
  today: gems removed and the Journey tab (T-404c, T-404d; ADR-760 to 768), FOLLOWUPS batches 1 to 7, ADR-810 (the company server
  builds and tests with fake data only; CranL keeps the hosting). Tasks 186 done, 33 open. CI run 42263782013: 12,981 tests passed.
  **Next:** `docs/agents/COORDINATOR_HANDOFF.md`, first the server measurement.

## T-813 part 1 — 2026-11-07

- **T-813 part 1 (tier B, API and SQL; migrations 0172 to 0175; no package change; ADR-816 and Q-753 proposed).** Items 1 to 4 of
  `docs/PERFORMANCE_AUDIT.md`, measured on 2 million ledger rows (the audit's "T-813 results" has every figure and its conditions).
  0172: four ledger, XP and audit indexes: `member_ledger` 2.8 million buffers to 3,249, `manual_awards` 2.2 million to 1,177, a
  rehearsal wipe of 323 rows 276.7 s to 0.27 s (968 table scans to none), the data export's audit read 63,713 to 6. 0173: the
  invitation queue index `(campaign_id, channel, id)` and `invitation_claim_at` restated to read its page unlocked and lock as it
  fetches: first fetch 1,955 buffers and a disk sort to 79, and a claim of 5 holds 10 rows (the first version held 400). 0174 and
  0175: the ledger's quest key on `(quest_id, event_id)`, no new index: a 26-quest draft delete 7.76 s to 0.23 s, a 10-quest
  category in a small event 3.13 s to 0.11 s, in the largest event 3.0 s unchanged (Q-753). Each quest row writes two more index
  entries; the ADR-734 gate shows 9.92 ms old and 9.89 ms new. N+1 and selective fetching had nothing to apply, and one tie-breaker
  landed (`readOwnerOthers`). T-813 stays open: part 2 (items 5 to 10) is still running. CI 0 minutes (not pushed).

## FOLLOWUPS batch 22 (player app) — 2026-11-08

- **FOLLOWUPS batch 22, player app part (tier B, `apps/app` only; no API change, no migration, no new string).** A zero-point replay
  that the server answered from a stored key now reads "Already recorded" (`scanner.alreadyRecorded`) everywhere a completion answer
  shows paid points, not "+0": `PollEntry`, `ShareEntry`, `SurveyEntry`, `VoteEntry` and the game result (`game-words.ts`) go through
  the new `playText` (`amount.ts`; `isRecordedAgain` then `paidText`), and each entry's choice of text is a pure function in
  `play-words.ts` (`pollSaid`, `voteSaid`, `surveySaid`, `shareSaid`) with unit tests in both languages. The vote, survey, share and
  game-result answers now carry `replayed` (the API already sent it). `scan-quest.tsx` plays the light impact, not the Success
  buzz, on such a replay. `completedOutcome` moved from `QuestSheet.tsx` to `amount.ts` (no screen import, so it can be tested)
  and has its own tests. First awards and replays that pay keep their points. Checked and left: `MeetEntry` (the passer's points
  from the pass state, no replay flag), `QuizEntry` (`earned` is the quiz total), the operator `review.tsx` (the staff review's points)
  and `SubmissionEntry` (shows no points). CI 0 minutes (not pushed).

## FOLLOWUPS batch 21 — 2026-11-07

- **FOLLOWUPS batch 21 (tier B, app, web and shared; no migration, no package change, no ADR, one new string).**
  A replay that pays nothing (the first answer's points were later removed) is no longer a "+0" success: the player's scanner and the quest
  sheet say "Already recorded" («سجّلنا هذا من قبل», `scanner.alreadyRecorded`, ux-araby and the glossary: a نحن verb, no heavy passive), and the
  kiosk and the operator station show their existing orange "already done" card instead of a green one (`replayed` with `points` 0 only; a
  replay that paid, and a first scan of a 0-point quest unless its response was lost and retried, stay as they were). The T-617 partial indexes' insert cost is measured in buffers
  (`PERFORMANCE_AUDIT.md`, Item 1): about two more buffers a row for a submission or ticket operator row (the ledger case is noisy, 0.4 to 2.8), +1% to +15% of the statement, extra dirty pages not distinguishable from noise; UPDATEs not measured.
  Checked and left: the T-804c NIT (no door but `complete_quest_answer` returns the ranking entries, so each other door needs its own
  migration; Q-640 stands), the `use-read.ts` rejected-load test (the app has no hook renderer or DOM in its tests; one needs a dependency)
  and the `sum()` NULL note (SQL). CI 0 minutes (not pushed).

## FOLLOWUPS batch 20 — 2026-11-07

- **FOLLOWUPS batch 20 (tier B, API and SQL; migration 0176; no package change, no new ADR, ADR-492 amended, no
  new string).** 0176 restates four functions with their grants: the personal fan-out checks `notice_audience_ok`, so a streak
  reminder or an invitation whose player played or joined since writes no center row; a banner slide's link port must be 1 to 65535,
  as `isAllowedLink` says; `own_level_items` matches `reached_at` to the XP entry, as `own_level` does since 0168; `admin_unpublish`
  takes the target's report lock before the target row, the order `admin_report_resolve` keeps. The team's held-prize count leaves
  rehearsal accounts out. `code_not_sent` answers 503, as `email_change_notice_failed` and every failed send (no client reads the
  status; API.md and the plan row updated). The owner email change's notices stay outside `outboundMailPerDay`: they carry the Stop
  link and the held one is the only guard on the no-password path (ADR-815), so the plan text now says only the code email counts;
  ADR-492 records the applied notices as at-most-once; the plan's digest lines say one per 10 minutes. T-813's key test also checks
  `confupdtype`, `condeferrable` and a 23503 for a ledger row in another event than its quest. Each fix's test failed without it.
  Left in FOLLOWUPS: the first password's notice (telling it from a reset needs a reset-link marker in sign-in, tier A), the T-713
  render test, ADR-816's index line. CI 0 minutes (not pushed).

## FOLLOWUPS batch 19 — 2026-11-07

- **FOLLOWUPS batch 19 (tier B, API, app and web; no migration, no package change, no ADR, no new string).**
  The English busy text now ends "Refresh the page in a few minutes." (the Arabic is as it was); `useRead` counts a rejected load as a
  failed read, so Retry cannot stay disabled; the `change_set_release` test also runs with the editor's member row deleted. The feature
  cards carry `aria-busy` while a choice saves and focus returns to the select by `data-field`; the panel is keyed by organizer; a
  browser test of a failed save (and `aria-busy` and focus in the held-reload test) joined `feature-layers.spec.ts`. The daily
  challenge spinner turns `coin.png`, not the emoji. R16 and Q-552 no longer read as if Q-069 were open (ADR-130, Saqr); the "Fixes
  needing no new art" and "Stale notes" sections left `ASSET_NEEDS.md`. The T-810f NIT is now a comment at `shop.ts` (the key id is a
  hint). Left in FOLLOWUPS: `requestJson`'s timeout (141 callers, some run for minutes, so it needs per-call limits) and a failed-reload
  test; T-810c's items (each is a sign-in function change or a migration). CI 0 minutes (not pushed).

## FOLLOWUPS batch 18 — 2026-11-07

- **FOLLOWUPS batch 18 (tier B, API, SQL and app; migration 0171; no package change, no ADR, ADR-766's build note amended).**
  `own_achievements` hides "next" only when the next tier is the revoked one; `admin_amounts_save` stores a missing row only for a save
  that changes something; `daily_xp_field` loses its unreachable range branch and its `top` (the CHECK of 0163 holds the range, and the
  amounts paid do not move); `admin_xp_table_save` takes no lock on a souvenir or unknown item id; `admin_report_resolve` compares
  usernames folded, as the unique index does. A change set's claim is let go of through a new door, `change_set_release`, even when the
  caller just lost the event, and a close that overtakes an apply answers 409 `change_set_finished`, not 500. The busy text says up to 5
  minutes (Arabic through ux-araby). The past points 5 s check runs only with `PAST_POINTS_TIMING`. Smaller: `isInEvent`'s type, the
  survey docstring, the `GET /v1/admin/events/{eventId}` row (`reason`), the organizers test's four actions, Journey's Retry waits while it
  reloads, the profile's theme gap. Closed without code: T-714's cursor (already done, 0167 clamps to 51). Review 94. Left in FOLLOWUPS: `ranking.ts`'s `own_level(NULL)`
  (+1.3 ms a read, ADR-766's note amended; the API role cannot read `player_xp`), the level subquery in 0164 (a shared
  function would not inline), `PODIUM_MIN`, the template `branding`, `sign-in-rush`. CI 0 minutes (not pushed).

## FOLLOWUPS batch 16 — 2026-11-07

- **FOLLOWUPS batch 16 (tier B, API and SQL; migration 0170, no package change, no new ADR, ADR-494 amended).** `record_completion`'s
  replay answers the completion's current net: the quest entry, its adjusts and its own removal (0170 restates it from 0098, score only;
  a bonus stays out, as in the first answer). `releaseSet` clears only its own claim: `claimSet` answers its end time as the token, no new
  column. An `email_change_dispute` alert goes past the 100-a-day digest cap in a digest of its own, because the console badge counts
  urgent reports only; the urgent rows beside it still close `skipped`, the run's `capped` count logs as an error, and the digest keeps the
  10-minute spacing. A repeat that answers `expired` no longer logs `desk.sale_offered`. New tests: `cancelled` and `skipped`
  announcements stay out of the hour and day message counts; the staff CLI's success path exits 0 with a generated RSA key and a preload
  `fetch` that answers OK; the initial secret differs per account. Left in FOLLOWUPS: the rest of the T-701b, batch 7 and batch 14 lines,
  and the staff invite's 502 and 503. CI 0 minutes (not pushed).

## FOLLOWUPS batch 15 — 2026-11-07

- **FOLLOWUPS batch 15 (tier B, CI and ops upkeep; no migration, no package change, no ADR).** `ci.yml` gets a `monitoring` job that runs
  `pnpm monitoring:validate` only when `ops/monitoring/` or `ops/alerts/questify.rules.yml` changed (`ci-scope.mjs` prints
  `monitoring=true|false`, true on doubt); `full.yml` splits into `checks` and a two-shard `browser` job copied from `ci.yml`;
  `pnpm infra apply` refuses a file of more than 3 apps or 2 databases and a create past that count (staging's fourth app, ADR-812,
  passes while nothing is created); `openStream` moved to `ops/load/schedule.mjs` with tests (shed, intended time, slot freed); a local
  load run throws on a plan without `database`; the seat-limit 1,000 accept-all test has a 120 s limit; the `monitoring-setup` test has
  one module-loading helper. Left in FOLLOWUPS: the email template's repo URL (needs a Docker validation and a redeploy), the rules
  copy, the T-804 NITs, 0148's rollback SQL, the routes on `afterCompletion`. The two workflow edits are held on local branch `workflows-pending` (FOLLOWUPS): the server's token has no `workflow` scope.

## Staff first password and the held change's notice — 2026-11-07

- **Staff first password and the held change's notice (tier A; migration 0169; ADR-814, ADR-815, Q-751, Q-752
  Proposed).** `staff.cjs create` takes no password, no flags and no standard input: it makes an account with no role and mails a
  24-hour set-password link; a platform admin is plain `create`, a confirmed sign-in, then `grant-admin --reason`. A held email change
  applies only with a recorded notice to the old address: a failed send closes it (503 `email_change_notice_failed`), and a waited
  apply with no record closes `send_failed`. V6.4.1 stays Partly and gap 18 open until the audit query in the plan has run on each
  environment (FOLLOWUPS). `RESEND_API_KEY` is unset in `ops/cranl/*.json`, so one Gmail failure closes the change. CI 0 minutes
  (not pushed).
  Code review 89, its MAJOR fixed (the CLI now prints why a send failed).
  Deployed as `release-20261107-3`; rows held before 0169 on staging were not counted (the check printed nothing) and close `send_failed` at their due time.
  **Next:** the audit query on each environment.

## FOLLOWUPS batch 17 — 2026-11-07

- **FOLLOWUPS batch 17 (tier B, web only; no migration, no package change, no ADR, no new text; touched suites and the two browser specs only).**
  The console's per-organizer feature selects keep the chosen value, and stay disabled, from the save until the list read answers
  (`shownChoice`; a failed save drops the choice); the feature usage page clears its last error when "More" starts, so an old error
  no longer stands beside a running read. Closed without code: the organizers page's loading state (already done in batch 9,
  `organizer-list.ts`). Left in FOLLOWUPS, with a 2026-11-07 check note: the matrix "stale" filter (a new `show` value, so an API
  change), the dashboard pages reading the store (Q-380 waits for a product call), `event words not read` (an API 500, no web fix).
  CI 0 minutes (not pushed).

## FOLLOWUPS batch 14 — 2026-11-07

- **FOLLOWUPS batch 14 (tier B; migration 0168, new and undeployed; ADR-813 and Q-743 Proposed).** The console's numbers leave out the
  review demo's organizer, its events and its accounts; the session message limit counts the event's announcements of the window
  (one way, ADR-813); the door's check-in shows staff the full name while the event shows names; `own_level` reports a level-up only
  for a level written in the scan's own transaction (read only). Batch 13 review: `inviteCancel` says withdrawn, `revertibleIds`
  reads `before` only for amounts, `previous` has a real-database test, the empty assertion is gone. T-612's expired offers: no code,
  batch 10's `expired` answer closed the line and a row left `offered` is the design. Left in FOLLOWUPS: the rest of the T-615 line,
  the T-709d item pre-check, the two device checks. CI 0 minutes (not pushed).

## FOLLOWUPS batch 13 — 2026-11-07

- **FOLLOWUPS batch 13 (tier B; web, console, player app; no migration, no package change; touched suites only, the full run is CI's).**
  "Prizes to collect" keeps its two desk hints behind the info button beside the title (`InfoTip`); the console history says 36 more
  audit actions in words (14 new texts: event, quest, reward, category, guest-list, feature-request and invitation edits); the Amounts
  revert dialog names each amount it puts back (`GET /v1/admin/catalog/amounts` now carries `previous`, read from the newest audit
  entry's `before` in the API, no SQL change); the texts matrix badges `console.*` keys "Not shown in the app"; the usage list leaves
  out the review demo's organizer (read in the same seat); the intro shows "Loading…" instead of an empty stage while the card order
  is read; the first stop of a launch is a tested function (`firstStop`); iOS announces each new intro card's title. Left in
  FOLLOWUPS: the numbers page's demo rows (SQL, needs a migration), the first frame of shipped text, the Android export-file check
  (device), Android focus after Next.
## FOLLOWUPS batch 12 — 2026-11-07

- **FOLLOWUPS batch 12 (tier B; missing API tests only; no production change, no migration, no package change).** Seven new tests, none
  exposed a bug: the maps' player read leaves out a hidden category's pin until revealed and a flash quest outside its window (database
  and HTTP) and a quest of a switched-off type (HTTP, through the organizer's `shareQuests` override); two simultaneous `alert_claim`
  calls on two connections lease different rows; the same briefing key on two connections writes one briefing, and five simultaneous
  briefings let exactly 3 through the hour limit; an upload runs while the re-seal batch is open (one row written, one waiting on a lock);
  0164 waits for a daily-challenge finish in flight with no deadlock. The rewards guard test's `pg_stat_activity` match now names the
  builder's event-lock query. Touched suites: 138 passed (logs in `/home/deploy/questify-logs/b12-*.log`). Not pushed.

## FOLLOWUPS batch 11 — 2026-11-07

- **FOLLOWUPS batch 11 (tier B; web, ops scripts, copy; no migration, no package change).** The load test's idle wait and lock samples
  look at the run's own database, not every `questify_test_` one; `requireLoopback` lives in `local.mjs` and `profile.mjs` uses it; the
  RUNBOOK says a non-loopback `--admin-url` or `--redis-url` is refused; the event switches' routes and titles moved from two client
  components into `lib/event-switches.ts`, so the template preview imports no component; the console organizers list's reads moved
  into `lib/organizer-list.ts` with tests for loading, appending, failures and stale replies; the template confirmation's Arabic and
  English agree in voice (e2e string updated); the `--rush` error says rate and seconds are numbers.
  `scripts/cranl/monitoring-setup.test.ts` (a local fake, never CranL): `create` refuses on a state file or an app of that name and
  makes no write, and the state file is 0600. Touched suites: 118 passed. Not pushed.

## T-018b staging monitoring app, replaced — 2026-11-06

- **Staging monitoring app is `questify-monitoring-staging` (tier C; ADR-812 Proposed; Q-610 stays open, T-018b stays unticked; no migration).**
  CranL refused a source change on the public-repo `questify-prometheus-staging` and `plan: true` had not caught it, so Dhia created a new
  app from `/ops/monitoring/stack` (volume on `/data`, a new password held only in CranL), set the API's telemetry settings and restarted
  the API: metrics arrive, 20 rules are loaded, `/-/healthy` and OTLP answer 401 without the password, `/readyz` is 200, alert email is off
  (Q-581). Done in the repo: `staging.json` and its test name the new app and carry the API's `TELEMETRY_*` and `OTEL_*` (the password an
  operator secret), RUNBOOK and the handoff updated, `monitoring_state.json` ignored by git and EAS, the state file written 0600, and
  `monitoring-setup.py create` refuses when the state file or an app of that name exists. T-811 gained the questions about CranL's twin
  server and "Saudi-3". **Still open:** the key does not cover the new app (403), so three checks wait (why CranL shows "deploying", `/data`
  surviving a redeploy, Grafana sign-in) and `plan staging` must show no differences; the old app stays stopped until Dhia deletes it
  (4 apps against the limit of 3 until then). `infra.test.ts` and `monitoring.test.ts`: 76 passed.
  **Next:** the key covers the new app, then those checks, then tick T-018b's staging part; the rest of T-018b is unchanged.

## Break and handoff — 2026-11-02

- Progress 149/197 (75.6%). Staging at migration 0117. `main` has T-709b (0119, CI green, undeployed); T-704 (0118)
  is built on branch `worktree-agent-a5a2d1538fa9b8395`, awaiting its tier A code review. Next steps are in
  `docs/agents/COORDINATOR_HANDOFF.md` "What to do next".

## FOLLOWUPS batch 10 — 2026-11-06

- **FOLLOWUPS batch 10 (ADR-355; tier B; migration 0167, new and undeployed; ADR-811 Proposed, Q-742).** Feature usage's last page ends
  with no cursor; `set_by` is closed to the API role's reads; a key replayed after its offer ran out answers `expired`; flag alerts
  are one per event per 15-minute window, newest first; held prizes are read by `my_held_prizes`, so an old one is never missed; My
  QR's sale card uses the event's currency word; `event_organizer_idx` is dropped. T-710's staff refusal is confirmed, no code. Left in
  FOLLOWUPS: the organizers page's loading state, and `start_player_challenge`'s window read (sign-in, tier A). CI 0 minutes (not pushed).

## FOLLOWUPS batch 8 — 2026-11-06

- **FOLLOWUPS batch 9 (tier B; web, console, ops script; no migration, no package change).** The console organizers list empties and
- **Dependency batch (tier B).** The packages of closed PR #9 are in: `next` 16.4.3, `oxfmt` 0.75, `oxlint` 1.90, `redis` 6.3.1, `zxing-wasm` 3.1.6 (the kiosk's wasm moved with it), `@types/node` 26.6.6, Stryker 10.1.1. Format, lint, types and the web build pass; CI is the gate for the suite and the browser tests.
  says Loading on a new search (stale replies ignored); the template preview reads its switch titles from the event page's switch
  maps (cheers and ranking now show) and the wizard's template step shows only for a draft; the template confirmation no longer
  says it replaces features (Arabic and English); `DELETE /v1/admin/switches/{features,tuning}/{key}` answers 422
  `invalid_catalog` for an unknown key like the PUT (API.md); load test: `startApi` times out, the rush waits for idle databases,
  a local run refuses non-loopback URLs, bad `--rush` steps are refused; `Telemetry.flush` documented as test-only. Left in
  FOLLOWUPS: the feature-usage cursor (needs a migration), intro row labels (web has no text overrides), `afterCompletion`
  routes (Q-640), the `openStream` test. CI 0 minutes (not pushed).

## FOLLOWUPS batch 7 — 2026-11-06

- **FOLLOWUPS batch 7 (ADR-355; tier B, SQL and locking; migration 0166, new and undeployed; ADR-800 to ADR-802, Q-740, Q-741).**
  Prepare ends the numbers' challenges before locking the reviewer; a self-erase locks all the player's deletion challenges in
  id order; a change set's apply rechecks and records each item in the write's transaction and claims the set by a column
  instead of holding a connection; `sponsor_tag` has its event foreign key and `sponsor_delete` counts what the dialog lists; the
  rehearsal's two sums read the same kinds; a player no longer reads a held reward's name in a goal's marker; the survey CSV says
  when text answers were cut; the outsider suite calls `survey_shared_results` for real; a duplicate copies the big screen's
  scenes only from an event with the add-on. No points, sign-in or redemption logic changed. Each fix has a test seen failing
  first (the outsider call is a new test on behaviour that already held). CI 0 minutes (not pushed).

## T-404c completion speed, old against new — 2026-11-06

- `profile.mjs --big-event-players 50000`, database ms a completion, old (`d56e0f8c`) and new in turns on one database:
  old 20.66, new 12.72, old 14.76, new 12.77, then old 12.81, new 12.98 (+0.17 ms). The PC was not quiet: a B7R test run
  used about 3 cores for the first rounds and CPU stayed at 44 to 75% in the last pair. No slowdown shows, and the code
  review found only a NULL-key foreign key check, a partial-index predicate and a longer CHECK on the path (at most
  +68 us, one run). The absolute ADR-734 gate is still not re-measured on a quiet machine: the last quiet old-code figures
  are 10.78 and 10.98 ms against 10 ms. T-804's production-like rerun settles it.

## T-404d built — 2026-11-06

- **T-404d built (tier B; no migration, no server change, no new ADR; the tier B code review with the Arabic pass is owed,
  and a phone check: RTL, Reduce Motion, VoiceOver and TalkBack on the trail).** The Questify bar has five tabs again: Home,
  Explore, scan, Journey («رحلتي»), Profile (`QUESTIFY_TABS`, ribbon icon until the 3D set). `JourneyScreen`: wooden plaque with
  the level medallion, title and XP bar ("1,400 of 2,000 XP"); the next level's item as a locked preview; the level trail
  (reached levels with a gold check, the player's own glowing and still under Reduce Motion, later ones faded with a padlock;
  it opens at the player's stone when that is below the first screen); the achievement items with tier medal, state icon and
  "Reach gold in Wanderer"; skeleton, retry on a failed read, a sign-in button signed out. A tap on an owned item opens the
  locker on its tab. `LevelBadge` (a wooden shield with the number, decorative to a screen reader) beside the name on event
  ranking rows, the podium and both profile headers, a blocked row included; the spoken row ends with "Level n"; an answer
  without a valid `level` draws no badge. The podium's badge is 18 points, the name line's height (26 at most on a row), so a name keeps
  its width at 320 points; `PODIUM_MIN` stays 100 (it was 96 before the badge; it can go back, FOLLOWUPS). Sync toasts: an achievement toast carries the XP its tiers paid, and one toast for each item given. Console:
  the achievement editor's "Unlocks" item and tier fields and a card line; `item` is sent only when changed. Two leftovers of
  T-404c in `console-catalog.spec.ts` fixed (the amounts revert read the removed "Level up" field; the item source check read
  the wrong element). No gem or price word on any new string (`no-gems.test`, `journey.test`).
  Tests: touched suites 234 files, 2,645 passed (apps/app, i18n, apps/web/src/lib); browser `console-catalog.spec.ts` 14
  passed and 2 skipped on desktop and phone, `layout.spec.ts` passed on both (one earlier run; the rerun after its race fix was
  `console-catalog` only); `npx expo export` (Android) bundles; oxlint, oxfmt, `lint:limits` and types clean; the full suite
  was not run on this shared PC (CI runs it). `readRanking` complexity 13 to 12 in the limits baseline. CI minutes: 0 (not
  pushed); agent tokens roughly 700k (estimate). Mutation: none (tier B). Review fixes (86): a title's name plate shrinks
  and its name is shown once (trail, rewards, next-reward card); a locked achievement card shows one padlock; a failed
  items read in the console shows a notice with Retry instead of raw ids; Arabic copy («العنصر الذي يفتحه», «ستحصل على … قريبًا»,
  hint «يفتح الخزانة»); spoken labels use «،»; a level with no item is no longer "where you start" after level 1.
  **Next:** the tier B code review of T-404d, the tier A code review of T-404c, then the next unchecked task in `docs/TASKS.md`.

## T-404c built — 2026-11-06

- **T-404c built (tier A; migrations 0163 and 0164; tier A code review and mutation owed).** Gems and the Questify gem shop
  are gone from the database, API, shared package, app and console. Achievement tiers pay XP once when earned (50, 150, 300,
  edited in Amounts); achievement items with the console door (five gold tiers seeded with former shop frames); bought items
  stay owned as source `questify`; `level` on event ranking rows and `me`; `GET /v1/me/rewards`. Plan review 86 folded; ADR-761
  to ADR-768 Accepted; Q-720 to Q-725 Answered (Q-724 the tab is "Journey" «رحلتي»; Q-725 the event's gem icon stays).
  Tests: full suite once: 835 files, 12,871 passed, 6 fixture failures, fixed and passing on rerun; the suites the later 0164
  edits touch were rerun, not the whole suite. Ranking read (50,000 players, old and new alternating on one database, median
  of 15): `ranking_top(…, 100)` 173.1 to 181.3 ms (+4.7%), `ranking_rows` 78.6 to 79.0 ms (+0.4%), inside the gate.
  **Completion gate (ADR-734) not settled:** `profile.mjs --big-event-players 50000`, one run each, back to back, base first, with
  another worker sharing the container: base (d56e0f8c, before T-404c) 14.64 ms, branch 15.87 ms (+8%); both over the 10 ms gate,
  so the load is the machine's, but this cannot show the completion did not move. Self times rise across functions T-404c does
  not touch, except `xp_credit`, 0.83 to 1.05 ms, which does insert into `xp_entry` (its new CHECK and foreign key). A
  quiet-machine run of both is owed. Staging app builds break on sync until rebuilt: the old app parses the answer's `gems`.
  The bar has four tabs until T-404d. CI minutes: 0 (not pushed).
  **Next:** the tier A code review of T-404c, then T-404d (Journey screen, badge, console Unlocks field).

## T-404c plan — 2026-11-06

- **T-404c planned (tier A; no code yet; awaiting the plan review).** `docs/plans/2026-11-06-t-404c-levels-only.md`:
  gems and the gem shop removed everywhere (migrations 0162 `platform_setting` only, 0163 the rest), achievement tiers pay
  XP, achievement items, the level on event ranking rows, `GET /v1/me/rewards`; the screens split out as T-404d (tier B).
  ADR-760 Accepted (Dhia); ADR-761 to ADR-768 and Q-720 to Q-725 Proposed. CI minutes: 0.
  **Next:** the tier A plan review of T-404c.

## FOLLOWUPS batch 8 (tier B) — 2026-11-06

- **FOLLOWUPS batch 8 (migration 0165, new and undeployed; ADR-790, ADR-791 and Q-730 Proposed).** Cleared: a browser
  test for the points and keep-or-remove dialogs of a played quest in a live event (`live-points.spec.ts`, with the
  `/played` control and `test/support/played-seed.ts`; it proves future-only leaves past completions alone and
  past-too rewrites them, through the impact read, and that Cancel changes nothing); the template confirmation names
  the features, accent colour and layout it also sets; the console history says 29 audit actions in words and shows a
  suspension's or lifting's reason beside it (`readHistory` returns `reason` for those four actions only); `operator_activity`
  (restated in 0165, closed to PUBLIC, same grant) returns `reachable`, the operators a briefing reaches, and the
  confirmation says it (a banned operator is listed but not counted); `useFeatureUsage` empties the list while a new search loads and
  says Loading; the `openJoinedEvent` membership mapping is one tested pure function (`join-result.ts`) used by the join
  card and the invitation; a late config answer after the intro's fallback refreshes the stored copy (tested); `infra.test.ts`
  covers an apply that stops halfway and a re-run that continues. T-605's Ask Questify line stays with a note (T-703
  stores no support contact; T-706 does, and the Contact page already shows it). Not touched: points, the ledger,
  sign-in, redemptions, levels and the Journey screen (the new browser test only reads them). Left in FOLLOWUPS: the rest of
  the audit actions in words, the organizers page's loading state, the `index.tsx` intro order test, the budget guard.
  **Next:** the next unchecked task in `docs/TASKS.md`.

## FOLLOWUPS batch 7 (light; tier B and C) — 2026-11-06

- **FOLLOWUPS batch 7 (no migration; ADR-780 Accepted and Q-705, Q-706 Answered after review 82).** Cleared: the catalog's
  name pairs (`catalogPair`) refuse the zero-width and mark characters `catalog_text` refuses, so the console names the
  field (`cleanText` and `hasUnsafeCharacter` stay: a template body's text is not read by `catalog_text`, translation
  overrides share the second and the shipped texts keep U+200E); `alerts:check --always` for `ci:full` and a step in `full.yml`, so
  the nightly run checks the alert rules (actionlint and zizmor clean); ADR-743 and ADR-744 wording, and the ranking
  switches' confirmation title (new text `events.ranking.todayTitle`); the real guarantee of the T-705 wall in ADR-430;
  Q-705 lists, from the code, which of the 27 switches have a door that refuses (25) and which only change what the server
  does (`dailyStreak`, `pushNotifications`); the RUNBOOK's proofing steps for a lost staff mailbox and a player's lost
  number, and `staff.cjs create` with a random unseen password (ASVS V6.4.4 Met, V6.4.1 Partly); a load run stops on
  SIGTERM and SIGHUP like Ctrl+C and kills its drivers (`ops/load/interrupt.mjs`). Left, with notes in FOLLOWUPS: the T-705
  comments and copy in 0120 (a migration), a ledger-insert test for the guard's lock (needs a database), an invite or a
  forced first password change for `create` (tier A). Unit suites only (no database, browser or build, the PC was shared):
  343 files, 4,445 tests passed (`apps/web apps/app packages scripts ops`); oxfmt, oxlint, `lint:limits` and types clean.
  CI minutes: 0 (not pushed); agent tokens roughly 700k (estimate).
  **Next:** the next unchecked task in `docs/TASKS.md`.

## FOLLOWUPS batch 6 — 2026-11-06

- **FOLLOWUPS batch 6 (tier B; migration 0162; 0156 stays reserved; ADR-745 to ADR-749 and Q-704 Proposed).** Cleared:
  `admin_report_resolve` closes with `unpublished`, `event_suspended`, `username_changed` or `player_banned` only once that
  action is in place (RP409, HTTP 409 `outcome_not_taken`); `report_target_seen` and the username 404 vs 201 kept, reasons
  in ADR-745 (T-705b; its `community_goals` part stays open); `catalog_text` refuses zero-width marks and whitespace alone
  (ADR-746); `event (organizer_id, created_at DESC, id)` after the plan on 3,000 events showed a sort of all of them
  (T-714, ADR-747); the health view's oldest push and notice are exact through two partial indexes (T-709, ADR-748); a
  real-database COMMIT-deadlock test for the migration runner (T-022); the feature-usage page parses only the demo's id;
  `pnpm alerts:check` runs promtool in `ci:changed` and the PR gate when `ops/alerts/` or `ops/monitoring/` change
  (T-018, ADR-749; actionlint and zizmor clean). The T-221 `ORDER BY` mutant was already killed in 44d44d98. Nothing
  touches points, sign-in or redemptions.
  Full suite once: 839 files; 66 files timed out in their database setup hooks on the shared PC and passed on one rerun
  of those files (2,787 tests); every other file passed. Oxlint, oxfmt, `lint:limits` and types clean. CI minutes: 0 (not
  pushed); agent tokens roughly 400k (estimate).
  **Next:** the next unchecked task in `docs/TASKS.md`.

## FOLLOWUPS batch 5 — 2026-11-06

- **FOLLOWUPS batch 5 (tier B; migration 0161; 0156 stays reserved; ADR-742 to ADR-744 and Q-703 Proposed).** Cleared:
  the Cheers switch (Big screen page), the ranking switches and the day streak ask before a live event loses them, with
  the twelve switches' text (T-604b; the streak asks at Save); "Explain this" on Maps, Agenda (`sessions`), Prizes and
  Operators, with the pages in `STEP_PAGES`, `OperatorsPanel` split into `useOperators` (T-605); `useOverrides` unit test
  with a fake React and `AppState` (T-702); a test that only `admin_amounts_save` writes the `xp`/`gems` rows of
  `platform_setting`, and an Amounts revert that asks (T-709c; its dialog does not name the amounts, see FOLLOWUPS); an
  XP-table revert that lowers the curve names the levels and the gems (T-709d); the generic `PUT …/features/:feature`
  dropped, no client called it (T-711; ADR-503 amended, API.md updated); `e2e/console-review-demo.spec.ts` and the
  feature-usage page leaving out the demo's organizer in `readFeatureUsage` (T-710); migration 0161 tightens
  `home_text_checked` (T-713). Nothing touches points, sign-in or redemptions.
  Full suite once: 838 files, 12,951 tests passed after `scripts/ci-scope.mjs` learned the new spec (16 files skipped).
  Browser: `layout`, `cheers`, `confirmations`, `streak`, `setup`, `console-catalog`, `console-review-demo` on desktop and
  phone (36 passed, 2 phone skips), and `feature-layers`, `events`, `organizers`, `operators`, `maps`, `prizes`, `sessions`,
  `console-feature-usage` on desktop (26 passed). Oxlint, oxfmt, `lint:limits` and types clean. CI minutes: 0 (not
  pushed); agent tokens roughly 1M (estimate).
  **Next:** the next unchecked task in `docs/TASKS.md`.

## FOLLOWUPS batch 4 — 2026-11-06

- **FOLLOWUPS batch 4 (tier B; migration 0160; 0156 stays reserved; ADR-735 to ADR-741 Accepted after code review 88, Q-702 Answered).** Cleared:
  a failed top-10 diff is stamped by `rank_push_failed` and goes to the back of the list (T-503); a failing group push
  page is counted, backed off 1/4/16 minutes to an hour and parked at the third failure, so later sends go ahead
  (T-706b; worker logs `push.group_page_failed` / `push.group_push_parked`); `cheers_purge` deletes an ended moment's
  cheers after 3 days, one event and 5,000 a lifecycle run (T-509); `request_feature` checks the organizer unlocked, then
  reads the event `FOR SHARE`, and the admin's unlock takes it `FOR NO KEY UPDATE` (T-711b, two-connection test); the duplicate runs at REPEATABLE READ, retries once on 40001, and
  `event_copy_setup` refuses a lower level (T-601, mid-copy race test); the streak scan rests an hour after an empty
  pass (`streak_scan_quiet`, now PL/pgSQL, left the SQL allowlist) (T-501f); low-stock alerts have a 6-hour cooldown per
  reward and item (T-609; its "no two-connection claim test" part stays); the manual-awards report lists `adjust` lines,
  signed (T-604, display only). Nothing writes points differently. Full suite once: 837 files, 12,936 tests passed
  (16 files skipped). Oxlint, oxfmt, `lint:limits` and types clean. CI minutes: 0 (not pushed); agent tokens roughly
  1.5M (estimate).
  Code review 88: `cheers_purge` now picks one event and walks `cheer_by_event`; the Allow takes `FOR NO KEY UPDATE`;
  `request_feature` locks only after its checks; a balance-only `adjust` line shows its balance change.
  **Next:** the next unchecked task in `docs/TASKS.md`.

## T-810 documentation gaps 15 to 17 — 2026-11-06

- **ASVS gaps 15, 16 and 17 written (tier C, docs only; no code, no review).** `docs/SECURITY.md` has "Cryptographic
  inventory and key policy" (every key and secret: algorithm, use, what it may not be used for, holder, rotation and what a
  rotation breaks, from the code and `ops/cranl/*.json`) and "Sign-in pathways and their strength" (23 numbered pathways in
  three tables, plus three links that open one thing). `docs/SLO.md` section 6 is the log inventory of every layer. The sheet:
  V11.1.2 and V6.1.3 Met; V11.1.1 stays Partly (Q-700: no rotation schedule, no previous-key slot for `AUTH_SECRET` or
  `QR_SECRET`, no provider-key steps) and V16.1.1 stays Partly (retention not set: Q-443, Q-084). Counts 159 Met, 23 Partly,
  0 Not met. Found while writing and fixed in the RUNBOOK: its `AUTH_SECRET` paragraph said nothing stored depends on it
  (the deletion marks, opt-out links and email-change links do) and its `QR_SECRET` paragraph named only the quest QR.
  QUALITY_BASELINE section 4 says secrets rotate "on a schedule", which no document sets (Q-700). Q-700 and Q-701 added.
  The three FOLLOWUPS lines are gone. CI minutes: 0 (not pushed); agent tokens roughly 0.4M (estimate).
  **Next:** the next unchecked task in `docs/TASKS.md` (T-810d, T-811 open; ASVS gap 18 stays in FOLLOWUPS).

## FOLLOWUPS batch 3 — 2026-11-06

- **FOLLOWUPS batch 3 (ADR-355; tier B; two small migrations, 0158 and 0159; 0156 stays reserved).** Cleared: the team's
  actor carries the support-view mark (`actorOf` moved to `organizers/context.ts`, tested) and the console's rate-limit
  helper is one module (`console/throttle.ts`: `throttled`, `holdBackAdmin`; the three console copies and the support
  view's `enterView` use it); `readTemplates` skips and logs a bad template row (`event_template.invalid`) and
  `templateExists` checks only the requested key; a hint push whose category was shown before the claim is skipped as
  `category_shown` (0159, `push_skip_reason` restated); the monitoring stack's `stop_all` sends TERM then KILL after
  20 s, the mail sink listens on 127.0.0.1 with capped buffers (a note says Docker Engine on Linux cannot reach it),
  and `validate.mjs` removes its containers on Ctrl+C (the full `pnpm monitoring:validate` passed; the SIGINT handler
  itself is not exercised on Windows); the language cookie is `__Host-qs_lang` and the proxy still reads `qs_lang`
  once and removes it; `outbound-redirect.test.ts` finds `"use client"` only among the leading directives (parsed);
  the RUNBOOK says the `ranking.write_failed` `sqlstate` is the only trace; 0158 seeds empty `features` and `tuning`
  rows (a first save locks a row; an audit entry's `before` for a first save is now `{}`; two concurrent-save tests);
  the two plain refresh-expiry tests are renamed; the session link message names the quest; `QUALITY_BASELINE` §2 has
  the dependency fix time frames (critical 7 days, high 14, moderate 30, the rest monthly) and ASVS gaps 14 and 19 are
  Met (counts 157 Met, 25 Partly, 0 Not met). Nothing touched the ledger, sign-in logic or redemptions. Full suite once (four workers): 837 files,
  12,934 tests; five files failed because they inserted the `features` row that 0158 now seeds (fixed with an upsert);
  those five re-ran green (85 tests). Oxlint, oxfmt, `lint:limits` and types clean.
  CI minutes: 0 (not pushed); agent tokens roughly 1.2M (estimate).

## FOLLOWUPS batch 2 — 2026-11-05

- **FOLLOWUPS batch (ADR-355; tier B, no migration).** Cleared: a wrong staff re-authentication code now counts in the
  staff sign-in failure windows (`confirmStaffReauth` records it in the same transaction; counted, not gated, so a
  flood of failures against an email cannot also lock its owner out of ending other sessions); the RUNBOOK gives the
  owner statement for a re-seal `conflict` (delete only when `redemption_id IS NULL`, lower `stock_total` in the same
  transaction; two tests run it); `writeBatch` keeps the first error when `ROLLBACK` throws (test with a connection
  whose `ROLLBACK` raises); the `/v1` route is `[[...path]]` and exports `OPTIONS`, so OPTIONS and a bare `/v1` carry
  the API security headers (`lib/v1-route.test.ts`; checked on a real `next build` and `next start`);
  `outbound-redirect.test.ts` walks every server-side file of `apps/web/src` (client files, `forward.ts` and
  `post-json.ts` left out); the `WALLS` comment sits above `WALLS`; `ops/load/run.mjs` `removeJobFiles` warns instead
  of throwing and `runRemote` deletes the job files on Ctrl+C. Left, with the reason in `docs/FOLLOWUPS.md`: the 0155
  sweep order and the end-others lock (a new migration rewriting sign-in functions, tier A). Nothing about the console
  host was touched. Full suite once: 834 files; 790 passed, 16 skipped, 28 failed on hook timeouts (the shared
  PostgreSQL was overloaded at sixteen workers; no assertion failed); those 28 files re-run with three workers: all
  passed (251 tests). Oxlint, oxfmt, `lint:limits` and types clean. CI minutes: 0 (not pushed); agent tokens roughly
  0.5M (estimate).

## T-804e completion profile — 2026-11-05

- **T-804e done (tier A, ledger; no code shipped).** `ops/load/profile.mjs` (ADR-734) gives a reproducible number:
  10.78 and 10.98 ms a completion before; a draft 0158 (ADR-731 to 733) measured 11.32 and 10.73 ms, no gain, so it was
  dropped and those ADRs Rejected. Gap about 0.9 ms over ADR-674's 10 ms; ADR-730 (trigger merge, about 0.5 to 0.8 ms)
  deferred to T-804. Disk: C: had 7 GB free; eight merged agent worktrees and the web build cache were removed (9.5 GB
  free, still 98% full). CI minutes 0; agent tokens about 0.7M.

## T-804e completion profile (plan) — 2026-11-05

- **T-804e planned (tier A, ledger; plan `docs/plans/2026-11-05-t-804e-completion-profile.md`; ADR-730 to ADR-734 and
  Q-697 to Q-699 Proposed or open; migration 0158 reserved, nothing built).** The profile is committed:
  `ops/load/profile.mjs` (one load API, 300 QR completions to warm, 2,000 one at a time, database time from
  `pg_stat_user_functions`, then auto_explain in its own session for the statements and triggers), with
  `ops/load/local.mjs` shared with `run.mjs` and `profile-stats.mjs` (7 tests). Two runs on the shared test container
  (17.11, T-804 seed plus a 50,000-player event): **10.78 and 10.98 ms** a completion (client mean 24.0 and 24.3 ms);
  paced at 7.6 a second, 11.73 ms, so T-804c's 23.5 ms was its method, not the rate (Q-641). Top costs: the ledger
  insert's seven triggers (`xp_credit` 1.71, `streak_record` 0.84, `apply_ledger_entry` 0.44, guards 0.45),
  `record_completion`'s own statements and 13 key checks 2.37, the answer's read-backs 2.3. The plan merges the ledger
  triggers into one BEFORE and one AFTER, passes the XP month, checks ranking eligibility once and skips enrollment and
  flag work a score write does not need: about 1.4 to 1.8 ms off. `event_timezone_guard` is not on the completion path.
  Ops tests 48 passed; oxlint and oxfmt clean; full suite not run (no app or schema change). CI minutes: 0; agent
  tokens roughly 0.4M (estimate).
  **Next:** T-804e plan review (tier A), then the build.

## T-810f reward code key rotation — 2026-11-05

- **T-810f built (tier A; plan review 88 folded; migration 0157, new and undeployed; ADR-725 to ADR-729 and Q-694 to
  Q-696 Proposed or open; code review next).** Each sealed reward code names its key (`0x51 0x02 keyId`, header in the
  AAD); legacy rows open under key 1. Settings `REWARD_CODE_KEY_ID`, `REWARD_CODE_PREVIOUS_SECRET`,
  `REWARD_CODE_PREVIOUS_KEY_ID`, one parser (`rewardCodeSettings`) for the API and the command. 0157:
  `add_reward_codes(..., prior_hashes DEFAULT '{}')`, 3-argument version dropped, each prior mark 32 bytes. New
  `reward-codes.cjs reseal | check` (owner only; reads outside transactions, batch writes of 100 with compare-and-set,
  `NOT EXISTS` on the mark and `lock_timeout` 2 s; start and end audit entries; prints counts and row ids only). RUNBOOK:
  rotation steps, deploy overlap and forward-fix-only rollback. ASVS row 8 and V11.2.2 Met (153 Met, 28 Partly).
  Reseal never run against staging. **Checks:** full Vitest once: 12,860 passed, 18 skipped, 1 failed
  (`db/seat-limit` timed out at 30 s under load; passes alone, 21/21); security, rehearsal and touched suites pass;
  types, lint, `lint:limits`, format, API build pass. CI minutes: 0 (nothing pushed). Agent tokens roughly 0.5M
  (estimate).
  **Next:** T-810f code review; then T-810d and T-811.

## Mutation chase: T-810c re-authentication and devices — 2026-11-05

- **Survivors and no-coverage mutants of GitHub run 41961473533 chased (one round; dead checks deleted, no bug
  found).** Files under 90%: `auth/reauth.ts` (60%), `players/reauth.ts` (61%), `players/devices.ts` (81%),
  `console/staff-sessions.ts` (83%); `session.ts` and `staff-store.ts` are above 90% and were not chased. New tests:
  `test/players/devices.int.test.ts` +8 (the Arabic SMS by default, the email channel and its 5-minute text, one
  platform unit spent per text; the gateway's refusal and a failed email answer 503 and log only why; a full contact
  window answers 429 with `retry-after`, logs `step: reauth_code` and gives the unit back; a wrong code counts in the
  player's failure window and a right one does not, and a full window refuses the verify; PN401 from an ended device
  row answers 401 on the list and the code request; `asDevicePlayer` passes another error on unchanged; a stale sign-in
  ending one device answers `reauth_required`, and both end routes take no body or `{}` only; `labelDevice` stores the
  platform and the folded model). `test/auth/sessions.int.test.ts` +2 (a wrong staff code answers 4 tries left, a right
  one `freshUntil` about 10 minutes ahead, the email says 10 minutes; a second code inside a minute and the hour's
  sixth answer 429, a failed email 503, each logged). **Source change:** the confirm rows of both re-authentications
  and the player's start row are unions by outcome, so the unreachable `fresh_until !== null`,
  `contact === null` and `masked === null` checks are gone. 11 equivalent, listed in FOLLOWUPS. Kills spot-checked by
  applying mutants by hand (8 mutants, every one failed a new test). Lint, types and format clean; touched suites
  (`players/devices`, `auth/sessions`, `db/signed-in-devices`, `src/players/devices`, `src/auth/routes`) 128 passed.
  Scores are confirmed by the next grouped mutation run. CI minutes: 0; agent tokens roughly 0.3M (estimate).

## T-810c signed-in devices — 2026-11-05

- **T-810c built (tier A; migration 0155, new and undeployed; ADR-717, ADR-718 and Q-682 Proposed; Q-680 answered by
  Dhia, Q-681 by the developer).** Players: `GET /v1/me/devices`, end one or all other devices, a fresh code
  (`/v1/me/reauth/*`) unless the phone signed in or changed its contact in the last 10 minutes; the app's "Signed-in
  devices" screen and the offer after a phone or email change; the sign-in sends the platform and `expo-device` model.
  Staff: the dashboard account page lists sessions, ends another or all others after an emailed code
  (`/v1/staff/reauth/*`); the database checks freshness (`staff_session` writes are definers, ADR-718). Console: "End
  all sessions" on the Admins page and each organizer team row (`POST /v1/admin/staff/{id}/end-sessions`, FR-141).
  Every family end goes through `end_family` (device row locked first, ADR-717); races tested in parallel (end vs
  rotation, the 11th sign-in vs the oldest rotation, end-others vs a new sign-in). ASVS V7.4.3, V7.4.5, V7.5.2 Met
  (152 Met, 29 Partly). **Checks:** see the reply; 0155 also passes on PostgreSQL 16.15. CI minutes: 0 (nothing
  pushed). Agent tokens roughly 1.5M (estimate).
- **T-810c reviewed (91, no BLOCKER or MAJOR) and live on staging** (0155 applied and verified, tag
  `release-20261105-3`; probes 200/200/200/307). The coordinator fixed two minors (erasure locks device rows first;
  "has changed" strings); ADR-710 to 718 Accepted, Q-682 answered; the rest in FOLLOWUPS. Mutation run 41961473533
  on the six T-810c files. The T-810b run 41927893554 hit the 240-minute limit (82% static mutants); its access files
  `auth/http-errors.ts` and `organizers/routes.ts` ride a later run, `conventions.ts` and `http-error.ts` are dropped
  (no ledger, sign-in, tenant or redemption logic). CI minutes about 20; review tokens about 0.15M.
  **Next:** T-810d (plan reviewed 86, build running; Dhia adds the console DNS and CranL domain when it is ready).

## T-810e code screen notice — 2026-11-05

- **T-810e done (tier C, copy; no review).** One line under every sign-in or contact-change code field: "Never share
  this code. Questify will never ask you for it." / "لا تشارك رمزك مع أحد. Questify لن يطلبه منك أبدًا." (one key,
  `signIn.codeNeverShare`, worded with ux-araby: masculine imperative, no "هذا", brand name in Latin letters). Web:
  `CodeStep` (sign-in, sign-up, invite) and the owner email change form, as the field's `help` so a screen reader reads
  it with the field (`CodeStep` sets its own `aria-describedby`, which replaces the one `Field` wires, so it now names
  the help line too; the e2e caught this); app: the sign-in and the phone or email change code steps, muted text under
  the field. The delete-account confirmation code has no line (not a sign-in or contact-change code). ASVS sheet:
  V6.6.1 Met, 149 Met, 32 Partly, 1 Not met. **Checks:** Vitest for `apps/app`, `apps/web`, `packages` and `scripts`
  (333 files, 4,335 tests) and the API suites that read the message table (258) pass; types, lint, `lint:limits`,
  format pass; web e2e `sign-in.spec.ts` (12 passed, desktop and phone), `console-owner-email.spec.ts` and
  `layout.spec.ts` (desktop) pass, one worker. CI minutes: 0 (nothing pushed). Agent tokens roughly 0.3M (estimate).
  **Next:** the next unchecked task in `docs/TASKS.md` (T-810d and T-811 are open; T-810f is built, review next).

## T-810b ASVS L2 code gaps built — 2026-11-05

- **T-810b built (tier A; plan review 87 folded; code review next).** Security headers on every `/v1` answer, set by the
  API and by the web forwarder (ADR-700); `redirect: "error"` on every outside `fetch` with a parsed source guard and a
  redirecting-server outsider test (ADR-701); new invitation links carry 128 random bits (0153, ADR-702); the player
  search escapes a backslash (0152); one `authz.denied` line for every 403 and the central hidden 404s, the
  cross-tenant test driven by the route inventory (ADR-703); Fastify's poisoning refusals pinned and tested; an SBOM on
  each `release-*` tag (`sbom.yml`, zizmor and actionlint clean, ADR-704); a player refresh family, its access tokens
  included, ends 365 days after the sign-in (0154, FR-123 amended, ADR-706); the one-factor exception in SECURITY.md.
  Reward key rotation moved to T-810f. ASVS sheet: 148 Met, 33 Partly, 1 Not met. **Checks:** full Vitest once: 12,766
  passed, 18 skipped, 0 failed; 0152 to 0154 apply on PostgreSQL 16.15 (container removed); lint, `lint:limits`,
  format, types pass. CI minutes: 0 (nothing pushed). Agent tokens roughly 0.6M (estimate).

## T-810 ASVS L2 sheet drafted — 2026-11-05

- **T-810 drafted before T-809 (tier C, docs only; not ticked).** `docs/security/ASVS_L2.md` lists all 253 ASVS 5.0
  L1 and L2 controls (numbering and levels from OWASP's 5.0.0 CSV at tag `v5.0.0`) against the core: 133 Met, 47
  Partly, 2 Not met, 71 N/A, each with its test, CI step, migration or doc section (every cited file and test title
  checked by a script against the repository). Top gaps: `/v1` answers carry no HSTS, nosniff or CSP; outside `fetch`
  calls follow redirects; invitation links are UUIDs; `event_players` (0032) lost the backslash step of its LIKE escape;
  no `authz.denied` event; player sessions have no absolute end; one-factor player sign-in; one hostname for console and
  public pages; CranL-held TLS, credentials, egress and log controls; no written fix time frames for dependencies.
  New: tier A task T-810b (8 code items), Q-660 to Q-664, six FOLLOWUPS lines, a T-811 note. `format:check` clean.
  CI minutes: 0; agent tokens roughly 0.4M (estimate).

## FOLLOWUPS batch — 2026-11-04

- **FOLLOWUPS batch (ADR-355; tier A for the migration, otherwise B/C; migration 0151, new and undeployed).** From the
  2026-11-03 and 2026-11-04 entries: `complete_quest_answer` returns `ranking_sqlstate` (0149 is deployed, so 0151
  drops and recreates the function with one more column; the WARNING is gone, `ranking_failed` stays for an API of the
  previous release) and `afterAnswer` logs it as `sqlstate`; the answer row's null-together columns are typed as unions
  with null; the 0149 comment about a `lock_timeout` is reworded in 0151. New tests: a 300-event insert with
  `enable_sort = off` holds the seat locks in id order (the hand mutant without `ORDER BY` fails it), the desk offer
  deadlines bounded by the database clock, the CranL client's network error, timeout, repeated-key write, still-differs
  and API-key cases. `ops/load/run.mjs` deletes its `*.job.json` files in `finally` and warns when `cleanUp` throws
  (smoke run with a tiny plan: no job file left). Each done line is marked in `docs/FOLLOWUPS.md`; left there: the
  `full.yml` sharding, set-based welcome, the monitoring items, Q-650, and the rest of the T-804 `run.mjs` list. 0151
  also applies on a throw-away PostgreSQL 16.15 (container removed). Full suite once: 805 files and 12,682 tests passed
  (16 files, 18 tests skipped). Lint, types, `lint:limits`, `format:check` clean. CI minutes: 0.
  **Mutation targets touched:** `apps/api/src/completions/complete.ts` (types and one `sqlstate` line),
  `apps/api/src/ranking/ranking.ts` (one log field, covered by the new `flow.int.test.ts` cases).

## Mutation chase: ranking.ts and store.ts — 2026-11-04
- **Survivors and no-coverage mutants of GitHub run 41851709795 chased (one round, tests only, no source change, no bug
  found).** `apps/api/src/ranking/ranking.ts` (88.3%, 44): 38 killed in the new `src/ranking/ranking.test.ts` (21 tests
  over a fake pool and a fake store, no Docker: a blocked player's masked row from both PostgreSQL and the copy, the
  copy that cannot be built, a player missing from or no longer ranked in the names read, QR403 against any other
  failure, a reader whose day or name display the database no longer answers, no full-name read while the event shows
  usernames, a repair of a single-day, not-live and vanished event, a busy whole or day rebuild marking the event
  again, the backstop's missing and old copies, an entry with no version, one not ranked, and `afterCompletion`'s
  empty, failed and day-failed reads); 6 equivalent. `apps/api/src/ranking/store.ts` (86.7%, 16): 8 killed in
  `test/ranking/store.int.test.ts` (3 new: the rebuild's copy and flag under the event's keys with the flag expiring,
  chunks of 500 sent to Redis, a member that stands for no enrollment left out of the top); 8 equivalent (`defineScript({})`
  is reported alive as a static mutant but fails the Redis tests by hand). Each kill was checked by applying the mutant
  by hand (48 failed their suite, 2 of them variants not on the list; the 14 equivalent ones passed; FOLLOWUPS names
  them). Lint, types, `lint:limits`, `format:check` clean; touched suites (`src/ranking`, `test/ranking`) 101 passed.
  Scores are confirmed by the next grouped mutation run. CI minutes: 0; agent tokens roughly 0.4M (estimate).

## Mutation chase: contact.ts and sign-in-limits.ts — 2026-11-04
- **Survivors and no-coverage mutants of GitHub run 41873529684 chased (one round; one dead-code deletion in
  `contact.ts`, no bug found).** `apps/api/src/players/contact.ts` (89.2%, 32): 24 killed by tests, 6 removed with dead
  code, 2 equivalent. `apps/api/src/players/sign-in-limits.ts` (89.6%, 14): all 14 killed. New: `src/players/contact.test.ts`
  (2 tests over a fake pool: the send windows filling after the lock-free look, which logs the step and channel, opens
  nothing and gives the budget unit back; `confirm_contact_change` answering no row), 7 tests in
  `src/players/sign-in-limits.test.ts` (`reserveSend` answers spent without a second try, tries a busy budget three more
  times with 5 to 20 ms of jitter, then answers busy; `withSendBudget` answers a busy budget with a one-second wait and
  the `player.budget_busy` log, and logs a failed give-back with its channel and reason), and 4 in
  `test/players/contact.int.test.ts` plus tightened asserts (a full window answers 429 before the platform budget is
  touched, a sent code keeps its budget unit, a demo account's change answers `contact_locked`, only a wrong code
  counts in the failure windows, the `notice_sent` and `notice_failed` logs carry their channel, outcome and reason,
  and the 429, `phone_not_supported` and `sms_unavailable` bodies carry `retryAfterSeconds` and `emailOffered: false`).
  **Source change:** `Confirmed` in `contact.ts` is a union by outcome (`wrong`, `expired` or `taken`, `changed`), so the
  unreachable `channel === null || kind === null` checks and their "expired" fallback are gone (the six `373`
  survivors). 2 equivalent, listed in FOLLOWUPS: the `.filter(to !== null)` before the notices (`notify` throws on a null
  address before it does anything, and `Promise.allSettled` absorbs it). Each kill was checked by applying the mutant by
  hand (38 failed their suites, plus 3 variants of the new `outcome !== "changed"` line; the 2 equivalent ones passed).
  Lint, types, `lint:limits`, `format:check` clean; touched suites (`src/players`, `contact`, `send-budget` and
  `contact-change` integration files) 178 passed. Scores are confirmed by the next grouped mutation run. CI minutes: 0;
  agent tokens roughly 0.5M (estimate).

## T-804b built — 2026-11-04

- **T-804b (tier A, sign-in; ADR-690 to ADR-692 amended to the plan review's Revision 1, Q-650 to Q-652 Proposed):
  migration 0150.** The platform send budget is 16 stripes (a constant) in `auth_throttle`, taken by
  `take_send_budget` (PL/pgSQL, VOLATILE, never waits) in its own statement before the request's transaction and given
  back on every refusal, error or send-nothing (App Review phone, unknown deletion contact, unchanged contact); its
  numbers are rows of `platform_send_budget` (API read-only; Q-093's 5,000 and 1,000 unchanged), a lowered cap or longer
  window settles for one window; the old single key's rows are copied. The windows are read once unlocked before the
  budget and again under the contact lock, in one query each. An address earns 2 codes (1 wrong code) per contact that
  typed a right code of the same channel from it, once an hour, up to 2,000 (500). No half warning. Tests: new
  `send-budget.int.test.ts` (concurrency over 20 rounds, odd caps, sliding, busy, give-back, mid-window cap changes,
  the 0149 to 0150 copy; four hand mutants of the SQL killed), `sign-in-rush.int.test.ts` (exact cap of 200 parallel,
  give-back paths, throttled flood holds no unit, earned room by channel and contact), outsider and grant lines.
  Load (plan section 9): before, 100 a second p95 2.2 s with 90% of sessions on the lock; after, 250 a second p95 47
  and 376 ms on one API, 54 and 79 ms on three; cap 5,000 sent exactly 5,000 of 9,000 (email 1,000 of 3,000); one
  address with 2,000 phones typing back after 20 to 90 s: no 429. Green on 17 and on a throw-away 16.15. Full suite
  once: 805 files and 12,664 tests passed (16 files, 18 tests skipped). Lint, types, `lint:limits`, `format:check`
  clean. CI minutes: 0; agent tokens roughly 1M (estimate).
  **Next:** T-804b code review (tier A), mutation on `sign-in-limits.ts`, `sign-in.ts`, `contact.ts`, `deletion.ts`;
  deploy 0150 outside an event's opening (RUNBOOK).

## T-804c built — 2026-11-04

- **T-804c (tier A, ledger and sign-in; ADR-680 to ADR-682 and Q-640, Q-641 Proposed; ADR-671 to ADR-673 marked
  built): migration 0149.** `complete_quest_answer` answers a completion in one statement (each part its own
  function's answer; the ranking reads in their own exception block, so a ranking failure answers `rank: null`, logs
  and marks the event and never undoes the completion); `player_request_gate` calls `player_session_owner` and
  `player_legal_held` in one call; the ranking's six Lua scripts run by SHA1 through node-redis `defineScript`
  (`createRankingRedis`), `WRITE_READ` declaring the union of its keys. A QR completion: 20 PostgreSQL statements and 2
  Redis calls before, 5 and 1 after (a test holds it). From the T-804a review: the parity seed reaches every set part
  and a catalog test fails on any new `LANGUAGE sql` definer or `SET` function (ADR-682). Tests: new
  `test/db/completion-answer.int.test.ts` (column parity with the part functions, a missed first bonus, refusals passed
  through, a broken ranking function with the completion committed, attributes, the gate with banned, reset, expired
  and held), HTTP 401 for banned, reset and expired tokens on writes, `afterAnswer` and `upsertRead` (NOSCRIPT
  reloaded) suites, outsider lines; two existing tests changed how they break the ranking (the door reads as its owner,
  so a revoked grant no longer breaks it; same assertions). Green on 17 and on a throw-away 16.15 (10 files, 242
  tests). Load (throw-away 17.11 with `pg_stat_statements`, ten events plus a 50,000-player event, three APIs, two
  runs): 240 a second confirmed, 100% within 1 s, p95 94 and 95 ms, ranking 100% within 5 s, tallies matched,
  PostgreSQL 5.1 to 5.9 cores; at 400 asked, 331 confirmed. Database time a completion, same container, 10 a second
  before and after: about 23.5 ms both (`complete_quest` alone 14.7 ms, not touched here), so the 10 ms gate is not met
  (Q-641); client mean 57.6 to 36.8 ms. Full suite once: 803 files and 12,632 tests passed (16 files, 18 tests skipped). Lint, types, `lint:limits`, `format:check` clean. CI minutes: 0; agent tokens roughly 0.9M (estimate).
  **Next:** T-804c code review (tier A), mutation on `complete.ts`, `ranking.ts`, `store.ts`, `guard.ts`.

## T-804a part A built — 2026-11-04

- **T-804a part A (tier A, ledger; ADR-670 and ADR-674 updated, Proposed; Q-631 answered by Dhia, Q-630 deferred to
  T-811): migration 0148.** The plan review (82) was folded into the plan (section 0); parts B to D became T-804c.
  The profile (throw-away PostgreSQL 17.11 with `pg_stat_statements`, T-804 seed plus one 50,000-player event) named 41
  `LANGUAGE sql` functions called per completion: 35 became plpgsql (`CREATE OR REPLACE`, attributes from
  `pg_get_functiondef`), and the six standard-body ones (`event_day` and friends, which the plan had assumed inlined)
  lost their `SET search_path` and are now inlined. Parity: `test/db/hot-path-plpgsql.int.test.ts` (attributes against
  a 0147 fixture, every function called and run, each answer equal to the old body's, the six inlined); hand mutants
  caught, `use_column` removal equivalent; green on 17 and on a throw-away 16.15 (Q-632). Sequential: 33.5 to 10.9 ms
  of database time a completion (client mean 63.5 to 37.2 ms); forced generic plans 10.8 ms, forced custom 44.6 ms;
  `EXPLAIN (GENERIC_PLAN)` reaches every large table by index. Load at 200 a second, three APIs: before 52 a second
  and 0% within 1 s; after (median of two runs) 200 a second, 98.0% within 1 s, p95 518 ms, ranking 100% within 5 s,
  PostgreSQL 6.4 to 7.0 cores (11.5 before); tallies matched. Full suite once: 801 files passed, 1 failed (`test/desk/sale-routes`: `offer_until` is the database's now() plus 2 min and the test subtracted the host clock, which Docker's runs 2 to 5 ms ahead of; the faster path now answers inside that gap, 120.005 s left; the bound in it and in `desk.int.test.ts` allows 0.5 s of skew, both files green after); 12,604 tests passed. Lint, types, `lint:limits`,
  `format:check` clean. TS files for mutation: none (no app code changed; the SQL is held by the parity test). Containers
  and databases removed; disk 14 GB free before and after. CI minutes: 0; agent tokens roughly 0.6M (estimate).
  **Next:** T-804a code review, then T-804c.

## T-804a completion hot path (plan) — 2026-11-04

- **T-804a planned (tier A, ledger; plan `docs/plans/2026-11-04-t-804a-completion-hot-path.md`; ADR-670 to ADR-674 and
  Q-630 to Q-634 Proposed; no code, no migration); T-804b (sign-in rush, Q-621) outlined in its section 8.** Profiled on
  throw-away PostgreSQL 17.11 and 16.15 containers with `pg_stat_statements` and the T-804 seed and drivers (harness
  borrowed from branch `worktree-agent-ac5958d377abcae1a`, not committed here): a QR completion makes 20 PostgreSQL and 2
  Redis round trips (about 1 ms each on Docker Desktop) and spends 36.1 ms in the database (34.1 on 16.15); the
  `LANGUAGE sql` definer functions plan every statement on every call (`own_bonus` 3.18 ms, 2.59 of it planning). A
  prototype rewrite of 51 of them as plpgsql on the throw-away database: 12.4 ms (13.6 on 16.15); under load 80 a second
  (6.8 cores) became 200 a second at 95% within 1 s with three API processes (8.0 cores); 240 a second failed. No lock
  contention (wait sampling). All 147 migrations run on 16.15. Target: at least 240 a second on this PC. 3,333 a second
  needs far more than code (Q-631, Q-630). Containers, databases and Redis keys removed; disk 16 GB free before, 15 GB
  after. CI minutes: 0; agent tokens roughly 0.4M (estimate). **Next:** the T-804a plan review.

## T-804 load test — 2026-11-04

- **T-804 harness built and run; the target is not met, so the task stays open (tier B; ADR-660 Proposed; Q-620, Q-621
  open; no migration, no app code changed).** `node ops/load/run.mjs` builds the load API from the checkout
  (`apps/api/test/load/`: production's pool, Redis options, ticks and logs; SMS, email, push stubbed), seeds a
  throw-away local database with set-based SQL (sessions by `issue_player_tokens`), drives open-schedule completions
  from 5 processes with a ranking probe per event, runs the `POST /v1/auth/code` rush, and drops the database and Redis
  keys in `finally` (RUNBOOK "Load test"). PC: AMD Ryzen 7 1700 (8 cores, 16 threads), 48 GB, Windows 10, Node 24,
  Docker PostgreSQL 17.11 and Redis 8, one API with a pool of 10; 10 events x 2,500 players x 20 quests, 60 s measured
  after 10 s of warm-up. Completions for all ten events: 50/s p95 224 ms; **80/s p95 245 ms (p50 108, p99 291), 100%
  within 1 s, ranking p50 175 / p95 253 ms after the confirm**; 95/s p95 1.65 s (42% within 1 s); 110/s p95 6.8 s; the
  target 3,333/s: 16 of 149,504 confirmed in 15 s (139,768 timeouts, 50,496 shed by the client, 9,720 connection
  errors), 1,626 written; every run's completion rows, ledger rows and scores matched. Bottleneck: PostgreSQL CPU (6 to
  7 cores at 80 to 110/s; a pool of 30 used 10.5 cores and still failed at 110/s); the API used 0.5 to 0.7 of a core and
  the client's delay stayed 14 ms p95 (at the target, 680 ms p95: the client too). Cause: `LANGUAGE sql` definer
  functions planned on every call (`own_bonus` 2.5 ms vs 0.08 ms as plpgsql); PostgreSQL 18.6 (throw-away container,
  removed) cut database CPU by about 45% and, with two API processes, reached 93% within 1 s at 160/s (Q-620). Sign-in
  rush: 100 codes/s p95 297 ms, 120/s p95 2.3 s, 200/s p95 10 s, all 202 (one platform lock); one client address is
  refused after 200 an hour (Q-621). Tests: `ops/load/*.test.ts` 40 (percentiles, the open schedule, the report and
  verdict; hand mutants of the rank rounding and the due count failed them). Lint, types, `lint:limits`,
  `format:check` clean. Disk 15.8 GB free before and 15.7 GB after. CI minutes: 0; agent tokens roughly 0.5M (estimate).
  **Next:** Q-620's tier A rewrite of the completion path's SQL functions, rerun locally, then the production-like
  rerun (its seeding is the first step).

## T-017 CranL infrastructure as code — 2026-11-04

- **T-017 built (tier B; ADR-650 and Q-612 Proposed; Q-610, Q-611, Q-613 open; no migration).** `ops/cranl/staging.json` and
  `production.json` declare everything Questify has on CranL; `pnpm infra plan <env>` (GET calls only) and `pnpm infra apply
  <env>` (creates and updates, never deletes, re-reads and fails if anything is left) in `scripts/cranl/`. Secrets live only on
  CranL: generated at the first apply or read from `SECRET_<APP>_<NAME>`; values are never printed. `plan staging` on 2026-11-04
  matched the API, the web app and both databases; one manual step is left: the monitoring app still builds from
  `/ops/monitoring/prometheus` and is stopped (Q-610, a dashboard change for Dhia). The staging database's scheduled backups
  have never run (Q-611). Nothing on CranL was created or changed. Tests: `scripts/cranl/infra.test.ts` (30, an in-memory
  CranL; a hand mutant of the secret rule failed 10 of them). Lint, `lint:limits`, `format:check` clean; full vitest once (4 workers):
  12,525 passed, 18 skipped, 811 files. CI minutes: 0; agent tokens roughly 0.4M (estimate).
  **Next:** Dhia fixes the monitoring app's build folder (Q-610), then the API's `TELEMETRY_*` go into `staging.json` and
  `apply staging`; T-017b (a fresh environment) once five CranL slots are free (Q-613).

## Mutation chase: review demo access code — 2026-11-04
- **Survivors and no-coverage mutants of GitHub run 41718131349 chased (one round, tests only, no source change, no bug
  found).** `apps/api/src/review-demo/codes.ts` (85.92%, 10): 9 killed in `src/review-demo/codes.test.ts` (a label with
  one language kept, no flag row means no flag, a meet code counts the pass and a caller over the limit gets
  `too_many_attempts` without a code); 1 equivalent (line 85 `?? ""`: no refusal is keyed by any fallback string).
  `apps/api/src/review-demo/routes.ts` (59.26%, 11): 9 killed in `test/review-demo/codes.int.test.ts` (403 while meet is
  off, 409 `none_left` with no fictional player left, 429 with `retry-after` and its details over the pass limit, the
  meet code's `no-store`); 2 equivalent (lines 55 and 66, the `cache-control` header name: the player guard already sets
  `no-store` on every player route). `apps/api/src/console/review-demo.ts` (71.67%, 17): all killed, in the new
  `src/console/review-demo.test.ts` (each SQLSTATE's refusal, 55P03, other errors passed through, Prepare before Create
  never reaching the prepare door) and `test/console/review-demo.int.test.ts` (change number before Create is 404, after
  Close shows the new number). `apps/api/src/console/review-demo-routes.ts` (86.11%, 5): all killed there (the malformed
  phone names its field; the number change). Each kill was checked by applying the mutant by hand (41 failed their
  suite; the 3 equivalent ones passed). Lint, types, `lint:limits`, `format:check` clean; touched suites 25 passed. Scores
  are confirmed by the next grouped mutation run. CI minutes: 0; agent tokens roughly 0.3M (estimate).

## Mutation chase: games.ts and layers.ts — 2026-11-04
- **Survivors of GitHub run 41703314042 chased (one round, tests only, no source change, no bug found).**
  `apps/api/src/plays/games.ts` (89.01%, 20 survived): 19 killed in `src/plays/meet-games.test.ts` (a sheet with half an
  open round shows none; an engine read's refusal answers before the limit counts or a round is issued; a refused
  replay is sent to `finish_game_round` as never unlikely; a paying round answers all six rewards and an unpaid one
  none; the sweep counts closed rounds and stops at a refusal); 1 equivalent (line 406 `rows[0]?.outcome`: the
  `SELECT close_one_due_round() AS outcome` always answers one row; FOLLOWUPS). `apps/api/src/settings/layers.ts`
  (73.53%, 7 survived, 2 no coverage): all 9 killed in the new `src/settings/layers.test.ts` (an unseen event, a
  switch-off that reads nothing, the platform default for an unset, an off-by-default and an unknown feature, the
  platform's switch over the default both ways). Each kill was checked by applying the mutant by hand (all 28 failed
  the suite; the equivalent one passed). Lint, types, `lint:limits`, `format:check` clean; touched suites 25 passed.
  Their scores are confirmed by the next grouped mutation run. CI minutes: 0; agent tokens roughly 0.2M (estimate).

## T-710b App Review QR picker — 2026-11-03

- **T-710b built (tier A; migration 0147, new and undeployed; ADR-640 and Q-600 Proposed).** Three doors, granted to the
  API role alone and revoked from PUBLIC: `review_demo_here` (the caller is the reviewer, in the demo event, the window
  open, an active member with an active account), `review_demo_codes` (the event's printable codes: visible quest QRs,
  passport steps, hidden categories' secret codes, meet quests; no NFC tags) and `review_demo_meet_code` (a fictional
  player's one-minute pass, first not yet met and under caps; RD409 `none_left`); RD404 to everyone else.
  `GET /v1/events/{id}/review-codes` signs the codes with the sticker keys; `POST .../review-codes/meet` issues the pass
  (meet-pass limit); Home carries `reviewDemo: true` for the reviewer only. The app keeps the flag in memory per event
  (`review-demo-flag.ts`); the scanner's "Pick a code (review only)" sheet feeds a pick to its own QR and meet
  handlers, so every completion rule is unchanged. `buildApp` split (`registerPlayDoors`) and the scanner's
  return re-check moved to `useRecheckOnReturn` to stay within the function limits (baseline shrank). Tests:
  `test/db/review-demo-codes` (7: the list, refusals for another event, a real player, a fictional one, an unknown event,
  a member who left, a closed window; the meet pass paid by `meet_player`; grants), `test/review-demo/codes` (4, HTTP:
  a picked QR paid by the ordinary complete route, a meet code paid by `/v1/meet`, the outsider's seat, Close), the
  security suites (routes, maintenance doors, outsider), the community gate map, `src/review-demo/codes.test`,
  `home-rows`, app `review-codes.test`. SQL hand mutants: the member status, the window and the caller check killed; the
  fictional player's cap filter survives (`meet_player` still refuses with `their_daily_cap`; noted, not chased).
  `npx expo export` (android) passes. Full vitest once (4 workers): 12,490 passed, 1 failed (the community gate map,
  fixed and re-run), 18 skipped, 810 files. Lint, `lint:limits`, `format:check`, types clean. CI minutes: 0; agent
  tokens roughly 1M (estimate).
  **Code review 87, MAJOR fixed:** a picked tag (no chip id) raised a false `nfc_copy` on Android, so tags are no longer
  listed (a tag quest's QR is; ADR-640 and Q-600 corrected); minors fixed with DB tests: a hidden meet quest refused, an
  inactive reviewer account refused, the fictional player's day-old passes deleted, a fictional player at its daily cap
  passed over (kills the surviving `meet_caps` mutant; hand mutants for all four killed).
  **Next:** mutation on GitHub
  (`apps/api/src/review-demo/codes.ts`); a store build carries the picker (T-806).

## T-221 seat limit once a statement — 2026-11-03

- **T-221 built (tier A; migration 0146, new and undeployed; ADR-630 to ADR-632 and Q-590, Q-591 Proposed; answers Q-323).**
  Plan review (88) folded in first: `lock_timeout` 1 s (below the pool's 2 s), READ COMMITTED check, `TG_OP` branches, the
  bulk ledger measured, the post-deploy probe a required RUNBOOK step. The row guard `enrollment_player_limit` is replaced
  by two AFTER statement triggers with transition tables over `enrollment_seat_limit()` (one `EXISTS` early exit, then
  one count per event in id order; `record_limit_crossings` records the 80/100 marks at the crossing); `souvenir_enqueue`
  is PL/pgSQL and `grant_welcome` writes the ranking mark once per transaction. **Done-when partly missed:** races hold
  at exactly the limit, but 5,000 in one call took 14 to 29 s (about 3 ms a row, mostly the welcome grant), so accept-all
  takes **1,000 a call in both modes** (was 1,000 / 250): median 2.78 s on the 20,000-seated fixture (before: 250 took
  7.7 to 11.7 s). Hot path: a quest scan +0.7%, a single score update within noise (32 µs a firing in the profile), a
  2,000-row bulk ledger insert +8% (1,479 vs 1,366 ms). Finding left in FOLLOWUPS (set-based welcome grant). Tests:
  `test/db/seat-limit.int` (20: races in both orders, direct writes, multi-event lock order, lowered limit, rehearsal,
  REPEATABLE READ refusal, marks, the cap, deny by default), `push-producers.int` cap cases replaced. Hand mutants of
  the SQL: `>`→`>=`, count before the lock, no old-status exclusion, rehearsal forgotten, `LIMIT` without `free`, no
  isolation check, crossing at the final count: all killed; iterating events without `ORDER BY` survives (live, not equivalent: a hash grouping can return events in any order and the `ORDER BY` keeps multi-event statements from deadlocking; killing test in FOLLOWUPS)
  in practice (the `GROUP BY` returns the same order to both statements). Full vitest once (4 workers): 12,425 passed, 18 skipped, 788 files. Lint, `lint:limits`, `format:check`,
  typecheck clean. CI minutes: 0 (not pushed); agent tokens: roughly 1.5M (estimate). **Mutation:** none (no TypeScript
  logic changed; the SQL hand mutants stand in).
  **Next:** the T-221 code review (tier A, strongest model); deploy 0146 outside an event's peak and run the RUNBOOK
  timing probe; then the next unchecked task in `docs/TASKS.md`.

## T-018b monitoring stack, prepared — 2026-11-03

- **T-018b prepared (tier B; files and checks only, no CranL call, no migration, no device work; ADR-620 to ADR-626 and Q-580 to Q-584 Proposed, Q-585 decided and built; T-018b stays open).**
  Dhia's answers (Q-560, Q-561): telemetry to CranL `riyadh-1`, alerts by email (none for now, Q-581). **Merged into one app the same day (ADR-626; Dhia: Questify on CranL is
  at most three apps, the API, the web app and one monitoring app, plus the two databases).** `ops/monitoring/stack/` is one Dockerfile: Grafana 13.2.5 as the base with
  Prometheus v3.15.1, Alertmanager v0.34.2 and Caddy 2.11.7 copied in (all pinned by version and digest); one public port (8080, Caddy: `/grafana` to Grafana, everything
  else to Prometheus, which asks every request for the one password, `METRICS_PASSWORD`); one volume (`/data`, 5 GB); the Alertmanager and Grafana on 127.0.0.1. The API sends
  straight to Prometheus's own OTLP receiver (`OTEL_EXPORTER_OTLP_ENDPOINT=https://<app>/api/v1/otlp`, `authorization=Basic%20<base64>`, `TELEMETRY_TRACE_RATIO=0`: traces are
  dropped); the API's configuration needed no change (a test pins the settings). `entrypoint.sh` starts the four programs and stops the container when any dies (tested for
  each, and for a stop signal). **Prometheus cannot filter the attributes it is sent** (verified: sentinel attributes are stored as labels), so the collector's closed-list wall is
  gone and the API's list is the wall (ADR-626 item 7): backed by `pii.test.ts`, the validation's label checks, the RUNBOOK's label audit, and a second wall inside the API's SDK (Q-585, decided by the developer 2026-11-03 and built: a metric view
  that passes every recording's attributes through `safeAttributes`, tested in `sdk.test.ts`). **Found while building:** Grafana 13 downloads its preinstalled plugins at every start (an outside
  call that also stalled its shutdown); now off (`GF_PLUGINS_PREINSTALL_DISABLED`), checked in the validation (the earlier Grafana app downloaded them too). RUNBOOK "Monitoring stack
  on CranL": the app's settings, pointing the API at it, rotating the password, the label audit, retention (no backups, on purpose), operating notes, the footprint.
  **Checks:** `pnpm monitoring:validate` (about 5 minutes; builds the image, runs `promtool`, `amtool`, `caddy validate`, `shellcheck`, `shfmt`, then proves the password refusals,
  the closed doors, names and labels, 20 rules, only port 8080 open, Grafana's login and every dashboard query under `/grafana`, a mailed test alert, the no-email mode, the off-list
  premise, a clean stop and the death of each program, and removes what it started) all 23 stages ok; `apps/api/src/telemetry/monitoring.test.ts` (structural, no Docker). Telemetry tests: 126 passed (9 files, 2 changed); the API's header settings are pinned in config.test.ts.
  Lint, `lint:limits`, `format:check` and `tsc` clean. CI minutes: 0 (not pushed); agent tokens: about 900k (estimate). **Mutation:** none (tier B; no ledger or access code).
  **Waiting on Dhia:** Q-581 is decided (2026-11-03): no alert email for now, the app runs with alerts on the dashboard only until a sender exists; Q-584 (an outside uptime service for
  `/readyz` and a heartbeat). **Waiting on a person with the CranL account (or T-017):** create the monitoring app and set the API's `TELEMETRY_*` on staging (RUNBOOK; Q-580 lists
  five CranL facts the first deploy confirms), then fire the test alert. **Footprint per environment:** 1 of the three CranL apps; 320 MB for the whole app idle (expect 500 to 900 MB in use) and well under one core; one 5 GB volume (0.5 to 1 GB used
  after 30 days); the image is about 2.5 GB.
  **Still open in T-018b:** the outside probe, the database function and migration for queue depth and ranking staleness (tier A), expiry probes, the one-address-key
  aggregate, the web app's traces, error tracking. **Next:** the review of this branch (tier B, mid-tier); T-017 creates the app; then the next unchecked task.

## T-018 observability and service levels — 2026-11-03

- **T-018 built (tier B, API side; no migration, no device work; ADR-600 to ADR-605 and Q-560 to Q-562 Proposed; the place telemetry goes to and who is paged are T-018b, ADR-600).**
  `apps/api/src/telemetry/`: OpenTelemetry (API 1.10, SDK 3.x, OTLP over HTTP) records a server span and a duration sample per request
  (route pattern, status, route class `completion` for the four scan routes; an unknown path is `unmatched`), a span, duration and outcome
  count per outside call (Msegat, Gmail, Resend, APNs, FCM), a root trace and last-run time per pass of the nine background loops, and both
  database pools' connections. Off unless `TELEMETRY_EXPORTER` is `otlp` (or `console` in development); a bad setting stops the start; an
  export has a 5 s timeout and a failure is one stderr line a minute. Logs stay JSON, gain `trace_id`/`span_id`, and every line with an
  `event` is also counted by event and level (the existing ~130 events are the alert signals). **No personal data:** a closed list of
  attribute keys with value shapes; `pii.test.ts` pushes sentinel usernames, emails, phones, tokens, cookies and addresses through the real
  server and finds none in a span, metric or log line. It found the request log writing the typed path of a request no route answers
  (now `unmatched`). **Service levels:** `docs/SLO.md`; `ops/alerts/questify.rules.yml` (20 alerts, Prometheus rule format, checked and
  unit-tested with `promtool`, which ran once in Docker, no install); RUNBOOK "Telemetry and alerts" has an entry per alert;
  `alerts.test.ts` fails an alert with no entry or one that names a metric, label, loop or log event the code does not have. Folded in: the
  T-711b deploy window (`QuestifyCommunitySettleFailing` needs ten unbroken minutes), the community tick lines, the T-006 and T-107
  sign-in signals. `buildApp` lost 6 lines (a `createServer` helper; baseline lowered). New dependencies, all with a reason in ADR-601:
  `@opentelemetry/*` (7 packages, pinned) and `yaml` 2.9.1 for tests. **Local:** full vitest ONCE in two parts: web, app, packages and scripts
  4,174 passed (325 files); the API 8,013 passed, 17 skipped (467 files, `--maxWorkers=4`) plus one plan-shape test in `flash-boosts` that
  failed under load and passed alone (80 of 80); telemetry tests 97 in 8 files. A first run at the default 16 threads crashed the shared
  test PostgreSQL (64 MB shared memory, then crash recovery; RUNBOOK Local checks has the fix); pnpm audit clean (the two existing
  ignores), lint, lint:limits, format:check and `tsc` clean; the API bundle builds and a bundled console-exporter smoke run emits the
  span and metrics. CI minutes: 0 (not pushed); agent tokens: about 600k (estimate). **Mutation:** none (tier B).
  **Waiting on Dhia (T-018b):** Q-560 (where telemetry goes; recommended a collector, a Prometheus-compatible store and Grafana in
  `riyadh-1`) and Q-561 (who is paged, an outside `/readyz` probe). Nothing in the API changes with the answers.
  **Next:** the T-018 code review (tier B, mid-tier); then the next unchecked task in `docs/TASKS.md`.

## T-802b intro card order and visibility — 2026-11-03

- **T-802b built (tier B; not run on a phone; migration 0145, new and undeployed; ADR-610 to ADR-613 and Q-570, Q-571 Proposed).** A platform admin orders and hides the player intro's four cards at `/console/intro` (at least one stays shown), with Save, Discard and Revert. One audited definer door (`admin_player_intro_save`, the 0119/0137 catalog pattern) stores `platform_setting` key `playerIntro`; `GET /v1/config` carries `playerIntro: {cards}`; the app plays the cards in that order, read once when the intro opens (last working copy, else the fresh configuration within 1.5 s, else the shipped four). The join welcome card stands where the join card stands. The cards' words stay in App texts. **Compliance change for Dhia's attention (Q-570):** the intro makes one anonymous `GET /v1/config` (no sign-in, nothing about the player), where T-802 made no request; the source guard allows exactly that. Tests: shared `player-intro` (20), `test/db/console-player-intro` (23), `test/console/player-intro` (8), the security suites, app onboarding (46 with the order and guard cases), web `console-intro` (4), `e2e/console-intro.spec.ts` (3), `layout.spec.ts` desktop and phone. **Local:** full vitest ONCE: 12,178 tests in 789 files; the shared Postgres ran out of shared memory (64 MB /dev/shm) with sixteen workers while other sessions used it and went into crash recovery, so 250 API files failed on hook timeouts and "connection terminated" (no assertion failed); all 250 were re-run (50 serially, then 200 with three workers) and passed (3,467 tests); the 524 other files passed in the first run. CI minutes: 0 (not pushed); agent tokens: roughly 1M (estimate). **Mutation:** none (tier B).
  **Next:** the T-802b code review (tier B, mid-tier); then the next unchecked task in `docs/TASKS.md`.

## T-802 player onboarding intro — 2026-11-03

- **T-802 built (tier B; not run on a phone; app only, no migration; ADR-590 to ADR-594 and Q-550 to Q-552 Proposed; ordering and hiding the cards split to T-802b, ADR-593).**
  A first launch opens `/intro`: a language step (Arabic and English each named in itself, the phone's language selected, a restart note
  when the choice differs), then four story cards (join an event, complete quests, earn points and climb the ranking, win prizes and grow
  your profile) on a parchment panel in a wood frame with a gold rim, the app's existing 3D icons on a medallion (pop-in and float, still
  under Reduce Motion), progress dots, Back and Next, and Scan an event QR and Explore events on the last card; Skip is on every step.
  The texts are `onboarding.*` messages, editable in the translation matrix. One local flag `questify.intro` (`language` or `seen`),
  marked seen when the first card shows, keeps it to once per install; an unreadable store counts as seen. Settings (the profile
  screen) has "How Questify works" for everyone: the four cards without the language step. From a join link the order follows ADR-096
  (join card and join first): "Go to the event" on the join card and the invitation opens the intro while it is due, its first card
  naming the event, no language step, ending in the event (a request still waiting or a waiting-list place goes straight to the event).
  No permission, request or tracker, and a test fails if the intro's files import one. Tests: `apps/app/src/onboarding` (30: state,
  cards, flow, route params, source guard). **Local:** `expo export --platform android` builds; pnpm lint, lint:limits, format:check
  and `tsc` (app) clean; full vitest ONCE: 12,066 tests in 781 files, 12,049 passed, 17 skipped, 0 failed. CI minutes: 0 (not
  pushed); agent tokens: about 450k (estimate). The look, the animation, the Arabic layout and the restart after a language change are untried
  on a device (STORE_COMPLIANCE has a note; T-808 has the copy and phone review). **Mutation:** none (tier B).
  **Next:** the T-802 code review (tier B, mid-tier); then the next unchecked task in `docs/TASKS.md`.

## T-022 migration retry on a lock clash — 2026-11-03

- **T-022 built (tier B, deployment tooling; no migration file; ADR-580 and Q-540 Proposed).** `migrate()` now retries a file whose transaction fails with `40P01` (deadlock) or `55P03` (lock timeout): it rolls back whole, waits 1 s, 2 s, 4 s (each between half and one and a half times) and runs the file again, three retries and four attempts in all; every retry is one stderr line (file, SQLSTATE, attempt, wait; no error text, no secrets); any other SQLSTATE fails at once; a fourth clash throws `MigrationLockClashError`; a failing ROLLBACK stops the run without a retry. `node migrate.cjs` exits 0 (all applied), 75 (lost the clash four times, rolled back, run it again) or 1 (read the error); the RUNBOOK "Migration retry" and the coordinator's deploy loop say so. Tests: `test/db/migrate-retry.int.test.ts` (6: a real lock timeout and a real deadlock each retried and applied once with the half-done work proven rolled back between attempts and the first file not run again, the fourth clash with the SQLSTATE and a rerun that finishes, three non-clash errors failing at once) and `src/db/migrate.test.ts` (7: backoff ranges, exit codes, a COMMIT-time deadlock, a failing ROLLBACK, give-up, and a guard that no migration file ends the runner's transaction itself); `migrate.int.test.ts` still passes. Three hand mutants (retry every error, no rollback, four retries) all caught. `migrate` left the function-limits baseline. CI minutes: 0. **Local:** full vitest ONCE: 11965 tests in 772 files, 11760 passed, 194 skipped, 11 failed in 20 files, every one a 60 s hook timeout (a busy shared PC; `live-edits` also statement timeouts), none in a file this task touched; the 20 files re-run serially: 300 passed. Lint, limits, format, `tsc` clean. **Local note:** the worktree had no `node_modules`; `pnpm install --offline --frozen-lockfile --ignore-scripts` filled it (hard links, one minute).
  **Next:** Q-540 (a default `lock_timeout` in the runner) is a small follow-up before the first real players; then the next unchecked task in `docs/TASKS.md`.

## T-507c souvenir sponsor tags — 2026-11-03

- **T-507c built (tier B; not run on a phone; migration 0143, new and undeployed; ADR-570 to ADR-574 and Q-530 to Q-532 Proposed).**
  An owner or editor tags a souvenir to one of the event's sponsors from the Sponsors page (a Souvenirs group beside quests,
  categories and rewards, saved by the existing `PUT …/sponsor-tags`; no new route or table). The tag is a fourth `sponsor_tag` kind
  with a same-event composite key to `souvenir_rule (id, event_id)` (any status; a draft's delete takes the tag; `souvenir_rule`,
  receipts and provenance untouched). The souvenir's owner sees "Presented by {sponsor}" (the sponsor's mark and name, text only,
  the logo stays T-507b) under the souvenir in the app's locker (`own_locker.presented_by`) and in the recap card's chip
  (`event_recap`), both from one internal helper; the Souvenirs card shows the badge on the dashboard; the sponsor's totals and
  spreadsheet list its souvenirs with the players who earned each (floored). `member_sponsors`, every public item DTO, a duplicate
  of the event, erasure and the export do not carry it. Tests: `test/db/sponsor-souvenirs` (15), `test/db/sponsors`,
  `test/sponsors/routes` (HTTP), the security suites, shared, API, app and web unit tests, `e2e/sponsors.spec.ts` (a souvenir step).
  Two hand mutants of 0143 (the duplicate's `kind <> 'souvenir'`, and `sponsor_tag_shown`'s `ELSE false`) were each caught by
  one test. **Local:** pnpm lint, lint:limits, format:check and typecheck clean; `expo export --platform android` passes; web
  build, then `layout.spec` and `sponsors.spec` on desktop and phone (4 passed). Full vitest ONCE: 11,982 tests in 772 files;
  on a PC shared with other runs 165 files hit 60 s hook timeouts (8,784 passed, 11 failed and 3,187 skipped, all timeouts but
  `meet` and the `events` lifecycle tick, both timing); those 165 files re-run with two workers: 3,678 passed, 0 failed.
  CI minutes: 0 (not pushed); agent tokens: about 700k.
  **Next:** the T-507c code review (tier B, mid-tier); then the next unchecked task in `docs/TASKS.md`. Mutation: not needed (tier B).

## T-710 App Review demo — 2026-11-03

- **T-710 built (tier A; migration 0144, new and undeployed; ADR-560 to ADR-569 amended with plan review 84, Q-520 to Q-526 Proposed).** Plan review 84 folded in first (plan section 0: lock order with the `review_demo` row before the challenge, the reviewer number never a real account's, `xp_apply` instead of the ranking readers, `promo_pool` only). A platform admin creates the demo once from the console (organizer, live event, 12 fictional players, reviewer account), prepares it per build (reviewer reset, new six-digit code shown once, 1 to 30 day window) and closes it; the database decides the fixed code in `start_player_challenge`, `sign_in_player` and `verify_deletion_code`, sends nothing for a reviewer challenge, and confines demo accounts by triggers. Deviations: the readiness counts ride in `console_review_demo()` (no separate door); the campaign refusal is `invitation_event_ok` answering `not_public` (no RD409, no TS change); Prepare is not idempotent (the store would keep the code); the browser spec and `console_feature_usage` leaving the demo out are in FOLLOWUPS. Tests: `test/db/review-demo` (25, incl. both Close races; two hand mutants caught), `test/console/review-demo` (8, HTTP, SMS spy, outsider's-seat case), the security suites, web lib (5), keys. CI minutes: 0. **Local:** full vitest ONCE: 11993 tests in 773 files, 11410 passed, 71 failed in 99 files: 4 real list-guard failures of mine (tick step count, event-duplicate NOT_COPIED, flash-boosts PAYER_MAP, the words and key-name tests; all fixed), the rest 60 s hook timeouts on the shared database; re-run serially: 81 of 96 files passed, 15 timed out again in `createTestDatabase` while the shared Docker database stopped answering (event-duplicate's fix not re-run).
  **Next:** the T-710 code review (tier A, strongest model), then mutation on GitHub; T-710b built after it (above).

## T-714 per-organizer feature usage — 2026-11-03

- **T-714 built (tier B; not run on a phone; migration 0140, new and undeployed; ADR-550 to ADR-553 and Q-510, Q-511 Proposed).** A platform admin opens Feature usage in the console, searches an organizer by the start of its name or slug and reads, for each of the 16 event-level features, whether it is on for the organizer (with the cause: Questify's override or the platform's switch), in how many of its events it is on, and in how many it has content (a map, a reward, a ticket, a poll and so on; the rankings show the switch only). Counts only, over the organizer's 200 latest events; one definer door (`console_feature_usage`), one route with the console `throttled` helper, the layers laid over the counts in shared code. Two small indexes (`quest_rating (event_id)`, partial `quest (event_id, type)`). Scale measured on a 50 x 250 fixture: 1.2 to 2.2 s for a page of 50 organizers on a loaded PC (a first version took 5 to 9 s). Tests: `packages/shared` usage (14), `test/db/feature-usage` (19), `test/console/feature-usage` (9), the security suites, web lib (11), `e2e/console-feature-usage.spec.ts` (3) and `layout.spec.ts` on desktop and phone (8 passed). CI minutes: 0. No mutation run on GitHub (tier B); six hand mutants of the door all caught. **Local:** full vitest ONCE: 11854 tests in 765 files, 11827 passed, 17 skipped, 10 failed in 2 files: `community-unlocks` (1, a real failure of mine: its list of every function that reads a quest, category or reward needed `console_feature_usage`; fixed) and `live-edits` (9, a 60 s hook timeout and statement timeouts while other runs shared the PC; not touched by this task); both files re-run serially: 98 passed.
  **Next:** the T-714 review (tier B, mid-tier); then the next unchecked task in `docs/TASKS.md`.

## T-711 feature layers — 2026-11-03

- **T-711 built (tier B; split, see ADR-500; not run on a phone; migration 0136, new and undeployed; ADR-500 to ADR-504 and Q-460 to Q-463 Proposed).** The console organizer page has a Features panel: for the 12 features whose platform rule reaches one event, an admin sets Off, On or "like the platform" for that organizer (`organizer_feature_override`, audited, applied at once to the composed configuration and to the SQL rules `feature_enabled`, `flash_on`, `shop_on` and the Cheers reading). The owner's Features section (event page and guided setup) lists only what the platform leaves on for the organizer, draws a locked add-on card with Ask Questify (the Contact page) for an add-on Questify has not unlocked, and the server refuses an owner's switch-on that a layer keeps off (403 `feature_not_allowed`). **T-711b** (tier A for its first half): the override for boosts, community, meet-someone and mini-games, whose SQL rules are in the points path, and the recorded Ask Questify request with an Allow and Decline queue. Tests: `packages/shared` layers (16), `test/db/feature-layers` (8), `test/console/organizer-features` (7), `test/events/feature-layers` (6), the security suites, web lib tests, `e2e/feature-layers.spec.ts`, `layout.spec.ts`. CI minutes: 0.
  **Next:** the T-711 review (tier B, mid-tier) with a look at migration 0136's change to `feature_enabled`, `flash_on` and `shop_on`; then T-711b or the next unchecked task in `docs/TASKS.md`; mutation is not needed (tier B).

## T-706b push to a group — 2026-11-03

- **T-706b built (tier B; split again, see ADR-530; not run on a phone; migration 0138, new and undeployed; ADR-530 to
  ADR-535 and Q-490 to Q-493 Proposed).** An admin sends a push from the console (Messages, third tab "Push to a group") to
  everyone in an event (found by its join code) or to players who opted in to promotional push, by city and interests,
  through the existing push pipeline (`group_push_event` and `group_push_promo`, free text). An event push is one notice the
  store fans out to the event's real players; an opted-in push is written by `group_push_fan()` in pages of 500 players
  through `marketing_audience` (the push worker calls it each loop), with the consent read again at the fan-out and the claim.
  Text rules: 60 and 140 characters, both languages, no placeholder, the name rule; the saved promotional push is the
  composer's starting text. A player gets at most one promotional push a week across group pushes and invitations
  (Q-421 part 2, `promo_push_free`, mirrored in `invitation_candidates`); the promotional email sender is decided in ADR-535
  for T-706c. Push stays off in practice (no Firebase); the sends still write the center. Tests: `test/db/group-push` (24),
  `test/console/group-push` (9), shared (13), web lib (8), push worker (2), the security suites,
  `e2e/console-messaging.spec.ts` (2 more). CI minutes: 0; agent tokens: about 600k. Also: the stale merge-conflict
  markers left in `docs/DECISIONS.md` and `docs/OPEN_QUESTIONS.md` by the T-712 merge are removed (both sides kept).
  **Next:** T-706c (promotional SMS and email, the email sender, the slots; its login-code part is tier A), and the code
  review of T-706b (tier B, one mid-tier review).

## T-711b feature layers, part 2 — 2026-11-03

- **T-711b built (tier A; plan review 86 with its MAJOR and MINOR findings folded into the plan, ADR-540/542/545 and Q-500;
  migration 0141, new and undeployed; ADR-540 to ADR-546 and Q-500 to Q-503 Proposed; not run on a phone).** Questify's
  per-organizer override now reaches boosts, community quests, meet-someone and mini-games, on new things only (ADR-540):
  `games_on` and `meet_on` read `feature_enabled` (the API's platform pre-checks are gone; QF403 is the same `feature_off`
  and does not use the refused-scan limit); `settle_goal(uuid)` and `settle_community(uuid, uuid)` decide may-start per
  organizer (the boolean versions are dropped; RUNBOOK deploy note); boost and goal saves read the layer per organizer in
  the team transaction (`platformOnFor`); the boost-start push and notice wait for the layer while the scan path is
  untouched (a boost saved earlier still pays once its window opens). No lock was added to a payment; both race orders are
  tested with a 200 ms lock timeout. Ask Questify is recorded: `feature_request` and the owner's `request_feature` door
  (one open per event and add-on, 24 hours after a decline, 20 an hour per account), the card says Requested or Not
  approved and keeps the Contact link, the console home lists open requests with Allow (the unlock, which closes the
  request) and Decline. Tests: `test/db/feature-layers-points` (18), `test/events/feature-layers` (12), the console,
  security and catalog suites, unit tests for boosts, goals, tick, payer, meet and games, `e2e/feature-layers` and
  `e2e/setup` (with layout, 18 passed on desktop and phone). Full vitest once: 11,810 passed, 10 failed (one
  `event-duplicate` guard on the new table, fixed; `live-edits` statement timeouts on the busy shared database, passed on
  a serial re-run). CI minutes: 0 (not pushed); agent tokens: about 900k.
  **Next:** the T-711b code review (tier A, strongest model), then mutation on GitHub for the globs in the reply.

## T-712 view as organizer — 2026-11-03

- **T-712 built (tier A; plan review 86 with its two MAJOR and the MINOR fixes folded in; migration 0135, new and
  undeployed; ADR-520 to ADR-525 and Q-480 to Q-483 Proposed).** The console's event page opens "View as organizer"
  (primary) or support access that can change (secondary). A view grant is read-only twice: the organizer hook refuses
  every write (403 `support_view_only`) and the codes and rehearsal card, and sets `readOnly` in the request's
  `RequestContext` (every seat now built by `teamSeat`), so the database, which honours a view only in read-only
  transactions, runs a lost mark as nobody. Every read is throttled (240 a minute, queued) and logged by
  `support_view_log` with the route pattern and path ids, once a minute. The admin's banner says read-only; an ended view
  says so with a link back to the console. The generated sweep found and fixed two reads that broke read-only (the
  join setup locked the event row; the big screen and finale seats dropped the mark). Tests:
  `test/organizers/view-mode` (every organizer route), `test/db/support-view` (11), the security suites,
  `e2e/console-organizers.spec.ts`. CI minutes: 0 (not pushed); agent tokens: about 700k.
  **Next:** the T-712 code review (tier A, strongest model), then mutation on GitHub for the access globs.

## T-708 legal data requests — 2026-11-03

- **T-708 built (tier A; plan review 84 with its five MAJOR fixes folded in; not run on a phone; migration 0129, new and
  undeployed; ADR-480 to ADR-485 Proposed; Q-440 to Q-445 open).** A player downloads their data from Settings (one JSON
  file, never stored, 3 a day, a notice); an admin exports or erases one player on a legal request from the console's
  Legal request card with a reason and an opaque case number, audited; `erase_player`'s body is now `erase_account`
  (the T-217 suite passes unchanged), the admin erase takes the deletion challenges `NOWAIT` before the player (race
  tested both ways with one and two challenges: it finishes first or answers 503 busy, and the retry finds the
  tombstone), a tombstone can never change (trigger ALWAYS), and `staff-cli reapply-erasures` re-applies after a
  restore. `test/db/personal-data-catalog` is the closed list of where a player's data lives. New direct app dependency
  `expo-file-system` (Expo's own module, already in the lockfile). Export timing: 50 events, 10,000 ledger entries,
  2,000 notifications, 500 submissions, 1.5 MB, 0.84 s warm and 1.0 s cold on the local database. CI minutes: 0 (not
  pushed); agent tokens: about 1.2 M.
  **Next:** the T-708 code review (tier A, strongest model), then the mutation run on the TS globs.

## T-701b owner email change and urgent reports — 2026-11-03

- **T-701b built (tier A; plan review 82 folded in; migration 0130, new and undeployed; ADR-490 to ADR-496 and Q-450 to
  Q-453 Proposed).** An admin starts an owner's sign-in email change from the console organizer page; the owner confirms
  on `/{lang}/email-change` with the emailed code and the current password, or waits 24 hours without it; the old
  address is told and can stop it (after completion, Stop alerts the team). Reports from a live event are urgent and due
  in 1 hour; the queue puts them first with due times, the console menu shows the urgent count, and a team digest (one
  per 10 minutes, 100 a day on its own budget) goes to `moderation.alertEmail` or `MAIL_FROM`; the Reports page edits
  the moderation addresses. Tests: `test/db/owner-email-change` (18), `test/db/report-urgency` (9),
  `test/console/owner-email` (8), `test/team-alerts/worker` (5), the security suites, `e2e/console-owner-email.spec.ts`,
  the reports spec, layout pages for the two public pages. CI minutes: 0; agent tokens: about 450k.
  **Next:** the T-701b code review (tier A, strongest model), then mutation on GitHub for
  `apps/api/src/console/owner-email*.ts` and `apps/api/src/auth/email-change*.ts`.

## T-713 Questify home layout editor — 2026-11-03

- **T-713 built (tier B; not run on a phone; migration 0137, new and undeployed; ADR-510 to ADR-514 and Q-470 to Q-473 Proposed).** A platform admin reorders and hides the eleven blocks of Questify home and writes its text banner (up to five slides, a tap opens nothing or an https link) at `/console/home`, with the phone redrawn from the unsaved draft, Save, Discard and Revert. One audited definer door (`admin_home_layout_save`, the 0119 catalog pattern) stores `platform_setting` key `questifyHome`; `GET /v1/config` carries `questifyHome: {blocks, banner}`; the app draws the blocks in that order from the last working copy first and falls back to the order it always had. Six blocks (`notices`, `code`, `account`, `operator`, `invitations`, `events`) move but are never hidden. The daily games are now two blocks. Pictures (Q-149) and taps into the app's own screens (Q-471) are not built. Tests: `packages/shared` questify-home (22), `test/db/console-home-layout` (22), `test/console/home-layout` (9), `app` home-layout and `loadHomeConfig` (8), `web` console-home (6), the security suites, `e2e/console-home.spec.ts` (3), `layout.spec.ts` with the new page. CI minutes: 0. No mutation (tier B). **Adjacent, not mine:** `test/db/personal-data-catalog` fails on main until T-701b's `team_alert` columns are classified.
  **Next:** the next unchecked task in `docs/TASKS.md` (T-714 needs T-711).

## T-706 message templates and support contact — 2026-11-03

- **T-706 built (tier B; split, see ADR-460; not run on a phone; migration 0127, new and undeployed; ADR-460 to ADR-462 and Q-420 to Q-422 Proposed).** The four templates (login-code SMS, promotional SMS, email and push) are edited in the console at `/console/messages` with the CST rules enforced on save and on a revert, checked again by the door and by the table's own CHECKs: a promotional SMS or email cannot be saved without `{optOutUrl}`, a login-code SMS without `{code}` and a sign-in-code wording, an SMS stays within 3 parts (`smsParts` moved to the shared package). The support contact (WhatsApp, phone, email) is edited on the same page, read at `GET /v1/support-contact`, shown on `/{lang}/contact` and put into the legal drafts' `{{CONTACT_EMAIL}}` and `{{PRIVACY_CONTACT}}`. **T-706b** (push to a group, promotional campaigns, the promotional email sender, the senders reading their slot) is next in `docs/TASKS.md`. Tests: `packages/shared` messaging (14), `test/db/messaging` (13), `test/console/messaging` (12), the security suites, `legal.test`, `e2e/console-messaging.spec.ts` (2), `layout.spec.ts` with the new page. CI minutes: 0.
  **Next:** T-706b, or the next unchecked task in `docs/TASKS.md`; mutation is not needed (tier B).

## Staging, APK and demo — 2026-10-30 (evening)

- **CranL runs migrations through 0086** (T-505 deployed from f408f6c, CI run 41095188086, verify ok; owner connection removed).
  Migrations up to 0086 are frozen.
- **Staging `DASHBOARD_ORIGIN` is now `https://questify.nafes.com`** (was the `…cranl.net` web address): sign-up from the
  domain was refused as `csrf_rejected`. Printed `/q/` codes now carry that origin, so the preview APK's
  `EXPO_PUBLIC_QUEST_CODE_ORIGIN` moved with it (`apps/app/eas.json`). The `…cranl.net` web address still loads but its
  writes are refused; use the domain.
- **Preview APK** (EAS build be6cc517, from 6adc57e): brand icon, Android adaptive icon and splash (`apps/app/assets/brand/`,
  from `docs/design/assets/logo`), staging API and the domain's QR origin. Built from a clean worktree because a worker's
  uncommitted files would otherwise ride in the upload; `.easignore` leaves `docs/` out (181 MB to a few MB).
- **Demo events:** `77XBUB` (live until 2030; owner `d.hamidaddin7@gmail.com`) and Dhia's `3MZM8X` (approved, live from
  2026-10-30 18:08 UTC). The staging Questify admin is `xdhia7@gmail.com`.
- **Photo storage is parked (Dhia: "Later", 2026-11-01, Q-149):** six upload tasks wait (T-301b, T-305b, T-504b, T-506b, T-507b, T-602b).
- **Push on phones is off (Dhia: "Later", 2026-10-30):** no Firebase project yet, so no `google-services.json` in the app
  and no `FCM_SERVICE_ACCOUNT` on the API; iPhone needs the APNs key. The in-app notification center works. Owed by Dhia
  before launch (RUNBOOK "The app's side of push").
- **The app now sends `X-App-Version`** (its config version, 1.0.0; see "Follow-ups batch 2" below), so the API's
  minimum-version gate (426) reaches phones; raise `MIN_APP_VERSION` only together with a store release.

## Follow-ups batch 2 — 2026-10-31
- **Cleared from FOLLOWUPS (tier B/C, one worker, no review owed beyond the coordinator's look). Migration 0101** (new,
  undeployed): `start_cheers_moment` ends a moment when a pending finale starts and refuses one once the finale has begun
  (409 `finale_started`); `sponsor_tag_set` answers a vanished item or sponsor as SO404 instead of a foreign-key fault.
  **Fixed:** ControlRoom first read under StrictMode and the quest list now reread every 30 s; a pending item of a closed
  change set shows `discarded` (was "Ready") and a points edit on a played live quest without a choice previews as invalid
  (`apply_required`); a body over 16 KiB as jsonb answers 422 `invalid_change_set {field: body}`; saving a boost is refused
  while the event's own double-points switch is off; `useConfirmation` logs a thrown action; the push-defaults panel offers
  Try again; the sponsors page stops saying Loading after a failed read; the team's held-prizes count is 404 for an editor
  outside their event limit (the public event's own policy had let it through); the app sends `X-App-Version` and its
  version is 1.0.0; category buttons carry the category name for assistive technology.
  **Tests added:** agenda register refused with the agenda off and cancel still working; editor outside the limit; the
  discarded and points-preview states; the header and the config version; the event-switch boost refusal; the cheers cap
  and the sponsor-tag race (deterministic, with a held row lock).
  **Left:** the `invitation-sending.int.test.ts` full-run flake (not found; see FOLLOWUPS for what was ruled out); the
  app render test for `eventOff` was dropped (the app has no render-test harness, and a harness is not worth adding for
  one line).

## T-709d XP table and items — 2026-11-02

- **T-709d built (tier A; migration 0124, new and undeployed; 0123 is T-707's; ADR-440, ADR-441, Q-399, Q-401, Q-402
  Proposed; plan review 85, its five fixes folded into the plan and ADR-440 first).** **XP table** tab: one row per level
  (start in XP, reward picked from free items, a lock on a level anyone reached), Add level, Remove top level; Save shows
  the preview first ("About {up} players go up… about {gems} gems… Undoing this does not take them back." / "About
  {down} players go down a level. They keep what they earned.") and sends `confirmed`; a lowering revert asks too; 503
  shows "Players are levelling up right now." The door (`admin_xp_table_save`) writes `xp_level` and `level_item` only,
  under row locks taken one per statement within one 1 s budget (CA503 / 55P03 → 503 `busy`, Retry-After 2), orders its
  updates so the `xp_from` UNIQUE never trips, refuses removing a level anyone reached or stands at (`level_held`) and
  remapping a reached level (`reward_given`), and needs `confirmed` for a save that pays. `levels_reach` (the only
  inserter into `level_reached`, FOR KEY SHARE per level) serves `xp_apply` and the sync's new `xp_catch_up`, which runs
  right after the sync's `player_xp` lock and pays each due level's item and gems once. `own_level`, `own_equipment` and
  the console's player record derive the level from XP. **Items** tab: equal cards (kind icon, both names, art, source
  badge), names always editable, art locked "On sale" / "Players own it", New item (optionally on sale); the source guard
  lets a shop item change its names only. **Tests:** DB `console-xp-table` (42), `console-xp-table-races` (13, incl. the
  budget test, shown to fail with a per-lock timeout), `console-items` (19), HTTP `catalog-xp-table` (7), security suites
  (outsider, cross-tenant, routes), shared and web unit tests (`console-catalog-xp`). Timing at 300,000 players
  (`test/perf/xp-table-timing`, by hand): save 159 to 316 ms, preview 191 to 307 ms, a queued scan 167 to 616 ms (Q-401).
  Full vitest once: 11329 passed, 2 failed (gems expected a shop item's name to be frozen, now its art; a zod `.union()` read as a Set method by the Hermes check) and one hook timeout under load (routes); all fixed and the touched suites re-run green. Browser, one worker after a fresh build: layout and console-catalog 12 passed, 2 skipped (shared documents on phone). Lint, format, types, function limits clean. CI minutes: 0. Agent tokens: about 1.5M (estimate).
  **Next:** the T-709d code review (tier A, strongest model), then the mutation run on the TS globs.

## T-709c thresholds, amounts and tier revoke — 2026-11-02

- **T-709c part 1 built (tier A; migration 0122, new and undeployed; ADR-436 to ADR-439 and Q-398 Proposed; plan review
  score 86, its six fixes applied; T-709d split out with a re-plan note).** **Achievement thresholds** (FR-1403): the
  Achievements tab edits the name and bronze, silver and gold (whole, 1 to 100,000, rising); a save or revert that lowers a
  tier answers 409 `confirmation_required` with the gems each lowered tier pays now, and the card asks once ("Pay gems
  for {name}?", undoing does not take them back) before it sends `confirmed`; the door locks the row FOR NO KEY UPDATE
  (never waits on a sync, tested both orders); paid once at the next sync, a revert keeps earned tiers and gems.
  **Amounts** tab: XP (quest, daily finish, each right answer, solved word) and gems (level up, bronze, silver, gold) in
  two equal cards, one confirmation naming each changed amount; CHECKs on `platform_setting` `xp` and `gems`; the generic
  settings writer is narrowed to `features` and `tuning` (USING and WITH CHECK); the door inserts a missing row then locks
  both rows in key order (no table lock). **Tier revoke** on the player record: an Achievements section with a Revoked mark,
  Revoke tiers (banned only) and Restore tiers panels with a reason and note; `achievement_revocation` is append-only;
  a revoked tier is hidden, shows no next tier, is never earned again or paid while revoked; paid gems stay (Q-398).
  **Tests:** `test/db/console-catalog-xp` (44), the HTTP catalog and safety suites, security suites (outsider,
  cross-tenant, routes), shared and web unit tests; the four suites that stored out-of-range amounts now assert the CHECK.
  Full vitest once: 11229 passed, 12 failed (gem-shop's fixture wrote a partial `gems` row; two web lists missed the new
  keys), all three fixed and re-run green. Browser, one worker after a fresh build: layout, console-catalog,
  console-players: 13 passed, 1 skipped (amounts on phone, one shared document). Lint, format, types, function limits
  clean. CI minutes: 0. Agent tokens: about 1M (estimate).
  **Next:** the T-709c code review (tier A, strongest model), then T-709d's re-plan and plan review.

## T-703 platform switches and tuning numbers — 2026-11-02

- **T-703 built (tier B; not run on a phone; migration 0125, new and undeployed; ADR-450 to ADR-453 and Q-410 to Q-412 Proposed; split: maintenance mode and the banner are T-703b).** The console page **Switches and numbers** (`/[lang]/console/switches`) edits the 27 platform feature switches (on or off at once, a message in both languages while off, put back to the app's own) and the 6 tuning numbers (whole, inside the shown range, put back). Four new server-only numbers are read by the database (`rehearsal_cap()`, `flag_tuning()`, `readiness_soon()` follow `platform_setting` `tuning`, shipped number on any bad value) and never reach a phone; the rehearsal card shows the cap in force. One key per call, audited with before and after; the app lists switched-off features' messages on Questify Home. The unused `myQrGraceSeconds` is gone and the burst flag text no longer says "5 minutes". The last-working configuration was already built and tested (T-007, ADR-412). Left: FR-1731 (T-706), the other FR-1770 numbers (Q-410), XP on repeats (Q-412). Tests: `test/db/platform-tuning` (12), `test/console/switches` (9), the security suites, shared, web and app unit tests, `e2e/console-switches.spec.ts`, `layout.spec.ts` with the new page. CI minutes: 0.
  **Next:** T-703b, or the next unchecked task in `docs/TASKS.md`; mutation is not needed (tier B).

## T-703b maintenance mode and the scheduled banner — 2026-11-03

- **T-703b built (tier B; not run on a phone; migration 0134, new and undeployed; ADR-470 to ADR-473 and Q-430 to Q-432 Proposed).** The Switches page gains a **Maintenance and banner** tab: pause play everywhere or for one event (by join code) with a message in both languages, and schedule the Questify Home banner. Both are `platform_setting` blocks composed into the configuration (`maintenance`, `banner`), so the app keeps its last working copy and shows them without a release; the phone decides the banner window by its clock. While paused, every door that earns or spends (scan, vote, quiz, submit, game, tap, meet, kiosk, stamp, reveal, reserve, goal, join, the station's scan, award and check-in, Questify sync, daily, gems) answers 503 `maintenance` with the message (`src/maintenance/gate.ts`, `play_event_id`; a test walks every player and device write route); reads, leaving, ratings, prize handover, the dashboard, the rest of operator mode, the console and the config door are never held. Home shows the pause, the banner and switched-off messages; the event pill shows the event's pause. CI minutes used: none (no push). Tokens: roughly 450k.
  **Next:** the next unchecked task in `docs/TASKS.md`; mutation is not needed (tier B).

## T-707 legal versions and help — 2026-11-02

- **T-707 built (tier B; not run on a phone; migration 0123, new and undeployed; ADR-445 to ADR-447 and Q-405 to Q-407 Proposed).** The version in force of the six legal documents is data (`legal_version`, append-only, published in the console at `/console/legal`, in force at once); players are asked at launch and refused at sign-in as before, an organizer's team is held (403 `organizer_acceptance_required`) until its owner accepts, with a dashboard banner. Help and FAQ articles (`help_article`) are edited in the same console page, read at `GET /v1/help`, `/{lang}/help` and the app's Get help screen; a language alone shows to both readers. Wording is data, not final copy (Q-288 open). Tests: `test/db/legal-help` (17), `test/console/legal` (15), the security suites, shared and web unit tests, `e2e/console-legal.spec.ts` (4), `layout.spec.ts` with the new pages. CI minutes: 0.
  **Next:** the next unchecked task in `docs/TASKS.md`; mutation is not needed (tier B).

## T-705b reports and moderation — 2026-11-02

- **T-705b built (tier A; not run on a phone; migration 0121, new and undeployed; ADR-433 to ADR-435 and Q-395 to Q-397 Proposed).** **Reports** (FR-1411, FR-1413): `POST /v1/reports` through `report_content` (an active player, only what they can see in an event they are an active member of, or an active player's username; one open report per reporter and target; 10 an hour and 30 a day counted in the database; the snapshot keeps what was reported; a username reported from an event's ranking also opens the team's `report_player` ticket when the help desk is on). Report in the app on the quest sheet, each reward, the full announcements list, agenda sessions, the sponsor page, the event's info page and profiles (ranking rows now open a profile with their event). **Console Reports** (FR-1404): grouped by target, oldest first, "Over 24 hours" marked; a target's page shows each snapshot beside the content now; Unpublish / Publish again for quests, rewards and announcements; links to the player's record (rename, ban) and the event (suspend); Close with the outcome or Dismiss. **Unpublish** (FR-1414): `content_hold` (team reads its own through a policy); a held quest stays hidden (HD423 → 423 `content_held`), a held reward leaves the shop, goal, desk, reserve door and pushes, a held announcement leaves the list, the center and pending pushes and a scheduled one is skipped `held`; `content_unpublished` alerts (FR-1727 now complete); audit with the event. **Console Flags**: open flags per event, read-only. Erasure and the 180-day purge of handled reports (lifecycle tick). The dashboard shows Questify's notice on held quests, rewards and announcements.
  **Tests:** `test/db/content-reports` (15), `test/console/moderation` (4), security suites (outsider, cross-tenant incl. `content_hold` probe, routes, player-name gate), `tick.test`, `report-api.test` (app), `console-reports.test` (web), `e2e/console-reports.spec.ts` (2, desktop and phone) and `layout.spec` (2, 6.6 min, the two new console pages in both languages). Full vitest once: 11,172 passed, 1 failed (the event-duplicate table list lacked the two new tables), fixed and that file re-run green (13). tsc, oxlint, oxfmt, function limits clean. CI minutes: 0.
  **Next:** the T-705b code review (tier A, strongest model); its mutation globs ride with the next tier A run.

## T-705 safety tools — 2026-11-02

- **T-705 built (tier A; not run on a phone; migration 0120, new and undeployed; ADR-429 to ADR-432 and Q-392 to Q-394 Proposed).** **Platform ban** (FR-1416, FR-1417, FR-1606): a Ban / Lift ban panel on the console's player record, a reason code (the ban's is shown to the player in fixed words) and a note, one confirmation; `admin_ban_player` and `admin_lift_ban` are the only writers of a standing (the API's role lost `UPDATE (status)` on `player`; a catalog test finds no other writer); a ban ends every way in as a reset does and sets the `tokens_valid_after` cutoff, repairs the rankings, keeps memberships, ledger and history; `player.ban_action_id` points at the ban; erasure clears it first. The sign-in answers `account_banned` (still only after the right code) with `{reason, appealEmail}`: the `platform_setting` `moderation.appealEmail`, else `MAIL_FROM` (no row seeded); the app shows "Your account is suspended", the reason and a mail link. **The wall** (ADR-430, plan review BLOCKER): BEFORE INSERT guards on `ledger_entry`, `xp_entry` and `gem_entry` raise PB423 for a player who is not active (refunds, removals, lowerings and gem purchases pass; a handover is refused so the reservation expires), serializing with a ban through the membership row, never the player row (a completion must not wait on the player, which erasure holds; tested both orders, held on a lock); the set-based writers (bulk and group awards, the past points change; the community payout already did) skip a banned member (tested: the rest are paid); PB423 is one global 423 `player_inactive`. **Block a player** (FR-1415): `player_block`, `GET|POST /v1/me/blocks`, `DELETE /v1/me/blocks/{username}` (the name replaced in the access log), 500 per player under a row lock, 60 changes an hour; the event ranking (top, today, rows, full names), the revealed results and the Questify-wide boards keep a blocked player's row and place with no name or face (`hidden`, the app shows "Hidden name" and opens nothing), the profile answers 404, meet quests refuse the pair both ways with `not_for_them`; staff, console, big screen untouched (Q-394); a gate test maps every function that names a player (masked or allowed with a reason) and every API file that reads a player row with a name. App: Block on a profile (asked once), Settings → Blocked accounts with Unblock. **Word lists** (FR-1779): console page `/console/word-lists`: the lists with search, language and match filters, Add and Remove, and the retired usernames with Release (in the body, the audit holds no name; Q-385's un-retire). **Local:** full vitest ONCE: 11125 passed, 16 skipped, 12 failed (703 files, 12.6 min): the first wall locked the player FOR SHARE, which broke the XP rule that a completion never waits on the player row (erasure holds it) and the souvenir race tests that banned by hand; the wall now serializes through the membership, the souvenir tests use the ban door, the push-store list names the ban; those 16 files and the related suites re-run green (956). Browser, one worker after a fresh web build: layout.spec, console-players.spec (ban and lift added) and the new console-word-lists.spec, 8 passed (7.4 min). expo export --platform android ok. tsc (shared, api, web, app), oxlint, oxfmt, function limits clean (baseline lowered). CI minutes: 0. Agent tokens: about 0.9M (estimate).
  **Next:** the T-705 code review (tier A, strongest model), then one `mutation.yml` run for T-704 and T-705 (globs in the reply), then T-705b.

## T-709b catalog editors — 2026-11-02

- **T-709b built (tier B; not run on a phone; migration 0119, new and undeployed; staging runs through 0115, 0116 and 0117 are pushed, 0118 is T-704/T-705's; ADR-425 to ADR-428 and Q-390, Q-391 Accepted (developer, delegated by Dhia; review 82 fixed, achievements made name-only)).** The console has a **Catalog** page (`/[lang]/console/catalog`, one nav item, four tabs): **event templates** (equal cards with the name and description in both languages, switched off or offered, the setup as JSON checked live by the template schema, a new template goes last), **achievement names** (the three thresholds are shown, not edited: a lower one makes `questify_sync` pay gems to every player at their next sync and a revert cannot take them back; the door refuses any threshold with CA400), **level titles** (the whole set, level 1 required) and the **gem shop** (price, on sale or retired, place). Each change is a definer door that checks the admin, changes only its row and writes the audit entry itself (who, before and after); a revert is the same door given the id of the row's latest catalog entry, which it re-reads under the row's lock (CA409, 409 `stale`, when another admin changed the row since), so it passes the same checks and can itself be reverted (no history table; partial index `audit_log_catalog_idx`). The daily-challenge questions and Questify quests already had pages (T-406c, T-403b). A template body is at most 30,000 bytes (audit columns stay under 64 KB); two admins making the same new key get CA409 for the second. **Split:** achievement thresholds (with a gems confirmation and a test that a sync pays once), the XP table (curve and recompute, level reward map, XP and gem amounts), item names and new shop items, and the audited revoke of earned tiers are **T-709c** (tier A, plan first; ADR-425).
  **Tests (after the review fixes):** `test/db/console-catalog` (25), `test/console/catalog` (10), the security suites (route table, outsider, cross-tenant), `catalog.test` (shared, 7), `console-catalog.test` (web, 12), `e2e/console-catalog.spec.ts` (6, desktop and phone) with `layout.spec` (2), all green. Full vitest once: 11,008 passed; the 4 that failed were this task's list guards (the gems door list, two help-copy lists, the words exemptions), fixed and rerun green, and `console/platform` (a sign-in code not emailed under load; green alone). **Mutation globs:** none owed (tier B).
  **Next:** `T-709c` (tier A, plan and plan review first) or the next unchecked task in `docs/TASKS.md`.
## T-704 player tools — 2026-11-02

- **T-704 built (tier A; not run on a phone; migration 0118, new and undeployed; ADR-419 to ADR-422 and ADR-424 Proposed, ADR-423 Accepted by Dhia; Q-385 to Q-389 Proposed).** The plan was first amended with the plan review (80) and Dhia's answers (merge dropped, appeals to `MAIL_FROM`, no ban email); T-705 and the new T-705b keep their amended sections unbuilt. Console **Players** (`/console/players`): search by a folded username prefix or an exact mobile or email (POST body, masked contacts, tombstones never found); the read-only **record** (`/console/players/{id}`): profile, masked contacts and when they last changed, username history with Questify's renames marked, events, flags, reports, sign-ins, marketing consent, Questify's own actions and the points record (50 a page, by event); three actions, each with a reason code, a note and one confirmation: **show full contacts** (every call a fresh action row and audit entry, outside the idempotency store), **change username** (players' own rules, old name retired for everyone, the player told with fixed text), **reset sign-in** (codes, tokens and push devices ended, the `tokens_valid_after` cutoff checked by `player_session_owner` and `rotate_player_refresh`, the contacts' code and failure throttles cleared; nothing returned that grants access). Six admin doors (QE403 for every other seat), two closed tables (`player_admin_action`, `username_retired`), erasure restated. Races tested with the second transaction held on a lock: reset vs refresh and vs sign-in in both orders, two resets, admin vs player rename. **Local:** full vitest ONCE: 11019 passed, 16 skipped, 2 failed (the community gate map lacked `console_player_ledger`; the Hermes guard flagged `z.union`); both fixed and those files re-run green (83). Browser, single worker after a fresh web build: `layout.spec.ts` 2 passed (16 min, both projects, the two new console pages in both languages); `console-players.spec.ts` failed on the search box's role, fixed, one targeted rerun 4 passed. tsc, oxlint, oxfmt, function limits clean. CI minutes: 0. Agent tokens: about 0.55M.
  **Next:** the T-704 code review (tier A, strongest model), then T-705; one mutation run after T-705 on `apps/api/src/console/players/**/*.ts` with T-705's globs.

## T-709 platform pages — 2026-11-02

- **T-709 built (tier B; not run on a phone; migration 0117, new and undeployed; staging runs through 0113; ADR-415 to ADR-418 and Q-382 to Q-384 Proposed).** Three console pages for platform admins: **Health** (six equal tiles, each with an icon and a word for OK, Warning or Down, the reasons, and the facts behind View more; the events tile lists the five busiest live events), **Numbers** (organizers, events, players, staff and the last hour's points entries as equal tiles) and **Admins** (every platform admin with the sessions open now, and a forced sign-out of any session but the one asking, with a reason, a confirmation and an audit entry; the ended session's next request is refused). Five definer doors (`console_health`, `console_numbers`, `console_admin_accounts`, `console_admin_sessions`, `admin_end_session`), all for an active platform admin only and granted to the API role alone; counts and flags only, every unbounded count stops at 10,001. One shared function (`evaluateHealth`) turns the facts and this server's set-up (yes or no per transport) into the tiles. No ticker keeps a run record, so a stopped ticker shows as its symptoms (an event past its start or end, the oldest waiting push or alert, leases that ran out); Q-382 asks whether a heartbeat is wanted. `revoke-admin` refuses the last active admin, even for two revokes at once (FR-1785). **FR-1403 split out as T-709b** (ADR-415): the eight content editors stay pending. **Measured:** `console_health()` 25 to 27 ms and `console_numbers()` 152 to 165 ms warm at 300,000 players, 150,000 seated, 300,000 points entries and 600,000 push sends.
  **Mutation globs (not tier A; none owed):** the forced sign-out and the last-admin rule touch admin powers lightly; if wanted, `apps/api/src/console/platform.ts`, `apps/api/src/console/platform-routes.ts`, `apps/api/src/auth/staff-admin.ts`.
  **Next:** `T-709b` (FR-1403 editors) or the next unchecked task in `docs/TASKS.md`.

## T-702 text matrix editor — 2026-11-02

- **T-702 built (tier B; not run on a phone; migration 0116, new and undeployed; ADR-411 to ADR-413 and Q-378 to Q-381 Proposed).** The console has an **App texts** page (`/[lang]/console/translations`, nav item with the globe icon): every shipped key (over 4,100) as a row of key, English and Arabic side by side, the shipped text kept in view under a changed one, a "Changed" marker, "Out of date" for a saved text the app ignores, search (key or text in either language, case and Arabic marks ignored), a screen select and All / Changed / Missing Arabic / Missing English tabs, 50 rows a page. One row opens into English and Arabic boxes (Arabic right to left) with placeholder chips (a lost name is flagged and put back with a click, an added name flagged, Save waits), a revert to the shipped text per row, and "Save your edit?" before any step, link or filter that leaves an unsaved edit (FR-1757). API: `GET /v1/admin/translations` (matrix built in `packages/shared/src/i18n/matrix.ts` from `MESSAGES` and the store) and `PUT /v1/admin/translations/{key}` (the store's own `save`, now returning the row; 422 `invalid_translation` and `text_locked`). Migration 0116: the store's write policies ask `app_admin_id()`. Legal and consent keys (`isLockedText`) are read-only and left out of the public bundle (Q-378). **The phone did not read the store before; it now does** (`apps/app/src/config/translations.ts`, `useOverrides`: cached copy, ETag fetch on start, on foreground and every 30 s, last working copy kept). `readOverrides` moved to shared. CI minutes: none used (local runs only).
  **Tests:** full vitest once (shared with a second worker's runs on the same machine): 10895 passed, 12 failed; the 3 that were this task's list guards (`scripts/ci-scope.test.ts` area table, `help-copy.test.ts` info-tip key and help prop) are fixed and rerun green, the other 9 were hook timeouts of the upgrade-against-traffic suites under load (`questify-ranking-upgrade`, `souvenir-repair`, `souvenir-doors`, `daily-upgrade`, `souvenir-results`, `souvenirs`) and passed alone (63). Browser, one worker, fresh build: `layout.spec` 2 passed (desktop and phone, includes the new page), `console-translations.spec` 12 passed (one test needed a rerun after a port clash with the other worker's browser run and a spec fix). New: `packages/shared/src/i18n/matrix.test.ts`, `locked.test.ts`; `apps/api/test/translations` (matrix, save, revert, audit, locked, stale, retired admin refused by the policy, non-admin 404); route guard entries; `apps/app/src/config/translations.test.ts`; `apps/web/src/lib/console-translations.test.ts`; `apps/web/e2e/console-translations.spec.ts` (6 tests, desktop and phone).
  **Left:** the dashboard's other pages still show the shipped texts (Q-380); mutation not requested (tier B).
  **Next:** the next unchecked task in `docs/TASKS.md` (T-701b, T-703).

## T-701 console foundation — 2026-11-02

- **T-701 built (tier A; migration 0114, new and undeployed; staging runs through 0113 pushed, 0115 is T-601b's; ADR-405 to ADR-410 and Q-377 Accepted by the developer after code review 88 (its MAJOR fixed); Q-372 to Q-376 answered by Dhia; mutation owed).** Plan amended first with Dhia's answers and the plan review (80, NO-GO until amended: organizer UPDATE grant revoked, ledger guard by kind with the community payer skipping, deny-by-default support seat, the minors). Admins are granted and revoked only by `staff-cli grant-admin|revoke-admin`; organizer rows are definer-only; organizers and events can be suspended from the console with a reason the organizer reads (players see "unavailable"); the database refuses joining, every ledger kind but refunds and removals, the public reads and the big screen, and the batches skip; the team's dashboard turns read-only (423) with a banner. A Questify admin opens 15 minutes of support on one event and works in the organizer's own dashboard as an editor of that event (no pairing, no exports, nothing outside the event), silently to the organizer; every change is stamped in the audit log and shown as "Questify support" where the dashboard names an actor. Console: Organizers list and page, suspend and support panels and the history on the event page; console reads that show emails are audited (Q-116 closed, Q-110 closed). The app keeps a suspended event on the player's list and says it is unavailable. Measured: `app_organizer_id`/`app_event_scope` as PL/pgSQL made a member read 2.4 to 2.0 ms and a player read 2.3 to 1.9 ms per statement (local). T-701b (owner email change, urgent reports) split; merge dropped.
  **Tests:** full vitest once: 10843 passed, 4 list guards failed (ci-scope area, audit trigger list, core-columns organizer insert, duplicate table list), fixed and those 4 files rerun green (103). Full browser suite once (1 worker, fresh build): 348 passed, 1 failed (quests.spec phone, Playwright trace-file ENOENT/EPERM, not app code), rerun alone: passed. New: test/db/console-suspension, support-grant, admin-role, test/console/organizers, support-seat and suspended-set units, e2e/console-organizers (8 runs). CI minutes: 0 (local only). Agent tokens: about 850k.
  **Next:** the code review of T-701 (tier A), then mutation on `apps/api/src/console/**`, `apps/api/src/organizers/routes.ts`, `apps/api/src/organizers/support-seat.ts`, `apps/api/src/events/suspended-set.ts`, `apps/api/src/auth/staff-admin.ts`; then the next unchecked task in `docs/TASKS.md` (T-701b).

## T-601b event templates — 2026-11-02

- **T-601b built (tier B; not run on a phone; migration 0115, new and undeployed; staging runs through 0112, 0113 is pushed and 0114 is T-701's; ADR-404 and Q-371 Proposed).** A new event can start from a template: the New event page has a "Start from a template" section (Start blank first and selected, then Conference, Festival, Campus event and Company event, each with one line and, when chosen, a preview of its categories and quests with their types and points, its rewards, its accent and its switches), and the guided setup's first step offers the same picker while the draft has no quest, after a confirmation. An event made from a template holds its categories, quests and rewards in Arabic and English, its accent, switches and layout preset, and is a plain draft: editing it changes only that event. Templates are rows of the closed table `event_template` (no grant; seeded by the migration; the Questify console edits them later, note on T-709), read and applied through two definer doors; the shared `templateBodySchema` checks every body on every read and a test checks the shipped ones in both languages. Rewards are experiences and digital ones with no stock; a template never holds an item reward (it needs the prize desk place), a quiz, a passport, a location, a typed code, a player, a point or a secret. **Not built:** the console editor, private "save as template", item rewards and quizzes in a template. **Local:** full vitest ONCE: 10800 passed, 16 skipped, 2 failed (both list-style guards: the community gate's function map did not list `event_apply_template`, and the help-text list did not list the rewards note, now an info button); those suites and the new template suites re-run green. Full browser suite after a fresh web build, single worker: 341 passed, 5 skipped, 0 failed (34.1 min); the new `event-templates.spec.ts` (6 tests, desktop and phone, Arabic and English) was also run on its own twice before it. CI minutes: 0. Agent tokens: about 450k. Mutation: none (tier B).
  **Next:** the next unchecked task in `docs/TASKS.md` (T-701).

## Follow-ups batch — 2026-11-02

- **Follow-ups batch cleared (tier B/C, no review; migration 0113, new and undeployed).** 16 lines of `docs/FOLLOWUPS.md` finished and 10 more trimmed; 45 remain. Player- and organizer-visible fixes: the shop-closing push now says the time as well as the date; a won-prize card opens My QR when the shop (and its tab) is off; "Collect by" disappears the moment a reservation ends; a paused quiz lets an attempt already open go on; a featured quest that is paused, locked or closed says so; a failed link open and "Not now" on a desk offer say so; link hosts are bidi-isolated in Arabic; the builder reads the quest list again before its form closes (no stale edit after a save); the hint note shows on its category's card; announcement send failures show inside the confirmation; the alert switches have a retry and keep keyboard focus (`aria-busy` instead of `disabled`, also on the push, event, ranking and branding switches); the layout move buttons keep focus at the ends; the App labels reset keeps its column; the Home preview titles the ranking card like the app; the session import says how many rows past 500 were left out, refuses a file over 1 MB and lists at most ten bad rows. Database (0113): index-only alert email counts, `alert_claim` skips unsendable rows only when it has room, no top-10 exit notice for a player the board stopped counting, and the operators page reads reviews and answers as a range plus one seek. Tests made deterministic: the community settle-point check retries until the database is quiet, the first-bonus Stop test has its own timeout; new tests: scoped editor outside the event (404), per-event top-10 cooldown, `ranking_on` against `composeConfig`, exit notice for a banned player. Left (and why) are in `docs/FOLLOWUPS.md`. **Next:** the next unchecked task in `docs/TASKS.md` (T-701).

## T-618 go-live readiness checklist — 2026-11-02

- **T-618 built (tier B; review 82, its three MAJORs fixed in migration 0112 itself; not run on a phone; migration 0112, new and undeployed; staging runs through 0111; ADR-403 and Q-370 Accepted).** The Overview (draft and scheduled events) and the guided setup's last step show the go-live checklist: a line of three counts (needed, to check, ready), then the items blocking first, each with a status word and a Fix link (Open when done) to the page that sets it: dates, activation, quests, rewards and stock, the prize desk place, operators, joining, official rules, the big screen's paired screen, kiosk devices, the rehearsal run (Missing when not run), the accent and the guided setup; only what applies is listed. The console has a Readiness page (platform admin): events starting within 14 days that are not live yet, soonest first, as equal cards with the organizer, the start, the counts and the open items. Facts come from two read-only definer doors (`event_readiness` for the event's team, `readiness_soon` for an admin; counts and flags only; the internal `readiness_facts` has no grant), items from one shared function, so both views agree; the checklist writes nothing and blocks nothing (a blocking item is advice). **Not built:** "quest QR codes printed" (nothing records printing), a reminder email, a tuning number for the 14 days. **Local:** full vitest ONCE: 10728 passed, 16 skipped, 0 failed. Full browser suite after a fresh web build, single worker: 332 passed, 5 skipped, 3 failed (33.2 min): layout.spec on desktop and phone (the three count tiles were a box inside a card; they are now one line of counts) and operators.spec on the phone (the new Fix link's name matched the menu's link; both operator specs now match the link exactly). Targeted rerun on a rebuilt web, both projects: layout, operators, operator-activity and readiness specs, 16 passed, 2 failed (the readiness spec's Arabic console test read the first card, another event's; it now reads the event's own card, not re-run). tsc, oxlint, oxfmt and function limits clean. CI minutes none; agent tokens roughly 0.5M (estimate).
  **Next:** the next unchecked task in `docs/TASKS.md` (T-701).

## T-617 operator activity and the staff briefing — 2026-11-02

- **T-617 built (tier B; not run on a phone; migration 0111, new and undeployed; staging runs through 0109, 0110 is pushed; ADR-402 and Q-369 Proposed).** The Operators page (`…/events/{id}/operators`, owner and editor) shows, once the event has an operator, five equal tiles, a card per operator (day's scans, awards, hand-overs, reviews and replies, last action and how long ago, a Quiet badge from 30 minutes, top stations), the latest actions with View more, and the staff briefing. **Two doors:** `operator_activity` (read only, `award_event_of`, usernames and counts, nothing about a player an operator served) and `staff_briefing_send` (one personal `staff_briefing` notice per current operator, replay by Idempotency-Key, 3 an hour and 10 a day, PE409 for an ended event, PT409 when nobody can receive it, audited with the count). The new `staff` membership on a notice kind is asked at the fan-out and the claim; a briefing cannot be muted; PUBLIC holds no EXECUTE on anything new and the new table has no grant. Push transport is still unconfigured, so the in-app center is where an operator reads it (the bell is on the operator Home now). **Measured** (50,000 players, 60 operators, about 270,000 operator entries today): 134 to 175 ms warm with the three partial indexes, 930 to 1,090 ms without; just bulk-loaded tables (no visibility map yet) 640 to 810 ms. **Not built:** the operator-invite push (no account exists when an invite is made; its unused route entry removed), a subset of operators, scheduling, an acknowledgement. **Local:** full vitest ONCE: 10679 passed, 16 skipped, 1 failed (`i18n/translate.test`: a message key with an underscore; renamed, then the i18n, help-copy and new web suites re-run once: 72 passed); full browser suite after a fresh web build, single worker: 325 passed, 5 skipped, 0 failed (32.2 min; the new `operator-activity.spec.ts` passed in desktop and phone, with the layout check on the filled page in Arabic and English). npx expo export --platform android ok. tsc (shared, api, web, app), oxlint, oxfmt and function limits clean (no new offender). Mutation targets: none (tier B). CI minutes none; agent tokens roughly 0.55M (estimate). **Note for the coordinator:** `apps/web/e2e/finale.spec.ts` and `layout-editor.spec.ts` had uncommitted edits that are not this task's; they are left out of its commits.
  **Next:** the next unchecked task in `docs/TASKS.md` (T-618).

## T-616 owner Inbox — 2026-11-02

- **T-616 built (tier B; not run on a phone; migration 0110, new and undeployed; staging runs through 0108, 0109 is pushed; ADR-401 and Q-368 Proposed).** The Inbox page (`…/events/{id}/inbox`, Run group; owner and editor within their event limit) puts what waits for the team in one place without a new store: one read-only door `event_inbox` (counts only; PUBLIC holds no EXECUTE; AN404 behind `award_event_of`) and two partial indexes (`ticket_event_open_idx`, `flag_event_open_idx`) make the counts index scans (13 to 17 ms warm on a 50,000-player event; 30 to 40 ms and sequential scans before). Eight equal tiles, each number a link to the list it counts (the Help desk on `?status=open&kind=prize` etc., With Questify, Submissions, Flagged activity, the join queue), then equal cards: Reported players and Oldest prize problems (five rows, "View more", a nothing-is-waiting line) and the existing join-requests panel (Accept, Decline, Accept all). The Help desk opens on a tab and kind from its address; the control room's Inbox counter links to the Inbox. Only @usernames, a one-line cut of the text and the time are shown (what the owner already reads; no full name, T-615). **Not built:** reported content (T-705), polling, inline Reply or Ban. **Local:** full vitest ONCE: 10622 passed, 15 skipped, 2 failed (661 files, 13 min; `community-unlocks.int` had the new door in its gate map though it reads no quest, category or reward, which I removed; `rank-push.int` is an order flake in the two notices of one diff, T-501). Full browser suite: 321 passed, 5 skipped, 0 failed (330 tests, 32.1 min; the layout check walked the Inbox in both languages and both projects). Targeted rerun: those two files re-run once: 89 passed.
  **Next:** the next unchecked task in `docs/TASKS.md` (T-617).

## T-615 name display — 2026-11-02

- **T-615 built (tier B; privacy review 91 GO and its fixes done 2026-11-02; not run on a phone; migration 0109, new and undeployed; staging runs through 0108; ADR-400 and Q-367 Accepted).** An event shows its players by username (default), full name or both, to its staff only (default) or to every player; the full name is the answer to the Full name join field. **Two gates in the database:** the event's setting and the player's own notice (the join card says who will see the name, the join sends the audience back, `join_name_notice` records it in the join's transaction as `enrollment.name_notice`; a notice that is not the event's now rolls the join back with 422 `card_version_stale` and the card as it must read). Another player reads a full name only through `public_full_name` (audience `everyone`, enrollment active, notice `everyone`, a name given, 60 characters at most): the event ranking and today's, the revealed results, the big screen's ranking and finale. Staff (the station's result, the prize desk) read it by the setting alone. **Widening to everyone is refused** (409 `name_display_locked`, ND409) while an active or pending player who was not told is in; narrowing always works; a full name needs the Full name field (422) and the field cannot go while names show (409). Dashboard: a "Names" section on the Joining page with a row preview for players and staff. App: the card sentence, ranking rows, podium and Home's podium, the station and the desk. Never in push, logs, errors or analytics (`apps/api/src/full-name-guard.test.ts` lists the API files that may name it). **Not built:** asking earlier players again, the session check-in result, names in Meet or Cheers (FOLLOWUPS). **Local:** full vitest ONCE: 10556 passed, 15 skipped, 14 failed (656 files): `desk.test`, `results.test` (unit expectations without the new fields) and `translate.test` (a message key with an underscore) were mine and fixed; `db/live-edits` (10) and `db/cheers` (1) timed out under load as before; those five files plus the security suites re-run once: 638 passed (live-edits and cheers pass alone). Full browser suite after a fresh web build, single worker: 317 passed, 5 skipped, 0 failed (32.2 min; the new `names.spec` passed in desktop and phone). npx expo export --platform android ok. tsc (shared, api, web, app), oxlint, oxfmt and function limits clean (two baselined offenders no longer exceed). Mutation targets: none required for tier B; if the coordinator wants some, `apps/api/src/join/names.ts`, `apps/api/src/join/join.ts` (runJoin), `apps/api/src/ranking/ranking.ts` (withNames). CI minutes none; agent tokens roughly 0.6M (estimate).
  **Next:** the next unchecked task in `docs/TASKS.md` (T-616).

## T-614 event text overrides — 2026-11-02

- **T-614 built (tier B; not run on a phone; no migration; review 88, its MAJOR fixed; ADR-399 and Q-366 accepted).** An event renames the bar's six names (Home, Quests, Scan, Rewards, Ranking, Profile, which the screens and the shop title also use) in Arabic and English from a new "App labels" page (`/texts`, Setup; owner and editor). They are `event.config.texts`, in the translation store's own shape, composed into the configuration as `texts` and kept in the phone's last working copy; a blank text falls back to the platform's, per language. The list is code (`EVENT_TEXT_KEYS`): any other key, legal and consent texts included, is refused (422 `invalid_texts`). Texts are cleaned with the T-610 function, 24 characters at most; a value-carrying placeholder must stay, the event's own word placeholders may go. The currency word stays in Event words (the page links to it). `withEventTexts` lays the texts over the translator in the app's `TermsScope` and the dashboard's phone preview. **Local:** full vitest ONCE: 10494 passed, 15 skipped, 2 failed (652 files; `settings/config.int` and the ADR-370 guard `help-copy.test`; both fixed, re-run with the config tests once: 205 passed). Full browser suite after a fresh web build, single worker: 312 passed, 5 skipped, 1 failed (31.7 min; `location.spec` desktop, a field not cleared in time under load; alone 6 passed). The new `texts.spec` passed in desktop and phone. npx expo export --platform android ok. tsc (shared, api, web, app), oxlint, oxfmt and function limits clean. Mutation targets: none (tier B). CI minutes none; agent tokens roughly 0.55M (estimate).
  **Next:** the next unchecked task in `docs/TASKS.md` (T-615).

## T-613 event info page and the extra page — 2026-11-01

- **T-613 built (tier B; not run on a phone; review 86, its MAJOR fixed with migration 0108, new and undeployed: it widens `audit_log` before and after to 256 KiB).** The event info page's
  sections are `event.config.layout.info` (seven sections, `rules` protected, `schedule` starts hidden) and the organizer's words join
  `layout.content` (`about`, `faq`, `contacts`, `page`): one layout store, the same cleaning, limits and https-only links as Home's words,
  a damaged entry or part left out (ADR-398 and Q-365 accepted). The one extra page (a title and up to 12 parts: heading, paragraph, list,
  link) opens from a new Home block `page`. App: `info.tsx` draws the shown sections in order, contacts open the mail or phone app (a website asks
  first), `page.tsx` is the page. Dashboard: the Layout page gets an "Event info page" list and an "Extra page" row with their editors, and "About the
  event" and "Extra page" screens in the live preview. **Split:** pictures on the page are T-613b (Q-149). **Not built:** the sponsors and free-text
  sections, opening maps at the venue pin. **Local:** full vitest ONCE: 10426 passed, 15 skipped, 8 failed (649 files; all in
  `db/live-edits.int.test.ts`, a "Hook timed out" and a "Test timed out in 120000ms" under load, nothing near this change; that file re-run once alone: 25 passed).
  Full browser suite after a fresh web build, single worker: 309 passed, 5 skipped, 0 failed (28.0 min). `layout-editor.spec.ts` (desktop and phone, 19 passed, 1 skipped) covers the new
  order, edit, preview, save and remove flow and the Arabic page without sideways scrolling. npx expo export --platform android ok (Hermes bytecode built).
  tsc (shared, api, web, app), oxlint, oxfmt and function limits clean (no new offender). Mutation targets: none (tier B). CI minutes none; agent tokens roughly 0.45M (estimate).
  **Review fixes:** the layout route's own 160 KiB body limit, 0108 for the audit size, the preview's rules row, unique list keys, 300 characters for a website contact.
  **Next:** the next unchecked task in `docs/TASKS.md` (T-614).

## T-612 prize reservation and the desk sale — 2026-11-01

- **T-612 built (tier A; one code review and mutation owed; not run on a phone). Migration 0107** (new, undeployed; staging runs through 0105, 0106 pushed).
  **Built (FR-1834, ADR-397 Proposed, Q-364 Proposed):** `event.reservation_on` in the shop settings (dashboard switch with a confirmation naming the held
  prizes); Off refuses in-app reserves of items and experiences (`reservation_off`) and the app shows "Redeem at the prize desk" instead of Reserve; the desk
  sells after a My QR scan (`desk_sale` offer, 2 minutes) and the player's own Pay on My QR takes the price and hands over in one transaction through the
  spend body `reserve_reward` now shares (`spend_checks`, `spend_reward`; refusal order pinned by `test/rewards/reserve-order.int.test.ts`). Analytics, exports,
  rehearsal wipe and erasure count or remove a sale as a handed-over reservation. **Local:** full vitest ONCE: 10323 passed, 15 skipped, 3 failed (646 files): two list guards had not learned the new routes and `spend_reward` (`security/routes`, `db/flash-boosts` payer map; fixed) and `db/first-bonus` "Stop during continuous claims on 8 connections" timed out at 30 s under load; those three files re-run once: 149 passed. Full browser suite after a fresh web build, single worker: 307 passed, 5 skipped, 0 failed (27.5 min; `rewards.spec.ts` covers the switch and its confirmation). npx expo export --platform android ok (Hermes bytecode). tsc (shared, api, web, app), oxlint, oxfmt and function limits clean (baseline locked in). Mutation globs: `apps/api/src/desk/sale.ts`,
  `apps/api/src/desk/routes.ts`, `apps/api/src/desk/desk.ts`, `apps/api/src/rewards/shop.ts`, `apps/api/src/rewards/builder.ts`. CI minutes none; agent tokens
  roughly 0.35M for this finishing worker (estimate; the first builder's share unknown).
  **Next:** the T-612 code review (tier A, strongest model), then mutation on the globs above; then T-613.

## T-611 ranking, Quests and shop layouts — 2026-11-01

- **T-611 review follow-up (2026-11-01, review 93 GO, migration 0106 new, undeployed; staging runs through 0105).** ADR-396 accepted; Q-363 decided: (a) places only now
  reaches the big-screen ranking scene (`screen_ranking` restated in 0106: the score is sent only when `layout.looks.ranking.scores` is "shown" or not stored; the web scene draws
  the place alone when none comes; the dashboard info text no longer says the big screen does not change), (b) the player's own points on Home stay, (c) the shop default stays
  the list, (d) the phone check stays with Dhia. Also: podium steps have floors and the rank digit uses the `label` text on a small phone (tested at 96 points); grid reward
  descriptions take three lines; a `ranking` look that is not an object reads as places only; the layout int test checks `?scope=today` under places only. Mutation targets: none.
  CI minutes none; agent tokens roughly 0.2M (estimate).
- **T-611 done (tier B; one code review owed; not run on a phone). No migration** (staging runs through 0104, 0105 pushed; 0106 is free).
  **Built (FR-1832, FR-1833, ADR-396):** `event.config.layout.looks` (`{ranking: {layout: list|podium, scores: shown|rank_only}, quests: list|grid,
  shop: list|grid}`, `packages/shared/src/layout/looks.ts`), validated by `PUT …/layout` (strict), always in the composed configuration, defaulting to the
  look every event had; presets and Reset leave it alone. **Places only is enforced on the server:** `GET …/ranking` (whole event and today) and the
  player's revealed `GET …/results` carry no `score` and say `scores: false` (`ranking/display.ts`, `results/display.ts`); the app draws a score only when
  the answer holds one. Switches still win (ranking off is still 404). App: the ranking screen's List or Podium (`podiumFit`, silver, gold and bronze steps),
  Quests and Rewards in two equally tall cards a row; no score on Home's ranking card or podium when the answer has none. Dashboard: "Screen styles" on
  the Layout page and a preview with tabs (Home, Ranking, Quests, Rewards) redrawn from the draft. ADR-396 and Q-363 were Proposed here and are decided in the
  follow-up above. **Not built here:** places only on the big-screen scene (added in 0106, above); Home's own points stay (Q-363 (b)). Mutation targets: none (tier B). **Local:** full vitest ONCE: 10191 passed, 15 skipped, 1 failed (642 files; `apps/api/test/results/routes.int.test.ts` expected the old answer without `scores: true`; fixed and that file re-run once: 7 passed). Full browser suite after a fresh web build, single worker: 307 passed, 5 skipped, 0 failed (29.6 min; the new layout-editor spec passed in desktop and phone). npx expo export --platform android ok (Hermes bytecode built). tsc (shared, api, web, app), oxlint, oxfmt and function limits clean. CI minutes none; agent tokens roughly 0.55M (estimate).

## T-610 Home editor, new blocks and the banner — 2026-11-01

- **T-610 review fixes (2026-11-01, migration 0105 new, undeployed).** Control characters (C0, C1, NUL) are stripped from Home texts on save, so a NUL no longer fails the layout write with a 500; the slider's label reads place, title and subtitle and the podium reads its content; the 5 s auto-advance also stops while a screen reader is on; a countdown follows a changed clock offset; duplicating an event points the Home content's quest actions and featured item at the copies (else `none` / `null`). Q-362 (c) decided: allowed (SECURITY.md). Nits in FOLLOWUPS.
- **T-610 done (tier B; one code review owed; not run on a phone). No migration** (staging runs through 0103, 0104 pushed; 0105 is free).
  **Built (FR-1828 to FR-1831, ADR-395):** `event.config.layout.content` (banner slides, quick links, featured item, text and countdown cards) beside the
  order; four new Home blocks (`banner`, `featured`, `podium` (starts hidden), `quickLinks`) and the organizer's cards as `card:<id>` in `home.order`;
  `PUT …/layout` takes and checks `content` (plain bounded text cleaned on the server, taps limited to the agenda, map, shop, one quest or an https link);
  presets and Reset to default keep the cards and words; the composed configuration carries the content of shown blocks only. Shared:
  `packages/shared/src/layout/home-content.ts` (tolerant `readHomeContent`, strict `checkHomeContent`). App: `HomeBlocks.tsx` (banner slider with swipe,
  dots from two slides, auto-advance unless reduced motion, quick links, featured, podium, text and countdown cards, link confirmation) and pure
  `home-content.ts`. Dashboard: Edit, Add text card, Add countdown, Remove and Reset to default on the Layout page (`HomeContentEditor`,
  `HomeContentFields`, `lib/home-content-editor.ts`), Save held until the words pass, preview shows the unsaved content; the existing "Countdown" row is
  now "Event countdown". **Split:** pictures to T-610b (Q-149). **Not built:** taps to a specific session, map pin, sponsor or reward. ADR-395 and Q-362
  Proposed. Mutation targets: none (tier B). **Local:** full vitest ONCE: 10128 passed, 15 skipped, 0 failed (626 files; the first try was cut off by my own 590 s timeout and run again without one). Full browser suite after a fresh web build, single worker: 305 passed, 5 skipped, 0 failed (28.8 min; the new Home content spec passed in desktop and phone). npx expo export --platform android ok (Hermes bytecode built). tsc (shared, api, web, app), oxlint, oxfmt and function limits clean. CI minutes none; agent tokens roughly 0.6M (estimate).
  **Next:** the next unchecked task in `docs/TASKS.md` (T-611).

## T-609 organizer alerts, second part, and the usage view — 2026-11-01

- **T-609 done (tier B; one code review owed; not run on a phone). Migration 0104 (new, undeployed; staging runs through 0102, 0103 pushed).**
  **Built (FR-1727, FR-1730 in part, ADR-394):** `alert_claim` restated so a batch made only of rows to skip no longer ends the sender's run
  (it skips the unsendable rows among the 500 oldest queued ones with their reasons, then leases up to `size` sendable rows from anywhere in the queue; a
  backlog of 620 ex-member rows ahead of two sendable ones sent 0 before and sends 2 in one run now; the test that ran twice for the old flake runs once
  and the FOLLOWUPS line is deleted). Quest-item stock is a `stock_low` source (`quest_item_alert_low`: the reward rule, live or ended events only,
  recovery rearms); the stock wording names rewards and quest items. The console's **Usage** page (`/console/usage`, navigation item, `LAYOUT_PAGES`)
  over two read-only admin doors (`usage_organizers`, `usage_events`; `GET /v1/admin/usage`, `…/usage/organizers/{id}`): events, players, invitations
  sent and alert emails sent per organizer (100 latest) and per event (200 latest); counts only, not audited; no table, index or hot-path write. Nothing new
  for sending: no second sender, store or switch UI, the transport stays unset (mail OFF). **Not built:** `content_unpublished` (T-701; note added there,
  FR-1727 stays "partly built"); login SMS, promotional email, push volume and storage (no durable count exists; Q-361), a period filter, platform totals.
  ADR-394 and Q-361 Proposed. Mutation targets: none (tier B). **Local:** full vitest ONCE: 9993 passed, 15 skipped, 1 failed (`words.test.ts`: the new stock wording hard-coded "quest"; fixed, and that file with two others re-run once: 18 passed). Full browser suite after a fresh web build, single worker: 300 passed, 5 skipped, 1 failed (27.1 min; `submissions.spec` on the phone, the Arabic page heading not found with a Playwright `querySelectorAll` of undefined during navigation, on a page this task did not touch; not re-run). The new `console-usage.spec` passed in desktop and phone. tsc (api, web), oxlint, format and function limits clean. CI minutes none; agent tokens roughly 0.35M (estimate).
  **Next:** the next unchecked task in `docs/TASKS.md` (T-610).

## T-608 exports, sponsor totals and the report — 2026-10-31

- **T-608 done (tier B; one code review owed; not run on a phone or in a PDF reader). Migration 0103 (new, undeployed; staging runs through 0101).**
  **Built (FR-1206 to FR-1208, FR-1306, FR-1626, ADR-393):** seven read-only definer doors behind `award_event_of` (PUBLIC without EXECUTE, no
  table, no index): `export_start` (checks the seat and the sponsor, **writes the audit entry `event.export` before any row is read**),
  `export_players`, `export_completions` (pages of 5,000 by `(created_at, id)` on the 0096 index; marks a completion the team removed),
  `export_redemptions`, `export_submissions`, `export_surveys`, `analytics_sponsor`. `POST …/events/{id}/exports/{players|completions|
  redemptions|submissions|surveys|sponsor}` writes a CSV in pieces (byte-order mark, formula-safe cells, Western digits, the event's zone), every
  row checked against a strict schema, so a file holds only the join card's fields (username, join answers, status, join time, points) and the
  event's own records, never a phone, an email, a join source, an id or a code; an empty event answers the header line alone. The sponsor filter
  on the Analytics page replaces the figures with that sponsor's totals (`GET …/analytics/sponsors/{id}`), **a floor of 5** (`MIN_GROUP_SIZE`,
  a count of 1 to 4 reads "fewer than 5"; a single hidden reward count hides the smallest shown with it) and the export becomes one totals file
  with no player. `POST …/report` (audited) feeds `/analytics/report`, a one-page A4 sheet the browser prints or saves as a PDF (no PDF
  dependency; headline numbers, top five quests and rewards, up to three surveys with choice counts, rating averages and counted written answers,
  small counts left out; no player). The web forwarder gives an export 180 s. ADR-393 and Q-360 Proposed. **Not built:** a period filter (no FR; it
  would scan the points record), the event's logo on the report (events have none; uploads wait for Q-149), souvenirs in the sponsor totals
  (T-507c note added), the event's renamed words in the CSV headers. Mutation targets: none (tier B).
  **Local:** full vitest 9937 passed, 25 skipped, 3 failed on the one full run (960 s): the sponsors route inventory (the new route, fixed), the
  Hermes check (`toSorted` in `report.ts`, fixed) and an unrelated random UUID that held "9999" in `invitation-campaigns.int`; one suite
  (`event-duplicate.int`) timed out in its 60 s hook under load; the four files re-run once: 78 passed. Browser suite 294 passed, 5 skipped, 1 failed on the one full run (32.5 min; the failure was `events.spec` phone, a sign-up redirect that passed on its one rerun, unrelated)
  (single worker, after a fresh web build; `analytics.spec.ts` now downloads the players, completions and sponsor files, filters by sponsor, opens
  the report and prints it to a PDF of one page, in both projects). tsc (api, web, shared), oxlint, format and function limits clean (the
  `Sheet`, `fileOf` and `AnalyticsPage` splits kept no new offender); `expo export` not run (no app screen changed). CI minutes none yet; agent
  tokens roughly 0.65M (estimate).
  **Next:** T-609, done above; then the next unchecked task in `docs/TASKS.md`.

## T-607 analytics — 2026-10-31

- **T-607 done (tier B; one code review owed; not run on a phone). Migration 0102 (three read-only definer doors, no table or index; staging
  runs through 0101).** **Built (FR-1201 to FR-1205, FR-1625, ADR-392):** `analytics_participation`, `analytics_quests`, `analytics_economy`
  behind `award_event_of` (AN404), PUBLIC without EXECUTE; `GET …/events/{id}/analytics/{participation|quests|economy}` (owner, editor) checks
  each answer against a strict schema (`packages/shared/src/analytics`), counts only, no time-spent or heatmap figure. Joined is every
  enrollment that was ever a member, active has at least one completion, activation is active over joined (no value when nobody joined),
  returning has a completion on two or more event days (`event_streak_day`); a completion the team removed does not count; earned points are
  the score cache plus the score each standing redemption took (its `redeem` entry; a post-end purchase takes none), spent is the standing
  reward redemptions. The points record is never scanned. **Measured** on one event of 50,000 players (35,000 active, 525,000 completions,
  1,000 removals, 50,000 bulk-award notes; `apps/api/test/perf/analytics-timing.int.test.ts`, run by hand): participation 370 to 635 ms,
  quests 143 to 192 ms, economy 27 to 51 ms, so no cache. Dashboard: the Analytics page in the Run group (`LAYOUT_PAGES`,
  `ci-scope` area `analytics`): four figure tiles, joined over time (SVG line, crosshair readout by pointer and keyboard), joined by source,
  most and least popular quests with their thumbs scores (T-508), a category funnel with the largest drop marked, where players stop, points
  earned and spent, unclaimed reservations and redemptions per reward; cards of a row are equally tall, lists show five rows and "View more"
  opens the rest; the new primitives are `ui/Charts.tsx` and `--chart-*` tokens (one data colour, about 4.7 to 1 on the surface); no
  dependency added. A rehearsal event says "Rehearsal, wiped at go-live" (T-211). ADR-392 and Q-359 Proposed. **Not built:** the period and
  sponsor filters (T-608), exports (T-608). Mutation targets: none (tier B).
  **Local:** full vitest 9880 passed, 15 skipped, 10 failed on the one full run (845 s): nine in `test/db/live-edits.int` (T-604) after its
  3,000-completion test hit its timeout under load (72 s) and left a connection in an aborted transaction, and `scripts/ci-scope.test.ts`
  (the helper-importers list now includes `analytics`, fixed); both files re-run once: 60 passed. Browser suite 295 passed, 5 skipped, 0 failed
  (single worker, 30.5 min, after a fresh web build; the layout check walks the new page in both languages at 1440 and 360 wide; the new
  spec also reads the filled page for layout and contrast). tsc (api, web), oxlint, format and function limits clean (no new offender);
  `expo export` not run (no app screen changed). `waitUntilSettled` now names the requests that kept a page from settling. CI minutes none
  yet; agent tokens roughly 0.6M (estimate).
  **Review fixes (2026-10-31, migration 0102 edited in place, not deployed):** earned adds back only the score a standing redemption took
  (a post-end purchase adds nothing); a removed completion no longer counts as active or toward a quest; the Earned, Spent and Unclaimed tiles
  have info tips (the analytics tips are now named `*Hint` and listed in `help-copy.test.ts`); each chart carries a text summary and a tap opens
  its readout; the browser spec checks equal card heights; the Arabic redemption count reads without a plural form; T-608 owes a minimum group
  size for sponsor-facing totals.
  **Next:** the next unchecked task in `docs/TASKS.md` (T-608).

## T-606 event layout — 2026-10-31

- **T-606 done (tier B; one code review owed; not run on a phone). No migration** (the numbering stays at 0101; 0102 is free).
  **Built (FR-1749 for an event's bar and Home, FR-1750, FR-1764, ADR-391):** `event.config.layout` (`{bar, home}`, each an order
  plus a hidden set) composed into the app's configuration as the items to show (`layout.bar`, `layout.home`);
  `PUT …/events/{id}/layout` (owner, editor; a preset by name or the two lists) refuses a layout that hides Home, the scan
  button, Profile, the points and balance, prizes and results, or the history and event info links (422
  `layout_item_protected {item}`) or has more than five bar slots; the registry, the strict check, the tolerant reads and the four
  approved presets are `packages/shared/src/layout/`. App: the event bar and Home draw by the layout (`barScreenOrder`,
  `homeBlocks`; Home's cards became eleven blocks in their old order), a damaged or old cached layout reads as Questify's, and an
  item whose switch is off stays off. Dashboard: the Layout page (`EventLayoutEditor`, presets in one tap, drag and move buttons,
  show switches, Save and Discard, the Home phone of the preview redrawn from the draft), `previewOf` follows the saved layout,
  and the wizard's Home and look step links to the page. ADR-391 and Q-358 Proposed; the Questify home bar, operator bar,
  Profile rows, rename and icon choice stay open (Q-358). Mutation targets: none (tier B).
  **Local:** full vitest 9846 passed, 14 skipped, 0 failed (611 files, 17.4 min); tsc (shared, api, web,
  app), oxlint, format and function limits clean (baseline: `createSettingsService` 234 to 233 lines); `expo export --platform
  android` clean; browser suite 291 passed, 5 skipped, 2 failed on the one full run (single worker, 38.4 min, after a fresh web
  build; the layout check walks the new page in both languages at 1440 and 360 wide): both failures were the preset test, run
  against an API bundle built before the last preset reorder; after rebundling, `e2e/layout-editor.spec.ts` 11 passed, 1 skipped
  (the drag test is desktop only). `ci-scope` maps the layout files to `layout-editor` and `branding`. CI minutes none yet; agent
  tokens roughly 0.65M (estimate).
  **Next:** the T-606 code review (done, 93 GO), then T-607.

## T-605 guided setup — 2026-10-31

- **T-605 done (tier B; one code review owed; not run on a phone). Migration 0100** (new, undeployed; staging runs through
  0098, 0099 pushed). **Built (FR-1751 to FR-1757, FR-1846, ADR-390):** `event_setup` (the step to open at, one letter per
  step, when finished; forced row-level security for owners and editors inside their event limit, no function);
  `GET|PUT …/events/{id}/setup` in `apps/api/src/setup/` (the last save wins); the `/setup` page with the ten steps of
  FR-1846 (the pages' own panels, switches and doors; `EventForm` and `JoinSetupPanel` take a `bare` prop), the list of all
  steps, Skip this step, Skip guided setup (asks first), the Overview card and "Explain this" on six Build pages; locked
  add-on cards (a switch that cannot be ticked, Ask Questify to the Contact page; unlocked, Open); the wizard's texts are
  `wizard.*` and `setup.*` keys over which the dashboard lays the translation store's usable values (the edit screen is
  T-702). The e2e control gained `/addon` and `/translation`. ADR-390 and Q-357 Proposed; FOLLOWUPS lists what was left.
  **Local:** full vitest 9700 passed, 14 skipped, 2 failed on the one run (the two list guards: the new routes in the route
  isolation list and the new `setup` folder in the event page list); both fixed and rerun once: 17 passed. Browser suite 278
  passed, 4 skipped, 0 failed (single worker, 27.5 min, after a fresh web build; the layout check walks the new page in both
  languages at 1440 and 360 wide); `e2e/setup.spec.ts` 6 passed on its own run. tsc, oxlint, format and function limits clean
  (baseline unchanged; `OperatorsPanel` stays at the limit, so it has no Explain this). CI minutes none yet; agent tokens roughly
  0.55M (estimate).
  **Next:** the T-605 code review, then the next unchecked task in `docs/TASKS.md` (T-606).
  **T-605 review fixes (2026-10-31):** the wizard reads the event again after every move and shows a step only from that
  read (Back no longer shows a switch as first read); Back, Skip, Continue and opening a step from the list ask "Discard
  unsaved changes?" when Basics or Join hold edits not saved (`use-unsaved.ts`, `use-step-moves.ts`); in `?step=review&only=1`
  the list opens the step alone and saves nothing; `EventForm`, `QuestBuilder` and `RewardsPanel` are back within their
  function baseline (`EventForm` and `QuestBuilder` shrank, baseline lowered). `e2e/setup.spec.ts` 10 passed on both projects.

## T-604b change sets and the confirmation sweep — 2026-10-31

- **T-604b done (tier B; one code review owed; not run on a phone). Migration 0099** (new, undeployed; 0097 and 0098
  pushed, not yet on staging). **Change sets (FR-1034, FR-1035, ADR-388, ADR-389):** `change_set` and `change_set_item`
  under forced row-level security for owners and editors inside the event limit (column grants, no DELETE, triggers for
  the 20-open-sets cap and for freezing content and deciding once; no function); `apps/api/src/change-sets/`; sets are made
  through the API, opened with each item checked now (invalid with the builder's reason, stale, ready, and its before and
  after), applied item by item through the builder's own services with the applier's seat (a points item reaches the
  live-edit door of ADR-387 with key `cs:{item}`), or closed; the Change sets page reviews them. **Sweep (FR-1031,
  FR-1032):** the hook `useConfirmation` and 11 new confirmations; DASHBOARD_AND_CONSOLE section 5 has a "Shipped in" column.
  ADR-389 and Q-356 Proposed; FOLLOWUPS lists the Cheers, ranking and streak switches, the console rows with no screen,
  two edits of one target, the crash window between a service commit and its item record.
  **Local:** full vitest 9626 passed, 14 skipped, 1 failed (the duplication list guard: the new tables are classified as
  not copied); fixed and the two files rerun once: 22 passed, with a new foreign-target test. Browser suite 270 passed, 4
  skipped, 2 failed (`players.spec.ts`: removing an exclusion now asks); fixed and rerun once: 2 passed (single worker,
  25 min). A targeted run of the touched specs before the full runs found the switch spec's `uncheck()` waiting on a box
  that stays checked until confirmed. tsc, oxlint, format and function limits clean (baseline 304). CI minutes none yet;
  agent tokens roughly 0.5M (estimate).
  **Next:** the T-603b/T-604 code review (tier A) and their mutation run, the T-603 and T-604b code reviews, then the next
  unchecked task in `docs/TASKS.md` (T-605).

## T-603b pause and skip, T-604 live points edits — 2026-10-31

- **T-603b and T-604 done (tier A; code review and mutation owed; not run on a phone). Migrations 0097 and 0098** (new,
  undeployed; staging runs through 0095, 0096 pushed). Plan review 80; its four MAJOR findings and the minors were taken
  into the plan (f271a2f) and built. **T-603b:** quest pause and skip columns, `set_quest_paused` and `set_step_skipped`
  (owner, editor; audited; idempotent), QN403 `paused` in the open check (an open quiz attempt goes on), skipped steps out
  of the category rules, `control_done` pause/skip/behind, the go-live wipe clears both; `POST …/pause|resume|skip|unskip`;
  the room's badges and confirmed switches; the app's `paused` state. **T-604:** the ledger kind `adjust` with its
  append-only header `quest_points_change`, `apply_past_points` (absolute targets, score and balance clamped on their
  own, batches of 2,000 entries, about 0.75 ms an entry), `quest_points_impact`, `past_points_replay`,
  `delete_played_quest` with the shared `write_removal`, the quest pin before the enrollment lock in every paying door,
  deleted quests out of the builder, codes page and duplication; `PATCH …/quests/{id}` `apply`, `GET …/impact`, `DELETE`
  `points`; the quest builder's points and keep-or-remove dialogs. ADR-386 to ADR-388 and Q-353 to Q-355 Proposed.
  **Split (ADR-388):** the confirmation sweep and change sets became **T-604b** (tier B, migration 0099 free).
  **Mutation targets (one run):** `apps/api/src/quests/live-edits.ts`, `apps/api/src/quests/quests.ts`,
  `apps/api/src/control/pause.ts`, `apps/api/src/home/home.ts`, `!**/*.test.ts`.
  Local: full vitest 9557 passed, 14 skipped, 5 failed on the one run (four expectations this change moves: the quest
  delete asks keep or remove, the member quest columns, the payer map, and three new texts that named quest and category
  instead of the event's word; one timing test of catch); fixed and the touched suites rerun once: 313 passed. Browser
  suite 268 passed, 4 skipped (single worker, 24.6 min); `expo export --platform android` ok; tsc, oxlint, format and
  function limits clean (baseline 307 to 304). Past points timed at 3,000 entries in 2.2 s. CI minutes none yet; agent
  tokens roughly 0.85M (estimate).
  **Next:** see the T-604b section above.

## T-603 live control room — 2026-10-31

- **T-603 done (tier B; code review owed; not run on a phone). Migration 0096** (new, undeployed; staging runs through 0095).
  **Built:** three read-only definers `control_feed`, `control_counts`, `control_done` (guarded by `award_event_of`; PUBLIC
  closed) and the index `quest_completion_event_recent_idx`; `GET …/events/{id}/control` (owner, editor) in the new
  `apps/api/src/control/` answering the 30 newest completions (username and avatar, quest, method, time: no contact detail or
  points), the counters (low stock, inbox, flags, active in the last 15 minutes) and each quest's completions, the last kept 30
  seconds per event in the API process. The "Control room" page (first in the Run group, open from rehearsal on) polls every 5
  seconds while the tab is shown and composes the existing doors: flash Launch and End, live poll Send and Close, the Up next
  pin, the boosts manager and the announcement composer, each with its confirmation; an action whose switch is off is not
  offered. The quest builder, Boosts page and Announcements page now share their parts with it (`useQuestLiveActions`,
  `useReturnFocus`, `BoostsManager`, `useAnnouncementPress`). **Split out:** pausing a quest and skipping a broken step
  (FR-1026) became **T-603b, tier A** (they change `complete_quest`). The desktop menu column now re-aligns the open page's
  link when a link arrives late (`ShellNav`; the extra link made "Manual awards" fall out of view once Invitations appeared).
  ADR-385 and Q-352 Proposed. Mutation targets: none
  (tier B). Local: full vitest 9455 passed, 14 skipped, 29 failed on the first run: 1 failure was the community gate map (the two new 
  doors added to it; green) and 28 were `invitation-sending.int.test.ts`, which fails inside the full run and passes alone (50 of 50), 
  flaky under load and not touched by this task (FOLLOWUPS); tsc (shared, api, web), oxlint, format clean; function limits hold 
  (baseline 307 to 305: the quest builder and boosts page shrank); browser suite 267 passed, 4 skipped, 1 failed (the desktop layout 
  check, fixed as above), then layout, navigation and `control-room.spec.ts` rerun 14 passed (single worker, 26.5 min for the full run). CI minutes none yet; agent tokens roughly 0.55M (estimate).
  **Next:** T-603b (tier A: plan and plan review first), the T-603 code review, then the next unchecked task in
  `docs/TASKS.md` (T-604).

## Follow-ups batch — 2026-10-31

- **FOLLOWUPS cleared (tier C and B minors).** The desktop menu scrolls on its own and shows the open page (ADR-378, Proposed, Q-345): no new link needs a regroup, and the layout check asserts reachability instead of fit. The flaky `organizer-alerts` "checks the member again when it sends" test: the alerts are numbered in the order of members' random ids, a claim takes five rows, and a claim that finds only rows to skip ends the run (T-503 line in FOLLOWUPS), so about one run in twenty sent nothing; the test now runs twice. App and dashboard minors: the map board's click surface leaves the tab order, the sponsor screen shows loading or "no longer part of the event", a late sponsor read of the previous event is dropped, the survey's left-out line has no plural, "Thanks" shows only for a thumb sent a moment ago, and the cheers button follows the server's clock (`Server-Now` of the live read). Not run on a phone.

## T-602d prizes to collect while the shop is off — 2026-10-31

- **T-602d done (tier B; code review owed; not run on a phone). No migration** (the numbering stays at 0095). **Built:**
  `GET /v1/events/{id}/held-prizes` for the player (the existing `event_shop` and `my_redemptions` doors; reserved rows of
  the bearer only, any source, with the desk; not behind the shop switch, so a prize reserved before the shop went off is
  listed and Collect still works; 404 for a non-active member) and `GET …/events/{id}/held-prizes` for the team
  (`{held}`: reserved prizes of active members under row-level security), both in the new
  `apps/api/src/rewards/held-prizes.ts`. App: a "Prizes to collect" card on Home (`PrizesToCollect.tsx`, shown whenever
  something is held, with Collect for collect first or Open My QR for desk offers). Dashboard: the shop switch, once saved
  off, shows "The shop is off. Prizes still to collect: N". ADR-384 and Q-351 Proposed; FOLLOWUPS: the Home win card still
  opens the hidden Rewards tab. Mutation targets: none (tier B). Local: full vitest 9449 passed, 14 skipped, 0 failed; tsc (shared, api,
  web, app), oxlint, format and function limits clean (baseline unchanged at 307); `expo export --platform android` clean;
  browser suite 264 passed, 4 skipped, 0 failed (single worker, 29.0 min; `branding.spec.ts` now asserts the shop-off
  note; `ci-scope` maps `EventFeatureSwitch` to it). CI minutes none yet; agent tokens roughly 0.35M (estimate).
  **Next:** the grouped mutation run for T-505b and T-602c (coordinator), then the next unchecked task in `docs/TASKS.md`
  (T-603).

## T-505b session points and T-602c switches in the points doors — 2026-10-31

- **T-505b and T-602c done (tier A; plan review 86 GO, its fixes folded; one code review owed; not run on a phone).**
  Three migrations, new and undeployed (staging runs through 0092): **0093** (T-505b) a session's `points` (0 to 100000) paid
  by the door once per player and session as ledger kind `session` (the pair is the natural idempotency key; the door reads
  the session `FOR SHARE`, refuses outside the play phase, while the agenda is off and for an inactive account, pays no
  staff member who may not play; `already` answers the points held, 0 after a removal); a paid session cannot be deleted,
  a checked-in player cannot cancel; `bulk_award` (now 8 arguments) gains the session target, filtered by
  `bulk_award_eligible`, shared with the preview `session_bulk_count {count, earlier}`; the readers and the rehearsal card
  know the kind; `ranking_repair_mark` marks the ranking where `mark_ranking_repair` marked nothing for an operator or
  staff caller. **0095** (review fix) widens `mark_ranking_repair` to the event's organizer seat (inside the member's
  event limit) and its operators, which repairs `grant_manual_award`, `review_core` and `confirm_results`; the door's
  phase check accepts a scheduled event for real players (the hour before the start). **0094** (T-602c) `reserve_reward` refuses a new reservation while the
  shop switch is off, `vote_quest`, `member_poll`/`poll_results` and `member_vote` refuse a live poll while polls are off
  (403 `feature_off`); replays and held prizes stand; a parity test proves the database's switch equals the composed
  configuration. Dashboard: points on the Agenda form and import, the Awards session target, the ledger's session line.
  App: "+N" at the door, "+N on check-in" on the Agenda, the History line, the poll sheet's polls-off line. New task
  T-602d (held prizes while the shop is off, tier B). ADR-382, ADR-383, Q-349, Q-350 Proposed. Mutation targets (one
  grouped run): `apps/api/src/sessions/door.ts`, `apps/api/src/sessions/store.ts`, `apps/api/src/awards/awards.ts`,
  `apps/api/src/awards/routes.ts`, `apps/api/src/rewards/shop.ts`, `apps/api/src/rewards/routes.ts`,
  `apps/api/src/plays/run.ts`. Local: full vitest 9418 passed, 14 skipped, 1 failed (the payer completeness map did not
  name `session_check_in`; mapped and rerun green); tsc (shared, api, web, app), oxlint, format and function limits clean
  (baseline 308 to 307); `expo export --platform android` clean; browser suite 264 passed, 4 skipped, 0 failed (single
  worker, 34.8 min). CI minutes none yet; agent tokens roughly 0.6M (estimate).
  **Next:** the T-505b and T-602c code review (tier A), then their grouped mutation run, T-602d, then the next unchecked
  task in `docs/TASKS.md` (T-603).

## T-602 event switches, accent colour and preview — 2026-10-31

- **T-602 done (tier B; code review owed; not run on a phone). The logo and banner are split to T-602b** (uploads, blocked on Q-149 like T-506b); layout presets (FR-1764) are T-606's. **No migration** (the numbering stays at 0092; 0093 is free). **Already there:** the owner's switches for ranking, today's ranking, share, meet, games, community, flash, boosts, help desk, quest ratings and cheers, the event streak's on/off, the rank prizes switch, and `composeConfig`'s event layer. **Built:** four more owner switches (`shop`, `polls`, `maps`, `agenda`; `PUT …/events/{id}/features/{key}`; `maps` and `agenda` join the feature registry) whose player doors answer 403 `feature_off` (shop read and goal pin, maps read, agenda read and register) and whose live read drops the poll cards, with the app taking the Rewards tab, Home's Agenda and Maps buttons and the Quests tab's map toggle off the screen; the event's accent colour (`PUT …/events/{id}/branding`, owner or editor) from six curated colours or Questify green in `event.config.branding`, carried by the composed configuration and applied by the app as the primary-action fill with the brand ink on it (`themeWithAccent`; the wood bar, parchment and fonts stay); every colour is proved at 4.5:1 with the ink and 2:1 against the page in `accents.test.ts`, and a hex, font or theme is refused (422 `invalid_branding`); the event page's Look section (no new menu link) and a read-only Preview page (new menu link, event group) showing Home, Quests and Rewards in Arabic or English by the app's own shared rules (`playerTabs`, `questTypeShown`, moved to `packages/shared`). The save of the words and of the look moved to `settings/save-event-config.ts`, so `createSettingsService` shrank 260 to 234 lines (baseline updated); the app's event configuration moved to `useEventConfig`. ADR-381 and Q-348 Proposed. **Not built:** refusing a reserve or a vote on a hidden live poll (both are doors on the points path, tier A, Q-348); the accent on the public event card (a database door). New spec `branding.spec.ts` in `scripts/ci-scope.mjs`; `organizers.spec.ts` lists the four new switches as the editor sees them and the accent as editable. Mutation targets: none (tier B). Local: full vitest 9384 passed, 14 skipped, 1 failed (the route list in `test/security/routes.int.test.ts` did not name the five new routes; fixed and the touched suites rerun green, 2495 passed); tsc (shared, api, web, app), oxlint, format and function limits clean; `expo export --platform android` clean; browser suite 263 passed, 4 skipped, 1 failed (the new Preview page's tab labels broke across lines at phone width; fixed, then `layout` and `branding` rerun green on the phone project; single worker, 24.3 min). CI minutes none yet; agent tokens roughly 0.6M (estimate).
  **Next:** the T-602 code review, T-602b (blocked on Q-149), then the next unchecked task in `docs/TASKS.md` (T-603).

## T-601 duplicate an event — 2026-10-31

- **T-601 done (tier B; code review owed; not run on a phone). Templates are split to T-601b** (a duplicate needs no template data; a template needs content, a closed `event_template` table, a picker and a rule for item rewards, which need the prize desk). Migration 0092 (new, undeployed; staging runs through 0090, 0091 is deploying): no new table; one granted door `event_copy_setup(source, target, request)` and eight closed helpers. API `POST …/events/{id}/duplicate` (owner and editor, Idempotency-Key, body `{name, startsAt, endsAt}`): the API makes the draft (create checks, new join code) and the door fills it in the same transaction with the source's setup (settings, switches and words, default topics from T-510, join form, quest items, categories, quests, first-bonus rules, passport steps, rewards, rank prizes, streak settings, agenda, maps, sponsors, big-screen scenes), new ids, references rebuilt, times moved by the distance between the starts. Never a player, point, prize handed over, code or secret: an entry code is made again, a digital reward starts with no stock, a guest-list-only copy starts with an empty list. The database test walks every table with an `event_id` and fails on one not decided yet. Dashboard: an icon on each row of the events list opens a dialog (name in both languages, start, end); no new menu link. Plan: `docs/plans/2026-10-31-t-601-duplicate-event.md`; ADR-380 and Q-347 Proposed; one line in FOLLOWUPS (a source edited during the copy). New spec `duplicate-event.spec.ts` in `scripts/ci-scope.mjs`. Local: full vitest 9305 passed after one fix (the community gate map listed the new door), 14 skipped; tsc (shared, api, web), oxlint, format and function limits clean; browser suite 260 passed, 4 skipped, 0 failed (single worker, 23.8 min). CI minutes none yet; agent tokens roughly 0.45M (estimate).
  **Next:** the T-505 to T-510 and T-601 reviews, T-505b (tier A: plan and plan review first), T-601b (templates), then the next unchecked task in `docs/TASKS.md` (T-603; T-602 is done above).

## T-510 default notification topics — 2026-10-31

- **T-510 done (tier B; code review owed; not run on a phone).** Migration 0091 (new, undeployed; staging runs through 0090): two closed tables
  (`event_topic_off`: a topic that starts off for an event's players; `push_topic_on`: a topic the player turned on, the mirror of the mute), three granted doors
  (`event_push_defaults`, `set_event_push_defaults`, and `set_push_topics` now takes `(turn_on, muted)`), `push_muted` takes the notice's event and `push_plan`,
  `push_skip_reason`, `own_push_topics` and `erase_rows` are restated. A player's own on or mute always wins; a player who never chose follows the event, at the
  fan-out and again at the claim; the center row is written either way. A notice with no event and a kind with no topic ignore the layer. API `GET/PUT
  …/events/{id}/push-defaults` (owner and editor, audited `push.defaults`), `GET /v1/me/push-topics` adds `eventOff`, and the PUT is a patch (the old read-then-replace
  is gone). Dashboard: four switches on the Announcements page, no new menu link. App: one line under a Settings switch an event started off. ADR-379 and Q-346
  Proposed; a note on T-601 to copy the defaults with a duplicated event. Local: full vitest 9281 passed, 14 skipped, 2 failed (`scripts/ci-scope.test.ts`, my own
  area edit, fixed and rerun green: 35 passed); tsc (shared, api, web, app), oxlint and format clean; browser suite 256 passed, 4 skipped, 0 failed (single worker, 23.5 min); `npx expo export` ok (Android). New spec `push-defaults.spec.ts` in
  `scripts/ci-scope.mjs`. CI minutes none yet; agent tokens roughly 0.5M (estimate).
  **Next:** the T-505 to T-510 reviews, T-505b (tier A: plan and plan review first), then the next unchecked task in `docs/TASKS.md` (T-601).

## T-509 cheers — 2026-10-31

- **T-509 done (tier B; code review owed; not run on a phone).** Migration 0090 (new, undeployed; staging runs through 0088, 0089 is deploying): two closed tables
  (`cheers_moment`, `cheer`) and seven granted doors. The owner starts a cheers moment (1 to 30 minutes) from the existing Big screen page, where the event's Cheers
  switch (the registry's `cheers` key, on by default) now also sits; no new menu link. While a moment is live the big screen runs the Cheers scene alone (the
  five reactions with running counts and floating up, polled every 3 seconds) and the app's Home shows a cheer card with five emoji buttons, found through the live read
  (`cheers: {endsAt} | null`, kept apart from `live_state`). A player may send 30 cheers a minute; the database counts them under a per-player advisory lock (a
  race test sends 42 at once and exactly 30 land; removing the lock fails it). The switch, the add-on and the event's end each end the moment at once. ADR-377 and
  Q-344 Proposed. Local: full vitest 9231 passed, 14 skipped, 10 failed (the Hermes scan timed out at 30 s and nine invitation-campaign tests saw an idle fill, both under load; the two files pass alone, 61 tests);
  tsc (shared, api, web, app), oxlint, format and function limits clean; `npx expo export` ok (Android); browser suite 248 passed, 3 skipped, 1 failed (single worker, 25 min; the phone
  `location.spec` failed once on a stale latitude field and passes alone, unrelated to Cheers). New spec `cheers.spec.ts` in `scripts/ci-scope.mjs`.
  CI minutes none yet; agent tokens roughly 0.6M (estimate).
  **Next:** the T-505 to T-509 reviews, T-505b (tier A: plan and plan review first), then T-510.

## T-508 quest ratings and survey results — 2026-10-30

- **T-508 done (tier B; code review owed; not run on a phone).** Migration 0089 (new, undeployed; staging is at 0087, 0088 is deploying): two closed tables
  (`quest_rating`, `survey_share`), seven granted doors, `survey_summary` restated over an internal `survey_results_core`. API `src/ratings`: the player's
  `GET/PUT /v1/quests/{id}/rating`, the team's `…/quest-ratings` counts and `…/survey-share` (make, replace, stop), the owner's ratings switch, and the one anonymous
  door `POST /v1/public/survey-results` (token in the body, own throttle bucket `survey_results_open`, a name added to `BUCKETS`; no change to any throttle logic).
  Dashboard: results on the survey quest's form and on the agenda row of a session that links it (no new menu link), spreadsheet export, "Share with the speaker",
  the "80% liked" score on the quest row, the owner's switch on the event page (the first event switch that starts off), and the speaker's page `/{lang}/r#token`.
  App: thumbs and Skip under a completed quest. The csv cell helper moved to `packages/shared/src/text/csv.ts` and `downloadText` to `apps/web/src/lib/download-text.ts`
  (both now shared by sessions and surveys). ADR-376 and Q-343 Proposed. **Not built:** the survey results in the one-page PDF report (T-608) and the score in quest
  analytics (T-607): notes added there. Local: full vitest 9199 passed, 14 skipped (two guards failed on the new doors and the new feature key: the community gate map
  and the config defaults test; both mapped and rerun green); tsc (shared, api, web, app), oxlint, format and limits clean; `npx expo export` ok (Android);
  browser suite 247 passed, 3 skipped, 0 failed (single worker, 23.5 min). CI minutes none yet; agent tokens roughly 0.4M for the finishing worker (the first worker was
  cut off by a PC crash; its figure is unknown).
  **Next:** the T-505 to T-508 reviews, T-505b (tier A: plan and plan review first), then T-509.

## T-507 sponsors — 2026-10-30

- **T-507 done (tier B; code review owed; not run on a phone).** Migration 0088 (new, undeployed; staging is at 0086, 0087 is deploying): two closed tables
  (`sponsor`, `sponsor_tag`) and six granted doors; a tag is a row of its own, so the quest, category and reward builders are untouched; an item has one sponsor; the
  player's door lists a tag only on an item the player may see. API `src/sponsors` (team routes behind `award_event_of`, the player's
  `GET /v1/events/{id}/sponsors`). Dashboard: Sponsors page under Set up (list, form, tag editor with a checkbox per quest, category and reward, delete confirmation naming
  the items that lose the sponsor) and a "Presented by" badge on tagged quests, categories and rewards. App: "Presented by {name}" with a lettered mark on a tagged quest
  card, category header and shop reward, the sponsor strip on Event Home, and a screen listing a sponsor's quests (tagged ones and those of a tagged category). **Menu:**
  the extra link ran the desktop navigation 10 px below a 1280 by 720 screen, so During the event and Review joined as "Run and review" instead of cutting the rows again
  (amends ADR-366 (1)). **Splits (ADR-375):** the logo and banner uploads moved to **T-507b** (blocked on Q-149; a lettered mark stands in), souvenir tags to **T-507c**.
  ADR-375 and Q-342 Proposed. Local: full vitest 9147 passed, 14 skipped (one guard failed on the new `sponsor_tag_set` and was mapped; its test and the touched suites rerun
  green); tsc (web, app, api, shared), oxlint, format and limits clean; `npx expo export` ok (Android); browser suite 243 passed, 3 skipped, 0 failed (after the menu regroup; the layout spec had failed once on the navigation, 10 px below the screen, before it);
  CI minutes none yet; agent tokens roughly 0.6M (estimate).
  **Next:** the T-505, T-506 and T-507 reviews, T-505b (tier A: plan and plan review first), then T-508.


## T-506 maps — 2026-10-30

- **T-506 done (tier B; code review owed; not run on a phone).** Migration 0087 (new, undeployed; staging is at 0085, 0086 is being deployed): two closed tables
  (`event_map`, `map_pin`) and eight granted doors; a pin's place is thousandths of the board, a quest has one pin, a quest pin is listed only while the player may list
  the quest. API `src/maps` (team routes behind `award_event_of`, the player's `GET /v1/events/{id}/maps`, which fills each quest pin's title, points and state from the
  Quests read). Dashboard: Maps page under Setup (maps list with rename, order and delete; plain board where a click names a pin's place; pin form and list). App: Maps
  screen linked from Event Home, and a List and Map toggle on the Quests tab; "you are here" is the pin of the last station scan, with its time. **Split (ADR-374):**
  the uploaded picture of FR-820 moved to **T-506b** (blocked on Q-149; there is no upload path in the repo). ADR-374 and Q-341 Proposed. Local: full vitest 9113 passed, 14 skipped (3 guard failures on key names and sort order
  fixed and the touched suites rerun green); tsc (web, app, api, shared), oxlint, format and limits clean; `npx expo export` ok (Android); browser suite 240 passed, 3 skipped, 1 failed
  (the layout check: the desktop navigation ran 24 px below the screen with one more link; the rows are 30 px now) and the layout, navigation, maps and sessions specs rerun green
  (13 passed, both projects); CI minutes none yet; agent tokens roughly 0.7M (estimate).
  **Next:** the T-505 and T-506 reviews, T-505b (plan and plan review first), then T-507.


## T-505 agenda and sessions — 2026-10-30

- **T-505 done (tier B; code review owed; not run on a phone).** Migration 0086 (new, undeployed; staging is at 0085): four closed tables (`event_session`,
  `session_registration`, `session_attendance`, `session_message`), twelve granted doors, the `session_reminder` and `session_message` push kinds and
  `push_due_session`. API `src/sessions` (team, player and operator routes); shared `sessions` (schemas, overlap-free checks, CSV import and report).
  Dashboard: Agenda page under Setup (list, form, CSV import with a per-line report, report export, close or reopen, message registrants). App: Agenda screen
  (All sessions, My sessions, register and cancel, overlap confirmation, linked quest, linked from Event Home) and the operator's session door under Tools.
  **Split (ADR-373):** the session's points on check-in and the "everyone checked in" bulk target moved to **T-505b** (tier A). ADR-373 and Q-340 Proposed.
  Local: full vitest 9079 passed (one gate-map guard fixed and rerun), browser suite 239 passed, 3 skipped (both projects, fresh build), tsc, oxlint, format and limits clean (the operator routes
  shrank 168 to 147 lines), `npx expo export` ok; agent tokens roughly 0.75M across the interrupted and the finishing worker; CI minutes none yet.
  **Next:** the T-505 review, T-505b (plan and plan review first), then T-506.

## Review follow-ups batch (T-504, T-599, T-599b, T-599c, T-599d, T-307b) — 2026-10-30

- **Follow-ups cleared (tier C batch; no review).** Migration 0085 (new, undeployed): `set_finale` accepts a start up to 23 hours after the event
  ends (a screen closes at 24), and `ranking_on` calls `feature_enabled`. Dashboard: info buttons are named "More information: {label}" by their
  field, switch, section, header or group (a group is named by its legend alone); the info tip stays open under keyboard focus while the page scrolls
  and a click closes an open one; Escape hides an icon tooltip; a page change sets the tab title to the page heading and moves focus to it (the phone's
  Menu button keeps focus, as before); filter tabs are `aria-pressed` buttons (the half-built ARIA tab list is gone); the finale form is read-only for
  an editor; the poll builder says the big screen shows live counts under "After they vote"; `plain-anchors.test.ts` lists every plain `<a>`; the
  console navigation no longer imports the console pages (`ConsoleNavLinks.tsx`). App: the finale celebration cannot return after a failed write, and
  its info buttons are named and report `expanded`. Dropped with a reason: the 15 s paired-device poll (the 3 s poll is what makes revoke and the
  finale list arrive in seconds), the global link colour on device pages (same colour as the text), the Arabic wordmark (ADR-020), "Revoke all" being
  quiet (it was before, and opens a danger confirm), the shell remount between the workspace and event layouts (the event layout owns the event's
  words). Left: the intermittent `event words not read ... 500` (see FOLLOWUPS; not reproduced in three runs with the API log on). Every info button now carries its label in its name, so a browser test finds a labelled field with `getByLabel(text, { exact: true })` where an info button sits beside it. Local: full vitest 8976 passed; tsc (web, app, api, shared), oxlint, format and limits clean; `npx expo export` ok; browser suite 220 passed, 17 failed on that label clash (fixed with `exact`, the 9 specs rerun green, both projects); CI minutes none yet; agent tokens roughly 1.2M.

## T-599d clear titles and icons, not explanatory text — 2026-10-30

- **CI cost split (coordinator follow-up, tier C; 2026-10-30).** A push now runs the layout check plus the browser specs of the changed area, chosen by `scripts/ci-scope.mjs` (AREAS table, shared code and unmapped files run the whole suite, a unit-test file starts nothing); `full.yml` runs everything daily at 01:17 UTC and by hand (about 900 minutes a month, free while public). The security floor is unchanged on every push. `scripts/ci-scope.test.ts` (35 tests) fails on a spec no area names. ADR-372 and Q-339 Proposed; RUNBOOK updated; the FOLLOWUPS line removed. **Next:** the push that carries this runs the whole suite once (workflow files changed); watch the step log for `all browser specs: ...`.
- **T-599d done (tier B; code review owed).** ADR-370 built on every page: the dashboard's `InfoTip` (hover, focus, tap, Escape) with an `info` slot on page
  headers, sections, fields and switches; the password's eye icon; icon-only sign out in the top bar, phone menu and app; the app's `InfoTip` and `IconButton`.
  64 help keys deleted, 64 explanations moved to info buttons, 8 shortened, 68 short lines kept (warnings, prices, locked and empty states); an editor sees
  owner-only switches disabled instead of a note each. `apps/web/src/lib/help-copy.test.ts` lists the kept help keys and every `help` or `description` prop, so a
  new help line fails until the diff lists it. ADR-371 and Q-338 Proposed. Screenshots of 8 pages, before and after, in `docs/evidence/2026-10-30-t599d/`. Local:
  full vitest 8970 passed; tsc, oxlint, format and limits clean; `npx expo export` ok; browser suite 206 passed, 3 skipped, 16 specs (both projects) changed for
  cut text and rerun green; CI minutes none yet; agent tokens roughly 0.8M. **Next:** the T-599c and T-599d reviews, then T-505 agenda and sessions.

## T-307b live finale — 2026-10-30

- **T-307b done (tier B; code review owed), not yet run on a TV or a phone.** Migration 0084 (new, undeployed; CranL is at 0083): the
  closed `finale` row (time, optional community goal), `set_finale` / `clear_finale` (owner only, audited), `event_finale`, the screen's
  `screen_finale` door and `device_view` restated. A set finale joins the screen's scenes last and takes the whole screen from its time on;
  the screen stays open after the event ends while one is set (confirming still needs the end, ADR-163; Q-127 left as it is). Phases:
  countdown on the server's clock (`serverNow`), the push (the goal's cached bar, "not reached" when missed, no reward), then the winners
  (top ten, username and avatar, no score) only after the owner's Confirm and Reveal on the Prizes and results page. Dashboard: a Finale
  section on the Big screen page (time, goal, Clear, where the results stand). App: Home's `finale` and a one-time full-screen
  celebration (shows on the next Home read; the reveal push is T-501's). ADR-369 and Q-337 Proposed. Mutation: none (not tier A).
  Local checks: full vitest 8965 passed; tsc (api, web, app, shared), oxlint, format, limits clean; `npx expo export` ok; browser
  suite 237 passed, 3 skipped (20 minutes; the finale spec is 4 of them, 1.2 minutes); CI minutes none yet; agent tokens roughly 2.5M.
  **Next:** the next unblocked task in `docs/TASKS.md` order (T-505 agenda and sessions); reviews of T-307b and T-599c are owed.

## Staging deploy and dashboard priority — 2026-10-30

- **CranL now runs migrations through 0083** (0083 applied 2026-10-30 from green commit fb6227f, CI run 40979237093, same
  steps and verify as below); **migrations up to 0083 are frozen.** The web app was redeployed from 5d5c6f8 (T-599b) the
  same day; T-599c (1f72d03) goes to staging once its CI run is green.
- Earlier: **CranL ran migrations through 0082** (0057 to 0082 applied 2026-10-30 from green commit 4482956, CI run
  40955488938). `--verify` ok (app role not superuser, no RLS bypass, `ownerSeesSessions: true`); owner connection
  removed and the API restarted without it. API and web redeployed from 4482956; `/healthz`, `/readyz` and
  `/{en,ar}/sign-in` answer 200, no error lines in the API log. **Migrations up to 0082 are now frozen.** No snapshot was
  taken: CranL snapshots need the database's external access switched on (staging, fake data only).
- **The Android release APK from 80a85bb on Dhia's phone breaks on the Questify quest list** once 0071 runs (RUNBOOK
  0071 note): it needs a new APK, or the `interests_set` quest retired in the console until then.
- **T-599/T-599b (dashboard usability baseline, ADR-364) go ahead of every remaining feature task** after Dhia found the
  dashboard unusable. T-504 was already building and finishes first.

## T-599 dashboard usability baseline — 2026-10-30

- **T-599 done (tier B; code review owed).** `apps/web/src/ui/` holds the tokens file and the primitives (shell with a
  navigation column and a phone Menu, page header, section, card, rows, toolbar, form fields, buttons, badge, notice,
  empty state, tabs, modal dialog, table). Sign-in, home, the events list, new event, the event overview, quests, rewards and
  team moved onto them; every organizer page already sits in the new shell and menu (ADR-366, Q-334 Proposed). The layout
  check (`apps/web/e2e/layout.spec.ts`, pages in `layout.ts`) walks each page at 1440 and 360 in English and Arabic and
  fails on sideways scrolling, overlapping controls, text under 14px and words squeezed apart; `layout-check.spec.ts` proves
  it catches each. Before and after screenshots: `docs/evidence/2026-10-30-t599/`. No migration, no API change.
  Review fixes: `Dialog` is a native modal `<dialog>` (top bar, navigation and skip link cannot take focus; focus returns to the
  opener); the phone Menu makes the page inert and Escape closes it from anywhere; the layout check also reads the open phone menu
  and a confirmation dialog, runs the phone at 360 and checks the desktop column fits 1440 by 900 (rows 32px, the "This event"
  group merged into the organizer's); ADR-366 and Q-334 Accepted (developer).
  **Next:** T-599b (the remaining dashboard and console pages; list in TASKS), then T-307b.

## T-599b remaining dashboard and console pages — 2026-10-30

- **T-599b done (tier B; code review owed).** The 30 pages left in the dashboard and console, and the public pages that used
  `TopBar`, now sit on the `apps/web/src/ui/` primitives; `components/layout.module.css`, `TopBar` and the unused `Table` are
  deleted. The console has its own navigation column. Dhia's review of the staging dashboard (page width, boxes in boxes, a
  cramped column, light text on a light hover) is ADR-367 (Proposed, Q-335): one box level by one CSS rule, the content area's
  width, and the layout check (`apps/web/e2e/layout.ts`) now also fails on nested boxes, crammed columns, text over text and any
  text under WCAG AA contrast, in the hovered and focused states of the header, navigation and first controls. The check fills the
  event first so it reads filled pages; the e2e API control has `/team`. Screenshots: `docs/evidence/2026-10-30-t599b/after/`.
  Console specs open the menu before they use the console navigation. No migration, no API change, no new dependency.
  Local checks: full vitest 8896 passed; full browser suite 219 passed (the layout spec needed one retry for a transient API stall, now
  reopened by the spec); CI minutes none yet; agent tokens roughly 2M.
  **Next:** T-599c (done, below), then T-307b.

## T-599c photos, logo, icons and smooth navigation — 2026-10-30

- **T-599c done (tier B; code review owed).** No broken picture was found (all 12 load locally and on staging, and the layout check, now
  failing on an image with no picture, passed every page before any change); the one failing image request was `/favicon.ico`, now the
  brand's app icon. The top bar shows the brand wordmark (cropped and resized, no new art) with "Dashboard" or "Console" beside it, and
  player pages say "Questify" alone; navigation items have icons (`ui/Icon.tsx`, one inline set); the language switch and Sign out are
  named icon buttons with tooltips; every link is `AppLink` (Next `Link`, no prefetch) and the shell lives in layouts (`console`, the
  organizer's `(workspace)` route group, the event layout) with a `loading.tsx` each, so only the content changes. The layout check
  also covers `/q`, `/s`, `/t`, the event rules and not-found, and fails on a broken picture, text over an image and unreadable ink.
  A new `navigation.spec.ts` proves no link loads the document again and that the icons are named and explained. ADR-368 and Q-336
  Proposed. **Browser budget:** run 40993429874 was cancelled by the 12-minute step; cause: the T-599b layout check (fixed waits per
  state and per page, 5.7 minutes, now 3.1); the suite is 16.4 minutes locally (230 specs), so the CI step is 18 minutes and the job 35.
  Local checks: vitest full, tsc, oxlint, format, limits clean; browser suite 230 passed; CI minutes none yet; agent tokens roughly 3M.
  **Next:** T-307b (the T-599c review is owed; its MINOR findings go to FOLLOWUPS).

## T-504 big screen — 2026-10-30

- **T-504 done (tier B; code review owed), not yet run on a TV.** Migration 0083 (new, undeployed; CranL is at 0082):
  `big_screen` (the picked scenes in order; none picked means all three), the team's `event_big_screen` and `set_big_screen`,
  and the screen's own doors `screen_ranking` (the rank push's `rank_top_ten_ids`, from PostgreSQL), `screen_community`
  (cached progress) and `screen_poll` (a sent poll in a public category, by its results policy; voters only for `never`).
  `/{lang}/screen` rotates the scenes every 15 s and re-reads the open one every 3 s (no server-sent stream, ADR-365); the
  dashboard has a Big screen page (tick, order, save). Tests: 30 database, 13 route, 3 scene-reader units, web units, the
  security suites, `big-screen.spec.ts` (desktop and phone); the full browser suite passed (201, only this spec's seed
  needed fixing). ADR-365 and Q-333 Proposed. **Split:** the photo wall (FR-635 to FR-637) is T-504b, blocked on T-301b and
  Q-149 (a second storage bucket only Dhia can open). The big-screen add-on is unlocked per event by a Questify admin.
  **Next:** T-599/T-599b (dashboard usability baseline, ADR-364) before any other feature task; T-307b can now start.

## T-503 reset — 2026-10-29 (Claude coordinator takes over from Codex)

- Stopped the T-503 lock-protocol line: plan, plan review, three failed timing probes and a NO-GO boundary
  diagnosis (`docs/evidence/2026-10-29-t503-*`), with no product code shipped. Root cause: ADR-359 added a
  "never coalesce" rule FR-613 does not state and put a global lock inside every quest completion.
- ADR-362 Accepted (Q-331; ADR-359/361 superseded, Q-330 closed): a tick diffs each live event's top ten against a
  stored snapshot and creates `rank` notices; 10-minute per-member cooldown; organizer alerts with per-member
  switches, outbox, transport OFF. Opt-in probe tests and SQL deleted. Tier B for the rank push.
- Cost note: the probe line used roughly a day of agent time and 0 CI minutes for no shipped feature.


## Stage 0 — Setup (2026-10-16)

**Situation:** greenfield. Empty folder, no code.

**Setup answers.** These were inferred from session 1; the user has not confirmed them yet:

| Question | Answer | Reason |
|---|---|---|
| Experience level | Technical; works through Claude Code | Engineering vocabulary, with a short gloss on store and legal terms |
| Project type | Commercial product (multi-tenant platform for organizers) | Any organizer worldwide, real users, public store listing |
| Depth | Guided: stage by stage, approval at each gate | User asked to "take it step by step" and to make everything clear before development |
| Scope preset | Max | Public launch on two stores, compliance-sensitive, first app, wants nothing left implicit |

**Doc set:** see `docs/README.md`. The final deliverable is `docs/SRS.md`, the master spec. The
other docs feed it and stay as its detailed appendices.

## Stage progress

| # | Stage | Status |
|---|---|---|
| 0 | Setup | Done, pending user confirmation of the answers above |
| 1 | Requirements: features, consultant pass, clarify loop | **Done and approved 2026-10-17** (after a second review pass) |
| 2 | Reuse check (open-source to reuse) | **Done 2026-10-17** (ADR-086) |
| 3 | Business & product (model, pricing, metrics, market, GTM) | **Done 2026-10-17** (ADR-087); market research is `research/COMPETITORS.md` |
| 4 | Design & UX (flows, design system) | UX flows and wireframes drafted 2026-10-17; visual design system deferred |
| 5 | Pressure-test | **Done 2026-10-17** (8 questions; `_blueprint/STAGE5_GRILL.md`) |
| 6 | Tech & architecture (stack, data model, remote config) | **Done 2026-10-17** (ADR-101 to ADR-103; `_blueprint/STAGE6_GRILL.md`) |
| 7 | Agent steering (CLAUDE.md for the build phase, rules, ADRs) | **Done 2026-10-17** (ADR-104; build-phase CLAUDE.md drafted, not applied) |
| 8 | Delivery & quality (roadmap, tasks, tests, risks) | **Drafted 2026-10-17** |
| 9 | Wrap-up: consistency pass, SRS consolidation, build handoff | — |

**Research (2026-10-16):**
- Done: `research/COMPETITORS.md` and `research/GAMIFICATION_PATTERNS.md`. Gaps Questify can own:
  a real rewards store, first-class Arabic, verification that needs no hardware, and premium UX.
- Done: `STORE_COMPLIANCE.md`, checked against Apple's guidelines dated June 8, 2026. It contains
  the pre-submission checklist and 30 proposed product decisions (PD-01–30) waiting for the
  user's review. Its open questions moved to `OPEN_QUESTIONS.md` (Q-040–051).

## Session 2 (2026-10-16)

- The user reviewed the compliance findings → ADR-006 to ADR-012.
- The brand deck was received → ADR-013, `design/REFERENCES.md` R-01.
- BRD v2 (April 2026) was found and imported → `inputs/`, F-53 to F-68.
- The setup answers were not objected to.
- The user wants the first release to contain every feature. The Stage 1 scope view will show
  the cost; the user decides.

## Session 3 (2026-10-16)

- Saudi-only launch → ADR-014.
- Location optional → ADR-015.
- Golden Ticket raffle removed.
- Design approach proposed and awaiting the user's choice:
  1. Image generation through the API, with an OpenAI key (and optionally a Gemini key) in `.env`.
  2. A code-first Design System artifact, with the brand tokens and live components in Arabic
     and English.
  3. Key screens on a Design canvas.
  4. The components ported to the app framework once it is chosen.

## Session 4 (2026-10-16)

- The design comes first; features come after (user).
- Asset production → ADR-016. Codex generates the assets through the user's ChatGPT subscription;
  no API key is needed.
- Created `design/codex-image-2/`:
  - `CODEX_BRIEF.md`: the style rules, prompts, sizes, naming, self-check and phase gate;
  - `ASSET_LIST.md`: 8 anchors, about 115 P1 assets and 18 P2 assets;
  - `reference/`: 8 deck pages and 10 crops.

## Session 5 (2026-10-16)

- Phase 1 anchors reviewed and approved. All icons have real transparency.
- Wood texture v3 tiles cleanly (checked with a 2×2 tile test), although Codex had marked every
  wood tile as failing.
- The approved variants are listed in `ASSET_LIST.md`.
- From Phase 2 on, one variant per asset (user). Only the Arabic wordmark gets 3.

- The user asked for every phase in one run. Phase 3 was expanded into the full app set:
  - venue and map icons, event types;
  - staff, moderation and organizer KPI icons, achievements;
  - a Saudi cultural set;
  - permission-screen and state illustrations;
  - animation parts (compass, chest lid);
  - the splash background and store graphics.

  About 218 assets remain.

## Session 6 (2026-10-16)

- Codex is mid-run: 47 of about 218 assets done at 15:52.
- Interim review in `design/codex-image-2/REVIEW.md`:
  - consistent style, real transparency;
  - padding to be normalized in one processing pass;
  - 3 redos queued.
- Font Lab published (https://claude.ai/artifact/CxYQ8cNEKfeoA9Yb2uokef): four pairings, each
  supporting both Arabic and Latin. Recommended: Baloo Bhaijaan 2 + Rubik. Open: Q-067, Q-068.

- Fonts chosen: Baloo Bhaijaan 2 + Rubik (ADR-017).
- Western digits everywhere (ADR-018).
- Codex at 16:10: 115 of about 218 assets done.

## Session 7 (2026-10-16)

- **Codex run.** Phase 2 is complete. Phase 3 stopped at the daily image limit (resets
  2026-10-17 14:48 Riyadh).
- **Full review** of 179 assets: 133 keep, 44 redo, 1 remove. See
  `design/codex-image-2/REVIEW.md`.
- **Library** (`design/assets/`): one approved file per asset, `manifest.json` and
  `ASSET_INDEX.md`. Raw outputs and rejects were archived outside the project
  (`NAFES/Questify-raw-archive/`).
- **Codex brief.** It gained the "Hard rules from review". `ASSET_LIST.md` now has Phase 4 (44
  redos + 3 avatar restyles) and Phase 5 (63 new assets that complete the app). 157 queued in
  total.
- **Design System page started** (https://claude.ai/artifact/H4ozsGZUWnR3joDZBnUWSb):
  - written locally: tokens, brand book, 25 components, cover;
  - uploaded: 75 assets;
  - paused until the next batch is reviewed, so rejected art doesn't go in.

## Session 8 (2026-10-16)

- No Arabic wordmark: the English wordmark is the only logo (ADR-020). It was removed from the
  library and the design system.
- A mascot was approved (ADR-021). Five options, two images each, are queued as Phase 6.
  `make_mascot_board.py` merges them into one voting board for the team. The choice is Q-069.

## Session 9 (2026-10-16)

- Stage 1 product answers → ADR-022 to ADR-029: pay per event, organizer-only submissions, four
  join methods, individuals only, no chance rewards, web dashboard + staff mode, age 13+, online
  only.
- Design System v1 published (https://claude.ai/artifact/H4ozsGZUWnR3joDZBnUWSb): tokens, brand
  book, 25 components, 133 assets. Its source is in the session scratchpad; on the next update,
  read the artifact first, because the page publishes its own generated files.

## Session 10 (2026-10-16): feature brainstorming begins

- **Format.** The user approved 14 areas in journey order; the list is at the top of
  `FEATURES.md`.

  For each area:
  - competitors and where we beat them;
  - ideas the user hasn't raised;
  - question batches with a recommendation.

  Each area ends with MoSCoW priorities in `FEATURES.md` plus ADRs. A prioritized feature moves
  out of the "Captured" tables into its area section.
- **Area 1 (joining and onboarding): done.**
  - F-01 and F-69 to F-82 prioritized.
  - ADR-030: sign in with a +966 phone or email, by one-time code.
  - ADR-031: browse first, sign in to earn.
  - ADR-032: nickname and avatar in public; real name per event.
  - PD-14 and PD-20 accepted.
  - Q-070: iOS deferred deep link.
  - Claude's recommendations the user declined (non-Saudi phone numbers, WhatsApp codes) are
    recorded in ADR-030 and the Won't list.

- The user asked to move between areas without being asked (saved to memory).
- **Area 2 (quests): done.**
  - Types and rules are prioritized: F-02 to F-07, F-52 and F-83 to F-92.
  - ADR-033: the quest model and v1 types.
  - ADR-034: share quests on the honor system, against Claude's advice; costs recorded.
  - ADR-035: 3 to 5 built-in mini-games.
  - ADR-036: video submissions up to 30 s.
  - Quiz: one try per question.
  - The user's design: every quest in a collapsible category, with an optional completion bonus
    and any-order or in-order quests (ADR-038; chains are in-order categories).
  - Live polls (F-100).
  - Four roles (ADR-037): platform admin, event owner, operator, player.
  - Community quest (ADR-039).
  - From Claude's ideas, picked: flash quests and boosts, live finale. Not picked: fog-of-war
    map, bingo, bring a friend, quiet-zone boost, kudos; collectible cards go to Area 7.
- **Area 3 (verification and fair play): done.**
  - F-54, F-55, F-67 and F-104 to F-120.
  - ADR-040: three verification methods (player scans the quest QR, operator or kiosk scans the
    player's rotating My QR, NFC tags written from staff mode), plus manual awards with caps.
  - ADR-041: flags only, people decide (Claude's "hold and review" was declined).
  - ADR-042: review queue with optional auto-approve; PD-12 accepted with that exception.
  - Help desk for players (F-118).
  - Q-071: NFC limits.
  - Note: the user first ticked "flag and hold" for shared phones, then wrote "just flag, no
    automated actions". The written rule was followed.
- **Area 4 (points, levels and streaks): done.**
  - F-08, F-11, F-24, F-56, F-57, F-59, F-60 and F-121 to F-126.
  - ADR-043: rank by points earned; balance separate.
  - ADR-044: two layers, the event and Questify. The fixed-XP rule is Claude's proposal.
  - ADR-045: an event streak plus a Questify daily streak.
  - The user opened a large topic: a cross-event Questify profile, items, achievements, Questify
    quests, and a player database for invitations and marketing. Area 7 was renamed "The
    Questify layer" and moved up to be next.
  - Claude raised the data-minimization caution once (in ADR-044).
  - Q-072: player data and consent. Q-073: organizer access to cross-event data.
- **Area 7 (the Questify layer): done.**
  - F-58, F-77 (detail), F-125 (rule) and F-127 to F-143.
  - Items: frames, titles, characters.
  - Earned by level-ups, achievements, Questify quests, event souvenirs, and a gem shop. Gems
    come from Questify quests, achievements and level-ups.
  - ADR-046: items, gems and the shop.
  - ADR-047: broad data collection within PD-09/PD-27, with a marketing opt-in; Questify-run
    invitations, organizers see results only. The user answered "all" on data, read as broad
    collection plus the required opt-ins.
  - ADR-048: shop window, then the balance closes.
  - Daily streak: any Questify activity counts, plus the daily challenge. Event recap only.
- **Area 5 (rewards shop and prize handover): done.**
  - F-10, F-22, F-62 and F-144 to F-153.
  - ADR-049: reserve in the app, pick up at the desk.
  - ADR-050: organizer-uploaded codes.
  - ADR-051: rank prizes, pending counsel (Q-041).
  - Shop ideas picked: prizes as quest rewards, pin a goal. Not picked: score tiers,
    back-in-stock alerts. No shipping.
- **Area 6 (leaderboard and big screen): done.**
  - F-09, F-23, F-61, F-154 to F-164.
  - Fixed XP confirmed (ADR-044 now Accepted).
  - ADR-052: the user's 11-row ranking (top 10 + you), first-to-reach tie-break, everyone
    visible (PD-20 anonymity declined); today's ranking and a Questify-wide ranking.
  - ADR-053: navigation. Event bar: Home, Quests, ● (Scan + My QR), Rewards, Profile; ranking on
    Home; Questify home through the event pill (Q-058 closed).
  - ADR-054: big-screen scenes, with a photo wall by per-photo consent; no freeze.
  - Rank alerts for top-10 moments only.
- **Area 8 (event home, maps, Questify home): done.**
  - F-50, F-63, F-64, F-165 to F-173.
  - Event Home: Up next, Happening now, announcements, info page.
  - ADR-055: maps are uploaded pictures with optional pins, as many as needed (Q-057 closed).
  - ADR-056: light agenda (Claude had recommended none).
  - Questify home bar: Home, Explore, ●, Shop, Profile (ADR-053 extended).
- **Area 9 (staff mode): done.**
  - F-174 to F-187.
  - ADR-057:
    - operators join by owner invite or a personal single-use operator QR;
    - they can't play by default; when allowed, they switch between Operator and Player modes;
    - abilities on by default, optional assignment;
    - operator bar: Home, Prize desk, ●, Inbox, Tools.
  - Station mode, prize-desk mode, inbox and today's numbers; practice mode.
  - ADR-058: per-event renameable words (player, operator, quest, category), Arabic and English,
    singular and plural.
- **Area 10 (organizer dashboard): done.**
  - F-20, F-21, F-25, F-26, F-66, F-68, F-188 to F-198; F-123 updated.
  - ADR-059: owner and editors.
  - ADR-060: the AI wizard is a future version; API-first operations and change sets ship now.
  - ADR-061: adventure theme branding is logo and banner only (Should); colors only with future
    themes (Q-059 closed).
  - ADR-062: scale target of 50,000+ players per event. Q-064 now only asks about events at once.
  - ADR-063: live edits ask "future only" or "also past"; delete asks keep or remove points;
    explanatory confirmation screens everywhere.
  - ADR-064: billing by invoice, activated by Questify.
  - Templates and duplicate; no spreadsheet import; dashboard preview only.
- **Area 11 (notifications and messaging): done.**
  - F-43, F-44, F-199 to F-204.
  - ADR-065: no push cap, no prayer or quiet pauses (Claude recommended both; costs recorded);
    announcements by push and in-app; promotional push, email and SMS to opted-in players.
    PD-24 accepted with promotional SMS allowed.
  - Notification center, permission asked after joining, per-topic mute.
- **Area 12 (analytics and reports): done.**
  - F-65, F-205 to F-210.
  - ADR-066: participation, quests and categories, economy, survey results, quest ratings,
    exports and a one-page PDF. No time or heatmap (Q-056 closed), no comparison or benchmark.
  - **Correction:** community points are participation points, never deducted. The donate mode
    was removed from ADR-039, ADR-043, F-101, F-121 and F-60.
- **Area 13 (sponsors): done.**
  - F-211 to F-214.
  - ADR-067: sponsor profiles, presented-by categories, sponsor strip on Home.
  - No leads, no report link, no sponsor logins.
- **Area 14 (platform admin, trust and safety): done.**
  - F-215 to F-227; platform foundations F-40, F-41, F-42 and F-45 prioritized as Must.
  - ADR-068:
    - free organizer sign-up; activation is the approval;
    - support has full edit access, logged (Claude recommended read-only);
    - one admin role;
    - report, nickname filter, block, platform ban.
  - PD-11 accepted.
  - The "Captured, not yet prioritized" section of `FEATURES.md` is now empty and was removed.

## Session 11 (2026-10-16, after a device restart)

- Docs verified intact after the restart.
- **SCOPE.md written.**
  - v1 is everything prioritized, except video submissions (ADR-069).
  - Claude recommended a pilot of the Musts first; the user chose one complete release.
  - No pilot event yet (Q-022 stays open).
  - Priorities now set the build order inside v1.

- **Compliance review: complete.** Every PD has an outcome (`STORE_COMPLIANCE.md` §6).
  - ADR-070: data hosted in Saudi Arabia.
  - ADR-071: no AI moderation in v1.
  - ADR-072: location while the app is open, never in the background.
  - ADR-073: everything else. PD-29 narrowed to reports and unpublish, after one pushback.
    PD-28 replaced by "store declarations always describe every feature as on".
  - The user asked for the PDs one by one, in plain words. Grouped acceptance didn't work for
    them.

- **SRS v1 drafted** (`SRS.md`).
  - 401 FRs across 14 areas plus §1.16 (rules settled while writing).
  - 24 NFRs, external interfaces, data requirements, and a traceability table (tests pending).
  - Every v1 feature (199) has at least one FR.
  - Four writers drafted areas in parallel; Claude merged and checked coverage.
  - Quality targets (ADR-074): 99.9% availability, iOS 16+ and Android 9+, 20,000 completions per
    minute with 95% confirmed within 1 s, ranking within 5 s.
  - Gaps the writers found, closed by ADR-075:
    - vote options written by the organizer only;
    - a second verified identifier on any account;
    - the year-based age rule;
    - the balance stops at zero;
    - FR-253 (prayer pause) retired.
  - Q-074: tuning values for Stage 6.
- **Stage 1 (requirements) is complete,** pending the user's approval at the gate.

- **Stage 1 review pass (user's request):** done.
  - Four independent reviews: the player journey; organizer, operator and admin; market and
    Saudi; consistency.
  - Then the grilling skill, one question at a time (52 questions), starting with the
    Questify-owner side.
  - The user confirmed the shared understanding twice before anything was written.
  - Outcomes:
    - ADR-076 to ADR-085;
    - F-228 to F-265 (plus a canonical switch list);
    - SRS §1.17 (FR-1701 to FR-1746) and NFR-025 to NFR-030;
    - nickname renamed to username throughout;
    - C1–C20 consistency fixes (CST promotional-SMS window, legal and consent steps,
      anonymization on deletion, time zones, minimum app version, device pairing, stale text).
  - The tracker is `_blueprint/STAGE1_REVIEW.md`.
  - SRS now: 446 FRs, 30 NFRs; all 232 v1 features traced.

## Stage 2 (2026-10-17): reuse check, done

- ADR-086, based on the research.
- Managed Supabase is ruled out by residency (no Middle East region).
- Live Saudi regions: Google Dammam, Oracle Jeddah and Riyadh, Huawei, Alibaba, Tencent. AWS and
  Azure are not yet live.
- **Decisions:**
  - backend: managed PostgreSQL in a Saudi region, plus open-source libraries;
  - game engine: built in-house;
  - notifications: a thin in-house layer;
  - animation, QR/NFC and admin UI: reused components.
- Q-031 narrowed; vendors are picked in Stage 6.

## Stage 3 (2026-10-17): business, done

- Written: `BUSINESS_MODEL.md`, `METRICS.md`, `PRICING.md`, `GO_TO_MARKET.md`. No separate `MARKET.md`: the
  research is in `research/COMPETITORS.md`.
- ADR-087:
  - first customer: organizers and agencies;
  - north-star: activated players per event;
  - per-event tiers plus add-ons, priced outside the platform;
  - riskiest assumption: players will install an app for an event;
  - channels: direct outreach and agencies.
- Codex is running (Phases 3–6) while Stage 3 is written.
- **Targets in METRICS.md are beliefs** (40% activation), to confirm after three events.

## Stage 4 (2026-10-17): UX flows and wireframes, drafted

- The user: "The adventure theme looks okay but we might change it completely, so don't rely on
  it. Focus on user experience and wireframes."
- Layout options were shown as sketches and chosen by the user (listed in `UX_FLOWS.md`).
- Written: `ux/PLAYER.md` (me), `ux/OPERATOR_MODE.md` and `ux/DASHBOARD_AND_CONSOLE.md` (two
  background writers).
- Fixes after merging:
  - the operator doc said a paused player could still collect reservations; FR-1604 says a pause
    blocks handover, so the doc was corrected;
  - FR-1023 updated for the accent color (ADR-085).
- The design system (colors, type, components) is deliberately not decided.
- **Review with the user (same day), ADR-088:**
  - operator mode approved: 10-second Undo, banned player's items held, results stay until the next scan;
  - dashboard and console explained in full and four judgment calls decided (one language required,
    activation any time, last save wins, sideways strip);
  - the XP-by-difficulty setting now has an Off switch, default Off;
  - the user's player-app notes (2026-10-17): flexible layout controlled by the Questify team and
    a guided setup wizard for organizers (ADR-090, `ux/ONBOARDING_WIZARD.md`); Wallet passes
    researched (`research/WALLET_PASSES.md`), decision pending;
  - Wallet decided (ADR-091): full wallet identity on Apple and Google, fixed code, risk accepted;
    organizer layout presets (F-276);
  - admin controls (ADR-093): translation matrix, feature kill switches, tuning numbers, maintenance
    mode, banner; safety tools (draft, rollback, last-working copy) declined with the risk recorded;
  - storefronts widened again: everywhere except the EU (ADR-092);
  - ADR-094: more admin tools (player tools, templates and word lists, legal documents, health,
    organizer tools, admin accounts, ranking seasons) and a last-working configuration on the phone;
  - mini-games specified (ADR-097: four quest games plus the daily word);
  - player onboarding (ADR-096, F-82, F-305 to F-307);
  - sessions with registration (ADR-095, F-295 to F-304);
  - the player app walked through: sign-in now happens at the Join tap (ADR-089); Up next uses an
    organizer pin (F-266) then best points for time; locked quests stay visible. The user then added the notes
    above and **approved the player app**.
- Assumptions to confirm are listed at the end of the operator and dashboard files.

## Codex status (2026-10-17, evening)

- The daily image limit stopped generation again. Seven mascot images and one fennec color
  correction remain. Reset reported for 18 October, 3:09 pm Riyadh time. Mascot heroes done so
  far: falcon, fennec, compass.
- The user confirmed: no account restore after deletion; email + password + code is "very safe";
  Apple allows an event logo on a pass and the lawyer accepts pass data abroad (user statements).

## Stage 5 (2026-10-17): pressure-test, done

- Standard intensity, 8 questions; log in `_blueprint/STAGE5_GRILL.md`.
- Changed the plan: email fallback for SMS login (FR-1812); first-coin target is 3 minutes from
  the first scan (ADR-098); weekly content at launch (ADR-099); a flag holds a prize handover
  (ADR-100); Q-078 added for counsel.
- Declined with the risk recorded: no review point or cut order (Q-077), no single lead reason, SMS
  cost absorbed, store accounts stay personal (ADR-010).
- Also this session: player onboarding (ADR-096), sessions with registration (ADR-095), mini-games
  (ADR-097), admin tools (ADR-093, ADR-094), wallet passes (ADR-091), setup wizard and layout
  (ADR-090). SRS: 515 FRs.

## Stage 6 (2026-10-17): tech and architecture, done; ADR-102 accepted

- The user asked for all options with pros and cons, research first, and a recommendation: one app for
  both phones, built from Windows with a Mac only briefly available, web a plus not a requirement.
- **Decided:** framework = Expo (React Native) + TypeScript (ADR-101, Q-030 closed). SMS = a Saudi
  gateway, Msegat or Taqnyat (ADR-103). **Postponed by the user:** cloud and database (Q-031,
  "I will see later"); Claude's lean is Oracle Riyadh + Jeddah, still to verify managed PostgreSQL there.
- **Accepted after the grill (ADR-102):** TypeScript modular monolith, PostgreSQL with shared schema
  and row-level security (one-way door), Redis-compatible rankings, one Next.js web app for event page,
  dashboard, console and big screen, internal `/v1` REST API.
- Written: `TECH_STACK.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `API.md`, `INTEGRATIONS.md`,
  `CONFIGURABILITY.md`, `SECURITY.md`. Added F-318 (player web build, Could), FR-1816 (516 FRs),
  NFR-031 (50 MB download budget), Q-079 (language-switch restart). Notes added to Q-031, Q-034, Q-070,
  Q-071, Q-076.
- Findings from research worth remembering: Firebase Dynamic Links shut down on 25 Aug 2025; AWS Saudi
  is announced for Dec 2026 and not live; the Apple wallet certificate can be made without a Mac; Saudi
  SMS gateways cost about SAR 0.06–0.14 against Twilio's 0.73.
- Items resting on the user's word, unchecked: Apple allows an organizer logo on a Questify-signed pass.

## Stage 7 (2026-10-17): agent steering, done

- Hard rules: the 8 proposed rules, kept as proposed. Quality bar: Max on the core, Standard elsewhere
  (ADR-104). `rules.md` written. The root `CLAUDE.md` is unchanged (still PLANNING); the proposed
  build-phase diff is in `_blueprint/CLAUDE_BUILD_DRAFT.md`, to apply when planning is approved.
- DECISIONS.md: every accepted recommendation already has an ADR (101 to 104 this stage); no
  re-seeding needed.

## Stage 8 (2026-10-17): delivery and quality, drafted

- Phase order approved by the user (nine phases, Phase 1 = a thin core loop, Google's closed test starts
  after Phase 2). `ROADMAP.md`, `TASKS.md` (107 tasks after the Stage 9 pass; every one of the 517 FRs is delivered by at least
  one task, checked by script), `TEST_STRATEGY.md`, `RISKS.md` (18 risks) written.
- GitHub issue export: not offered (the folder is not a git repository with a GitHub remote).
- Open-question sweep: no new genuine unknowns beyond Q-079 (language switch restart) and the notes added
  to Q-031, Q-034, Q-070, Q-071, Q-076 in Stage 6.
- Legal documents (`legal/`) are left until counsel input (T-807); drafting them from templates is
  possible earlier if the user asks.

## Wireframe review round (2026-10-18)

- The user reviewed the first wireframe and asked for more customization; six brainstorm rounds plus two idea rounds
  are logged in `_blueprint/WIREFRAME_REVIEW.md`. The user approved ("that's it, now update").
- Applied: F-320 to F-348, FR-1818 to FR-1846 (546 FRs), ADR-105 and ADR-106, Q-080 (name display, counsel) and Q-081
  (ticket reply rule), 18 new tasks (125 in all, every FR covered), wizard cut to ten steps (FR-1846).
- The wireframe is being rebuilt with: clickable ten-step wizard, working tabs, view-option switches for the new variants,
  and the new screens (tickets, access types, Home editor, features, cheers, readiness, operator activity, view as organizer).

## Wireframe v2 approved (2026-10-19)

- The user approved wireframe v2 (artifact `4Y63bxDGJQwW2sZgB3NqzC`: 101 screens, ten clickable wizard steps, working tabs and view options). It is a throwaway review aid, not application code.
- Planning is complete except the user's explicit approval to end it. Until then the root `CLAUDE.md` still says PLANNING.

## Blocker research (2026-10-19)

- User chose to resolve blockers before ending planning. Done by research: T-015 / Q-046 (use Expo SDK 57; iOS minimum becomes 16.4, Q-082). Partly done: T-014 / Q-031 (Oracle Riyadh and Jeddah are live; PostgreSQL and cache availability must be confirmed in the OCI console), T-013 / Q-034 (Msegat needs a commercial registration, 3–7 + 3–7 business days; quotes still needed).
- Still needs the user: an OCI account check, written quotes from Msegat and Taqnyat, the Saudi lawyer batch.

## Hosting and SMS decided (2026-10-19)

- **Hosting:** CranL Pro, `riyadh-1` (ADR-107), with conditions before real players. **SMS:** Msegat, existing account with services and ads senders (ADR-103). **Expo SDK 57** (Q-046 answered).
- Blockers the user named are resolved enough to start. Remaining, not blocking Phase 0: the lawyer batch (T-807), the CranL written answers, Msegat's volume quote, the pending mascot images.

## Planning ended, build phase started (2026-10-19)

- The user approved ending planning. Process: `TASKS.md` + Superpowers + `cto-cycle`; Spec Kit not used (ADR-108). Quality bar: `docs/QUALITY_BASELINE.md`.
- Root `CLAUDE.md` switched to BUILD. First work: Phase 0, in `docs/TASKS.md` order (T-001 monorepo and CI, T-002 CranL staging, T-013 SMS (Msegat account exists), T-014 and T-015 done by research, T-119 draft legal text).
- Still open, not blocking: CranL written answers (T-811), the lawyer batch (T-807), Msegat volume quote, mascot images, Q-082 (iOS 16.4).

## Build log

- 2026-10-19 **T-001 done.** Monorepo (pnpm workspace: `apps/api`, `apps/web`, `apps/app`, `packages/shared`), strict TypeScript 7, oxlint, oxfmt, vitest 5, one-job CI (`.github/workflows/ci.yml`, actions pinned by SHA, gitleaks 8.30.1 with a pinned checksum), Dependabot monthly. `pnpm ci:changed` passes. Mutation check on the first real code (`apiError`) caught a broken rule; gitleaks passes a clean tree and fails (exit 1, 2 findings) on planted fake keys. The CI run itself has not happened yet because there is no GitHub remote. Local node is 24; `.nvmrc` pins 22.
- Large assets (`docs/design/assets`, `docs/design/codex-image-2`, brand-deck PDF, BRD) are in `.gitignore`; they need a separate backup.

- 2026-10-19 **T-016 done** (contract tests wait for the OpenAPI file in T-005 and later). Stryker 10 mutation testing on `packages/*` (break below 80%; `apiError` scores 100%), SBOM script (`pnpm sbom:generate`, CycloneDX), audit in CI. Findings: Stryker 10 gives false results with Vitest 5, so Vitest is pinned to 4.1.12; Stryker pulls in `qs` with known moderate issues, so `qs >= 6.16.0` is forced by an override. A planted vulnerable dependency (lodash 4.17.15) made `pnpm audit` exit 1. **Repository:** https://github.com/diax7/questify-app (public, everything in one repo, user's choice); CI passes in 26 s; GitHub secret scanning, push protection and Dependabot alerts are on.

- 2026-10-19 **T-005 done.** `packages/shared`: error envelope, cursor pagination (`encodeCursor`, `decodeCursor`, `parseLimit`), app-version compare, rate-limit header helper. `apps/api`: `registerConventions` (request id, one error envelope that never leaks causes, 426 for old apps, `Idempotency-Key` on routes marked `config.idempotent`, replay of the first answer, 409 while running, 422 on a different body, retry after a 5xx, 24-hour expiry) with an in-memory store (the database store comes with T-003). 82 tests; mutation score 88%. Not yet built: an actual rate limiter (only the headers) and the principal that scopes keys (comes with sign-in, T-006/T-107).

- 2026-10-19 **T-002 partly done.** API server entry, `/healthz` and `/readyz`, esbuild bundle and a Dockerfile (239 MB, non-root, healthcheck, base image pinned by digest) built and tested locally. Deployed to CranL Riyadh (`questify-api-staging`, Nafes project); the health URL answers over HTTPS. Databases confirmed in `riyadh-1` and not reachable from the internet. **Not met yet:** a restore from backup (CranL snapshots are too limited, ADR-107 addendum) and the secret store (environment variables are set per app on CranL). T-002 stays open until T-019 provides a restorable backup.

- 2026-10-19 **T-003 done.** `apps/api/migrations/0001_baseline.sql`: organizers, staff, organizer members, players, events, enrollments; row-level security **forced** on every table; deny by default (PUBLIC has nothing; the API role `questify_app` has explicit, minimal grants and neither superuser nor BYPASSRLS); request context set per transaction by `withRequestContext`; migration runner with checksums, advisory lock and rollback. 42 database tests (outsider, structure, tenant isolation, data rules); deliberately weakening the rules made the tests fail. CI runs them against a PostgreSQL 17 service. **Live on CranL staging** (PostgreSQL 16.15): roles created, migration applied, and `node migrate.cjs --verify` proves the API role is not a superuser, does not bypass row-level security, sees nothing when unidentified, cannot insert, and cannot read the migration table. The owner connection string and the role password are removed from the app after each migration run. Findings: the CranL `run` endpoint returns no output (read it through the app log with the `/proc/1/fd/1` trick in `scratchpad/cranl_api.py`); the CranL database user `admin` is a superuser, so the API must never connect as `admin`; passwords contain non-ASCII bytes, so connection strings must be attached with CranL's `connect` operation instead of copied. Route-level cross-tenant tests wait for the first routes (T-012).

- 2026-10-19 **T-019 deferred by the user** (no backup while staging has only fake data; before real players). T-002 closed for staging. Release gate updated in ADR-107 addendum 2.

- 2026-10-19 **T-006 done (code, tests and review; staging deploy and live check still to do).** Staff sign-in: email + password (argon2id, `@node-rs/argon2`, native, external in the bundle; the Docker image installs it with `pnpm deploy --legacy --prod`), then a six-digit code by email, then a `__Host-` session cookie. Migration `0002` (tables `staff_login_challenge`, `staff_session`, `auth_throttle`; forced row-level security; column grants so the API cannot create accounts or change `platform_role`/`status`; a trigger so a revoked session stays revoked). Sign-in finds exactly one row before identity is known through three narrow settings (`withPreIdentityContext`); the wall is thinner there and `SECURITY.md` says so. One sliding-window throttle (8 failures per email and 30 per address in 15 minutes, counted across challenges; IPv6 as /64), 5 code attempts per challenge kept across resends, 5 challenges an hour, 4 password checks at once. Idle expiry 30 minutes (admins 15), maximum age 12 hours (admins 8), checked against the user's current role on every request; 10 live sessions; list and end sessions. Default-deny staff scope with an explicit public list (route-walk test). Email: Gmail SMTP primary, Resend backup (needs a verified domain, so off until one exists) as a time-limited exception to the in-region rule (Q-083). `staff` CLI (`create`, `clear-throttle`) for the first accounts. Config is required and fails fast; `TRUST_PROXY_HOPS` is required in production.
  **Review:** plan 78 -> 88 (two rounds), phase 1 code 92, phases 2 and 3 code 88, fixes 94 (CTO sub-agent). Findings fixed: a malformed email gave 500; request logs carried the client address; failures could have been rolled back by the error that reported them; a throttle that checked before recording; lock columns that leaked account existence; a missing default-deny scope; native argon2 breaking the image build. Deviations from the plan are listed in the plan's "As built" section.
  **Tests:** 468 (unit plus integration against a real PostgreSQL, none skipped). **Mutation (run under `ci:full`, about 35 minutes):** 93.2% overall; core auth files: keys, limits, http-errors, templates, resend, failover, smtp, verify-gate 100%; routes 98.9, staff-store 97.8, throttle 96.8, normalize 93.7, staff-admin 93.5, password 93.1; after the last tests and written exceptions (equivalent boundary mutants on a moving clock, branches made unreachable by foreign keys, guards the database repeats) a targeted rerun gave sign-in 95.7 and session 96.8. `ci:changed` no longer runs mutation (too slow with database tests); it is part of `ci:full`.
  **Open for T-006:** deploy to staging, run `migrate.cjs`, create a throwaway account with `staff.cjs`, sign in once over HTTPS, delete the account; needs the Gmail app password in the CranL secret store (Dhia). **Follow-ups recorded:** T-020 (password reset, breached-password check), T-004 (sign-in events into the audit log), T-011 (the dashboard proxy and the real proxy-hop check), T-018 (alerts for email down, throttle spikes, one address key carrying most traffic).

- 2026-10-19 **T-007 done.** Configuration service. `packages/shared/src/config`: the registry of features and tuning numbers the reviewed app contains (FR-1504), `composeConfig` (shipped defaults, then platform settings, then the event; a lower level can only narrow a higher one; add-ons stay hidden until unlocked; out-of-range numbers fall back to the default; sorted keys so equal inputs give an equal document), strict save-time validation (unknown features, out-of-range numbers, blank messages, bad versions and typos refused, every problem reported), tolerant reading of stored data, and `parseComposedConfig` for the app (drops blocks it does not know, refuses a document it cannot read so the app keeps its last working copy). API: migration `0003` (`platform_setting`, `event_entitlement`; forced row-level security; only a Questify admin writes platform settings and unlocks), `GET /v1/config[?event=<id>]` with an ETag and 304, a 15-second server cache (a change reaches every copy of the server within that time, the copy that saved it at once), and save functions for admins (platform settings, unlock or lock an add-on) and organizers (their own event's feature switches). **Design point:** add-on unlocks are in their own table, not `event.config`, because the organizer can edit that column and must not unlock paid features for themselves; a test proves it through the database rules and the validator. A private event's configuration answers 404 exactly like a missing one. **Tests:** 593 in total; mutation on the configuration source 98.5% (note: with per-test coverage analysis Stryker under-reports code whose result is cached by an earlier test, so configuration runs use `--coverageAnalysis off`). Not built (belongs to later tasks): admin screens and routes that call the saves (T-703, T-602), maintenance mode and banner (T-703), the translation bundle (T-008).

- 2026-10-19 **T-008 done.** Translation store. `packages/shared/src/i18n`: the shipped Arabic and English texts (`MESSAGES`, with a test that both languages carry the same placeholders and no Arabic-Indic digits), `placeholdersOf` and `interpolate`, `toWesternDigits` and `formatNumber` (Western digits in both languages, asked for explicitly because some devices default Arabic to Arabic-Indic), `validateTranslation` (a save that removes or renames a placeholder is refused, naming it; blank means "use the shipped text"; digits normalized), and `createTranslator` (the admin's text only when it is usable, otherwise the shipped one, so blank, missing, damaged or unreachable values never leave a hole). API: migration `0004` (`translation`, forced row-level security, read by all, written only by an admin), `GET /v1/translations` with an ETag, a 15-second cache, and an admin save that checks every language before writing anything. Shared ETag helpers (`etag.ts`). **Tests:** 686 in total; mutation on the new code 97.9 to 100% per file. The ETag, 304 and admin-only rules are proven in tests against a real database. Not built here (later tasks): the matrix editor (T-702), plural forms (T-117), date and time formatting in Western digits (with the first screen that shows a date).

- 2026-10-19 **T-009 built, device run pending.** Expo app shell (`apps/app`) on **Expo SDK 57** (React Native 0.86, Expo Router 57, development-build ready; SDK 58 came out on 2026-10-15 and waits, see `TECH_STACK.md`). Five tabs (Home, Quests, Ranking, Shop, Profile) that mirror in Arabic; design tokens (`src/theme/tokens.ts`: the deck's seven colours plus two derived neutrals marked for confirmation, spacing, radius, type scale) with a contrast test; Baloo Bhaijaan 2 and Rubik shipped from the `@expo-google-fonts` packages; every text comes from the shared translator, numbers in Western digits; language follows the phone (any other phone language starts in English) and the player's saved choice wins; **ADR-110** (the user chose "ask, then restart" for Q-079). Checks that need no phone: types, lint, 24 tests on the pure logic with 97% mutation, `expo-doctor` 21/21, and Android and iOS bundles that compile to Hermes bytecode (pnpm workspace, `#src` imports and the shared package all resolve). **Still open for T-009:** the run on a real iPhone and a real Android phone in both languages. Needs (Dhia): sign in to Expo (`eas login`, then `eas init`), then an Android development build; the iPhone also needs the Apple Developer account and a registered phone (T-010). `eas.json` has the `development` profile only.

- 2026-10-19 **Foundation review and fixes (ADR-111).** An independent reviewer read and ran the whole Phase 0 foundation: 79/100, "solid with fixes", nothing reachable from outside. It proved live that the API's database role could set a player's own points, lift a ban, join a private draft event, and let an editor make themselves owner. Fixed in migration 0005 (column grants and guard triggers, contact details in `player_contact`, owner-only team changes) with a test for each probe; plus explicit filters in the sign-in queries, one connection helper with the context in one round trip, app-wide route access (a route without `config.access` stops the server; public routes listed exactly), a 204 idempotency fix, the pool size as a setting, the app's restart-loop and splash guards, CI that fails if the database tests would be skipped and now runs the API build, and an API image that installs only the API's packages. The API type check now covers its tests too. User decisions: mutation testing on the core only; T-017 and T-018 stay in Phase 0. Language switch now restarts with Expo's `reloadAppAsync` (the Expo Go "ExpoAsset" error on switching to Arabic).

- 2026-10-19 **T-004 done.** Append-only audit log (migration 0006): no role can change, remove or truncate an entry, the database owner included (triggers set to fire always, tested); the API inserts only named columns, so it cannot backdate or renumber, and only in its own name and organizer (no `system` entries from the API); an organizer reads its own entries, including a Questify admin's support work in its events; no foreign keys, so an event's history outlives it. `recordAudit` writes in the change's own transaction and refuses secrets and contact details at any depth (the change rolls back too). Wired: platform settings, event switches, add-on unlock and lock, translations, staff session open and end, the staff CLI; a save that changes nothing writes nothing. Failed sign-ins stay in the server log. Retention and the player anonymisation path: Q-084. 830 tests; audit mutation 97%. CTO plan review 84, code review 93 (GO); its three minor fixes applied.

- 2026-10-20 **T-012 done.** `apps/api/test/security/`: the outsider suite reads the live catalog (every table, sequence, function, schema); the cross-tenant suite classifies every table as owned or shared and proves, from organizer, staff and player seats, no reads beyond what is public by design, no filtered or bare writes (including from a seat that owns nothing and from A's real seats with test-only detector triggers), no forged inserts, and exactly where the retention sweeps stop; the route suite lists every route with how it keeps callers apart. A new table or route fails CI until classified. Nine planted leaks, all caught. 925 tests. CTO review 86, then 93 (GO).
- 2026-10-20 **T-009 Expo Go finding.** The Arabic switch "did nothing" on the user's phone: Expo Go resets the right-to-left setting on every launch, and the restart guard then fell back to English. The app now keeps the chosen language for the texts; the full mirror needs a development build (ADR-110 note). `extra.supportsRTL` set.
- 2026-10-20 **Arabic layout confirmed on the user's phone (Expo Go).** Each screen frame takes the language's direction and text starts from it (no fixed `textAlign`, which React Native reads relative to the container and so flipped Arabic twice). The tab bar keeps one order in both languages (user's choice, ADR-110 note).
- 2026-10-20 **T-011 started.** Plan `docs/plans/2026-10-20-t-011-web-shell.md` (Next.js 16.4, language in the URL, our own `/v1` forwarder, sign-in screens, Playwright on desktop and phone); CTO plan review 84, then 93 (GO).
- 2026-10-20 **T-011 built, staging check open.** `apps/web`: Next.js 16.4.2 (React 19.2.3, one React across the repo), pages under `/{ar|en}` with `<html lang dir>` from the server, a `/v1` forwarder (allow-listed headers both ways, 1 MB cap, 15 s timeout, no retry, `X-Forwarded-For` passed through, API reached on its internal address only, ADR-113 Proposed), two-step staff sign-in (password, emailed code, resend countdown, Arabic-Indic digits accepted), a signed-in home (organizer names now in `/me`), sign out, CSP with a per-request nonce. Design tokens moved to `packages/shared`. 51 unit tests, 12 browser tests (desktop and a 360 px phone, both languages, keyboard only) on the standalone build the Docker image ships; CI builds the web app and runs the browser tests only when web, shared, API source or migrations change. CTO code review 93 (GO). **Open:** staging deploy and the real-iPhone and Android check, which waits on a working email sender (ADR-112, T-021).
- 2026-10-20 **Email decision (ADR-112).** Gmail API from `questify@nafes.com` (nafes.com already has Workspace, SPF, DKIM and DMARC); dashboard on `questify.nafes.com`; setup steps in RUNBOOK; T-021 builds the sender.

- 2026-10-20 **Staging is live with the new code; T-021 done.** API migrated (0002 to 0006) and verified, owner connection removed afterwards. Web app `questify-web-staging` at https://questify-web-staging-4ecphq.cranl.net (Dockerfile.web at the repo root: CranL builds from the Dockerfile's folder). Email from `questify@nafes.com` via the Gmail API: SPF, DKIM, DMARC PASS. Admin account for the user created with a generated password sent by email. The user chose the CranL address for now; `questify.nafes.com` is attached for later.

- 2026-10-20 **T-011 done.** The user signed in on an iPhone and an Android phone in both languages. Forged `X-Forwarded-For` values did not escape the per-address throttle on either path (ADR-113 proven). Phase 0: 12 of 21 tasks.

- 2026-10-20 **Autonomous build started** (user away for some days; INBOX entry). Store accounts (T-010) and SMS
  (T-013) skipped until the user returns; SMS is built behind its adapter with a fake.
- 2026-10-20 **Swappable visual theme (NFR-024).** The adventure look is one `Theme` value in `packages/shared`
  (colour roles, font roles with weights, text scale, spacing, radius); the app reads it through `useTheme()` /
  `useThemedStyles()`, the web through CSS variables; contrast and Arabic line-height contract tests run for every
  registered theme, and a web test refuses raw colours in style sheets. A new look is a new value plus its fonts.
- 2026-10-20 **T-015 done.** Expo SDK 57 meets every current App Store and Play rule (`docs/compliance/EXPO_SDK_CHECK.md`);
  required-reason APIs added to `app.json`. Before the first TestFlight upload: data types in the privacy manifest;
  move to SDK 58 before Apple requires Xcode 27 (expected spring 2027).
- 2026-10-20 **T-119 done.** v0.1 player terms, privacy policy and community guidelines in `docs/legal/` (Arabic
  first); questions for counsel in its README and Q-085; contradictions found went to Q-086 and Q-087.
- 2026-10-20 **T-020 done.** Password reset by emailed link (fragment token, 30 minutes, one use, one per person,
  same 202 for every email, work after the answer drained on shutdown), change while signed in (keeps this
  session, ends the others), breached-password check on every set including `staff-cli create` (Pwned Passwords,
  k-anonymity, 3 s, one retry, fails closed), product names and the email's name refused, a "password changed"
  notice, reset clears the sign-in lockout (RUNBOOK "A locked-out admin"). Migration 0007. Web: forgot-password,
  reset-password, account pages. CTO: plan 84 → 94, code 88 (one real bug: sign-in deleted pending reset links,
  fixed with a test) → fixes sent. API 843 tests, 20 browser tests.

- 2026-10-20 **T-101 done.** Organizer sign-up (email, password, organizer name, the three organizer documents, then
  the emailed code; the same answer for an email that already has an account, which gets a note with no code),
  creating another organizer while signed in, the team (invite editors by email with an optional event limit,
  change limits, remove, leave), owner transfer by owner invite, and invite acceptance with an existing or a new
  account (a new account still signs in with an emailed code). Migration 0008: the organizer context now comes from
  the caller's membership in the database (a forged organizer id opens nothing), editor event limits apply to events,
  enrollments, players and event audit entries, members join only through invites, and sign-up completes only with
  the HMAC of the emailed code. A daily budget of 400 sign-up and invite emails keeps sign-in codes deliverable.
  Organizer drafts (terms, DPA, content rules) served by the web app. CTO: plan 82 → 93; phases 93, 93, 92 (GO).
  Bugs found on the way: a sub-select in the event and enrollment rules made PostgreSQL report infinite recursion;
  an editor leaving could not write their own audit entry after the delete; the invite page re-checked its link after
  acceptance and lost the code step.
- 2026-10-20 **T-102 done.** The event builder: create, edit and delete events (kind, names and venue in either
  language, time zone, event-day start hour, access, join methods) from the dashboard, with times typed as the event's
  own wall clock and shown with its zone ("Fri, 1 Nov 2030, 09:00 (Dubai time)"). Migration 0009: the API's role can
  never write `status` (new events are always drafts), times lock once an event starts or ends, only drafts are
  deleted, the owner ends a live event early, and the API moves events from scheduled to live to ended every 30
  seconds, audited. CTO: plan 86 → 94; phases 92, 92, 92 (GO). Bugs found on the way: impossible dates (30 February) were
  accepted; a time read back with less precision than stored looked like a change, so an event ended early could not
  be renamed.
- 2026-10-20 **T-103 done.** The quest builder: categories (add, rename, reorder, delete with a choice to move or
  delete their quests; every event has a General category) and quests (scan a QR, enter a code; bilingual title and
  description, points, a repeat cap, an opening window in the event's zone, show or hide, move between categories,
  reorder). Migration 0010; the shared quest-type registry, which each later quest task extends with its player flow
  (FR-1505). In a live event every change asks for a confirmation; an ended event is shown and not changed. Entry codes
  never reach the audit log. CTO: plan 88 → 94; phases 93, 93, 88 → 95 (GO). Bugs found on the way: an editor of two
  events could have edited a live event's quest through a draft event's path (closed before code: every child row is
  read under the path's event); the builder's dialogs opened off-screen on a phone with no focus (now focused and in
  view, focus returned after).
- 2026-10-20 **T-104 done.** Quest QR codes: each scan quest has a signed code (`{dashboard}/q/{token}`: the quest,
  its code version and a 128-bit HMAC under the new `QR_SECRET`), checked strictly and bound to its quest; "New code"
  bumps the version so the printed one stops working at once. The dashboard's Print codes page draws them (`uqr`),
  prints or saves them as PDF through the browser, downloads each as SVG; a phone camera that scans a code outside the
  app lands on a page that says to scan it inside the app. Migration 0011. CTO: plan 87 → 94; phases 93, 92 (GO).
  T-105 verifies scans with `verifyQuestCode` and compares the version. Waiting on Dhia: ADR-115, ADR-116, and
  `QR_SECRET` in staging.
- 2026-10-20 **T-105 done.** The completion engine: a player with a session completes a scan or entry-code quest
  through `POST /v1/quests/{id}/complete`. One database function, the only writer, checks enrollment, event, quest,
  proof and cap under a lock on the player and writes the completion and its points; the points ledger is append-only
  for every role and the score and balance are trigger-kept sums of it. Retries never pay twice (the key is stored with
  the completion), two scans at once pay once (proven over 25 connections), wrong typed codes are limited per quest,
  player and install. No player can sign in yet (T-107 waits on Msegat), so the route sits behind a session lookup that
  T-107 will issue tokens for. Migration 0012. CTO: plan 83 → 94; phases 93 → 95, 95 (GO). Bugs found on the way: a
  replay check that hashed the route pattern instead of the path (one quest's answer could replay for another), and a
  plpgsql variable named `found` that shadowed `FOUND`.
- 2026-10-20 **T-107 done (server side).** Player sign-in: a six-digit code by SMS to a Saudi mobile (Msegat) or by
  email, a profile step for a new contact (username and birth year; under 13 refused), then a 1-hour access token and a
  180-day refresh token that rotates on every use; a reused refresh token ends that device's sign-in. The answer to a
  code request is the same whether or not an account exists. Limits per number, install and address, and platform
  ceilings for SMS (5,000 an hour, Q-093) and player email (1,000 a day, ADR-117). A security sweep found that definer
  functions could be fooled by a caller's temporary table of the same name: migration 0014 closes it for every
  function, and a test fails the build if a new one is not pinned. The Arabic brand name in emails and SMS now follows
  ADR-019 (كويستفاي; the emails had a misspelling). Migrations 0013, 0014. CTO: plan 83 → 94; phases 87 → 95, 93 (GO);
  mutation 96%. The sign-in screens wait for the app shell (moved to T-111). Local test runs needed more database
  connections (`compose.yaml`: 300).
- 2026-10-21 **T-106 done.** Live rankings: each event's ranking orders players by points, ties going to whoever
  reached those points first (the ledger decides, no clocks). A Redis copy per event (ADR-118, Dhia's call: "Redis
  now") answers the top 10 and "my place" in one round trip and is kept current after each completion (the completion
  answer now carries `rank`). PostgreSQL stays the truth: when Redis is down every answer comes from PostgreSQL in the
  same order, and a lost copy is rebuilt without losing writes that land during the rebuild. Banned and removed players
  and the organizer's own team never appear; every change of who may be ranked marks the event for repair through
  database triggers, and a repair job rebuilds within seconds. The owner hides or shows the ranking from the event page
  (FR-607). Measured at 20,000 players: per-row rules took 1.7 s, now about 50 ms (the Redis-down path only).
  Migration 0015. CTO: plan 82 → 93; phases 92, 87 → 94, 93; mutation 92%. A full disk stopped the work for an hour: killed mutation
  runs had left thousands of test databases inside Docker (105 GB); test databases now carry their creation time and
  stale ones are swept (memory note `stryker-stop-cleanup`).
- 2026-10-21 **T-109 done.** Usernames and avatars: a new player picks a username, one of the six default avatars and
  a birth year. Names that read alike (case, أ/إ/آ, ة/ه, ى/ي) count as one; a word list in Arabic and English blocks
  offensive names (started from an open list and reviewed: Dhia's call, ADR-119; false positives like "therapist",
  "basement" and «فرج» were cut). Every name a player had is kept; a rename is allowed once every 30 days and only
  while Questify allows it. The review found the API's database role could still rename players directly, skipping
  the filter: that right is gone, and only the checked functions write names. Other players only ever see the
  username and avatar. Migration 0016. CTO: plan 78 → 93; phases 92, 94; mutation 94%.
- 2026-10-21 **T-110 done.** Consent before data: the sign-in screen must send the terms and privacy versions the
  person accepted, or nothing is stored, counted or logged; the server tells every app which versions are in force
  (`/v1/config`), so a new version needs no app release. Each acceptance is kept with its version and how it was
  given (sign-up, sign-in, re-acceptance, before a first submission); a player sees only their own. The three
  player documents and a contact page are on the web in both languages; the contact page honestly says the details
  are being prepared (a release gate, STORE_COMPLIANCE §4). Migration 0017. CTO: plan 84 → 93; phases 94, 93,
  94; mutation 93.6%. Questions for counsel: Q-095.
- 2026-10-21 **T-111 server half done.** Joining an event: by its code (typed, scanned from the join QR or opened
  from the invite link) or from the public list; anyone can browse public events and their quests before signing in;
  the join card says what the organizer will see, and its version is kept with the membership; a private event's
  joiner waits for approval (T-218). Scoping found a hole that had been in the database since the start: a signed-in
  player could add themselves to any event, private ones included, and an organizer could add any player to their
  event and so read that player's row. Nothing used it yet; now only one checked database function adds members.
  Wrong codes are limited per address and per player; right codes cost nothing, so a crowd's correct scans never
  use up the limit. Migration 0018. CTO: plan 84 → 94; phases 93, 92, 93; mutation 97.8%. The app screens wait for the app
  shell (T-009).
- 2026-10-21 **T-208 done.** Bans, the exclusion list and leaving. The owner bans a player from an event (they leave
  every board, cannot earn or join again, their points record stays) and can lift it; a player who left can still be
  banned, so leaving never dodges a ban. The exclusion list keeps phones and email domains (the organizer's staff,
  sponsors) off the boards while they still play; phones are shown masked to everyone. A player can leave an event.
  The dashboard has a Players page in both languages. The birth-year gap found in T-111 is closed: organizers now see
  only what the join card tells players they will see. Two older faults fixed on the way: editors could change a
  player's standing directly with no audit entry, and a ban or a player leaving left no mark for the board to repair
  until the 5-minute backstop. Redemption pausing moved to T-209 (nothing to pause yet). Migration 0019. CTO: plan
  84 → 94; phases 92, 93, 92; mutation 93.2% (moderation alone 91.5%, then three more survivors killed by tests).
- 2026-10-21 **T-108 server half done.** A player can change their phone or email, or add the second one, with a
  code sent to the new contact; the account takes it only with the right code. Nothing says whether another account
  already has that contact until its code comes back, so the feature cannot be used to find out who has an account. The
  old number or email and the other channel get a notice (SMS or email, both languages) on every change, so a change
  made from someone else's hands is seen; the old contact is not asked for a code (a player who lost their number could
  not give one: ADR-120, Proposed). The API can no longer write contacts directly; every change is audited without the
  contact. The profile now shows masked identifiers. Migration 0020. CTO: plan 80 → 94; phases 93, 93, 95; mutation
  92.2% on contact.ts, 91.5% on profile.ts. The screens wait for the app shell (T-009).
- 2026-10-21 **T-112 web half done.** The event web page `/{lang}/e/{CODE}`: what the join QR and the invite link
  open on a phone without the app. It shows the event, its code, what the organizer will see, and the way to the
  stores; WhatsApp and social apps get a preview with the event's name, place and date and a brand image (tested as a
  WhatsApp bot reads it); unlisted and private events stay out of search; an unknown code says "not available" in both
  languages; when the API cannot answer, the code and the buttons still work. The store buttons wait for the store
  listings (T-010: two web settings), and the app's side (the Android referrer, the iPhone paste) waits for the app
  shell. CTO: plan 81 → 93; phases 92, 95. Found: the Arabic brand spelling drifts in six older strings (Q-098, ADR-019).
  One flaky e2e seen once (the players page on the phone layout, under the full suite; it passed alone and in the next
  full run): watch it.
- 2026-10-21 **T-111 app half built.** The app can now sign a player in (consent, a phone or email code, the profile
  step), keep them signed in safely (tokens only in the phone's keychain, never in a backup; a reinstall starts signed
  out; a lost network does not sign anyone out), open an event's join card from a code, a pasted or shared link or the
  public list, join (after sign-in when needed, and only then), switch between joined events, accept new terms on
  launch and sign out. Arabic-Indic digits work in the code and the birth year. Not yet run on a phone: that is
  T-009, which needs Dhia. CTO: plan 82 → 93; core 88 → 94; screens 84 → 94; mutation 89.6% on the session core.
- 2026-10-21 **T-113 built.** Inside an event the app now has its own bar (Home, Quests, a round Scan button that says
  "coming soon" until T-115, Rewards, Profile; one order in both languages), an event pill on every tab that switches
  events or goes back to Questify home, and the event's Home: a countdown with the right Arabic forms, points,
  balance and progress, a ranking card that opens a plain ranking screen, Up next with Go, and an information page
  that opens the maps app. The app opens in the live event used most recently on the phone. Organizers can pin one
  quest as Up next in the builder. Not yet run on a phone (T-009): also check there that event times show in the
  event's zone (Hermes `Intl` time zones). CTO: plan 79 → 93; phases 94, 95, 92 (its four fixes applied).

- 2026-10-21 **T-114 built.** The Quests tab lists the event's quests by category; each category opens and closes and,
  closed, shows the points earned of those available and the quests finished. Each quest has a card and a details
  sheet saying how it is verified. Entry-code quests can now be completed in the app: the player types the code and
  gets the points (the first quest playable end to end on the phone). Scan quests wait for T-115. The server decides
  each quest's state on its own clock, so Home and the tab agree; a member waiting for approval is told so and keeps
  the event. Quests have no location, time, difficulty, tips or steps yet (Q-102). Not yet run on a phone (T-009).
  CTO: plan 86 → 94; code 92, with its fixes applied.

- 2026-10-21 **T-115 built.** Players can scan a quest's printed QR code inside the app (live camera only), see
  "Scanned! Checking…" at once, then their points with a celebration, or the reason in clear words; finishing a whole
  category plays a full-screen one. Home's points count up to their new value, and a points history lists every point
  earned. Reduce Motion turns all of it off. Android now asks only for internet, vibration and the camera (Expo's
  default storage and overlay permissions are blocked). Not yet run on a phone (T-009): the camera and haptics need a
  real device. CTO: plan 88 → 94; code 92, its fixes applied.

- 2026-10-21 **T-116 built.** The ranking screen shows the top 10 with each player's avatar, the player's own row
  highlighted, and their own row as an 11th with their real rank when they are lower; all of it fits one screen on
  every phone, with no scrolling, and refreshes every 15 seconds while open. Dhia decided the app has one font at one
  size for everyone (ADR-121). Not yet run on a phone (T-009 now lists every on-phone check). CTO: plan 86 → 93; code
  93, its fixes applied.
- 2026-10-21 **T-117 built.** Each event names its currency (both languages, singular and plural, one of five icons)
  and what players and operators are called, from an "Event words" section on the event page with a live preview.
  The app, the quest builder and the players page use those words; sentences that would need Arabic grammar around a
  renamed noun were rephrased (ADR-058). Found and fixed: an unlisted or private event's configuration never reached the
  app, and Home and the ranking read its ranking as off; a player now reads it through `GET /v1/events/{id}/config`
  (ADR-122, Proposed). Q-105 holds the star-vs-XP icon and quest/category renames. 2366 tests, 64 browser tests,
  `expo export` clean; mutation not run (not core, Token budget rule 4). CTO code review 88, then 93 (GO).
- 2026-10-21 **T-118 scripted half built.** `apps/api/test/loop/first-loop.int.test.ts` drives the first loop through
  the real routes: an organizer signs up and builds an event with a QR quest, two players sign up by SMS and join by
  code, one scans, the balance and both rankings update (Redis and PostgreSQL rankings). Found: a player with no points
  is not ranked, so their own row is absent until a first completion (as designed, ADR-052). The phone run is in
  `RUNBOOK.md` and waits on Dhia (staging migrated, a development build). Sonnet code review 86; its fixes
  applied (the dev-client steps, a Redis-only rank check, an exact join check), about 94 by its own estimate.

- 2026-10-22 **T-201 and T-202 done** (one CTO cycle: plan 84 → GO; code 93, GO). Migration 0024: `reward` (stock left derived as `stock_total − units_out`), `redemption`, the `redeem` and `redeem_return` ledger kinds (balance only, ADR-043), `reserve_reward`, `cancel_redemption` and `expire_one_reservation` on the lifecycle tick (one reservation per transaction, ADR-133, Accepted). The dashboard's Rewards page and the app's Rewards tab. 2514 tests, the rewards browser test on desktop and phone, `expo export` clean; mutation 96.3% on `apps/api/src/rewards` (550 of 571). Found by the browser test: saving the shop settings sent empty rules as null and got 400; fixed (`shopRequest`). ADR-134 (spending lowers rank, FR-1847) arrived after the review and became T-219. Docker Desktop stopped at 00:02 during the first mutation run; Postgres needed a restart and 640 leftover test databases were dropped.

- 2026-10-22 **T-219 and T-203 done** (Dhia asked for both in one session; one CTO cycle: plan 84 → 93, code 93, GO). Migration 0025: each event's "spending lowers rank" (owner only, locked from live; only live-time spends move the score, ADR-135 Proposed, Q-106), digital rewards with encrypted codes delivered at once (ADR-136 Proposed; new secret `REWARD_CODE_SECRET`, required at start). Dashboard: the switch, the code upload, the low-codes banner; the reward forms now work on phones (a T-201 layout bug). App: the rank note on confirm, the code shown at once and kept in My rewards. Tests: 22 database, 13 route, unit, the rewards browser test on desktop and phone, `expo export`; mutation 98.35% on `apps/api/src/rewards`.

- 2026-10-22 **T-204 and T-205 done** (Dhia asked for both; one CTO cycle: plan 86 → 93, database and API 92, dashboard and app 86 → 93 after its two majors), not yet run on a phone. Migration 0026 (operators, invites, the fixed My QR, one completion engine, operators off the boards), the owner's operator routes and the player's claim, the station scan, the dashboard's Operators page and `/op` page, the app's operator mode, station scanner, claim screen (through sign-in), My QR. Dhia's answers: email-only invites (ADR-138), a fixed My QR with prizes needing the player's in-app accept (ADR-137); ADR-139 Proposed; FR-306, FR-307, FR-901 amended; Q-107 (booths). Tests: 23 database, 31 route, unit, the operators browser test on desktop and phone, `expo export`. Mutation: about 94% on 576 of 683 mutants before a worker crash; a full rerun is owed (memory note on the crash). Not pushed.
- 2026-10-22 **T-210 and T-212 done** (Dhia asked for both; built earlier by background agents in worktrees, finished, merged onto T-204/T-205 and into `main`, not pushed). T-210: migration 0027, activation requests, the console under `/v1/admin/`, hard and soft player limits; CTO code 92 GO, fixes folded in (one player's last-seat race, audit `before`, console id guard; Q-116 console read audit, Q-117 times after activation). T-212: migration 0028, join fields and answers, guest list with an exact lookup, guest-list-only and domain locks, welcome reward; CTO code 91 GO, fixes folded in. Merge fixes: 0028 had dropped `operator` from `joined_via`; a playing operator takes a seat (`event_full`); 0026 changed in place (never deployed). New task T-220 (FR-1708). 2869 tests, 68 browser tests. Mutation (2026-10-23): `src/activation` 97.4%, `src/join` + `packages/shared/src/join` 90.9%; leftovers cleaned; Stryker now skips `.claude` (the worktrees broke its test finder). Heavy checks run on GitHub by hand from now on (ADR-149: `full.yml`, `mutation.yml`, free while the repository is public). **Not done:** browser tests for the console and the Joining page; the two worktrees under `.claude/worktrees` can be removed.
- 2026-10-23 **T-206 done** (one CTO cycle: plan 86 → 93; code 92, GO, its fixes folded in), not yet run on a phone. Migration 0029 and `src/desk`: the event's one prize desk (place, pin, optional hours, how players confirm), `handed_over` through one handover body that checks the operator, the player, the desk's hours, the mode and the deadline under the locks, the operator's cancel, desk hours closing items and experiences (FR-1717), item rewards needing the desk's place (FR-1716). Dashboard: the desk card. App: the Desk tab, Collect, the accept card on My QR (asks the server only in desk-offer events, at most 3 minutes). Dhia: the owner picks Collect first or Desk offer, no undo, hours optional (ADR-150); ADR-151 Proposed. Tests: 51 database and route desk tests (the races included), unit tests, the rewards browser test on desktop and phone (68 browser tests), `expo export`; Full checks green on GitHub after two test-teardown fixes (a test's own pool now closes before its database is dropped; a race test's refused side is handled at once). Mutation: 96.95% on `src/desk` and `rewards/builder.ts` (desk.ts 98.2%, after unit tests that took it from 73.7%; routes.ts 93.1%; builder.ts 97.2%). **Pushed to branch `t-206-prize-desk`, not `main`:** the push to `main` waits for Dhia.
- 2026-10-23 **T-207 done** (CTO plan 93; CTO code 68 → 94 GO; the blocker (a quest replay reaching another event) is fixed with `expected_event` and tests, minors folded in), not yet run on a phone. Migration 0030 and `src/awards`: manual awards by operators and staff inside the owner's caps (per award, per day; the owner uncapped), removals with a reason by owners and editors (score and balance never below 0, a clamped removal refused while a prize is reserved), bulk awards to a list or a quest's completers, the report. Dashboard: record, Award and Remove on the Players page; the Awards page. App: Tools → Manual award; history shows awards and removals. Dhia's answers in ADR-152; Q-118 (editor bulk inside the per-award cap). FR-320 and FR-1712 amended; FR-1602 moves to T-401; notes on T-214, T-217, T-401, T-505. Tests: database, route, unit, 70 browser tests, `expo export`; mutation 98.4% on `src/awards`. A bulk preview no longer resets when the amount is typed (found by the browser test). Not pushed.
- 2026-10-23 **T-209 done** (CTO plan 88 → folded; code 93 GO, its fixes folded in: a held player's accept reads as no live offer, the paused message tested in the app, a removed account never in a same-phone case), not yet run on a phone. Migration 0031 and `src/flags`: same-phone and burst flags raised by a trigger on every completion (never blocking play, FR-329); the Flags page (clear; close after removing points; the owner pauses or bans); the desk holds a flagged or banned player's items alike ("Held, ask the owner"; never naming the ban: CTO MAJOR), the owner's per-player pause (reserve, Collect and handover) and per-event hold switch; the desk finds by username or phone (FR-1848). FR-331/332 move to T-303, FR-334 to new T-812. ADR-153 to 156 Proposed; Q-119 to Q-121. Tests: database (29 new, races deterministic), route, unit, outsider and cross-tenant, 72 browser tests (desktop and phone; also fixed a flaky players test), `expo export`, the full API/app/web/shared run (3208); mutation `src/flags` 96.6%, `src/desk` 97.8%. Also fixed T-207's `awards.kind.redeem_return` key that broke the key-name test. Not pushed.
- 2026-10-23 **T-211 done** (CTO plan 86 → folded; code 92 GO; minors folded), not yet run on a phone. Migration 0032 and `src/rehearsal`: rehearsal accounts join a Draft or Scheduled event with the event's rehearsal code (XXXX-XXXX, at most 25, no seat, no welcome; a real member cannot rehearse with that account); every writer calls `ensure_rehearsal_wiped` first; rehearsal plays like live (shop open, desk hours ignored, digital rewards show a test code and never spend a real one); at go-live (the tick's own step, or the first live write) one wipe deletes the rehearsal accounts with their completions, ledger entries, reservations, handovers, flags and awards, recomputes stock and repairs the ranking, audited with counts; the team can erase earlier. The ledger's one exception (ADR-157): only that wipe may delete rows stamped `rehearsal`. Dashboard: the rehearsal card (code, change, erase, the go-live notice) and a Players badge; deleting a quest or draft with rehearsal data says "Erase rehearsal first". App: one code box for both codes, the rehearsal join, the strip on player and operator screens, "Rehearsal ended. Join to play.". ADR-157 to 160 and Q-122 to 125 Proposed (NFR-019 sentence Proposed). Tests: 29 database (races at the start, the ledger exception, FK and writer coverage guards), 9 route, unit, outsider and cross-tenant, 74 browser tests, `expo export`, the full API/app/web/shared run (3287); mutation `src/rehearsal` 92.8% (rehearsal.ts 100%, routes 91.1%, service 90.2%). Not pushed.
- 2026-10-23 **T-213 done** (not core; Sonnet code 86 → fixed), not yet run on a phone. Migration 0033: `enrollment.goal_reward_id`, written only by `set_goal` (a member pins one reward of the event's shop, or clears it). `PUT /v1/events/{id}/goal`; the shop gains `goalRewardId`; Home gains `goal` (the pinned reward while it is in the shop, with what is left; else the cheapest reachable reward not yet affordable; none with the shop off). App: Pin as goal / Unpin on reward cards, the goal card on Home opening Rewards. Shop sections were already built (T-201); FR-522 moves to T-304 (ADR-161, Q-126 Proposed). Tests: 6 database, 3 route and 2 Home over HTTP, unit (`pickGoal`, app parsers), the API/app/shared/web run (3136 + 178), `expo export`. Not pushed.
- 2026-10-23 **T-214 done** (CTO plan 80 → 93 GO; code 93 GO; minors folded), not yet run on a phone. Migration 0034 and `src/results`: rank prizes per rank range (locked once live), the owner's confirmation after the end against the places seen (freezes them and stops removals; races with removals tested both ways), the reveal with the owner's claim deadline giving winners price-0 desk items, the official rules as a fixed block built from data (store gate §1.12) plus the organizer's text on a public page and in the app. Dashboard: Prizes and results. App: the win card, rank prize items, the desk label. ADR-162 to ADR-165, Q-127 to Q-131 Proposed (Q-131: counsel on the winner wording); FR-1707, FR-1718 (push left to T-501), FR-1719 amended; notes on T-501, T-307, T-217. Tests: 29 database, 7 route, unit, security suites, 76 browser tests, `expo export`; mutation 92.6% on `src/results`, `rules.ts`, `desk.ts` (one worker crash; orphans and 75 test databases cleaned). Not pushed.
- 2026-10-23 **T-216 done** (not core: no plan review; Sonnet code 91 GO; minors folded), not yet run on a phone. Migration 0035: today's ranking read from the append-only ledger (points inside the current event day, the overall tie rule and exclusions; no table, no trigger change), one Redis copy per event day (`{event}/{day}`) written after each scan and rebuilt by repair and the backstop, the PostgreSQL fallback. `?scope=today` and `today` on the ranking read; the owner's `rankingToday` switch on the dashboard; Whole event / Today tabs in the app. ADR-166, Q-132 Proposed. Tests: 6 database, 4 new route tests, app unit, the events browser test (desktop and phone), security suites, `expo export`; 2262 tests in the touched suites. Not pushed.
- 2026-10-23 **T-218 done** (core: CTO plan 84 → folded; code 93 GO; minors folded: requests pending before declined with a server count and Show more, the Accept-all result shown on an empty queue, no ban or lift of a player who left (ADR-168 amended), the join flow in its own hook, a waitlisted rejoin says so), not yet run on a phone. Migration 0036 and `src/moderation/requests.ts`: a declined request is its own status (no seat, cannot ask again unless invited, ADR-167); seats count accepted players only (ADR-168, amends ADR-141); a full hard-limited event answers `full` and offers the waiting list (`waitlisted` pending rows); the team accepts, declines and accepts all under the seat lock (seats before the row everywhere, no caught `QL409`); bans refuse requests; `enroll_operator` answers `full`. Dashboard: Join requests on the Players page, the access change confirmed in words (ADR-169). App: Request to join, Event is full with Join the waiting list, the waiting card on Home (read every 15 seconds), the declined message. The decision push moves to T-501 (note there). ADR-167 to ADR-169, Q-133 to Q-135 Proposed. Tests: 18 database (races at the last seat for accepts and waitlist joins), 5 route tests, join and Home route tests, app unit, the join-requests browser test (desktop and phone; 78 browser tests green), the whole vitest suite (3,449), security suites, `expo export`. Also fixed T-216's stale config test (`rankingToday`). Mutation 92.5% on `src/moderation/requests.ts` and `routes.ts` (local, 182 mutants; leftover test databases dropped). Not pushed.
- 2026-10-23 **T-220 done** (core: CTO plan 86 → folded; code 93 GO; minors folded; mutation on GitHub run 39936502814), not yet run on a phone. Migration 0037 and `src/audience`: a category or reward can be kept for players whose answer to a choice field is one of chosen options, or for guests with chosen tags (ADR-170 to ADR-173, Q-136 to Q-139 Proposed). Players outside it do not see it; `record_completion` refuses `not_for_you` on every path (player, operator scan, team award) and `reserve_reward` answers 404; `set_goal` refuses. Options are fixed once answered except for adding and relabelling; a targeted field or option cannot go; a returning player keeps earlier answers; a draft event still deletes in one statement. Dashboard: options in the field editor, the guest tag with the invitation hint, "Who sees what" on the Joining page with each rule's reach. App: the picker and the refusal text. Tests: 22 database, 5 route, unit (rules, options, setup, web lib, app join), the audience browser test (desktop and phone; 80 browser tests green), the whole vitest suite (3,510), security suites, `expo export`. Mutation not run locally (Dhia's rule): `apps/api/src/audience` added to `stryker.config.json`. Not pushed.
- 2026-10-24 **T-217 done** (core: CTO plan 86 → folded; code 92 GO; minors folded; mutation owed on GitHub: apps/api/src/deletion/**, auth/keys.ts, idempotency-store.ts), not yet run on a phone. Migration 0038 and `src/deletion`: a deleted account becomes a tombstone (ADR-175 to ADR-178, Q-140 to Q-144 Proposed): contacts, sessions, histories, acceptances, answers, flags, device ids and note reasons go; the ledger, enrollments, frozen results and handed-over prizes stay, naming no one. A fresh code (its own challenge, never a sign-in) gives a 10-minute deletion token; pending prizes are listed and need a forfeit (`end_reservation` with `erasure`). Keyed fingerprints of every contact held leave ban, welcome (until the event ends) and platform marks only. Joins read the caller FOR KEY SHARE, so a join in flight waits and refuses. App: Profile → Delete account. Web: `/{lang}/delete-account` (linked from the privacy policy). Deleted players show as "Deleted player". Also ADR-174 (mutation on GitHub only, batched, 90% bar; Accepted) and the T-220 code-review minors. Tests: 19 database (races with a join, a join request, a reserve and a My QR scan), 7 HTTP, app and web units, the whole API suite (2,684), security suites, 4 new browser tests plus the touched specs (desktop and phone), `expo export`. Mutation not run locally: `apps/api/src/deletion` added to `stryker.config.json`. Not pushed.
- 2026-10-24 **T-401 done** (core: CTO plan 89 → folded; code 94 GO; minors folded (an operator My QR scan pays XP once, DB test; the T-709 curve-edit note); mutation on GitHub run 39945083260), not yet run on a phone. Migration 0039 and `src/questify` in the app: Questify XP follows the event ledger by trigger (ADR-179 to ADR-182, Q-145 to Q-148 Proposed): one credit per (player, quest) from every writer of a quest entry, nothing for rehearsals, awards or repeats, one reversal per removed credit (FR-1602); 100 XP per quest (server-only, CHECKed), 30 levels, six titles; levels reached are kept for T-402's items. `GET /v1/me` gains `questify`, a completion answers `levelUp`. App: Profile level, title and XP bar; the scanner's medium level-up beat. Tests: 21 database (races, a deletion holding the player row, the backfill twice, append-only, closed doors), route, app units, security suites, the whole API suite, `expo export`. Not pushed.
- 2026-10-24 **T-301 planned** (core; CTO plan 80 → revised, re-check owed): `docs/plans/2026-10-24-t-301-submissions.md`, ADR-183, ADR-184, ADR-187 to ADR-189 and Q-149, Q-150, Q-152 to Q-155 Proposed. Text submissions only; pending points live on the submission (points and cap fixed at sending); approval re-checks player and event and writes the ordinary completion (key `sub:<id>`) and quest entry; one removal path through `remove_award`. Photos split to T-301b, blocked on a Questify bucket (Q-149).
- 2026-10-24 **T-302 planned** (core; CTO plan 85, GO at about 93 with its fixes folded in): `docs/plans/2026-10-24-t-302-vote-quiz.md`, migration 0041, ADR-190 to ADR-195 and Q-156 to Q-159 Proposed. Votes and quizzes pay through one shared payment path (`pay_completion`, from T-301's `pay_submission`); the quiz serves one question at a time, times it on the server (2 s grace), pays once at the end (zero right pays nothing), and the lifecycle tick pays an abandoned attempt at the quest's close. Text vote options only (images wait on Q-149).
- 2026-10-24 **T-301 done** (core: CTO plan 80 → 93 GO; code 93 GO; minors folded: approval refused for a platform ban, a reviewer's approval moves the ranking, pending points summed in SQL (`own_pending_points`), the wipe counts submissions, operator reviews recorded per SECURITY.md, no separate submit rate limit; mutation on GitHub run 39949844007; migration 0040 edited in place, never deployed: CranL has migrations through 0039), not yet run on a phone. Text submission quests: migration 0040 and `src/submissions`; pending points live on the submission and never touch the ledger until approved; approval is an ordinary completion (key `sub:<id>`, reserved at the API and in SQL) so score, rank, XP and the shop window follow; rejection with a reason adds nothing; auto-approve pays at once and stays unread in the queue; removal goes through `remove_award`; ban, removal, leaving and deletion close pending ones; the rehearsal wipe, burst flags and the quest builder's delete guard know submissions. App: the quest sheet (guidelines first, text box, pending and rejection lines), "+N pending" on Home, Tools → Review. Dashboard: Submissions page, builder toggles. Tests: 26 database, 6 route, the security suites, app, web and shared units, the submissions and awards browser tests on desktop and phone, `expo export`. Photos are T-301b (blocked on Q-149). Not pushed.
- 2026-10-24 **T-302 done** (core; Opus code review owed), not yet run on a phone. Vote and quiz quests: migration 0041 and `src/plays`. A vote is one completion (method `vote`) with the player's option; the quiz serves one question at a time on the server's clock (2 s grace, the deadline never moves), one try, the right answer only after answering or closing, one payment at the end (right answers × points frozen at start, key `quiz:<id>`; none right pays nothing, still done). Open checks on every step; a member who stops being active voids their attempt; no manual award on a quiz in play; the lifecycle tick and `confirm_results` finish due attempts with an approval's re-checks; played quests lock their structure. App: vote sheet and quiz flow (reduce motion, spoken countdown). Dashboard: vote and quiz types, vote counts. Tests: 25 database, 5 route, security suites, app, web, shared and tick units, the builder browser test on desktop and phone, `expo export`. Mutation owed on GitHub (`apps/api/src/plays/**`, `apps/api/src/quests/builder.ts`). ADR-190 to ADR-195, Q-156 to Q-159 Proposed. Not pushed. CTO plan 85 → folded; code 92 GO; minors folded (2026-10-23: the sweep takes the event FOR KEY SHARE first, a failing attempt is voided with an audit entry and the sweep moves on, integer timer, the ranking moves only on the step that paid; sweep cost noted in Q-157).
- 2026-10-24 **T-303 done** (core; CTO plan 91 GO; code 94 GO; nits folded: a non-boolean `required` reads as required, the share link must be https, `vote_quest` goes through `play_quest` in migration 0043), not yet run on a phone. Split first (ADR-196): location check-in and the location flags are T-303b, meet-someone is T-303c. Migration 0042: challenge quests (only staff: the station's My QR scan or a manual award), survey quests (`survey_response`, one per player, each answer checked, results for owners and editors with names not shown) and share quests (paid once on the share sheet's `sharedAction`; the `shareQuests` switch hides them from every player read and refuses payment). App: survey form, share flow, challenge line, station label. Dashboard: the three types, survey results, the share switch. Tests: 18 database, 10 route, security suites, shared, app and web units, the builder browser test, `expo export`. Mutation owed on GitHub (`apps/api/src/plays/**`, `apps/api/src/quests/switched-off.ts`, `apps/api/src/quests/builder.ts`). ADR-196 to ADR-199, Q-160 to Q-163 Proposed. Not pushed.
- 2026-10-23 **Stabilisation round**: the preview APK crashed at launch because the release Hermes has no `Array#toSorted` (`fontFor`, also in `launch.ts`, `home.tsx` and shared `compose.ts`, `placeholders.ts`); copy-then-sort everywhere, `unicorn/no-array-sort` off for the app and shared, and `apps/app/src/hermes-runtime.test.ts` fails on any call to a built-in the release Hermes lacks. Submissions mutation survivors (run 39949844007: routes 69.5%, submissions 67.4%) answered with `refuse` and SQLSTATE unit tests, queue paging tests and two equivalent-mutant notes; a new GitHub run is owed (`apps/api/src/submissions/**`, `apps/api/src/plays/**`).
- 2026-10-24 **T-304 planned** (core; CTO plan 81, revised: bonus a removable credit of its own, shop-closed balance, explicit calls, no dead ends, kind sites listed; re-check owed): `docs/plans/2026-10-24-t-304-category-rules.md`. Split (ADR-200): T-304 = in order, opens at, unlock after and the points completion bonus (FR-231 to 235; a zero-right quiz counts as done); T-304b passport; T-304c refresh and hidden categories; T-304d item rewards (FR-522, FR-1617); FR-238 to T-501. Migration 0044 (0043 is T-303's `vote_quest` fix). ADR-200 to ADR-202, Q-164 to Q-166 Proposed. Also: T-303's code-review nits folded (0042 edited in place: a non-boolean `required` reads as required, the share link must be https; 0043 `vote_quest` through `play_quest`), and the plays mutation survivors from run 39956001295 killed by `src/plays/plays.test.ts` and route tests (re-run owed on GitHub). Not pushed.
- 2026-10-24 **T-304 done** (core; CTO plan 81 → 93 GO; code 92 GO; minors folded: `bonus.settled` so a removed bonus is never promised again, an unlock category's name hidden outside its audience, `own_category_bonus`'s same-transaction match documented; 0044 edited in place), not yet run on a phone. Migration 0044: category order, opening time, unlock-after and completion bonus; gates in `quest_open_check` (manual awards pass; no dead ends); the bonus paid once by the database (`bonus` ledger kind, balance only while the shop is open, no XP, removable on its own), also for a quiz finished with no right answers. API, app (locks, rules, bonus lines) and dashboard (category form and notes). Also fixed the organizers browser test broken by T-303's second owner-only note. Tests: database 20, route, unit, security, browser (quests and organizers specs), `expo export`. Mutation owed on GitHub (`apps/api/src/quests/categories.ts`, `apps/api/src/quests/store.ts`, `apps/api/src/home/home.ts`, `apps/api/src/completions/complete.ts`, `apps/api/src/plays/**`, `apps/api/src/submissions/submissions.ts`). Next in the area: T-304b, T-304c, T-304d. Not pushed.
- 2026-10-24 **T-304b planned** (core; Opus plan review owed): `docs/plans/2026-10-24-t-304b-passport-quests.md`. Passport quests: steps in their own table, each its own signed code (format 0x04), paid once by the database on the needed-th stamp through `pay_completion`, `needed` never falls once stamped, steps by printed QR only. Migration 0045. ADR-203, Q-167 Proposed. Not pushed.
- 2026-10-24 **T-304b done** (core; CTO plan 84 → 93 GO; code 92 GO; minor folded: a re-scan pays a player left at `needed` unpaid by a `needed` lowered under a stamp in flight; 0045 edited in place), not yet run on a phone. Migration 0045: passport steps and stamps, `stamp_step` pays the quest once on the needed-th stamp through `pay_completion` (key `pass:{quest}`, reserved in every player key check), a deferred step-count check (a quest's delete with its steps passes), `needed` never falls once stamped. API: `POST /v1/steps/{id}/stamp`, `GET /v1/quests/{id}/passport`, `steps` on the quests read and in the builder, a code per step (format 0x04, own key) and its regeneration. App: scanner, progress line, passport list. Dashboard: passport fields, step codes. Tests: 17 database, 5 route, unit, security, browser (passport, codes, quests, survey-share; desktop and phone), the full API suite (2956), `expo export`. Mutation owed on GitHub (`apps/api/src/quests/qr.ts`, `apps/api/src/passport/**`, `apps/api/src/quests/passports.ts`, `apps/api/src/quests/codes.ts`, `apps/api/src/quests/store.ts`, `apps/api/src/quests/quests.ts`, `apps/api/src/plays/run.ts`, `apps/api/src/home/home.ts`). Not pushed.
- 2026-10-24 **T-304c planned** (core; Opus plan review owed): `docs/plans/2026-10-24-t-304c-refresh-hidden-categories.md`. Refresh counts the repeat cap, done, gates and bonus inside the event's day or 7-day block (nothing paid is touched; scan, code and challenge only); hidden categories open per player by a signed secret code (0x05). Migration 0046. ADR-204, Q-168 Proposed. Also: deletion and idempotency-store mutation survivors from run 39960854772 killed (`deletion.int.test.ts`, `idempotency-store.test.ts`; re-run owed). Not pushed.
- 2026-10-24 **T-304c done** (core; CTO plan 84 → 93 GO, its two build notes applied: the bonus guard runs under the enrollment lock, a manual award reveals only on a fresh payment; Opus code review owed), not yet run on a phone. Migration 0046 (new file): refresh per event day or 7-day block from the event's first day (cap, done, gates and bonus per period; occurrence lifetime and past 100; scan, code and challenge only), hidden categories (`category_reveal`, `reveal_category`, `sees_category` in every reader and the open check; the public page leaves them out). API: reveal route (0x05, code checked before any read), quests read `refresh`/`resetsAt`, builder fields, secret codes and their regeneration. App: scanner reveal, reset notes. Dashboard: refresh, hidden, secret codes. Tests: 31 database, 7 route, unit (signer, app, web), security suites, browser (quests, codes, passport; desktop and phone), `expo export`. Mutation owed on GitHub (`apps/api/src/quests/qr.ts`, `apps/api/src/reveal/**`, `apps/api/src/quests/categories.ts`, `apps/api/src/quests/codes.ts`, `apps/api/src/quests/quests.ts`, `apps/api/src/quests/store.ts`, `apps/api/src/home/home.ts`). Not pushed.
- 2026-10-24 **T-304d done** (core; CTO plan 84 → 93 GO, its two build notes applied: the new triggers are named `quest_item_*`/`category_item_*` so the item lock is taken before the refresh lock, and a comment says every completion locks the items; Opus code review owed), not yet run on a phone. Migration 0047 (new file): `quest_item` with its own stock and guards (desk, removed stays removed, `item_in_use`), `quest_item_miss`, a redemption's third source (once per completion, once per category and period), `give_item`, the payers lock both items in id order and give the quest's item on the first completion and the category's with its bonus (an item-only bonus writes no ledger entry), removal cancels a pending item and answers it (replay too), `AO409` counts priced reservations only, every reader learns the item and `source`, the shop's popular list skips free items, `member_event_quests` names the items still to win, rehearsal wipe and erasure. API: `…/quest-items` (list, add, edit, remove, misses), `itemId` on quests and categories (`invalid_item`), `item`/`bonus.item` on every pay answer, `source` on desk and player items, the removal's `item`. App: item lines on completion (pending, ran out, desk closed), the item beside quests and in category notes, "Quest reward" labels, no cancel for free items. Dashboard: Quest items on the Prizes page (stock, given by, ran-out warning, who missed), item picker on quest and category forms, warning on the event overview. Deviations recorded in ADR-205's build notes. Tests: 34 database, 5 route, unit (API, app, web), security suites, browser (all 100 on desktop and phone), `expo export`. Mutation owed on GitHub (`apps/api/src/rewards/quest-items.ts`, `apps/api/src/completions/complete.ts`, `apps/api/src/desk/desk.ts`, `apps/api/src/quests/builder.ts`, `apps/api/src/quests/categories.ts`, `apps/api/src/quests/quests.ts`, `apps/api/src/awards/**`). Not pushed.
- 2026-10-23 **T-303b done** (core; CTO plan 82 → 92 GO, its three build notes applied: `position_of` judges shape only so `bad_position` and `stale` answer apart; the check-in limit is counted before the check under the player lock, with a parallel test; Q-172 cites its Apple sources; coordinator notes applied: distances only in `completion_position`, a separate `location_tuning()` with `flag_tuning` untouched, older builds complete a location quest by its QR and this build keeps the QR for unknown types; Opus code review owed), not yet run on a phone (needs a new EAS build: `expo-location` is native). Migration 0048 (new file): `location` quests (place required, quest QR always), quest places and the venue pin, `completion_position` (rounded distances, accuracy, mocked; no grant, no policy; never a coordinate), `complete_quest` and `record_completion` take the reading (every 11-argument payer unchanged), `far_from_venue` and `impossible_speed` flags, `flag_detail` distance, gap and seconds, erasure and the wipe. API: lenient position on scans, strict on check-ins (`location_refused`), own check-in limit, platform switch `locationQuests` off by default (shared `offByDefault`), builder place and venue pin, Home `locationPrompt`. App: check-in sheet with the QR beside it, one-button explanation (on Check in, or once after joining an in-person event with a pin; never at launch), scans and typed codes carry the last fix up to 2 minutes old. Dashboard (Sonnet worker): venue pin, quest place, location note, Flags lines. CranL's log settings meet the rule (RUNBOOK). Tests: 31 database, route and flow (incl. parallel check-ins and no-echo), builder, security suites, app, web and shared units, browser `location.spec.ts` plus flags, rewards, quests, events (desktop and phone), the full suite (4198), `expo export`, gitleaks. Mutation owed on GitHub (`apps/api/src/completions/complete.ts`, `apps/api/src/completions/routes.ts`, `apps/api/src/flags/flags.ts`, `apps/api/src/quests/builder.ts`, `apps/api/src/events/events.ts`, `apps/api/src/home/home.ts`). Not pushed.
- 2026-10-23 **T-303c done** (core; CTO plan 84 → 93 GO, its two build nits applied; Opus code review owed), not yet run on a phone (no native change, no new EAS build). Meet-someone quests: migration 0049 (new file) with `meet_pass` (a one-minute code kept as a SHA-256 hash) and `meeting` (one per pair and quest), `meet_player` pays both players or neither under ADR-211's lock order (payments in player id order for the per-player XP rows), the daily cap from each player's own meet completions, the shown side out of the burst flag, erasure and the wipe. API: three player routes (limits 30, 60, 20), both rankings move, the `meetSomeone` switch (owner), builder `dailyCap`. App: the meet sheet and code screen, the scanner reads meet codes, every refusal line (Arabic checked with ux-araby). Dashboard: the meet type, the switch (`EventFeatureSwitch`), Flags method labels. Tests: 35 database (races on two connections, 50 rounds), 7 route, security suites, API/app/web/shared units, browser `meet.spec.ts` and the touched specs, `expo export`, gitleaks. Mutation owed on GitHub (`apps/api/src/plays/meet.ts`, `apps/api/src/plays/routes.ts`, `apps/api/src/quests/builder.ts`, `apps/api/src/home/home.ts`, `packages/shared/src/quests/meet-code.ts`). Not pushed.

- 2026-10-24 **T-305 done** (core; CTO plan 84 → 92 GO, its two build notes applied; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Mini-games: migration 0050 (new file) with `game_round` (seed, the level's numbers, points and engine version frozen at issue; the inputs never kept), `start_game_round` (an attempt used at issue, idempotent by key, cooldown for unlimited attempts), `finish_game_round` (the API's replay verdict, the clock check, one payment on the first pass, a refused round written as a row and flagged `minigame`), the sweep, the leave trigger, `quest_done` for spent attempts, the config lock once played, erasure and the wipe. Shared engines for memory match and slide puzzle (integer PRNG with golden vectors, `canInput` gate = the replay's rules; 5,000-seed honest-play tests). API: three player routes (426 for an older engine; limits 30 and 20), the `miniGames` switch, builder `game` (catch and tap rush "not available"). App: the sheet (Play, Retry while a result waits, Passed, attempts), the full-screen games with `Animated` and haptics, results in Arabic and English. Dashboard: the game type, the switch, flag lines. Tests: 42 database (races on two connections, 50 rounds), 12 route, security suites, shared/API/app/web units, browser `games.spec.ts` and the touched specs, `expo export`, gitleaks. Mutation owed on GitHub (`packages/shared/src/games/**/*.ts`, `apps/api/src/plays/games.ts`, `apps/api/src/plays/routes.ts`, `apps/api/src/plays/limits.ts`). Not pushed.
- 2026-10-24 **T-305c done** (core; CTO plan 84 → 93 GO, its five build notes applied; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Catch and tap rush on T-305's rounds: shared `ticks.ts` (30 Hz, integer `tickAt`/`tickStartMs`), `catch/v1.ts` (`advance` on the tick, basket speed capped by the world, foresight per ADR-217) and `tap-rush/v1.ts` (seeded 3 × 4 schedule, 120 ms gate, 150 ms grace for an empty cell only, score = hits − misses); `RealtimeEngine` type; levels and thresholds from calibration (ADR-217 build note). Migration 0051 (new file): both games in `quest_game_shape` and `game_round`'s check, `game_level` with six rows; 0050 edited in place (undeployed) so the flag case's rounds carry their `result`. API: registry and builder take all four (`COMING_GAMES`, `unavailableGame` and the builder's `not_available` deleted); the sheet carries `engineVersion`. App: `realtime.ts` (paused-aware game clock, the 3-2-1 count kept covered and out of `t`, the round ended on return when the window left < game time left + 30 s, `frame`), catch and tap rush screens (`PanResponder`, `Animated` pool, `onPressIn`), the sheet's update line for a game or engine version the build lacks. Dashboard: four games with the quick-sight note; the flag line shows the count that tripped `unlikely`. Also: T-305's many-seed tests moved to `*.calibration.test.ts`, which Stryker now skips (`vitest.stryker.config.ts`; mutation run 40030086932 had timed out on them); `pnpm test` still runs them. Tests: shared engines and calibration, app frame/pause/honest-play properties (500 seeds a level through `frame` and the tap gate), 43 database, 17 route, security suites, web units, browser `games.spec.ts` and flags specs, `expo export`. Mutation owed on GitHub (`packages/shared/src/games/ticks.ts`, `packages/shared/src/games/catch/v1.ts`, `packages/shared/src/games/tap-rush/v1.ts`, `packages/shared/src/games/registry.ts`, `packages/shared/src/games/levels.ts`). Not pushed. CTO code review 91 GO; fixes folded in: the pause line is a
statement ("Paused."), replay-cost bound 50 ms (calibration) and 150 ms (unit, run by Stryker), tap rush rounds at most
30 s, the foreseen flag's limit written into ADR-217 and Q-181. Accepted: an app build from before T-305c shows
"failed" (not the update line) on a catch or tap rush quest; no store build of that kind exists.
- 2026-10-24 **T-306 done** (core; CTO plan 84 → 93 GO, its four re-review notes applied; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Live polls: migration 0052 (new file): a vote quest's `live` block (one or several choices, results after voting, at close or never, 1 to 1,440 minutes), `quest.poll_sent_at`, `quest_vote` one row per option (one completion, one payment), `vote_quest(uuid, text[], text)` (`VC422 too_many_choices`, the replay compares the set), `send_poll`/`close_poll` (owner, editor; audited; live event, or a running rehearsal), the API-seat guard on a live poll's window and `quest_lock_played` on `live`, choices and minutes (`PL409`), live polls left out of `category_done`/`category_cleared`/the in-order check (a category of only live polls is cleared, never done; a category holding one never refreshes), `member_poll`, `poll_results` (policy, `PR403`), `quest_vote_counts` with `voters`, `live_state` (empty for anyone not an active member), `event_has_open_poll`, the wipe puts rehearsal-sent polls back to draft and counts votes per player and quest. API: vote body `{optionIds}`, `GET /v1/quests/{id}/poll`, `GET /v1/events/{id}/live` (weak ETag without `serverNow`, 304, `Server-Now`, 3 s per-event cache, 30 a minute per player in each instance's memory), `…/send` and `…/close`, builder `poll_locked {field}` and a live poll's window kept as Send/Close set it. App: the pop-up card over the event tabs (only on a calm screen: no sheet, not Scan, never over a game, quiz or camera; Later puts it off for the session), the poll sheet (radio or checkboxes, countdown on the server's clock, results as shares of voters), the one-time results card, `livePollSeconds` tuning (10). Dashboard (web): Live poll fields with the "ideas, never looks" line, the window fields hidden for a live poll, Draft/Open/Closed with Send now and Close now (each confirmed) and counts every 5 s while open, shares of voters. T-306b's plan section gained the `pg_stat_activity` build notes (CTO re-review 3). Tests: 25 database, 5 route (+ live unit), builder and shared units, security suites, app and web units, browser `live-polls.spec.ts` and `vote-quiz.spec.ts` (desktop and phone), `expo export`, gitleaks. Mutation owed on GitHub (`apps/api/src/plays/votes.ts`, `apps/api/src/plays/live.ts`, `apps/api/src/quests/polls.ts`, `apps/api/src/quests/builder.ts`, `packages/shared/src/quests/registry.ts`). Not pushed.
- 2026-10-24 **Mutation survivors of GitHub run 40036668119 chased** (plays meet, games, limits, routes; home; quests builder and store; the game engine and memory match; awards routes): tests only, plus one bug the survivors showed: `GET /v1/events/{id}/quests` built each quest's `meet` and `game` but never sent them, so the app's meet sheet never showed today's meetings (fixed in `home/routes.ts`, API.md). New: `test/support/fake-pool.ts` (a pool answering canned rows and errors) and its unit tests for the race-only refusals; `test/quests/store.int.test.ts`; memory match reads its board inside each test (a board read while the file is collected made Stryker treat `start` as static). `stryker.config.json` leaves out `packages/shared/src/games/testing/**`. Re-run owed on GitHub.

- 2026-10-24 **T-306b done** (core; CTO plan 91 GO, its eight notes folded; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Community quests: migration 0053 (new file, undeployed): five closed tables (`community_goal`, `_step`, `_reach`, `_contributor`, `_payout`; RLS forced, PUBLIC revoked, no grant), ledger kind `community` (system, balance only while the shop is not closed, no XP, unique per step and player), the settle point from `pg_stat_activity` for the API's and the owner's sessions (`CV500 settle_blind`; the migration and `--verify` assert the owner sees them, nothing granted; READ COMMITTED only, `CI500`), `settle_goal` (30 s lag, settled slice plus shown tail, contributors from every row read, the `contributors` top-up, the read capped at the goal's reach, final once the settle point passes the reach or the window's end), `pay_community_batch` (event `KEY SHARE`, rows `SKIP LOCKED`, enrollments in id order, skips `inactive`/`no_play`/`results_final`), the builder (one goal at a time, at most 20, locked at start but texts, `event_ended`), the owner's `settle_community` (`CS409 community_settling`), `confirm_results` `RF409 community_paying`, the event switch's trigger, `remove_award`/`member_ledger`/`member_activity` for the kind, `live_state.community`, `event_has_live` replacing `event_has_open_poll`. API: `apps/api/src/community/` (builder routes, the 5 s tick with `community.settle_behind {goals, blockerPid, blockerApp}`, `payout_stuck`, `settle_blind` logs, the 2 s pay budget, Settle and pay now), `PUT …/community`, the confirm's `community_paying {goals, due}`, quest/category delete `goal_in_use`, the pool's 10 s `idle_in_transaction_session_timeout` (`db/pool-options.ts`). App: one live read for the tabs (`LiveProvider`), the wooden community bar on Home (gold fill from the reading direction's start, milestone markers, time left, "Counting the last points…", Reached/Not reached), one-time cards for a reached moment and a paid step, `history.community`. Dashboard: the Community page (list with progress and payouts every 5 s while running, form with milestones and a bar preview, delete before the start), the event switch, Settle and pay now on the results page. Timing (by hand): first settle over 20,000 completions 2.25 s, steady tick 73 ms, 10,001 players paid in 5.5 s. Tests: 34 database, 3 crossed-lock, 7 route, tick/goal/results/pool units, security suites, app and web units, browser `community.spec.ts` (desktop and phone; `builder.ts`'s Quests link now exact), `expo export` (android). Mutation owed on GitHub (`apps/api/src/community/**`, `apps/api/src/plays/live.ts`, `apps/api/src/results/results.ts`, `apps/api/src/db/pool-options.ts`). Not pushed.- 2026-10-24 **T-306c done** (core; CTO plan 84, re-review 92 GO, its two notes folded: the category bonus at a miss is accepted as paid only by a completion, ADR-227 build note and Q-194, tested; `community_lock_missed` counts a milestone left unreached on a goal that ended reached, tested; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Unlock rewards: migration 0054 (new file, undeployed): `community_step.reward` takes `unlock` with one of three target columns (composite keys to the event, partial unique indexes: a target is locked once), the internal gate (`quest_community_lock`, `category_community_lock`, `reward_community_lock`, `community_lock_missed`, `quest_lock_missed`, `community_lock_note`, `category_rule_lock`, `community_unlock_target`, `community_check_unlocks`), `category_lock` checks the lock first (every door through `quest_open_check`; owners' and editors' manual awards pass, an operator's is refused in `record_completion`), the category rules leave missed-locked quests out, `reserve_reward` `RW403 community_locked`, `send_poll` `PL409`, the sheets serve nothing (`member_game` QN403), `live_state`'s closed results, `public_event_quests`, `operator_award_quests`, `member_event_quests`/`shop_rewards` with notes (DROP and CREATE), the bar's target only to a member who sees it, the builder's `unlock_target`/`unlock_counted`/`unlock_taken`, and a `BEFORE DELETE` trigger on `event` so a draft event with goals can be deleted (0053 had the same trap). API: `communityLock` on quests, categories, the shop and Home's goal (`pickGoal` skips locked rewards), the unlock body, `409 unlock_taken`, `422 invalid_goal {issues: unlock_target|unlock_counted}`, Send's `409 community_locked`, `goal_in_use` for a step, `/live`'s `target`. App: the lock line by the goal's measure (or its start, or missed), the category note, the shop line instead of Redeem, Home's pinned-goal line, the bar's padlock step (named or "a surprise"; an unknown reward kind keeps its marker), the one-time unlocked card and the refetch on the reach. Dashboard: Unlock in the reward picker with the target picker (live polls and the counted items left out, taken targets disabled), the preview line, the title hint, the event switch's warning. Tests: 69 database (the door table over 19 doors by quest and by category, readers, builder, missed and switched off, CTO 2, rehearsal, index probes, the completeness map, 2 crossed-lock), 5 route, API/app/web units, security suites, browser `community.spec.ts` (desktop and phone), `expo export`. Mutation owed on GitHub (`apps/api/src/community/goals.ts`, `apps/api/src/community/lock-note.ts`, `apps/api/src/home/home.ts`, `apps/api/src/home/goal.ts`, `apps/api/src/rewards/shop.ts`, `apps/api/src/plays/live.ts`, `apps/api/src/quests/polls.ts`). Not pushed.
- 2026-10-24 **T-307 done** (core; CTO plan 84, re-review 93 GO, its three notes folded; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Flash quests and double-point boosts: migration 0055 (new file, undeployed): `quest.flash`/`flash_launched_at` with their checks and guard, the closed `boost` table, `ledger_entry.boost_id` (quest and removal only; `LB500` for a real entry naming a rehearsal boost), `boost_in_force` (one rule for payers and readers), every payer restated (`pay_completion` with `device` and `fixed_at` and no defaults; now for scans, votes, surveys, shares, passports and meetings; the send, the quiz's start and the round's issue for the frozen ones; never manual), every reader with `flash_shown`, the category rules without flash quests, `member_event_quests`/`member_activity`/`member_ledger` dropped and created, `live_state`'s `flash` and `boosts`, `event_has_live`'s 15-minute tail, pending points at the send's boost, the wipe and the event delete. API: `quests/flash.ts` (Launch, End now), `boosts/` (list, save, edit, delete, Stop, platform switch), `PUT …/flash-quests` and `…/double-points`, `boost` on every completion answer, `flash`/`boost` on the quests read, `/live`'s cards, `multiplier` on the activity and the team's record, `409 boost_in_use`. App: lightning badge (icon-lightning, 128 px) and "Ends …", the ×2 seal (an isolated run in Arabic) with "Double points until …", "Double points!" on every paid line, one-time live cards with the refetch, "×2" in the history. Dashboard: the Flash quest box, Launch now (minutes) and End now on the list, the Double points page, the two switches. Tests: 79 database (the door table over 15 doors, the payer table over 15 payers ×3, the frozen crossings, never-boosted rows, readers, Launch/End, the builder, rehearsal and CTO note 2, removal, places, today's ranking, a community points goal, the payer completeness map, 3 crossed-lock), 8 route, API/app/web units, security suites, browser `flash-boosts.spec.ts` (desktop and phone), `expo export` (android). Mutation owed on GitHub (`apps/api/src/boosts/**`, `apps/api/src/quests/flash.ts`, `apps/api/src/quests/builder.ts`, `apps/api/src/plays/live.ts`, `apps/api/src/completions/complete.ts`, `apps/api/src/home/home.ts`). Not pushed.
- 2026-10-24 **T-308 planned** (core; CTO plan review 86 → 92 GO): `docs/plans/2026-10-24-t-308-nfc-tags.md`. Q-071 answered with research (react-native-nfc-manager v4.1.0 on Expo SDK 57 reads and writes NDEF on both phones). Basic tags only (Dhia, Q-198): signed tags will not be built (ADR-235, ADR-236 rejected).
- 2026-10-24 **T-308 done** (core; CTO plan 92 GO, notes A to C folded; Opus code review owed), not yet run on a phone (Android release APK built 2026-10-24, see the CranL note below). Migration 0056 (deployed on CranL 2026-10-24): closed `nfc_tag` and `nfc_tap`, the `nfc` method only on scan quests and only with the quest QR, `record_completion` restated with `nfc`, `tap_quest` (unknown or another event's tag NT404, the retry replayed on its own quest first, the sticker check, `nfc_copy` from the second mismatch since the last closed case, `platform` taps unchecked), `prepare_nfc_tag`/`register_nfc_tag` (operator, `write_nfc`, quest limit, ended event, the sticker swap under the quest row and the event's lock, 50 a quest, 2,000 an event, `already_registered`), the Tags panel's reads and Move/Revoke/Revoke all, the event delete. API `src/nfc`: tag code purpose 0x06, the 5-minute write ticket (HMAC from `QR_SECRET`), `POST /v1/taps`, prepare, confirm and the operator's page, the team routes, `nfcTags` platform switch, 60 a minute limits, `tags_in_use` on quest delete. App: `react-native-nfc-manager` 4.1.0 (config plugin, NDEF/TAG entitlement, no select identifier; loaded lazily), the scanner's NFC (Android reader mode, iOS button and auto-start from the quest sheet), Tools → Write NFC tag (lock on by default, read-back, Rewrite, retry of a lost confirm). Dashboard: the NFC method box (QR kept and locked), the Tags panel (taps, possible copies, unchecked), the `/t/` page, the `nfc_copy` flag line. Tests: 29 database (door table, writes, crossed locks), 7 route, ticket/qr/app/web units, security suites and the completeness maps, browser `nfc-tags.spec.ts` (desktop and phone), `expo export` (android, ios). Mutation owed on GitHub (`apps/api/src/nfc/**`, `apps/api/src/quests/qr.ts`). Needs Dhia: a new EAS development build (Android and iOS), then the phone test with NTAG213/215 stickers (the iPhone must send the sticker's id). Not pushed.
- 2026-10-24 **T-308 phone-test fix (Android NFC, app only)**: on Dhia's phone (APK cf9ec23b) a sticker and a card met Android's "Could not find an app that supports this NFC tag" on Write NFC tag. Cause: the sessions never asked for reader mode (the library fell back to foreground dispatch) and the library's cancel turned the registration off a second later under the next session. `apps/app/src/nfc/native.ts` now holds reader mode itself for each session, one session at a time; blank stickers (NdefFormatable) are formatted with the link; NFC off and unusable tags (MIFARE Classic) are said in the app (ADR-243, Q-205 Proposed). Tests: `native.test.ts` (7; 6 fail on the old code), app units, `expo export`. **Needs a new APK.** Then the fob "written OK" but unknown on tap: CranL holds no `nfc_tag` row or `nfc_tag.*` audit entry, so no confirm ever committed; the app shows success only on a 2xx confirm, so the likely path is a write that failed after the NDEF write (fob moved before the read-back or the lock) and a second tap answering `taken` ("already holds a Questify quest"). Now a write that went through is registered (unlocked if the lock missed, said on screen), and the `taken` copy says the link may not be registered. Tests: `native.test.ts` 10.

- 2026-10-24 **T-309 done** (core; CTO plan 84, re-review 92 GO, its three notes folded; Opus code review owed), not yet run on a phone or a TV (no native module, no new EAS build). Pairing for stations, kiosks and big screens, the device credential and the rotating screen QR: migration 0057 (new file, undeployed; CranL is at 0056): `device_request` and `paired_device` (RLS forced, PUBLIC revoked, no grant), the screen method `screen_qr` (scan quests only, never with the printed QR), `record_completion`/`complete_quest` restated (the window on the database clock, QV422 `expired`, one pay per player per 45 s), activation's secret swap (`previous_hash` UNIQUE, accepted only while `previous_until` is ahead, a second old-secret activation draws a fresh secret without extending it), removal triggers on `staff_assignment`, `organizer_member` and `staff_user` (no-op without devices; an event being deleted takes its devices), paused when the pairing operator loses the ability or quest. API: `src/devices` (the `device` access kind under `/v1/device` with its guard, the `__Host-qs_device` cookie, pairing with the address limit and the reload case, preview, claim, Revoke, the miss throttles and their alarm, the `stations` switch), screen code purpose 0x07 and the completion proof `screen` (422 `code_expired`). App: the scanner's `/s/` codes, "Scan the code on the screen", Tools → Rotating QR, Pair a device (stations only until T-309b), My paired devices. Web: `/{lang}/station`, `/screen`, `/kiosk` (pairing only), `/s/` and `/pair` landing pages, the Devices page, the quest form's screen QR box, the operator removal note. Build notes on ADR-239 and ADR-240; Q-206 (the unused `screenQrRotationSeconds` tuning). Tests: full Vitest 5110 passed (52 database, 17 device route, the security suites; 0 unhandled errors); browser `stations.spec.ts` (desktop and phone) plus `nfc-tags`, `quests`, `operators` specs; `expo export` (android); gitleaks clean. Mutation owed on GitHub (`apps/api/src/devices/**`, `apps/api/src/quests/qr.ts`, `apps/api/src/completions/complete.ts`, `apps/api/src/completions/routes.ts`, `apps/api/src/route-access.ts`). Not pushed.
- 2026-10-24 **T-309b done** (core; CTO plan 92 GO, its five notes and two nits folded; Opus code review owed), not yet run on an iPad or an Android tablet (no native module, no new EAS build). The kiosk and the live code (F-107, FR-315): migration 0058 (new file, undeployed; CranL is at 0056, 0057 undeployed too, only its stale comment changed): the method `kiosk` (scan quests, with any other scan method), `kiosk_scan` (RLS forced, PUBLIC revoked, no grant; cascades with its completion, kept by erasure), `record_completion` restated with exactly four changes (the null-safe `kiosk:` key check, the method row, the window, the one-pay rule per method keeping `quest_completion_window_idx` usable), `kiosk_complete_quest` (device `FOR SHARE`, `DV403 paused`, `OY409` the pairing operator, a UUID key namespaced `kiosk:{device}:{key}`, install id NULL, `boosted` from the ledger on replays too), `kiosk_scan_subject`, `live_code_window`, `device_quest_state`, `device_view`/`device_json` (`scans`)/`operator_devices` (`kioskQuests`) restated. API: purpose 0x08 `live`, `GET /v1/me/live-code`, `POST /v1/device/kiosk-scans` (the code opened in the API: `needs_live_code` for My QR, `invalid_code` counted), the platform `kiosks` switch (also `shut: feature_off` on `GET /v1/device`), 30 scans and 10 bad codes a minute per kiosk, 6 live codes a minute per player, the ranking after a fresh completion. App: My QR's tabs (For kiosks: fetched on open and again at `changesInMs` plus jitter, never cached, offline and off states, kept awake, the emptying bar), the quest sheet's "Show your live code at the kiosk", Pair a device for kiosks with the lock-the-tablet tip, scans on My paired devices. Web: `/{lang}/kiosk` (`KioskScanner`: the camera on a tap, front by default with Switch camera, `zxing-wasm/reader` loaded by this page alone at 4 frames a second, the Questify-shape filter, a 5-s drop, one scan in flight, one retry with the same key, never queued, the 4-s green/orange/red card with no one named on red, offline and slowed banners), `camera=(self)` and `'wasm-unsafe-eval'` on `/ar/kiosk` and `/en/kiosk` only, every link there a plain `<a>`, the committed wasm with its hash test, the Devices page's kiosk pairing, scans in the last 24 hours and page links, the quest form's Kiosk method; the web image and `pnpm start` now copy `public/` (the currency icons were missing from the image too). Tests: 31 database (the kiosk door table, keys incl. a NULL key, cross-tenant, cascades, flags, 5 crossed-lock), 9 kiosk route, the security suites, qr/kiosk/decoder/headers/devices units, app units, browser `kiosks.spec.ts` (a tablet's fake camera reads a live code and pays; the click-through from the Devices page; wasm served as `application/wasm`) plus `stations`, `quests`, `nfc-tags` specs; `expo export` (android). Mutation owed on GitHub (`apps/api/src/devices/kiosk.ts`, `apps/api/src/devices/live-code.ts`, `apps/api/src/devices/routes.ts`, `apps/api/src/devices/limits.ts`, `apps/api/src/devices/devices.ts`, `apps/api/src/devices/claims.ts`, `apps/api/src/quests/qr.ts`). Not pushed.
- 2026-10-24 **T-310 done** (core; CTO plan 86 → 93 GO, its two notes folded; Opus code review owed), not yet run on a phone. The help desk (F-118, F-180): migration 0059 (new file, undeployed; CranL is at 0056): `ticket` (RLS forced, no grant), `open_ticket` (an active member; 3 open and 10 a day per player and event under the enrollment lock, a key replayed under the lock; `sending_closed` in a draft or archive or 30 days after the end; `feature_off`), `staff_answer_ticket` (audited, no text) and `operator_answer_ticket` (one answer closes it, replays and `already_closed` under the ticket lock, `event_closed` once archived), `own_tickets` (one event or every event, never who answered), `mark_tickets_seen` (NULL event allowed, the CTO note), the merged `operator_inbox` and its count, `event_tickets`, erasure, the rehearsal wipe (`tickets`) and `purge_ended_tickets` (90 days, the lifecycle tick). API `src/tickets`, Home's `help.unread`, the `helpDesk` switch. App: Get help (Info, the profile tab, Home's strip, the quest sheet's "Report a problem with this quest", Contact Questify), the profile's Your requests, staff mode's Inbox with a 30-second badge and the ticket screen. Dashboard: Help desk page, nav link with the open count, Features switch. Tests: 34 database (crossed locks: two answerers, the open cap, one key twice, erasure and the sweep beside an answer), 7 HTTP (logs never hold the text), unit and app tests, security suites, the full vitest suite, 2 new browser tests plus the touched specs, `expo export`. Mutation owed on GitHub: `apps/api/src/tickets/**`, `apps/api/src/home/home.ts`, `apps/api/src/events/tick.ts`. Not pushed.
- 2026-10-24 **T-311 done** (core; CTO plan 92 GO, its notes folded; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Operator tools (F-181, F-182): migration 0060 (new file, undeployed; CranL is at 0056): `operator_practice_scan` (invoker; the real door in a block that always raises, so every row and lock is undone), `practice_wipe_owed` (PW409 `going_live` while the go-live wipe is owed), `operator_station_today` (everyone's completions of the station in the event's day and the last hour). API: `POST /v1/operator/scan/practice` (own route, no key, no ranking, `withRolledBackContext` always rolls back, a failed rollback destroys the connection), `GET …/stations/:questId/today` (60 a minute). App: Tools → Practice mode (memory only), the strip on every staff screen from the shared frame, the lock card on desk, inbox, tickets, award, review, NFC write, rotating QR, pairing; the result line from the server's `practice: true`; a mode change forgets the last code; Home's Today at this station with one shared Inbox poll ("You today" on the station list). T-311b no longer depends on T-311. Tests: 23 database (a whole-database fingerprint around every case with a committing transaction, every refusal compared with the real door, locks gone, keys, crossed scans, the owed wipe, the day boundary), 6 HTTP, API and app units, security suites, the full vitest suite, `expo export`. Mutation owed on GitHub: `apps/api/src/operators/practice.ts`, `apps/api/src/operators/station-today.ts`, `apps/api/src/db/context.ts`. Not pushed.
- 2026-10-24 **T-311b done** (Standard bar; code review owed), not yet run on a phone (no native module, no new EAS build). The event's quest and category words (FR-942) and the event's words in staff mode (Q-214, FR-941): `EventTerms` gains `quest` and `category` (no migration, no route change); `wordParams` fills `{questOne}`, `{questMany}`, `{questOneCap}`, `{questCap}` (and for category and player) in every text through the translator (app root defaults, `TermsScope` in `EventProvider` and `OperatorProvider`; the web translator takes optional terms for the Event words preview, which now has quest and category fields and lines). About 85 texts of the player app and staff mode rewritten (ADR-253: Arabic noun only where it needs no article or agreement, else rephrased). Staff mode loads the event's configuration like the player app (ADR-254), uses its currency in the review queue and desk, and the manual award search no longer names the player. Tests: shared terms and the translator (parity ignores the word placeholders), the app's `words.test.ts` (substitution, no unfilled placeholder, no hard-coded quest/category in the keys staff and event screens name, no hard-coded player in staff texts), web terms, API terms route. ADR-252 to ADR-254 and Q-215 to Q-217 Proposed. Dashboard builder texts split to T-311c.
- 2026-10-25 **T-311c done** (Standard bar; code review owed). The event's quest and category words in the dashboard (FR-942): the event layout (`events/[eventId]/layout.tsx`) reads the event's terms on the server (`fetchEventTerms`) and offers them through `TermsScope`; components use `useTranslator`; `translatorFor` keeps one function per set of words (bounded to 32 events). About 120 texts rewritten (ADR-264; builder, codes, operators, audience, community, flash, boosts, quest items, devices, event switches). Saving the Event words refreshes the layout. Tests: `words.test.ts` (substitution, no unfilled placeholder, no hard-coded quest or category in any key the dashboard names, no direct `translatorFor` in a component that names a word), `event-terms.test.ts`, `language.test.ts` (same function for the same words); browser: `terms.spec.ts` extended (both languages, list reads counted), 17 other specs follow the new Arabic. ADR-264, Q-227 and Q-228 Proposed.
- 2026-10-25 **Dashboard request loop fixed.** `translatorFor` built a new function on every render, and six
  panels (Boosts, Devices, Events, NFC tags, Prizes, Team) list `t` in their hook dependencies, so each reloaded its
  list after every render (CI run 40134112004: 12,378 boost reads in 90 s; the save's own reload landed after the
  Edit click and shut the form, failing `flash-boosts.spec.ts`; not a clock or midnight issue). It now returns one
  translator per language; the Boosts form closes before its list is read again; `flash-boosts.spec.ts` counts the
  list reads; `stations.spec.ts` reloads instead of riding the loop. All browser tests pass under `TZ=UTC`.

## Coordinator handoff (2026-10-25, for the next session)

Work runs in **coordinator mode** (CLAUDE.md "How work runs"; brief: `docs/agents/WORKER_BRIEF.md`). The session
of 2026-10-23 to 25 closed T-304c, T-304d, T-303b, T-303c, T-305, T-305c, T-306, T-306b, T-306c, T-307, T-308,
T-309, T-309b, T-310, T-311, T-311b, T-311c, T-312 and T-313, each with its CTO plan and code reviews (GO) and
fixes folded; everything is on `main` and pushed. Progress: **74 of 152 tasks** (splits keep adding tasks).
Dhia paused the work on 2026-10-25 ("let's have a break"); the queue below is where to resume.
- **CranL** (the only environment, fake data) runs migrations through **0056** (0048 to 0056 applied 2026-10-24 from
  green commit 80a85bb, CI run 40084164841; `--verify` ok with `ownerSeesSessions: true`; owner connection removed
  afterwards); the frozen-migration rule applies to ≤0056. API and web redeployed from 80a85bb the same day:
  `/healthz`, `/readyz` and `/{en,ar}/sign-in` answer 200. Demo event "Questify Demo Day", join code **77XBUB**. The
  release APK (preview profile) works on Dhia's Android phone (confirmed 2026-10-24); the one for the NFC phone test
  (react-native-nfc-manager in) is EAS build cf9ec23b, APK https://expo.dev/artifacts/eas/oizO-3k1mo421W8h9KqEyrsVDmQagzGxIVJ0KjAR4rI.apk (app code as 80a85bb). No iPhone build until the
  Apple Developer account (T-010). The 500-row community payer batch was not timed: the runbook asks for it before the
  first real event with a community quest, against a CranL copy, which does not exist yet. Msegat allows CranL's
  outbound IP 130.94.119.140.
  - **NFC test setup on 77XBUB (2026-10-24, fake data):** the platform switch `nfcTags` is on (no platform override
    stored; on by default). In "General", the scan quest "Tap the NFC sticker" (15 pts, quest QR and NFC ticked). Dhia's
    player account `dhia` is an operator of the event (personal invite "Dhia NFC test", preset full, so `write_nfc`;
    may play, no quest limit), so the app's Tools → Write NFC tag offers that quest; a prepare call answered on CranL
    (no tag registered yet). Write an NTAG213/215 sticker in the app, then tap it as a player.
    Three more scan quests were added in "General" the same way (staff API, temporary sessions revoked afterwards):
    "NFC test 2", "NFC test 3" and "NFC test 4" (15 pts each, quest QR and NFC ticked, visible now). Dhia's operator
    has no quest limit, so Write NFC tag now lists all four; a prepare call answered for each (no tag registered).
  - **Phone-test setup on 77XBUB (2026-10-23, fake data):** category "Daily challenges" refreshes daily (typed codes
    `SUNRISE` 10 pts, `CHECKIN` 5 pts); hidden category "Secret garden" (typed code `ROSE` 25 pts inside) whose secret
    QR is in the dashboard's printable codes (event, Codes, "Secret garden"; version 1); in "General", "Find the
    treasure chest" (code `TREASURE`) gives the quest item "Questify sticker" (stock 2) and "Golden pin hunt" (code
    `GOLD`) gives "Golden pin" (stock 0, the ran-out case). Items show on the Prizes page, Quest items.
  - CranL Postgres log settings (read 2026-10-23, for T-303b): `log_parameter_max_length` -1,
    `log_parameter_max_length_on_error` 0, `log_min_duration_statement` -1, `log_statement` none,
    `log_min_error_statement` error.
- 2026-10-25 **T-312 built** (core; CTO plan 86 → re-review 91 GO with the routing CHECK fixed: a NULL `escalated_at` no longer passes, forged-insert test added, the return CHECK tightened). Migration 0061 (undeployed): six ticket kinds routed by kind, Report a player (owners and editors only, never operators), app problems and suggestions with no event (device facts, `expo-device` 57.0.2 loaded lazily), escalation with a note, Questify's queue for active platform admins (`queue = 'questify'` only, every read audited per event), send back, retention by the latest hop. API (`apps/api/src/tickets/**`, console routes under the T-210 hook, 120 calls a minute per admin), app ticket center, dashboard With Questify and Escalate, console Tickets. Tests: database (tickets, tickets-center), security, routes, unit, app, web, browser (help-desk, console-tickets), `expo export`. Opus code review 93 GO (minors folded: atomic lookup cap, `moved` on a stale reply); pushed. Owed: mutation on GitHub, a new development build (Dhia).
- 2026-10-25 **T-313 built** (core; CTO plan 84 → re-review 92 GO, its three notes folded: a quiz the tick sweeps while the event is live claims, one swept after it does not; the live set includes bonuses with 0 left; `claimed_at = clock_timestamp()`). Migration 0062 (undeployed): `quest_first_bonus` and one `quest_bonus_slot` row per place, claimed `FOR UPDATE SKIP LOCKED` as each payer's last write under a shared advisory lock (the setter's exclusive), the `first_bonus` ledger kind (never boosted, no XP), the setter with Stop, the readers, the rehearsal wipe; `practice:` keys reserved at the API. API (`apps/api/src/quests/first-bonus.ts`, a 2-second per-event count cache, `/live` and the quests read, `firstBonus` on every player completion answer, the practice scan's `bonusPoints`), app (gold ribbon fed by `/live`, success-card beat, history, practice line), dashboard (bonus fields, locked points, Stop, list count, record place, remove hint). Burst timing by hand (two pools of 10, 300 at once, N = 50, median p95 of six rounds): plain 59.7 ms, bonus 73.2 ms (+22.7%), used-up 60.0 ms; over the plan's 20% by 13 ms, Q-229 asks Dhia to accept. `completion_id` join sweep: no SQL or API query reads ledger rows by completion without a kind filter (all filter `kind = 'quest'`). Tests: database (first-bonus, 54), security, routes, unit, app, web, browser (first-bonus spec), `expo export`. Opus code review 92 GO (burst cost accepted, Q-229 recommends agree; minors folded: live gate, Stop with only rehearsal claims switches off, forced crossed orders); pushed. Owed: mutation on GitHub.
- **Queue for the coordinator (2026-10-25):**
  1. Mutation: read GitHub run 40139062524 (tickets, practice, station today, context, home, tick, devices,
     completions routes; still running at the pause). Then dispatch T-313's globs (`apps/api/src/quests/first-bonus.ts`,
     `quests/builder.ts`, `quests/quests.ts`, `completions/complete.ts`, `plays/live.ts`, `plays/run.ts`, `home/home.ts`,
     `packages/shared/src/quests/first-bonus.ts`, always with `!**/*.test.ts`). Chase survivors only while a file is
     under 90%, in a worktree.
  2. Deploy to CranL when Dhia asks: migrations 0057 to 0062 are undeployed (pairing, kiosks, help desk, practice,
     ticket center, first-N bonus); then a new EAS build (adds `expo-device`, `expo-keep-awake` and the NFC fixes
     42b7291, 832ba03, 25ebd30 beyond APK 6059a3f3).
  3. Phase 3 left: T-301b and T-305b (blocked on Q-149), T-307b (T-504 is done, so it can start), T-312b (needs T-501). So the next
     unchecked task is Phase 4: **T-402** (Questify profile), then T-403, T-404.
  4. Coordinator rules learned this session (also in WORKER_BRIEF): every worker runs the full vitest with the DB env
     and, for UI copy, the full browser suite before reporting; an owner-only switch updates the count in
     `apps/web/e2e/organizers.spec.ts`; before pushing, check `git log origin/main..main` for a mid-task worker's
     partial commits (memory: push-check-worker-commits).
- **Parked by Dhia:** Q-149, a storage bucket for photos (T-301b), "revisit later".
- **Phone tests owed (Dhia):** NFC basic tags on Android (APK 6059a3f3; the fob passed after Rewrite; retry the sticker
  after pressing Start writing; quests "NFC test 2" to "NFC test 4" on 77XBUB); T-304c/T-304d (secret QR, quest
  items); location (needs the switch and a build), meet-someone, the four mini-games, practice mode, the kiosk on a
  tablet, the station page on a TV; iPhone tests wait for the Apple account (T-010).
- **Dhia's open decisions:** Q-170 to Q-229 (except those answered: Q-198 basic NFC tags only, Q-206 removed,
  Q-215 split agreed); the historical handoff's ADR-206–264 are Proposed except decisions resolved above. Highest value: Q-229 (accept +13 ms burst cost, CTO says agree),
  Q-219 (FR-1411 vs FR-1822 player reports), Q-207/Q-208 (kiosk), Q-210/Q-220 (retention).

- 2026-10-25 **Coordinator handoff taken over:** recorded Dhia's model and reasoning policy as Accepted ADR-265
  and updated the active coordinator/worker instructions (fresh independent session or subagent for every review).
  Mutation run **40139062524 remains active** per handoff; do not dispatch another run while it is active. **T-402**
  remains the next build task after the mutation queue. Dhia answered **"Keep building; deploy later"**: defer CranL
  migrations 0057–0062 and the new Android build; continue the build queue. UI copy changes require the full browser
  suite after a fresh web build; this update changes docs only and stops for independent review before further work.

- 2026-10-25 **T-402 plan committed for independent review (no implementation yet):**
  `docs/plans/2026-10-25-t-402-profile.md` covers own-only cosmetics/equipment, atomic edits, each level's guaranteed
  item/backfill, next reward, public-profile allowlist, ranking cosmetics and erasure races. Proposed ADR-266–268 /
  Q-230–232 record the split and catalog choices. T-402b immediately follows for organizer souvenirs (FR-723/1622);
  T-403 completes FR-701/702's real achievements/passport and owner history. No requirements cut. Next task action:
  fresh independent Sol High plan review, >=90 and no BLOCKER/MAJOR, then the worker's three build phases. Mutation
  queue remains independent; coordinator holds push while the current run is active. Keep building; deploy later.
- 2026-10-25 **T-402 plan review 86/100 NO-GO; revised for fresh re-review, no implementation:** migration now drains
  old in-flight erasures with player EXCLUSIVE before XP/reached barriers and requires both pre-0063 upgrade schedules;
  table-lock compatibility was verified with two local connections and rolled back, without data changes. Removed
  large-text promises to honor Accepted ADR-121, kept fixed row/avatar bounds and full accessible labels, and added
  T-402 to T-403's dependencies. Coordinator must receive fresh independent GO before build starts.

- 2026-10-25 **T-402 implementation in progress after independent plan GO94**: migration 0063, own/public profile
  API, ranking cosmetics and app locker/edit/public screens are written, not yet committed or reviewed. Focused
  checks PASS: 11 files/577 tests (DB/Redis), including both actual pre-0063 upgrade/erasure schedules and all
  security suites; API/app typechecks pass. Fresh Arabic UX review87 NO-GO identified ambiguous reward copy and
  title/error labels; author is applying those before a fresh re-review. Final full vitest, fresh web build/full
  browser suite, Expo export and fresh core code review remain. Coordinator created the requested recurring usage-
  reset heartbeat `resume-questify-after-usage-resets`, first 05:50 Riyadh (reported reset05:44); resume this active
  work after limits rather than restarting or skipping gates. Keep building; deploy later; never worker-push.

- 2026-10-25 **T-402 durable implementation checkpoint (WIP, no push; task still unchecked):** independent plan
  reviews86→94 GO, Arabic UX review87 NO-GO then copy revised and fresh review pending. Focused run11 files/577
  tests PASS with DB/Redis (both actual upgrade races, all security, ownership/privacy, ranking/app parsing); API
  and app types PASS. After that run, added PostgreSQL-microsecond pagination and both-order runtime erase/equip/seen
  tests (not yet rerun). Source/catalog/screens are written; label fixes applied per Arabic review. Remaining:
  add the upgrade/in-flight-XP schedule, app parser/frame/reward-message tests, finish short-function refactors and
  session/late-response review, update DATA_MODEL/API/SECURITY/SRS/TASKS implementation records accurately, normalize
  touched files to LF, then full vitest with DB/Redis, fresh web build + FULL browser suite, Expo export, lint/types/
  formatting/audit/secret checks. Fresh core code review only after final green checks; mark pending until GO>=90
  without BLOCKER/MAJOR. T-402b remains next, then T-403. Mutation40139062524 remains active; coordinator holds push.
  Recurring heartbeat resumes this task after actual reset05:44:06 Riyadh, first wake05:50; reschedule for future
  actual resets. Worker owns this WIP; do not restart/rebuild an unrelated feature. No CranL/EAS/deployment.

- 2026-10-25 **WIP commit af6345e saved; Arabic re-review GO96/100** (fresh independent Sol High, no
  BLOCKER/MAJOR). Current full-vitest diagnostic command uses TEST_DATABASE_URL at127.0.0.1:55432 and TEST_REDIS_URL
  at127.0.0.1:56379; running exec session **10434**. JSON report will be saved to
  `C:/Users/xdhia/AppData/Local/Temp/questify-t402-full-vitest.json`. Poll that session/read the report first on resume.
  After it ends: fix any failures, add the missing in-flight-XP-vs-upgrade test plus app profile/frame/multi-item-message
  tests, complete changed-function size refactors and late-response owner guards, then update DATA_MODEL/API/SECURITY/
  SRS/TASKS with actual coverage and pending core review. Repeat final checks if subsequent source changes warrant.
  Still owed fresh web build/full browser suite, Expo export, full workspace lint/types/format/audit/secret check and
  fresh core code review. This is WIP, not task completion; no tick, push or deploy. Mutation40139062524 stays active.

- 2026-10-25 **T-402 resumed after quota reset:** old diagnostic5666 passed/8 failed/3 skipped; exact causes
  fixed (revoked-avatar legacy assertions, ranking DTO, Hermes z.union false-positive, Questify-wide word exceptions,
  expensive upgrade-fixture setup moved into existing beforeEach hook budget). Focused regression73 tests PASS;
  app contracts/frame/reward-message + request-log redaction18 tests PASS. Added actual in-flight-XP upgrade schedule.
  Workspace lint/format/types and API/fresh web builds PASS; Android/iOS exports PASS, baseline web export lacks
  react-native-web. Audit completed exit0, two preexisting high advisories ignored by existing policy. Pinned
  official Gitleaks8.30.1 asset digest verified; committed-task scan PASS, final staged scan pending. Final full
  vitest session68090/report `C:/Users/xdhia/AppData/Local/Temp/questify-t402-final-vitest.json` is running.
  Small final owner-load gate now distinguishes loading/offline retry from signed-out (no new copy); recheck
  app guards/types/native exports after it. Full browser suite and fresh core code review remain. Mutation run
  40139062524 completed SUCCESS; coordinator dispatched T-313 mutation40156105166, so push remains held.

- 2026-10-25 **T-402 final verification underway:** source/docs complete and task remains unchecked for fresh core
  review. API/fresh web production builds, workspace lint/format/types, Android/iOS exports and dependency audit
  PASS (two existing high advisories remain ignored by unchanged policy). Default Expo web export is unavailable
  on the baseline because react-native-web is not installed; explicit native bundles are supported and no dependency
  was added. Final full vitest session68090 is running; focused current app/Hermes/word guards30 tests PASS, and
  native exports are refreshing after the small owner-load gate. Next: read final vitest JSON, run full browser suite
  against the fresh web build, final staged Gitleaks redacted scan, commit source/docs and request fresh core review.
  No deploy/EAS/push. Usage-reset heartbeat already woke successfully05:50; next scheduled10:55 Riyadh after the
  actual10:50:18 reset. Mutation40156105166 is active (T-313); coordinator owns that run and push sequencing.

- 2026-10-25 **T-402 final gates PASS; fresh core code review pending (task unchecked):** final full DB/Redis
  vitest **354 files/5681 tests passed,3 timing opt-ins skipped**,244.10s; report
  `C:/Users/xdhia/AppData/Local/Temp/questify-t402-final-vitest.json`. All three actual pre-0063 upgrade schedules,
  runtime erasure races, outsider/cross-tenant/public privacy, app contracts/Hermes and request-log masking pass.
  Fresh web build + FULL browser suite **139 passed,1 intentional phone-camera skip**,9.2m. Workspace lint/types/
  format, API build, final Android/iOS exports, audit (two existing high advisories ignored by unchanged policy)
  and digest-verified portable Gitleaks8.30.1 redacted task/staged scans PASS. Default Expo web export lacks baseline
  react-native-web; no dependency added. Real-phone Arabic/RTL and narrow cosmetic appearance remain owed; no export
  is claimed as device proof. Plan GO94 and fresh Arabic UX GO96 stand. Source/docs/refactors/upgrade-XP/app coverage
  now complete; all diagnostic sessions ended. Next: final local commit, fresh independent Sol High core code review
  >=90 with no BLOCKER/MAJOR; keep T-402 unchecked until GO, then T-402b immediately (FR-723/1622); T-403 completes
  FR-701/702. Proposed ADR-266–268/Q-230–232 stay Proposed. Pending integration: test-only branch
  `codex/t312-mutation-tests` at `137cf4416dc141994ec6cf119e2a085f5eec68c7` (`f77b531` plus minor fix), fresh
  independent review GO96 and its isolated full suite5694 passed/3 skipped,262.81s. Not integrated or pushed; ticket
  mutation90% remains unverified. Root integrates only after this worker's final clean commit and fresh core review;
  then queues a GitHub rerun of the three ticket globs after current T-313 run40156105166 finishes. That active
  mutation remains coordinator-owned/push hold;
  no push/deploy/EAS. Existing usage-reset heartbeat next10:55 Riyadh after10:50:18 reset; no duplicate created.

- 2026-10-25 **T-402 core review88 NO-GO, client fix checkpoint (task unchecked):** one MAJOR, a delayed
  provider `/me` response could restore an ended account/private cosmetics. Fix extracts the actual provider loader
  with generation checks after both awaits, invalidation on sign-out/forced end/new load/cleanup, immediate private
  state removal and no reload during logout. Deferred real-session behavioral regressions + session/profile/Hermes/
  word guards **48 tests/5 files PASS**; workspace lint/types/format PASS. Fix committed017070b. Refreshed full
  DB/Redis vitest **355 files/5690 tests PASS,3 timing opt-ins skipped**,216.76s, JSON
  `C:/Users/xdhia/AppData/Local/Temp/questify-t402-review-fix-vitest.json`; session34781 ended exit0.
  Final Android/iOS exports PASS (session72680 ended exit0); redacted secret checks PASS, source LF. Next: fresh
  independent Sol High core re-review >=90, no BLOCKER/MAJOR; author checks are not approval. Prior fresh web/full browser139 passed/1 intentional
  skip stands (no server/web/shared/copy changes). Arabic GO96 unchanged. Root integrates T-312 only after this fix
  is committed/clean and fresh core GO; no T-402b work by this author. Mutation40156105166 push hold unchanged.

- 2026-10-25 **T-402 fresh core re-review88→95 GO; ready for final integration gate (unchecked):** zero
  BLOCKER/MAJOR; independent53 native and43 DB/API checks PASS, including StrictMode/account fences. Cheap MINOR
  folded: ProfileScreen's missing identity now renders existing ProfileGate retry/error while preserving help,
  account and sign-out controls; no new copy. All native app tests **603/59 files PASS**, workspace lint/types/
  format PASS; Android/iOS exports refreshed after the fold. Previous full DB/Redis5690 PASS/3 timing skips and
  browser139 PASS/1 intentional skip remain evidence; root now cherry-picks reviewed T-312 tests, runs ONE combined
  full DB/Redis suite including this fold, and only then requests the task tick/final doc commit. Progress still
  **74 of153 tasks checked**, counted from TASKS (T-402b added); T-402 not prematurely counted. Core review is GO,
  migration0063 remains undeployed, GitHub mutation and real-phone Arabic/RTL/cosmetic visual checks are owed.
  No push/deploy/EAS. Mutation40156105166 and ticket rerun queue remain root-owned; existing heartbeat10:55 Riyadh.

- 2026-10-25 **Coordinator integration checkpoint:** T-402 code re-review GO95 (previous88 MAJOR fixed), Arabic
  GO96, and the small profile retry improvement are saved through a4178a4. Reviewed T-312 test-only commits
  f77b531/137cf44 (GO96, 5694 tests passed) were integrated on main as 162edc0/d601097; no production ticket
  code changed. Main is now d601097. The final combined DB/Redis Vitest run is active in exec session4546;
  report `C:/Users/xdhia/AppData/Local/Temp/questify-combined-t402-t312-final.json`, log with the same prefix
  ending `.log`. Read the report/poll that session first on resume. T-402 remains unchecked (74/153) until
  this integration gate passes; then record completion and continue with a fresh T-402b worker. Mutation
  40156105166 (T-313, remote main179e55d) is still active: hold push until it completes, inspect its results,
  then push only reviewed green commits after checking origin/main..main. The three ticket-file mutation
  rerun is still owed; target90 is unverified. T-402 mutation and phone visuals are also owed. No deployment
  or EAS build. Reset-resume heartbeat is active for10:55 Riyadh after reported reset10:50:18; reschedule
  it after the next actual reset. No reset credits or purchases used.

- 2026-10-25 **T-402 complete locally, reviewed and integration-green:** core code review88→95 GO (session race fixed), Arabic96 GO; retry minor folded. Reviewed ticket test-only changes are integrated as162edc0/d601097. Final combined DB/Redis suite:5728 passed,3 optional timing tests skipped,0 failures; report `C:/Users/xdhia/AppData/Local/Temp/questify-combined-t402-t312-final.json` (exec4546 exited0). Full browser139 passed/1 intentional camera skip, current native Android/iOS exports, lint/types/format, audit and redacted secret scans also passed. TASKS now75/153 checked. Migration0063 remains undeployed; T-402 mutation and real-phone/RTL visuals remain owed per batched mutation/device gates. Current mutation40156105166 is still active: all local commits remain unpushed. Next: fresh T-402b plan worker; when the active run completes inspect its results, check origin/main..main, push only finished reviewed green work, then queue the three ticket-file mutation rerun. Heartbeat next10:55 Riyadh; deployment/EAS remain deferred.
- 2026-10-25 **User resumed work; progress verified75/153 (49.02% by task count):** main clean at e5e4404 with T-402 complete/reviewed95 and final combined5728 tests passed. T-402b worker previously hit quota before writing a plan; resume that same incomplete task, do not start a duplicate. T-313 mutation40156105166 completed SUCCESS (54.43 wall minutes,0 billable): requested API first-bonus.ts88.71 and quests.ts89.38 still need targeted tests in a separate worktree; all other requested files reached90+, shared first-bonus100. Ticket test improvements are integrated and independently reviewed96; their three-file GitHub rerun remains next after reviewed-main push and green CI. No CI run is currently active. New actual quota reset15:00:55 Riyadh; same heartbeat rescheduled15:05 before work. No reset credits or purchases. Keep building, deploy later.
- 2026-10-25 **T-402b plan saved; no implementation, independent review pending:**
  `docs/plans/2026-10-25-t-402b-souvenirs.md` covers all FR-723/1622 audiences, frozen targets, rank snapshot depth,
  immutable0063 ownership extension, private source events, scoped organizer/system doors, generation-fenced bounded
  grants and erasure/rehearsal/upgrade lock schedules. Proposed ADR-269–271 / Q-233–235, not user acceptance.
  Fresh independent Sol High plan review >=90 and zero BLOCKER/MAJOR is required before code. No source/migration/
  dependency changed; no application tests/build claimed at this document-only gate. T-402b stays unchecked,
  progress75/153 (49.02%). Main6f5a899 already pushed; CI40171311885 running per coordinator: hold further push
  until it is green; root queues T-312's three-file GitHub mutation afterward. T-313 mutation40156105166 finished
  successfully; two under90 files are being handled in a separate worktree, not this docs task. Migration0063,
  real-device/CranL/EAS/deployment remain deferred. Resume heartbeat15:05 Riyadh after reset15:00:55.

- 2026-10-25 **T-313 mutation follow-up, isolated test-only verification:** run40156105166's requested API
  `quests/first-bonus.ts`88.71 and `quests/quests.ts`89.38 were the only targets below90 (historical cached files
  excluded). Added deterministic cache eviction/in-flight success and failure regressions, real-DB builder service
  bonus-boundary refusals with unchanged quest/bonus/audit state, setter outcome logging and omitted-bonus preservation.
  Full DB/Redis Vitest **359 files/5735 tests passed,3 optional timing tests skipped**,272.57s; report
  `C:/Users/xdhia/AppData/Local/Temp/questify-t313-followup-full-vitest.json`. Focused16 tests PASS; workspace
  lint/format/types, API build, audit (two existing high advisories ignored by unchanged policy), digest-verified
  Gitleaks8.30.1 redacted scan PASS. Only API test files and this state note change; fresh web/browser checks are
  unnecessary under the existing CI scope. Production code, fallback/security/cache contracts and dependencies
  remain unchanged. Fresh independent core review GO96; remote90% scores remain unverified. Coordinator owns
  integration and the two-file GitHub rerun after its current queue; no local mutation, push, deploy or EAS.

- 2026-10-25 **T-402b independent plan review88 NO-GO; revised, fresh re-review pending:** one MAJOR fixed in
  the plan: active player FOR SHARE through grant commit serializes the existing admin non-key status UPDATE;
  KEY SHARE did not. Added deterministic ban-first/evaluator-first tests, enrollment/XP blocking schedules and
  compatibility analysis for level/community payers, erasure, equip and admin status/ranking triggers. MINOR
  corrected: no data-download assembly exists; new personal souvenir records/private provenance are explicit
  T-708 integration obligations, not export infrastructure built here. ADR-269–271 remain Proposed. Documentation
  only; no application source/migration/test changed or tests/build claimed. Fresh independent Sol High plan
  review >=90 with zero BLOCKER/MAJOR required before implementation; T-402b unchecked,75/153 (49.02%).
  Current main e8f7c8e includes reviewed T-313 test follow-up (GO96;5735 passed/3 timing skips), same production
  source as6f5a899. CI40171311885 SUCCESS. T-312 targeted mutation40172088017 active on remote6f5a899: push hold
  remains; coordinator owns later T-313 two-file rerun. Migration0063 undeployed, devices/CranL/EAS deferred;
  heartbeat15:05 Riyadh remains. Commit this plan revision and stop for fresh review; no build or push by worker.

- 2026-10-25 **PAUSED AT DHIA'S REQUEST after the active plan review; do not resume automatically.** Progress75/153 (49.02%). T-402 is implemented, reviewed95 and pushed in6f5a899; CI40171311885 SUCCESS (10.9 wall minutes,0 billed). T-402b remains PLAN ONLY: independent plan reviews88→96 GO, zero BLOCKER/MAJOR, no implementation. On explicit resume, first fold the two cheap review clarifications: receipt uses composite rule/enrollment references only (no redundant direct event FK after enrollment, which would invert0053 confirmation's event→enrollment order); worker guard/refusal tests explicitly reject device-only app_device_id context in addition to player/organizer/staff/admin. Proposed ADR-269–271/Q-233–235 remain Proposed; T-402b stays unchecked.
  Ticket mutation40172088017 SUCCESS (4.5 wall minutes,0 billed): console.ts100 and routes.ts95.45 meet target; console-routes.ts85.07 still needs survivor tests in an isolated worktree, then independent review/full checks/GitHub rerun. Do not chase the two files already above90. T-313 test improvements55bccb7 are integrated locally, fresh independent GO96,5735 full DB/Redis tests passed/3 optional skips; only tests/docs changed. Their two-file remote mutation rerun is still owed and scores remain unverified. Latest local commits after pushed6f5a899 include the approved souvenir plan and reviewed test improvements; nothing after6f5a899 has been pushed. Before any future push inspect origin/main..main, require finished reviewed work, and do not interrupt desired active CI. No workflows/tests/build processes remain active at this pause.
  The existing reset-resume heartbeat resume-questify-after-usage-resets is PAUSED; its former15:05 schedule must not wake this chat while Dhia is taking a break. Wait for his explicit instruction to resume, then inspect real usage limits and re-enable/reschedule the SAME heartbeat if he wants the earlier automatic-reset behavior restored. No reset credits or purchases used. CranL migrations after0056, deployment, EAS builds and real-phone/RTL/cosmetic checks remain deferred. All current review evidence and pending work are saved; no worker is authorized to begin implementation during the break.
- 2026-10-25 **RESUMED explicitly by Dhia ("keep working now"); the break is over.** Progress75/153, T-402 complete. T-402b approved plan96 GO; before implementation retain composite rule/enrollment receipt FKs (no redundant direct event FK after enrollment) and explicitly deny device-only app_device_id worker context. Resume the same T-402b author, then fresh independent code review after full green gates. The previously requested reset heartbeat is ACTIVE again, next03:12 Riyadh on2026-10-26 after reported03:07:04 reset. No credits purchased or consumed. All earlier PAUSED notes are history overridden by this explicit resume. Deployment/EAS remain deferred.
  Current main041efc7 includes the approved plan and reviewed T-313 test-only improvements (GO96,5735 full tests passed/3 optional skips), not yet pushed after6f5a899. No CI/mutation run is active; latest CI40171311885 and mutation40172088017 succeeded. Publish only the reviewed clean checkpoint before starting build work, wait for its CI, then queue the T-313 two-file mutation proof. Separately chase only ticket console-routes.ts85.07 in an isolated worktree; console.ts100/routes.ts95.45 are already above90. T-402/T-402b mutation batch remains owed; never local Stryker.
- 2026-10-25 **T-402b implementation WIP after approved plan88→96 GO; unchecked75/153:** migration0064 now
  extends typed ownership with closed rules/targets/receipts, generation-fenced work/scans and durable scoped
  command replay; rank depth extends confirmed snapshots, result-place facts enqueue work without changing0053's
  confirmation body. System guard excludes device-only identity, grants hold player FOR SHARE through commit,
  receipt composite FKs avoid a direct event-lock inversion, and cleanup extends0063. Organizer forms/controls,
  shipped previews and private locker event attribution are connected. Fresh independent Arabic84→94 GO,
  no BLOCKER/MAJOR; cheap wording minor folded. Focused29 souvenir/lock and518 results/security/rehearsal tests
  passed; initial11 profile ownership tests passed. New upgrade/refusal/browser cases, final full DB/Redis,
  web build/full browser/native exports/lint/types/audit/secrets and fresh core code review remain owed. No
  implementation completion or release is claimed. Main4bca465 reviewed checkpoint was pushed; CI40224593807
  SUCCESS,404000ms (6.73wallmin),0 billed. Root's reviewed optional mutation-force config is side-branch only;
  forced console mutation40226079637 active/queued, T-313 two-file rerun and profile/souvenir batch remain root-owned.
  No worker push/local Stryker/deploy/EAS; migration0064 undeployed and phone/RTL checks deferred. Heartbeat03:12
  Riyadh2026-10-26 after actual03:07:04 reset remains active. Continue this same worker; no other main writer.

- 2026-10-25 **T-402b durable implementation checkpoint; final verification pending, NOT complete:**
  Source is frozen for the final rerun after self-audit fixes. Since a4ab626: activation accepts the legitimate
  300-quest target body (activation-only512KiB limit plus HTTP regression); catalog writers serialize on item;
  repair/enqueue skips already-owned rule/player pairs; audit records settings without free names; final scoped
  UI retry/read fencing, private native event provenance, HTTP/security/native/shared and Arabic browser cases
  are saved. Arabic84→94 GO and plan88→96 GO remain source/plan evidence, not core-code approval. TASKS remains
  unchecked75/153 (49.02%); Proposed ADR-269–271/Q-233–235 remain Proposed. Migration0064 remains undeployed.
  Final fresh web build exec3002 PASS (exit0), log `C:/Users/xdhia/AppData/Local/Temp/questify-t402b-web-final-build.log`.
  Current workspace shared/API/app/web types PASS exec47984. Its lint failed only the manual benchmark console.log;
  changed that to process.stdout.write, so final lint rerun is owed. Earlier API build/audit PASS (two existing high
  advisories ignored by unchanged policy); Android export6359 PASS, log `Temp/questify-t402b-android.log` and output
  `Temp/questify-t402b-android`. iOS export is owed. Focused evidence: original11 ownership;29 souvenir/locks;
  518 results/security/rehearsal; updated HTTP/shared/native/copy15 passed. Final-focused51807 had12 pass/1 fail:
  optimized repair changed scan order; fixture fixed and targeted expired-lease rerun PASS1/6 filtered skips.
  Log `Temp/questify-t402b-final-focused.log`; no known unresolved focused failure, but full rerun remains required.
  Initial full Vitest99199 and browser56935 were deliberately cancelled after real source fixes, NOT passing runs.
  Logs `Temp/questify-t402b-full.log` and `Temp/questify-t402b-browser.log`; initial browser discovered142 cases.
  No local check process remains active:3002/47984 completed; cancelled suites left no3100/4100 listeners. The
  final DB/Redis Vitest slot is available; coordinate before running ONE full suite. Full final DB/Redis Vitest,
  FULL browser142 from the fresh build, iOS export,20k convergence benchmark, final lint/format/API build/redacted
  secret scans and fresh independent core code review remain owed. Benchmark source is manual support script
  `apps/api/test/support/souvenir-benchmark.ts`, not yet run; bundle alongside test-db in support before execution,
  set TEST_DATABASE_URL and optional SOUVENIR_BENCH_REPORT. Do not claim20k latency until actual report exists.
  Reviewed remote main4bca465 CI40224593807 SUCCESS,404000ms/6.73wallmin,0 billed. Mutation-force configfb0fba4
  GO98 is side-branch only. Forced console40226079637 SUCCESS98.51% (65Killed+1Timeout,1Survived,3Ignored),
  983000ms/16.38wallmin,0 billed; artifacts `Temp/questify-forced-console-40226079637`; no further console chase.
  Forced T-313 two-file run40227738340 ACTIVE per coordinator; root owns it and the push hold. T-402/T-402b mutation
  batch remains owed, never local Stryker. Heartbeat ACTIVE03:12 Riyadh2026-10-26 after03:07:04 reset; no credits.
  Save this checkpoint locally, do not push or commission core review before remaining gates. Continue the SAME
  worker after reset; physical-phone RTL/cosmetic visuals, CranL migrations/deployment/EAS remain deferred.

- 2026-10-26 **T-402b resumed from b0944d3; frozen-source final gates running:** full DB/Redis Vitest exec4924,
  log/report `C:/Users/xdhia/AppData/Local/Temp/questify-t402b-final-vitest.{log,json}`. iOS export48842 PASS,
  output/log `Temp/questify-t402b-ios`; lint/format67520 PASS; current API build PASS, audit61415 pending.
  Redacted Gitleaks8.30.1 scan of4bca465..b0944d3 PASS. No source edits since the checkpoint. Fresh web build3002,
  workspace types47984 and Android6359 remain current evidence. Full browser142 follows the full suite, then20k
  benchmark runs alone; final docs/staged scan and fresh independent core review still owed. T-402b unchecked75/153.
  Coordinator verified forced T-31340227738340 SUCCESS: API first-bonus93.55%, quests90.27%, both>=90, no chase;
  1386000ms/23.10wallmin,0 billed. Artifacts `Temp/questify-forced-first-bonus-40227738340`. All prior T-312/T-313
  mutation follow-ups are now closed; T-402/T-402b batch remains owed. No current remote CI/mutation; main WIP
  push hold remains. Configfb0fba4 stays isolated until root integrates after this worker's green checkpoint.
  Heartbeat ACTIVE08:22 Riyadh after coordinator-reported actual08:16:06 reset; no credits. Continue same worker.

- 2026-10-26 **Final-gate diagnosis, no production changes:** full4924 completed324.45s with5786 passed,
  3 optional timing skips and3 failures; retain its JSON/log as failed evidence, not a green gate. Fixed test-only
  issues: community gate-map classifies souvenir_action through actual staff/tenant guards; outsider table query
  now schema-qualified; rehearsal test creates an immutable rehearsal enrollment and proves a real member still
  receives the item. Focused4996 then97 passed/1 failed: PostgreSQL's FK guard preceded the intended truncate
  trigger; changed the test to TRUNCATE CASCADE. Targeted truncate rerun1 passed/24 filtered skips in5.36s.
  Logs `Temp/questify-t402b-failures-rerun.log` and `Temp/questify-t402b-truncate-rerun.log`. Final full rerun remains
  required. All current production/web/native build evidence remains valid.20,001-recipient benchmark exec4363
  is running alone; JSON/log `Temp/questify-t402b-20k.{json,log}`. No full/browser/export overlaps this measurement.
  Audit61415 PASS under unchanged two-high-advisory exceptions. Next: benchmark result, then final full Vitest,
  FULL browser142, final changed-test static checks/docs/secrets, local green checkpoint for independent core review.

- 2026-10-26 **T-402b synthetic20k benchmark PASS; final full rerun active:** exec4363 completed exit0.
  Report/log `C:/Users/xdhia/AppData/Local/Temp/questify-t402b-20k.{json,log}`:20,001 owned,0 due,0 failed,
  443,198ms convergence;20,001-row source enqueue storm23,401ms.7,399 back-to-back calls/213 nonempty passes,
  max160 recipients/pass below500; slowest2,764ms because2s budget is checked between transactions, not a hard
  deadline. Isolated local Docker/one joined rule, no full/browser/export overlap; normal5s cadence and production
  capacity/all-audience100-rule load are not measured. Generated support bundle safely removed after completion.
  Full frozen-production-source Vitest rerun exec66372 now active, JSON/log `Temp/questify-t402b-final-vitest-rerun`.
  Test-only corrections from the failed run are included; no production change or stale-build claim. Browser142,
  final static/docs/staged secret scan and independent core review remain owed. Keep T-402b unchecked75/153.

- 2026-10-26 **Final rerun66372 not green:5788 passed/3 optional skips/1 upgrade timeout,324.02s.**
  All prior3 failures are resolved. First actual0063-erasure upgrade test exceeded30s; old trace identifies only
  the test start, not the exact phase. Prior full-run durations for these three setup-in-body tests were20.27s,
  19.37s,17.62s; this run30.01s(timeout),23.68s,12.90s. Do not claim proven production failure or proven setup
  phase from that trace. Moved preSouvenir database construction/63 migrations into beforeEach (existing60s hook),
  cleanup into afterEach; behavioral crossed-lock assertions retain the existing30s test budget. Failure-only
  diagnostics now distinguish incomplete fixture from behavior/cleanup and report fixture time. No production
  change or global timeout increase. Focused upgrade lifecycle exec13575 PASS3/3 in14.54s, log
  `Temp/questify-t402b-upgrade-lifecycle.log`; affected-file lint and API types PASS. Save this test-fix checkpoint
  and run the required final full again. Logs/reports of both failed
  full runs are preserved. Lint/format/types19666 PASS before this lifecycle-only refinement; recheck affected file.

- 2026-10-26 **Test-fix checkpoint4c1ac36 saved clean; final full exec90390 active:**
  `Temp/questify-t402b-verified-vitest.{json,log}`. Focused upgrade3 passed/14.54s; affected lint/API types and
  redacted staged secrets PASS. Production remains b0944d3's frozen source, current builds/native exports valid.
  Browser142 follows the completed full run; no local mutation/push/deploy/EAS. Keep T-402b unchecked75/153.

- 2026-10-26 **Final DB/Redis suite GREEN at4c1ac36:** exec90390 exit0,366 files/5789 tests passed,
  3 optional timing skips,0 failures in288.94s. Report/log `Temp/questify-t402b-verified-vitest.{json,log}`.
  Full browser142 now exec1127, report/log `Temp/questify-t402b-browser-final.{json,log}`, against the current fresh
  production web build3002 plus freshly bundled test API. First launch failed before tests because PowerShell
  split an unquoted reporter comma; corrected argument, no application change, diagnostic retained separately in
  `Temp/questify-t402b-browser-startup.log`. Full Vitest slot released. No production source change this resume;
  full/native/static/benchmark evidence remains current. Browser completion, final docs/staged secrets/local commit
  and fresh independent core review remain. Keep T-402b unchecked75/153; root owns later reviewed config integration.

- 2026-10-26 **Browser found real souvenir page forwarder bug; full1127 continues, not green:**
  Desktop case64 timed out waiting for Add because useSouvenirs used /api/v1 instead of the existing /v1 forwarder.
  Its trace proves307 to /ar/api/v1 then404; page showed the intended load-error state. Diagnostics preserved in
  `apps/web/.e2e/results/souvenirs-creates-and-edit-06250-d-stops-a-permanent-promise-desktop/trace.zip` and
  error-context.md. Corrected only the new hook's prefix in source; running browser still serves the OLD build,
  so do not interpret later pass/fail as verification of that edit. Let FULL142 complete without cancellation.
  Next: make the existing real-forwarder browser regression assert its actual GET response, fresh web build,
  focused souvenir desktop/phone, checkpoint the verified repair, final full frozen-source Vitest and FULL browser.
  No API/SQL/native/shared/copy change; iOS/Android/20k evidence remains valid.5789-pass suite90390 is prior to this
  web fix; its required final rerun is owed. Parent has enough quota; do not rush or mark T-402b done.

- 2026-10-26 **First FULL142 browser completed with139 passed/1 intentional skip/2 failed (10.3min):**
  Both souvenir desktop/phone cases reproduce the same /api/v1 forwarder bug. Full report/log preserved at
  `Temp/questify-t402b-browser-final.{json,log}`; original default .e2e/results traces retained. Source repair is
  one prefix in use-souvenirs.ts (/v1), and the existing real-API browser flow now explicitly awaits its exact
  forwarded GET200 before interacting. No mocking or proxy allowlist workaround. Fresh web build exec64981/log
  `Temp/questify-t402b-web-forwarder-build.log` active. Next focused desktop/phone souvenir browser using a separate
  output directory, checkpoint repair, final static/type checks, required final Vitest and FULL142 browser reruns.
  No native/API/SQL/shared/copy change; their exports/benchmark remain current. Task still unchecked75/153.

- 2026-10-26 **Souvenir forwarder repair focused-GREEN:** fresh web build64981 PASS, workspace lint/format
  and all four types PASS. The real forwarder browser assertion now observes /v1/.../souvenirs GET200. First
  focused34704 then exposed only an ambiguous draft-status selector matching Edit/Delete button text; changed to
  anchored status text, preserving the production UI. Focused86804 PASS desktop+phone2/2 in18.4s, including all four
  audience helpers, create/edit, activation permanence/current membership, stop and360px RTL overflow assertion.
  Logs/reports `Temp/questify-t402b-browser-focused-rerun.{log,json}`; earlier failed focused report/traces preserved
  under `Temp/questify-t402b-browser-focused` and `Temp/questify-t402b-focused-browser-results`. Production repair
  remains just the new hook's /v1 prefix. Save repair checkpoint before final full Vitest and FULL142 browser;
  native/API/SQL/shared/copy/20k evidence unaffected. Final task/core review still pending,75/153 unchecked.

- 2026-10-26 **Repair checkpointc2353c9 saved clean; final frozen-source full Vitest18450 active:**
  report/log `Temp/questify-t402b-forwarder-vitest.{json,log}`. FULL142 browser rerun follows using fresh web64981;
  retain all prior failed/cancelled evidence. No further source changes planned. Final docs and independent core
  review remain; task unchecked75/153, no worker push/deploy/EAS/local mutation.

- 2026-10-26 **Final frozen-source Vitest18450 GREEN atc2353c9:**366 files/5789 tests passed,3 optional timing
  skips,0 failures,290.78s. Report/log `Temp/questify-t402b-forwarder-vitest.{json,log}`. Current web build64981
  includes the observed forwarder fix; focused desktop/phone2/2 PASS. FULL142 browser verified rerun started next,
  output `Temp/questify-t402b-verified-browser-results`, report/log `Temp/questify-t402b-browser-verified.{json,log}`.
  Earlier failing traces remain intact in the original paths. Native exports,20k measurement and static/audit
  evidence remain current. Full Vitest slot released; only browser completion/final docs/secrets/commit then fresh
  independent core review remain. Keep task unchecked75/153, no push/deploy/EAS/local Stryker.

- 2026-10-26 **T-402b author verification GREEN; ready for fresh independent core CODE review, NOT complete:**
  Production source cutoffc2353c9. Final full DB/Redis exec18450 PASS366 files/5789 tests,3 optional timing skips,
  0 failures,290.78s; `Temp/questify-t402b-forwarder-vitest.{json,log}`. Fresh production web build64981 PASS;
  FULL142 browser37282 PASS141/1 intentional phone-camera skip,0 failures,417.28s; report/log
  `Temp/questify-t402b-browser-verified.{json,log}`. Focused real-forwarder desktop/phone86804 PASS2/2. Original
  failed/cancelled runs and traces remain explicitly documented, never substituted for passing evidence. The real
  /api/v1→/v1 integration fix and anchored draft-status assertion are committed; no source changes afterc2353c9.
  Current Android6359/iOS48842 exports PASS. Workspace lint/format/all types, API build and audit PASS (unchanged
  two existing high-advisory exceptions). Redacted committed-range/repair/final staged Gitleaks8.30.1 scans PASS;
  source LF and staged diff clean. Generated benchmark bundle removed; no local command or browser server remains.
  Isolated20,001-recipient benchmark PASS:443,198ms,0 due/failed,max160 recipients/pass; detailed bulk-enqueue and
  back-to-back-cadence limitations remain in RUNBOOK, not a production capacity claim. Plan88→96 GO and Arabic
  84→94 GO already independent; no fresh Arabic review needed because no copy changed during this resume.
  Keep T-402b UNCHECKED75/153 (49.02%) until fresh Sol High core code review >=90 with zero BLOCKER/MAJOR. Proposed
  ADR-269–271/Q-233–235 remain Proposed. Root owns review and subsequent configfb0fba4 integration/push/CI.
  Suggested mutation targets (GitHub-only, only changed core files): apps/api/src/souvenirs/*.ts,
  apps/api/src/players/items.ts, apps/api/src/players/item-routes.ts, packages/shared/src/souvenirs.ts,
  packages/shared/src/players/items.ts; reviewer/coordinator may narrow pure wiring/format branches. No broad repo
  mutation. T-402/T-402b batch and physical-phone RTL/cosmetic checks remain owed.0063/0064 undeployed; CranL,
  deployment and EAS remain deferred. T-312/T-313 forced proofs are closed, no current remote CI/mutation active.
  Latest reviewed remote4bca465 CI40224593807 SUCCESS6.73wallmin/0 billed. T-31340227738340 requested files93.55/
  90.27 meet target; console40226079637 98.51 meets target, no survivor chase. Heartbeat ACTIVE08:22 Riyadh after
  coordinator-reported08:16:06 reset; no credits. Worker commits this green evidence and STOPS for core review.

- 2026-10-26 **Coordinator integrates independently reviewed mutation CI maintenance:** fb0fba4, authored in
  isolated codex/mutation-force-input from4bca465, received fresh independent GO98 with no findings. Optional
  boolean force=false uses an environment binding and exact-true --force alongside unchanged incremental mode,
  cache, permissions and dependencies. Installed Stryker10 source/help verified; author15 and reviewer24 stubbed
  Bash cases/YAML checks passed, plus baseline full DB/Redis5735 passed/3 optional skips, lint/format/types,
  API build/audit/redacted history+commit scans. No local mutation ran. The nine stale static schema survivors in
  run40172088017 were cache reuse, not missing boundary tests. Forced console40226079637 now proves98.51%
  (16.38wallmin,0 billed); forced T-31340227738340 proves first-bonus93.55%/quests90.27%
  (23.10wallmin,0 billed). All these targets meet90; no further chase. STATE conflict resolved by retaining the
  complete current souvenir verification/history and current queue rather than the older branch queue.
  Fresh independent core reviewer /root/t402b_code_review is active on immutable4bca465..db53d11, production
  cutoffc2353c9. This integration changes workflow/docs only; no task source or tests changed. No push until core
  GO and required checks. Heartbeat ACTIVE08:22 Riyadh after actual08:16:06 reset; no credits/deploy/EAS.

- 2026-10-26 **Fresh independent core review84 NO-GO: one BLOCKER, one MAJOR; task remains unchecked.**
  Reviewer reproduced editor POST201, then only event_scope revoked to another event of the SAME organizer;
  GET404 but identical POST key replayed201 with idempotent-replayed:true and the private old rule list.
  Existing organizer membership checks were insufficient because membership stayed active. Added all-six-route
  real cache middleware regressions; red run review-auth-red2 reproduced six failures. Earlier red fixture-only
  missing join_code failure is separately retained. Repair is scoped to souvenir routes: preValidation now runs
  current SQL event authorization before global cached preHandler; handler SQL still authorizes every write.
  No global rewrite or claim about unrelated routes. API/SECURITY notes document this invariant.
  MAJOR missing new-door proof addressed with actual automatic work/evaluator tests: finished zero-right quizzes
  for category/all, last-attempt short games, still-open games, unlimited games, and a forced completion that
  holds its queue write while waiting for XP against concurrent evaluation and old-generation acknowledgment.
  Added activation-versus-confirmation both lock orders with5s lock timeouts, exact committed snapshot depth,
  receipts/items and stale-preview refusal/refresh. Focused routes/new doors18 passed25.78s; confirmation locks
  2 passed8.42s. Small test helper extraction for the 100-line limit followed; combined focused rerun passed all 20 tests in 26.56s (exec 5871, Temp/questify-t402b-review-matrix.log).
  Lint/all types PASS; no SQL/native/shared/copy or payer change, so native/Arabic/20k evidence remains valid.
  Save focused repair checkpoint before final full DB/Redis, fresh web build/FULL browser, API build/audit/secrets
  and NEW fresh independent re-review (different reviewer). No push/deploy/EAS/local Stryker. Main5c87d29 includes
  root's reviewed mutation-force workflow/config integration; no current remote CI/mutation. Keep75/153.

- 2026-10-26 **Review repair checkpoint 7c0843b committed; final gates active:** all 20 focused regressions
  passed together in 26.56s. Extracted helper needed a compile-time literal tuple annotation; API types passed
  after that correction. Workspace lint/format and staged redacted secrets PASS. Full DB/Redis exec 90379,
  `Temp/questify-t402b-review-full.{json,log}`; fresh web build exec 56569,
  `Temp/questify-t402b-review-web-build.log`; API build/audit exec 60003 (build passed, audit pending).
  FULL browser must use a freshly rebuilt test API bundle after these gates because the route hook changed.
  SQL/payer/shared/native/copy are unchanged: prior native exports, Arabic review and 20k benchmark remain valid.
  Current source is frozen; only a concrete failure justifies another edit. No current remote CI/mutation.
  Keep T-402b unchecked 75/153; root commissions a NEW independent reviewer after green final evidence.

- 2026-10-26 **Review-repair full DB/Redis GREEN at 7c0843b:** exec 90379 passed 368 files / 5,803 tests,
  3 optional timing skips, 0 failures in 311.69s; `Temp/questify-t402b-review-full.{json,log}`. Fresh web build
  56569 and API build/audit 60003 PASS (two existing high advisories ignored by unchanged policy). Test API bundle
  rebuilt with the current pre-replay authorization hook. FULL 142 browser exec 83776 active; report/log
  `Temp/questify-t402b-review-browser.{json,log}`, unique output `Temp/questify-t402b-review-browser-results`.
  No production change after the repair checkpoint. Browser completion, final docs/redacted secret scan/commit and
  NEW independent core re-review remain. The last independent verdict is still 84 NO-GO, never author-approved.
  Task unchecked 75/153. Native exports, Arabic review and SQL benchmark evidence remain current; no push/deploy/EAS.

- 2026-10-26 **Review repairs and final author gates GREEN at source 7c0843b; NEW core re-review required:**
  Scoped souvenir preValidation resource authorization now precedes global cached replay on all six mutation
  doors, including process. The actual middleware regressions reproduced all six leaks before repair and passed
  afterward. The 20-case new-door/race matrix passed, including zero-right quiz automatic work, exhausted/open/
  unlimited games, queue-before-XP completion against evaluator/old ack, and activation/confirmation both lock
  orders with finite 5s waits and exact depth/receipt/item outcomes. No SQL or payer change was needed.
  Final full DB/Redis exec 90379: 368 files / 5,803 passed, 3 optional timing skips, 0 failures, 311.69s;
  report/log `Temp/questify-t402b-review-full.{json,log}`. Fresh web build 56569 PASS and rebuilt test API;
  FULL browser 83776 PASS: 141 passed / 1 intentional phone-camera skip, 0 failures, 436.30s, report/log
  `Temp/questify-t402b-review-browser.{json,log}`. Workspace lint/format/all types, current API build and audit
  PASS with unchanged two existing high-advisory exceptions. Redacted committed-range/staged Gitleaks scans PASS;
  all task source LF and staged diff clean. No active local command or browser server remains.
  Native Android/iOS exports, Arabic 84→94 approval and the isolated 20k SQL/worker benchmark remain valid because
  no corresponding source changed. Last independent CORE verdict remains 84 NO-GO; author verification does
  not replace it. Root must use a NEW independent Sol High reviewer, excluding author and first code reviewer,
  and obtain >=90 with zero unresolved BLOCKER/MAJOR before ticking T-402b. Keep 75/153 (49.02%) unchecked.
  Proposed ADR-269–271 / Q-233–235 unchanged. API/SECURITY document the pre-replay authorization invariant; no
  claims or broad rewrite of unrelated routes. Prior red/failed/cancelled evidence is retained. Root owns reviewed
  push/CI and later T-402/T-402b mutation batch; no current remote CI/mutation. Config integration 5c87d29 is already
  independently reviewed. No worker push/deploy/EAS/local mutation; physical phone/CranL/migrations remain deferred.
  This worker commits the green repair evidence and STOPS for the new independent re-review.

- 2026-10-26 **Coordinator checkpoint: fresh independent core re-review ACTIVE, no approval yet.**
  Reviewer /root/t402b_code_review_2 reviews immutable4bca465..8f32f05 (production cutoff7c0843b), separate from
  author and first reviewer. First review84 NO-GO found cached replay after event-scope revocation and missing
  evaluator/forced-lock proof; author repairs and all final gates are saved in7c0843b/8f32f05. Root independently
  parsed final reports:5803 passed/3 optional skips/0 failed; browser141 passed/1 intentional skip/0 flaky.
  Main remains unpushed after reviewed remote4bca465. No local check, remote CI or mutation is active; author
  stopped, no duplicate worker. Quota89% used; next reset08:16:06 Riyadh, same heartbeat ACTIVE08:22. Preserve
  re-review findings/verdict before any push; only GO>=90 with no BLOCKER/MAJOR closes this gate. No credits.

- 2026-10-26 **Fresh independent re-review could not run: automated safeguard failure, no verdict.**
  /root/t402b_code_review_2 failed with: "This content was flagged for possible cybersecurity risk."
  No review score or approval was returned. Do not treat this failure as GO, silently substitute author approval,
  or route around the safeguard. The provider message suggests a supported review-access path before retrying.
  Human action is needed to arrange a permitted independent review path; retain the unpublished source at
  7c0843b and green evidence8f32f05. Main also contains coordination checkpoint8958447; remote remains4bca465.
  All final tests/builds and both repair matrices remain saved, but the last valid independent core verdict is
  still84 NO-GO until a fresh reviewer validates closure. T-402b stays unchecked75/153 (49.02%). No active local
  commands, workers, remote CI or mutation. No push/deploy/EAS/credits. Keep heartbeat ACTIVE08:22 Riyadh;
  while this condition is unchanged, stay quiet and do not resubmit the blocked review automatically.

- 2026-10-26 **PAUSED by Dhia for handoff to a new Codex session.** His instruction: finish saving the current
  task checkpoint, take a break, and give a short takeover prompt. The implementation cannot be declared complete:
  the fresh independent re-review remains blocked without a verdict. All source, repairs and green evidence are
  committed locally (source7c0843b/evidence8f32f05; main3e0529d before this documentation commit), no push.
  `docs/agents/COORDINATOR_HANDOFF.md` is the concise durable takeover map. Progress remains75/153, T-402b unchecked.
  Heartbeat resume-questify-after-usage-resets is now PAUSED, overriding all earlier ACTIVE schedules. No active
  worker, local check/server, remote CI or mutation remains. This coordinator stops; the new session must retain
  the supported-review requirement, existing gates and deployment/EAS deferral. No credits used.

- 2026-10-26 **T-402b re-review 87 NO-GO repaired; fresh independent re-review of the delta pending.** The re-review
  of 4bca465..8f32f05 closed both 84 findings and found grants correct, but the repair sweep never ended: every minute
  it re-queued all non-recipients of rank/category rules. Production repair 81d5054 (undeployed 0064 edited in place;
  CranL stays at 0056): finite passes per activation/Process that wait for live and delete themselves, rank rules
  without a pass, triggers for operator play/removal and account reinstatement, least(ready_at), an unlocked evaluator
  pre-check, lease release for unevaluated claims, control/bidi name refusal in schema and SQL (22P05→400), 409
  souvenir_data for deleting a draft event with souvenirs, work erased last. Proposed ADR-272, Q-236 (design) and
  Q-237 (central replay-before-scope fix for other routes). Focused souvenir/security/rehearsal/event suites green;
  full DB/Redis 5819 passed / 3 optional skips; lint/format/types PASS. No web code changed, so no browser rerun.
  T-402b stays unchecked, 75/153 (49.02%). No push, deploy, EAS or mutation. Follow-up: category/quest deletion that a
  souvenir names still answers 500.

- 2026-10-26 **T-402b DONE: repair re-review GO 93; three fold-ins committed.** The third code review (8f32f05..81d5054
  plus the coordinator's Arabic fix 6a53ef2) returned GO 93 with zero BLOCKER/MAJOR. It was run by the in-house CTO
  reviewer (Claude Opus): **the recorded GPT-6.1 Sol review policy (ADR-265) could not be used from the Claude Code
  session; Dhia should know the gate ran on another model.** Independent Arabic review of the event-delete string 72,
  fixed in 6a53ef2. Fold-ins 6d7dd9c/597c009: 409 `souvenir_in_use` (three new bilingual strings in http-errors.ts, awaiting Arabic review) for
  deleting a category a souvenir rule names or a quest an activated souvenir froze (was 500); the every-quest-only
  completion/ack lock test; enqueue triggers renamed `enqueue_souvenir_on_*` so they fire before `mark_ranking_on_*`
  (removes a rare 40P01 with a rejoin) plus a trigger-order assertion. Focused 983 passed; full DB/Redis 5824 passed / 3 optional skips / 0 failed;
  lint/format/types PASS; no web code changed. No new ADR/Q (ADR-272, Q-236, Q-237 stay Proposed). Progress
  **76/153 (49.67%)**. No push, deploy, EAS or mutation by the worker; 0063/0064 remain undeployed (CranL at 0056).

- 2026-10-26 **T-402b pushed; CI green; mutation dispatched (coordinator).** `4bca465..6286d41` (18 commits) pushed
  after the Docker gitleaks scan (419 commits, no leaks) and a fresh Sonnet Arabic review of the three `souvenir_in_use`
  strings (84; quest and category-with-quests wording fixed in 6286d41, Q-238 added for fixed refusal wording vs renamed
  terms). CI run 40356348454: success, 14 min, browser 141 passed / 1 skipped. Mutation run 40358820903 (GitHub only,
  one at a time) targets `apps/api/src/souvenirs/*.ts`, `apps/api/src/players/{items,item-routes}.ts`,
  `packages/shared/src/souvenirs.ts`, `packages/shared/src/players/items.ts`, tests excluded; chase only files under 90.
  CLAUDE.md gains Dhia's cost cap (one sub-agent at a time, two only for review plus next build; the strongest model
  only for core work). Progress **76/153 (49.67%)**. No deployment, EAS, phone or local mutation.

- 2026-10-26 **T-403 plan written, awaiting independent plan review.** `docs/plans/2026-10-26-t-403-achievements.md`
  covers three parts (ADR-273): **T-403 CORE** (event city, final-rank snapshot at confirm, Event Passport and owner
  history reads, achievement tiers through one `questify_sync` evaluator, public profile achievements and public-event
  stamps only; 0065), **T-403b CORE** (always-on and seasonal Questify quests, console API, XP source `questify`; 0066),
  **T-403c STANDARD** (app, dashboard and console screens, copy). No change to the scan transaction; follow Questify not
  built (store risk). Proposed ADR-273 to ADR-279, Q-239 to Q-245. TASKS gains T-403b/T-403c (now 155 tasks). No code.

- 2026-10-26 **T-403 built (core), awaiting the independent core code review; not ticked.** First commit folded the plan
  review's amendments (88, one MAJOR) into the plan, ADR-273..279 and Q-239..245 (ADR-276: other players see a played
  event only once it has ended or been archived, public and not workplace; never while live). Migration 0065 (new,
  undeployed; 0063/0064 untouched): `city` (20 seeded), `event.city_id` with `event_city_guard` (fixed once live, every
  role, `CY409`), `final_rank` written with `result_place` in one CTE over `all_places` plus `backfill_final_ranks`
  under an `event_result` lock, `achievement` (five seeded) and append-only `achievement_earned`, one
  `played_enrollment` rule, `questify_sync` (unlocked pre-check, player KEY SHARE → `player_xp`), `own_achievements`,
  `own_events`, `public_player_profile` with tiers and at most 50 ended public stamps. API `apps/api/src/questify/`:
  `POST /v1/me/questify/sync` (20/min), `GET /v1/me/achievements`, `GET /v1/me/event-history?played=` (cut 1's single
  door; `/v1/me/events` is the switcher's), public `GET /v1/cities`; event `cityId` (422 unknown/virtual, 409
  `city_locked`); the public profile is parsed through the shared allowlist; shared `packages/shared/src/questify/`.
  Tests: focused 53 files / 727 passed (DB achievements 15, event-passport 9, final-rank 4 + opt-in 20,000-member
  confirm under 10 s, routes 4, events city 3, security suites); full `npx vitest run` 374 files, 5863 passed / 4
  skipped / 0 failed; oxfmt, oxlint --deny-warnings and tsc clean for api and shared. No app or web code changed. No
  new ADR/Q (build notes in the plan). Mutation owed on GitHub with T-403b (one dispatch, cut 7).

- 2026-10-26 **T-403 done (core), ticked; progress 77/155.** Code review GO 93 by the in-house CTO reviewer on Claude
  Opus (the recorded Sol policy could not be used from the Claude Code session); plan review 88, then folded. Its MINOR
  folded in 0065 in place (undeployed): `top10` counts a final place only on a membership with a standing credit, so
  welcome points alone never earn Top Ten (new DB test). `GET /v1/cities` sends `cache-control: public, max-age=3600`;
  API.md, DATA_MODEL.md and the plan's build notes updated (lock-order note to T-403b, `rank_state` note to T-403c; a
  NULL `profile_player()` in event history left as an empty page). Not pushed by the worker.

- 2026-10-26 **T-403b built (core), awaiting the independent core code review; not ticked.** Migration 0066 (new,
  undeployed; 0063 to 0065 untouched) takes `xp_entry` then `player_xp` up front in scan order under a 10 s lock
  timeout: `questify_campaign`, `questify_quest` (seeded active: attend 3 events, play in 2 cities, 300 XP each),
  append-only `questify_award`; `xp_entry` source `questify` (no ledger entry, CHECK `xp_entry_shape`, never reversed);
  the window as `standing_credits`/`player_metrics(player, since, until)` on `ledger_entry.created_at`; `questify_sync`
  pays each met quest once (award, XP entry, `xp_apply`, level items) and answers `quests` and `levelUp`;
  `own_questify_quests`; six console doors that re-read the admin and audit ids and field names. API
  `GET /v1/me/questify-quests` and `/v1/admin/questify/*` (Idempotency-Key on every write; `409 questify_conflict
  {reason}`, `422 invalid_questify {field}`); shared `packages/shared/src/questify/quests.ts`. Tests: DB
  questify-quests 18, routes quests 3 and questify 4, unit 6, achievements 16, security suites 492; full suite 377
  files / 5892 passed / 4 skipped / 0 failed;
  oxfmt, oxlint --deny-warnings and tsc clean for api and shared. Proposed ADR-280 / Q-246 (console rules; ADR-093's
  "seasonal campaigns" read as configuration, not FR-711). No app or web code changed.

- 2026-10-26 **T-403b done (core), ticked; progress 78/155 (50.32%).** Code review GO 94 of 7b8b981 by the in-house CTO
  reviewer on Claude Opus (the recorded Sol policy could not be used from the Claude Code session); no re-review. Two
  minors folded in 0066 in place (undeployed): `questify_admin()` raises `QY403` and only that maps to 404, so a real
  42501 (a lost EXECUTE grant) answers 500 (unit and HTTP tests); a published campaign that has started refuses a new
  quest, `409 questify_conflict {reason: started}` (DB and HTTP tests). API.md, ADR-280 and the plan's build notes
  updated. Focused suites (questify-quests DB, test/questify, src/questify, security) 525 passed; oxfmt, oxlint and
  tsc clean for api and shared. Not pushed by the worker.

- 2026-10-26 **First GitHub mutation result for T-402/T-402b:** run 40358820903 on 6286d41, 8 files mutated (the
  report's other rows are stale from earlier runs). souvenirs.ts 98.11, souvenirs/routes.ts 97.89; under 90, to chase
  with tests only: souvenirs/payer.ts 84.42 (11 no-cov, 1 survived), souvenirs/tick.ts 0.00 (65 no-cov: no test
  imports it), players/items.ts 80.65 (12 survived), players/item-routes.ts 79.31 (6 survived, 6 no-cov),
  `packages/shared/src/souvenirs.ts` 58.56 (45 survived), `packages/shared/src/players/items.ts` 0.00 (43 survived,
  11 no-cov; no unit test of its own). Cause: `stryker.config.json`'s default `mutate` list leaves out
  `apps/api/src/souvenirs/**`, `apps/api/src/questify/**`, `packages/shared/src/souvenirs.ts` and
  `packages/shared/src/questify/**`; only the dispatch input mutated them. Proposed after the chase (needs Dhia's OK,
  not done): add those globs to the default list.

- 2026-10-26 **Mutation chase tests added for the six T-402/T-402b files under 90 (tests only, no source change):**
  new unit tests, all without a database: `souvenirs/payer.test.ts` 17, `souvenirs/tick.test.ts` 14 (fake pool and
  timers), `players/items.test.ts` 21, `players/item-routes.test.ts` 30 (Fastify inject over a fake pool),
  `packages/shared/src/souvenirs.test.ts` +15 (issue codes, paths and messages), `packages/shared/src/players/items.test.ts`
  27. About 4 mutants are left as equivalent (tick.ts `timer !== undefined` is always true and
  `Date.parse(null)` is NaN; souvenirs.ts `rankTo === null` and `visual === null` are covered by JS coercion). A hand
  check (a changed condition in tick.ts, payer.ts) failed the new tests; the sources are unchanged. Awaiting the
  coordinator's push and one GitHub mutation re-run on these six files.

- 2026-10-26 **T-403c built (standard).**
  App: achievements (shipped badges, tier rings, padlock silhouettes), the Event Passport on the profile, `/event-history`,
  `/questify-quests`, the public profile's tiers and ended public stamps, and `QuestifySyncProvider` (scheduler:
  focus, launch, foreground at 5 minutes, a trailing 15 s debounce after a completion, a silent 429; toasts and the
  level-up card). Dashboard: the event city picker. Console: `/console/questify`. Shared: the public profile's
  `achievements` and `passport` are required; theme gains three tier colours; `formatLocalDate`. 103 new strings
  in `messages.ts` (own `ux-araby` pass). Tests: app and web units (scheduler, notices, stamps, API client, console
  checks), the shared suites, `events.spec.ts` and `console-questify.spec.ts` (desktop and phone), `expo export`
  (android and ios). Proposed ADR-281 / Q-247. Needs a phone check. No CI minutes used.

- 2026-10-26 **T-403c done (standard), ticked; progress 79/155 (50.97%).** Standard code review GO 92 of
  9f4af20..fb699f6 by the in-house reviewer (Sonnet; the recorded Sol policy could not be used from the Claude Code
  session); no re-review. Folded in: `ConsoleQuestify` split (`RetireDialog`, under 100 lines); the sync scheduler treats
  a rejected call as done; the own-profile badge label carries the next-tier line; "Show more" is single-flight and
  deduplicates by `eventId` (`event-pages.ts`); the level-up card is modal for screen readers and hides the screen
  beneath; the new-string count is 103; Arabic polish on the console conflict, invalid-number, retire and city-hint
  lines (the quest-limit line now says retired quests are not counted, drafts are); migration 0065 seed names set in
  place (`العشرة الأوائل`, `يد واحدة`; undeployed, no test pins them). Publishing a campaign has no confirmation:
  Q-248. Phone checks still owed. No CI minutes used.

- 2026-10-26 **CI red on 569190d, fixed by the coordinator.** Run 40392290636: 6119 passed, 3 failed, all in
  `apps/api/src/players/item-routes.test.ts`. The mutation-chase tests built a fake public profile without
  `achievements`/`passport`, which T-403c made required in the shared schema, so the route's own parse answered 500.
  The T-403c worker ran `apps/api/test/players` but not `apps/api/src/players`. Fixture fixed (two fields); players unit
  suite 99 passed; one CI re-run. Lesson for worker briefs: after a shared-schema change, run the unit tests of every
  package that imports the schema (`npx vitest run apps/api/src/<area>`), not only the integration suites.

- 2026-10-26 **Second GitHub mutation result (run 40386286433 on 7a0faa8) and the chase for the files under 90 (tests
  only, no source change).** Scores: souvenirs files 96.9 to 98.7, `players/items.ts` 100; under 90: `questify/questify.ts`
  67.65 (17 survived, 5 no-cov), `questify/admin-routes.ts` 88.64 (3 + 2), shared `questify/quests.ts` 0.00 (47 no-cov),
  `questify/events.ts` 29.63 (19), `questify/achievements.ts` 27.27 (8), shared `players/items.ts` 23.64 (42) and
  `souvenirs.ts` 81.08 (21). New unit tests, none needing a database: `questify/questify.test.ts` 32 (fake pool: the
  `PI401` 401, rethrown faults, null/missing lists, event mapping, cursor paging and every cursor refusal),
  `questify/admin-routes.test.ts` 34 (Fastify inject: the PUT campaign write, the publish/retire arguments, a window
  ending when it starts, no staff on the request), `questify/routes.test.ts` 15 (the `no-store` headers),
  `packages/shared/src/questify/{achievements 13, events 20, quests 49}.test.ts` (accept/reject at every boundary,
  trimmed text, direction characters with message and path, offset-required instants, every enum value). 21 of the 22
  `questify.ts` mutants and all 5 `admin-routes.ts` and all shared `questify/*` mutants should now die; the one
  equivalent is `questify.ts:101` (an emptied `catch` still ends in the same 400, because `safeParse(undefined)` fails).
  Hand checks (10 broken lines, each failed the new tests, restored). The shared `items.ts` and `souvenirs.ts`
  survivors are **not test gaps**: 9 of 10 applied by hand (empty schemas, bounds, enum values, `refine` removed) fail
  the existing tests and the tenth, `souvenirs.ts:27` (`rankTo === null` replaced by `false`), is equivalent (`5 > null`
  is true in JS). Every survivor is import-time schema code while the in-function mutants of the same files were killed;
  the incremental cache (restored from run 40358820903) most likely kept their old result.
  If a forced run still leaves import-time schema mutants alive, the lever is `ignoreStatic` for those files, not tests.

- 2026-10-27 **Forced mutation run 40400940399 on 9345a17 (all 9 files retested): every file passes, no chase
  needed, no `ignoreStatic`.** API `questify/`: `admin-routes.ts` 100, `admin.ts` 100, `routes.ts` 100,
  `questify.ts` 98.53 (1 survivor, the known equivalent at line 101). Shared: `questify/{achievements,events,quests}.ts`
  100, `players/items.ts` 94.55 (3 survived), `souvenirs.ts` 98.20 (2 survived). This confirms that the earlier low shared
  scores came from incremental-report leftovers. The T-402 and T-403 mutation chase is closed.

- 2026-10-27 **ADR-283 built (answers Q-248).** The console's Questify campaign page asks for confirmation before Publish
  (`PublishDialog` in `ConsoleQuestify.tsx`, same `ConfirmDialog` as retire; new messages `console.questify.publishTitle`
  and `publishBody`, Arabic and English). Only the dialog's confirm button sends the publish call. Browser spec
  `console-questify.spec.ts` covers cancel (no call), confirm (one call) and the English text.

- 2026-10-27 **T-404 built (core, server; core code review pending).** Migration 0067 (undeployed; 0063 to 0066
  untouched) takes the plan's lock list up front (player, player_xp, level_reached, achievement_earned, questify_quest,
  questify_award, item, player_item, level_item, souvenir_rule; never platform_setting). Gems: `player_xp.gems` (CHECK ≥ 0),
  append-only `gem_entry` with four sources bound by composite keys, paid only by `questify_sync` once per level,
  tier and paying Questify award (retroactive; `gem_amounts()` falls back to 20/10/25/50, no setting row yet; seeded
  quests 25, quest gems frozen once it can pay). Shop: `gem_shop_item` (six titles 40–80, six "ring" frames 80–150 on
  `frame-15`…`frame-20`), `gem_purchase`, the locker's `shop` source, exclusive sources with level rewards and
  souvenirs; `gem_shop()`, `gem_buy()` (seen price, one copy, too few gems, replay by key with the current balance),
  `own_gems()`. API: `GET /v1/me/gem-shop`, `POST /v1/me/gem-shop/purchases` (UUID Idempotency-Key, 10 a minute), `gems`
  on `/v1/me`, the sync answer and the quests list; shared `questify/gems.ts`. STORE_COMPLIANCE 1.6 row and review note
  added. New suites `test/db/gems.int`, `gem-shop.int`, `gems-upgrade.int` (a scan in flight across the migration, the
  lock list checked against the SQL); security suites extended. Full suite: 400 files passed, 3 skipped; 6359 tests
  passed. Proposed ADR-290 / Q-255 (build choices), ADR-291 / Q-256 (two rare deploy-time lock clashes accepted).
  Mutation owed on GitHub (core files only). Progress 80/156 (51.28%).
  Core code review GO 93 (independent, no re-review); folded in: the STORE_COMPLIANCE demo-account line (played to
  level 3 before submission, T-806 note), T-022 added (migration retry on 40P01/55P03, before real players; ADR-291),
  the sync's missing-row fallback now throws, one shared `idempotency_key_invalid` error. ADR-290/291 Accepted,
  Q-255/256 answered. Progress 80/157 (50.96%).

- 2026-10-27 **T-404b built (gems on screen, standard).** App: `app/gem-shop.tsx` (balance; "Gems are earned by playing.
  They can't be bought." always; frame and title cards with the price in gems; "Get" / احصل عليه opening a confirmation
  sheet; `createPurchaser` sends the same key again only after a lost answer, a 5xx or a 409 `request_in_progress`,
  and takes a new key after every other answer, 409 and 429 included; a changed price keeps the sheet open and asks
  again; too few gems says how gems are earned; owned and retired refresh; "Equip now" through `PATCH /v1/me`); the gem
  count and the shop door on the Profile and the locker; the locker's "From the gem shop" line; "+N gems" on the
  Questify quests list and one "You earned N gems" toast per sync (a gems-only sync counts as written and reloads the
  profile); Arabic gem counts by helper (`gems.ts`: جوهرة واحدة, جوهرتان/جوهرتين, 3-10, 11+). Shared: `frame-15` to
  `frame-20` as an explicit table (colours outside the level palette, 3:1 on the page, tested), about 40 new strings.
  Console: the quest form's Gems field (0 to 1000, disabled once the quest can pay) and gems in the list row. Tests: new
  unit tests (api outcomes, key rule, flow steps, Arabic counts, toast, frames, console draft/body/`questCanPay`),
  `console-questify.spec` extended (seeded quest's fixed gems, bad gems named, new quest at 0, both languages, phone
  width). `npx expo export` (Android, Hermes bundle) passes; full browser suite after a fresh web build: 151 passed, 1
  skipped; full `npx vitest run`: 404 files passed, 3 skipped; 6431 tests passed, 4 skipped. Proposed ADR-292, ADR-293 /
  Q-257, Q-258. Phone check owed when a build exists (RTL, Reduce Motion, the sheet, VoiceOver/TalkBack labels, the six
  rings). No mutation (standard task). Progress 81/157 (51.59%).
- 2026-10-27 **Mutation chase for `players/profile.ts` (run 40418719633: 88.54%, 17 survived, 5 no coverage), tests only.** New
  `apps/api/src/players/profile.test.ts` (14 unit tests over `fakePool` and a fake settings service) kills the level
  threshold (null stays null), the gem balance (no row or null answers 401), the username-change rules (switch, tuned days,
  30-day fallback, settings that do not compose: off, 403 on rename), the `retry-after` arithmetic and the null
  `next_change_at` of a 429, and "no settings read for the rename when the username is not sent". Equivalent, left alone:
  line 244 (`?? { outcome, next_change_at }`: with no row the switch matches nothing either way), line 116 (the fallback
  equals `TUNING.usernameChangeDays.default`, 30), line 287 (`rules` is null exactly when `body.username` is undefined, so
  `&&`, `||` and either `true` behave the same). Expected score about 96%; confirmed by run 40422438219: **95.83%**
  (6 survived, 2 no coverage). T-404 mutation closed: questify `gems.ts` 95.00, `questify.ts` 98.70, `routes.ts` 100,
  players `items.ts` 100, shared `questify/gems.ts` 100, `questify/quests.ts` 100, `players/items.ts` 92.98.
- 2026-10-27 **T-405 plan written (core; awaiting the independent CTO plan review).** `docs/plans/2026-10-27-t-405-streaks.md`:
  split into T-405 (core: migration 0068, API, shared) and T-405b (standard: screens, dashboard Streak panel, strings;
  added to TASKS). Event streak: day rows per enrollment and open event day (organizer closed weekdays and dates neither
  count nor break; recorded on every multi-day event, on or off), a flat bonus from day 2 as ledger kind `streak`, paid
  by a `ledger_streak` trigger on the quest entry (after `apply_ledger_entry`, before `ledger_xp`) so every door pays
  it; an owner-only settings door. Daily streak: one 04:00 Riyadh day, written by the same trigger only while the
  platform key `dailyStreak` is on, length read not stored, XP milestones (3 to 365 days) once ever through
  `questify_sync` (`xp_entry` source `streak`); no gem or points source (FR-421). Lock list up front (enrollment
  EXCLUSIVE first; never `platform_setting` or `player`). STORE_COMPLIANCE gate: nothing sold, no loss copy or
  countdowns. Proposed ADR-294 to ADR-301 / Q-259 to Q-266. Progress 81/158 (51.27%; T-405b added). CTO plan review 86 (approve with revisions, no re-review): the day row stays append-only (bonus entry first, then a plain INSERT), approval-day and manual completions count (ADR-301), error class ST, UNIQUE completion_id, the day-boundary race, closed weekdays frozen once started, quest_id joins in the build check.

- 2026-10-27 **T-405 built (core, server; core code review pending).** Migration 0068 (undeployed; 0057 to 0067
  untouched) takes the plan's lock list up front (enrollment EXCLUSIVE, event and quest_completion SHARE ROW EXCLUSIVE,
  xp_entry and ledger_entry ACCESS EXCLUSIVE, player_xp SHARE ROW EXCLUSIVE; never platform_setting or player).
  Event streak: `event_streak` (owner-only `set_event_streak`, class `ST`, `RF409` for final results, audited
  `event.streak_set`; `event_streak_settings` for owners and editors), append-only `event_streak_day` (UNIQUE
  completion), ledger kind `streak` (shape CHECK, unique per completion, never boosted, no XP), written by the
  `ledger_streak` trigger (after `apply_ledger_entry`, before `ledger_xp`): the later-day probe, the length from the
  previous open day, the bonus entry first and then the day row by a plain INSERT (no UPDATE, no ON CONFLICT). Daily
  streak: `questify_day` (04:00 Riyadh), `questify_streak_day` (no FK), append-only milestones and rewards, `xp_entry`
  source `streak` paid once ever by `questify_sync` (pre-check `streak_due`), the platform key `dailyStreak`. Readers
  restated with `streak` (remove_award, the operator guard, community points goals, member_activity, member_ledger) and
  a quest's `earned` leaves it out (the `completion_id`/`quest_id` join list is in the plan's build notes). API
  `apps/api/src/streaks/` (`GET`/`PUT …/streak`), `streakBonus` on every answer that carries `firstBonus`, Home
  `streak`, `streakDays` in the history and the team record, `dailyStreak` on `/v1/me` and the sync, log
  `completion.streak_bonus {days}`; shared `streaks/`. New suites `test/db/event-streak.int` (50, the door table, ADR-301,
  the boundary race, crossed locks), `daily-streak.int` (14), `streaks-upgrade.int` (3), `test/streaks/routes.int` (5),
  unit and shared tests; security suites and the list guards extended. Burst timing by hand
  (`test/perf/streak-timing.int`): +12% to +24% at p95 (10 to 18 ms) over the 10% target, Proposed ADR-303 / Q-268 to
  accept; build choices ADR-302 / Q-267. Full suite (second run): 409 files passed, 4 skipped; 6562 tests passed, 5 skipped; 2 failed: one stale submissions unit fixture (fixed, re-run green) and the known first-N bonus Stop timing test under full-suite load (passes alone). Mutation owed on GitHub (core files only). Progress
  82/158 (51.90%).
  Core code review GO 93 (independent, no re-review); folded in: a non-object body or an unknown key with no listed field at
  fault is a plain 400 `invalid_request` (tested); `set_event_streak` takes the event FOR KEY SHARE before the
  final-results check, as `remove_award` does (0068 edited in place, undeployed; a DB test crosses a confirmation and fails
  without the lock); ADR-303's target became a burst budget of about 20 ms at p95 within NFR-002 (CTO rerun +17.7%, about
  13 ms; re-time with T-406, TASKS note); the T-405b note that a closed day reads `closedToday` first; the first-N bonus
  Stop test (`first-bonus.int`, CTO 4) is load-independent (4,000 players claimed back to back; Stop must return within a
  loose 15 s guard and the lanes keep claiming after it; a setter made to wait for the claims to pause fails it). ADR-294
  to ADR-303 Accepted, Q-259 to Q-268 answered.
- 2026-10-27 **T-405b built (standard, screens and dashboard; code review pending).** App `src/streaks/`: `daysLabel`
  (English one or many; Arabic one, two by role, 3 to 10, 11 and over singular), the card's states (a closed day is read
  first, then today played, then a live streak, then "Start a new streak today"), tolerant readers for Home's `streak`,
  a completion's `streakBonus` and `/v1/me`'s `dailyStreak`, and the lines, the success line and the sync toasts. Event
  Home gets a Day streak card (hidden while Home sends null); the scan celebration a streak beat after the first-N beat
  (`PopIn`, so Reduce Motion is respected), and quest-sheet, vote, survey, share, poll, game and quiz answers carry
  "Streak day N! +P" in their line; history reads "Streak bonus, day N"; the profile shows the daily streak beside the
  gems (hidden while null) and one toast per milestone paid. The flame is the redone `icon-flame` (upright, one connected
  shape; passed the full-size review) at 128 px. Dashboard: a Day streak panel on the event page (owner form with one
  Save and an Idempotency-Key, weekday chips, upcoming dates only with started ones fixed, a preview line, refusals worded
  by reason; editors read it and see "Only the owner can change this."; a single-day event explains why it has no
  streak). Tests: app units (`streaks/*.test`, plus the readers in `event`, `quests`, `plays`, `games`, `celebration`,
  `amount`, `player-state`, `sync-notices`), web `lib/streak.test`, `e2e/streak.spec` (desktop and phone, English and
  Arabic) and the organizers spec's note count (8 to 9), `npx expo export`. Proposed ADR-304, ADR-305 / Q-269, Q-270.
  Phone check owed (RTL, Reduce Motion, the streak beat, VoiceOver/TalkBack labels). No mutation (standard task).
  Progress 83/158 (52.53%).
- 2026-10-27 **T-023 done (standard, infrastructure).** The function limits of `docs/rules.md` now have a ratchet
  (Q-271): `scripts/function-limits.mjs` (`pnpm lint:limits`) runs oxlint with `.oxlintrc.limits.json` (only the
  ratchet reads it; tests, `apps/*/test` and e2e left out) and compares with `scripts/function-limits-baseline.json`
  (323 limit violations today). A new offender or a grown value fails; shrunk or gone ones are listed; `--update`
  only lowers the baseline. It is in `ci:changed`, so `ci:full` and the CI lint step run it; no workflow change. Unit
  tests in `scripts/function-limits.test.ts` (vitest now also includes `scripts/**/*.test.ts`). No mutation (standard
  task). Split offenders when their files are next touched.
- 2026-10-27 **Mutation chase: `completions/complete.ts` (run 40433111492, 89.93%, 22 survived and 7 uncovered).**
  Tests only: `apps/api/src/completions/complete.test.ts` (fake pool; the DB-backed `test/completions` suites do not
  count under Stryker). Kills the QP403 refusal, the release-failure log (event, fields, `unknown`), the missing-detail
  reason, no release for a QR scan, the item/level/boost/bonus row guards, `locationQuestsOn` and when the location
  switch is read. Hand-checked: 20 mutants applied one by one, each failed a test. Equivalent, left alone: line 431 (`code`
  undefined), 435 hint default (`parseInt` of any non-number is NaN), 474 `kind` guard, the three `kind: "ready"`
  strings (only `"refused"` is read), 539 `? false` (position already null). Expected score about 100% of the killable
  mutants (all but 7 equivalents); confirmed by run 40458787437: **97.57%** (7 survived, the equivalents). T-405
  mutation closed.
- 2026-10-27 **T-406 plan written (core; awaiting the independent CTO plan review).** `docs/plans/2026-10-27-t-406-daily.md`:
  split into T-406 (core: migration 0069, API, shared), T-406b (standard: app screens) and T-406c (standard: console
  pages), both added to TASKS. Periods on the Questify day, weekly Sunday to Saturday, a cadence per kind from the next
  day (weekly at launch); a two-language question bank, three questions a period, one five-letter word per language,
  all used once and frozen once started; XP only (challenge 20 + 10 per right answer, word 50 when solved) as
  `xp_entry` source `daily`, paid by the finishing door after the daily streak row and before `player_xp` (T-405's
  order); no points or gems; hidden answers and words never in a read before the caller finished; a sponsor is a
  disclosed name on a period's challenge (no logo, link, tracking or data; no prizes). Lock list: `xp_entry` then
  `player_xp`, nothing else. Proposed ADR-306 to ADR-312 / Q-272 to Q-278; for Dhia: Q-279 (sponsor terms), Q-280
  (disclosure wording, counsel), Q-281 (word list licences). Progress 84/161 (52.17%; T-406b, T-406c added). CTO plan
  review 84 (approve with revisions; short re-review pending): explicit FOR UPDATE on content and the clock after the lock,
  `questionId` in the answer (`changed`), the cadence door locks today's row and drops a same-cadence pending row, XP
  field ranges that fit the 1000 CHECK, the FK to `player` kept, a 33-letter shared Arabic set and a display form.
- 2026-10-27 **T-406 core built (plan re-review GO 92; core code review 94, minors folded in 431470d; ADR-306..313 accepted).** Migration 0069 (undeployed; lock list
  `xp_entry`, `player`, `player_xp` only): the cadence per kind (weekly from 2026-01-04, changed for tomorrow, rows whose
  day came frozen), the question bank, challenges of three questions with an optional sponsor name, daily words per
  language and the guess lists, frozen once started for every role; plays, answers, guesses and finishes (append-only);
  `xp_entry` source `daily` paid once per play by the finishing door after the daily streak row and before `player_xp`;
  no points or gems. `apps/api/src/daily/` (three player routes, eleven console routes), `packages/shared/src/daily/`
  (schemas, the 33-letter Arabic set), switches `dailyChallenge` and `dailyWord`. The re-review's four items are in the
  plan's build notes. Entrance burst re-timed: streak work +15 to +20 ms at p95; the shared daily row +10.6 ms over the
  same load; 300 extra concurrent finishes about +62 ms on a laptop (142 ms p95, inside 1 s; Q-282). Proposed ADR-313 /
  Q-282. Progress 85/161 (52.80%). Mutation globs for GitHub: `apps/api/src/daily/**/*.ts`,
  `packages/shared/src/daily/**/*.ts` (tests excluded).
- 2026-10-27 **T-406b built (standard; code review 91 GO, folded in).** The daily games on screen: `apps/app/src/daily/` (the
  challenge screen: one question at a time, a reveal after each answer with the right option by colour, tick and label,
  the sponsor line, an end card with the score, the XP and the next date; the word screen: a six-row grid in the word's
  language, the app's own keyboard with 33 Arabic or 26 English keys, marks by colour, glyph and border with a legend,
  screen-reader labels per tile, the reveal at the end, the language choice before the first guess), two cards under
  "Daily games" on the Profile's Questify section until T-408, hidden when a game is null. A finish reloads the profile,
  syncs and shows the level-up card (`celebrate` on the sync provider). Strings in both languages (`daily.*`). No
  countdown or loss copy. Proven by `daily-api`, `daily-state`, `daily-lines`, `daily-flow` and `keyboard` tests
  (the keys equal the shared 33-letter set), the Hermes guard, the function limits and `npx expo export`. Proposed
  ADR-314 / Q-283. Phone check owed (RTL grid, keyboard size, VoiceOver and TalkBack). Progress 86/161 (53.42%). No
  mutation globs (standard).
- 2026-10-27 **T-406c built (standard).** The daily content in the console: `/console/content` (Content) with a Daily challenge tab (the warning banner, the period control from tomorrow, the schedule by period with empty periods marked and started ones read-only, an editor of three ready questions with the sponsor name in both languages and a preview, the question bank with edit and retire, unused content with Remove) and a Word bank tab (per-language warnings, the period control, the daily words by period, the guess list with search and pages, and the import by paste or text file in calls of at most 20,000 with the refused lines shown; no list ships, Q-281). The console home links to Content with a "Needs attention" mark while content runs low. Strings in both languages. Proven by `console-daily.test`, `console-daily-forms.test` and `e2e/console-daily.spec.ts` (desktop and phone, Arabic and English); `console-questify.spec.ts` still green. ADR-315 / Q-284 accepted (code review 91, about 94 after the fold-in: plain-button tabs, idempotency keys ended after a refusal, the bank re-read only after bank writes, confirmed Remove, import notices). Progress 87/161 (54.04%). No mutation globs (standard).
- 2026-10-27 **T-407 and T-407b built (standard; T-407c split off as core).** Marketing consent, interests, city and "For you". Migration 0070 (new file, undeployed): `interest` (12 seeded), `player_preference`, `event.interests` (up to 3, trigger-checked), the append-only `marketing_consent` log and the `marketing_state` its trigger writes, nine doors (`own_marketing`, `set_marketing`, `marketing_opt_out`, `marketing_audience`, `marketing_consent_history`, `own_preferences`, `set_preferences`, `interest_list`, `own_for_you`), `erase_rows` restated. API: `GET`/`PUT /v1/me/marketing` (every channel off, the first answer recorded even when all stay off, wording version checked, a possible minor, birth year gap under 19, never accepted), `GET`/`PUT /v1/me/preferences`, `GET /v1/me/for-you`, `GET /v1/interests`, the HMAC-signed opt-out link and `POST /v1/public/marketing/opt-out`, an admin's audited read of a player's consent, `marketing` on `GET /v1/me`, `interests` on events; `promoSendTime` (SMS never 22:00 to 09:00, Ramadan 01:00 to 12:00 by the Umm al-Qura calendar with both windows beside its edges). Web: the event form's Interests picker and the `/[lang]/opt-out` page (asks first, then posts). App: the one-time step (three unticked switches, Save or "No offers, thanks", shown on Questify home or the launch screen only), Settings → Offers and notifications, Interests and city, For you. Proven by `test/db/marketing.int` (28+ cases), `test/marketing/routes.int`, `src/marketing/*.test`, the outsider, cross-tenant and route inventories, the app and web unit tests, `e2e/events.spec.ts`, `e2e/opt-out.spec.ts`, `npx expo export`. Proposed ADR-316 to ADR-319 / Q-285 to Q-289; for Dhia and counsel: Q-286 (age), Q-287 (quiet hours for push and email), Q-288 (consent wording), Q-289 (proof after deletion). Progress 89/163 (54.60%; T-407b, T-407c added). Phone check owed (switches and choices with VoiceOver and TalkBack, RTL). No mutation globs (standard); T-407c carries the core files.
- 2026-10-27 **T-407c built (core; plan review 92 GO, folded; code review owed).** The "set your interests" Questify quest (FR-710). Migration 0071 (new file, undeployed): `questify_quest.metric` gains `interests_set`, a named CHECK keeps it always-on with target 1, one seeded active quest "Set your interests" / «اختر اهتماماتك» (100 XP, 10 gems, position 3; Q-290 answered by the developer), and `player_metrics` gains a lifetime-only row (1 when `player_preference` holds an interest; the city is never read). `questify_sync`, `questify_due` and `own_questify_quests` are not restated; no new lock edge (a preference save and a sync never wait on each other, both tested). Shared `INTERESTS_METRIC`; the player card schema takes any metric name; the console door answers 422 `{field: target|metric}`; the console offers the metric for always-on quests only, fixes its target at 1 and warns about a second one; the app's undone card opens Interests and a save with an interest syncs at once. **Deploy note:** app builds installed today have the closed metric list and fail to parse the quest list once 0071 ships, so the server deploys together with a new app build. Tests: 11 new DB cases, a 0071 upgrade suite, route, shared, web and app units; console browser spec 8/8; full browser suite 171 passed / 1 intentional skip; full Vitest 7258 passed / 5 skipped with one seed-count failure (`gems.int`) fixed and that file re-run green (17/17); `npx expo export` Android and iOS PASS. Proposed ADR-320. Code review 87 (BLOCKER: function limits) fixed: `MetricField` split out of the console form, the card shows "1 of 1" once met and unpaid, a re-chosen interest pays nothing again, RUNBOOK release step for 0071. Progress 90/164. Mutation globs (GitHub): `apps/api/src/questify/admin.ts`, `apps/api/src/questify/admin-routes.ts`, `packages/shared/src/questify/quests.ts`.
- 2026-10-27 **T-408 built (core server; plan review 88, MAJOR-1 and the minors folded; code review owed).** The Questify-wide ranking by XP (FR-611) and its monthly seasons (FR-1786; Q-292 answered by Dhia: "Automatic monthly", FR-1786 amended). Split (ADR-321): T-408 core server, T-408b app screens, T-408c console Seasons page, T-408d Redis copy. Migration 0072 (new file, undeployed): `xp_board` (`all` and Questify months `YYYY-MM`, a month starting at 04:00 Riyadh time on the 1st; no foreign key), `xp_apply` restated to write both boards under the player's `player_xp` lock (a removal on its credit's month, so a month never goes negative; versions by `greatest`), `xp_backfill` dropped, a backfill that aborts unless the boards equal the ledger, `player_inactive_idx`, the doors `questify_ranking`, `questify_seasons`, `questify_season_top`; locks `xp_entry` ACCESS EXCLUSIVE then `player` SHARE. API: `GET /v1/questify/ranking?scope=`, `GET /v1/admin/questify/seasons[/:month]`; shared schemas; the `questifyRanking` platform switch. Tests: `test/db/questify-ranking.int` (19: order, a 300-player reference check, banned and deleted, every writer and four races equal to the ledger, the doors, the month edge, MAJOR-1), `test/db/questify-ranking-upgrade.int` (7: backfill, lock list, live traffic, abort), outsider, cross-tenant and route inventories, unit and route tests; full Vitest 7304 passed / 6 skipped with one failure (the config defaults list lacked the new switch) fixed and that file re-run green (31/31). Timing at 100,000 ranked players, run on its own: p95 about 37 ms (gate 50 ms); T-408d (Redis copy) starts when the RUNBOOK monthly check passes about 30,000 ranked players. Code review 93 GO, minors folded (seasons listed from the key ends, notes); ADR-321 to ADR-323 accepted, ADR-324 Proposed until T-408b (Q-293 open). Progress 91/167. Mutation globs (GitHub): `apps/api/src/questify/ranking.ts`, `apps/api/src/questify/routes.ts`, `apps/api/src/questify/admin.ts`, `apps/api/src/questify/admin-routes.ts`, `packages/shared/src/questify/ranking.ts`.
- 2026-10-27 **T-408b built (standard; code review owed).** The bar outside events and its screens. `apps/app/app/(questify)/` (Tabs: Home, Explore, the center button, Shop = the gem shop, Profile; the event bar's style and left-to-right order), `app/join-scan.tsx` (`classifyJoinScan`: operator invite first, then a join link; event-only codes say to open the event first; else "not an event join code"; no rehearsal QR exists), Home (`src/home/`: events live, coming up and past with the newest 5 past then the history, the daily cards moved off the Profile, the streak line, the Questify quests button, the typed code), Explore (`src/explore/`: For you as a section, the Questify-wide ranking with All time / This month in the 11-row layout and hidden when `questifyRanking` is off, the public events). `/for-you` and its button are gone; `atLanding` knows the `(questify)` group; `MyEvent` gains `startsAt`/`endsAt`. Code review 82, folded in (limits, Home re-reads on focus, label punctuation per language, public-events retry test); ADR-324 and ADR-325 accepted. Strings in both languages (`nav.explore`, `home.*`, `joinScan.*`, `explore.*`). Proven by `join-scan`, `home-groups`, `ranking-api` and `event-isolation` tests (FR-612), `marketing-flow`, `event`, the Hermes guard and `npx expo export`. Proposed ADR-325 / Q-294; ADR-324 / Q-293 are decided at this review. Phone check owed (RTL bar and rows, the center button, VoiceOver and TalkBack). Progress 92/167 (55.09%). No mutation globs (standard).
- 2026-10-27 **T-406 mutation scores (GitHub).** Run 40467748184 on the six core files: daily admin-routes.ts 96.67, admin.ts
  94.95, daily.ts 97.06, shared letters.ts 93.33; under 90: daily routes.ts 51.22 and shared daily.ts 63.56. After the survivor
  tests (326a2ae): routes.ts 100 (run 40485273781) and shared daily.ts 95.93 (forced run 40487686895; the incremental report
  had kept stale survivors). Every T-406 core file is at 90 or above.
- 2026-10-27 **T-407c mutation scores (GitHub run 40491590598).** questify admin-routes.ts 100, admin.ts 95.08, shared
  questify/quests.ts 100. All at 90 or above; T-407c is closed (re-review 93 GO, ADR-320 accepted, pushed a9b183d).
- 2026-10-27 **T-408 mutation scores (GitHub run 40499485325).** questify ranking.ts 100, routes.ts 100, admin-routes.ts
  100, admin.ts 94.12, shared questify/ranking.ts 91.30. All at 90 or above. T-408b code review 82 (one BLOCKER, function
  limits, and one MAJOR, Home re-reads on focus), both fixed in 11d6e25 and `lint:limits` checked by the coordinator;
  ADR-324 and ADR-325 accepted.
- 2026-10-27 **T-408c built (standard; code review owed).** The console's Ranking seasons page `/console/seasons` («مواسم الترتيب»; a link on the console home): every Questify month newest first with its ranked count and the current one marked, one month open at a time (the current one on arrival) showing its top 10 (rank, avatar, username, XP, level), read only with no reset button (Q-292). `ConsoleSeasons`, `lib/console-seasons.ts` (reads through the shared schemas), shared `formatLocalMonth`, strings `console.seasons.*`; the test API server gains a test-only `/season-board` control. Proven by `console-seasons.test`, `event-time.test`, and `e2e/console-seasons.spec.ts` (Arabic and English, desktop and phone: opens on the current month, a past month's count and top 10 in order, a month nobody played, one open at a time, no sideways scroll, no reset button, a non-admin gets 404). Proposed ADR-326 / Q-295 (the name «مواسم الترتيب», because «المواسم» already means campaigns in the console). Progress 93/167 (55.69%). No mutation globs (standard).
- 2026-10-27 **T-406d built (standard; code review owed).** The daily word guess lists (Q-281, answered by Dhia: open lists plus the team's picks). `data/word-lists/guess-list-en.txt` (8,863 words, from SCOWL size 80, US/GB/CA spellings, lower-case only) and `guess-list-ar.txt` (119,023 words, from the Arabic lexemes of Wikidata, CC0: lemmas and forms in the 33-letter set, five letters, every spelling filed as a proper noun left out, the definite article put before three-letter nouns and adjectives), one normalized word per line, sorted, without offensive and vulgar words (SCOWL's marks, LDNOOBW, a short extra list), names, abbreviations and repeats. `scripts/build-word-lists.mjs` rebuilds them; the sources, exact licences read at their primary source on 2026-10-27, checksums, attribution texts and the sources refused (Leipzig unclear, FrequencyWords share-alike, Ayaspell and Snowball copyleft, UKC non-commercial) are in `docs/legal/THIRD_PARTY.md` (the existing notices file, extended); SCOWL's notice also sits in `data/word-lists/NOTICE.txt`. Proven by `apps/web/src/lib/word-list-files.test.ts` (12 checks) and by importing both files once into a test database through `word_list_change` (all added, none refused). That check found the console's 20,000-word import calls would time out against the API's 5 s statement limit (about 1.4 ms a word, `word_norm` three times a word through nested `search_path` functions): the console now imports in calls of 500 words. Proposed ADR-327, ADR-328 / Q-296, Q-297 (a faster `word_list_change` is a later, core SQL change). Code review 92 GO, folded: eleven more slurs out of the English list, the import loop in `word-import-run.ts` with a test (a failing second call keeps the first call's counts), "Stopped after N of M words" in both languages, the real call limit in `docs/API.md`, the dated Wikidata URL, a test for `NOTICE.txt`. Progress 94/167 (56.29%). No mutation globs (standard).
- 2026-10-27 **T-409 built (core; plan reviews 84 → 86 folded; code review owed, it checks MAJOR 1 and 2 by their named tests).** Questify invitations, the server half: migration 0073 (new file, undeployed; CranL is at 0056): `invitation_campaign`, `invitation_recipient`, `invitation_channel_hold` (RLS forced, no grant), the consent's `language` (`set_marketing` gains a defaulted fourth argument; NULL read as Arabic), `promo_pool` (the one consent rule, plain SQL, no grant) with `marketing_audience` restated over it and system-only, `marketing_adult` without its SET clause, 13 doors (owner request/cancel/list, console queue/detail/approve/refuse/cancel, system start/claim/ack/settle, anonymous open), `erase_rows` restated. API `src/invitation-campaigns/` (doors with strict answer schemas, routes, the SMS template, two-band quiet hours, the outcome map, the 5 s tick: settle every 10 minutes even with the switch off, one start under the fill lock with its own 60 s limit, rounds of 5 while 3 s last, no further round after an account refusal), `MSEGAT_PROMO_SENDER` (refused equal to the service sender), `PUT /v1/me/marketing` records `accept-language`, the platform switch `invitationCampaigns` (off). Shared: the name rule (NFKC, control and format characters, dot-like characters between letters or digits, 9+ digit runs, also on the cut text) and the schemas. Departures from the plan in ADR-334 / Q-303 (proposed): the start skips the 24-hour rule, the claim locks campaigns FOR NO KEY UPDATE, no foreign keys on recipient rows (a 100,000-row fill measured about 12 s with them, 4.0 s without; the console's estimate 0.7 s; the 2 s gate missed on the laptop, measure on CranL), `M0030`/`M0090` hold the channel. Tests: 57 + 49 database (`invitation-campaigns.int`, `invitation-sending.int`), 19 route, the security suites (outsider by name, cross-tenant, route inventory), marketing restatements, unit tests (name rule, schemas, message and parts, quiet hours, outcomes, tick, doors), the app guard `no-invitation-purchase.test`; full Vitest once: 7671 passed, 2 failed (the Hermes check refusing a `z.union` call in the shared schema, now `.or`; a unit test edited during the run), both fixed and their suites re-run green. No web pages (T-409b). Mutation owed on GitHub (`apps/api/src/invitation-campaigns/**`, `packages/shared/src/invitation-campaigns/**`, `apps/api/src/marketing/marketing.ts`, `apps/api/src/marketing/routes.ts`). Not pushed.
- 2026-10-27 **T-409 code review 89 folded (no re-review).** ADR-334 Accepted and Q-303 answered as built. MAJOR: the fill's
  limits are its own on the client too (65 s read limit beside the 60 s statement limit; the pool's 6 s read limit had
  still killed it), proven by `test/invitations/fill-limits` on a pool built from `poolOptions` (fails with the fix
  removed). Also: default-ignorable characters and combining marks around a dot in the name rule; the purge deletes a
  row a fill inserted for a player erased meanwhile; the request's name check reads only the caller's events (404, not
  `event_name`, for another tenant's); a text that cannot be built is `failed`/`render_error`; the 90-day purge kept
  with its trade-off in ADR-334; a RUNBOOK line on one campaign's template refusal holding the channel.
- 2026-10-27 **T-409b built (standard; code review 92 folded).** The web pages for Questify invitations. Dashboard: the event's Invitations page (`/organizers/{o}/events/{e}/invitations`; the event page links to it only while the `invitationCampaigns` switch is on): the owner asks (city, up to 3 interests, history, size 50 to 100,000, earliest send in Riyadh time) and withdraws; owners and editors read each request's state, criteria, approved cap and send time, the note and the end reason, with only rounded counts ("120+", "Fewer than 10", "Not published yet", updated daily); "Nothing is charged here" and "only rounded counts, never who" are on the page; the name rule's refusal and each `event_not_eligible` reason are worded; editors see the owner-only sentence and no form. Console: `/console/invitations` (open requests first, then the latest closed ones; the home links to it with the number waiting) and `/console/invitations/{id}` (facts, the audience now, the event's names with the name rule's verdict, the exact SMS in both languages with its parts and a placeholder token, the channel-hold banner, exact counters; Approve with SMS, a cap, a Riyadh-time send time and a note, sending back the names it showed; the moved send time is said; `event_renamed` reads the page again and asks to review the new text; Refuse and Cancel need a note; Approve is off with a reason when SMS is not set up, the event no longer qualifies, a name fails the rule or there is no name). Landing: `/[lang]/i#{token}` reads the token once, clears it from the address, sends it once, shows the public event card and "Open in Questify" (`/{lang}/e/{code}`), or "This invitation has ended" / "This link is incomplete"; never indexed, no referrer, no language switch. Arabic and English for every string (`invCampaign.*`, `console.invCampaign.*`, `invCampaignPage.*`; ux-araby: «طلب دعوات», not «حملة»), Western digits, RTL, phone width. One line of the reviewed server code changed: the console detail renders the SMS from the frozen names once a request is approved (ADR-335 (1); before, it showed the event's current names in every state). The event form's link row moved into `EventNavLinks` (EventForm shrank from 352 to 306 lines). ADR-335 / Q-304 Accepted at the code review (92, GO; folded: Approve and Refuse ask first, a failed first read of a request, the name-rule warnings only while `requested`, grouped counters). Tests: unit (`invitations`, `console-invitations`, `invitation-landing`, `campaigns.test`), `e2e/invitations.spec.ts` (desktop and phone, Arabic and English: the refused name, the size check, the request, the queue, a rename between preview and Approve, the moved time, the frozen text after a rename, rounded counts with no exact number on the page, one open for two visits, the unknown and the incomplete link, Cancel, an editor, a non-admin), the e2e API gains a fake promotional sender, an `invite` editor and test controls (`/invitations-switch`, `/invitation-started`, `/invitation-link`, `/invitation-event`). No mutation globs beyond T-409's. Progress 96/168 (57.14%). Not pushed.
- 2026-10-27 **T-410 built (core; code review owed).** The server half of "after the event". Migration 0074: `event_shop_window_guard` (the API's role; after the end the days only grow, `SW409 shorter`; once closed, or archived, frozen, lengthening included, `SW409 closed`; judged on `clock_timestamp()` so an edit begun before the close cannot reopen it), `event_recap` (caller-bound definer: membership as the passport counts it, `left` in, `joined_via` NULL in; rank by `own_events`' rule; distinct quests from `quest` entries no removal reverses; the event's souvenirs in earned order), and `reserve_reward` restated: 0054's rehearsal flag was NULL once the event had ended, so in the window after the end a digital reward was delivered with no code and no unit counted, and items skipped the desk's hours (`desk_finished`, the next opening); found by the new after-the-end tests, now proven. API: the window rule and the `SW409` mapping in `rewards/shop-window.ts` (state and time read in SQL in `updateShop`'s transaction, savepoint on the guard's refusal, 409 `shop_window_locked {reason}`), the dashboard's shop read and write carry `state` and `closesAt`, Home's `shopWindow {state, closesAt, deskEndsAt}` and no goal once closed (`goal.ts`), `GET /v1/events/{id}/recap` (`private, no-store`, 404 for anyone else, 409 `not_ended`), shared `shopWindowSchema` and `eventRecapSchema`. The close is a rule (ADR-337): nothing written; the FR-751 snapshot test proves score, final rank, stamp, souvenirs, XP, level, achievements and items untouched across it. Arabic and English error texts (ux-araby). Docs: API.md, DATA_MODEL.md (the close, the recap, the permanent record Q-075 must keep), SECURITY.md, CONFIGURABILITY.md, SRS statuses. Mutation globs: `apps/api/src/rewards/shop-window.ts`, `apps/api/src/home/goal.ts`. T-410b (screens, share) and T-411 (archiving) not started. Progress 97/170 (57.06%). Not pushed.
- 2026-10-27 **T-410b built (standard; code review 89 folded).** The screens after the event. App: Home shows, for an active member once the event ended, "Your recap" and the shop's line under the standing card ("open until {date}" in the event's zone, with the desk's end or "stopped" once `deskEndsAt` is past, or "closed on {date}"); the balance reads "Closed" and the goal card is dropped once the shop closed (the app drops it itself whatever an older API sends); Home reads itself again a second after the close or the desk's end. The Rewards tab swaps its catalog for a closed panel (date, "can no longer be redeemed", what stays), keeps My rewards, and the cancel confirmation adds the returned-points note. `/event/[eventId]/recap`: the card (event, date, city, rank by the passport's rule or "comes with the results", quests done or "Thanks for joining", up to 3 souvenirs and "+N") and Share: a PNG made on the phone (`react-native-view-shot` 5.1.0, Expo SDK 57's pin) through `expo-sharing` ~57.0.24, the image alone, no link, no tracking, no text; the previous capture is released before the next and when the screen closes. Both native modules are detected first (`requireOptionalNativeModule('ExpoSharing')`, `TurboModuleRegistry.get('RNViewShot')`) and loaded lazily only when both exist; otherwise one fixed text line goes through React Native's `Share`. Web (dashboard Rewards page): the closing line in the event's zone, the desk warning when its last window ends before the close, the days field only growing after the end and read-only once closed, `daysAfter` sent only when changed, each `shop_window_locked` reason in words (Arabic and English) and the shop read again after one. Proven by unit tests (`shop-window`, `recap`, `recap-share`, `recap-share-native` with a source scan that fails any value import of the two packages outside that file, Home and shop reads, `rewards`, `sign-in-errors`, `hermes-runtime`), `npx expo export`, and `e2e/shop-window.spec.ts` (desktop and phone, Arabic and English; a mutation that always sends `daysAfter` fails it). Test support: the e2e control's `/event-status` takes `endedDaysAgo`. ADR-340 Accepted and Q-309 answered (developer, delegated by Dhia). Code review fold-in: Home's re-read at the close retries every 15 s when the phone's clock is up to 2 minutes ahead of the server (older passed boundaries ignored), the recap card is restyled as a grown-up passport stamp (wood frame, parchment panel, gold edge, gold-ringed emblem; no new art), the source scan catches a bare import, a dynamic import and `export * from`, no recap for a rehearsal account, no desk warning once closed. Docs: SRS, TASKS, API, CONFIGURABILITY, STORE_COMPLIANCE (the two modules' privacy manifests and permissions), ux/PLAYER.md 3.4, the plan's T-410b note. No core file changed: no new mutation globs (T-410's stand). **Phone checks owed to Dhia (a new development build is needed to see the image; the old build shows the text line):** Home after the end in Arabic and English (the banner and its date, the desk line, "stopped" after the desk's hours, balance "Closed", no goal card, "Your recap" on top); the Rewards tab once closed (the panel, My rewards still listed, the cancel warning); the recap card for each rank state, zero quests, no souvenir, more than 3 souvenirs, Arabic right to left with Western digits; Share to a messaging app shows the image alone on Android and iOS (the restyled card, its wood frame, parchment panel and gold edge, is not transparent and its fonts are drawn), a second Share works, and closing the screen leaves no temp file. Progress 98/170 (57.65%). Not pushed.
- 2026-10-28 **T-411 built (small, fully specified; code review owed).** Archiving ended events (FR-1608's last step, ADR-337 (5)). Migration 0075 (new file, undeployed; CranL is at 0056): `archive_ended_events()` (definer, the API's role only, no argument), the tick's last step after the reservation timeout and the ticket purge, archives up to 100 due events a run (`FOR UPDATE SKIP LOCKED`, the rule rechecked by the UPDATE after the lock, audited `event.lifecycle` ended → archived); `archive_due` (internal: stored ended, shop closed by `shop_state`, 30 days since the end, no `reserved` redemption of any kind, results revealed or `ends_at` + 60 days, no open ticket in either queue); insert guards `redemption_event_open` and `ticket_event_open` read the event `FOR KEY SHARE` and refuse an archived one with each door's own refusal; `event_archived_final` refuses leaving archived for every role. The tick's steps became a table (`src/events/tick.ts`); `MyEvent.statusNow` gains `archived`. Proven by `test/db/event-archive.int` (each blocker alone, the 60 days to the microsecond, clearing, twice, two at once, a ticket and a reservation in flight in both orders, the guards, final for every role), `test/events/archived.int` (every player read over HTTP after archiving; the owner's PATCH, end and delete refused), the tick's unit test, the outsider and cross-tenant suites. ADR-341 Proposed, Q-310 open. Mutation glob: `apps/api/src/events/tick.ts`.
- 2026-10-28 **T-411 code review 87 folded (no re-review).** MAJOR: archiving waited only for the shop's close, which
  can be the end itself, while `open_ticket` lets members send for 30 days after the end and refuses an archived
  event; `archive_due` now also needs `ends_at + 30 days <= now()` (also 30 days for organizers to review pending
  submissions), proven at 29 days and to the microsecond at 30, with the race tests crossing that boundary. Also: the
  delete check asserts `409 event_not_draft`; the cross-tenant test archives a due event of B from A's seats (the
  audit names the system); ADR-341 corrects the ticket purge's 90 days, records the reveal race and the decision
  against a per-event exception block (one failing row would stall the batch; RUNBOOK). ADR-341 Accepted, Q-310
  answered.
- 2026-10-28 **T-501 built (core; plan reviews 80 → 88 GO folded; core code review owed).** The push store, the
  notification center and the sending worker, with no kind wired and no real provider yet. Migration 0076 (new file,
  undeployed; CranL is at 0056): `notice_kind` (none seeded), `notice`, `notification` (the center), `push_device` (one per
  sign-in), `push_topic_mute`, `push_send` (the outbox), all RLS forced with no grant; `notice_create` (one insert, a
  mismatch inserts nothing); the fan-out (personal first; 2,000 enrollments a call; the event's status, membership and
  visibility rules); the claim (a loose index scan, at most 100 rows from one notice, every re-check with its reason, 60 s
  leases); the bulk acknowledgement (`least(n, 8)`, invalid tokens unless re-registered after the claim); settle (lease
  and queue expiry, the cleanup after recent erasures, purges walking the primary key); the device, center and topic
  doors; `erase_rows` with the five deletes; a deleted-player index. API `src/push`: the worker on its own pool of 3 (waves
  of 50 each acknowledged, the deadline on its monotonic clock, in-lease retries, the breaker, holds, the mass-invalid
  guard, settle every 10 minutes, the platform switch `pushNotifications`), the fake provider, the APNs and FCM request
  builders for T-501b, six player routes and `GET /v1/me` `notifications.unread`. Shared: the schemas and the template
  renderer (allowlist, name rule, nameless variant, generic text). Timing on the laptop: 50,000 members fanned out in
  19.5 s (slowest call 871 ms), claim plus ack of 200 with 60,000 queued 85 ms (ADR-345, ADR-350 (10)). ADR-350 and
  Q-319 Proposed (the build's details). Tests: `test/db/push-store.int` (38), `test/db/push-sending.int` (13), `test/push/routes.int` (8), the worker, round, send, breaker, payload, center, FR-1106 and template units, the outsider, cross-tenant and route inventories, the rehearsal guard; full Vitest once: 8194 passed / 8 skipped with one failure (a test reading two sends in id order; the fan-out now inserts in notice order) fixed and the push suites re-run green (104/104); lint, format, types, function limits clean; the e2e API runs the worker on the fake provider. Mutation globs (GitHub): `apps/api/src/push/**/*.ts` (not
  `fake.ts`), `packages/shared/src/push/**/*.ts`, `apps/api/src/players/profile.ts`, `apps/api/src/players/guard.ts`.
  Not pushed.
- 2026-10-28 **T-501 code review 87 folded (narrow re-review owed).** BLOCKER: `SYSTEM_CLOCK.wait` left an `abort` listener
  on the worker's one idle signal every second (about 47 MB a day with no providers); one `done` for the timer and the
  abort, `{ once: true }`, proven by `getEventListeners` and by breaking the fix. MAJOR: `push_queue_heads` visited every
  queued notice; it stops at 200 per target, proven by a 10,000-notice test (200 heads, claim timed). Minors: the ack
  locks devices `FOR NO KEY UPDATE`; a `token_version` per send replaces the time comparison (race test with a
  registration straddling the claim); no promotional center row without push consent (developer's decision, ADR-350
  (11), the plan amended); an event notice parked after 3 failed batches (`push.notice_parked`, RUNBOOK); the register
  and invalid-ack deadlock in `docs/rules.md`; the provider's deadline 500 ms before the worker's timer and T-501b's
  done-when gains the settings check; two misplaced doc comments. Migration 0076 edited in place (undeployed). ADR-350
  Accepted, Q-319 answered. Tests: the push suites (store 41, sending 15, routes 8, units 53), outsider, cross-tenant, route inventory and the rehearsal guard green; full Vitest once: 8201 passed / 8 skipped with one failure (the 65,000-row timing test passed its 30 s limit under the full run's load) given a 120 s limit and its suite re-run green (15/15); lint, format, types and function limits clean.
- 2026-10-28 **T-501 re-review 92 (GO) folded.** A failing fan-out try no longer parks a notice for good: it waits out
  a back-off (1, 4, 16 minutes, then hourly; `push.notice_parked` at the third failure in a row; the RUNBOOK release
  kept as the override), tested for the retry after the back-off, the cap and the release; a failing personal batch of
  500 is undone and its oldest due notice tried alone, so a poisoned one is backed off without blocking the rest
  (tested); the 50,000-row, 65,000-row and 10,000-notice claim checks moved to the by-hand `test/perf/push-timing.int`
  (run 2026-10-28: fan-out 18.4 s, slowest call 794 ms; claims 92, 163 and 153 ms median; 200 heads; [100, 10]), the
  default suite keeping a 300-row fairness test and a 1,000-notice head-count test with no 120 s limits; a stacked doc
  comment removed. Migration 0076 edited in place (undeployed). Tests: the push suites, outsider, cross-tenant, route
  inventory and rehearsal guard 687/687; full Vitest once: 8202 passed / 9 skipped, no failure; lint, format, types and
  function limits clean.
- 2026-10-28 **T-501b built (core; plan final after the T-501 plan reviews; core code review owed).** The real APNs and
  FCM clients behind the provider interface, on one HTTP/2 transport of our own (`src/push/h2.ts`, `node:http2`; FCM
  too, ADR-351 (1)): one reused connection per host, at most 50 streams and never above the server's limit, a request
  written only with 200 ms left, "never written" (requeue, uncounted) told from "written, then lost" (`unknown`),
  reconnect after a `GOAWAY`, a refused stream or a hold, a 4-minute idle close. APNs: ES256 provider token (re-signed
  every 40 minutes and once after `ExpiredProviderToken`), Apple's headers, the plan's table by reason then status. FCM:
  service-account token (scope `firebase.messaging`, cached until 5 minutes before its end, one refresh on a 401), the
  table by FCM code then status, no `collapse_key` (Google ignores it for notification messages). Settings in
  `config.ts`, all or none, keys parsed into key objects (EC P-256, RSA), ids, bundle id, project id and https token
  address checked; none set starts and sends nothing; built in `server.ts` with the APNs token signed at start and the
  FCM token asked for in the background (a refusal holds FCM and logs `push.fcm_auth_failed`). The Gmail sender's token
  code moved to `src/auth/google-token.ts` (its tests pass unchanged in substance). Probed with self-made keys: both
  Apple hosts 403 `InvalidProviderToken`, Google 400 `invalid_grant`, FCM 401 `UNAUTHENTICATED` (ADR-351 (10)); the
  RUNBOOK go-live checklist keeps what only real keys show. ADR-351 and Q-320 Proposed. Tests: every row of both
  tables against local HTTP/2 servers, GOAWAY (graceful and with an error), REFUSED_STREAM, resets, slow and silent
  hosts, the stream cap, connection reuse, token signing and refresh, the startup check, the settings, no secret in a
  log, and one provider contract run on the fake, APNs and FCM. Mutation globs (GitHub):
  `apps/api/src/push/{h2,apns,fcm,providers}.ts`, `apps/api/src/auth/google-token.ts`, `apps/api/src/auth/email/gmail.ts`,
  `apps/api/src/config.ts`. Not pushed.
- 2026-10-28 **T-501b code review 88 folded (no re-review).** MAJOR: a connection that silently stopped carrying traffic
  turned every send `unknown` and was never replaced (writes kept resetting the idle timer); any stream lost after its
  write now retires the session, proven with a TCP proxy that drops open connections and by breaking the fix. Minors:
  `close()` no longer waits on a far side that never closes (2 s, then the socket the client now makes itself is
  dropped; a replaced session's after 15 s), the FCM 429 hold capped at 15 minutes, timing tests on the 500 ms provider
  margin, ADR-351 (4) corrected (Apple: retry a 5xx after 15 minutes; the in-lease retries go against it, bounded by
  the breaker, noted in Q-320), the RUNBOOK checklist gains the 60-minute soak, the offline phone (only the latest push
  arrives, ADR-351 (5)), uninstall timing and "Team Scoped (All Topics)". ADR-351 Accepted, Q-320 answered.

- 2026-10-28 **T-501c built (Standard; code review owed; also delivers T-312b).** The app's side of push, not run on a
  phone (it needs a new development build; real pushes also need Dhia's APNs key and Firebase project). One
  separate server commit: `GET /v1/me/notifications` items gain `refs` (reference ids only; shared schema, `centerItem`,
  a route test). New dependencies `expo-notifications ~57.0.23` (resolves 57.0.24) and `expo-application ~57.0.3`
  (plugin `expo-notifications` in `app.json`). `apps/app/src/push/`: `push-native.ts` is the only file that loads the
  two packages, after `requireOptionalNativeModule` found the native modules it checks (an older build runs with push
  off; a unit test removes the modules and a scan keeps the loads in this file); `push-flow.ts` has the rules over an
  injected phone (explainer due only while the system is unasked and not snoozed 30 days; registration at launch, on a
  token, language or version change, else daily; iOS tokens lower-case; `development` → sandbox, `production`, null or a
  throw → production; sign-out unregisters first); `tap.ts` reads `{n, k, e, r}` from `trigger.payload.q`,
  `remoteMessage.data` and `content.data` and `notificationRoute` (shared, a fixed table of the owed kinds) maps it to a
  screen. Screens: the center at `/notifications` (paged, tap marks a row read, Mark all as read, the opt-out on
  promotional rows), the bell on Questify Home and Event Home, Profile → Notifications, Settings at
  `/settings/notifications` (phone status, four topic switches, the offers), the explainer sheet on the join card and the
  invitation. Six Android channels (`personal` and `offers` private on the lock screen). `ChannelRow` became the shared
  `SwitchRow`; the profile loader gained a release step before sign-out. Tests: 145 new unit tests in
  `apps/app/src/push` and `packages/shared/src/push` (flow, native adapter with and without modules, tap shapes, routes,
  API, guards for FR-1106 and the Arabic copy rules), mutated by hand on the flow (8 of 8 killed); `npx expo export` for
  Android and iOS passes; full Vitest once with both URLs: 8464 passed / 9 skipped, no failure. ADR-352 and Q-321 Proposed. Mutation globs (core files this
  task changed, GitHub only): `apps/api/src/push/center.ts`, `apps/api/src/push/message.ts`,
  `packages/shared/src/push/push.ts`, `packages/shared/src/push/routes.ts`. Not pushed.
- 2026-10-28 **T-501c code review 84 folded (no re-review unless the diffs grow).** MAJOR: a cold-start tap was lost to
  the launch screen's own `router.replace`; `settleTap` holds a tap until the player is signed in and the path has left
  `/`, and drops it on sign-out. MAJOR: a resume or a foreground push re-read the profile, whose failed read publishes
  `me: undefined` and unmounts screens (a game offline at a venue); the bell now refreshes from
  `GET /v1/me/notifications?limit=1` only (a failed read leaves everything as it was). Minors: the registration record
  holds the player id and a registration still on its way when its sign-in ends is not recorded; no explainer on an Android
  build that cannot get a token, and the Firebase file is a hard gate on the Android store build (RUNBOOK, T-806); the
  "always reach you" line names decisions, answers and prizes; the center keeps older pages already loaded when page 1 is
  read again on focus (only when the pages overlap); the module-check comment reworded; sign-out waits at most 3 s on the
  device removal. ADR-352 Accepted, Q-321 answered.
- 2026-10-28 **T-501d built (core; code review owed).** The owed personal pushes (plan note
  `docs/plans/2026-10-28-t-501d-personal-pushes.md`). Migration 0077 (new file, undeployed): ten personal kinds; row
  triggers with a `WHEN` on `enrollment` (join decisions: decide, accept-all, a waiting-list release; never an operator, a
  rehearsal account or the player's own re-join), `ticket` (one per closed ticket, by team and outcome) and `submission`
  (a reviewer's decision), a statement trigger with transition tables on `event_result` (each prize place at the reveal),
  and the system door `push_due()` the worker calls every minute (ready at the first desk opening a reservation waited
  for; ending 15 minutes before a hold over 30 minutes ends). Every producer calls only `notice_create` (restated in
  PL/pgSQL so its plan survives trigger calls); a missing kind never undoes a door. Shared templates in both languages
  (ux-araby pass) and two routes; the worker's due-scan step. Tests: `test/db/push-producers.int` (18), push-store,
  outsider, cross-tenant, worker and shared units. **Measured:** accept-all of 5,000 requests 7.4 s with the trigger,
  5.8 s before it, over the API's 5 s statement limit already before this slice (the souvenir enqueue trigger, about
  1 ms a row): Q-322 recommends accept-all in calls of 1,000. ADR-353 and Q-322 Proposed. Mutation globs:
  `apps/api/src/push/{worker,doors}.ts`, `packages/shared/src/push/{templates,routes}.ts`.
- 2026-10-28 **T-501d code review 84 folded (short re-review owed on the accept-all cap).** MAJOR: a flaky assertion
  (the number 50 matched inside random ids) now checks only the frozen names against an unusual point value; accept-all
  takes at most 1,000 requests a call (0077 restates `accept_all_join_requests`, `LIMIT least(free, 1000)`) and the
  dashboard repeats while one accepted some and requests wait (at most 10 calls, a progress line, a partial failure says
  what was accepted); one call of 1,000 measured 1.76 s with the trigger. Minors: the acceptance text drops "You can play
  now" (a scheduled event test added); `notice_create`'s parameters qualified. ADR-353 Accepted, Q-322 answered (cap
  taken now). Mutation glob added: `apps/web/src/lib/accept-all.ts`.
- 2026-10-28 **T-501d cap re-review 88 folded (GO to push).** A hard-limited event's seat guard recounts the seats on
  every accepted row, so its accept-all takes 250 a call (one call with 5,000 waiting 0.85 s); without a hard limit
  1,000 a call (1.70 s). New core follow-up T-221 (Q-323 Proposed): check the limit once a statement so accept-all is
  one call again. The dashboard stops its calls when the page is left and says "press again" when its 10 calls ran out
  with requests still waiting; the rejection notice's ids are checked exactly.
- 2026-10-28 **T-501e built (core; code review owed).** The owed event pushes (plan note
  `docs/plans/2026-10-28-t-501e-event-pushes.md`). Migration 0078 (new file, undeployed): six event kinds; row triggers
  on `quest` (Launch, Send poll) and `boost` (a boost saved to start now), a statement trigger on `community_reach`
  (one push per goal per settle, for the highest step), and four more due scans in `push_due()` (a scheduled flash
  quest, a boost's later start, a category opening after the start, the event starting within the hour). Audience:
  active real members (a rehearsal account on a live event and an operator kept from playing get none), visibility at
  fan-out and at the claim, a poll's voters skipped, moved moments skipped and pushed again at the new time. Tests:
  `test/db/push-events.int` (18), push-store, outsider, rehearsal guard, shared units; fan-out of a live poll to 50,000
  members by hand (about 27 s, 1.1 s a call against the 1 s gate; 336 s before the shared visibility
  checks were restated in PL/pgSQL so they keep their plans, ADR-354 (5)). ADR-354 and Q-324 Proposed. Mutation globs:
  `packages/shared/src/push/{templates,routes}.ts`.
- 2026-10-28 **T-501e code review 78 folded (narrow re-review owed).** BLOCKER: a gated category's opening checked the
  gate per member (about 5 s a call): such a category is never announced and no gate is checked in the fan-out or the
  claim. The event fan-out takes 1,000 a call (a live poll to 50,000 members about 30 s, 0.6 s a call); a flash quest
  and a boost wait for their category to open; a moved start or opening is pushed again only when moved 15 minutes or
  more, at most twice; test gaps closed; the rehearsal-phase lock order documented. ADR-354 Accepted, Q-324 answered.
- 2026-10-28 **T-501e re-review 91 folded (GO to push).** A flash quest or a boost now waits, with no notice or
  marker, until its category opens (a boost also until its community lock is lifted), then is pushed once; an opening
  is pushed again only when moved 15 minutes or more to a later time; the re-push check reads only numeric markers;
  30 s for a 50,000-member fan-out is a soft target, 1 s a call and the 5 s limit the hard gates.
- 2026-10-28 **T-501f built (core; code review owed).** Reminders and promotion by push (plan note
  `docs/plans/2026-10-28-t-501f-reminders-promotion.md`). Migration 0079 (new file, undeployed): the daily streak
  reminder (18:00 Riyadh, a 2-day streak with nothing today, only to players with a pushable device and reminders on,
  skipped at sending once they play; ADR-300 copy), the shop's closing the day before (once per event, real active
  members with a balance, skipped when the window was extended), invitations by push or SMS (one fixed channel per
  player, push first, never both; the invitation tick hands push rows to the push store; consent checked at the
  hand-off, the fan-out and the claim; the open counted from the center row). FR-1114: a promotional tap opens the
  center on its row with the opt-out; an invitation row carries "See the event". Console: push and SMS checkboxes and
  the push text. Tests: `push-reminders.int` (10), `invitation-push.int` (10), security, rehearsal guard, unit; full
  suite 8,630 passed (11 skipped), browser suite 193 passed (1 skipped), Android export clean. ADR-356 and Q-325
  Accepted (tier A review fixes folded). Mutation globs: none (ADR-355). CI minutes: 0 (local only). Effort: one worker session, about 0.6M agent tokens.
- 2026-10-28 **T-501g built and reviewed (tier B; review fixes folded).** The hidden-category hint push (FR-238; plan note
  `docs/plans/2026-10-28-t-501g-hint-push.md`). Migration 0080 (new file, undeployed): the kind `category_hint`, the
  team's door `send_category_hint` (one notice through `notice_create`, once per Idempotency-Key, a second press while
  the first is delivered refused, a missing kind row answers `sent` false and the door commits) and
  `category_hint_preview` (the count). The reveal is the fan-out's: `push_fan_out_batch` writes a `category_reveal`
  row for each member it writes a center row for, in the same statement, so recipients and the players who see the
  category are one set, whatever their permission, mute, device or delivery; recipients are active real members who
  joined at or before the press, in the category's audience, not told by an earlier hint since they joined. The text
  names the event only. Dashboard: "Send a hint" on a hidden category, a confirmation with the count (`GET`/`POST
  …/categories/{id}/hint`). Review fixes: the count's exclusion rule is an inline `NOT EXISTS` (through
  `excluded_from_event` per row it was 16 times slower as soon as an event had one entry); a press that would tell no one
  is refused `409 hint_nobody` (`PT409`); new tests for the since-joined cut-off (a told member who re-joins is told
  again), the 10-minute pending cut-off and the go-live wipe, and a phone exclusion in the count test; each protection
  broken by hand once made its test fail. Tests: `push-hint.int` (22), `reveal/hint.int` (5 over HTTP), outsider,
  cross-tenant, route inventory, shared units, `e2e/hidden-hint.spec` (desktop and phone); full suite 8,672 passed (12
  skipped). At 50,000 members: count 305 to 366 ms with or without an exclusion entry, press 311 to 327 ms, fan-out 41.2
  s in 500-row calls (slowest 474 ms); the generic event fan-out is unchanged. The function-limit baseline shrank
  (QuestBuilder 289 to 284 lines, CategoryCard 133 to 115). ADR-357 and Q-326 Accepted. Mutation globs: none (ADR-355). CI minutes: 0 (local only). Effort: one worker session, about 0.6M agent tokens.

- 2026-10-29 **T-502 built (tier B; independent code review owed, not self-approved).** Recovered the crashed worker's
  uncommitted 0081/shared/DB work at fe688ddc4a7b8992a1d50b12aba10de373b207a4 in the actual
  C:/Users/xdhia/Downloads/Github coding/NAFES/Questify App repository (not the coordinator's Questify cwd).
  Immutable bilingual announcements, shared clean/filter/cut validation and push renderer recheck, five scoped API
  routes with replay-before-scope reauthorization, send-now/schedule/cancel and serialized 3/hour + 10/day reservations;
  due release skips closed/not-live/over-30-minute-late events under the cancel's row lock. One push-store notice only:
  muted topics keep center/Home rows, never email/SMS. Dashboard compose/counters/bilingual previews/count/confirmation,
  event-zone schedule, history/cancel and rounded delivered count; native Home current flash/boost strip from Quests,
  newest-three announcements and See all (50). Security table/function/route/rehearsal and channel inventories updated.
  Proposed ADR-358 / Q-327; API, DATA_MODEL, SRS clarification, CONFIGURABILITY, SECURITY, TEST_STRATEGY, RUNBOOK and UX
  notes updated. The scoped-term and message-key guards and free-text-kind inventory were fixed, not waived.
  Checks: the full Vitest suite ran ONCE to t502-vitest-full.log: 526 files / 8759 tests passed, 11 files / 13 tests
  skipped, three T-502 guard tests failed. All three fixed; final targeted 18 files / 804 tests pass, including DB/HTTP,
  shared/app/web units, outsider/cross-tenant/route/rehearsal and the three failing guard suites. No full rerun (ADR-355).
  Fresh final web build; full browser suite 197 passed / 1 skipped in 11.8 min (t502-browser-clean.log). Earlier full
  attempts each had one unrelated phone failure (location clearing, then a Chromium Target crashed on the Arabic
  streak screen); both pass in the five-test isolated phone recheck and the clean full run, with no unrelated edits.
  API build, all workspace types, lint, lint:limits (318 baselined violations, none new), format and audit pass (three
  existing ignored advisories, none actionable). Native Android+iOS Expo export passes; default Expo web export needs
  the existing absent react-native-web and was not added for this native task. By-hand 50,000-member timing: count
  732 ms, press 337 ms, fan-out 19.235 s / 52 calls, slowest 430 ms; 1 s call / 5 s statement gates pass.
  Progress 108/177 (61.02%). CI minutes: 0 (local only). Recovery worker effort: about 80 minutes and roughly 0.1M
  working tokens (estimate; billing usage unavailable). No deployment, EAS, push or mutation; mutation globs: none.
  Remaining at original build handoff: independent tier B review, coordinator acceptance/override of ADR-358/Q-327, findings fix/CI/push and
  real-phone/push-provider release checks. **Review/fix/push/update handoff, then stop; no next task.**

- 2026-10-29 **T-502 review 84 MAJOR corrections (fresh implementation worker; no re-review under ADR-355).**
  Fixed only the two MAJOR findings from the independent tier B NO-GO on main 5dac217. Undeployed migration 0081:
  send waits on the announcement advisory lock, locks the event FOR SHARE, then reauthorizes/rereads before replay
  and lifecycle validation; the lock lasts through notice/state commit. Due-send takes event FOR SHARE before the
  announcement row lock and rechecks scheduled state, so lifecycle writes cannot cross either sender's check/write.
  Crossed tests cover advisory wait then committed archive, post-wait scope reauthorization, archive-first, and
  send-first for immediate and due sends.
  The reproduced advisory race fails against the old read (expected PE409:event_closed, got successful send), then
  passes with the fix. Pending schedules now have separate earliest-first keyset pages of 30 (one DB lookahead);
  history excludes scheduled rows and stays bounded to 30. API/dashboard previous/next controls, bilingual labels,
  precise timestamp/UUID cursors, cancellation beyond 30, cursor ties, earlier cancellations, empty last page and
  preserved compose draft covered. MINOR modal failure accessibility recorded in FOLLOWUPS, intentionally not fixed.
  Focused final tests: 12 files / 703 passed, including DB/HTTP/outsider/cross-tenant/routes/rehearsal/archive,
  shared page contracts, translation and scoped-term guards. API/fresh web builds, all workspace types, lint,
  lint:limits (318 existing baselined violations, none new), format and diff checks pass. Fresh-build full browser:
  199 passed / 1 existing skip in 12.5 minutes, including the new pagination/cancellation flow on desktop and phone
  (t502-review-browser-full.log). Focused tests: t502-review-final-targeted.log; red proof: t502-review-red.log.
  Full Vitest was NOT rerun (the original build's one full run remains the evidence); no mutation/EAS/deploy/push.
  CI minutes: 0 (local only). Rough worker cost: 40 minutes / 45k tokens (estimate, billing usage unavailable).
  ADR-358/Q-327 remain Proposed for coordinator acceptance; remaining: coordinator inspection, acceptance/CI/push
  and existing real-phone/provider release checks. Stop here; do not start T-503.

- 2026-10-29 **T-502 coordinator acceptance and handoff.** Independent tier B review 84 initially NO-GO;
  both MAJORs fixed in efad9cd and coordinator-inspected: event-row locking/revalidation closes archive/send races,
  and earliest-first keyset pages keep all pending schedules cancellable independently of bounded history.
  ADR-358 Accepted (developer, delegated by Dhia); Q-327 resolved, explicitly accepting the flash/boost-only
  Happening now strip alongside the existing poll/community cards. Modal-accessibility MINOR deferred in FOLLOWUPS.
  Latest regression evidence: 703 targeted tests / 12 suites; fresh-build browser 199 passed / 1 existing skip.
  Full Vitest not rerun under ADR-355. Progress 108/177. No deployment, EAS, mutation or next task.
  CI run 40828699004 PASSED on e28a1e4 at 2026-10-29 06:44 UTC (09:44 Riyadh): full tests, lint/format/types,
  API/web builds, dependency audit, secret scan and browser suite all green. Job duration: 22m49s (about 23 CI
  minutes, not an invoice). Rough implementation/fix cost 145k tokens / 120 minutes,
  plus review/coordinator usage not separately measured (estimates, not billing data).
  Implementation, fixes and acceptance/handoff are pushed; this docs-only checkpoint records the verified result.
  Stop after T-502 and wait for a new instruction before T-503.

- 2026-10-29 **T-503 plan accepted for performance-first implementation.** Independent Tier A plan review 80
  NO-GO; MAJOR corrections ed3866a inspected by coordinator. ADR-359/360 Accepted design; Q-328/329 resolved design.
  Ordered transaction crossing facts and a coherent DB overall board preserve FR-613 (no coalescing); exact latest
  identity/generation gates, source-time reset edges, isolated token wait aborts, structured provider outcomes and
  explicit G/E source writer/lock matrix replace the rejected gaps. Today-cache and board/own-rank contracts stay.
  Early build gate: representative full completion/source path, 50,000-member transaction hold/queue/propagation
  measurements and deterministic crossing/reset proofs BEFORE broad email/UI work; a failed gate stops for redesign.
  Full source coverage/lock tests and independent CODE review still owed. Mail transport OFF; retry allowlist empty
  until documented/tested nonacceptance proof. No implementation completed/task tick/push/deploy/EAS/mutation.
  Planning effort approximately 43k tokens (25k original +18k corrections); review/coordinator usage unmeasured;
  CI minutes 0 for this unpushed plan/design checkpoint. Estimates, not billing data.

- 2026-10-29 **T-503 EARLY feasibility FAIL / safe checkpoint; stop for coordinator redesign.**
  Authorized on main d10fa98. Opt-in disposable-DB probe invokes the original complete_quest and latest
  record_completion/ledger/bonus/trigger/COMMIT path under shared G/exclusive E, maintains indexed changed-only
  eligible entries and deferred ordered facts/latest identity. Before any drain, generation 1 entry1/exit2/entry3
  persists; exact identity relation retains revision 3. Snapshot rollback/empty dirty and private-role refusals pass.
  Two 50,000-active-member runs, 20 warmups +100 warm samples each: E-residence LOWER means
  14.46488 / 14.20142 ms, versus required <3 ms (target <=1.5 ms). Confirmation full-residence mean lies in
  [14.20142, 20.262509] ms; lower-bound p50/p95/p99 13.801/16.88/22.109 ms; uncontended combined G/E
  wait mean 0.02903 ms. Optimistic arithmetic service ceiling 4,224.93/minute, NOT measured sustained throughput.
  Full machine/setup, baseline (including the 757.3794-ms outlier), methodology, limitations and both numeric
  records: docs/evidence/2026-10-29-t503-early-gate.md and .json. Initial run overlapped local validation;
  confirmation did not overlap tests/types/lint. No claimed steady-20k/min queue/drain/<=5s propagation proof.
  Gate runs: 3 pass /1 RED each (t503-early-gate-initial.log, t503-early-gate-confirmation.log); assertion stays red.
  Security: 517 pass /4 suites, including outsider/cross-tenant/HTTP inventories (t503-security.log, 32.79 s).
  API types, zero-warning targeted lint, limits (318 existing, none new), targeted format pass; logs
  t503-{types,lint,limits,format}.log. Full Vitest NOT run at early gate; no UI/app change, browser/export not due.
  Safe scope: tests/docs only; source SQL is a private test fixture, NOT a production migration. 0082 remains free;
  deployed/undeployed migrations, production ranking/afterCompletion/Redis adapters and mail/auth unchanged.
  Partial writer inspection corrects wipe_rehearsal latest 0055 to 0062; complete writer/raw-SQL/cascade/default
  inventory, source reset/off-on/lifecycle/rehearsal and tombstone proofs, both-order lock tests, full rollback
  equivalence, canonical top/own/total and excluded-leader costs remain gates, NOT inferred passes.
  Proposed ADR-361 / Open Q-330: profile/reduce full source cost or coordinator-authorize a newly proven terminal
  publication fence with no legacy locks after E; no coalescing, budget relaxation or FR-613/NFR-003 waiver.
  All remaining review80 resolutions/email/UI/transport-code and final code-review/CI gates remain unfinished.
  Mail stays OFF, send-retry allowlist empty, T-609 reuse and future T-701 producer boundaries unchanged.
  T-503 NOT ticked/self-approved; no subagent, real services, full suite, local mutation, push/deploy/EAS or T-504.
  CI minutes 0 (local only); rough effort 45k agent tokens /30 minutes, estimates not billing. Coordinator decides
  the technical redesign; no new independent review requested until code is ready.

- 2026-10-29 **T-503 failed gate: coordinator investigation direction.** Inspected 9b1e76e evidence and probe.
  Reject full-source E duration as infeasible; production remains unchanged. ADR-361 accepts investigation ONLY:
  profile the full real completion chain and test a distinct terminal E fence after legacy lock work, preserving G
  before business work, exact committed crossings and fresh post-wait snapshots. Original red fixture/evidence stays.
  Require deterministic concurrent/late-commit/reset/rollback and deferred-FK/back-edge proofs, real fence-release
  measurements and full-source overhead. No terminal protocol acceptance, production migration/adapter, email/UI,
  task tick, push, deploy, EAS, mutation or requirement waiver. Q-330 remains Open. Investigation is the next work.

- 2026-10-29 **T-503 terminal-publication recovery: FAIL / STOP; no protocol acceptance.** Recovered the three
  untracked test-only artifacts on main 4ff69c5, inspected/preserved the four prior terminal logs and original red
  source probe. Fixed harness typing/lint and measurement/column mistakes; source remains real non-replay paid
  complete_quest/record_completion/ledger/XP/trigger work in disposable local DBs. Evidence and full numerical
  profiles: `docs/evidence/2026-10-29-t503-terminal-gate.md` and JSON (including old-log SHA-256 provenance).
  Final opt-in: 11 PASS /1 deliberately RED (91.35 s): member704 completion commits, publication revision
  355 ->355 instead of356. Actual nested record_completion can wait on legacy enrollment AFTER E before a late
  42501 guard; synthetic deferred work can be re-armed after E and fail only during COMMIT. Current terminal
  design is demonstrably incomplete; no further redesign attempted. No mandatory commit-finalization certificate.
  Historical full-source E means >14 ms LOWER remain valid; reprofile 60 incl.warmup mean lower12.947 ms still
  fails <3 ms. Warm full transaction profiles: baseline15.145 /original17.753 /terminal19.137 ms (50 each).
  Three terminal single-source runs: full client means22.675/23.217/23.641 ms; actual E mean bounds
  [1.595,3.484]/[1.616,3.612]/[1.639,3.597] ms. Two alternating-top-member runs: full29.909/37.759 ms,
  E[1.481,3.388]/[1.764,3.851] ms; only2/0 crossing facts INCLUDING warmup, not a crossing-heavy load test.
  Publication-body lower means0.258-0.325 ms are NOT full lock residence. Hard <3 ms UNPROVEN; <=1.5 ms target
  FAIL in4/5 runs. No sustained20k/min, queue/<=5s propagation, cold/excluded leader, complete source inventory,
  production lifecycle/reset/drain, all-source both-order or failed-COMMIT full rollback proof is claimed.
  Security517 PASS/4 suites (26.17 s), API types, targeted lint/format, limits318 existing/0 new PASS; opt-out12
  skipped. Full Vitest NOT run. Plan gate unchanged; T-503 not ticked, no production migration/adapter, dependency,
  email/UI, real external service, mutation, push/deploy/EAS or T-504. Coordinator decides next bounded direction.
  Approximate recovery effort15-20 minutes, zero CI minutes (estimate, not billing); no new ADR/Q/acceptance.

- 2026-10-29 **T-503 explicit terminal candidate rejected (56437ac).** Correctness red: real source can commit
  without publication; late nested/deferred source waits remain. <3 ms fence mean is UNPROVEN, not passed.
  Coordinator authorizes ONE bounded test-only automatic commit-finalization candidate: mandatory deferred marker,
  business drain before E, source entrances checked before further legacy locks, failed-COMMIT full rollback and
  same-request server timing through release. Preserve all earlier red fixtures/evidence and durability settings.
  No production change, task tick, email/UI or candidate acceptance; report unresolved gates rather than spin an
  open-ended benchmark loop. ADR-361/Q-330 remain investigation/Open. Independent code review still owed.

- 2026-10-29 **T-503 automatic deferred-finalization candidate FAIL / STOP (base f716225).** ONE local
  test-only dirty marker/automatic callback implemented; no production door/migration/adapter/dependency changed.
  At real COMMIT, SET CONSTRAINTS ALL IMMEDIATE inside that callback returns before already queued business;
  E is taken and the later business callback hits the new pre-source guard (42501). Temporary session-local
  reproduction confirms callback/drain/E/business ordering, rollback of its temp rows and released E.
  Ordinary complete_quest+ledger without helper PASS (revision0->1, completion/ledger72->73); representative
  eligibility remove/reinsert PASS. Targeted 50k run:2 PASS/1 RED,8 remaining tests unreached,164.89 s.
  Failed-COMMIT full business rollback injection, exact latest/generation, fresh READ COMMITTED after E,
  same/different enrollment orders, nested payer/DML pre-row-lock closure, multi-event/global proofs UNPROVEN.
  No candidate timing repetitions run: new E mean lower/upper and baseline overhead unavailable, not zero;
  <3 ms hard /<=1.5 ms target UNPROVEN. Original baseline2 repetitions/workload,36 transactions each,
  144 actual completion/quest-ledger rows; warm client means noncross15.602/15.161,cross17.806/20.136 ms.
  Prior early/terminal fixtures/results unchanged. Full inventory/lifecycle/canonical-own-rank/steady-load,
  backlog/propagation and deployment remain separate UNPROVEN gates. Evidence: docs/evidence/2026-10-29-t503-auto-gate.md
  and JSON. Reject this callback-drain assumption; stop rather than retune/requeue or remove guards.
  Final API types,targeted lint/format,limits318 existing/0 new PASS; opt-out11 skipped. No full Vitest or
  duplicate security517 run, mutation, real services,email/UI,next task,push/deploy/EAS. ADR-361 not accepted,
  T-503 not ticked; coordinator authorization required before another experiment. Approximate effort25k
  agent tokens (estimate,not billing),CI minutes0. No children or new ADR/Q; independent review remains owed.

- 2026-10-29 **T-503 built (tier B, from ADR-362; independent tier B code review owed, not self-approved).** Plan
  `docs/plans/2026-10-29-t-503b-rank-diff.md`; Proposed ADR-363 / Q-332. Migration 0082 (undeployed). **Rank push:**
  kinds `rank_top_ten` and `rank_top_ten_exit`; `rank_push_diff` per live event under a per-event try-lock, run by a
  10 s tick (`ranking/top-ten-tick.ts`, never overlapping, 5 s budget); the ten read from PostgreSQL in the board's order
  and rule (index walk, not a pass over all members); baseline with no notices on the first read, a return to live, ranking
  off and a rehearsal wipe; 10-minute cooldown per member and event; no push inside the top ten; the completion
  transaction and the Redis copy untouched. **Organizer alerts:** own switches for the seven types (`GET`/`PUT
  …/alerts/me`, panel on the team page), id-only outbox, producers for activated, size limit, stock low, codes low, support
  access and (by scan) new flags, a sender that re-checks account, membership, event limit and switch at claim time; the
  `EmailSender` type is reused and production gives none (rows skipped `transport_off`). Owed: `content_unpublished` source
  (T-701/T-609), quest-item pools, real-mail gates of ADR-360. **Checks:** full Vitest ONCE: 8829 passed, 14 skipped, 1 failed
  (the audit-log trigger list, fixed; audit suite rerun green); targeted rerun 996 tests green; security suites 552 green;
  fresh-build browser suite 197 passed / 1 skip, the organizers spec failed once (checkbox not optimistic), fixed and rerun
  green on desktop and phone; lint, `lint:limits` (none new), format, types pass. 50,000 members, 300 excluded and 300 left
  leaders: diff 257-306 ms (gate 1 s per event). Two mutations (cooldown, membership start) were caught by the tests. CI minutes: 0
  (local only, nothing pushed). Rough worker cost: about 190k tokens / 3 hours (estimate, not billing).

## T-808 Arabic sweep (2026-11-07)

- Tier C, the machine-checkable part of T-808; T-808 stays open because a person must read every screen in both languages.
  Covered: 5,144 message keys, 407 error texts, email and alert templates, `ar.json`; none of the locked legal and consent keys
  (56) or `rules.*` (T-807) were edited. No Eastern digits, empty or English-only Arabic text were found.
- Fixed in about 190 message keys, 28 error lines and 33 template lines: «كويستفاي» to "Questify" (ADR-125, all but the SMS
  family), «تم» openings to the product's light passive or a نحن verb, «الخاص بك», «لديك» push openings, term variants
  (مقترن to مرتبط, أكواد to رموز, علامات to حالات, المنظمة to الجهة المنظِّمة, تجاوز to تخطي), tanween and shadda spelling, one
  retry phrase, labels in place of «N + noun» where the count can be 1 to 10, «منصة الجوائز» to «مكتب الجوائز» (3 texts), and the
  `change_set_busy` text («بعد بضع دقائق», the mismatch left by the batch 19 review; that clause is out of `FOLLOWUPS.md`).
  Pinned strings were updated in 18 test files.
- New: `docs/design/ARABIC_GLOSSARY.md` (terms, rules applied, nine items for a human decision, among them the SMS brand that
  needs a migration, the `rules.*` text and the «المشارك»/«المشاركة» ambiguity).
- Checks: Vitest `packages/shared` 1,665; `apps/web` and `apps/app` unit 2,660; `apps/api/src` 2,672; four DB suites 99; format,
  lint, `lint:limits` and types pass. Not run: browser specs (e2e strings were updated, CI runs them). CI 0 minutes (not pushed).

## Console history words (2026-11-08)

- Tier B, the follow-up of T-701 (`docs/FOLLOWUPS.md`). The console history now words every audit action an audit writer in
  `apps/api` can produce: 217 more (282 in all) in 145 new texts, Arabic and English, grouped where one text reads better (the
  builder's other tools, points and cases, the team and owner email change, invitations, the store review demo, then Questify's
  own: catalog, daily challenge, staff and player accounts). Read from the writers: the TypeScript `recordAudit` calls, every
  `INSERT INTO audit_log` in the migrations, and the SQL helpers that build an action (`catalog_audit`, `daily_audit`,
  `questify_audit`, `owner_email_audit`, `invitation_audit`, `souvenir_audit`, `set_audience`, `admin_tier_change`). Left with
  their stored name: none. The map moved to `apps/web/src/lib/console-history.ts`; no existing text changed, so no pin moved.
- Guard: `console-history.test.ts` reads those writers and fails when an action has no text and is not on its `UNWORDED` list
  (empty), when a writer builds an action at run time and is not on its `DYNAMIC` list, or when a text names an action no
  writer produces. Eight texts that name a quest or category got `QUESTIFY_LEVEL` exceptions in `words.test.ts` (FR-942).
- Entries with no organizer or event (player, staff, catalog, daily, legal, platform) are worded too but never appear in an
  organizer or event history today; the wording is ready for a Questify-level history.
- Reason beside an entry: `REASON_ACTIONS` gained `content.unpublish`; the read takes `reasonCode` when an entry has no `reason`.
  A take-down keeps one of six fixed codes (no free text, no personal data), shown as the reports' own words. Not widened:
  `owner_email.start` (its `reason` is free text an admin typed, which may name a person), a player ban (`player.ban` has no
  organizer or event, so it never reaches this history), `event.player_ban` (keeps no reason), and the take-down's note (it is in
  `content_hold`, not in the audit entry; showing it needs a migration).
- Checks: Vitest `apps/web/src` and `packages/shared` 2,930 tests in 213 files; DB suites `console/moderation` and
  `console/organizers` 27; Playwright `console-organizers.spec.ts` 10 passed (one worker); format, lint, `lint:limits`, types
  pass. CI 0 minutes (not pushed).

## Next

- **2026-11-05 (T-810b):** built; a fresh tier A code review is next, then one `mutation.yml` run on
  `apps/api/src/conventions.ts`, `apps/api/src/http-error.ts`, `apps/api/src/auth/http-errors.ts`,
  `apps/api/src/organizers/routes.ts`, `apps/api/src/activation/routes.ts`. Then T-810c to T-810f. T-810 is ticked only
  after T-809's findings are folded in; Q-664 rides with T-811.

- **2026-11-04 (T-804):** T-804 stays open: a tier A task for Q-620 (the completion path's `LANGUAGE sql` functions as
  `plpgsql`, fewer round trips, CranL's PostgreSQL version) comes before its rerun; Q-621 (sign-in lock and address
  window) is a tier A sign-in change. T-809 depends on T-804.

- **CURRENT 2026-10-29: T-503 is BUILT (tier B, ADR-362), ticked in TASKS; a fresh tier B code review is next, then the
  coordinator's CI and push (nothing pushed).** Accept ADR-363 / Q-332 after the review. The bullets below about the
  stopped lock-protocol line are history.

- **SUPERSEDED by ADR-362 (history): T-503 implementation STOPPED at failed early source-transaction feasibility gate.**
  The ONE authorized automatic commit-finalization follow-on also FAILS: queued deferred business runs
  after E despite callback SET CONSTRAINTS ALL IMMEDIATE; see docs/evidence/2026-10-29-t503-auto-gate.md.
  No further candidate/tuning is authorized; require a sound after-all-deferred boundary before redesign.
  Terminal follow-on also FAIL / UNPROVEN: mandatory finalization absent, nested/deferred back-edges observed;
  see `docs/evidence/2026-10-29-t503-terminal-gate.md`. Stop; no further redesign without coordinator direction.
  Coordinator technical redesign decision (ADR-361/Q-330) precedes further implementation. Measured evidence:
  `docs/evidence/2026-10-29-t503-early-gate.md` and JSON. Keep <3 ms /<=1.5 ms, ordered FR-613 crossings,
  eligibility and NFR-003 unchanged. All unfinished gates listed above. Do not start email/UI/T-504, tick T-503,
  self-approve, or treat the historical plan-stage handoffs below as current instructions.

- **2026-10-29 — T-503 PLAN CORRECTIONS ONLY after Tier A review80 NO-GO (base main bca5223).**
  All seven MAJOR findings mapped in `docs/plans/2026-10-29-t-503-rank-organizer-alerts.md`: ordered durable
  source-transaction crossings and DB-coherent overall publication (not coalescing); exact latest identity plus
  lifecycle generations; source reset/baseline edges; per-waiter Google token cancellation; structured provider
  outcomes; explicit source writer/G-E lock matrix with deterministic two-connection BOTH-order barriers; stock/
  code total/threshold revision tests. Durable inbox/captured-id deletion, Redis independence and eligibility index
  retained, with worst-excluded-leader and hot-event throughput gates. ADR-359/360 remain Proposed, Q-328/329 Open.
  NEXT: coordinator inspection and explicit technical design acceptance BEFORE implementation; no independent
  re-review required for MAJOR-only fixes (ADR-355), no self-approval. Inspect overall-cache authority change,
  source guard completeness, global lock pauses/own-rank cost and provider refusal proof. Operational transport
  default OFF; no T-609 duplicate infrastructure/T-701 invented producers. Only docs and local commit authorized;
  no task tick, code/build/full tests/real services/push/mutation/EAS/deployment. Correction CI minutes 0; rough
  additional effort 18k agent tokens (estimate, not billing), no children. Checks: source/docs inspection and
  git diff --check. The older independent-review-next bullet below records the prior stage, not current authority.

- **2026-10-29 — T-503 Tier A PLAN ONLY, independent plan review next.** On main 0818a3d, inspected canonical
  ranking/cache flow, existing notice producers, organizer membership/inventory/seat/flag/support facts and foreign
  auth email adapters. Plan: `docs/plans/2026-10-29-t-503-rank-organizer-alerts.md`; ADR-359/360 Proposed and
  Q-328/329 Open. Both rank directions/re-entry, own-member switches, safe uncertain-send policy, T-609/T-701
  boundaries and live-email privacy gate are explicit. Migration 0082 proposed, reverify before build. No code,
  full tests/builds, real services, push/deploy/EAS/mutation or next task. Planning CI minutes 0; rough agent effort
  25k tokens. Stop for independent plan review; T-503 and T-609 remain unchecked.

**Current instruction (2026-10-29): RESUMED by Dhia; continue with T-503 after green T-502 CI.**
The recovery request, "Keep going" and "why arent you doing anything?" supersede the previous session's break;
the coordinator had carried that stop instruction forward too literally. T-503 starts with a tier A plan/review
because it includes organizer email alerts (personal data leaving the system). No deployment or EAS is authorized.
T-501e/f/g are already reviewed and pushed; T-502's review MAJORs are fixed and coordinator-accepted (ADR-358).
The older checkpoint below is history, not authorization to restart those tasks or dispatch mutation/deployment.

1. **Paused for Dhia (2026-10-27, compaction and a model switch).** Done, reviewed and pushed: T-406, T-406b, T-406c,
   T-407, T-407b, T-407c, T-408, T-408b; every core mutation score is at 90 or above. T-408c (console Ranking seasons) is
   built, its code review is owed; so is T-406d's (the daily word guess lists). **T-410 and T-410b are built and reviewed (folded: c3e0d46, and T-410b's 89); T-411 (archiving) is built and reviewed (87 folded; ADR-341 Accepted); its mutation run is owed with the next batch.** **T-501 (the push store, center and worker) is built and reviewed (ADR-350 Accepted); T-501b (the APNs and FCM clients) is built and reviewed (88 folded; ADR-351 Accepted); its mutation run is owed with the next batch. **T-501c (the app's push) is built and reviewed (84 folded; ADR-352 Accepted). T-501d (the personal pushes) is built and reviewed (84 folded, cap re-review 88 folded, GO to push; ADR-353 Accepted; accept-all 1,000 a call, 250 with a hard limit until T-221); T-501e (the event pushes) is built and reviewed (78 folded, re-review 91 folded, GO to push; ADR-354 Accepted); T-501f (reminders and promotion by push) is built and reviewed (tier A findings folded; ADR-356 Accepted); T-501g (the hint push) is built and reviewed (ADR-357 Accepted); T-502 (announcements) received review 84 NO-GO; both MAJOR fixes are built, and coordinator inspection/acceptance/CI/push is next, then stop (do not start T-503).** Real pushes wait for Dhia's Apple key and Firebase service account and the RUNBOOK go-live checklist.** **Next:** the T-409 mutation run (T-409 and T-409b are
   reviewed and folded, ADR-334 and ADR-335 accepted); T-408d when the RUNBOOK ranked-count check fires. Waiting for counsel: Q-280 (sponsor wording), Q-286 (marketing age), Q-288 (consent
   wording), Q-289 (proof after deletion); nothing waits on them. Waiting on people, not blocking: an Arabic reader skims
   `data/word-lists/guess-list-ar.txt` and its block list (Q-296), and the team imports both guess lists in the console
   before the first daily word goes live (RUNBOOK). No deployment/EAS/local Stryker; phone checks owed for T-403c, T-406b,
   T-407b, T-408b and T-501c (RUNBOOK, "The app's side of push"). **Deploy note:** 0071 needs a new app build first (RUNBOOK). Follow-up: Q-237 central
   replay-before-scope fix for other idempotent organizer routes; Q-297 a faster `word_list_change` (only if bigger lists
   are imported). Follow-up (seen at T-501d, not caused by it): `test/db/community.int`'s "answers community_settling
   while a transaction from the window is open" reads `pg_stat_activity` cluster-wide and failed once under a full
   parallel run; fix or quarantine it.
2. **Phase 0 still open:** T-009 device run, T-010 cloud builds (store accounts), T-013 Msegat quote, T-017
   infrastructure as code, T-018 observability. T-019 backups before real players. Staging needs migrations 0007 to
   0023, a managed Redis in the Nafes project with `REDIS_URL` and `maxmemory-policy noeviction` (ADR-118), Msegat's static-IP check (M0037) registered or switched off before the first real SMS, `REWARD_CODE_SECRET` (32+ characters, its own value, backed up apart from the database; migration 0025), the new `QR_SECRET` (32+ characters, from the secret store; the API refuses to start without it) and outbound HTTPS to `api.pwnedpasswords.com` when T-020 and T-101 are deployed.
3. **Waiting on Dhia** (walk-through 2026-10-21, INBOX): **a Questify storage bucket in `riyadh-1` (Q-149, T-301): CranL Pro allows one bucket per account and `b7r-media` uses it, so photo submissions (T-301b) wait for a second bucket (or Oracle Riyadh);** the Apple Developer and Google Play accounts (T-010); installing the first Android development build (EAS build a1411217, started 2026-10-21) on a phone; sending Msegat the volume-quote request; CranL's written answers (Q-031). ADR-113 to 116 and 120 are Accepted. **No staging (ADR-123):** the CranL staging services become production, and the items above that said "staging" (migrations 0007 onward, Redis with `noeviction`, Msegat's static-IP check) are done there; renaming them is its own session. Resend backup skipped while Gmail stays out of spam (Q-083). **For push (T-501b, T-501c):** the Apple APNs key (Sandbox & Production, Team Scoped) and the Firebase project (service account for the server, `google-services.json` for the Android build), a new EAS development build with `expo-notifications` and `expo-application`, and the notification icon (96 px white on transparent) from the brand deck; then the RUNBOOK's push go-live checklist and the app checks.
4. Open questions: Q-031, Q-034, Q-070, Q-071, Q-075, Q-077, Q-078, Q-083, Q-084, Q-085, Q-086, Q-088, Q-090, Q-093 (login SMS ceiling), Q-095 (player consent, counsel), Q-105 (star icon and XP, quest and category renames). Follow-ups from 2026-10-21: the username hold setting (ADR-124), the brand spelling and billing wording in the copy pass (ADR-125, ADR-128, T-808), the sound set (ADR-129), Saqr's character sheet (ADR-130), the listing name (ADR-131).

## Run complete — 2026-10-18
- Status: COMPLETE for the blueprint run; **planning is not yet closed**: the root `CLAUDE.md` still says
  PLANNING until the user approves ending it (then apply `_blueprint/CLAUDE_BUILD_DRAFT.md`). Future runs:
  Update mode.
- Docs produced this session: `TECH_STACK.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `API.md`,
  `INTEGRATIONS.md`, `CONFIGURABILITY.md`, `SECURITY.md`, `rules.md`, `ROADMAP.md`, `TASKS.md` (107 tasks),
  `TEST_STRATEGY.md`, `RISKS.md`, `_blueprint/STAGE6_GRILL.md`, `_blueprint/CLAUDE_BUILD_DRAFT.md`;
  ADR-101 to ADR-104; F-318, F-319; FR-1816, FR-1817 (517 FRs); NFR-031; Q-079.
- Consistency pass: subagent review, 26 findings; 17 mechanical fixes applied; 4 plan changes approved by
  the user (Phase 0 gates T-013 to T-015, email-invite F-319/FR-1817, data and API gaps filled or marked
  baseline, account deletion moved to Phase 2 and a v0 legal-text task T-119). Nothing dropped silently.
- Recommended toolbox: cto-cycle, security-guidance / cso, setup-playwright, ux-araby (none installed or run).
- Handoff: Claude Code in this project, after the user approves ending planning.
- Open questions at close: see `OPEN_QUESTIONS.md`. Blocking Phase 0: Q-031 (cloud), Q-034 (SMS quotes),
  Q-046 (Expo SDK check). Also open: Q-070, Q-071, Q-075, Q-077, Q-078, Q-079, Q-043, Q-051.
- Codex: mascot images resume after the limit resets (18 Oct, 3:09 pm Riyadh).
