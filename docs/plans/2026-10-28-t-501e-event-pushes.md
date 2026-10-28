# T-501e: the owed event pushes (plan note)

Core bar. Builds rows 7 to 12 of "Owed pushes" in `docs/plans/2026-10-28-t-501-push.md` on the T-501 store (ADR-342 to
ADR-353, Accepted; T-501d took rows 1 to 6). Delivers FR-1102 (flash quests, boosts, a category opening, community
milestones, the event starting soon) and FR-246's push. Migration **0078** (new file, undeployed; CranL runs through
0056). Where this note fills in what the plan left open: **ADR-354 / Q-324 (Proposed)**. Row 17 (the hidden-category hint,
FR-238) stays T-501g's. Never push, deploy or run Stryker locally.

## Rules kept from the plan and T-501d

- A producer calls only `notice_create` (one insert; an unknown kind inserts nothing and raises nothing), after every
  lock its door takes, so a broken kind never rolls a door back. No `EXCEPTION` block anywhere.
- Single-row doors (launch, send poll, a boost that starts at once) use a row trigger with a `WHEN`; the community tick's
  reach is one statement over several steps, so a statement trigger with a transition table; moments in time are due
  scans in `push_due()` (restated), each a bounded set-based statement of at most 500 notices with its marker filtered
  out first (`NOT EXISTS` on `dedupe`). Trigger functions are definers closed to PUBLIC; the scans are internal.
- Event notices: active members only (§ Review 1), rehearsal accounts only while the event is draft or scheduled,
  nothing for an archived event; what a notice names is checked at fan-out and again at the claim (§ Review 7:
  `sees_category`, `member_sees_quest`), and each kind's own audience in `notice_audience_ok` (restated).
- Text: the fixed template; names frozen on the notice by `push_names` (cut to 40), cut and filtered again by the T-501
  name rule at render; `refs` ids only. Never an answer, an amount, points or a person.

## The kinds (event class, priority 1; `NOTIFICATION_TARGETS` already lists each)

