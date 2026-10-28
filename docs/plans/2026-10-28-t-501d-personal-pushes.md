# T-501d: the owed personal pushes (plan note)

Core bar. Builds rows 1 to 6 of "Owed pushes" in `docs/plans/2026-10-28-t-501-push.md` on the T-501 store (ADR-342 to
ADR-352, Accepted). Delivers FR-1101 (decisions, answers, reservations), FR-1718 (the prize at the reveal) and FR-1819
(the join decision). Migration **0077** (new file, undeployed; CranL runs through 0056). Where this note fills in what
the plan left open: **ADR-353 / Q-322 (Proposed)**. Never push, deploy or run Stryker locally.

## Rules kept from the plan (§ Review 2)

- A producer calls only `notice_create` (one insert, nothing else; an unknown kind inserts nothing and raises nothing).
  No producer reads a device, a mute or consent, or writes a center row or a send; the worker fans out about a second
  later.
- A door that changes many rows in one statement gets a statement-level trigger with transition tables; `enrollment`
  keeps the row-level `WHEN` trigger (accept-all of up to 5,000 pendings); single-row doors use a row-level trigger
  with a `WHEN` (one firing per decision). Moments in time are **due scans** in the push worker. No `EXCEPTION` block
  in any producer; a set-based producer is one statement that calls `notice_create` per row (`PERFORM notice_create(...)
  FROM ...`), so `notice_create` stays the only writer of a notice.
