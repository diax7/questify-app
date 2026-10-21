# T-208 — Exclusion list, bans from an event, leaving an event

Delivers FR-319, FR-321, FR-1605 (the server side that exists: no earning, no boards; redeeming and collecting arrive
with the shop and the prize desk), FR-1703 (the server side; the confirmation screen and pushes are the app's and the
push task's). Depends on T-106. Core (tenant isolation, ledger-adjacent, admin powers): Max.

## Scope note

- **What already holds:** a `banned` enrollment cannot score (`complete_quest`, QC403), is not ranked (`ranking_eligible`,
  `ranked_enrollments`), and cannot rejoin (`join_event`, `not_allowed`); its ledger is append-only, so FR-321's "the
  record is kept" is true by construction. A player who left and joins again gets their earlier record back (FR-1703:
  the same enrollment row). The T-111 note that cited FR-1603 for narrowing rejoin was wrong (FR-1603 is about
  reservations); rejoin stays as built.
- **The known gap from T-111 closes here:** the `player_own` policy lets an organizer read every column of any player
  enrolled in their events, `birth_year` included. Nothing in the API reads `player` from the organizer seat today (the
  ranking reads are the player's own row or definers), so the organizer branch is dropped and organizers read players
  only through one definer that returns the disclosed columns (PD-17).
- **Moved:** FR-518 and FR-1604 (pause redemption for a player) need a redemption to pause; they go to T-201 (the shop)
  and T-202 (the prize desk), where the check sits next to the thing it blocks. Storing a flag nothing reads now would
  be a phantom feature.
- **Reuse:** the `enrollment_status_guard` (organizers may change status; a player only `active|pending → left`), the
  ranking repair triggers, `removeFromRanking`, the audit log (`staff` actor), `normalizeSaudiMobile`, the owner-only
  route access, `RankingSwitch` as the dashboard pattern.

## Decisions (tactical; for the CTO to challenge)

1. **Organizers see players only through `event_players(event uuid, after uuid, page int, search text)`** (definer,
   pinned, closed to PUBLIC): for a member of the event's organizer within their event limit (`app_organizer_id()`,
   `in_event_scope`), the event's enrollments with `enrollment_id, player_id, username, avatar, status, score,
   joined_at`, ordered by score then join, keyset by enrollment id, an optional username prefix search (folded as
   `username_fold`). Never `birth_year`, a contact or another event's rows. `player_own` loses its organizer branch.
2. **Ban and lift (FR-321, FR-1605):** `PUT …/events/:eventId/players/:enrollmentId/ban {banned: boolean}` (owner).
   `banned: true` turns `active` or `pending` into `banned`; `false` turns `banned` into `active` (the owner lets them
   back; for a private event too: the owner's lift is the approval). Through `set_enrollment_ban(enrollment, banned)`
   (definer, owner role checked from `organizer_member`, the event in the caller's organizer and scope), which writes
   the audit entry (`event.player_ban` / `event.player_unban`, target the enrollment, no personal data in `after`).
   Already in the asked state is a no-op answer. `left` and `removed` cannot be banned or lifted here (409). The ranking
   trigger marks the repair; the route also calls `removeFromRanking` so the board drops the name at once.
3. **Exclusion list (FR-319):** `event_exclusion (id, organizer_id, event_id, kind phone|email_domain, value,
   created_by, created_at)`, unique `(event_id, kind, value)`, at most 500 rows an event. Phones are stored as E.164
   (`normalizeSaudiMobile`; the sign-in only takes Saudi mobiles), domains lower-case and checked (`a.b` form, no `@`).
   Forced RLS: members of the organizer within their scope read; writes only through `add_exclusion` and
   `remove_exclusion` definers (owner), each audited (`event.exclusion_add` / `_remove`, `after: {kind}`, never the
   value: a phone number is personal data). Routes: `GET …/exclusions` (member), `POST …/exclusions {kind, value}` and
   `DELETE …/exclusions/:id` (owner).
4. **Excluded means off the boards, still playing:** `ranking_eligible` and `ranked_enrollments` gain one more test, a
   player whose `player_contact.phone_e164` equals a `phone` entry or whose email's domain equals an `email_domain`
   entry is not ranked. They keep earning (F-111: boards and rank prizes only). Triggers on `event_exclusion` mark the
   event's repair; the existing `player_contact` trigger is widened from the email to the phone too. Timing: the set
   form must stay near today's ~50 ms at 20,000 players (an index on `player_contact (phone_e164)` exists; the domain
   test uses `split_part(email, '@', 2)` against a small set).
5. **Leaving (FR-1703):** `POST /v1/events/:eventId/leave` (player) → 204; `active|pending → left` through the
   guard's existing player path (a plain UPDATE under RLS). Leaving again is 204. A banned or removed player cannot
   leave (409 `cannot_leave`): leaving would let them join again. A note on the push task: pushes go to `active`
   enrollments only.
6. **Dashboard (web):** the event page gains a Players section: the list (username, avatar, points, status, search),
   Ban and Lift with a confirmation naming the player (owner only; editors see the list), and an Exclusions section
   (owner adds a phone or a domain and removes entries; members see the count and the entries, phones shown masked
   except the last 4 digits). Arabic and English, RTL checked, e2e on desktop and phone.

## Data

Migration 0019: drop and re-create `player_own` without the organizer branch; `event_players`; `set_enrollment_ban`;
`event_exclusion` with RLS, grants (SELECT only), the append trigger to the ranking repair, `add_exclusion`,
`remove_exclusion`; `ranking_eligible` and `ranked_enrollments` re-created with the exclusion test; the
`player_contact` repair trigger widened to the phone.

## Tests

- Database: an organizer can no longer read `player` (direct SELECT returns nothing), `event_players` returns only the
  named columns for a member and nothing for another organizer, an editor outside the scope, or a player; ban and lift
  by the owner only, audited, refusals for `left`/`removed`; a banned player is not ranked, cannot score, cannot join
  again, and their ledger is intact; exclusion by phone and by domain takes a ranked player off and back on (both rule
  forms agree); repair marks on add and remove; outsider and cross-tenant probes for the new table and functions.
- HTTP: every route's answers and errors, owner-only writes, the 500 cap, malformed phone and domain, leaving and its
  refusals, the route inventory.
- Web: e2e for the Players and Exclusions sections in both languages.
- Mutation on the new modules; a timing check of `ranked_enrollments` at 20,000 players with 100 exclusions.

## Phases

1. **Database:** migration 0019, tests, the timing check.
2. **API:** the routes, tests, mutation.
3. **Web and docs:** the dashboard sections, e2e; API.md, DATA_MODEL, SECURITY (the gap closed), TASKS (FR-518/1604
   to T-201/T-202, the push note, fix the T-111 note), STATE.

## Revision 1 (after CTO plan review 1, 84/100) — overrides the sections above where they differ

- **M1, status changes only through definers:** 0019 drops the organizer branch from `enrollment_status_guard` and
  from `enrollment_update`'s USING and WITH CHECK; what stays is the player's `active|pending → left` and the admin.
  `set_enrollment_ban` (and T-218's approvals later) run as the owner role and pass the guard by design. No API code
  updates enrollments from the organizer seat today. `core-columns.int.test.ts` flips: owner and editor seats cannot
  change a status directly; an editor calling `set_enrollment_ban` is refused.
- **M2, no dodging a ban by leaving:** `left → banned` is allowed; lifting returns `active`. `removed` stays refused.
  Test: a player leaves, is banned, and `join_event` answers `not_allowed`.
- **m3:** no `removeFromRanking` call: every ranking read re-checks its rows with `ranking_eligible` and drops stale ones,
  and the status trigger marks the repair; `total` is approximate until the next tick.
- **m4:** `event_players` orders by `(joined_at, id)`, keyset on the last enrollment id read at query time (as
  `public_events`).
- **m5:** the username search is a prefix of `username_fold`, with `%`, `_` and `\` escaped, at most 30 characters.
- **m6:** phones are masked on the server for every seat: `GET …/exclusions` returns `{id, kind, value}` with a phone as
  `•••• 1234`; removal is by id.
- **m7:** `add_exclusion` locks the event row (`FOR UPDATE`) before counting toward the 500 cap.
- **m8:** a duplicate add answers the existing entry (`ON CONFLICT DO NOTHING`, then select); removing an unknown or
  another organizer's id is the same 404.
- **m9:** table CHECKs: `phone` values `^\+9665[0-9]{8}$`; `email_domain` values lower-case, no `@`, dotted labels;
  `(event_id, organizer_id)` references `event (id, organizer_id)`.
- **m10:** the definers take the path's event id (an enrollment or entry of another event is not found) and the
  request id for the audit entry: `set_enrollment_ban(event, enrollment, banned, request_id)`,
  `add_exclusion(event, kind, value, request_id)`, `remove_exclusion(event, id, request_id)`.
- **m11:** FR-518 and FR-1604 move to **T-209** (the desk hold for banned and flagged players, FR-1747, FR-1815, next to
  which the pause belongs).
- **m12:** `event_players` returns `enrollment_id, username, avatar, status, score, joined_at`; no `player_id`.
- **m13:** SECURITY.md records the accepted risk: an owner who adds a phone and watches the board can learn which
  username has it (FR-319 needs the behaviour). Kept small: no "excluded" flag in `event_players`, the 500 cap, every
  add and remove audited.
- **m14, leaving:** a conditional UPDATE to `left`, then the row's state decides: 204 (left now or already), 404 (not
  enrolled), 409 `cannot_leave` (banned or removed).
- **m15:** rewritten in the same change: `organizer-team.int.test.ts` (the organizer no longer reads `player`) and
  `core-columns.int.test.ts` (no direct status change).
- **Nits:** `email_domain` matches exactly (`company.com` does not cover `mail.company.com`), said in the API docs and
  the dashboard; the 0018 comment "T-208 narrows this" is corrected in TASKS and API.md (migrations are immutable); no
  public-mail-domain warning (scope).

## Result (2026-10-21)

CTO: plan 84 → 94; phases 92, 93, 92 (GO). Found while building:
- `mark_ranking_on_enrollment` (0015) called `mark_ranking_repair`, which marks only for the system or an active
  player, and runs after the row changed: a ban from the organizer seat and a player leaving left no repair mark.
  0019 writes the mark from the trigger directly (as `mark_ranking_on_player` does); the exclusion trigger too, only
  for an event that still exists (a cascade on event delete).
- The first set form (`= ANY(array)`) took about 105 ms at 20,000 players and 100 entries; two hash-joinable equality
  joins take about 65 ms (27 ms with no list). `apps/api/test/perf/ranking-timing.int.test.ts` reruns it on request.
- `GET …/exclusions` first checked only that the event was visible, and organizers see other organizers' public
  events: both lists now check the event is the caller organizer's and within their limit.
- `add_exclusion` locks the event `FOR NO KEY UPDATE`, so it never blocks the event's scans and joins; the domain rule
  accepts `xn--` TLDs (`.السعودية`); `created_by` is set NULL when a staff account goes.
- The dashboard list shows the username, status and points; the avatar is in the API's answer but the web app has no
  avatar art yet (the six avatars arrive with the app's art), so the page does not draw it.
Mutation on `moderation/*` and `join/*`: 93.2% (moderation alone 91.5%, then three more survivors killed by tests).
