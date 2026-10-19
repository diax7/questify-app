# Implementation Tasks — Questify

> Ordered, verifiable build steps for a coding agent. Steps, not code. Drafted in Stage 8, 2026-10-17.
> Last updated: 2026-10-17. Each task is one sitting to a few sittings of work; split it further when it is picked up.
> Every one of the 546 functional requirements in `SRS.md` is delivered by at least one task (checked by script).
> Phases are build order, not releases (ADR-069). **No application code is written until planning is approved** (`_blueprint/STATE.md`).

How to read a task: `delivers` lists FR numbers from `SRS.md` (FR-### shortened to ###; NFR ids written in full). `depends on` lists task ids that must be finished first. The quality bar for **core** tasks (ledger, sign-in, tenant isolation, prize handover, wallet, signed proofs, admin powers) is Max; the rest Standard (`rules.md`).






## Phase 0 — Foundations

_A working skeleton: repository, pipeline, Saudi staging environment, tenant-safe database, sign-in for staff and players, configuration and translations, and the first installable build._

- [ ] **T-001** Create the monorepo (app, web, api, shared) with strict TypeScript, lint, format, type and test commands, and a single-job CI gate that also runs a secret scan — delivers no FR (infrastructure or quality gate); depends on: none
  - Done when: A clean checkout runs lint, types and tests with zero warnings in one command and in CI; a planted fake secret makes CI fail.
- [ ] **T-013** Get written SMS quotes from Msegat and Taqnyat and start the sender-name registration (commercial registration, Chamber of Commerce letter, SAR 230 a year per name); pick the gateway (Q-034, ADR-103) — delivers no FR (infrastructure or quality gate); depends on: none
  - Done when: Two written quotes are filed; one gateway is chosen; the sender-name request is submitted.
- [ ] **T-014** Verify the chosen Saudi cloud offers managed PostgreSQL with point-in-time recovery, a cache, object storage and email in that region, and get a quote (Q-031); if not, take the fallback — delivers no FR (infrastructure or quality gate); depends on: none
  - Done when: A written note lists each needed service as available in the region, with a price; the database choice in ADR-102 is confirmed or changed.
- [ ] **T-015** Check the chosen Expo SDK against the stores' current rules: privacy manifests, Android target API, Xcode version (Q-046, NFR-010) — delivers no FR (infrastructure or quality gate); depends on: T-001
  - Done when: A note records the SDK version and confirms it meets both stores' current requirements, or lists what must change.
- [ ] **T-002** Stand up the staging environment in the chosen Saudi region: managed PostgreSQL with backups, cache, object storage, secret store, container hosting (needs Q-031 decided) — delivers no FR (infrastructure or quality gate); depends on: T-001, T-014
  - Done when: A health endpoint answers from staging; a restore of last night's backup into a scratch database succeeds; no resource is reachable from the public internet except the API.
- [ ] **T-003** Database baseline: organizers, events, players, staff, enrollments; every tenant table has an organizer key; row-level security on; public access revoked by default — delivers FR 1501, 1502; depends on: T-002
  - Done when: A suite using only the public credential can read and write nothing; an editor of organizer A gets 403/404 on every organizer B route.
- [ ] **T-004** Append-only audit log and change log infrastructure (updates and deletes revoked in the database) — delivers FR 1029, 1030, 1410; depends on: T-003
  - Done when: Any attempt to update or delete an audit row fails at the database; each state-changing call writes who, what, before, after and when.
- [ ] **T-005** Shared API conventions: error envelope, idempotency-key middleware, cursor pagination, rate-limit headers, request ids, app-version check (426) — delivers FR 1033, 1735; depends on: T-001
  - Done when: Repeating a request with the same idempotency key returns the first result; an old app version receives 426 with a store link; the error envelope is identical on every route.
- [ ] **T-006** Staff sign-in: email, password (argon2id), email code, inactivity expiry, session list — delivers FR 1725; depends on: T-003
  - Done when: A staff user cannot reach any page without all three steps; a session expires after the inactivity limit; wrong codes are limited.
- [ ] **T-007** Configuration service: platform settings, event configuration, composed /v1/config with ETag and per-feature minimum app version — delivers FR 1503, 1504, 1010, 1729; depends on: T-005
  - Done when: Changing a setting changes the composed config within a minute without any release; an unknown block is ignored by an older app.
- [ ] **T-008** Translation store: keys with Arabic and English values, shipped defaults, fallback to defaults, placeholder protection — delivers FR 1768, 1767, 1506, 1507; depends on: T-007
  - Done when: A blank or missing key shows the shipped text; a save that removes a placeholder is refused; numbers render in Western digits in both languages.
- [ ] **T-009** Expo app shell: development build, navigation skeleton, Arabic and English with full RTL, design tokens, Baloo Bhaijaan 2 and Rubik fonts, language by phone setting — delivers FR 1743; depends on: T-001, T-015
  - Done when: The app runs on a real iPhone and Android phone in both languages and mirrors every screen; how a language switch behaves is settled by Q-079; tokens (not colours) are used in components.
- [ ] **T-010** Cloud builds: EAS Build and Submit configured from Windows; first TestFlight and Play internal builds — delivers no FR (infrastructure or quality gate); depends on: T-009
  - Done when: A build installs from TestFlight on an iPhone and from Play internal testing on an Android phone.
- [ ] **T-011** Next.js web app shell: staff login screens, responsive layout usable on a phone browser, Arabic and English — delivers FR 1746; depends on: T-006, T-008
  - Done when: The dashboard login works on a desktop and on a phone browser in both languages.
- [ ] **T-012** Outsider and cross-tenant test suites wired into CI — delivers no FR (infrastructure or quality gate); depends on: T-003
  - Done when: CI fails when any route or table is reachable with only the public credential, or when one organizer reaches another's data.
- [ ] **T-016** Quality tooling: mutation testing on core code (e.g. Stryker), contract tests against the generated OpenAPI file, SBOM generation, dependency audit and secret scan in CI (QUALITY_BASELINE sections 2 to 4) — delivers no FR (infrastructure or quality gate); depends on: T-001
  - Done when: CI runs a mutation check on a sample core module and fails below the agreed score; an SBOM is produced from a build; a planted vulnerable dependency fails the audit.
- [ ] **T-017** Infrastructure as code: create and rebuild staging and production on CranL (apps, databases, buckets, cron, settings) from scripts kept in the repository, never by hand — delivers no FR (infrastructure or quality gate); depends on: T-002
  - Done when: A fresh environment is created from the scripts alone; a second run changes nothing; no setting exists only in the dashboard.
- [ ] **T-018** Observability and service levels: OpenTelemetry logs, metrics and traces without personal data; written targets with alerts; a runbook entry for every alert — delivers no FR (infrastructure or quality gate); depends on: T-002
  - Done when: A forced error shows in the logs with a request id and no personal data; each alert links to a runbook; the targets in QUALITY_BASELINE are measured on a dashboard.
- [ ] **T-019** Second backup copy: a nightly dump of the database and bucket copied to a second place in Saudi Arabia that we control, and a restore from it (ADR-107 condition) — delivers no FR (infrastructure or quality gate); depends on: T-002
  - Done when: A restore from the second copy into a scratch database works and the time it took is written down.

## Phase 1 — Core loop

_A real phone runs the whole loop: an organizer builds an event, a player joins, scans a quest QR, earns points and sees the ranking._

- [ ] **T-101** Organizer sign-up, accepting organizer terms and the data processing agreement, one owner, invite editors by email, owner transfer, editor event limits — delivers FR 1401, 1726, 1011, 1012, 1013, 1014, 1723, 1724; depends on: T-006
  - Done when: Anyone can create an organizer account and a draft event with no approval; an editor cannot do owner-only things; the owner can invite and limit editors.
- [ ] **T-102** Event builder: create, edit, delete an event with kind, time zone, event-day start, join methods; lifecycle states Draft to Archived — delivers FR 1001, 1002, 1003, 1728, 1714, 1715, 1017, 1608; depends on: T-101
  - Done when: A draft event can be created and edited; its state moves Scheduled to Live to Ended at the set times; every shown time is in the event's time zone.
- [ ] **T-103** Categories and quests builder (dashboard): bilingual fields, default General category, order, repeatable quests, start/end times, show/hide while live — delivers FR 1004, 1005, 1006, 1007, 1008, 223, 228, 229, 233, 225, 226, 227, 1505; depends on: T-102
  - Done when: An editor can build a category with a quest in Arabic and English; a quest outside its time window cannot be completed.
- [ ] **T-104** Quest QR codes: signed codes with a version, view/download/print, regenerate (old code stops at once) — delivers FR 301, 302, 305, 1711; depends on: T-103
  - Done when: A regenerated QR makes the old printed code fail immediately; a forged payload is rejected.
- [ ] **T-105** Completion engine: one transaction writes completion, ledger entry, score, balance and idempotency key; rate limits on typed codes; scan-QR and enter-code quests — delivers FR 201, 211, 202, 304, 316, 317, 401, 402, 322, 303; depends on: T-104, T-005
  - Done when: Two simultaneous scans produce one completion; a retry with the same key never pays twice; a gallery image is never accepted as a scan; the ledger cannot be edited.
- [ ] **T-106** Ranking: sorted store per event, ties go to who reached the score first, exclusions and bans, ranking on/off, rebuild from the ledger — delivers FR 606, 609, 607, 1612, 318; depends on: T-105
  - Done when: A change in score appears in the ranking within 5 seconds; deleting the cache and rebuilding gives the same order; ties resolve by time reached.
- [ ] **T-107** Player sign-in: SMS and email codes, +966 only, resend and attempt limits, SMS adapter (Saudi gateway) and email adapter, email fallback after 30 s, auto-fill — delivers FR 106, 107, 108, 109, 110, 323, 1740, 1812, 1813, 1109, 1110; depends on: T-005, T-013
  - Done when: A +966 number gets a code by SMS; a foreign number is refused with an email option; after 30 seconds the screen offers an email code; limits stop code spam.
- [ ] **T-108** Sessions: stay signed in, sign out with an explanation, change phone or email with a fresh code, add a second identifier — delivers FR 123, 124, 125, 139, 1817; depends on: T-107
  - Done when: A player stays signed in across launches; changing a phone needs a code on the new number first.
- [ ] **T-109** Profile at sign-up and username rules: unique case-insensitive @username, history, word lists, rate limit, avatar from the set, birth year gate, public profile fields only — delivers FR 117, 118, 119, 120, 704, 705, 1412, 1628, 1701, 1702; depends on: T-107
  - Done when: A duplicate or filtered username is refused; under-age sign-up is refused kindly; other players see only username and avatar.
- [ ] **T-119** Draft v0 terms of use, privacy policy and community guidelines text (Arabic first, English alongside) so sign-up can record acceptance; counsel reviews them later in T-807 — delivers no FR (infrastructure or quality gate); depends on: none
  - Done when: Three draft documents exist in both languages with version numbers; T-110 can record acceptance of them.
- [ ] **T-110** Legal steps: terms and privacy before data collection, recorded acceptance, guideline reminder before first submission, Settings Legal and contact — delivers FR 1705, 1706, 1707; depends on: T-109, T-119
  - Done when: No data is stored before the terms are accepted; the acceptance and version are recorded.
- [ ] **T-111** Join: by code, join QR, invite link and public list; join card with rules; browse before sign-in; sign-in at the Join tap; several events at once — delivers FR 101, 102, 103, 104, 105, 111, 112, 121, 122; depends on: T-107, T-102
  - Done when: A signed-out person can browse a public event and is asked to sign in only at Join; a private event cannot be found in the public list.
- [ ] **T-112** Event web page with link preview, store buttons and the join code; install prompt; Android install referrer and iPhone paste-code flow — delivers FR 113, 114, 115, 116, 1741; depends on: T-111
  - Done when: Opening a join link on a phone without the app leads to the store and, after install, to the event card (Android automatic, iPhone with one tap).
- [ ] **T-113** Event Home and the event bottom bar: banner and countdown, progress, ranking card, Up next, event info page, open the right event on launch — delivers FR 801, 802, 804, 805, 620, 621, 622, 624, 623, 1610, 1748; depends on: T-106, T-111
  - Done when: The Home shows progress and a ranking card; tapping the card opens the 11-row ranking; leaving an event takes two taps.
- [ ] **T-114** Quests tab: category accordion, quest cards and details sheet with steps and the verification line — delivers FR 221, 222, 230, 1742; depends on: T-103, T-113
  - Done when: A player sees which quests are open, locked or done, and how each is verified.
- [ ] **T-115** Scanner and celebration: live camera only, instant 'Scanned' beat then celebration, coin flies to balance, reduce-motion respected, activity history — delivers FR 406, 407, 408, 403, 409, 410; depends on: T-105, T-114
  - Done when: The 'Scanned' beat shows within 300 ms; the celebration follows the server's confirmation; with reduce-motion on, animations are replaced by static versions.
- [ ] **T-116** Ranking screen: top 10 plus the player's own row, 11 rows with no scrolling on every size, public profile details only, no hide option — delivers FR 601, 602, 603, 604, 605; depends on: T-106, T-113
  - Done when: Eleven rows fit one screen on the smallest supported phone; a player ranked below 10th sees their own real rank.
- [ ] **T-117** Currency name and icon (bilingual) and renamed words 'player' and 'operator' foundations — delivers FR 404, 405, 940, 941; depends on: T-103, T-008
  - Done when: Renaming the currency changes every screen and the dashboard in both languages.
- [ ] **T-118** Close the first loop: end-to-end test and a first demo build with one event on real phones — delivers no FR (infrastructure or quality gate); depends on: T-115, T-116, T-117, T-010
  - Done when: A scripted run creates an event, joins from a phone, scans a quest, and the ranking and balance update on a second phone.

## Phase 2 — Rewards and fair play

_The shop, reservations and prize desk, staffed events (operators and My QR), flags and bans, activation and the event lifecycle._

- [ ] **T-201** Rewards builder and shop: price, stock, per-player limit, windows, kinds (item, digital code, experience), sold-out, official rules before first redemption — delivers FR 501, 502, 503, 504, 505, 514, 515, 516, 1617, 1618; depends on: T-105
  - Done when: A reward with stock 1 can be reserved by only one player; an out-of-window reward cannot be redeemed.
- [ ] **T-202** Reserve and cancel: price and stock taken at once, automatic return when not collected, collectible until its own deadline after the shop closes — delivers FR 506, 508, 513, 1603, 1609, 1717; depends on: T-201
  - Done when: A reservation that is not collected returns points and stock automatically; cancelling returns both.
- [ ] **T-203** Digital reward codes: upload list, one code per redemption, low-stock warning, encrypted storage — delivers FR 510, 511, 512; depends on: T-201
  - Done when: No code is revealed twice; a duplicate upload is refused; low stock warns the owner.
- [ ] **T-204** Operator accounts: add by phone or email, personal operator QR, claim screen, remove at once, abilities, station limits, optional playing with two modes — delivers FR 901, 902, 903, 904, 905, 906, 907, 908, 909, 1720; depends on: T-111
  - Done when: Scanning a personal QR makes that person an operator for that event only; removal takes effect at once.
- [ ] **T-205** My QR (rotates every 30 s) and the operator station scan with full-screen results — delivers FR 306, 307, 920, 921, 922, 923, 924; depends on: T-204, T-105
  - Done when: A My QR older than the grace period (default one minute, a tuning number, Q-074) is rejected; the station scan shows green, orange or red with the reason.
- [ ] **T-206** Prize desk: scan My QR, show reservations, hand over, confirm experience rewards, never award points, one desk per event with hours — delivers FR 507, 509, 925, 926, 1716; depends on: T-202, T-205
  - Done when: The desk hands over only reserved items; physical rewards stop being reservable after the desk's last hours.
- [ ] **T-207** Manual awards with a reason, owner caps and a report; remove an award with a reason; XP and balance consequences — delivers FR 308, 309, 310, 311, 320, 1601, 1602, 1712, 1027; depends on: T-205
  - Done when: An award over the cap is refused; removing an award after spending lowers the balance to a legal value.
- [ ] **T-208** Exclusion list and bans from an event; kicked-player rules; leave an event — delivers FR 319, 321, 1605, 1703, 518, 1604; depends on: T-106
  - Done when: A banned player leaves the boards and cannot earn, redeem or collect; leaving keeps their history.
- [ ] **T-209** Flags: several accounts on a phone, far from venue, impossible speed, bursts, same device, device-integrity signal; flagged-activity page; the flag hold at the desk — delivers FR 329, 330, 331, 332, 333, 334, 335, 336, 1745, 1815, 1747; depends on: T-206, T-208
  - Done when: A flagged player's items are held at the desk with 'Held, ask the owner'; flags never block play by themselves.
- [ ] **T-210** Event activation and limits: request by owner, console activation, hard/soft/no limit, add-ons unlock features, hidden when not unlocked, event page works only when activated — delivers FR 1019, 1020, 1021, 1402, 1737, 1729, 1730, 1731, 1607; depends on: T-102
  - Done when: An event not activated has no working join link; unlocked add-ons show and others are hidden.
- [ ] **T-211** Rehearsal mode: staff try the whole event before go-live, wiped at go-live — delivers FR 1721, 1722; depends on: T-210
  - Done when: Rehearsal points and redemptions are gone at go-live and stock is restored.
- [ ] **T-212** Join fields, guest list, company-email lock, private events, welcome reward — delivers FR 129, 130, 131, 132, 133, 134, 135, 136, 137, 1708; depends on: T-111
  - Done when: A guest-list-only event refuses anyone not on the list; answers go only to the organizer.
- [ ] **T-213** Goal and pinned reward on Home; shop sections; next reachable reward — delivers FR 803, 517, 422, 1616, 522; depends on: T-201, T-113
  - Done when: Pinning a reward shows how many points remain for it on Home.
- [ ] **T-214** Rank prizes and final results: attach prizes to ranks, exclusions, claim push and deadline, open flags shown before reveal — delivers FR 519, 520, 521, 1718, 1719; depends on: T-209, T-206
  - Done when: Winners come from the final score excluding staff; open flags are shown before the reveal.
- [ ] **T-217** Account deletion from the app and from a web page: remove the profile and points, anonymize log entries, keep prize-handover records only as the law requires, keep a one-way fingerprint so bans stand — delivers FR 126, 127, 128, 1704, 1739; depends on: T-109, T-206
  - Done when: A deleted account cannot sign in or be found; log entries are anonymized; a ban still applies to the same phone or email; a pending handover is explained before deletion.
- [ ] **T-216** Today's ranking for multi-day events, reset at the event day start — delivers FR 608, 610, 1611; depends on: T-106, T-102
  - Done when: Today's ranking shows only points earned since the event day started and resets at the set hour.
- [ ] **T-215** Closed test: ship the Phase 2 build to 12+ testers and start Google's 14-day closed test — delivers no FR (infrastructure or quality gate); depends on: T-214, T-216, T-217
  - Done when: The Play Console shows 12 or more opted-in testers and the 14-day clock running.
- [ ] **T-218** Event access types: Public, Unlisted, Private; join requests with a waiting screen and push; invited people skip approval; change type any time; hard limit counts accepted players with a waiting list — delivers FR 1818, 1819, 1820, 1821; depends on: T-111, T-102
  - Done when: A Private event cannot be entered with the code alone; accepting a request lets the player in and sends a push; a full event shows 'Event is full' and offers the waiting list.

## Phase 3 — Quest depth

_All quest types, category rules, submissions, polls, community quests, mini-games, NFC, kiosks and stations, flash quests and boosts._

- [ ] **T-301** Submission quests: photo and text, review queue, approve or reject with reason, pending points, auto-approve and later removal, resubmission rules — delivers FR 204, 205, 206, 324, 325, 326, 327, 328, 1709, 1710, 1629; depends on: T-105
  - Done when: A submission's points stay pending until approved; submissions are visible only to the organizer team.
- [ ] **T-302** Vote and quiz quests with timers and one try per question; enter-a-code variants — delivers FR 207, 208, 209, 210; depends on: T-105
  - Done when: A quiz question closes at the timer; the right answer shows after answering.
- [ ] **T-303** Challenge quests (staff confirm), meet-someone quests, survey quests, share quests, location check-in with the QR fallback — delivers FR 203, 212, 213, 214, 215, 216, 219, 220, 1744; depends on: T-205
  - Done when: A challenge pays only after a staff member confirms; a location quest can always be done by scanning the QR at that spot.
- [ ] **T-304** Passport quests and category rules: collapse, completion bonus, in order or any order, timed open, unlock after another, daily/weekly refresh, hidden categories — delivers FR 224, 231, 232, 234, 235, 236, 237, 238, 1619; depends on: T-103
  - Done when: An in-order category unlocks the next quest only after the previous one; a daily refresh resets completion but keeps points.
- [ ] **T-305** Mini-games: server-issued seeded rounds, replay check, four games, attempts, pass target, organizer images, result retry — delivers FR 217, 218, 1804, 1805, 1806, 1807, 1808, 1809; depends on: T-105
  - Done when: Impossible inputs are rejected and a flag raised; a game quest pays once on the first pass.
- [ ] **T-306** Live polls and community quests with milestones and rewards — delivers FR 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 1620; depends on: T-302
  - Done when: A community goal not reached pays nothing; points-based goals count participation points.
- [ ] **T-307** Flash quests, double-point boosts, live finale — delivers FR 251, 252, 254, 255, 1621; depends on: T-306
  - Done when: A flash quest is available only in its window; a boost applies only to its category or zone.
- [ ] **T-308** NFC: write a tag from staff mode, tap to complete, signed tags (Q-071 decision first), QR stays as a fallback — delivers FR 312, 313; depends on: T-205
  - Done when: A quest can be completed by tapping its tag; a cloned plain tag is flagged or refused according to Q-071.
- [ ] **T-309** Rotating screen QR, station pages and kiosks, pairing of stations, kiosks and big screens — delivers FR 314, 315, 1713; depends on: T-205
  - Done when: An unpaired device shows nothing; a kiosk scans players without staff.
- [ ] **T-310** Help desk: Report a problem or Ask a question, operator inbox, private tickets — delivers FR 337, 338, 339, 927; depends on: T-205
  - Done when: A ticket is visible only to the player and the event team.
- [ ] **T-311** Operator tools: today's numbers, practice mode, renamed 'quest' and 'category' — delivers FR 928, 929, 942; depends on: T-205
  - Done when: Practice mode shows real result screens but changes no points.
- [ ] **T-312** Ticket center: four types, routing by type, one reply then closed, escalate to Questify, My tickets and notification history in the profile — delivers FR 1822, 1823, 1824; depends on: T-310
  - Done when: An app-problem ticket reaches only the Questify queue; a prize question reaches only the event team; the reply closes the ticket and the player sees it in My tickets.
- [ ] **T-313** First-N bonus on a quest, counted inside the completion transaction, with a live 'bonuses left' count — delivers FR 1840; depends on: T-105
  - Done when: Two simultaneous completions at the Nth place pay exactly one bonus.

## Phase 4 — The Questify layer

_XP, levels, items, gems, passport, streaks, achievements, the daily challenge and word, invitations and Questify home._

- [ ] **T-401** Questify XP ledger and levels: fixed hidden XP per quest on first completion only, lifetime level, level titles — delivers FR 414, 415, 416, 706, 721; depends on: T-105
  - Done when: Repeating a quest gives no second XP; XP can never be spent.
- [ ] **T-402** Questify profile: character, frame, title, locker, equipping, public profile view — delivers FR 701, 702, 703, 720, 722, 723, 1622; depends on: T-401
  - Done when: Another player sees only the public profile fields.
- [ ] **T-403** Achievements (bronze/silver/gold, silhouettes), Event Passport stamps, always-on and seasonal Questify quests — delivers FR 707, 708, 709, 710, 711; depends on: T-401
  - Done when: A finished event adds a stamp; unearned achievements show as silhouettes.
- [ ] **T-404** Gems and the Questify shop (no money, no trading) — delivers FR 724, 725, 726; depends on: T-402
  - Done when: Gems cannot be bought or traded and are earned only from Questify activity.
- [ ] **T-405** Streaks: event day streak (with or without bonus), Questify daily streak, switch off platform-wide — delivers FR 417, 418, 419, 420, 421, 1615; depends on: T-401
  - Done when: Missing a day breaks the streak; the daily streak rewards XP or items only.
- [ ] **T-406** Daily challenge (three questions) and daily word game; sponsor-funded days; question and word banks; weekly or daily cadence — delivers FR 730, 731, 732, 1810, 1811, 1733, 1814; depends on: T-405
  - Done when: A day without a daily word shows no game; fewer than 7 queued questions warns the console.
- [ ] **T-407** Marketing consent per channel and opt-out; interests, city and the 'For you' list — delivers FR 733, 734, 735, 736, 737, 1113, 1114, 1111, 1112, 1738; depends on: T-107
  - Done when: Promotional messages go only to opted-in players and never between 22:00 and 09:00 Saudi time.
- [ ] **T-408** Questify home and Explore: events grouped live, upcoming and past, Questify-wide ranking (lifetime and monthly), join-QR scanner on the center button — delivers FR 611, 612, 830, 831, 832, 833, 1614, 1786; depends on: T-401
  - Done when: Outside an event the center button scans only join QR codes.
- [ ] **T-409** Questify invitations to chosen players, results counts, billed on the web — delivers FR 738, 739, 740; depends on: T-407
  - Done when: An organizer sees only counts of their invitations, never player lists.
- [ ] **T-410** After the event: shop window, closing the balance, keeping score and stamp, recap card — delivers FR 750, 751, 752, 1018; depends on: T-201
  - Done when: After the window the balance closes but the score, rank and stamp remain.

## Phase 5 — Live and messaging

_Notifications, announcements, big screen, agenda and sessions, maps, sponsors and surveys._

- [ ] **T-501** Push infrastructure: APNs and FCM directly, permission asked after joining, personal and event pushes, notification center, per-topic mute — delivers FR 1101, 1102, 1103, 1104, 1105, 1106, 1115; depends on: T-107
  - Done when: A refused push permission blocks nothing and the center still holds every message.
- [ ] **T-502** Announcements: write in both languages, send now or schedule, push and in-app only; Home strip — delivers FR 1107, 1108, 806, 807; depends on: T-501
  - Done when: Announcements never go by email or SMS.
- [ ] **T-503** Top-10 rank push; alerts for organizers by email — delivers FR 613, 1727; depends on: T-501
  - Done when: A player entering the top 10 gets one push; organizer alert types are switchable per team member.
- [ ] **T-504** Big screen: pairing, scenes, order, live ranking within seconds, community, poll and photo wall scenes — delivers FR 630, 631, 632, 633, 634, 635, 636, 637, 1613; depends on: T-309, T-106
  - Done when: The big-screen link opens only when paired; the photo wall shows only photos the player allowed.
- [ ] **T-505** Agenda and sessions with registration, My sessions, door check-in, reminders, overlap warning, import, report, close or reopen, message registrants — delivers FR 808, 809, 810, 1787, 1788, 1789, 1790, 1791, 1792, 1793, 1794, 1795, 1796, 1797; depends on: T-205, T-501
  - Done when: A full session refuses registration; registration records no payment details.
- [ ] **T-506** Maps: any number of maps, pins, quest pins with status, list/map toggle, you-are-here — delivers FR 820, 821, 822, 823, 824, 825, 826, 827; depends on: T-114
  - Done when: A quest pin shows done, open or locked for the viewer.
- [ ] **T-507** Sponsors: profiles, tags, presented-by labels and category, sponsor strip, no sponsor login — delivers FR 1301, 1302, 1303, 1304, 1305, 1307; depends on: T-103
  - Done when: A tagged item shows 'presented by' with the sponsor's name and logo.
- [ ] **T-508** Quest ratings and survey results — delivers FR 1209, 1210, 1211, 1623, 1624; depends on: T-303
  - Done when: Rating is optional and can be skipped; survey results export with the report.
- [ ] **T-509** Cheers: five fixed reactions, cheers moment started by the owner, big-screen Cheers scene, rate limit, on/off per event — delivers FR 1841; depends on: T-504
  - Done when: No cheer button shows unless a moment is live; a player cannot send more than the per-minute limit.
- [ ] **T-510** Default notification topics per event — delivers FR 1836; depends on: T-501
  - Done when: A new player's topic defaults follow the event's settings and can still be muted.

## Phase 6 — Organizer power

_Wizard, templates, layout, reports and exports, analytics, rehearsal mode and the usage view._

- [ ] **T-601** Templates and duplicate an event — delivers FR 1015, 1016; depends on: T-102
  - Done when: A duplicated event is a new Draft with the same structure and no players.
- [ ] **T-602** Feature switches per event; preview of player screens; branding with logo, banner, accent — delivers FR 1009, 1022, 1023, 1764; depends on: T-007
  - Done when: A switched-off feature disappears completely; the preview matches the app.
- [ ] **T-603** Live control room: scan feed, launch flash quest or boost, announcement, pause quests, counters, pin the focus quest — delivers FR 1024, 1025, 1026, 1028; depends on: T-307, T-502
  - Done when: The feed shows completions as they happen.
- [ ] **T-604** Confirmation screens, live-edit choices (future only or also past) and change sets — delivers FR 411, 412, 413, 1031, 1032, 1034, 1035; depends on: T-103, T-004
  - Done when: Editing live points asks 'future only or also past' and explains each option before it applies.
- [ ] **T-605** Guided setup wizard (12 steps), skippable, resumable, locked add-on cards, re-run, admin-editable texts — delivers FR 1751, 1752, 1753, 1754, 1755, 1756, 1757, 1846; depends on: T-102, T-210
  - Done when: Skipping a step keeps the template's defaults; resuming returns to the same step.
- [ ] **T-606** Layout: reorder home blocks, rearrange the bar, hide pages, protected items rejected, layout presets — delivers FR 1749, 1750, 1764; depends on: T-113
  - Done when: A layout that hides the scanner is rejected.
- [ ] **T-607** Analytics: participation, join source, quests and categories, rewards and economy, active-player rule — delivers FR 1201, 1202, 1203, 1204, 1205, 1625; depends on: T-105
  - Done when: Analytics use only in-app actions and count an active player as one completed quest.
- [ ] **T-608** Exports and one-page PDF report; sponsor-filtered totals — delivers FR 1206, 1207, 1208, 1306, 1626; depends on: T-607
  - Done when: An export contains only the fields the join card disclosed.
- [ ] **T-609** Organizer email alerts and usage view groundwork — delivers FR 1727; depends on: T-503
  - Done when: Alerts are switchable per team member.
- [ ] **T-610** Home editor: new blocks (custom text card, quick links, podium preview, featured), banner slider with tap actions, countdown blocks, drag with live preview, Questify preset and reset — delivers FR 1828, 1829, 1830, 1831; depends on: T-113, T-606
  - Done when: A reordered Home shows in that order in the app; a one-slide banner has no slider dots; a countdown at zero hides or shows its message.
- [ ] **T-611** Ranking layouts (List, Podium, scores or rank only), Quests layout (list or grid), shop layout (grid or list) — delivers FR 1832, 1833; depends on: T-116, T-114, T-201
  - Done when: Podium and list both fit one screen with no scrolling; 'rank only' shows no scores.
- [ ] **T-612** Prize reservation On or Off and the shop On or Off; redeem-at-desk in one step when reservation is off — delivers FR 1834; depends on: T-202, T-206
  - Done when: With reservation Off the app shows no Reserve button and the desk takes the points and hands over in one scan.
- [ ] **T-613** Event info page builder and one extra custom page — delivers FR 1835; depends on: T-113
  - Done when: Reordering sections changes what players see; the custom page opens from Home.
- [ ] **T-614** Event text overrides from the approved list — delivers FR 1843; depends on: T-008, T-113
  - Done when: An override changes the label in both languages for that event only; blank falls back to the platform text.
- [ ] **T-615** Name display: username, full name or both, visible to everyone or staff only; join-card notice — delivers FR 1842; depends on: T-109, T-116
  - Done when: Staff-only mode shows usernames to players and full names to operators; Questify-wide pages stay username-only.
- [ ] **T-616** Owner reports: tickets inbox with counts by type, reported players and content, prize-problems view, join requests queue — delivers FR 1825; depends on: T-312, T-218
  - Done when: Counts by type match the tickets; Accept all accepts every pending request.
- [ ] **T-617** Operator activity view and staff briefing push to operators only — delivers FR 1844; depends on: T-204, T-501
  - Done when: The view shows scans per hour and last activity per operator; a briefing reaches only operators.
- [ ] **T-618** Go-live readiness checklist (owner dashboard and Questify team view) — delivers FR 1845; depends on: T-211
  - Done when: A missing rehearsal shows as missing; the checklist blocks nothing.

## Phase 7 — Console and trust

_The Questify console: admin tools, translation matrix, switches, player lookup, legal documents, health, data requests._

- [ ] **T-701** Console foundation: platform admin role, organizer and event management, suspend and edit any event with support logging, urgent reports — delivers FR 1402, 1408, 1409, 1732, 1784; depends on: T-006, T-210
  - Done when: Every support access to an organizer event appears in that event's log.
- [ ] **T-702** Translation matrix editor: edit Arabic or English per key, live, placeholders protected — delivers FR 1765, 1766; depends on: T-008
  - Done when: An edit appears in the app within a minute without a release.
- [ ] **T-703** Platform switches, tuning numbers, maintenance mode, banner, last-working configuration — delivers FR 1405, 1769, 1770, 1771, 1772, 1773, 1734, 420; depends on: T-007
  - Done when: A switched-off feature hides with a message; an unreadable config makes the app use its last working copy.
- [ ] **T-704** Player tools: find a player, read-only record, change username, reset sign-in, merge accounts — delivers FR 1774, 1775; depends on: T-004, T-109
  - Done when: Every look at a player's record is logged.
- [ ] **T-705** Safety tools: reports, block player, unpublish content, platform ban with appeal email, word lists, report queue — delivers FR 1404, 1411, 1413, 1414, 1415, 1416, 1417, 1606, 1779; depends on: T-109
  - Done when: A reported username goes to the event team and a platform admin can unpublish content.
- [ ] **T-706** Messaging tools: templates with CST rules, push to a group, campaigns, support contact details — delivers FR 1777, 1780, 1731; depends on: T-407
  - Done when: A promotional template without an opt-out cannot be saved.
- [ ] **T-707** Legal documents with versions and forced re-acceptance; help and FAQ content — delivers FR 1781, 1782; depends on: T-110
  - Done when: Publishing a new version asks players and organizers to accept again.
- [ ] **T-708** Legal data requests: export and delete a player's data; player data download; no restore after deletion — delivers FR 1778, 1418, 1776; depends on: T-704
  - Done when: A deletion request removes the profile and anonymizes log entries; a deleted account cannot be restored.
- [ ] **T-709** Platform health view, platform numbers, admin accounts and sessions — delivers FR 1783, 1419, 1785, 1403; depends on: T-004
  - Done when: An admin can see and end another admin's sessions.
- [ ] **T-710** Review demo tenant and reviewer login — delivers FR 1406, 1407, 1736; depends on: T-703
  - Done when: The demo login and QR picker work only inside the demo tenant (outsider test).
- [ ] **T-711** Feature layers: platform Off/On with per-organizer override, Questify allows per event, owner switches, locked cards with Ask Questify — delivers FR 1826, 1827; depends on: T-703, T-210
  - Done when: A feature that is Off is invisible to owners and players; a non-allowed feature shows a locked card.
- [ ] **T-712** View as organizer (read-only support view, banner, every access logged) — delivers FR 1837; depends on: T-701
  - Done when: The banner is visible and each view is in the event log.
- [ ] **T-713** Questify home layout editor with banner slider — delivers FR 1838; depends on: T-610
  - Done when: Reordering blocks changes Questify home for players.
- [ ] **T-714** Per-organizer feature usage view — delivers FR 1839; depends on: T-709, T-711
  - Done when: The view lists which features each organizer has on.

## Phase 8 — Launch readiness

_Wallet passes, onboarding intro, web build, load test, restore rehearsal, store submission, closed test, counsel batch._

- [ ] **T-801** Wallet passes: Apple signing certificate, Google class and objects, fixed ID code, accepted like My QR, updates, minimal data — delivers FR 1758, 1759, 1760, 1761, 1762, 1763; depends on: T-205
  - Done when: A pass added to an iPhone shows the event logo and the numbers, and its code is accepted at a station.
- [ ] **T-802** Player onboarding intro: language choice, four story cards, skip, replay, join-link variant — delivers FR 138, 1798, 1799, 1800, 1801, 1802, 1803; depends on: T-009
  - Done when: The intro asks for no permission and shows once per install.
- [ ] **T-803** Player web build of the app (a bonus) — delivers FR 1816; depends on: T-118
  - Done when: A player can sign in on the web, browse and play scan-free quests.
- [ ] **T-804** Load test at 20,000 completions per minute per event and ten events at once — delivers no FR (infrastructure or quality gate); depends on: T-105, T-106
  - Done when: 95% of completions confirm within 1 second and the ranking within 5 seconds in the test.
- [ ] **T-805** Restore rehearsal and second-region recovery drill — delivers no FR (infrastructure or quality gate); depends on: T-002
  - Done when: A restore to a point 5 minutes earlier completes within an hour.
- [ ] **T-806** Store submission: privacy labels, age rating, data-safety form, screenshots, review notes, the review demo event — delivers no FR (infrastructure or quality gate); depends on: T-710
  - Done when: Both stores accept the submission for review.
- [ ] **T-807** Counsel batch and data map: send the batched legal questions and finalize the vendor data map — delivers no FR (infrastructure or quality gate); depends on: none
  - Done when: A written answer exists for each batched question or it stays listed in OPEN_QUESTIONS.
- [ ] **T-808** Final accessibility-of-text and Arabic copy pass; microcopy review with the ux-araby skill — delivers no FR (infrastructure or quality gate); depends on: T-802
  - Done when: Every screen has been read in Arabic and English by a person.
- [ ] **T-809** Independent penetration test against ASVS L2 (core) and MASVS L1 with open-book access; fix or accept in writing every finding — delivers no FR (infrastructure or quality gate); depends on: T-804, T-805
  - Done when: A written report exists; every high or medium finding is fixed and retested, or accepted in writing by the user.
- [ ] **T-810** ASVS L2 verification sheet for the core, with evidence (a test, a CI check or a note) per control — delivers no FR (infrastructure or quality gate); depends on: T-809
  - Done when: Every L2 control for the core has evidence or a written exception.
- [ ] **T-811** CranL go/no-go: written answers on high availability, point-in-time restore, backup copies, uptime, hosting provider and CST status; decide to stay or move production (ADR-107) — delivers no FR (infrastructure or quality gate); depends on: T-805, T-019
  - Done when: A written decision exists: stay on CranL, or move production to Oracle, sccc or Google Dammam.
