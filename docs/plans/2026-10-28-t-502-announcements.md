# T-502: organizer announcements and the Home strips (plan note)

Tier B (ADR-355: no ledger, sign-in or tenant-boundary code; the doors are definers behind `award_event_of`). Delivers
FR-1107, FR-1108, FR-806 and FR-807 on the T-501 push store (row 18 of "Owed pushes", ADR-342 to ADR-357). Migration
**0081** (new file, undeployed; CranL runs through 0056). Where this note fills in what the plan left open:
**ADR-358 / Q-327 (Proposed)**. Never push, deploy or run Stryker locally.

## How it works

- **An announcement is a row and, once it goes out, a notice.** `announcement` (new table, deny by default) holds the
  organizer's text in both languages and its state: `scheduled`, `sent`, `cancelled` or `skipped`. Sending writes **one
  notice through `notice_create`** (kind `announcement`: event class, topic `announcements`, active members, 2 hours,
  not `before_start`; marker `announcement:{id}`; refs `{announcement: id}`; params the event's name and the frozen
  `title` and cut `body`, each `{ar, en}`). The fan-out, the center rows, the mutes (a muted `announcements` topic keeps
  the center row and loses the push), the claim's re-checks and the route (`NOTIFICATION_TARGETS`: the event's Home) are
  T-501's, unchanged.
- **Audience** is T-501's rule for an event kind: active enrollments of active players, not on the exclusion list; real
  members on a live (or, for a notice already sent, ended) event, rehearsal accounts before the start; an operator the
  owner keeps from playing is told too (an announcement is about the event, not about playing). The dashboard's count
  (`announcement_preview`) is one set-based statement over the same rules, held equal to the fan-out's recipients by a
  database test.
- **Doors** (definers, granted to the API role): `announcement_send(event, draft, at, press, request)`,
  `announcement_cancel(event, id, request)`, `announcement_list(event)`, `announcement_preview(event)` for owners and
  editors inside their event limit (`award_event_of`), and `member_announcements(event, size)` for the event's active
  members. Internal, no grant: `announcement_phase`, `announcement_crowded`, `push_due_announcement`; `push_due()` is
  restated with the new scan.
- **Send now** (`at` null): the event must be live, or a draft or scheduled one with an open rehearsal (then only the
  rehearsal accounts are told and the row is flagged `rehearsal`: the Home list shows it to them only); ended and
  archived events refuse (`409 announcement_event_closed`), a draft without a rehearsal refuses (`409
  announcement_event_not_live`), and a send that would tell no one refuses (`409 announcement_nobody`, after the replay
  check). **Schedule** (`at` set): 2 minutes to 180 days ahead, not before the event's start (before it only rehearsal
  accounts could be told) and before its end; an ended or archived event refuses.
- **At the time** the due scan (`push_due`, every minute) takes each due `scheduled` row `FOR UPDATE SKIP LOCKED` and
  re-checks the event: live sends (`notice_create`, status `sent`); ended or archived is `skipped` (`event_closed`); not
  yet live is `skipped` (`not_live`); more than 30 minutes overdue is `skipped` (`late`: the worker was down, a stale
  "lunch is ready" is not sent). A missing kind row writes nothing and the row waits for the next tick (then goes
  `late`). Cancel takes the same row `FOR UPDATE`, so a cancel and the scan cannot both win.
- **Once per Idempotency-Key:** `UNIQUE (event_id, press)` on the key's sha256; a replay answers the first result with
  `replayed`. A missing kind row on send-now writes nothing and answers `sent` false (`503 announcement_unavailable`).
- **The text is frozen:** the draft is stored whole and a trigger refuses any change to the text, the event or the key;
  only the state columns move. The notice copies the title and the cut body at the moment of sending.

## The send door's own rate limit (no push brake exists, ADR-065)

At most **3 announcements an hour and 10 a day per event**, counted over any rolling hour and day on their send time
(`scheduled` and `sent` rows; cancelled and skipped ones never went out), checked when one is created by looking at every
window that would hold the new send (`announcement_crowded`: the new moment and each existing send in the span before it
as window starts), under an advisory lock per event so two presses cannot both pass. Refused as `429
announcement_limit` naming the window (`hour` or `day`). Why these numbers: an event day has an opening, a meal, a
session change, a prize pickup and a closing, a peak hour rarely needs more than three, and ten a day is generous; the
worst a stolen editor session can do is 10 x 50,000 pushes a day to one tenant's own members, and the rule is one line
to change (`CONFIGURABILITY`: a code constant until T-703). The replay check comes first, so a retried key still
answers. No API bucket besides: the door is the limit.

## Text rules (organizer free text to up to 50,000 phones)

- Both languages are required for the title and the body: title 1 to 60 characters, body 1 to 500, counted in code
  points. The push and the center carry a **cut body**: the first 140 code points, then `...` when cut (single
  implementation in `packages/shared/src/announcements`; the database stores what the API sends and bounds it).
- **Cleaning** (one function, the dashboard preview and the API share it): format and default-ignorable characters
  (zero-width joiners, variation selectors, bidi marks) are removed, whitespace runs become one space, the ends are
  trimmed and Arabic-Indic digits become Western (ADR-018). Emoji that need a joiner lose it; a single-code-point emoji
  is untouched.
