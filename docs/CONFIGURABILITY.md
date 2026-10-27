# Configurability — Questify

> What can change from a dashboard or the console without a store release, and how it works. Stage 6,
> 2026-10-17. Rules: ADR-004, ADR-007, ADR-093, ADR-094.

## The one rule

**Configuration changes data. It never adds behavior.** Every feature the dashboard can switch on is
already inside the reviewed app and is switched on in the review demo event (ADR-007, ADR-009, NFR-022). A new
quest type, a new mini-game, a new screen, a new native capability or a new visual theme is a code
change and a store release (Apple 2.5.2 and 2.3.1(a)).

## Three levels

| Level | Who changes it | Where it is stored | Examples |
|---|---|---|---|
| Platform | Questify admin (console) | `platform_setting`, `translation` | Feature off-switch for everyone, tuning numbers, text matrix, banner, maintenance mode, item/achievement/gem prices, SMS/email/push templates, legal documents, word lists, help content |
| Event | Owner and editors (dashboard) | `event.config`, quest/category/reward rows | Features on/off for this event, renamed words, layout and bar items, branding (logo, banner, accent), quests, shop, announcements |
| Player | The player (app) | `player`, `consent`, device settings | Language, notification channels, profile parts, equipped items |

A lower level cannot override a higher one: a feature switched off platform-wide cannot be turned on
for an event.

## How the app gets its configuration

1. On launch and when returning to the app, the app calls `GET /v1/config` (event-scoped when inside
   an event) and receives one composed document: **shipped defaults ← platform settings ← event
   overrides**. The response has an `ETag`; unchanged config costs one tiny request.
2. The document is checked against the shared schema. If it is invalid or cannot be read, the app
   keeps using the **last configuration that worked** (F-282, ADR-094).
3. Texts come from a **translation bundle** per language: key → value. A missing or empty key falls
   back to the text shipped inside the app, so a blank save can never leave a hole.
4. The document declares a **minimum app version per feature**. An older app ignores a block it does
   not know, so a new setting never breaks an old install.
5. Changes go live to everyone at once. There is no draft, rollback or A/B testing (ADR-093). What
   limits the damage: validation on save, protected items, an audit entry for every change, and the
   last-working copy on the phone.

## As built (T-007)

- **The registry is code.** `packages/shared/src/config/registry.ts` lists the features and tuning numbers the reviewed app
  contains. A key is added in the same change that builds the feature (FR-1504); a save naming anything else is refused.
- **Composition** (`composeConfig`): a feature is on when the platform has it on **and** (it is not an add-on **or** Questify
  unlocked it for the event) **and** the event has not switched it off. A lower level can only narrow a higher one. A
  platform "off" message is shown only while the platform has it off. Numbers outside their safe range are never used; the
  default is used instead.
- **Saving is strict, reading is tolerant.** `validatePlatformSettings` and `validateEventConfig` refuse unknown features,
  out-of-range numbers, blank messages, bad versions and unknown fields, and report every problem at once. Reading stored
  data drops whatever is malformed, so one damaged value never stops an app getting its configuration.
- **Who writes what.** A Questify admin: platform settings and unlocks (database rules and the service both check). An
  organizer: only the feature switches inside their own event's config. Unlocks live in `event_entitlement`, not in
  `event.config`.
- **Caching.** The server keeps a reading for 15 seconds; a save on that copy clears it at once, other copies catch up within
  15 seconds. The ETag is a hash of the document, so it changes exactly when the document does.
- **Still to come:** the admin screens and routes that call these saves (T-703, T-602), the translation bundle (T-008),
  maintenance mode and the banner (T-703).

## As built (T-303): share quests switch

- `shareQuests` (not an add-on) joins the registry. The owner turns it off per event (`PUT …/share-quests`); off hides
  every share quest from every player read through one helper (`src/quests/switched-off.ts`) and refuses paying one.
  The database also checks the event's own switch in `share_quest`.

## As built (T-307): flash quests and double points switches

