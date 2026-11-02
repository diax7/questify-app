# T-617 - Operator activity and the staff briefing (plan note, tier B)

Delivers FR-1844 (F-346). Decisions: ADR-402 and Q-369 (Proposed). Migration 0111. No change to points, sign-in or tenant
isolation: the activity is one read-only door over rows other doors already write, and the briefing is one personal notice per
current operator through `notice_create`, so the push worker, the fan-out, the center and the claim are T-501's.

## What it builds

On the Operators page (`…/events/{id}/operators`, owner and editor within their event limit), above the invite form, shown only
for an event that has an operator:

- **Five equal tiles**: operators active in the last 30 minutes, scans in the last hour, scans today, awards today, hand-overs today.
- **By operator** (a card, ten rows then "View more"): `@username`, a "Quiet" badge from 30 minutes (or never), the last action and how
  long ago (browser plural rules, Western digits) with the time of day, the scans in the last hour and today, awards, hand-overs, reviews
  and replies when not zero, and the five stations scanned most today. Most recently active first.
- **Latest actions** (a card): five, then 25, then 50 with "View more"; the operator, what they did, the station, the time.
- **Message the operators** (a card): title and text in Arabic and English (60 and 140 characters, so the push and the center carry it
  whole), cleaned and checked like an announcement, a confirmation that says how many operators will be told and that players will not,
  and the last five messages sent with how many were told.
- The page reads again every 30 seconds while open.

## The two doors (migration 0111)

`operator_activity(event, recent)` (owner/editor, `award_event_of`, AN404): per operator the ledger's own entries by `operator_id` (quest and
session entries are scans, `award`, `handover`, `redeem_return` a cancel), submissions they reviewed and help requests they answered. "Today" is
the event's day, the same as the station counts. Usernames and counts only; no player an operator served.

`staff_briefing_send(event, draft, key, request)`: one personal notice (`staff_briefing`) per current staff assignment whose player is active,
once per Idempotency-Key, 3 an hour and 10 a day, PE409 for an ended or archived event (a briefing may go before the event starts), PT409 when
no operator can receive it. Audited `staff.briefing` with the count only. The new kind has membership `staff`: `notice_membership_ok` asks for
the staff assignment at the fan-out (center row) and again at the claim (push), so an operator removed in between gets neither. No topic: it
cannot be muted. Push text is the frozen title and text (free-text kind, with the announcements' renderer and name rule); the tap opens the
center row. Push transport is not configured on staging, so the center is where the operator reads it: the bell is now on the operator Home too.

## Indexes and measurement

`ledger_entry (event_id, operator_id, created_at DESC) INCLUDE (kind, quest_id) WHERE operator_id IS NOT NULL`, and one small partial index each
for operator-reviewed submissions and operator-answered tickets. Measured (`apps/api/test/perf/operator-activity-timing.int.test.ts`, by hand):
50,000-player event, 60 operators, 570,000 operator entries in all (about 270,000 today), 6,000 reviews, 2,000 answers, a 20-operator neighbour.

| | warm |
|---|---|
| With the three indexes, tables vacuumed (steady state) | 134 to 175 ms |
| With the three indexes, just bulk-loaded (visibility map not set) | 640 to 810 ms |
| Without them | 930 to 1,090 ms |

The ledger is read by an index-only scan (2,973 buffers for 270,000 entries). Nothing is cached; the page reads every 30 seconds.

## Personal data

Usernames (not full names, T-615's rule), counts, station names and the organizer's own briefing text. No player an operator served, no contact
detail. The briefing reaches operators only; no player gets a center row or a push.

## Tests

DB `test/db/operator-activity.int.test.ts` (29: counts, windows, event separation, ordering, limits, roles, one notice per operator, removed and
banned operators, fan-out and claim, key replay, rate limits, phases, audit, no text in the audit); HTTP `test/operators/activity.int.test.ts` (8);
outsider, cross-tenant, route-map, rehearsal-writer and event-duplicate guards; shared `operator-activity.test.ts`, templates and routes; web
`lib/operator-activity.test.ts`; browser `operator-activity.spec.ts` (Arabic and English, desktop and phone, the layout check on the filled page).
