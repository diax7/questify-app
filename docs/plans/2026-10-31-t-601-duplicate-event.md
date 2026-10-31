# T-601: duplicate an event (plan note)

Tier B (ADR-355): a copy reads and writes only inside one organizer and moves no points, so it touches no ledger, sign-in or
tenant-isolation logic; the door runs behind `award_event_of` like every team door. Delivers FR-1016 (F-190). Migration **0092**
(new, undeployed; staging runs through 0090, 0091 is deploying). Choices: **ADR-380 / Q-347 (Proposed)**.
**Split:** templates (FR-1015, F-189) are T-601b. Each part ships alone: a duplicate needs no template data, and a template needs
content, a table of its own and a picker on the new-event page (below).

## What it does

- `POST /v1/organizers/{id}/events/{eventId}/duplicate` (owner or editor, **Idempotency-Key**), body `{name, startsAt, endsAt}`
  (times as the event's wall clock, the create rules). The API reads the source (`readEvent`, so another organizer's event is
  404), merges the source's fields with the new name and times (`merge`, the create checks), inserts the draft with a new join code
  (`insertEvent`) and calls `event_copy_setup(source, target, request)` in the same transaction. An editor limited to chosen events
  is `scope_limited`, as for a create. The answer is the new event, `201`.
- `event_copy_setup` (SECURITY DEFINER, granted to the API role, nothing else new is) checks both events with `award_event_of`
  (AN404), refuses one event onto itself (ED422) and a target that is not an empty draft (ED409: any quest, reward, item, join field,
  enrollment, or more than the one General category every event starts with), takes the source `FOR SHARE` and the target
  `FOR NO KEY UPDATE`, removes the target's own General category (the source's categories replace it) and copies, in order:
  settings (shop, desk with its hours, caps (not the player limit, which Questify sets at activation), rules, config with switches and words, default topics), quest items,
  join fields, categories, quests, first-bonus rules, passport steps, the focus quest, rewards, rank prizes, streak settings,
  agenda, maps with pins, sponsors with tags, big-screen scenes. One audit entry `event.duplicate` (source and counts).
- **New ids, stable references.** `copy_id(old, target)` = `md5('copy:' || old || ':' || target)::uuid`, so a reference between
  copied rows (a quest's category, an unlock order, an item, a tag, a pin, a session's quest, an audience field) is rebuilt in plain
  SQL with no mapping table.
- **Times move.** Every absolute time (quest and reward windows, a category's opening, sessions, the desk's hours, the streak's
  closed days) moves by the distance between the two start times; the new event's own times are the ones asked for.

## What it never copies

People and play: enrollments, guests, exclusions, join answers, completions, the points and XP ledger, redemptions, submissions,
votes, ratings, tickets, passport stamps, session registrations, cheers, notices. Secrets and devices: reward codes, NFC tags,
paired devices, operator invitations and staff assignments, speaker links, invitation campaigns. Live operation and money: boosts,
community goals, the finale, entitlements, activation requests, results, rehearsal rows, souvenir rules. A typed entry code
(`enter_code`) gets a NEW random code; a flash quest and a sent poll start unsent; a digital reward starts with no stock (its stock
is its codes); a removed reward, item or rank prize is not carried over. The copy is a Draft; Questify activates it as any draft.

## Tests

`test/db/event-duplicate.int` (copies, references, shifted times, an enumeration over every table with `event_id`: only the
copied ones hold rows in the target, refusals, audit), `test/events/events.int` (the route: setup, original untouched by a date
change, replay, 400/422, other organizer 404, limited editor 403), `outsider` (one door, helpers closed), `cross-tenant` (every
seat, both directions), `routes.int` (the route is listed), `e2e/duplicate-event.spec.ts` (Arabic and English, phone and desktop).

## T-601b (templates), for the next plan

`event_template` (DATA_MODEL: "supplied as data by the team"): a closed table of four structures (conference, festival, campus,
corporate) with Arabic and English categories, quests and rewards; a door that applies one to the empty draft just made, reusing
`copy_id` and the quest checks; `GET` of the list for the picker on the new-event page; the template's item rewards need the
prize desk, so the picker must say so or the template must leave item rewards out.