- `flashQuests` and `boosts` (not add-ons) join the registry. The owner turns each off per event (`PUT …/flash-quests`,
  `PUT …/double-points`). Flash quests off (the event's or the platform's, both read by the database) hides every flash
  quest and refuses it at every door at once, and none can be launched. Boosts off for the event stops every boost
  paying at once; off for the platform, no new boost is saved while running ones finish (ADR-233).

## As built (T-409): Questify invitations

- `invitationCampaigns` (platform level, **off by default**) joins the registry and ships in `/v1/config` (the app shows
  nothing for it, FR-740). The database reads the same key (`invitation_on()`, off when absent). Off: owners cannot
  request a campaign (403 `feature_off`) and the tick neither starts nor claims anything, at once; settle keeps counting
  joins, publishing and purging. The RUNBOOK says when it may be turned on.
- `MSEGAT_PROMO_SENDER` (environment): the registered promotional "-AD" sender; without it SMS cannot be approved.
- Code constants until T-703's tuning: 50 to 100,000 messages a campaign (and at least 50 matched players to send), at
  most 3 interests, one invitation per player per 7 days, the 24-hour rule for an eligible event, rounds of 5, a
  60-second lease, a 15-minute channel hold, counts rounded to 10, the joined window of 30 days, rows kept 90 days, the
  open door's 120 tries an hour per address.

## As built (T-501): push notifications

- `pushNotifications` (platform level, on by default) joins the registry and ships in `/v1/config`. The database reads
  the same key (`push_on()`, on unless set to false). Off: the worker claims nothing and queued pushes expire unsent, at
  once; the fan-out keeps writing the center, and registration, mutes and settle go on. No event switch: T-510 adds an
  event's defaults for the topics.
- The four mutable topics (`announcements`, `rank`, `community`, `reminders`) are the player's own choice (FR-1115);
  which kind belongs to which topic is a `notice_kind` row, not a setting.
- Code constants until T-703's tuning: 2,000 enrollments a fan-out call, 500 personal notices a call, 200 rows a claim
  and at most 100 from one notice, waves of 50, a 60-second lease with a 2-second margin, 10 seconds per request, 3 tries
  in a lease (after 1 s and 2 s), 8 attempts in all, the breaker's 10 failures and 30 seconds doubling to 15 minutes, the
  15-minute account hold, the guard's 20 answers and half ambiguous, 20 registrations an hour, settle every 10 minutes,
  center rows 180 days, outbox rows 7 days, devices 60 days unseen or 7 days after an invalid mark.

## As built (T-408): the Questify-wide ranking switch and its seasons

- `questifyRanking` (platform level, on by default) joins the registry and ships in `/v1/config`. Off,
  `GET /v1/questify/ranking` answers 404 `ranking_off` at once (the database reads the same key,
  `questify_ranking_on()`, on when absent) and the app hides the ranking (T-408b); the boards keep being written, so
  turning it back on is exact. Until T-703's switches page, a Questify admin flips it through the settings service.
- Seasons are not configurable (ADR-323, Q-292 "Automatic monthly"): each Questify month is a season, starting at 04:00
  Riyadh time on the 1st; no reset, length or prize settings.

## As built (T-406): the daily games' switches, cadence and XP

- `dailyChallenge` and `dailyWord` (platform level, on by default) join the registry and ship in `/v1/config`. Off,
  that game reads `null` in `GET /v1/me/daily` and its doors refuse at once (`daily_unavailable`); a play left
  unfinished pays nothing. The database reads the same keys (`daily_feature_on`, on when absent). Until T-703's
  switches page, a Questify admin flips them through the settings service.
- The cadence per kind (`daily` or `weekly`, weekly at launch) is data in `daily_cadence`, set from the console for the
  next Questify day (`PUT /v1/admin/daily/cadence`).
- The XP amounts are `platform_setting` key `xp` fields `dailyFinishXp` (0–400, default 20), `dailyRightXp` (0–200,
  default 10) and `dailyWordXp` (0–1000, default 50); no row is added (each field defaults when absent). T-703/T-709's
  editor must keep the same ranges.

## As built (T-405): the daily streak switch and the streak settings

