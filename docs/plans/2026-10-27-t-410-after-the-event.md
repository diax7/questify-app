# T-410 — After the event: the shop window, closing the balance, keeping score and stamp, the recap card

Delivers FR-750, FR-751, FR-752, FR-1018 (and FR-1609's after-the-close half). Depends on T-201/T-202 (shop,
`shop_state`, `shop_days_after`), T-206 (desk), T-214 (results, `claim_until`), T-301 (FR-1710), T-402b/T-403
(souvenirs, `final_rank`, passport). Choices are **Proposed ADR-336 to ADR-339 / Q-305 to Q-308**. Never push, deploy,
run EAS or run mutation testing locally. CranL runs migrations through 0056; this is **0074** (new file).

**Bar: CORE** for T-410 (the window rule on the points balance, the shop's refusals, prize holds after the close): plan
review and code review, mutation on GitHub for the files below. T-410b is Standard.

## What already exists (read from the code, 2026-10-27)

- `event.shop_days_after` (0 to 30 whole days, default 3; migration 0024), set on the dashboard's Rewards page
  (`PUT …/events/{eventId}/shop` `daysAfter`, `RewardsPanel`), editable in any status but archived.
- `shop_state(status, starts_at, ends_at, days)` is the one rule: open while live and until `ends_at + days`, then
  closed; archived is closed. It reads the transaction's `now()`.
- `reserve_reward` refuses `RS403 closed`. Every earning door that runs after the end writes `balance_delta = 0` once
  the shop is closed (FR-1710: submission approval, quiz finish, category rules, quest items, meet, community payout,
  boosts, first bonus). Manual and bulk awards run only while live.
- A hold made before the close keeps its own `reserved_until` and is handed over at the desk (FR-1609); the tick's
  timeout returns points and unit (FR-1603). Digital codes are delivered at once and stay in My rewards (FR-511). Rank
  prizes are price-0 holds with the owner's `claim_until` (1 hour to 60 days).
- `event_shop` answers `state` and `closes_at`; the app reads `state` only. Home sends the balance as a number and a
  goal ("you have enough") whatever the shop's state.
- Score, `final_rank` (append-only), the passport stamp (`own_events`, `public_passport`), souvenirs and items
  (`player_item`), XP, level and achievements (append-only) have their own doors; nothing at the end of the event or of
  the window touches them.

## Gaps this task closes

1. **The window can be changed after the end, even after it closed:** raising `daysAfter` on a closed shop reopens it
   with the old balance; shortening it after the end cuts a date players were shown.
2. The player never sees the window: no "open until" date, a closed shop says only "The rewards shop is closed.", the
   balance still reads as a spendable number, the goal card can still say "you have enough".
3. The dashboard does not say when the shop closes.
4. No recap card.

Nothing is written when the window closes, and nothing needs to be (ADR-337).

## Split (recorded in TASKS)

| Task | Bar | What |
|---|---|---|
| **T-410** | **CORE** | Migration 0074 (the window guard, `event_recap`), the window rule in the API, the dashboard's shop read gains `state` and `closesAt`, Home's `shopWindow` and the closed goal, `GET /v1/events/{id}/recap`, tests. |
| **T-410b** | Standard (app + web) | Home's banner and closed balance, the Rewards tab after the close, the recap screen and its share, the dashboard's window field and closing line. |

Reason: the server rule is core and small; the screens, the share image and two new app dependencies need their own
context and a standard review.

## Decisions

### The window (ADR-336, Q-305)

1. **Where:** the dashboard's Rewards page, shop settings (exists): owner or editor in scope, 0 to 30 whole days,
   default 3 (exists). 0 closes the shop when the event ends.
2. **Exactly when it closes:** at `ends_at + make_interval(days => shop_days_after)` (`shop_state`, unchanged). A
   request whose transaction began before that moment is served as open; one that begins at or after it is refused.
   `end_event_early` sets `ends_at` to now, so the window starts then.
3. **Changes:** before the end (draft, scheduled, live) any value 0 to 30. After the end, while open: **only longer**
   (still at most 30 days after the end); shorter is `409 shop_window_locked {reason: "shorter"}` (players were shown
   the date). **Once closed: frozen**, `409 shop_window_locked {reason: "closed"}`, even to lengthen. Archived:
   `event_archived` (exists). Sending the current value is no change (as `spendLowersRank`).
4. **Enforced twice:** the API, with a pure rule in `apps/api/src/rewards/shop-window.ts` fed by `shop_state` and the
   status read in `updateShop` under the event lock it already takes (`lockBuilderEvent`, `FOR NO KEY UPDATE`); and the
   DB trigger `event_shop_window_guard`, judged on `clock_timestamp()`, so an edit whose transaction began a moment
   before the close cannot reopen it. When they disagree at the boundary the DB wins (`SW409` maps to the same 409).
5. **No reopening:** no door moves an ended event back to live (the API role never writes `status`;
   `event_times_guard` freezes an ended event's times). With the days frozen too, `shop_state`'s inputs never change
   after the close, so the close is permanent. Extending the window while it is open is the only way to move it.

### Closing the balance (ADR-337, Q-306)

1. **The close is a rule, not a write.** No ledger entry, no stored flag, no job. From the close moment the shop refuses
   (exists), every earning door adds to the score only (exists), Home drops the goal and sends the window's state, and
   the app shows the balance as closed. The ledger stays append-only; `enrollment.balance` still equals the sum of
   `balance_delta`.
2. **Why not a `balance_close` ledger entry that zeroes the balance:** (a) FR-1609's returns after the close (timeout,
   player or operator cancel) would put points back after it, needing another entry per return; (b) about 15 earning
   doors decide the balance on their transaction's `now()`, so an approval that began before the close and commits after
   a zeroing entry would leave points behind it: a race; (c) one row per member (10,000+) at one moment, and a new
   ledger kind every reader must learn (history, flags, XP, the souvenir trigger, removal); (d) nothing is lost by not
   writing it: the points record already explains every point and the closed balance is spendable nowhere (checked: only
   `reserve_reward` spends it; gems are a separate balance). **Why not a stored `balance_closed_at`:** it would cache a
   fact derived from inputs that are frozen, and could drift from `shop_state`.
3. **At the close:**
   - Digital codes never given stay unassigned in their reward and go to no one; the dashboard keeps the counts; they
     stay encrypted until event-data retention (Q-075). Delivered codes stay in the player's My rewards for good.
   - Shop holds not yet picked up: unchanged (FR-1609): handed over at the desk, within its hours, until their own
     `reserved_until`; the timeout returns the unit and the points into the closed balance (FR-1603). The player and an
     operator may still cancel (FR-513); the app warns that returned points cannot be redeemed (T-410b). With
     `spend_lowers_rank`, a return mirrors its spend on the score as before: the hold's own rule, not the close.
   - Rank prizes (price 0) and quest-item handovers: unchanged, each with its own deadline.
   - Desk holds (T-209) and paused redeeming: unchanged.
4. **Kept and untouched (FR-751):** score, final rank, passport stamp, souvenirs and items, XP, level, achievements.
   The close writes nothing; a test proves it across the boundary. **Erasure still wins:** `erase_rows` and its
   tombstones are unchanged (final ranks kept anonymous; items, XP and achievements deleted with the account). T-410
   stores no new personal data.
5. **No archiving here.** FR-1608 moves Ended → Archived when the window closes, but an archived event refuses the
   results' confirmation and reveal (`not_ended`), leaves the operators' assignment list (the desk could not hand over
   FR-1609 holds, or rank prizes whose deadline runs up to 60 days) and closes help-desk tickets. The event stays Ended
   after the close; archiving needs its own conditions (window closed, every hold ended, results revealed or a time
   limit passed) and its own task (Q-306). FR-1608 stays partly delivered.

### What the player and organizer see (ADR-338, Q-307); data from T-410, screens in T-410b

- **Home** gets `shopWindow: {state: "not_open" | "open" | "closed", closesAt}` (null when the shop switch is off),
  read from `event_shop` so a rehearsal account sees what the shop shows it.
  - Ended and open: «متجر الجوائز مفتوح حتى {date}» "The rewards shop is open until {date}": a date and time in the
    event's zone, never a countdown, no loss copy (ADR-300's rule).
  - Closed: the balance row reads «مغلق» "Closed" instead of a number, with «أُغلق متجر الجوائز في {date}» "The rewards
    shop closed on {date}"; no goal card (the server sends `goal: null`).