- Every trigger function is `SECURITY DEFINER` (the API's role holds `UPDATE (status)` on `enrollment`: a non-definer
  trigger would fail its insert and roll the door back), closed to PUBLIC, never granted. The notice is the last write
  of each door (docs/rules.md, the push store's lock order); it locks nothing but the foreign keys' `KEY SHARE`.
- Text is the fixed template; names come from the notice's frozen `params` (cut to 40 in SQL by `push_names`); `refs`
  hold ids only. Never a ticket's text or reply, a review reason, an amount, points or a person.

## The kinds (migration 0077 seeds the rows; `messages.ts` the texts; `NOTIFICATION_TARGETS` already has the routes)

All personal (priority 0), no topic (decisions, answers and prizes cannot be muted in the app, ADR-347 (4)).

| Kind | Membership, TTL | Producer | Once-only marker (`dedupe`) | Route |
|---|---|---|---|---|
| `join_accepted` | decided, 24 h | row trigger on `enrollment` (below) | `join:{enrollment}:{status}:{transaction time in µs}` | event |
| `join_declined` | decided, 24 h | the same trigger | the same | center |
| `help_answered` | none, 7 d | row trigger on `ticket`, `open → closed`, `answered`, the event team | `ticket:{id}` | requests |
| `help_answered_questify` (new) | none, 7 d | the same, `answered` by a Questify admin | `ticket:{id}` | requests |
| `help_solved` (new) | none, 7 d | the same, outcome `solved` (either team) | `ticket:{id}` | requests |
| `rank_prize` | active, 7 d, until `claim_until` | statement trigger on `event_result` (`revealed_at` set) | `rank_prize:{event}:{rank}` (the place) | rewards |
| `submission_approved` | active, 24 h | row trigger on `submission`, `pending → approved` by a reviewer | `submission:{id}:{status}` | quests (the quest's sheet) |
| `submission_rejected` | active, 24 h | the same, `pending → rejected` by a reviewer | the same | quests |
| `reward_ready` | active, 2 h, until `reserved_until` | due scan (below) | `reward_ready:{redemption}` | rewards |
| `reward_ending` | active, 1 h, until `reserved_until` | due scan (below) | `reward_ending:{redemption}` | rewards |

The help-desk answer is **three kinds** with one route: a template is per kind, and the plan's note asks for three
fixed texts by team and outcome. `help_answered_questify` and `help_solved` join `NOTIFICATION_TARGETS` (→ `requests`).

### Texts (title: the event's name when it passes the name rule, else "Questify"; ux-araby pass, gender-neutral)

| Kind | English | Arabic |
|---|---|---|
| `join_accepted` | Your request to join was accepted. You can play now. | قُبل طلب انضمامك، ويمكنك اللعب الآن. |
| `join_declined` | Your request to join wasn't accepted. | لم يُقبل طلب انضمامك. |
| `help_answered` | The event team answered you. | ردّ عليك فريق الفعالية. |
| `help_answered_questify` | The Questify team answered you. | ردّ عليك فريق Questify. |
| `help_solved` | Your request was marked solved. | حُلّ طلبك. |
| `rank_prize` | You won a prize: {reward}. Collect it at the prize desk by {date}, {time}. | فزت بجائزة: {reward}. يمكنك استلامها من مكتب الجوائز حتى {date}، الساعة {time}. |
| … nameless | You won a prize. Collect it at the prize desk by {date}, {time}. | فزت بجائزة. يمكنك استلامها من مكتب الجوائز حتى {date}، الساعة {time}. |
| `submission_approved` | Your answer to “{quest}” was approved. | قُبلت إجابتك في «{quest}». |
| … nameless | Your answer was approved. | قُبلت إجابتك. |
| `submission_rejected` | Your answer to “{quest}” wasn't accepted. You can open it to see why. | لم تُقبل إجابتك في «{quest}». يمكنك فتحها لمعرفة السبب. |
| … nameless | Your answer wasn't accepted. You can open it to see why. | لم تُقبل إجابتك. يمكنك فتحها لمعرفة السبب. |
| `reward_ready` | Your reward “{reward}” is ready at the prize desk. | جائزتك «{reward}» جاهزة للاستلام من مكتب الجوائز. |
| … nameless | Your reward is ready at the prize desk. | جائزتك جاهزة للاستلام من مكتب الجوائز. |
| `reward_ending` | Your reward “{reward}” is held for you until {time}. | جائزتك «{reward}» محجوزة لك حتى الساعة {time}. |
| … nameless | Your reward is held for you until {time}. | جائزتك محجوزة لك حتى الساعة {time}. |

A text with no name uses itself as its nameless variant. «حُلّ طلبك» and «قُبل» are light passives (never `تم` +
masdar); "answer" (إجابتك) is the app's word for a submission. The prize names the deadline's date **and time** (a
deadline can fall on the reveal's own day: "by 29 Oct" alone hides it).

## Producers

1. **Join decision.** `AFTER UPDATE OF status ON enrollment FOR EACH ROW WHEN (OLD.status IN ('pending', 'declined')
   AND NEW.status IN ('active', 'declined') AND NEW.status <> OLD.status AND coalesce(NEW.joined_via, '') NOT IN
   ('operator', 'rehearsal') AND app_player_id() IS DISTINCT FROM NEW.player_id)`. Covers `decide_join_request`,
   `accept_all_join_requests` and a waiting-list release (an acceptance of a waitlisted request). The last condition
   is new (ADR-353 (1)): the player's own re-join (`join_write`: a declined or pending request turned active by an
   invitation) is not a decision and is answered on screen. One insert per firing.
2. **Help-desk answer.** `AFTER UPDATE OF status ON ticket FOR EACH ROW WHEN (OLD.status = 'open' AND NEW.status =
   'closed')`: `answer_core` (team and operator) and `admin_answer_ticket`. An escalation or a send-back changes only
   the queue, so it gives none. Erasure deletes the tickets (no update), so an erased account never gets one; the
   fan-out's active-player check stops a banned or deleted one. A left member still gets the answer to their own
   request (`none`).
3. **Rank prize.** `AFTER UPDATE ON event_result REFERENCING OLD TABLE AS before_rows NEW TABLE AS after_rows FOR EACH
   STATEMENT`: for each event whose `revealed_at` went from NULL to set, one statement over its `result_place` rows with
   a `redemption_id` whose enrollment is `active` and player `active` (never a winner who left, was removed or banned);
   `until = claim_until`; `reward` = the rank prize's name; `date` and `time` = `claim_until`. A replayed reveal changes
   nothing. Results need an ended event, so no rehearsal account is ever placed (rehearsal guard, T-214).
4. **Submission decision.** `AFTER UPDATE OF status ON submission FOR EACH ROW WHEN (OLD.status = 'pending' AND
   NEW.status IN ('approved', 'rejected') AND (NEW.reviewed_by_staff IS NOT NULL OR NEW.reviewed_by_operator IS NOT
   NULL))`: a reviewer's decision only; an auto-approval (the player is on the screen) and the system's rejection when a
   member leaves give none. `refs {quest, submission}`; the quest's name, never the reason or the points. A decision on a
   closed quest still reaches its player (plan § Review 7: `sees_category` only).
5. **Reservations: one due-scan door, `push_due()`**, system only, called by the worker **every 60 s** (switch on or
   off, like the fan-out; the center keeps every message). Two set-based statements of at most 500 notices each,
   driven by `redemption_due` (`status = 'reserved'`), for an `active` member and player, never a rehearsal account
   (its reservations ignore the desk's hours), never an archived event, never while the player is collecting or was
   offered at the desk (`collect_until`, `offer_until`):
   - **Ready (ADR-353 (2)):** the event's desk has hours, is open now, and the window open now began after the
     reservation was made: once per reservation (the first opening it waits for), until `reserved_until`. An event
     without desk hours has its desk open all along: nothing to announce.
   - **Ending (ADR-353 (3)):** due 15 minutes before `reserved_until`, for a hold longer than 30 minutes counted from
     when it became collectable (`greatest(created_at, the last desk opening at or before reserved_until)`), and only
     when the desk is open at some moment before `reserved_until` (no "held until" while it cannot be collected).
     Names the time (the event's zone), never a countdown.
   Re-running the scan writes nothing new (the marker); an unknown kind writes nothing and raises nothing.

## Tests (named; `test/db/push-producers.int.test.ts` unless noted)

- Per kind: fires once and only once, to the right recipient and no one else; the center row after the fan-out; a retry
  of the door (same key) or a re-run of the scan adds nothing.
- Join: accept, decline, **"declined → active gives one accepted notice"**, accept-all, a waiting-list release; **"made
  an operator (pending → active, operator) gives none"**, a rehearsal account none, the player's own invited re-join
  none; accepted then left before the fan-out: no center row; erased: none.
- Ticket: team answer, operator answer, solved, Questify answer, Questify solved; escalation and send-back none; a
  replayed answer none; a left member still gets it; erased and banned get none; the text and reply never in the notice.
- Rank prize: one per prize place, none for a place without a prize, a winner who left or was removed; the replayed
  reveal none; the deadline frozen.
- Submission: staff approve, operator reject; auto-approval none; leaving (the system's rejection) none; removal none.
- Reservations: ready at the opening for a reservation made before it, none when made inside the window, the desk
  closed, no hours, a rehearsal account, a member who left; ending at `reserved_until − 15 min`, none for a short hold,
  while collecting, with the desk closed until the end; the scan system only (PN403).
- **"A broken kind cannot roll back the door"**: with its `notice_kind` row missing, decide, accept-all, the ticket
  answer, the reveal, the review and the scan all commit, and no notice is written.
- **The text is the fixed template, ids only in the payload:** each kind claimed and built with `pushMessageOf`; the
  body equals the template; `data.r` holds ids only; no reply, reason or ticket text anywhere in the notice.
- **Every `notice_kind` row has a template and a route** (`push-store.int`, now with `NOTIFICATION_TARGETS`).
- Timing (by hand, `test/perf/push-producers-timing.int.test.ts`): accept-all of 5,000 pendings with the trigger under
  5 s, measured and recorded in ADR-353; the default suite proves 300 notices from one accept-all.
- Security: outsider (the door, its helpers and the trigger functions: no PUBLIC, exact grants, definers), cross-tenant
  (`push_due` refuses every seat with an identity), the rehearsal guards (no new foreign key; no new writer judging the
  status), unit tests for the worker's scan step and the shared templates and routes.

## Mutation globs (GitHub, core)

`apps/api/src/push/worker.ts`, `apps/api/src/push/doors.ts`, `packages/shared/src/push/templates.ts`,
`packages/shared/src/push/routes.ts` (already under `stryker.config.json`'s push globs).