- `dailyStreak` (platform level, on by default) joins the registry and ships in `/v1/config`. Off, no Questify day is
  counted, `/v1/me` and the sync answer `dailyStreak: null` and no milestone is paid, at once; a streak restarts after it
  is switched back on (FR-420). The database reads the same key (`daily_streak_on()`, on when absent). Until T-703's
  switches page, a Questify admin flips it through the settings service. No event switch.
- The milestones are data in `questify_streak_milestone` (3→50, 7→100, 14→150, 30→250, 60→300, 100→400, 200→500,
  365→750 XP), edited by migration until T-703/T-709 add an editor.
- The event day streak is not in `event.config`: its on/off, bonus (1 to 100,000 points or none), closed weekdays and
  closed dates live in `event_streak`, set only by the event owner (`PUT …/streak`), validated and audited (ADR-299).

## As built (T-310): the help desk switch

- `helpDesk` (not an add-on) joins the registry, on by default. The owner turns it off per event (`PUT …/help-desk`,
  the event settings' Features list); the platform's switch is read by the API from the composed config. Off, the app
  hides only the send form (Get help's two buttons and the quest sheet's "Report a problem with this quest") and the
  server refuses new tickets (`feature_off`); Your requests, Home's "The event team answered you" and the answers stay,
  and open tickets stay answerable.

## As built (T-308): the NFC switch

- `nfcTags` (platform level, not an add-on, on by default): off, the app hides NFC, taps and the operator's write
  routes answer `feature_off`, and every NFC quest completes by its QR. The team's Tags panel stays. No event switch:
  the quest's own NFC method is the organizer's.

## As built (T-309): the stations switch

- `stations` (platform level, not an add-on, on by default): off, station pages show "Not available" and the
  screen-code routes (the device's and the operator's) answer `feature_off`; pairing, the Devices page and Revoke stay.
  No event switch: the quest's own `screen_qr` method is the organizer's. The window is fixed at 30 seconds with 15
  seconds' grace (ADR-240); the old platform tuning `screenQrRotationSeconds` was removed (Q-206).

## As built (T-309b): the kiosks switch

- `kiosks` (platform level, not an add-on yet, on by default; ADR-076's paid add-on gates it later, with activation):
  off, kiosk pages show "Not available" (`GET /v1/device` answers a kiosk `shut: feature_off`),
  `POST /v1/device/kiosk-scans` and `GET /v1/me/live-code` answer `feature_off`, and the app's For kiosks tab says
  "Kiosks aren't available right now"; pairing, the Devices page and Revoke stay. No event switch: the quest's own
  `kiosk` method is the organizer's.

## As built (T-008): texts

- **Shipped texts** are `MESSAGES` in `packages/shared/src/i18n/messages.ts`: every key in Arabic and English, the same
  `{placeholders}` in both. A key is added in the same change that uses it. A test keeps the two languages in step and
  keeps Arabic-Indic digits out.
- **The store** (`translation` table) holds only what an admin changed, per language. Saving a blank value removes that
  language's change (back to the shipped text); a key with neither language left is deleted.
- **Save rules** (`validateTranslation`): the key must exist; every placeholder of the shipped text must still be there and no
  other may be added (the message names the missing or extra one); Arabic-Indic digits are written as 0-9; at most 1000
  characters. Both languages are checked and reported together, and nothing is written if either fails.
- **Showing a text** (`createTranslator`): the admin's value when it is usable, otherwise the shipped text. Usable means not
  blank and the same placeholders as the shipped text, so a damaged stored value never reaches a screen. Numbers passed in
  as values are formatted with Western digits in both languages (`formatNumber`).
- **Still to come:** the matrix editor and its search and filters (T-702), and date and time formatting in Western
  digits (with the first screen that shows a date).
- **A changed key:** when a shipped text gains or loses a placeholder (T-117 put `{currency}` and `{player}` into several),
  an admin's override written for the old text no longer has the same placeholders, so the shipped text shows until the
  admin saves it again.

## As built (T-117): the event's words

- **Stored** in `event.config.terms`, only the words the organizer changed; the event page's "Event words" section saves
  the whole set (`PUT …/events/{id}/terms`). Questify's defaults: «نقطة / نقاط», "point / points", the coin; «لاعب /
  لاعبون», "player / players"; «مشغّل / مشغّلون», "operator / operators".
- **Rules** (`validateEventTerms`, shared): a word is given in both languages with both forms, or left out; each form is
  trimmed, 1 to 30 characters, with no digits, braces, control or bidi characters. The icon is one of five images
  (coin, crown coin, gem, leaf, star); there is no upload (FR-405).
- **Reading** (`readEventTerms`) is tolerant: each word that is wholly usable is kept, anything else is the default, so
  a damaged value never empties a label. The composed configuration always carries the complete set.
- **Arabic grammar (ADR-058):** a renamed noun is used only where it needs no article, agreement or counting: as a label
  before a colon («جواهر: 120»), as a heading on its own (the players page title is the plural as typed), or after لكل
  in the singular («عدد المرات لكل طالب: 3»). Sentences that would need more were rephrased with no noun. English uses
  the singular for exactly 1 ("+1 gem"), and a label or heading takes the plural with a capital ("Gems: 120").
- **The app** keeps one copy of the configuration per event (`questify.config.<eventId>`, beside the platform's), shows
  the cached words first and then the fresh ones, and Questify's defaults until either exists. An icon it does not know
  shows the coin. A scan paid in another event names the amount with Questify's words, since that event's are unknown.
- **Quest and category (T-311b, FR-942):** stored and read like the other words (`terms.quest`, `terms.category`, defaults «مهمة /
  مهام», «فئة / فئات»). Texts name them with placeholders the translator fills (`{questOne}`, `{questMany}`, `{questOneCap}`,
  `{questCap}`, the same for `category` and `player`; ADR-252), so a screen never passes them. Arabic takes a renamed noun only
  as a label or heading, an indefinite object or a construct, and is otherwise rephrased with no noun (ADR-253). The player app
  and staff mode use them (staff mode loads the event's configuration with the player app's cached copy, ADR-254); Questify
  home keeps the defaults. Every page of an event in the dashboard says them too (T-311c, ADR-264: the event layout reads them
  once; the kiosk page, the public code page and the Event words form keep the defaults, Q-227); the big screen (T-5xx) uses
  the words when it exists.

## As built (T-403b): Questify quests and campaigns

- **Data, not code (ADR-278):** the Questify team creates always-on quests and seasonal campaigns in the console
  (`/v1/admin/questify`; the page is `/console/questify`, built T-403c). A quest has a title in Arabic and English (1–80 characters, no control or
  bidi characters), a metric from a closed list (events played, cities played, quests completed), a target (1–1000), an
  XP reward (1–10000) and an order; a campaign has a name and a window entered in Saudi time. No new metric, reward kind
  or screen can be added this way (rule 7).
- **Safe edits:** a campaign is published only before it starts; once started its start is fixed and its end only moves
  later; once a quest can pay (active always-on, or its campaign published) its metric and target are fixed and it stays
  active until retired. Titles, XP (later awards only), order and names stay editable. Retiring hides a quest or
  campaign and keeps every award. At most 20 quests per campaign and 50 always-on.
- **Seeded:** attend 3 events and play in 2 cities, 300 XP each, live from the deploy (ADR-279).
- **Audit:** every change is in the audit log with the admin, the ids and the names of the fields changed.

## As built (T-404): gems and the gem shop

- **Amounts are data (ADR-286):** `platform_setting` key `gems` `{levelUp, bronze, silver, gold}` sets the gems paid per
  level reached and per achievement tier; each field counts only when it is a whole number 1–1000, else its default
  (20, 10, 25, 50). No row exists until T-709 adds the editor and the row's CHECK; a changed amount pays rows earned
  later. Server-only, never in the public `features`/`tuning`.
- **Quest gems:** each Questify quest pays 0–1000 gems with its XP (the two seeded quests 25), fixed once the quest can
  pay. The console quest form has the Gems field (T-404b), disabled once the quest can pay.
- **The shop catalog:** items, prices, order and retirement are seeded by migration until T-709 (FR-1403). Nothing is
  sold for money; gems are earned only by playing (STORE_COMPLIANCE 1.6).

## As built (T-410): the shop's window after the event

- **Per event, on the dashboard's Rewards page (ADR-336, FR-1018):** the days the rewards shop stays open after the
  event ends, 0 to 30 whole days, default 3 (0 closes it at the end); owner or editor in scope. Before the end any
  value; after the end only a longer window; once closed it is frozen, lengthening included (409 `shop_window_locked`,
  enforced again by a database guard). The dashboard and Home show when it closes in the event's zone (T-410b, built).
- **The close is a rule, not a setting:** nothing is written at the close (ADR-337), and no switch reopens a closed
  shop. The event's `shop` feature switch still hides the shop and Home's window entirely.

## What can be configured

| Area | Configurable | Limits and protections |
|---|---|---|
| Features | Switch any feature off, platform-wide or per event; an off feature is hidden as if absent, with an optional message (F-278) | Switching off a feature never adds one. Store listings always describe everything as on (NFR-022) |
| Texts | Every string in the app as key, Arabic, English, edited live (F-277) | Placeholders (`{player}`, `{quest}`, points) cannot be removed; both languages checked on save |
| Renamed words | Player, operator, quest, category, currency name and icon per event (ADR-058) | Plural/singular forms required in both languages (NFR-014) |
| Layout | Reorder home blocks, rearrange the 5-item bar, hide pages (ADR-090) | A protected set of bar items cannot be hidden (FR-1750) |
| Branding | Logo, banner, accent colour from an approved palette (ADR-085) | Theme itself is code, not data (ADR-093); colours are tokens so a second theme can be added later (NFR-024) |
| Quests, categories, rewards, sessions, maps, sponsors | Everything an organizer creates | Typed by shared schemas; live edits ask "future only / also past" with confirmation (ADR-063) |
| Tuning numbers | Flag thresholds, QR refresh and My QR grace time, login-code limits, reservation time, push/SMS limits, "running low" levels (F-279, Q-074) | Each has a safe range; out-of-range saves are refused |
| Platform messages | Banner on Questify home (scheduled); maintenance mode, global or per event (F-280, F-281) | Maintenance shows its message; staff and health checks still work |
| Catalog | Items, achievements, gem prices (F-216) | |
| Questify quests | Always-on quests and seasonal campaigns: titles, metric (closed list), target, XP, order, window (FR-710, FR-711; T-403b) | Condition fixed once a quest can pay; a campaign published only before it starts; caps 20 per campaign, 50 always-on |
| Templates and legal | SMS/email/push templates with CST rules checked on save; terms, privacy, guidelines, DPA as versions with forced re-acceptance (F-288, F-289) | Promotional templates cannot omit opt-out; versions are never edited, only replaced |
| Content | Daily questions, word bank, help/FAQ, word lists (F-261, F-313, F-287, F-290) | A day with no daily word shows no game |
| Intro cards | Edited by admin (ADR-096) | |

## What is not configurable (needs a release)

New quest types and mini-games; new screens and flows; theme and animation code; choosing celebration
animations; anything native (NFC behavior, wallet formats). Left out of v1 on purpose (ADR-093):
theme settings as data, gradual rollout, seasonal campaigns of configuration (Questify quest campaigns, FR-711, are
data; Q-246), per-country settings, draft/preview/publish, version rollback, A/B tests.

## Over-the-air updates (Q-033)

EAS Update can ship fixes to the app's JavaScript without store review. Policy proposed: **bug fixes
only, never a new feature or a change of purpose**, and never a way around ADR-007. Anything that
changes behavior goes through the store. Counsel and a read of Apple's current wording confirm this
before the first use.

## Audit

T-402b souvenir rules are organizer data: bilingual public cosmetic names, a shipped frame/chest/title renderer,
one of4 audiences and category/rank parameters. Explicit activation freezes item content and the nonempty eligible
quest set; stop prevents future grants without recall. New behavior/art mechanics still require a release. Private
event attribution is separate from public cosmetic names. Rank rules must activate before confirmed results;
existing snapshots are not reconstructed.100 rules/event, ranks1–100. Configuration uses no remote art/code service.

Every platform and event configuration change writes an audit entry (who, what, before, after, when)
that is never edited (FR-1409, NFR-019).
