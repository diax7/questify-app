# T-312 — Ticket center: four types, routing, escalation to Questify, the Questify queue, My tickets

F-324, F-325, F-326: one ticket center with four types; the type decides who receives it; one reply closes a ticket;
the event team escalates to Questify with a note, and Questify answers or sends it back; the player reads every ticket
and its reply from the profile. Delivers FR-1822 and FR-1823; FR-1824 **partly** (My tickets; the notification history
needs T-501's notification center and moves to **T-312b**). Extends T-310 (migration 0059, `apps/api/src/tickets/**`,
ADR-246 to ADR-248, Q-209 to Q-211) without moving data.
**Core bar** (tenant isolation, a new **cross-tenant reader**: the Questify queue, admin powers, personal data): one Opus
plan review, one Opus code review, mutation on GitHub. Migration **0061** (new file; CranL runs through 0056, 0057 to
0060 are undeployed; the functions they last stated are restated here, never edited there).

**CTO plan review 2026-10-25: 86/100, findings folded in; re-review 91/100, GO with the routing CHECK fixed** (MAJOR 1 a platform send racing erasure; MAJOR 2 the list
read's audit names the tickets shown; minors 3 to 9 and nit 10 in the sections below, marked "CTO n"). ADR-078
(email, password and an emailed code for admins) is Accepted and kept.

Dhia is away: open choices are my recommendation, written as **Proposed** ADR-255 to ADR-259 and Q-218 to Q-222.

## Split (ADR-255)

- **T-312** (this plan): the four types and routing, Report a player, app problems and suggestions outside an event,
  escalation, the console's Questify queue (answer, send back), My tickets, the device facts of an app problem.
- **T-312b** (new, Should, depends on T-501): Profile → **Notification history** (FR-1824's second half). Nothing to
  read exists yet: no migration holds a notification (T-501 builds the center, FR-1104). T-312b is the profile row and
  the full list (read and unread, newest first) on T-501's table; it is a screen, not a second store.

The rest is T-310's size plus one console page: one migration, one module grown, the app's ticket center, two web
pages changed and one added. One worker.

## What T-312 builds on

- **`ticket`** (0059): `kind` CHECK `question|problem`, `queue` CHECK `event`, the event columns nullable with the CHECK
  `queue <> 'event' OR (event_id, organizer_id, enrollment_id NOT NULL)`; answer columns `answered_by_staff` /
  `answered_by_operator`, `answer_key`, the caps under the enrollment lock; `own_tickets(NULL)`, `mark_tickets_seen(NULL,
  …)`, `GET /v1/me/tickets` and the app's Your requests (`apps/app/app/requests.tsx`, `src/event/Requests.tsx`).
- **Visibility**: `operator_sees_ticket` already requires `queue = 'event'`; `answer_core`, `event_tickets`,
  `event_ticket_counts` filter `queue = 'event'`. So a ticket moved to `questify` leaves the operators and the team's
  answer doors by the rules already written; T-312 only adds the read-only "With Questify" view for the team.
- **The console** (T-210, 0027): routes only under `/v1/admin/`, a hook that answers **404** to anyone but an active
  platform admin (`platformRole = 'admin'`, `status = 'active'`), the staff session (email + password + emailed code,
  ADR-078; inactivity expiry), and **`app_admin_id()`** re-read inside every definer (the request flag alone is not
  enough). One admin role (`staff_user.platform_role IN ('none', 'admin')`). Web: `/[lang]/console` and
  `apps/web/src/lib/console.ts`. Console reads are not yet audited (Q-116, T-701): T-312 audits its own reads now.
- **Idempotency**: answers keep T-310's database key; escalate and send back use the API's `idempotency-store.ts`
  (24 hours, per principal) plus state checks in SQL.

## Types and routing (ADR-256)

| Card (player) | Stored `kind` | Needs an event | Goes to | Who answers there |
|---|---|---|---|---|
| Report a player | `report_player` (+ the reported member) | yes | the event team | owners and editors only, **never operators** |
| Question or problem at the event | `question`, `problem` (T-310's), `prize` (new) | yes | the event team | owners, editors, operators with `help_desk` (T-310's rule) |
| App problem | `app_problem` (+ device facts) | no | Questify | platform admins |
| Suggestion | `suggestion` | no | Questify | platform admins |

- Q-209 answered as recommended: the fourth card holds three choices (A question / A prize problem / Something else
  here), so T-310's rows stay as they are and T-616's prize-problems view is `kind = 'prize'`. The quest sheet's
  "Report a problem with this quest" stays a shortcut (`problem`, quest attached); the reservation and prize screens gain
  "A problem with this prize" (`prize`).
- Routing is fixed by the kind, in the database: `kind IN ('app_problem', 'suggestion')` ⇔ no event columns and
  `queue = 'questify'` for life (never sent back: there is no event team). Event kinds start in `queue = 'event'` and reach
  `questify` only by escalation (CHECK `queue = 'event' OR (escalated_at IS NOT NULL AND escalated_at >
  coalesce(returned_at, '-infinity'))` for event kinds: the latest hop is an escalation; CTO 3, re-review: a NULL
  `escalated_at` must not pass).
- **Why report_player skips operators**: operators are often players and friends of players; a report names someone.
  Owners and editors are the accountable seats. Report-only mute/blocks are T-705's (FR-1415); a report never blocks.
- **App problems and suggestions never carry an event**, even when sent from inside one: the event team never sees them,
  and erasure, the rehearsal wipe and the event cascade stay simple. The text can name the event.
- FR-1411's "report to the event team **and** Questify's moderation queue" is T-705's moderation queue (a different
  thing from tickets; Q-219). T-312's Report a player reaches the event team only, as FR-1822's acceptance says.

## The shape (migration 0061)

`ticket` gains (all nullable unless said):

| Column | Type | Notes |
|---|---|---|
| `kind` | CHECK widened | `question, problem, prize, report_player, app_problem, suggestion` |
| `queue` | CHECK widened | `event, questify` |
| `reported_enrollment_id` | uuid | `(reported_enrollment_id, event_id) → enrollment ON DELETE SET NULL (reported_enrollment_id)`; set only by the send for `report_player` (a rehearsal wipe may clear it later, so no CHECK requires it) |
| `app_version` | text | `^[0-9A-Za-z.+-]{1,32}$`; only for `app_problem` |
| `platform` | text | `ios \| android`; only for `app_problem` (NOT NULL there) |
| `os_version` | text | 1–32, same character class; only for `app_problem` |
| `device_model` | text | 1–64 printable, cleaned; only for `app_problem`; NULL from a build without the module (below) |
| `escalated_at`, `escalated_by_staff` (→ `staff_user`), `escalation_note` (1–1,000, cleaned) | | the latest escalation; all three set together (CHECK) |
| `returned_at`, `returned_by_admin` (→ `staff_user`), `return_note` (1–1,000, cleaned) | | the latest send-back; all three together; only after an escalation |
| `answered_by_admin` | uuid → `staff_user` | the third answerer; CHECK at most one of the three answerers; the closed ⇔ an answerer CHECK restated with it |

CHECKs restated: `queue <> 'event' OR (event columns NOT NULL)` stays; new `(kind IN ('app_problem','suggestion')) =
(event_id IS NULL)`; `kind IN ('app_problem','suggestion') OR queue = 'event' OR (escalated_at IS NOT NULL AND
escalated_at > coalesce(returned_at, '-infinity'))` (CTO 3; the re-review's fix, with a forged insert of `queue =
'questify'` and `escalated_at` NULL in the tests); `returned_at IS NULL OR (escalated_at IS NOT NULL AND (queue =
'questify' OR returned_at >= escalated_at))` (a return only after an escalation, and in the event queue the latest hop
is the return; re-review nit);
`answered_by_admin IS NULL OR queue = 'questify'` (Questify answers only in its queue); device columns NULL unless
`app_problem`. Indexes: `ticket_questify_open_idx (created_at, id) WHERE status = 'open' AND queue = 'questify'`,
`ticket_questify_closed_idx (closed_at DESC, id) WHERE status = 'closed' AND queue = 'questify'`,
`ticket_answer_key_admin UNIQUE (answered_by_admin, answer_key) WHERE answered_by_admin IS NOT NULL` (no event to scope
by), `ticket_reported_idx (reported_enrollment_id) WHERE reported_enrollment_id IS NOT NULL` (the FK),
`ticket_platform_player_idx (player_id, created_at DESC) WHERE event_id IS NULL` (the Questify caps),
`ticket_open_report_key UNIQUE (player_id, reported_enrollment_id) WHERE kind = 'report_player' AND status = 'open'`
(the backstop for one open report per reporter and reported; CTO 4). RLS stays forced,
no grant, no policy.

## Who sees a ticket (ADR-257, replaces ADR-247's table; Q-211 answered by this)

| Who | Reads | Acts |
|---|---|---|
| The sender | their own, every queue, any enrollment status, while the account is active; sees "With the Questify team" while escalated, the reply signed **The event team** or **The Questify team** (never a person, never the notes) | — |
| Another player | nothing; a reported player never learns of the report | — |
| Owners, editors in scope | every ticket of their event: `queue = 'event'` to answer; **escalated** ones read-only ("With Questify", their own note, Questify's reply once closed); the return note | answer, solve, **escalate** |
| Operators with `help_desk` | T-310's rule, minus `report_player` (and `queue = 'event'` already); a sent-back ticket shows them neither the escalation nor the return note (team only; CTO 7) | answer, solve |
| **A platform admin** | **exactly the rows with `queue = 'questify'`**, open or closed: app problems, suggestions, and event tickets while escalated (and after Questify closed them). A ticket sent back is gone from the console. Never `queue = 'event'`, never by id, never through any other door | answer, solve, send back |
| An admin who is also an organizer member | the console rule in the console; the organizer rule in the dashboard; neither widens the other | |
| Anyone else, `anon`, `PUBLIC` | nothing | |

**States, one meaning everywhere** (CTO 6): *Open* = open in `queue = 'event'`; *With Questify* = open in `queue =
'questify'`; *Closed* = closed, from either queue (the team's Closed tab lists its own and Questify's answers; the
console's Closed lists what Questify closed and the app problems and suggestions closed).

**What Questify sees of a ticket**: the kind, the text, the time, the sender's @username (no avatar; CTO 10), for an event ticket
the organizer's and event's names, the quest's title, the reported member's @username, the escalation note and who
escalated (the staff member's email, for follow-up); for an app problem the four device facts. Never a contact, full name
or birth year. **Every console read is audited** (Q-116 for this page now): a list page writes one
`console.tickets_read` row **per distinct (organizer_id, event_id) among the rows shown** (`target_type ticket`, `after
{status, ids: [the ticket ids shown for that event]}`; one row with `organizer_id` NULL for the event-less ones), so each
event's log shows every support look at its tickets, lists included (CTO 2); and `console.ticket_read` per detail (`organizer_id`, `event_id` set, so
T-701's "every support access appears in that event's log" holds for tickets); ids only, never text.

## Escalation and the Questify queue (ADR-258)

- **Who escalates**: owners and editors in scope, from the dashboard (`award_event_of`, AN404). Operators cannot (the
  console's cross-tenant door stays narrow; an operator asks the owner). Any open event-kind ticket, while the event is
  not archived (`HT409 event_closed`). A **note is required** (1–1,000, `clean_submission_text`): what the team tried.
- **What moves**: `queue → questify`, `escalated_at/by/note` set (an earlier return's columns stay for the history);
  the ticket keeps its event, quest, sender and caps (it still counts as one of the sender's 3 open). It leaves every
  operator's Inbox and count at once (`operator_sees_ticket`), and the team's answer doors (HT404 there); the dashboard
  shows it under **With Questify**, read-only.
- **Questify's actions** (console, `app_admin_id()` re-read in each): **Answer** (one reply closes it; the player sees
  "The Questify team") and **Solve** (closed, no reply), through `admin_answer_ticket` with T-310's replay rules and
  its own key index; **Send back** (event tickets only; a note is required: `queue → event`, `returned_*` set; the team
  sees the note on the ticket; the ticket rejoins operators' inboxes by T-310's rule). App problems and suggestions
  cannot be sent back (`HT409 not_escalated`). Re-escalating a returned ticket is allowed (a new note; the audit holds
  every hop). FR-1823's "take over any ticket" reads as Questify answering an escalated ticket itself, and "any" as any
  ticket in its queue, never a ticket that was not routed or escalated to it (Q-218).
- **Audit**: `event.ticket_escalated` (staff; `organizer_id`, `event_id`, `target_id`, no text), `console.ticket_answered`
  / `console.ticket_solved` / `console.ticket_returned` (`actor_type admin`; the event's ids when the ticket has an
  event, so the organizer's activity log shows Questify touched their ticket). An admin answer of an app problem audits
  with no organizer.
- **The archived and ended event**: Questify can answer an escalated ticket whatever the event's state (support is not
  bound to the event's clock); send back is refused once archived (the team can no longer answer).
- **Concurrency**: escalate, send back and every answer take the ticket row `FOR UPDATE` and re-read `status` and
  `queue`; the loser gets `HT409 already_closed` / `not_open` / `moved` (the ticket changed queue). No new lock order.

## Sending (ADR-259)

1. `open_ticket(target_event, kind, quest, reported_username, body, key)` (DROP and CREATE, 0059's six-argument shape
   is gone): T-310's order and rules, kinds `question|problem|prize|report_player`. For `report_player`: a username
   (`HR422 username_required` otherwise) resolved case-folded to an enrollment of **this event** whose player is active
   (`HR404 unknown_player` otherwise: nothing about accounts outside the event), not the sender (`HR403 self_report`),
   at most **one open report per (sender, reported)** (`HT409 already_reported`; the partial unique index is the
   backstop, CTO 4). **The lookup can tell a username is in the event** even when the board would not show it (the team
   and the exclusion list are off the board, the board can be switched off, FR-607, and shows a top only), so failed
   lookups are capped (CTO 8): the API counts `unknown_player` answers per player and event in the existing Redis
   limiter, at most **10 an hour** (`429 too_many_lookups` with Retry-After; the counter is a number, no username kept;
   if Redis is down the send still works and the cap is skipped, logged `ticket.lookup_cap_unavailable`). The quest is refused for a report
   (`HQ422`). The replay compares the reported member too. The event caps (3 open, 10 a day per player and event) cover
   all four event kinds together.
2. `open_platform_ticket(kind, body, app_version, platform, os_version, device_model, key)` (player): `app_problem |
   suggestion`; an active player account, no enrollment needed (a player in no event can write). Takes a
   per-player transaction advisory lock (`ticket-send:<player>`), then **the player row `FOR KEY SHARE` with `status =
   'active'`** (CTO 1: erasure takes that row `FOR UPDATE`, 0038:763, so a send waits for an erasure in flight and then
   finds the account deleted, `HT403 not_member`; and an erasure waits for a send in flight, whose row its `DELETE FROM
   ticket` then removes; without it a send could insert after erasure's delete and outlive the account), then the
   replay by `(player_id, key)`, then the text,
   the device facts (`HD422 {field}`; required for `app_problem`: version, platform, OS), the caps: **3 open** and
   **5 in 24 hours** in the Questify queue per player (`HT409 too_many_open`, `HT429` with the seconds), the insert.
   Lock order line in rules.md: the advisory lock, then the player row `FOR KEY SHARE`, then the insert; no enrollment,
   no ticket lock. Erasure takes the player row and then deletes tickets, never the advisory lock, so no cycle.
3. **Device facts**: version and build from `expo-constants`, platform and OS from `Platform`; the model from
   **`expo-device`** (`Device.modelName`, e.g. "iPhone 15 Pro"; no permission, no identifier, Expo SDK 57's version, a
   new development build). The app loads it lazily in a try/catch (as `react-native-nfc-manager`), so a binary without
   it sends `deviceModel: null` (Android falls back to `Platform.constants.Model`). Never `Constants.deviceName` (it is
   the owner's name for the phone). The form shows the facts it will send ("Sent with: Questify 1.4.0, iPhone 15 Pro,
   iOS 18.1"). Dependency reason: FR-1822's acceptance names the phone model, and iOS gives no model without it.

## Functions (migration 0061; each REVOKEd from PUBLIC, entry points granted to `questify_app` only)

1. `open_ticket` (DROP, CREATE) and `open_platform_ticket` (above).
2. `own_tickets(target_event)` DROP and CREATE: plus `queue`-derived `with_questify` (open and in `questify`),
   `answered_by_team` (`event | questify`, from which column is set; never a person), `reported_username` (the sender's
   own report: the name they reported, so they recognize it), `kind`'s new values; the NULL form lists event-less
   tickets with `event NULL`. `own_unread_tickets(NULL)` restated to count every queue (the profile tab's dot).
3. `event_tickets` and `event_ticket_counts` DROP and CREATE: the tabs become `open | with_questify | closed`; rows
   gain `reported_username`, `escalated_at`, `escalation_note`, `escalated_by` (email), `returned_at`, `return_note`,
   `answered_by 'admin'` shown as "The Questify team" (never the admin's email to the organizer); counts by the three
   tabs **and by kind** (the start T-616 builds on).
4. `operator_sees_ticket` restated: `AND t.kind <> 'report_player'` (the inbox, its count, `operator_ticket`, and
   `answer_core` all go through it).
5. `staff_escalate_ticket(target_event, target, note, request)` (team).
6. `console_tickets(wanted open|closed, wanted_kind, wanted_source direct|escalated, cursor_id, page)` and
   `console_ticket_counts()` (admin): `queue = 'questify'` only; open oldest first, closed newest first, keyset by id,
   at most 100; each row with the preview (first 120 characters), never the full text, plus the facts above. The list
   writes one `console.tickets_read` row per distinct event among the rows shown, with their ids (CTO 2); the counts
   write none (numbers only).
7. `console_ticket(target)` (admin): one ticket where `queue = 'questify'`, full text, reply, notes; `HT404` otherwise
   (an event ticket, a returned one, a missing id: one answer); writes `console.ticket_read`.
8. `admin_answer_ticket(target, reply, key, request)` and `admin_return_ticket(target, note, request)` (admin).
   Each calls `app_admin_id()` first (`insufficient_privilege` when NULL: the request flag alone opens nothing).
9. `purge_ended_tickets` restated: `LEFT JOIN event`; due at `greatest(coalesce(e.ends_at, t.created_at), t.created_at,
   t.escalated_at, t.returned_at, t.closed_at) + 90 days` (an escalation, a send-back or a late answer gives the
   ticket 90 more days; CTO 5). An event-less ticket still **open** is not purged by age: it waits in the console until
   Questify closes it, and goes 90 days after the closing (CTO 5; Q-220 updated). The console shows its age.
10. **Erasure**: `erase_rows` unchanged in substance (`DELETE FROM ticket WHERE player_id = me` already takes event-less
    and escalated tickets); a report **about** an erased member keeps the report, the reported name shows "Deleted
    account". An erased admin is a staff account; staff deletion is T-709's (the FK holds, as `answered_by_staff`).
11. **Rehearsal wipe**: unchanged (tickets by `enrollment_id`); a report against a rehearsal account loses the
    reported link by the FK (`SET NULL`) when the account is wiped; a rehearsal account's app problems stay (they
    have no event).

## API (`apps/api/src/tickets/`; API.md rows)

Player (bearer):
- `POST /v1/events/{eventId}/tickets` gains `kind: "prize" | "report_player"` and `reportedUsername?: string` (3–30);
  new errors 404 `unknown_player`, 403 `self_report`, 409 `already_reported`, 422 `username_required`.
- `POST /v1/me/tickets` `{kind: "app_problem" | "suggestion", text, device?: {appVersion, platform, osVersion,
  model | null}}`, **Idempotency-Key** → `201 {ticket}` (`200` on a replay); 409 `too_many_open`, 422 `invalid_text` /
  `invalid_device {field}` / `idempotency_key_reused`, 429 `too_many_tickets` with Retry-After.
- `GET /v1/me/tickets` and `…/tickets/mine` gain `withQuestify`, `answeredBy: "event" | "questify" | null`,
  `reportedUsername`, `event: null` for Questify tickets; `GET /v1/me` gains `help: {unread}` (the profile dot).
  The body scan for any person's name (T-310's CTO 5) extends to the new fields.

Team (staff cookie, organizer prefix):
- `GET …/events/{eventId}/tickets?status=open|with_questify|closed&kind=` (counts by tab and kind), `POST
  …/tickets/{ticketId}/escalate` `{note}` **Idempotency-Key** → `{ticketId, queue: "questify", replayed}`; 404,
  409 `not_open` / `moved` / `event_closed`, 422 `invalid_text`.

Console (`/v1/admin/`, `access: admin`, the 404 hook, `no-store`):
- `GET /v1/admin/tickets?status=open|closed&kind=&source=direct|escalated&cursor` → `{tickets, nextCursor, counts}`;
  `GET /v1/admin/tickets/{ticketId}`; `POST …/{ticketId}/answer` `{reply?}` **Idempotency-Key** → `{ticketId,
  outcome, replayed}`; `POST …/{ticketId}/return` `{note}` **Idempotency-Key**; 404 for anything outside the queue,
  409 `already_closed` / `not_escalated` / `moved` / `event_closed`, 422 `invalid_text`.
- Rate limit: 120 console ticket calls a minute per admin (the existing limiter's pattern), so a stolen session cannot
  scrape the queue quickly; refusals logged `console.tickets_throttled {adminIdHash}`.

Every route declares `config.access` and is classified in `routes.int.test.ts`. **Logs**: `ticket.opened {kind,
queue, hasQuest, marked}`, `ticket.escalated {replayed}`, `ticket.returned`, `ticket.answered {outcome, via
operator|staff|admin, replayed}`; never the text, the notes, the reply, a username, an email or a device model. The
redaction test gains a note, a reported username and a device model.

## How the player learns of an answer (unchanged until T-501)

Home's strip and Your requests' dots (T-310) cover event tickets; the profile tab gains a dot from `GET /v1/me`'s
`help.unread` for every queue, so a Questify answer to an app problem is found without an event. T-501's note grows:
one push per closed ticket, fixed text by team ("The event team answered you" / "The Questify team answered you" /
"Your request was marked solved"), never the text; no push when a ticket is escalated or sent back.

## App

- **The ticket center** (`apps/app/app/help.tsx`, account-level; the event's `event/[eventId]/help.tsx` opens it with
  the event fixed): four wooden cards with one line each saying who receives it ("Goes to the event team" / "Goes to the
  Questify team"). Report a player and Question or problem at the event need an event: inside an event it is that
  one; from the profile a chip list of the player's active enrollments, or "Join an event to use this" when there are
  none. The event cards hide with `helpDesk` off or sending closed (T-310's rules); app problem and suggestion are
  always on. Report a player: an @username field and "The player is not told who reported them".
- **The privacy line changes** (the event cards): "Only you and the event team can see this. If they ask Questify for
  help, the Questify team can see it too" (it was "Only you and the event team"; ADR-257). Questify cards: "Only you and
  the Questify team can see this".
- Get help's foot line "A problem with the app itself? Contact Questify" now opens the App problem card; Settings →
  Legal keeps the web contact page (Apple 1.5).
- **Your requests** (= FR-1824's My tickets; the player-facing word stays "requests", one term since T-310): every
  queue, the kind's label, "With the Questify team" while escalated, the reply's signature by team, a reported
  username on the sender's own report. The profile row shows the dot.
- **Staff mode**: `prize` gets its badge; reports never appear; an escalated ticket open on screen when it moves answers
  HT404 → "This request moved to the event's owners" and returns to the list.

## Dashboard and console

- **Help desk page**: tabs Open / With Questify / Closed with counts, kind filter (six kinds), **Escalate to Questify**
  on an open ticket (a note box, required; confirm "The Questify team will answer the player. You can still read it
  here"), the With Questify tab read-only with the note; a returned ticket in Open shows "Sent back by Questify:
  {note}"; Closed shows "Answered by the Questify team" for theirs. Report a player rows show the reported @username
  (linked to the Players page) with "Report a player" badge.
- **Console → Tickets** (`/[lang]/console/tickets`, linked from the console home with the open count): Open and Closed,
  filters by kind and source (Direct: app problems and suggestions; Escalated), each row with preview, age, event and
  organizer (for escalated), device facts (for app problems); the detail with the full text, the escalation note, Reply,
  Solve, and Send back (escalated only, a note required). Desktop and phone layouts, RTL, `no-store`.

## Strings (Arabic through `ux-araby` at build, matched to `messages.ts`; Western digits; RTL checked)

| Key | English | Arabic (draft) |
|---|---|---|
| help.center.title | How can we help? | كيف نساعدك؟ |
| help.type.report | Report a player | الإبلاغ عن لاعب |
| help.type.event | Question or problem at the event | سؤال أو مشكلة في الفعالية |
| help.type.app | App problem | مشكلة في التطبيق |
| help.type.suggestion | Suggestion | اقتراح |
| help.to.event | Goes to the event team | يصل إلى فريق الفعالية |
| help.to.questify | Goes to the Questify team | يصل إلى فريق كويستفاي |
| help.event.question / .prize / .other | A question / A prize problem / Something else here | سؤال / مشكلة في جائزة / أمر آخر هنا |
| help.prizeProblem | A problem with this prize | مشكلة في هذه الجائزة |
| help.report.username | Player's username | اسم مستخدم اللاعب |
| help.report.anonymous | The player is not told who reported them | لن يعرف اللاعب من أبلغ عنه |
| help.report.unknown | No player with this username in this event | لا يوجد لاعب بهذا الاسم في هذه الفعالية |
| help.report.self | You can't report yourself | لا يمكنك الإبلاغ عن نفسك |
| help.report.already | You already reported this player. The event team will look at it | سبق أن أبلغت عن هذا اللاعب، وسيراجع فريق الفعالية البلاغ |
| help.private.event | Only you and the event team can see this. If they ask Questify for help, the Questify team can see it too | لا يراه إلا أنت وفريق الفعالية، وإن طلبوا مساعدة كويستفاي فسيراه فريق كويستفاي أيضًا |
| help.private.questify | Only you and the Questify team can see this | لا يراه إلا أنت وفريق كويستفاي |
| help.device.sentWith | Sent with: {facts} | يُرسل معه: {facts} |
| help.needEvent | Join an event to use this | انضم إلى فعالية لاستخدام هذا |
| help.pickEvent | Which event? | في أي فعالية؟ |
| help.status.withQuestify | With the Questify team | لدى فريق كويستفاي |
| help.replyFromQuestify | The Questify team | فريق كويستفاي |
| help.tooManyPlatform | You have 3 requests waiting for the Questify team | لديك 3 طلبات بانتظار رد فريق كويستفاي |
| operator.ticket.moved | This request moved to the event's owners | انتقل هذا الطلب إلى مالكي الفعالية |
| operator.inbox.prize | Prize | جائزة |
| tickets.tab.withQuestify | With Questify | لدى كويستفاي |
| tickets.escalate | Escalate to Questify | أحِله إلى كويستفاي |
| tickets.escalate.note | What did you try? The Questify team reads this, the player doesn't | ماذا جرّبتم؟ يقرأ هذا فريق كويستفاي، ولا يراه اللاعب |
| tickets.escalate.confirm | The Questify team will answer the player. You can still read it here | سيرد فريق كويستفاي على اللاعب، ويبقى الطلب ظاهرًا لك هنا |
| tickets.returned | Sent back by Questify: {note} | أعاده فريق كويستفاي: {note} |
| tickets.answeredByQuestify | Answered by the Questify team | ردّ عليه فريق كويستفاي |
| tickets.kind.report / .prize | Report a player / Prize | بلاغ عن لاعب / جائزة |
| console.tickets.title | Tickets | التذاكر |
| console.tickets.direct / .escalated | Direct / Escalated | مباشرة / محالة |
| console.tickets.return | Send back to the event team | أعده إلى فريق الفعالية |
| console.tickets.returnNote | Tell the event team why | أخبر فريق الفعالية بالسبب |
| console.tickets.device | Device | الجهاز |

## Retention and personal data

- New personal data: the reported member (a link, shown as @username), the device facts (app version, platform, OS,
  model; no identifier), the notes (staff writing about a player). All in Riyadh, never in logs, error reports, audit
  rows or push text. The redaction and audit tests check the notes and the model.
- **Who may now read a ticket changes**: escalation lets Questify read an organizer's player's text. The app's privacy
  line says so before sending (above); the privacy policy's help-ticket line (Q-075) adds it; counsel confirms with
  Q-210 (Q-221).
- Retention (function 9): 90 days after the later of the event's end, the sending, the escalation, the send-back and
  the closing; an event-less ticket 90 days after its closing, never while open (Q-220). Account deletion takes every ticket the
  account sent at once, every queue.
- DATA_MODEL's `ticket` line and PII line grow; SECURITY's who-can-do-what gains the console row and the outsider/
  cross-tenant rows below.

## Store compliance

- **Apple 1.2 / Google UGC**: Report a player is an in-app report of another user; tickets stay private, so no public
  UGC is added. STORE_COMPLIANCE §1.2's T-310 note gains it (blocks remain T-705's, FR-1415).
- **New dependency `expo-device`**: no permission, no tracking; Apple's privacy manifest: device model is sent only
  inside a support request (App Privacy's **Customer Support**, already declared by T-310, and **Other Diagnostic
  Data** is not claimed since nothing is sent automatically). Google Data safety: "App info and performance → Other"
  only inside the user's report, user-initiated, deletable with the account. STORE_COMPLIANCE's privacy table rows.
  **At build** (CTO 9): read `expo-device`'s own `PrivacyInfo.xcprivacy` entries (any required-reason API it declares)
  and record them in STORE_COMPLIANCE; confirm the App Privacy answer above against them; the new development build
  (Android and iOS) is Dhia's step; the lazy load and the ban on `Constants.deviceName` stay, each with a unit test.
- **Apple 1.5** unchanged (the contact page stays). Nothing downloaded; the kinds are data in the database, the switch
  is T-310's.

## Tests (test first)

- **Database** (`test/db/tickets.int.test.ts` grown, `test/db/tickets-console.int.test.ts` new):
  - **Routing table** (one row per kind × door): each kind lands in its queue; `app_problem`/`suggestion` with an event,
    or an event kind without one, refused by the CHECKs (forged inserts as the owner role); `report_player` invisible to a
    `help_desk` operator by list, count, id and answer (HT404); a prize ticket visible to operators.
  - **Report a player**: unknown username, a username of another event's member (unknown_player, same answer),
    a pending or removed member (unknown_player), self, the second open report (already_reported), a closed one freeing
    it, case folding, a quest with a report (HQ422), the replay with another username (QK422).
  - **Platform sends**: no enrollment needed; device facts required for app problems, bad characters and lengths
    (HD422 each field), NULL model accepted; 4th open and 6th in 24 hours; replay; a deleted or suspended account.
  - **Escalation**: owner and editor in scope escalate; editor out of scope (AN404); an operator cannot (no door);
    note required and cleaned; a closed ticket (not_open); an archived event; the ticket leaves `operator_inbox`,
    `operator_inbox_count`, `operator_ticket`, `answer_core` (HT404 for team and operator answers) and appears in
    With Questify; audit row without the note text.
  - **The Questify queue**: list and counts show exactly `queue = 'questify'`; answer and solve (player sees
    `answeredBy questify`), replay by the admin's key, the key on another ticket (QK422); send back (event tickets only;
    not_escalated for app problems; note required), after which the console answers HT404 by list and id and the
    operators see it again; re-escalation; answering an archived event's escalated ticket works, sending it back does
    not; audit rows for every read and action with the event's ids, never text.
  - **Reads**: `own_tickets` signatures by team and never a person, `with_questify`, the sender's reported username;
    `own_unread_tickets(NULL)`; `event_tickets` tabs and counts by kind; the team never sees the admin's email.
  - **Lifecycle**: erasure takes event-less and escalated tickets; an erased reported member shows Deleted account; the
    rehearsal wipe clears a report's link; `purge_ended_tickets` for an event-less ticket and after a late escalation
    and a late answer (not a day early), in batches.
  - **Crossed locks**: the team answers while escalating (one wins); two admins answer (one wins); an admin answers
    while sending back; the same platform key twice at once (one row, the second `replayed`); the 3rd and 4th
    platform send at once (one refused); erasure during an admin answer (HT404); **a platform send during erasure**,
    both orders (the send waits and is refused `not_member`, or the erasure waits and deletes the new ticket: no
    ticket outlives the account; CTO 1).
  - **Added from the CTO review**: a list read writes one audit row per event shown, each holding exactly the ids shown
    for that event and no text, plus one event-less row (CTO 2); a forged `answered_by_admin` on an event-queue row, a
    `questify` event ticket whose latest hop is a return, and a second open report for the same pair, each refused by
    the table (CTO 3, 4); a `report_player` escalated then sent back stays hidden from operators by list, count, id and
    answer, and no operator read carries either note (CTO 7); `purge_ended_tickets` after a send-back (not a day
    before `returned_at` + 90 days) and an open event-less ticket never purged by age (CTO 5); the 11th failed username
    lookup in an hour answers `too_many_lookups`, and a Redis outage lets the send through (CTO 8); the console never
    returns an avatar (CTO 10).
- **Security** (the brief's core):
  - **Outsider**: every new function refused to `anon` and `PUBLIC` (`open_platform_ticket`, `staff_escalate_ticket`,
    `console_*`, `admin_*`); `ticket` still closed.
  - **Cross-tenant and the platform admin**: seeded with organizers A and B, each with open, closed, escalated and
    returned tickets, plus app problems: **a platform admin's `console_tickets` and `console_ticket` return no
    `queue = 'event'` ticket of any organizer, by list, by count, by any id (each non-routed id HT404, the same answer as
    a missing id), and none after send back**; the request admin flag on with `platform_role = 'none'` (or a
    suspended admin) opens no console function (`app_admin_id` NULL); a member of organizer A who is also an admin reads
    B's escalated tickets only through the console, never through `event_tickets` (AN404); an editor of A cannot
    escalate or read B's tickets; an operator of event A never sees A's reports or escalated tickets nor anything of
    B; a player never reads another's ticket or report, and the reported player gets nothing.
  - `routes.int.test.ts`: the console routes are `admin`, 404 for a staff member, an owner, a player and `anon`;
    every new route classified.
- **Route/unit**: each route's answers and refusals, bodies scanned for any email, name or admin field on player and
  team reads, the error maps, cursors, Retry-After, the console's `no-store` and rate limit, the log redaction.
- **App**: the ticket center (four cards, the event picker and the no-event state, report form and its refusals, the
  device facts line, a missing `expo-device` module), Your requests (signatures, With the Questify team, the profile
  dot), staff mode (prize badge, moved), RTL and Arabic; `expo export`.
- **Web**: Help desk page (tabs, escalate with note, returned line), console Tickets (list, filters, detail, reply,
  solve, send back); e2e `help-desk.spec.ts` grown and `console-tickets.spec.ts` new (desktop and phone): an escalated
  ticket reaches the console, the admin answers, the dashboard shows "Answered by the Questify team"; a never-escalated
  ticket's id typed into the console URL shows Not found.
- **On a device** (not a CI gate): an app problem from an iPhone build with `expo-device` shows the model in the console.
- **Mutation (GitHub)**: `apps/api/src/tickets/**`, plus `apps/api/src/activation/routes.ts` (the console hook) only if
  the build touches it.

## Phases (CTO code review once, at the end)

1. Migration 0061 + database, crossed-lock and security tests (outsider, cross-tenant, the platform-admin suite).
2. API: `src/tickets` (player, team, console routes; the console's `registerConsoleTicketRoutes` under the existing hook),
   `GET /v1/me`'s `help`, shared types (`packages/shared/src/tickets/`).
3. App (ticket center, report form, device facts with `expo-device` loaded lazily, Your requests, staff badges),
   dashboard (tabs, escalate), console Tickets, strings; docs (API.md, DATA_MODEL.md, SECURITY.md, SRS FR-1822 /
   FR-1823 / FR-1824 partly, FEATURES F-324 to F-326, rules.md lock line, STORE_COMPLIANCE, TECH_STACK dependency line,
   TASKS notes on T-312b, T-501, T-616, T-701, T-705, STATE).

## Proposed decisions and questions

- **ADR-255** T-312's split: notification history to T-312b (depends on T-501; a screen on T-501's center, no second
  store).
- **ADR-256** Types and routing: four cards, six stored kinds (`question`, `problem`, `prize` and `report_player` to the
  event team; `app_problem` and `suggestion` to Questify, never with an event); routing fixed by the kind in CHECKs;
  reports to owners and editors only; Q-209 answered as recommended.
- **ADR-257** Who sees a ticket (replaces ADR-247's table): a platform admin reads exactly `queue = 'questify'`;
  the team reads its escalated tickets read-only; the player sees which team answered, never a person or a note; the
  privacy line names Questify; every console read is audited, a list with the ids shown per event. Answers Q-211.
- **ADR-258** Escalation: owners and editors only, a note required, the ticket moves whole to the Questify queue;
  Questify answers, solves or sends back (with a note), answers whatever the event's state, never sends back an app
  problem; every hop audited with the event's ids; "take over" = Questify's own answer.
- **ADR-259** Sending outside an event: `open_platform_ticket` under a per-player advisory lock and the player row
  `FOR KEY SHARE` (no send outlives an erasure), 3 open and 5 a day in
  the Questify queue; one open report per reporter and reported; device facts with `expo-device` (new dependency,
  loaded lazily, never the device's name).
- **Q-218** FR-1823's "take over any ticket": read as "answer any ticket in Questify's queue", never a ticket that was
  not escalated (that would make Questify a reader of every event's tickets). Agree, or should Questify see every
  ticket?
- **Q-219** FR-1411 sends a report to the event team **and** Questify's moderation queue; FR-1822 says a Report a
  player ticket reaches the event team and not the Questify queue. Built: the event team only; T-705's moderation queue
  (reports of content and usernames) is where Questify sees reports. Agree?
- **Q-220** Retention of tickets with no event (app problems, suggestions): 90 days after closing; an open one waits in
  the console, never purged by age (CTO 5). Agree, or keep app problems longer for bug history (without the text)?
- **Q-221** Counsel: escalation shows a player's text to Questify, which the T-310 line "Only you and the event team"
  did not say. The new line says it before sending; does the privacy policy need more (with Q-075, Q-210)?
- **Q-222** Operators cannot escalate (only owners and editors). Agree, or let operators with `help_desk` escalate too?
