# T-510: default notification topics per event (plan note)

Tier B (ADR-355): a default only ever turns a push off, it moves no points, touches no sign-in or tenant-isolation logic and
reaches no new data. The team doors run behind `award_event_of`; the player's doors read the caller's own rows. Delivers FR-1836
(F-338). Migration **0091** (new, undeployed; staging runs through 0090). Choices: **ADR-379 / Q-346 (Proposed)**.

## What exists and what this adds

- T-501 keeps a player's muted topics (`push_topic_mute`, all events) and reads them where a push is planned (`push_plan`) and at
  the claim (`push_skip_reason`). ADR-347 (6) said T-510 would add the event's defaults as a layer under the player's choice.
- **The layer.** `event_topic_off (event, topic)`: a row means the topic starts OFF for that event's players, no row means on. Nothing
  else about the event changes. `push_muted(player, topic, event)` is now: muted by the player, or (never chosen by the player and
  the event starts it off). A notice with no event (the streak reminder, an invitation) and a kind with no topic ignore the layer.
- **The player's own choice always wins, so "chose" needs a record.** Until now only a mute was stored, so "on because I never
  touched it" and "on because I turned it on" looked the same. `push_topic_on (player, topic)` records the second. The Settings
  switch is now a patch: `set_push_topics(turn_on, muted)` writes the topics named (an on removes the mute and records the on; a
  mute removes the on) and keeps the others, instead of replacing the whole muted set. The API no longer reads the current set
  first (that read-then-replace could lose a second change).
- **What Settings shows.** `own_push_topics()` answers the four booleans as before plus `eventOff`: the topics the player never
  chose that an event they are an active member of (not archived) starts off. Those switches show off with one short line.
- **The organizer's setting.** `GET`/`PUT …/events/{id}/push-defaults` (owner or editor, as announcements): four switches on the
  Announcements page, saved as they move. Audited `push.defaults` (before and after) only when something changed.

## Care points

- Read without locks in the fan-out and the claim (as the mutes are); the team write takes the event row `FOR NO KEY UPDATE`.
- The center row is written either way (ADR-347 (5)); a default off never hides a message.
- `push_muted` and `set_push_topics` change signature; the old forms are dropped in the same migration, with their callers restated.
- Erasure deletes `push_topic_on` with the mutes (`erase_rows` restated, 0076's body plus one line).
- Deny by default: both tables forced RLS and no grant; three doors granted; the outsider and cross-tenant suites list them.

## Not in this task

- Copying the defaults when an event is duplicated (a note on T-601).
- A per-event view for the player of which topics each event started off (one line says an event did).
- Per-event player choices: a choice stays global, as FR-1115 says.

## Mutation globs

None required (not tier A).
