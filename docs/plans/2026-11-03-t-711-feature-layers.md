# T-711 - Feature layers (plan, tier B)

Delivers FR-1826 and FR-1827 (ADR-105). Builds on T-703 (platform switches), T-210 (add-on unlocks in `event_entitlement`) and
T-602 (the owner's event switches).

## What exists

- Layer 1, the platform: `platform_setting` `features` (T-703), read by `composeConfig` and by SQL rules (`feature_enabled`,
  `flash_on`, `shop_on`, `cheers_json`).
- Layer 2, Questify allows an event: a `gated` feature (an add-on, today only `bigScreen`) needs a row in `event_entitlement`
  (console: `PUT /v1/admin/events/{id}/addons/{feature}`).
- Layer 3, the owner: `event.config.features.<key>` through `PUT /v1/organizers/{o}/events/{e}/<feature>`.
- The owner's Features section on the event page (`EventForm`) and in the guided setup shows every switch, whatever the platform
  or Questify allowed; a switched-off or locked feature is only hidden from players.

## Split (each half delivers value alone)

- **T-711 (this change):** a per-organizer override of the platform switch for the 12 features whose platform rule reaches an
  event (composed configuration or `feature_enabled`): the console organizer page lists them (platform now, override, effective)
  and sets Off, On or "like the platform". The owner's Features section hides what the platform (or the override) turns off,
  shows a locked card with Ask Questify for an add-on Questify has not allowed, and the server refuses an owner switch-on that a
  layer forbids (403 `feature_not_allowed`).
- **T-711b (new):** the override for `boosts`, `community`, `meetSomeone` and `miniGames` (their platform check is read
  platform-wide in code and their SQL rules `boosts_on`, `community_on`, `games_on`, `meet_on` sit in the points path: tier A, plan
  review first) and the in-app Ask Questify request (one tap records the request; the console lists it with Allow and Decline).

## Design

1. **Registry.** `FeatureDefinition.noOrganizerOverride` marks the four features above; `level: "platform"` features (player-wide,
   kiosks, stations, NFC, location, invitations) have no organizer or event to act on, so they are not overridable either
   (`isOrganizerOverridable`).
2. **Data (migration 0136).** `organizer_feature_override (organizer_id, feature, enabled, set_by, set_at)`, primary key
   `(organizer_id, feature)`. Forced RLS: read when any event of the organizer is visible (as `event_entitlement`), insert, update
   and delete only for `app_is_admin()`; nothing for PUBLIC. Internal rule `platform_feature_on(organizer, feature)` = override,
   else the platform's switch. `feature_enabled`, `flash_on`, `shop_on` and `cheers_json.platformOn` use it; their answer with no
   override row is unchanged (parity test against `composeConfig`).
3. **Composition.** `platformForOrganizer(registries, platform, overrides)` lays the overrides over the platform settings; the
   settings service reads the event's organizer overrides with the event config and composes with that. The apps and every door
   that reads the composed configuration follow (a player's `GET /config`, `requireEventFeature`, the quest lists). An override On
   shows no "switched off" message; an override Off shows none either (the platform message is about the platform).
4. **Console.** `GET /v1/admin/organizers/{id}/features`, `PUT` and `DELETE …/features/{key}`: admin hook (404 to anyone else),
   the shared `throttled` helper, one key per call under an advisory lock, audited `organizer.feature_override.set|clear` with
   before and after. The organizer page gets a Features panel.
5. **Owner.** `GET /v1/organizers/{o}/events/{e}/features` (owner or editor) answers one row per event-level feature the platform
   leaves on: `on`, `off` or `locked` (an add-on not unlocked). `saveEventSwitch` refuses `enabled: true` for a feature that is
   hidden or locked (`not_allowed` -> 403 `feature_not_allowed`); switching off stays allowed. `PUT …/features/{feature}` is the
   one handler behind the owner's existing per-feature paths. The event page and the guided setup read the rows and drop the
   hidden switches, and show an `AddonCard` (locked: Ask Questify opens the Contact page) for each add-on row.

## Tests

shared: `layers` (override laid over platform, rows, view, overridable list). DB: `test/db/feature-layers` (policies, outsider,
cross-tenant, parity of the four SQL rules with `composeConfig` in every state, shop reservation refused by an override Off and
allowed by an override On). Console: `test/console/organizer-features` (404 for non-admin, audit, effect on the composed config,
a member of another organizer cannot read the rows). Owner route: refusal and rows. Web: lib tests, `e2e/console-features.spec.ts`
and the owner section.
