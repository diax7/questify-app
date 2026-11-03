# T-713 - Questify home layout editor with banner slider (plan note, tier B)

Delivers FR-1838 (F-340): a platform admin reorders and hides the blocks on Questify home and edits its banner slider; players see
the new order. Builds on T-610 (the slide shape and its reader, the app's banner slider, the editor's rows) and T-709b (the
audited door with a revert through the audit log, migration 0119). Migration **0137**, ADR-510 to ADR-514, Q-470 to Q-473.
Nothing here touches points, XP, gems, sign-in or a tenant. Pictures on slides wait for photo storage (Q-149, T-610b): slides are
text only, as in T-610.

## What exists and is reused

- `readSlide`, `BANNER_SLIDES_MAX`, `CONTENT_LIMITS`, `isAllowedLink` (`packages/shared/src/layout`), `repairList` and `readShown`
  of the event layout (exported for this), the catalog editors (`apps/api/src/console/catalog.ts`, `catalogDoor`, `revertCatalog`),
  the console `throttled` helper (`platform-routes.ts`), `catalog_audit`, `catalog_revert_doc`, `catalog_text` (0119).
- The app: `BannerBlock` (made context-free: `BannerSlider` takes how a tap opens), `loadConfig` and its last-working copy.
- The dashboard: `ItemList` (drag, move buttons, show switch, lock for protected rows), `EntryList`, `TextPair`, `ActionPicker`,
  `useCatalog` (list, save, revert), `Tabs`, the phone frame styles.

## Design

1. **Store.** `platform_setting` key `questifyHome`, value `{order, hidden, banner}`. No new table: the key sits beside `features`
   and `tuning`, readable by the API role, and writable only by the definer door (the generic writer's policies already name
   `features` and `tuning` alone, 0122). Not `event.config.layout`: it is Questify's, not an event's (ADR-395 note).
2. **Blocks (eleven, in the order the screen draws them today).** `notices`, `banner`, `code`, `account`, `operator`,
   `invitations`, `streak`, `dailyChallenge`, `dailyWord`, `events`, `quests`. Protected (never hidden; they can still move):
   `notices` (what Questify says about a switched-off feature), `code` (the way in for anyone who cannot scan), `account` (the
   recovery email), `operator` (staff reach their event), `invitations`, `events`. The two daily games were one block; each is its
   own now so the daily word can sit above the challenge. A block keeps its own conditions (a streak the platform switched off
   draws nothing). Sign-in only blocks draw nothing for a signed-out visitor, who sees the layout's other blocks and then the
   sign-in prompt, which is not a block.
3. **Content.** The banner only: up to five text slides in two languages, the T-610 slide shape; a tap opens nothing or an https
   link (the other taps open event screens). The reader and checker reuse `readSlide`; the Questify reader refuses other taps.
4. **Door (0137).** `admin_home_layout()` and `admin_home_layout_save(doc, revert_of, request)`: `console_admin()` first, the
   row ensured and locked, the document checked again in SQL (a permutation of `questify_home_blocks()`, protected ones not hidden,
   at most five slides, bounded clean text, https links), one `catalog.home_layout.update|revert` audit entry with before and
   after, a save that changes nothing writes nothing. The revert reads the latest entry's `before` under the row lock (CA409
   when another change landed). `questify_home_blocks()` is the one SQL list; a DB test compares it with the shared list.
5. **Composition.** `GET /v1/config` and the event config carry `questifyHome: {blocks, banner}` (the shown blocks in order and
   the banner, empty while the banner block is hidden). The settings service reads the key with the other two and the catalog
   routes clear its cache after a change, so a save reaches the apps within the cache's time. An app older than this build ignores
   the field.
6. **App.** Questify Home draws the layout's blocks in order. It shows the cached configuration first and the fresh one after,
   so the order never flickers; a missing, damaged or incomplete layout is the order the screen always had. Unknown names are
   dropped, a missing block joins the end, a layout without a protected block is the default.
7. **Dashboard.** `/console/home` ("Questify home" in the console navigation): the block list with the rows of the event editor
   (drag, move buttons, show switch, lock), the banner slides under it (Edit opens the slide editor), a phone beside it redrawn from
   the unsaved draft, Save, Discard and Revert. Save waits until the shared check passes.

## Tests

Shared: reader (tolerant), checker (strict), compose, parse of a received config. DB (`test/db/console-home-layout`): QE403 for
every seat, list default, save, audit, no-op writes nothing, every refusal, protected set equals the shared list, revert and revert
of a revert, CA409 stale, a race of two saves. HTTP (`test/console/home-layout`): 404/401 on the three routes, save, 422 with
issues, revert, the public config shows the change. Security: route table, outsider (grants, the key cannot be written
directly), cross-tenant. App: layout reading and block order logic. Web: lib tests, `console-home.spec.ts` plus `layout.spec.ts`.

## Left out on purpose

Pictures (Q-149), the scheduled banner message and maintenance mode (T-703b), taps into the app's own screens (Q-471), quick
links, cards and countdowns on Questify home (not asked by FR-1838), a preset list.
