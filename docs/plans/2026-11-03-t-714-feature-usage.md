# T-714 - Per-organizer feature usage view (plan, tier B)

Delivers FR-1839 (F-341): the console shows, per organizer, which features are on and used. Builds on T-709 (the
read-only platform doors and the console `throttled` helper), T-711 (feature layers: `platformForOrganizer`,
`organizer_feature_override`) and T-609 (the Usage view, whose counts stay as they are). Migration **0140**. ADR-550 to
ADR-553 and Q-510 Proposed.

## What exists and is reused

- Layer state: the platform switch with the organizer's override over it (`organizerFeaturesView`, `layers.ts`); an
  event's own switches (`event.config.features`); an add-on is "unlocked" by an `event_entitlement` row.
- Read-only door pattern (0117): a `SECURITY DEFINER` function that starts with `console_admin()` (QE403), revoked from
  PUBLIC, granted to `questify_app`; the API runs it through `door()` and checks the answer with a strict zod schema.
- `throttled(deps, request, reply, limit)` of `console/platform-routes.ts` (one holdBack, never copied).

## Design

1. **One new page, `/console/feature-usage`** ("Feature usage"), a read-only list of organizers (name or slug prefix
   search, keyset pages of 25, at most 50) beside Usage. Each organizer card lists the 16 event-level features: the
   layer state (On or Off for the organizer, with "Off for everyone" or "Override: on/off" so the cause is visible) and,
   for events, "On in N of M events" and "Used in K events". The four Questify-wide groups of features (`level:
   "platform"`) have no organizer and are not listed. Counts only: no player, staff or contact is read or shown.
2. **Door `console_feature_usage(search, after, page_size, feature_keys)`** (migration 0140). One query over the page's
   organizers and, per organizer, its **200 latest events** (the Usage view's bound; `more` says there are older ones):
   the events' own switches (`config.features`, counted by key through `jsonb_each`), the add-on unlocks, and for each of
   12 features whether the event has content in its table (`event_session`, `paired_device` kind `screen`, `boost`,
   `cheers_moment`, `community_goal`, `quest` flash / live poll / share / meet / game, `ticket`, `event_map`,
   `quest_rating`, `reward`), each an `EXISTS` through an event-id index. Ranking and today's ranking have no content of
   their own: their usage is not measured (shown as the switch only). `feature_keys` (the registry's event-level keys,
   passed by the API) bounds what the door answers. Each part is aggregated once per organizer and joined back by
   organizer (never a correlated subquery over the events read, which was quadratic in the page size: 5 to 9 s against
   1.2 to 2.2 s for a page of 50 organizers with 250 events each, measured on a fixture).
3. **Layers stay in TypeScript.** The door answers raw counts; `featureUsageOrganizer` (`packages/shared/src/switches/
   usage.ts`) lays the platform and the override over them with the same functions as T-711 and derives "on in N events"
   with `featureLayer`'s rules (default on: events minus explicit off; `eventOffByDefault`: explicit on; add-on: unlocked).
   The route answers the strict `featureUsagePageSchema`.
4. **Indexes** (same migration): `quest_rating (event_id)` (the table had none by event; it also serves the event
   cascade) and a partial `quest (event_id, type) WHERE type IN ('share', 'meet', 'game')`.
5. **API.** `GET /v1/admin/feature-usage?q&cursor&limit`, console scope (404 to anyone but an active admin), the admin
   checked again in the door, bucket `console_feature_usage` 60 a minute per admin. Not audited: no personal data.

## Tests

shared `usage` (state per layer, default-on / off-by-default / add-on counts, untracked usage, schema); DB
`test/db/feature-usage` (who may ask, per-feature usage from real rows, the 200-event bound, switches, entitlements,
overrides, search and keyset, an unknown cursor, plan uses the indexes); console `test/console/feature-usage` (HTTP: 404
for a member, 401 signed out, the Cheers-off row of the FR, strict query); security (outsider, cross-tenant, route
catalog); web lib tests, `e2e/console-feature-usage.spec.ts`, `layout.spec.ts` with the new page. A scale measurement
(50 organizers x 200 events, every table filled) is recorded in the STATE bullet.
