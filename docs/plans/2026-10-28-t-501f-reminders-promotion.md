# T-501f: reminders and promotion by push (plan note)

Core bar. Builds rows 13 to 16 of "Owed pushes" in `docs/plans/2026-10-28-t-501-push.md` on the T-501 store (ADR-342 to
ADR-354; T-501d and T-501e built rows 1 to 12). Delivers FR-1102 (the streak reminder), FR-1111 (push as a promotional
channel for invitations) and FR-1114 on push (the opt-out on the promotional center row). Migration **0079** (new file,
undeployed; CranL runs through 0056). Where this note fills in what the plan left open: **ADR-356 / Q-325 (Accepted, developer, delegated by Dhia, 2026-10-28)**.
Row 17 (the hint) stays T-501g's. Never push, deploy or run Stryker locally.

## Rules kept from the plan, T-501d and T-501e

- A producer calls only `notice_create` (one insert; an unknown kind inserts nothing and raises nothing), so a broken kind
  never undoes its door. Moments in time are due scans in `push_due()` (restated), each one bounded set-based statement of
  at most 500 notices with its marker filtered out first. No `EXCEPTION` block. Every new function is closed to PUBLIC in
  the group that creates it; only the invitation hand-off door is granted (system seat, like the claim).
- What a notice may name and who it reaches are checked at fan-out and again at the claim; the claim now asks each kind's
  own audience rule (`notice_audience_ok`) for every notice, not only event ones (below).
- Text: fixed templates, names frozen on the notice (`push_names`), cut and filtered again at render; ids only in `refs`.
  ADR-300 for the streak: no countdown, no loss or guilt copy, never a number, the streak is the player's own.

## The kinds (`NOTIFICATION_TARGETS` already lists each)

| Kind | Class, topic, membership, TTL | Producer | Marker | Who (re-checked at the claim) | Route |
|---|---|---|---|---|---|
| `streak_reminder` | personal, reminders, none, 6 h, until midnight Riyadh | due scan from 18:00 to midnight Riyadh while the daily streak switch is on | `streak:{player}:{Questify day}` | an active player with Questify streak days yesterday and the day before and none today, a pushable device and `reminders` not muted; at the claim: still nothing played today | Questify Home |
| `shop_closing` | event, reminders, active, 24 h, until the close | due scan: the event ended, `shop_state` open, the shop switch on (event and platform), the close within 24 hours (a 0-day window never qualifies) | `shop_closing:{event}` (once per event) | real active members with a balance above 0, not an operator kept from playing; at fan-out and the claim the close must still be the frozen date (an extended window: skipped, no second push) | Rewards |
| `invitation` | promo, none, none, 7 d, until the event's end | the invitation hand-off door `invitation_push_hand()` (the invitation tick, before the SMS rounds) | `invitation:{recipient}` and the recipient row | consent on push now (`promo_pool('push')`) at the hand-off, the fan-out and the claim; no enrollment in the event; no center row without consent | the center row (with the opt-out and "See the event") |

The daily games reminder is folded into the streak reminder (one daily reminder at most); "playing" covers a quest, the
daily challenge and the daily word, all of which count for the Questify streak.

### Texts (title: the event's name when it passes the name rule, else "Questify"; ux-araby pass, gender-neutral)

| Kind | English | Arabic |
|---|---|---|
| `streak_reminder` | You can keep your daily streak going by playing today. | يمكنك مواصلة سلسلتك اليومية باللعب اليوم. |
| `shop_closing` | The {event} rewards shop is open until {date}. | متجر جوائز {event} مفتوح حتى {date}. |
| … nameless | The rewards shop is open until {date}. | متجر الجوائز مفتوح حتى {date}. |
| `invitation` | You have an invitation to {event}. | لديك دعوة إلى {event}. |
| … nameless | You have an invitation to an event. | لديك دعوة إلى فعالية. |

Never an amount, a balance, a streak length, the daily word or an answer. `{date}` is the event's zone.

## Push as an invitation channel (T-409, ADR-331)

