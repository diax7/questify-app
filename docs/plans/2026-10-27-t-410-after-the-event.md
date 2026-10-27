# T-410 — After the event: the shop window, closing the balance, keeping score and stamp, the recap card

Delivers FR-750, FR-751, FR-752, FR-1018 (and FR-1609's after-the-close half). Depends on T-201/T-202 (shop,
`shop_state`, `shop_days_after`), T-206 (desk), T-214 (results, `claim_until`), T-301 (FR-1710), T-402b/T-403
(souvenirs, `final_rank`, passport). Choices are **ADR-336 to ADR-339 / Q-305 to Q-308, Accepted (developer, delegated
by Dhia, 2026-10-27) at the plan review**. Never push, deploy, run EAS or run mutation testing locally. CranL runs
migrations through 0056; this is **0074** (new file).

**Bar: CORE** for T-410 (the window rule on the points balance, the shop's refusals, prize holds after the close): plan
review and code review, mutation on GitHub for the files below. T-410b is Standard.

## Plan review (88, GO to build; no BLOCKER, no re-review; all ten folded 2026-10-27)

| # | Finding | Where it sits now |
|---|---|---|
| 1 | MAJOR (T-410b): the text fallback had no mechanism; a plain import of `expo-sharing` throws at load without its native module | Recap card, "Share"; T-410b "Loading the share modules" and its unit test; ADR-339 (4) |
| 2 | `shareAsync` cannot attach a text line; the temp file was deleted too early | Recap card, "Share" (no line on the image path; release on the next capture or on leaving); ADR-339 (4) |
| 3 | `quests_done` from XP credits drops a quest whose first completion was removed (XP once per player and quest, `0039_xp.sql:85`) | Recap card, "quests done"; `event_recap`; recap DB test; ADR-339 (2) |
| 4 | `joined_via` can be NULL; `left` members should match the passport | `event_recap`'s filter; API row; recap DB tests; ADR-339 (1) |
| 5 | The dashboard always sends `daysAfter`, so a stale page gets `shop_window_locked` on unrelated edits | T-410b (web: send it only when that field changed); ADR-336 (4) |
| 6 | Items and experiences stop when the desk's hours end (`desk_finished`), before the shop may close | What they see (banner's desk line, dashboard warning); Home's `shopWindow.deskEndsAt`; ADR-338 (1), (5) |
| 7 | Archiving (Q-306): deferred, with a task now | ADR-337 (5); Q-306 answered; TASKS **T-411**; SRS FR-1608 partly delivered |
| 8 | Event-data retention (Q-075) must keep the permanent record | Closing the balance (4); ADR-337 (4); the Q-075 row; Docs |
| 9 | Deterministic boundary tests on 2-core CI; no due spend-lowers-rank hold in the FR-751 snapshot; time from SQL | Tests; The window (4) |
| 10 | The `SW409` reason mapping falls under the mutation glob | The window (4); API; Mutation globs |

## Build notes (T-410, 2026-10-27)

- **A bug the after-the-end tests found, fixed in 0074:** `reserve_reward` (0054) set `rehearsing := play_phase(...) =
  'rehearsal'`, which is NULL once the event has ended, so every `NOT rehearsing` test was skipped in the window after
  the end: a digital reward was delivered with no code and no unit counted (the app would show a test code), and an
  item skipped the desk's hours (no `desk_finished`, no pickup moved to the next opening). 0074 restates 0054's body with
  `coalesce(..., false)`; nothing else changes. Proven by three tests in `test/db/shop-window.int` that fail on 0054.
- The rule's `statusNow` check is `ended` only: an archived event's shop is always `closed`, which is refused first.
- The guard's `closed` test reads `NOT coalesce(ends_at + days > clock_timestamp(), false)`, the exact negation of
  `shop_state`'s open test, so the two agree on every row.
- An `ends_at` change after the close stays `event_times_guard`'s (`QE409`); the window guard watches the days only.
  Extending a live event's end in a transaction begun before its end remains allowed (the times guard judges on
  `now()`), which can move a days-0 close by that one edit; it is the end moving while the event was live, not a
  reopening.
