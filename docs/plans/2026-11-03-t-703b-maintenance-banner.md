# T-703b - Maintenance mode and the scheduled banner (plan, tier B)

Delivers FR-1771 (maintenance, global or one event, with a message) and FR-1772 (a banner with a start and an end on
Questify Home). Builds on T-703 (`platform_setting`, the Switches page, `throttled`, the one-key audit pattern).

## Storage (configuration is data, ADR-450)

Two new `platform_setting` keys, both objects, written only by an active platform admin (migration 0128 widens the 0122
policies from `features, tuning` to `features, tuning, maintenance, banner`):

- `maintenance`: `{ "global": {ar,en}?, "events": { "<event uuid>": {ar,en} } }`. A message present means play is paused.
- `banner`: `{ "message": {ar,en}, "startsAt": ISO, "endsAt": ISO }`. `{}` means none. A clear writes `{}` (rows are never
  deleted).

## Composition (the app keeps its last working copy)

`GET /v1/config` and `GET /v1/events/:id/config` gain `maintenance` (`{ar,en}` or null: the event's own message, else the
global one; the platform document carries the global one only) and `banner` (`{message,startsAt,endsAt}` or null). The
composer stays pure: the app decides "now" against the start and end with its own clock, so a copy kept offline stops
showing a banner once it has ended. An older app drops the blocks it does not know; an older cached copy has none (null).
`parseComposedConfig` reads both tolerantly.

## Enforcement (server)

`preHandler` hook after the player guard (`src/maintenance/gate.ts`): while a message applies, the play doors answer
`503 maintenance` with the message (and `details.scope`): quest complete, passport stamp, category reveal, reward reserve,
event goal, join, Questify sync. Reads, the leave door, redemption cancel, deletion, acceptances, the team dashboard, the
operator doors and the whole console stay open, so staff and platform admins are never locked out and the config door still
answers (the last-working copy). A 5xx releases the idempotency key, so the offline queue retries after maintenance ends.
An event's own maintenance needs the event of the door's id: `play_event_id(kind, ref)` (definer, API role only) resolves it,
and is called only when some event has a message and no global one applies. The settings service's cache (15 s, cleared on
every save) serves the gate.

## Console

`GET /v1/admin/switches/notices`, `PUT`/`DELETE` `/switches/maintenance/global`, `PUT /switches/maintenance/events`
(event by join code), `DELETE /switches/maintenance/events/:eventId`, `PUT`/`DELETE` `/switches/banner`. `throttled`,
catalog limits, audit `platform_settings.update` with before and after. Third tab "Maintenance and banner" on the Switches
page.

## App

Questify Home shows the global maintenance message and an active banner (`PlatformNotices`); the event pill shows the event's
maintenance message on every event tab. A refused door shows the server's message as it shows any refusal.

## Tests

shared (read, compose, parse), API service and routes (outsider, player, staff 404; audit; cache; validation), gate (each
door, event vs global, other event plays, GETs and admin/staff doors open, idempotency key released), DB (function grants,
write policy), outsider and cross-tenant lists, app notice selection, web lib and console spec.