| Kind | Producer | Once-only marker | Recipients (beyond the status rule) | Topic, TTL, `until` | Route |
|---|---|---|---|---|---|
| `flash_quest` | row trigger on `quest` (`flash_launched_at` set, Launch); due scan at `opens_at` for a scheduled one (visible, not launched, shown, not community-locked) | `flash:{quest}:{opens_at µs}` | `member_sees_quest` (visible, window open, category seen, flash switch on) | announcements, 24 h, until `closes_at` | quests, the quest's sheet |
| `boost_start` | row trigger on `boost` insert or a new `starts_at` when it starts at once; due scan at `starts_at` | `boost:{id}` | `sees_category`; a rehearsal boost to rehearsal accounts, a real one to real members; still running and the event's switch on | announcements, 24 h, until `ends_at` | quests |
| `poll_sent` | row trigger on `quest` (`poll_sent_at` set, Send) | `poll:{quest}:{poll_sent_at µs}` | `member_sees_quest`; not yet voted (no completion); the event's polls shown | announcements, 24 h, until `closes_at` | event (the poll card) |
| `community_step` | statement trigger on `community_reach` inserts: one notice per goal per statement, for the highest step it reached | `community_step:{step}` | the event's community switch on (the card's own rule: every member, no quest named) | community, 2 h | event (the community bar) |
| `category_open` | due scan at `category.opens_at` (after the event's start, live, a visible quest in it, not community-locked) | `category_open:{category}:{opens_at µs}` | `sees_category`; open now; its "unlocks after" category cleared by the member | announcements, 2 h, until `opens_at + 2 h` | quests |
| `event_soon` | due scan at `starts_at − 1 h` for a scheduled event | `event_soon:{event}:{starts_at µs}` | `before_start`: real members of a scheduled event; the start still the one named | reminders, 1 h, until `starts_at` | event |

Every kind also skips a member the owner made an operator who may not play (`staff_assignment.can_play` false): each of
the six is about playing. `community_step`'s route moves from the quests tab to Event Home, where the community bar is.

### Texts (title: the event's name when it passes the name rule, else "Questify"; ux-araby pass, gender-neutral)

| Kind | English | Arabic |
|---|---|---|
| `flash_quest` | Flash {questOne}: “{quest}” | {questOne} بوقت محدود: «{quest}» |
| … nameless | A flash {questOne} is on now. | {questOne} بوقت محدود الآن. |
| `boost_start` | Double points now in “{category}”. | نقاط مضاعفة الآن في «{category}». |
| … nameless | Double points now. | نقاط مضاعفة الآن. |
| `poll_sent` | New live poll: “{quest}” | تصويت مباشر جديد: «{quest}» |
| … nameless | A new live poll has started. | بدأ تصويت مباشر جديد. |
| `community_step` | The community reached a new milestone. | تحقّقت مرحلة جديدة في الهدف الجماعي. |
| `category_open` | “{category}” is open now. | يمكنك الآن اللعب في «{category}». |
| … nameless | New {questMany} are open now. | {questMany} جديدة متاحة الآن. |
| `event_soon` | The event starts at {time}. | تبدأ الفعالية الساعة {time}. |

No adjective or verb agrees with an organizer's word (`{questOne}` may be masculine or feminine); `{questMany}` is a
non-human plural, so «جديدة متاحة» always agrees. The community push names no quest: a goal's title is not on the
name allowlist and a points goal counts no quest; the community card already shows every member the goal. `{time}` is
the event's zone (the claim returns `event.timezone`).

## Re-checks at sending (the claim's `push_skip_reason`)

A flash quest ended early (End now) or moved, a poll closed or voted, a boost stopped, a category moved later, an event
whose start moved: `member_sees_quest` and `notice_audience_ok` fail, so the queued push is `skipped` (`not_visible`,
`not_member`); a moved start or opening gets a new marker and its own push at the new moment.

## The status rule, refined (ADR-354 (1))

`notice_status_ok` (0076) is restated: a live or ended event's notices reach real members only. A rehearsal account
left between go-live and the wipe gets nothing (as `polls_shown` and `boost_in_force` already treat it).

## Fan-out cost at 50,000 members

One event push: 50,000 center rows, about 60,000 sends, 25 fan-out calls of 2,000 enrollments. The per-member checks
add `member_sees_quest` (one quest probe), a `staff_assignment` probe and, for a poll, a completion probe. Measured by
hand with `test/perf/push-event-timing.int` (a sent poll to 50,000 members); the gates stay T-501's (each call under
1 s, the whole under 30 s on the laptop). A rehearsal on a large event costs the same scan over its enrollments.

## Tests (named; `test/db/push-events.int.test.ts` unless noted)

- Per kind: fires once and only once (a replayed launch or send, a re-run of the scan, a second settle), to the right
  members and no one else: left, banned, pending, an operator who may not play, erased, a rehearsal account on a live
  event, a member who cannot see the hidden category or quest, a member who voted; the center row after the fan-out.
- **"A broken kind cannot roll back the door"**: with its `notice_kind` row missing, Launch, Save boost, Send poll, the
  community settle, activation and the due scan all commit, and no notice is written.
- The markers survive a retry and a re-run of the scan; a rehearsal send and the live send are two notices.
- Scheduled starts: a scheduled flash quest opens → one push; moved later before the claim → skipped; the event soon
  push names 20:00 for a Riyadh event starting at 17:00 UTC and 18:00 for a London one in summer time; a moved start
  is skipped at the claim and the new start gets its own.
- The text is the fixed template and the payload ids only (`pushMessageOf` over the claimed rows).
- `push-store.int`: live and ended reach no rehearsal account; every `notice_kind` row has a template and a route.
- Security: outsider (the new trigger functions and helpers: no PUBLIC, no grant, definers), cross-tenant (`push_due`
  refuses every seat), the rehearsal guard (the scans read the status and write only notices).
- Unit: templates and routes (shared), the worker's due step unchanged.

## Mutation globs (GitHub, core)

`packages/shared/src/push/templates.ts`, `packages/shared/src/push/routes.ts` (SQL is covered by the DB suites).