- `invitation_campaign.channels` takes `{push, sms}` (CHECK widened; `invitation_approve` restated). The admin picks the
  channels; push is offered only when both push providers (APNs and FCM) are set up on the server, SMS when the promotional sender is.
- **One message per player per campaign, never both:** the fill (`invitation_candidates` restated with a `channel`
  column, `invitation_start_due` restated) gives each chosen player one row: push when the campaign has push and the
  player is opted in on push with a pushable device (`push_live_devices`), else SMS when the campaign has SMS and the
  player is opted in on SMS. The row's channel is fixed at the fill; nothing falls back to the other channel. The
  estimate before approval counts both channels.
- **The hand-off** (`invitation_push_hand`, system seat, switch on, the claim's campaign locks): up to 500 queued push rows
  of running campaigns; each is checked again (consent on push, no enrollment: `opted_out`, `member`), then one notice
  through `notice_create` naming the campaign's frozen names and the event's join code, and the row becomes `sent` (the
  message is handed to the push store; the fan-out and the claim check consent again). A row whose notice could not be
  written (a broken kind) becomes `failed` (`no_kind`) and the door still commits. At most once: the row leaves `queued`
  in the transaction that writes its notice, and the marker refuses a second notice.
- **Quiet hours (Q-287):** SMS only. The approval moves the send time out of quiet hours only when SMS is among the
  channels; push rows are handed off at any hour.
- **The open:** opening the invitation's center row (a tap on the push or on the row marks that row read through
  `POST /v1/me/notifications/read` with its id) marks the recipient's `opened_at` once and counts `opened`, while the
  event runs and the results are open, like the landing page. "Mark all as read" counts no open.
- **The console** shows both channels, the push text in both languages beside the SMS text, and "Neither push nor SMS is
  set up" when neither can be sent.

## FR-1114: the screen a promotional tap opens (decided here)

The notification center (P16) opens on that row, highlighted (`/notifications?row=<id>`, T-501c), with its opt-out
("Stop offers in Settings" → Settings → Offers and notifications). An invitation row also carries **"See the event"**,
which opens the app's join screen by the event's join code (frozen on the notice; `via: link`). No separate detail
screen: the row is the whole message.

## Tests (named; `test/db/push-reminders.int.test.ts` unless noted)

- Streak: once per player and day to a player with a streak of 2 or more and nothing today; none for a streak of 1, a
  player who played today, a banned or erased player, no device, `reminders` muted, the switch off, before 18:00; a
  rehearsal play writes no streak day and so no reminder; a re-run writes nothing; played after the scan → skipped at the
  claim; the broken kind leaves the scan committing.
- Shop: one push the day before the close to real active members with a balance above 0; none to a zero balance, left,
  banned, pending, erased, a rehearsal account, an operator kept from playing; none for a 0-day window, the shop switch
  off, a closed or not-yet-due window; extended after the notice → skipped, no second push; once per event across
  re-runs; the broken kind.
- Invitation (`test/db/invitation-push.int.test.ts`): the fill's channel order (push with consent and a device, else
  SMS; push consent without a device → SMS; OS permission alone is no consent); never both channels; the hand-off writes
  one notice per row and the row is `sent`; re-runs and retries write nothing more; consent withdrawn before the
  hand-off → `opted_out`, between the hand-off and the fan-out → no center row, between the fan-out and the claim → the
  push is skipped (`consent`); joined meanwhile → `member`; the broken kind marks the row `failed` and commits; the
  read door marks `opened_at` once (a second read, another player's id, "mark all" count nothing); system seat only;
  the switch off hands nothing off; the CHECK refuses another channel.
- `push-store.int`: every `notice_kind` row has a template and a route (existing test covers the new rows).
- Security: outsider (no PUBLIC on any new function; only `invitation_push_hand` granted), cross-tenant (the hand-off and
  `push_due` refuse every seat), the route inventory unchanged, the rehearsal guard (the scans read the status).
- Unit: templates and routes (shared), the center item's join code, the console's approval body, the tick's hand-off.

## Mutation globs (GitHub, core; ADR-355: ledger and access code only)

None required: this slice touches no ledger or access code. Optional: `packages/shared/src/push/templates.ts`.