- The recap route registers inside `registerHomeRoutes` (the event's player routes); its 404 is `not_found`.
- Balance writers re-checked at the build: the only spender is `reserve_reward` (`RS403 closed`); quest payments,
  category and first-N bonuses, community payouts and quiz finishes write `balance_delta = 0` once `shop_state` is
  `closed`; manual and bulk awards and the streak bonus run only while live; the welcome credit needs a first activation,
  which `join_event` and `decide_join_request` refuse after the end; returns (`redeem_return`) put back what a hold took
  (FR-1609) and `remove_award` takes at most the balance held.

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
   status read in SQL in `updateShop` under the event lock it already takes (`lockBuilderEvent`, `FOR NO KEY UPDATE`);
   the rule takes its state and "now" from SQL, never `Date.now()`. And the DB trigger `event_shop_window_guard`, judged
   on `clock_timestamp()`, so an edit whose transaction began a moment before the close cannot reopen it. When they
   disagree at the boundary the DB wins: `shop-window.ts` also maps `SW409`'s DETAIL (`closed`, `shorter`) to the 409's
   reason, so the mapping is under the mutation glob. The dashboard sends `daysAfter` only when that field changed
   (T-410b), so a page loaded before a co-editor lengthened the window can still save its other settings.
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
   stores no new personal data. **Retention:** the future event-data retention (Q-075) must exclude score,
   `final_rank`, `souvenir_receipt`, `player_item`, XP and achievements: they are the permanent record FR-751 keeps.
5. **No archiving here (decided at the plan review: deferred to T-411).** FR-1608 moves Ended → Archived when the
   window closes, but an archived event refuses the results' confirmation and reveal (`not_ended`), leaves the
   operators' assignment list (the desk could not hand over FR-1609 holds, or rank prizes whose deadline runs up to 60
   days) and closes help-desk tickets. The event stays Ended after the close. **T-411** adds a tick step that archives
   an ended event only when all hold: the shop is closed, no `reserved` redemption of any kind is left, results are
   revealed or `ends_at` + 60 days has passed, and no help-desk ticket is open. FR-1608 is partly delivered until then.

### What the player and organizer see (ADR-338, Q-307); data from T-410, screens in T-410b

- **Home** gets `shopWindow: {state: "not_open" | "open" | "closed", closesAt, deskEndsAt}` (null when the shop
  switch is off), read from `event_shop` so a rehearsal account sees what the shop shows it. `deskEndsAt` is the end of
  the desk's last window when the desk has hours and that end is before `closesAt`, else null.
  - Ended and open: «متجر الجوائز مفتوح حتى {date}» "The rewards shop is open until {date}": a date and time in the
    event's zone, never a countdown, no loss copy (ADR-300's rule). With `deskEndsAt`, a second line: «تُحجز القطع
    والتجارب حتى انتهاء ساعات مكتب الجوائز في {date}» "Items and experiences can be reserved until the prize desk's
    hours end on {date}" (after that `reserve_reward` answers `desk_finished`; digital rewards stay until the close).
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
  read-only once closed, with each refusal's text. When the desk's last window ends before the shop closes, a warning:
  «تنتهي ساعات المكتب قبل إغلاق المتجر، فيتوقف حجز القطع والتجارب عندها، وتبقى الجوائز الرقمية حتى الإغلاق.» "The prize
  desk's hours end before the shop closes: items and experiences stop then; digital rewards stay until the close."
- Copy above is a draft: ux-araby at the build; Western digits; RTL.

### The recap card (ADR-339, Q-308)

- **When:** once the event is Ended or Archived, for a member who played, as the passport counts it: not pending,
  declined, banned or removed, and `joined_via IS DISTINCT FROM 'rehearsal'` (NULL for older enrollments); `left`
  members included. Home (active members) shows a "Your recap" card at the top that opens `/event/[eventId]/recap`.
