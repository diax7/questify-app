# T-703 - Platform switches and tuning numbers (plan, tier B)

Delivers FR-1405, FR-1769, FR-1770, FR-1773 (check), FR-420 and FR-1734's switches (the daily streak and username
changes are two of the switches; XP by difficulty is T-709c's Amounts editor and is not duplicated).

## Split (each half delivers value alone)

- **T-703 (this change):** the console **Switches** page: every feature switch of the app (on or off, a message in
  both languages shown to players while it is off) and the tuning numbers (range shown, reset to the default); the
  numbers the database reads (rehearsal cap, readiness look-ahead, flag burst count and window) become tuning numbers;
  the app lists the messages of switched-off features on Questify Home. The last-working copy exists already
  (`apps/app/src/config/remote.ts`, ADR-412 and T-007); a test is added where it was not covered.
- **T-703b (new):** maintenance mode, global or for one event (FR-1771), and the scheduled banner on Questify home
  (FR-1772). They need a stored schedule, a gate on the play doors, and app screens; none depends on the page above.
- **Stays where it is:** FR-1731 (support contact) is T-706's (nothing built, T-706 already lists it). FR-1730 stays
  "partly built" (Q-361: SMS, push and storage are not metered). `minAppVersion` is not edited: the app does not read
  it yet (a switch the app ignores would be a phantom feature).

## What exists and is reused

- `platform_setting` keys `features` and `tuning` (migration 0003; the API role writes only these two since 0122), the
  settings service (`savePlatformSettings`, audit `platform_settings.update` with before and after, cache cleared on every
  save), the registry (`packages/shared/src/config/registry.ts`), `composeConfig`, `GET /v1/config` with the app's cached
  last-working copy.
- The console door pattern: `/v1/admin/` scope behind the admin hook, `throttled` per admin, the catalog limits.

## Design

1. **Registry.** `TuningDefinition.serverOnly`: composed config leaves such a number out (the flag thresholds must not
   reach players). Four numbers: `rehearsalCap` 25 (1-100), `readinessDays` 14 (1-60), `flagBurstCount` 10 (3-100),
   `flagBurstMinutes` 5 (1-60). All tuning numbers are whole numbers (the database reads integers).
2. **Settings service.** `setPlatformFeature` and `setPlatformTuning` (one key, or back to the default with `null`):
   lock the block, read it tolerantly, change one key, validate with `validatePlatformSettings`, write, audit as before.
   Two admins on two keys never overwrite each other (the whole-block replace of `savePlatformSettings` stays for tests).
3. **Routes** (`/v1/admin/switches`): `GET` (the view built by `buildSwitchesView` in shared), `PUT`/`DELETE`
   `/features/:key`, `PUT`/`DELETE` `/tuning/:key`. A key the app does not have is 404 on DELETE and 422 on PUT.
4. **Migration 0125.** `rehearsal_cap()`, `flag_tuning()` and `readiness_soon()` read `platform_setting` `tuning`
   (`platform_tuning_int`, internal, no grant), falling back to the shipped number when the stored one is missing, not
   whole or outside the range (the same range as the registry; a test compares the two). Callers and grants unchanged.
   The rehearsal card's `cap` is read from the stored number in TypeScript.
5. **Console page** `/[lang]/console/switches`: two tabs (Features, Numbers). Switch saves at once; the message boxes
   (Arabic and English, both or none) save with a button. A number saves with its field; the range is the field's
   min and max (ADR-370: no help line); an icon button resets to the default.
6. **App.** `PlatformNotices` on Questify Home: the message of every switched-off platform feature that has one, in the
   player's language, read from the cached platform config.

## Tests

shared: registry/compose (server-only left out), validate (whole numbers), view builder. API: service (one key at a
time, audit, reset), routes (outsider, player token and organizer staff get 404; admin ok; throttle), DB (the three
functions follow the stored number and fall back; PUBLIC and the API role have no grant), cross-tenant/outsider suites
extended. Web: lib tests and the console spec (switch off with a message). App: notice selection.
