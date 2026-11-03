# T-802b - Intro cards: order and visibility set by a platform admin (plan note, tier B)

Delivers the layout-controls half of FR-1803 (F-307): a platform admin reorders the four intro cards and hides
some; the app plays the cards in that order. The four texts stay editable in the translation matrix (T-802, ADR-593). Built in
the T-713 pattern (migration 0137: one `platform_setting` key, one audited definer door, the shared catalog route). Migration
**0145**, ADR-610 to ADR-613, Q-570. Nothing here touches points, XP, gems, sign-in or a tenant.

## What exists and is reused

- The catalog route table (`apps/api/src/console/catalog-routes.ts`, `catalog.ts`): list, save, revert, the console `throttled`
  limits, the idempotency key and the settings-cache clear for a composed document (`composed: true`).
- `catalog_audit`, `catalog_revert_doc` (0119), `home_only_keys` (0137), the shared `repairList`, `readShown` and `nameIssues`.
- The config registry, `composeConfig`, `readPlatformSettings`, `parseComposedConfig` and the app's `loadHomeConfig` (cached
  copy first, then the fresh one; renamed `loadPlatformConfig` because the intro reads it too).
- The console's `ItemList` (drag, move buttons, show switch), `useCatalog`, `CatalogState`, `EditorButtons`.
- The intro: `apps/app/src/onboarding` (T-802), the four `onboarding.card*` texts.

## Design

1. **Cards (four, in today's order).** `join` (card 1), `quests` (2), `points` (3), `prizes` (4). None is protected; the rule is
   **at least one card stays shown**. Keys are the contract between the app, the console and the database (`player_intro_cards()`;
   a DB test compares it with the shared list).
2. **Store.** `platform_setting` key `playerIntro` = `{order, hidden}`. No table, no column (nothing for the personal-data
   catalog). Written only by the door; the generic settings writer's policies name `features` and `tuning` alone (0122).
3. **Door (0145).** `admin_player_intro()` and `admin_player_intro_save(doc, revert_of, request)`: `console_admin()` first (QE403),
   row ensured and locked, the document checked again in SQL (only `order` and `hidden`; `order` is the four cards once; `hidden`
   known cards once; not all four hidden: CA400 with the field), one `catalog.player_intro.update|revert` audit entry with before
   and after, a save that changes nothing writes nothing, revert reads the latest entry under the lock (CA409 when stale).
4. **Composition.** `GET /v1/config` and the event config carry `playerIntro: {cards}` (the shown cards in order). A newer
   server's unknown card key is dropped by the app's reader; a list left empty (or a copy from before this build) is the
   shipped order. An older app ignores the field.
5. **App.** The intro reads the platform configuration the phone holds (cached copy at once, the fresh one after) and plays the
   shown cards in that order. The list is fixed when the cards start, so the cards never change under the player. Anything
   unreadable is the shipped four. The join variant's welcome card takes the join card's place; hiding the join card hides it.
6. **Console.** A section "Player intro" under the Questify home editor on `/console/home` (the page already has the layout
   spec): the four cards as rows (drag, move buttons, show switch), Save, Discard, Revert; Save waits while no card is shown.

## Tests

Shared: reader (tolerant), checker (strict), compose, parse of a received config. DB (`test/db/console-player-intro`): QE403 for
every seat, default, save, audit, no-op writes nothing, every refusal, card list equals the shared list, revert and revert of a
revert, CA409 stale, a race of two saves. HTTP (`test/console/player-intro`): 404/401, save, 422 with paths, revert, the public
config shows the change. Security: route table, outsider (grants, key cannot be written directly), cross-tenant. App: card
order logic and tolerance. Web: lib tests, `console-home.spec.ts` section test plus `layout.spec.ts`.

## Left out on purpose

Per-event intro cards, new card texts or pictures (the translation matrix and T-802's art stay), hiding the language step.
