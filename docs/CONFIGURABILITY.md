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
| Templates and legal | SMS/email/push templates with CST rules checked on save; terms, privacy, guidelines, DPA as versions with forced re-acceptance (F-288, F-289) | Promotional templates cannot omit opt-out; versions are never edited, only replaced |
| Content | Daily questions, word bank, help/FAQ, word lists (F-261, F-313, F-287, F-290) | A day with no daily word shows no game |
| Intro cards | Edited by admin (ADR-096) | |

## What is not configurable (needs a release)

New quest types and mini-games; new screens and flows; theme and animation code; choosing celebration
animations; anything native (NFC behavior, wallet formats). Left out of v1 on purpose (ADR-093):
theme settings as data, gradual rollout, seasonal campaigns, per-country settings, draft/preview/
publish, version rollback, A/B tests.

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
