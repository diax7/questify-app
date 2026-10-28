# T-218 — Event access types, join requests and the waiting list

Delivers FR-1818, FR-1819, FR-1820, FR-1821 (FR-1825's queue is T-616's; the accept-all route lands here for it).
**Core bar** (admin powers: a definer that decides who enters an event; seat counting under the hard limit): one
Opus plan review, one Opus code review, mutation on the new SQL-facing module. Migration **0036**. Depends on T-111
(join card, `join_core`, pending enrollments), T-102, T-212 (guest list), T-210 (player limit, ADR-141).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-167 to ADR-169 and Q-133 to Q-135.

## What exists (no change)

- `event.access` (public, unlisted, private) and its edit on the event form; the public list shows Public only; the
  join card works by code for any access type.
- `join_core` (latest in 0032): a Private join without an invitation makes a `pending` enrollment; an invited person
  goes in as `active`, also when they asked before being listed; a pending member cannot score and is not ranked.
- Approval pending → active grants the welcome reward through the `enrollment_welcome` trigger (T-212 note).
- The app's Home, Quests and history already say "waiting for approval" for a pending member.

## Rules

- **Decline (ADR-167):** a new enrollment status `declined`. A declined player sees "Your request was declined" and
  cannot ask again (`join_core` answers `declined`), unless the organizer puts them on the guest list (then they go
  in as an invited person). The owner or an editor can accept a declined request later (undo). Declined takes no
  seat, is not ranked, cannot score; leaving is not offered.
- **Seats count accepted players only (ADR-168, amends ADR-141):** `event_seats` counts `active` and `banned`;
  `pending` and `declined` take no seat. The limit trigger checks a move into `active` (insert or update, from
  pending or declined included). A pending request is never refused for being over the limit; its acceptance is.
- **Waiting list (ADR-168):** a hard-limited event at its limit answers a join with `full` (the app shows "Event is
  full" and offers the waiting list). Joining the waiting list is the same join with `waitlist: true`: it makes a
  `pending` enrollment flagged `waitlisted` (new column, default false), for any access type and for invited people
  too. Releasing someone is accepting them (oldest first in the queue). If a seat is free when `waitlist: true`
  arrives, the player simply joins.
- **Who decides:** the owner or an editor in scope (FR-1819). Accept and decline are audited
  (`enrollment.accept`, `enrollment.decline`) with the enrollment id only (no personal data in the audit details).
- **Access change any time (ADR-169):** stays on the event form; the dashboard shows a confirmation naming the
  effect before saving a change of access. Current members keep their status. Pending requests stay pending after a
  switch to Public or Unlisted (the owner accepts or declines them; the queue stays visible while any exist).
- **Raising the limit:** the limit stays Questify's (the console's `set_event_player_limit`, ADR-141). There is no
  owner ceiling today, so "the owner raises within the limit Questify set" waits for one (Q-134). The owner
  releases people; a platform admin raises the limit in the console.
- **Push:** owed to T-501 (note there): an accepted or declined request and a release from the waiting list each
  get a personal push. In the app now: the waiting screen reads the status on focus, on return to the front and
  every 15 seconds; accepted opens the event's Home, declined shows the message.

## Data (migration 0036)

- `enrollment.status` CHECK gains `declined`; `enrollment.waitlisted boolean NOT NULL DEFAULT false`.
- `event_seats` (accepted only) and `enrollment_player_limit` (a move into `active` takes a seat) replaced.
- `join_core` replaced: `declined` outcome; `full` outcome when hard-limited at the limit and `waitlist` is not asked;
  `waitlisted` set on the pending row when it is. `join_event` and `join_invited` gain `waitlist boolean DEFAULT
  false` (old signatures dropped). The rejoin of a player who left clears `waitlisted` unless asked again.
- Every reader that lists statuses is checked for `declined`: leave trigger (not from declined), `my_invitations`
  (a declined invited person is invited again), the players page (`event_players`) and its filter, `me/events`.
