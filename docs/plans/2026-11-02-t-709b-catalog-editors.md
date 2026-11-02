# T-709b - Console catalog editors (plan note, tier B)

Delivers FR-1403 in part (ADR-425): event templates, achievements, level titles and the gem shop. The daily-challenge questions
(T-406c) and the Questify quests (T-403b) already have console pages. The XP table, the level reward map, the XP and gem amounts,
item names and new shop items, and the revoke of earned tiers are **T-709c** (tier A: a curve change recomputes
`player_xp.level` and pays or withholds gems and items). Migration **0119** (staging runs through 0115; 0116 and 0117 are pushed;
0118 is T-704/T-705's). Nothing here touches points, XP, gems already earned, sign-in or a tenant.

## What exists and is reused

- The console scope and its admin hook (`activation/routes.ts`), `console_admin()` (QE403), the `door()` wrapper and its
  refusal map (`console/doors.ts`), the throttle helper of the platform pages (`console/platform-routes.ts`).
- The closed tables `event_template` (0115), `achievement` (0065), `level_title` (0039), `gem_shop_item` (0067): no grant to any
  role, so each editor is a definer door. `templateBodySchema` for a template body; `hasUnsafeCharacter` (the translation
  helpers) for control and direction characters; `gem_buy` already refuses a price the player did not see.
- UI: the App texts page's row layout (English and Arabic side by side, RTL cells, a revert button), `PanelGrid`-style equal
  cards, `Tabs`, `useConsoleRead`, `useWrite`, the info tip (ADR-370).

## Design

1. **Doors (0119):** a list door and a save door per editor (8 in all), `console_admin()` first, row lock, change only that row,
   `catalog_text` (CA400) for names, CHECK violations for numbers, `catalog_audit` for the entry (`catalog.<kind>.update` or
   `.revert`, `before` and `after` the edited fields). A save that changes nothing writes nothing. Level titles replace the
   whole set under `LOCK TABLE ... IN EXCLUSIVE MODE`. Partial index `audit_log_catalog_idx` for a row's latest entry.
2. **Revert:** the API reads the id and `before` of the row's latest `catalog.%` entry, checks the `before` with the same
   schema and calls the save door with `revert_of` = that id; the door re-reads the entry under the row lock and raises CA409
   (409 `stale`) unless it is still the latest. Revert of a revert re-applies the change; a new template has no `before` (409).
   Review 82: achievements are edited by name only (a lower threshold pays gems at the next sync and a revert cannot take them
   back; thresholds are T-709c).
3. **Shared:** `catalog/catalog.ts` (the edit documents and the admin rows), `text/bilingual.ts` (clean, Arabic and English
   text, moved out of the template schema), `hasUnsafeCharacter` exported.
4. **API:** `console/catalog.ts` (one descriptor per editor) and `console/catalog-routes.ts` (list, save, revert for each; 60
   reads a minute, 120 changes an hour, revert needs an Idempotency-Key).
5. **Web:** `/console/catalog` with four tabs; equal cards; edit in place; Save off until the shared schema passes; the setup of
   a template is JSON with the failing paths listed.

## Tests

DB (`test/db/console-catalog`): QE403 for every seat on every door, each editor's list and save, the audit entry, nothing
written when nothing changed, the refusals (control and direction characters, lengths, thresholds, ranges, unknown rows, body
size), an event that started earlier keeps its categories, earned tiers and paid prices stay. HTTP (`test/console/catalog`):
404 and 401 on all twelve routes, saves, 422 with issues, revert and revert of the revert, idempotent revert, 409 on a new
template. Security: route table, outsider (grants), cross-tenant. Unit: `console-catalog.test`. Browser: `console-catalog.spec`
plus `layout.spec`.

## Left out on purpose

Template order (move up or down, Q-391), a visual template editor (Q-390), new shop items and item names (T-709c), the XP table
(T-709c).