- **Rewards tab, closed:** the catalog gives way to «أُغلق المتجر في {date}. لم يعد رصيد هذه الفعالية قابلًا للاستبدال،
  وتبقى {currency} وترتيبك وختمك.» "The shop closed on {date}. This event's balance can no longer be redeemed; your
  {currency}, rank and stamp stay." My rewards stays (codes, holds with their pickup time, past items).
- **Cancel after the close:** the sheet adds «بعد إغلاق المتجر لا يمكن استبدال {currency} المستردة.» "After the shop
  closes, returned {currency} can't be redeemed."
- The points record is unchanged. The leftover number is not shown as a balance (every entry stays in the record).
- **Dashboard:** the shop settings show «يُغلق المتجر في {date}» "The shop closes on {date}" / «أُغلق المتجر في {date}»
  "The shop closed on {date}" in the event's zone; after the end the days field accepts only higher values, and it is
  read-only once closed, with each refusal's text.
- Copy above is a draft: ux-araby at the build; Western digits; RTL.

### The recap card (ADR-339, Q-308)

- **When:** once the event is Ended or Archived, for an active member who is not a rehearsal account. Home shows a
  "Your recap" card at the top that opens `/event/[eventId]/recap`.
- **Shows** (all of it already visible to the player): the event's name, local start date and city; the rank: the
  final rank once results are revealed (the passport's rule, ADR-276: `final_rank` and `revealed_at`), «يظهر ترتيبك
  النهائي مع إعلان النتائج» "Your final rank comes with the results" while pending, no rank line when unranked; quests
  done = distinct quests with a standing completion (`standing_credits` for this enrollment, the achievements' "quests"
  metric: a removed award does not count); the souvenirs earned at this event (`player_item`, source souvenir, this
  event), up to 3 on the card and "+N". No souvenir: that part is left out (FR-752's second case). Zero quests: «شكرًا
  لمشاركتك» "Thanks for joining" instead of the count.
- **Never shown:** username, character, score, balance, the event's player count, join code, link, QR, any id.
- **Share:** the phone captures the card as a PNG (`react-native-view-shot`) and opens the system share sheet with it
  (`expo-sharing`) and one fixed line «ملخّصي في {event}» "My recap from {event}". Nothing is uploaded; no link, no
  tracking parameter, no analytics event; the temporary file is deleted when the sheet closes. If the native modules
  are missing (an older build), it shares the line through React Native's `Share` (the share quest's path). Sharing is
  never rewarded. Two new dependencies (reason: an image is what "recap card" means in ADR-048 and F-141, and Android
  cannot share a file through React Native's `Share`); versions through `npx expo install` for SDK 57 and context7. A
  new development build is needed to see the image on a phone (Dhia, later); the text path works without it.
- Arabic and English, the card laid out right to left in Arabic, Western digits, Gregorian dates (shared helpers).
- **No push:** T-501 does not exist. A note there owes one push the day before the window closes (TASKS).

## Migration 0074 (new file)

```sql
-- After the end the window only grows, and once closed it is frozen (ADR-336). The API's role only, as
-- event_times_guard; clock_timestamp(), not now(), so a transaction begun before the close cannot reopen it.
CREATE FUNCTION event_shop_window_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ended boolean;
BEGIN
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  ended := OLD.status IN ('ended', 'archived')
           OR (OLD.status IN ('scheduled', 'live') AND OLD.ends_at <= clock_timestamp());
  IF ended AND (OLD.status = 'archived'
                OR OLD.ends_at + make_interval(days => OLD.shop_days_after) <= clock_timestamp()) THEN
    RAISE EXCEPTION 'the shop has closed' USING ERRCODE = 'SW409', DETAIL = 'closed';
  END IF;
  IF ended AND NEW.shop_days_after < OLD.shop_days_after THEN
    RAISE EXCEPTION 'after the end the shop window only grows' USING ERRCODE = 'SW409', DETAIL = 'shorter';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_shop_window_guard() FROM PUBLIC;
CREATE TRIGGER event_shop_window_guard BEFORE UPDATE OF shop_days_after ON event
  FOR EACH ROW WHEN (OLD.shop_days_after IS DISTINCT FROM NEW.shop_days_after)
  EXECUTE FUNCTION event_shop_window_guard();
```

`event_recap(target uuid)`: `LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp`, `REVOKE ALL FROM
PUBLIC`, `GRANT EXECUTE TO questify_app`. One row for the caller (`profile_player()`) when their enrollment in `target`
is `active` and not `joined_via = 'rehearsal'`; none otherwise. Columns: `status_now`, `name jsonb`, `local_date`,
`city jsonb`, `rank integer`, `rank_state` (`live | pending | unranked | final`, the same CASE as `own_events`; a test
proves both answer the same for the same member), `quests_done integer`, `souvenirs jsonb` (`item_json` array in
earned order). No table, no ledger change, no tick, no grant beyond this EXECUTE. Lock order unchanged (the guard runs
under `updateShop`'s event lock).

## API

| Route | Change |
|---|---|
| `PUT …/events/{eventId}/shop` | `409 shop_window_locked {reason: closed \| shorter}` (the TS rule first, `SW409` mapped the same); the answer's `shop` gains `state` and `closesAt` |
| `GET …/events/{eventId}/rewards` | `shop` gains `state` and `closesAt` |
| `GET /v1/events/{id}/home` | `shopWindow: {state, closesAt} \| null` (null when the shop switch is off); `goal: null` once closed (the rule in `goal.ts`) |
| `GET /v1/events/{id}/shop` | unchanged; API.md documents `closesAt` |
| `GET /v1/events/{id}/recap` (new, player) | `{event: {id, name, date, city}, rank: {state: pending \| unranked \| final, value}, questsDone, souvenirs: [Item]}`; 404 for a non-member, an unknown event or a rehearsal account (as the shop), `409 not_ended` while not ended (the code results use, with the recap's own message); `Cache-Control: private, no-store`; the route inventory (`src/route-access.ts`) |

Shared types follow Home's (`packages/shared`). The app slices souvenirs to 3.

## Tests

- **DB `test/db/shop-window.int.test.ts` (new):**
  - guard: before the end and while live any change; ended and open: longer and the same value pass, shorter
    `SW409 shorter`; closed: any change `SW409 closed`, longer included; archived: closed; the owner connection passes;
    a transaction begun before the close that updates after it gets `SW409 closed` (`clock_timestamp()`).
  - no reopening: as the API role after the close, an `ends_at` change is `QE409` and a `status` write is denied.
  - FR-750/FR-1018: ended 1 day ago with the default 3, a reservation passes; past the window `RS403 closed`;
    `event_shop` answers `closed` and `closes_at`.
  - boundary: a transaction begun before the close reserves after the close moment and is served (balance, units and
    ledger agree); a new transaction is refused.
  - FR-1609 after the close: a hold made before it is handed over after it (desk open); another times out after it
    (points and unit back, one `redeem_return`, the shop still refuses); a player's cancel after the close returns the
    points.
  - earnings after the close: quiz finish by the tick, community payout and `remove_award` (takes no more than the closed
    balance holds) each move the score and write `balance_delta = 0` for new points; submission approval is already
    covered (`submissions.int`).
  - FR-751: snapshot score, `final_rank`, the `own_events` row, `player_xp`, `achievement_earned` and `player_item`
    before the close; move past it; run `advance_event_lifecycle()` and `expire_one_reservation()`; all equal.
  - digital: a delivered code still reads through `my_redemptions` after the close; unassigned codes unchanged.
  - a rank prize with `claim_until` after the close is still handed over after it.
- **DB `test/db/event-recap.int.test.ts` (new):** live → `status_now` live; ended with results pending, revealed
  (final) and unranked; the same rank and state as `own_events`; souvenirs 0, 1 and 4 in earned order; quests done with
  two quests, one done twice and one whose award was removed → 1; rehearsal account, left, banned, removed, pending and
  declined members → no row; a member of organizer B's event asking for A's event → no row; a platform-banned player →
  no row.
- **Security:** outsider (neither function executable by PUBLIC; the `questify_app` grant list gains `event_recap`),
  cross-tenant (`event_recap` across organizers), the routes inventory (`/v1/events/:id/recap`), and the list-style
  guards (`rehearsal.int`, the community gate map) for the new function.
- **Unit:** `shop-window.test.ts` (every branch), `goal.test.ts` (closed → null), Home (`shopWindow` mapping, null when
  the switch is off), the recap route (shape, 404, 409, no-store), the rewards routes (`shop_window_locked` mapping).
- **T-410b:** app units (banner and closed states, the recap view: each rank state, no souvenir, zero quests, more than
  3 souvenirs, the share falling back to text when the modules are missing), `hermes-runtime.test`, `npx expo export`;
  web units for the window field and the Rewards page browser spec (desktop and phone, Arabic and English).
- Full `npx vitest run` once with both URLs before reporting.

## T-410b (standard, app + web)

App: Home (banner while open, closed balance, the recap card once ended), the Rewards tab (closed panel, cancel note,
`closesAt` read in `shop-api.ts`), `/event/[eventId]/recap` (card, share with `react-native-view-shot` and
`expo-sharing`, text fallback), every string in `messages.ts` through ux-araby. Web: the shop settings' closing line and
the days field's rules with both refusals. Notes the build adds: STORE_COMPLIANCE (the share sends an image the player
chose, no link, no tracking; check the two modules for required-reason APIs in the privacy manifest), ux/PLAYER.md §3.4.

## Docs the build updates

API.md (the routes above), DATA_MODEL.md (the guard, `event_recap`, "the close is a rule"), SECURITY.md (the
`event_recap` boundary), SRS (FR-750, 751, 752, 1018 status; FR-1608 partly delivered; FR-1609 tested),
CONFIGURABILITY.md (the window per event, 0 to 30 days), TASKS, STATE.

## Mutation globs (core, GitHub only)

`apps/api/src/rewards/shop-window.ts`, `apps/api/src/home/goal.ts`.

## Risks for the reviewer

1. **The rule-not-write close:** a balance number stays on the enrollment for good. Is there any door that spends or
   converts `enrollment.balance` without `shop_state` (checked: only `reserve_reward`; gems are separate)?
2. **The boundary is the transaction's start (`now()`):** a redemption begun a moment before the close completes after
   it; the guard uses `clock_timestamp()` instead. Are the two rules consistent enough?
3. **FR-1609 returns after the close** land in an unspendable balance, and with spend-lowers-rank they move the score.
4. **Not archiving** (FR-1608): the conflicts named in ADR-337 (5); is leaving events Ended the right call?
5. **Two native dependencies** for the share image, the text fallback on older builds, and OTA safety.
6. **The recap's rank waits for the reveal:** an organizer who never confirms leaves it pending for good (as the
   passport).
7. **Quests done** counts quests completed at least once (XP credits); Home's progress line counts a repeatable quest
   only at its cap, so the two can differ.