- Definers, revoked from PUBLIC, granted to the API role, organizer-scoped like `set_enrollment_ban`:
  - `join_requests(event, after, page)` → id, username, avatar, status, waitlisted, requested_at (joined_at), oldest
    first, pending and declined (labelled), by a cursor.
  - `decide_join_request(event, enrollment, accept boolean, request uuid)` → `accepted | declined | unchanged |
    not_found | full`. Locks the row; a full event answers `full` (the trigger's QL409 caught in the function).
  - `accept_all_join_requests(event, request uuid)` → `accepted integer, left integer`: oldest first until full.
- Outsider + cross-tenant suites: the three functions refuse the public role and another organizer's event; the new
  column and status are invisible to strangers.

## API

- `POST /v1/join` and the invite join accept `waitlist?: boolean`. New answers: 409 `event_full` gains
  `details.waitlist: true` (offerable); 403 `join_declined`. A waiting-list join answers 200 with
  `status: "pending", waitlisted: true`.
- `GET /v1/me/events` and the event read give `status` (`active | pending | declined`) and `waitlisted`.
- Dashboard (member access, event scope): `GET /v1/organizers/{org}/events/{id}/join-requests?after=`,
  `POST .../join-requests/{enrollment}/accept`, `POST .../join-requests/{enrollment}/decline`,
  `POST .../join-requests/accept-all`, each audited with the request id (as the ban route). Accept and decline are
  idempotent by outcome (`unchanged`); accept all accepts only what is still pending. Outcomes map to 200, 404, 409
  `event_full`, `not_a_request`, `event_over`.

## Screens

- **App:** the join card says "Request to join" for a Private event without an invitation; a full event shows
  "Event is full" with "Join the waiting list"; the waiting screen (event name, its dates, "Waiting for approval" or
  "You are on the waiting list", Leave) replaces the pending text on Home; declined shows its message and a way
  back. Arabic and English, RTL, Western digits.
- **Dashboard:** the players page gains a Requests section (list, Accept, Decline, Accept all with a confirm) shown
  for pending or declined rows; the event form's access field confirms a change with the effect in words.

## Tests (test first)

- **DB:** private join pending; accept → active, welcome granted once, ranked after points; decline → declined,
  join again answers `declined`; guest-listed after decline goes in; accept a declined; accept when full → `full`,
  nothing changes; two accepts at the last seat (one wins); accept-all stops at the limit, oldest first; pending
  takes no seat (a public join still fits beside 5 pending); waitlist join when full → pending waitlisted, when not
  full → active; invited + full → full; switch Private → Public keeps pending rows; another organizer, an editor out
  of scope, a player and the public role refused; audit rows written, no personal data.
- **Routes:** every outcome's status code and body, idempotent replay, the editor allowed.
- **App unit:** join outcomes (`full`, `declined`, waitlisted), the waiting screen's state machine.
- **Browser:** the players page's Requests section and the access-change confirm (desktop and phone).
- **Security suites** updated; `expo export`.

## Out of scope

The tickets inbox and reports' join queue (T-616), push (T-501), an owner limit ceiling (Q-134), event banners
(FR-1829's slides; the waiting screen shows the banner once an event has one).

## CTO plan review (84, approve with revisions): folded in

1. **Bans:** `set_enrollment_ban` answers `not_allowed` for pending and declined rows (a ban would take an unchecked
   seat, a lift would skip acceptance).
2. **Lock order:** the seat lock (`free_seats`, counting under `lock_event_seats`) before the enrollment row in
   `join_core`, `enroll_operator`, `decide_join_request` and `accept_all_join_requests`; every decision is made on the
   free seats counted under the lock, never by catching `QL409` (the trigger stays as the last guard). An invited,
   waitlisted player rejoining a full event answers `already`.
3. **Accept all** (since T-501d: at most 1,000 a call, the dashboard repeats while one accepted some and requests
   wait, ADR-353 (5)): one seat lock, `free = cap - seats` (unbounded without a hard limit), the oldest `free` pending rows
   (never declined) `ORDER BY joined_at, id LIMIT free FOR UPDATE SKIP LOCKED`, one audit row each with the same
   request id; returns accepted and remaining.
4. `enroll_operator` lets a declined row in and answers `full` instead of raising.
5. ADR-168 reworded; `full` applies to every access type.
6. Any move out of pending clears `waitlisted` (a trigger, so the player's own `left` needs no column grant).
7. ADR-167: a decline on a Public event bars the player too.
8. Deciding on an event that is not scheduled or live answers `ended`, with no welcome.
9. Readers: `my_invitations` (a declined guest is invited again), `desk_hold`, `/me/events` (declined listed so the
   decision shows; never chosen at launch), the status unions in the API, app and dashboard. Home answers
   `standing: declined`; the quests answer `not_enrolled`. A declined player cannot leave.
10. Push: noted on T-218 and T-501.
11. `questify_app` keeps `UPDATE (status)` only; tested. Nit: the partial index
    `enrollment (event_id, joined_at, id) WHERE status = 'pending'`.