- **Shows** (all of it already visible to the player): the event's name, local start date and city; the rank: the
  final rank once results are revealed (the passport's rule, ADR-276: `final_rank` and `revealed_at`), «يظهر ترتيبك
  النهائي مع إعلان النتائج» "Your final rank comes with the results" while pending, no rank line when unranked; quests
  done = `count(DISTINCT quest_id)` of this enrollment's `kind = 'quest'` ledger entries that no `removal` entry
  reverses (`reverses`). Not XP credits: XP is paid once per player and quest, on the first completion only
  (`0039_xp.sql:85`), so a quest whose first completion was removed and then done again would be dropped. The souvenirs
  earned at this event (`player_item`, source souvenir, this event), up to 3 on the card and "+N". No souvenir: that
  part is left out (FR-752's second case). Zero quests: «شكرًا لمشاركتك» "Thanks for joining" instead of the count.
- **Never shown:** username, character, score, balance, the event's player count, join code, link, QR, any id.
- **Share:** the phone captures the card as a PNG (`react-native-view-shot`) and opens the system share sheet with the
  image alone (`expo-sharing`'s `shareAsync` takes only `dialogTitle`, `mimeType` and `UTI`; the card names the event).
  Nothing is uploaded; no link, no tracking parameter, no analytics event. The capture is not deleted when
  `shareAsync` returns (the receiving app may still be reading it): the screen releases the previous capture
  (`releaseCapture`) before the next one and when it closes. If either native module is missing (an older build), it
  shares one fixed line «ملخّصي في {event}» "My recap from {event}" through React Native's `Share` (the share quest's
  path); how it is detected is in T-410b. Sharing is never rewarded. Two new dependencies (reason: an image is what
  "recap card" means in ADR-048 and F-141, and Android cannot share a file through React Native's `Share`); versions
  through `npx expo install` for SDK 57 and context7. A new development build is needed to see the image on a phone
  (Dhia, later); the text path works without it.
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
has `status NOT IN ('pending', 'declined', 'banned', 'removed')` and `joined_via IS DISTINCT FROM 'rehearsal'` (as
`own_events`; `joined_via` is NULL for enrollments older than 0018); none otherwise. Columns: `status_now`, `name
jsonb`, `local_date`, `city jsonb`, `rank integer`, `rank_state` (`live | pending | unranked | final`, the same CASE as
`own_events`; a test proves both answer the same for the same member), `quests_done integer` (`count(DISTINCT
l.quest_id)` over `ledger_entry l` with `l.enrollment_id = n.id AND l.kind = 'quest' AND NOT EXISTS (removal r WHERE
r.reverses = l.id)`), `souvenirs jsonb` (`item_json` array in earned order). No table, no ledger change, no tick, no grant beyond this EXECUTE. Lock order unchanged (the guard runs
under `updateShop`'s event lock).

## API

| Route | Change |
|---|---|
| `PUT …/events/{eventId}/shop` | `409 shop_window_locked {reason: closed \| shorter}` (the TS rule first, `SW409`'s DETAIL mapped to the same reason in `shop-window.ts`); `daysAfter` stays optional and the current value is no change; the answer's `shop` gains `state` and `closesAt` |
| `GET …/events/{eventId}/rewards` | `shop` gains `state` and `closesAt` |
| `GET /v1/events/{id}/home` | `shopWindow: {state, closesAt, deskEndsAt} \| null` (null when the shop switch is off; `deskEndsAt` only when the desk's last window ends before `closesAt`); `goal: null` once closed (the rule in `goal.ts`) |
| `GET /v1/events/{id}/shop` | unchanged; API.md documents `closesAt` |
| `GET /v1/events/{id}/recap` (new, player) | `{event: {id, name, date, city}, rank: {state: pending \| unranked \| final, value}, questsDone, souvenirs: [Item]}`; 404 for a non-member, an unknown event, a rehearsal account or a pending, declined, banned or removed member (a `left` member is answered, as the passport); `409 not_ended` while not ended (the code results use, with the recap's own message); `Cache-Control: private, no-store`; the route inventory (`src/route-access.ts`) |

Shared types follow Home's (`packages/shared`). The app slices souvenirs to 3.

## Tests

- **DB `test/db/shop-window.int.test.ts` (new):**
  - **Deterministic on 2-core CI:** each boundary test puts the close at `clock_timestamp() + interval '1 second'`
    (owner connection), begins its transaction before it, then sleeps 1.5 s (a 0.5 s margin) before acting; no test
    depends on a race of milliseconds.
  - guard: before the end and while live any change; ended and open: longer and the same value pass, shorter
    `SW409 shorter`; closed: any change `SW409 closed`, longer included; archived: closed; the owner connection passes;
    a transaction begun before the close that updates after it gets `SW409 closed` (`clock_timestamp()`).
  - no reopening: as the API role after the close, an `ends_at` change is `QE409` and a `status` write is denied.
  - FR-750/FR-1018: ended 1 day ago with the default 3, a reservation passes; past the window `RS403 closed`;
    `event_shop` answers `closed` and `closes_at`.
  - boundary: a transaction begun before the close reserves after the close moment and is served (balance, units and
    ledger agree); a new transaction is refused.
  - the API's rule reads `shop_state`, the status and `now()` from SQL in `updateShop`'s transaction (a route test
    with the event just past its close and the API's clock unchanged still answers `closed`).
  - FR-1609 after the close: a hold made before it is handed over after it (desk open); another times out after it
    (points and unit back, one `redeem_return`, the shop still refuses); a player's cancel after the close returns the
    points.
  - earnings after the close: quiz finish by the tick, community payout and `remove_award` (takes no more than the closed
    balance holds) each move the score and write `balance_delta = 0` for new points; submission approval is already
    covered (`submissions.int`).
  - FR-751: snapshot score, `final_rank`, the `own_events` row, `player_xp`, `achievement_earned` and `player_item`
    before the close; move past it; run `advance_event_lifecycle()` and `expire_one_reservation()`; all equal. The
    fixture has no due hold that could move the score (spend-lowers-rank off, or every hold handed over), so a timeout's
    mirrored return cannot be mistaken for the close.
  - digital: a delivered code still reads through `my_redemptions` after the close; unassigned codes unchanged.
  - a rank prize with `claim_until` after the close is still handed over after it.
- **DB `test/db/event-recap.int.test.ts` (new):** live → `status_now` live; ended with results pending, revealed
  (final) and unranked; the same rank and state as `own_events`; souvenirs 0, 1 and 4 in earned order; quests done:
  two quests, one done twice and one whose award was removed → 1; a quest whose first completion was removed and then
  done again → counted (the case XP credits would drop); a `left` member → a row; a member with `joined_via` NULL → a
  row; rehearsal account, banned, removed, pending and declined members → no row; a member of organizer B's event
  asking for A's event → no row; a platform-banned player → no row.
- **Security:** outsider (neither function executable by PUBLIC; the `questify_app` grant list gains `event_recap`),
  cross-tenant (`event_recap` across organizers), the routes inventory (`/v1/events/:id/recap`), and the list-style
  guards (`rehearsal.int`, the community gate map) for the new function.
- **Unit:** `shop-window.test.ts` (every branch of the rule and of the `SW409` DETAIL mapping, an unknown DETAIL
  included), `goal.test.ts` (closed → null), Home (`shopWindow` mapping, `deskEndsAt` only before the close, null when
  the switch is off), the recap route (shape, 404, 409, no-store), the rewards routes (`shop_window_locked` mapping).
- **T-410b:** app units (banner with and without the desk line, closed states, the recap view: each rank state, no
  souvenir, zero quests, more than 3 souvenirs; the share: with both modules reported missing, the text `Share` is used
  and neither module is loaded; with one missing, the same; the previous capture released before the next and on
  leaving), `hermes-runtime.test`, `npx expo export`; web units (`shopRequest` sends `daysAfter` only when it changed;
  the desk warning) and the Rewards page browser spec (desktop and phone, Arabic and English).
- Full `npx vitest run` once with both URLs before reporting.

## T-410b (standard, app + web)

App: Home (banner while open with the desk line, closed balance, the recap card once ended), the Rewards tab (closed
panel, cancel note, `closesAt` read in `shop-api.ts`), `/event/[eventId]/recap` (card, share), every string in
`messages.ts` through ux-araby. Web: the shop settings' closing line, the desk warning, the days field's rules with both
refusals, and `shopRequest` (`apps/web/src/lib/rewards.ts`) sends `daysAfter` only when that field changed. Notes the
build adds: STORE_COMPLIANCE (the share sends an image the player chose, no link, no tracking; check the two modules for
required-reason APIs in the privacy manifest), ux/PLAYER.md §3.4.

**Loading the share modules (MAJOR 1).** A plain `import` of `expo-sharing` or `react-native-view-shot` throws at load
on a build without the native module (the class of crash the `toSorted` APK had). One small module
(`apps/app/src/event/recap-share.ts`) checks first: `requireOptionalNativeModule('ExpoSharing')` (from `expo`) and
`TurboModuleRegistry.get('RNViewShot')` (from `react-native`); only when both are present does it load the two packages
with a lazy `require` inside the function, never at the top of a file. Otherwise it shares the fixed line through
React Native's `Share`. The unit test mocks both checks to report the modules missing and asserts the text share is
used and neither package is required. Context7 confirms each module's registered native name at the build.

### T-410b build note (2026-10-27, Standard)

- **Files.** App, pure and unit-tested: `event/shop-window.ts` (Home's banner rule and the next time to read Home
  again), `event/recap-api.ts` (the route's answer through `eventRecapSchema`), `event/recap.ts` (the card's lines and the
  fixed text share), `event/recap-share.ts` (the sharer with injected modules) and `event/recap-share-native.ts` (the
  two native checks, the lazy `require`s, React Native's `Share`). Screens stay thin: `ShopBanner.tsx`, `RecapEntry.tsx`
  and `RecapCard.tsx` in `event/`, `app/event/[eventId]/recap.tsx`, and edits to Home, the Rewards tab, `shop-api.ts`
  and `home-api.ts`. Web: `lib/rewards.ts` (the settings carry `state` and `closesAt`; `shopRequest` takes the loaded
  settings and sends `daysAfter` only when it changed; the days check after the end; the desk warning),
  `lib/sign-in-errors.ts` (the two `shop_window_locked` reasons in words) and `RewardsPanel.tsx`.
- **The share is split in two files** so the rule is testable without React Native: `recap-share.ts` takes `{modulesPresent,
  loadModules, shareText}`; the native file supplies the real ones. The unit test passes "both missing" and "one
  missing" and asserts the text share ran and `loadModules` (the only place the packages are required) never did; a
  second test mocks `expo` and `react-native` and asserts the two checks use `ExpoSharing` and `RNViewShot`, and a
  source guard asserts neither package is imported at the top of any app file.
- **New dependencies (Dhia's rule: a reason for each).** `react-native-view-shot` **5.1.0** (the exact version Expo SDK
  57's `bundledNativeModules.json` pins; the registry's latest is 6.2.1, which Expo has not blessed for SDK 57) draws the
  card into a PNG on the phone. Its `src/specs/NativeRNViewShot.ts` calls `TurboModuleRegistry.getEnforcing("RNViewShot")`
  when the file loads, which is why a plain import crashes an older build. `expo-sharing` **~57.0.24** (SDK 57's range
  `~57.0.23`; published 2026-10-21, over the 1-day `minimumReleaseAge`) opens the system share sheet for a file;
  React Native's own `Share` cannot attach a file on Android. Context7 and the packages' sources confirm the native names
  (`ExpoSharing` in both `SharingModule` files; `RNViewShot`), `captureRef(…, {format, quality, result: "tmpfile"})`,
  `releaseCapture(uri)` and `shareAsync(uri, {mimeType, UTI, dialogTitle})`. `react-native-view-shot` adds five
  pure-JS web-only packages (`html2canvas` and its four helpers, none loaded on a phone). Neither package asks for a
  permission or an install script (`strictDepBuilds` holds). Privacy manifest: view-shot's is empty; expo-sharing ships
  none and uses `UserDefaults` only to read an app group's received shares, which `app.json` already declares
  (`NSPrivacyAccessedAPICategoryUserDefaults`, `CA92.1`); nothing to add (STORE_COMPLIANCE records it).
- **Decisions taken (Proposed ADR-340, Q-309):** the recap card on Home shows for an active member once the event is
  ended or archived; the card draws with the current theme and language (an image is a snapshot of the screen);
  souvenirs show as names, three at most; Home reads itself again when the shop's close or the desk's end passes, so the
  balance flips to "Closed" without a manual refresh; the dashboard shows the refusal's own words for each
  `shop_window_locked` reason and loads the shop again after one.

## Docs the build updates

API.md (the routes above), DATA_MODEL.md (the guard, `event_recap`, "the close is a rule"), SECURITY.md (the
`event_recap` boundary), SRS (FR-750, 751, 752, 1018 status; FR-1609 tested; FR-1608 already marked partly delivered,
T-411), CONFIGURABILITY.md (the window per event, 0 to 30 days), DATA_MODEL.md's retention notes (Q-075 must exclude
score, `final_rank`, `souvenir_receipt`, `player_item`, XP and achievements), TASKS, STATE.

## Mutation globs (core, GitHub only)

`apps/api/src/rewards/shop-window.ts` (the rule and the `SW409` mapping), `apps/api/src/home/goal.ts`.

## Risks for the reviewer (the code review)

1. **The rule-not-write close:** a balance number stays on the enrollment for good. Is there any door that spends or
   converts `enrollment.balance` without `shop_state` (checked: only `reserve_reward`; gems are separate)?
2. **The boundary is the transaction's start (`now()`):** a redemption begun a moment before the close completes after
   it; the guard uses `clock_timestamp()` instead. Are the two rules consistent enough?
3. **FR-1609 returns after the close** land in an unspendable balance, and with spend-lowers-rank they move the score.
4. **Not archiving** (FR-1608): events stay Ended until T-411.
5. **Two native dependencies** for the share image: the detection before any load, the text fallback, OTA safety.
6. **The recap's rank waits for the reveal:** an organizer who never confirms leaves it pending for good (as the
   passport).
7. **Quests done** counts quests completed at least once (ledger, removals excluded); Home's progress line counts a
   repeatable quest only at its cap, so the two can differ.

## T-411 — archiving ended events (plan note, 2026-10-28; ADR-341 Proposed, Q-310)

Delivers FR-1608's last step under ADR-337 (5). Small and fully specified, so a note, not a plan review. Migration
**0075** (new file; CranL is at 0056).

- **The step.** `archive_ended_events()` (definer, granted to the API's role like `advance_event_lifecycle`, no
  argument: it applies only the rules) is the lifecycle tick's last step, after the reservation timeout and the ticket
  purge, so a hold that timed out in the same run no longer blocks. It picks at most 100 `ended` events for which
  `archive_due(event)` holds, oldest end first, `FOR UPDATE SKIP LOCKED`; for each it runs one `UPDATE … WHERE
  archive_due(e)` (a statement that starts after the lock, so it sees every commit before it) and writes the same
  audit row as the other moves (`system`, `event.lifecycle`, `{status: ended}` → `{status: archived}`).
- **`archive_due(ev)`** (plain SQL, internal): `status = 'ended'`; `shop_state(...) = 'closed'`; `event_result.revealed_at`
  set or `ends_at + 60 days <= now()`; no `redemption` of the event `reserved` (shop holds, rank prizes, quest items: one
  table); no `ticket` of the event `open` (either queue). Every blocker clears on its own: holds and prizes time out,
  tickets are purged 90 days after the end, results fall back to the 60 days.
- **Races (the handover risk).** Two triggers read the event row `FOR KEY SHARE` before a redemption or an event ticket
  is inserted and refuse an archived event with the door's own refusal (`RS403 closed` for a shop reward, `RF409
  not_ended` for a rank prize, `QN403 ended` for a quest item, `HT403 sending_closed` for a ticket). The step's `FOR
  UPDATE` conflicts with that lock: a door that read first makes the step skip the event this run; a door that reads
  after waits for the step and then sees Archived. So nothing reserved or open is ever left in an archived event.
- **Final.** The API's role has no right on `status` (0009); no definer moves an event out of Archived; a trigger now
  refuses that for every role (`QE409 archived`).
- **What Archived means (checked in the code).** Organizer writes refuse it (`event_archived`), joining and new tickets
  refuse it, the operators' list leaves it (nothing is left to hand over). The player keeps everything: `/v1/me/events`,
  Home (shop `closed`), recap, passport (`own_events`, ended or archived), the public stamp, results, points record, My
  rewards, tickets, profile, locker and achievements all read an archived event. `MyEvent.statusNow`'s type in
  `join.ts` gains `archived` (the list already returned it).
- **Tests.** `test/db/event-archive.int` (each blocker alone, every redemption kind, both ticket queues, the open shop,
  60 days to the microsecond, clearing, twice, two at once, a reservation and a ticket during the step in both orders,
  the audit row, organizer and editor refused, the final trigger, the triggers' refusals), `test/events/archived.int`
  (the player's reads over HTTP after archiving), the tick's unit test, the outsider and cross-tenant suites.
- **Mutation globs (core):** `apps/api/src/events/tick.ts`.