- **The T-409 name rule as a filter** (`textIssue`, the rule's body exported from `name-rule.ts`) runs on each cleaned
  field, so links (`://`, `@`, a dot between letters or digits of any script, which catches `example.́com`),
  phone numbers (nine digits in a row once punctuation is gone) and the control characters left after cleaning are
  refused `422 invalid_announcement {field, issue}`; the dashboard gives one message per issue. It is a filter, not a
  gate: the organizer is an authenticated, audited member of a paying tenant (`announcement.send` and `.cancel` audit
  lines name the staff user), which a spelled-out "example dot com" still passes.
- At render the push and the center run the same filter again on the frozen text; a failing text shows the generic
  line and is never pushed (a database row edited by hand cannot reach a phone).

## What the app shows

- **Home, "Happening now" (FR-806):** running flash quests and boosts, read from the quests read (`flash` on each quest,
  `boost` on each quest and category), not from `GET …/live` (whose list stops naming them 15 minutes after the start,
  `event_has_live`'s tail, left alone). Open categories need no strip (the quests tab), live polls and the community
  quest keep their cards, sessions come with T-505. The strip steps aside when nothing is running; a tap opens the quests
  tab.
- **Announcements (FR-807):** Home shows the latest three with "See all"; `/event/[eventId]/announcements` lists up to
  50, newest first, in the player's language (`GET /v1/events/{id}/announcements`). A tap on the push opens Home.

## What the dashboard shows

`…/events/{id}/announcements`: a form (title and text in both languages with counters, Send now or a time in the
event's zone), a preview of the push and the center text in both languages and of who gets it ("N players", or "your
rehearsal accounts" before the start), a confirmation, then the list: scheduled (with Cancel), sent (with a **rounded
delivered count**: exact below 10, else the nearest 10, from the center rows; "Sending" until the fan-out is done),
cancelled, skipped (with the reason). Only push and in-app are named: no email or SMS option exists, and the channel is
not a field of the API.

## Care points and where they are tested

| Care point | Test |
|---|---|
| Filter on all four fields, clean-up, cut lengths, limits in both languages | `packages/shared/src/announcements/announcements.test.ts`; `test/announcements/routes.int` (each issue answers 422 with field and issue) |
| Rate limit on the door; replay first; concurrent presses | `test/db/announcements.int`: 4th an hour, 11th a day, the exact window (a later send that would crowd an earlier one), cancelled ones not counted, two presses at once |
| One send per key | same suite: replay answers `replayed`, one notice; same key from another event is a new send |
| Scheduled: cancel; re-check; late; ended/archived/not live | same suite plus the due scan on a fixed clock moved by editing `send_at` |
| Text frozen | the trigger refuses an update of any text column, even as the owner |
| Roles | owner and editor send; an editor outside the event limit, another organizer's owner, a player, the public key: AN404 or permission denied (db suite, outsider and cross-tenant suites) |
| Audience equals the count | a crowd (real, left, banned, pending, rehearsal, operator, barred, erased, excluded by phone): count = fan-out recipients, rehearsal-only before the start |
| Muted topic | center row, no send; unmuted: a send; both read `announcements` from the kind |
| No email or SMS | source scan of `src/announcements`; a table-by-table row-count diff of a send plus fan-out plus claim (only `announcement`, `audit_log`, `notice`, `notification`, `push_send` change); the functions' source names no sender; the dashboard offers no channel |
| Cost at 50,000 | `test/perf/push-announcement-timing.int` (by hand): count, press and fan-out calls against the 1 s call and 5 s statement gates |
| Deny by default | outsider suite (every new function closed to PUBLIC; the exact grant list; no table rights on `announcement`); cross-tenant (another organizer's event: AN404; a player reads only their event's list) |
| Route inventory and rehearsal guards | `test/security/routes.int` entries; `rehearsal.int` allow list gains the three volatile functions that judge the status and write only announcements and notices |
| Every kind row has a template and a route | `push-store.int` (existing) with `FREE_TEXT_KINDS` and `NOTIFICATION_TARGETS` |

## Mutation globs

None required (ADR-355). Optional: `packages/shared/src/announcements/**/*.ts`, `packages/shared/src/push/templates.ts`.

## Recovery/build evidence (2026-10-29)

Resumed the crashed worker's uncommitted 0081/shared/DB work at fe688ddc4a7b8992a1d50b12aba10de373b207a4 in the real
NAFES/Questify App repository. Added the five HTTP routes, scoped replay reauthorization, dashboard and native Home/list
surfaces, HTTP/app/web tests, live-catalog security inventories and 50,000-member timing. ADR-358/Q-327 remain Proposed;
no independent review/self-approval, deployment, EAS, mutation, next task or push performed.
The rehearsal guard requires two new volatile writer entries, not three: announcement_phase is STABLE. Timing with
an exclusion row/devices: count 732 ms, send door 337 ms, fan-out 19.235 s over 52 calls, slowest 430 ms (1 s/5 s gates
pass). Targeted new browser flow passes desktop and phone. Native iOS+Android export passes; default Expo web export
fails on the existing absent react-native-web, intentionally not installed for this native-only task.
Final full-suite/check totals are recorded in STATE after completion; independent tier B review follows the commit.

### Final local gates

Full Vitest was run exactly once: 8759 pass / 13 skip / three guard failures (message-key naming, event-term translator
scope and the free-text-kind catalog inventory), all fixed. Final targeted regression: 18 suites / 804 pass, including
the failing guards and all relevant DB/HTTP/security/units. Fresh final web build and clean full browser: 197 pass /
1 existing skip. Earlier unrelated location and Chromium phone failures each pass the isolated five-test recheck and
the final full run; no unrelated source changed. Native iOS+Android exports, API build, all types, lint, limits, format,
audit (existing ignored advisories) and 50,000-member perf gates pass. See STATE for logs, review/release gates and cost.
The author has not performed the independent code review or accepted Proposed ADR-358/Q-327. No push/deployment.
