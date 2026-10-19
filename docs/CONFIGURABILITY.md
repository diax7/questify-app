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

Every platform and event configuration change writes an audit entry (who, what, before, after, when)
that is never edited (FR-1409, NFR-019).
