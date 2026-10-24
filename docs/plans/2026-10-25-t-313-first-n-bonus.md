# T-313 — First-N bonus: extra points for the first N players who complete a quest, with a live "bonuses left"

F-342, FR-1840: the owner or an editor sets on a quest a bonus of X points for the first N completions; the count is
taken inside the completion transaction so no more than N bonuses are ever paid; the app shows the bonuses left.
**Done when** two simultaneous completions at the Nth place pay exactly one bonus, and a completion after the last bonus
earns the quest's points only. Depends on T-105 (done).
**Core bar** (the points ledger): one Opus plan review, one Opus code review, mutation on GitHub. Migration **0062**
(new file; CranL runs through 0056, 0057 to 0061 are undeployed; the functions they last stated are restated here,
never edited there).

Dhia is away: open choices are my recommendation, written as **Proposed** ADR-260 to ADR-263 and Q-223 to Q-226
(recorded in `docs/DECISIONS.md` and `docs/OPEN_QUESTIONS.md` in phase 1).

## What T-313 builds on

- **The two payers.** Every quest payment reaches `record_completion` (0058: QR, typed code, location, my-QR, NFC,
  screen QR, kiosk, vote, live poll, survey, share, manual) or `pay_completion` (0055: submission approval, quiz finish,
  game result, passport stamp, meet both sides). The payer completeness map (`test/db/flash-boosts.int.test.ts`,
  `PAYER_MAP`) fails on any new writer or caller; T-313 adds one internal payer and both doors call it.
- **The lock order inside a completion** (rules.md, ADR-211, ADR-205): the rehearsal row (`ensure_rehearsal_wiped`,
  `FOR SHARE` before go-live), the enrollment `FOR NO KEY UPDATE`, the quest's and category's items `FOR UPDATE` in id
  order (`lock_quest_items`), the Questify XP row (the `ledger_xp` trigger on the quest entry), then the category bonus.
- **The nearest pattern**: the category bonus (`pay_category_bonus`, ADR-202): its own ledger kind, `actor = 'system'`,
  balance 0 while the shop is closed, never boosted (ADR-232's Never list), removable on its own by `remove_award`,
  counted by a community points goal, wiped with the rehearsal. And the quest item's stock (ADR-205), the only
  per-quest counter so far: every completion of an item quest locks the item row for its whole transaction.

## How the count is taken (ADR-260)

Three designs were weighed against NFR-003 (20,000 completions in a minute in one event, about 333 a second, and the
quest a first-N bonus is put on is the entrance quest everyone scans first) and NFR-002 (95% confirmed within 1 s):

| Design | Two at the Nth | Contention among the first N | Verdict |
|---|---|---|---|
| A. A counter row, `UPDATE … SET claimed = claimed + 1 WHERE claimed < slots RETURNING claimed` | exact (the waiter re-checks the WHERE on the new row) | every claimer holds the one row from its UPDATE to its commit: claims run one at a time, about 2 to 3 ms each (the rest of the transaction plus the commit's WAL flush), so 1,000 slots queue for 2 to 3 s at a burst and the queue's tail breaks NFR-002 | rejected |
| B. A per-quest advisory lock plus a count of bonus entries | exact | the same queue, plus a count per claim | rejected |
| **C. One row per slot, claimed with `FOR UPDATE SKIP LOCKED`** | exact (N rows exist; a locked slot is skipped, a committed one fails the re-checked WHERE) | none: concurrent claimers each take a different free slot; only two players racing for the very last slot meet, and the loser skips it at once | **chosen** |

**The tables** (deny by default: RLS forced, `REVOKE ALL FROM PUBLIC`, no grant to the API role, written only by
definers; the money rule: no column grant at all):

| Table | Columns | Notes |
|---|---|---|
| `quest_first_bonus` | `quest_id` PK, `organizer_id`, `event_id` (composite FK `(quest_id, event_id) → quest` ON DELETE CASCADE), `points` integer 1–100,000, `slots` integer 1–1,000, `updated_at` | The quest's bonus, one row or none. `slots` always equals the number of slot rows (the setter keeps it) |
| `quest_bonus_slot` | `quest_id` → `quest_first_bonus` ON DELETE CASCADE, `place` integer ≥ 1, `organizer_id`, `event_id`, `completion_id` → `quest_completion` RESTRICT, `entry_id` → `ledger_entry` RESTRICT, `enrollment_id`, `rehearsal` boolean, `claimed_at`; PK `(quest_id, place)` | A slot is free while `completion_id` is NULL. CHECK: the four claim columns are all NULL or all set. UNIQUE `completion_id`, UNIQUE `entry_id`, UNIQUE `(quest_id, enrollment_id)`. Partial index `quest_bonus_slot_free (quest_id, place) WHERE completion_id IS NULL` (the claim's scan and the left count) |

**The claim** (`pay_first_bonus(enrolled, quest_row, completion, occurrence, method, request_key) RETURNS bigint`,
internal, not granted), called by `record_completion` after `pay_category_bonus` and **before** its final score read
(so the returned score holds the bonus), and by `pay_completion` after `pay_category_bonus`:

1. Nothing (NULL, no lock) when: no `quest_first_bonus` row (a primary-key probe: the only cost a quest without a bonus
   pays); `occurrence > 1`; `method = 'manual'`; the key starts `practice:`; no free slot (an unlocked read: once the
   bonus is used up, no completer takes any lock for it).
2. The bonus row `FOR SHARE`, re-read (it may have been switched off or changed while this waited; NULL if gone).
3. `SELECT place … WHERE quest_id = q AND completion_id IS NULL ORDER BY place LIMIT 1 FOR UPDATE SKIP LOCKED`; none →
   NULL (the loser of the last slot; it pays the quest's points only).
4. The ledger entry (below), then the slot's claim columns (`rehearsal` from the enrollment's `joined_via`).

**Why the bonus row `FOR SHARE`**: the setter takes it `FOR UPDATE`, so an edit waits for the claims in flight and a
claim waits for an edit in flight; the setter then counts every committed claim exactly, and no claim pays an amount
an edit just changed. Only claimers take it (at most N, and only while slots are free); shared locks do not wait for
each other. The setter takes nothing else a claimer holds, so the wait is one way.

**Lock order (rules.md gains a line)**: a completion takes the rehearsal row, the enrollment, the items, the XP row,
the category bonus, then **the bonus row `FOR SHARE`, then one slot `FOR UPDATE SKIP LOCKED`**, last, so the slot is
held only from there to the commit. The setter takes the rehearsal row (`ensure_rehearsal_wiped`), the bonus row `FOR
UPDATE`, then the slot rows; never an enrollment, an item or an XP row. The builder's save calls the setter **after**
its quest UPDATE (the quest UPDATE may wait on an item's `KEY SHARE`; it must not hold the bonus row then). The
rehearsal wipe holds the rehearsal row `FOR UPDATE`, so no claim runs during it. No cycle.

**Measured at build, by hand, recorded in STATE** (the T-306b timing pattern): 300 completions at once on one quest
with N = 50 on 8 connections, against the same burst on a quest without a bonus: exactly 50 paid, and the p95 of the
bonus burst within 20% of the plain one. If it is not, the plan comes back to the CTO before phase 2.

## Which completions count (ADR-261)

| Completion | Takes a slot? |
|---|---|
| A player's own act through any door: QR, typed code, location, NFC, screen QR, kiosk, my-QR (an operator's scan), vote, live poll, survey, share, passport (the stamp that finishes it), submission (**at approval**; auto-approve at once), quiz (at its finish), game (at its result) | yes, the player's **first** completion of the quest only |
| Meet (both sides pay in one transaction) | each side is a completion: two slots; with one left, the side paid first (player id order, ADR-211) gets it |
| A repeat (`occurrence > 1`), a period refresh, a daily quest's next day | never: one bonus per player per quest, ever (Q-224) |
| A manual quest award by the team | never (as ADR-232: staff award the quest's own points); it takes no slot |
| A point award, the welcome points, a community reward | never (not quest completions) |
| An operator's practice scan | never: `practice:` keys skip the claim, so it takes no lock and no slot (the real door runs inside the practice's undone block, ADR-249). `operator_practice_scan` is restated to also answer `bonus_points` when the scan would be the player's first and a free slot exists (an unlocked read), so practice shows the real result. The API never forwards a client key starting `practice:` (keys are UUIDs at the routes; checked by a route test) |
| A rehearsal account's completion | yes, as live (the owner rehearses the race); the wipe gives every rehearsal slot back (below) |
| A quiz with no right answer, a game with no result | never: no completion row, no bonus |

- **Never boosted** (ADR-232's Never list gains it): the entry is the organizer's fixed amount, with no `boost_id`.
- **No XP**: XP follows `kind = 'quest'` entries only (ADR-179), so the new kind pays none.
- **The shop**: balance 0 while the shop is closed, as every completion credit.
- **An operator who may not play**: the quest entry is refused first (`QP403`); the guard lists the new kind anyway.

## The ledger entry and its reversal

- New kind **`first_bonus`**: `ledger_entry_kind_check` widened; `ledger_entry_system_returns_only` lists it
  (`actor = 'system'`); new CHECK `ledger_entry_first_bonus_shape`: `completion_id` and `quest_id` set, `score_delta >
  0`, `balance_delta IN (0, score_delta)`, `category_id`, `community_step_id`, `redemption_id`, `boost_id` NULL, actor
  `system`. Backstops: UNIQUE `(completion_id) WHERE kind = 'first_bonus'`, UNIQUE `(quest_id, enrollment_id) WHERE
  kind = 'first_bonus'`. `ledger_operator_play_guard` lists it. The score and ranking triggers are kind-blind (0015).
- **Removal**: `remove_award` (restated from 0055) accepts `first_bonus`; its removal copies `completion_id` and
  `quest_id` (the existing columns). The bonus is its own line, removed on its own, as the category bonus; removing
  the quest line does not remove it (the team's record shows the two lines together; the remove dialog of a quest
  line says "This completion also earned the first-{slots} bonus. Remove that line too if it should go"). **A removal
  never frees the slot**: the place stays used, as the quest stays used (ADR-152), so "bonuses left" never rises
  except by the team raising N (Q-223). `credit_item` is kind-gated already (no item for this kind; tested).
- **Readers that list kinds** restate with `first_bonus` beside `bonus`: `community_read_slice` (a points goal counts
  it), `rehearsal_card` and `wipe_rehearsal`'s points, `member_ledger` and `member_activity` (the row has the quest's
  title; the app labels it by kind). **Build check**: every query joining `ledger_entry` by `completion_id` without a
  kind filter now finds two rows for a bonus completion; phase 1 greps them (SQL and `apps/api/src`) and lists each in
  the PR notes with its fix or why it is right.

## The go-live wipe and the rehearsal

- Every payer calls `ensure_rehearsal_wiped` before anything (unchanged), so the go-live wipe has run before the first
  real claim. `wipe_rehearsal` (restated from 0059) **first** clears the claim columns of the event's slots with
  `rehearsal` true (before it deletes the rehearsal ledger entries and completions the slots point to), and counts
  them as `first_bonuses` in its counts. The team's Erase rehearsal does the same.
- The edit lock (next section) counts **real** claims only, so a rehearsal never locks the bonus's points.

## The builder (ADR-262)

- **Fields** on the quest form, every quest type: "First players bonus" switch; "Bonus points" (1 to 100,000, the
  quest points' range, in the event's currency word); "For the first how many players?" (1 to 1,000). Preview line.
- **The setter** `set_quest_first_bonus(target_quest, points, slots, request)` (definer, granted to `questify_app`):
  `award_event_of` (owners and editors in scope, AN404), the quest in that event (QC404), the builder's
  results-final and archived refusals as the quest save; then the rehearsal row, the bonus row `FOR UPDATE` (or the
  insert), then:
  - **Off** (`points` and `slots` NULL): deletes the row and its slots; refused once a real slot is claimed
    (`QB409 first_bonus_paid`).
  - **Points**: free until the first real claim; then refused (`QB409 first_bonus_paid`): every player of the first N
    got the same amount.
  - **Slots**: any value ≥ the claimed slots (real and rehearsal; `QB409 below_given {given}`). Raising inserts the
    new places; lowering deletes free slots from the highest place down (no claim holds one: the setter waited for
    them on the bonus row). **Stop the bonus** in the dashboard is slots = given (left 0).
  - Audit `event.first_bonus_set` (`target_type quest`, before and after `{points, slots, given}`).
- The quest save (`PUT …/quests/{questId}`, `POST …/quests`) takes `firstBonus: {points, slots} | null` and calls the
  setter in the same transaction after the quest write; the builder read gains `firstBonus: {points, slots, given,
  left, locked}`. A quest with a claimed slot cannot be deleted (its completions already block it; tested). Flash
  quests, hidden categories and community-locked quests take a bonus like any quest.
- The dashboard: the fields with the preview "The first {slots} players to finish this quest get {points} extra
  {currency}"; once locked, the points field is read-only with "{given} players already got this bonus, so its points
  can't change", the slots field's minimum is {given}, and **Stop the bonus**. The quest list shows "First {slots}:
  {left} left". The team's player record shows the line "First-{slots} bonus, place {place}".

## The live "bonuses left" (ADR-263)

- **Counting is the slots**: left = free slot rows. A count over the partial index is up to 1,000 entries per quest,
  but `/live` runs every 10 s for every player (`livePollSeconds`; 50,000 players is about 5,000 reads a second), so the
  count is **not** run per player.
- `first_bonus_left(target_event)` (definer, granted to `questify_app`; counts only, no player): every bonus quest of
  the event with `{quest_id, points, slots, left}`. The API caches it **per event for 2 seconds** in process
  (`apps/api/src/quests/first-bonus.ts`, one query in flight per event and instance; no new dependency), so the
  database sees about one count per event per instance every 2 s, whatever the players. Served only behind each route's
  own membership gate.
- `GET /v1/events/{id}/live` gains `firstBonus: [{questId, left, slots}]`: the bonus quests with `left > 0` that the
  caller may play now and has not completed (the playable set the read already computes for `flash`). The ETag covers
  it, so the body changes as the count moves. Delay seen by a player: at most the poll (10 s) plus 2 s.
- `GET /v1/events/{id}/quests`: each quest gains `firstBonus: {points, slots, left, mine: {place} | null} | null` (the
  caller's own slot from SQL, the counts from the cache).
- Every completion answer (each door listed above, an approved submission's read, a quiz finish, a game result,
  passport, meet) gains `firstBonus: {points, place, slots} | null` from `own_first_bonus(completion)` (definer: the
  caller's own completion only; the same on a replay). `points` stays the quest's own (boosted) amount; the score holds
  both.
- **The app**: a gold "First {slots}" ribbon on the quest card and sheet with "+{points} · {left} left", "All taken"
  when 0, and "You got bonus #{place}" once mine; the success card adds "First {slots} bonus! +{points}" (its own coin
  beat, after the points); a player who scanned when the last slot went sees the normal success and "The first-{slots}
  bonus is all taken". The history row "First-{slots} bonus". The quests list re-reads on a `/live` change of `left`
  (no new timer). Operator practice: "This scan would also earn the first-{slots} bonus (+{points})".

## Functions (migration 0062; each `REVOKE ALL … FROM PUBLIC`; entry points granted to `questify_app` only)

1. Tables, ledger CHECKs and indexes (above).
2. `pay_first_bonus` (internal), `set_quest_first_bonus`, `first_bonus_left`, `own_first_bonus`.
3. Restated with the claim: `record_completion` (from 0058), `pay_completion` (from 0055; signature unchanged).
4. Restated with the kind: `remove_award`, `ledger_operator_play_guard`, `community_read_slice`, `rehearsal_card`,
   `wipe_rehearsal`, `member_ledger`, `member_activity` (only those whose body lists kinds; DROP and CREATE only where an
   output changes), `operator_practice_scan` (DROP and CREATE: `bonus_points`), `live_state` (the `firstBonus`
   playable set's ids; the counts come from the cache), `member_event_quests` (DROP and CREATE: `first_bonus_points`,
   `first_bonus_slots`, `first_bonus_place`).
5. The event delete trigger and the quest delete path know the two tables (cascade from the quest; a claimed slot's
   completion blocks a delete already).

## API (`apps/api/src/quests/first-bonus.ts` new; API.md rows)

- Builder: `firstBonus` on the quest save and read; 409 `first_bonus_paid`, `below_given {given}`; 422
  `invalid_first_bonus {field: points|slots}` (shared Zod in `packages/shared/src/quests/`).
- Player: the `/live`, quests and completion fields above.
- Logs: `quest.first_bonus_set {replayed}`, `completion.first_bonus {place, slots}` (no player); the redaction test
  is unchanged (no new personal data).

## Strings (Arabic through `ux-araby` at build, matched to `messages.ts`; Western digits; RTL checked; "points" is the event's currency word, NFR-014)

| Key | English | Arabic (draft) |
|---|---|---|
| quest.firstBonus.ribbon | First {slots} | أول {slots} |
| quest.firstBonus.left | +{points} · {left} left | +{points} · بقي {left} |
| quest.firstBonus.gone | All taken | نفدت |
| quest.firstBonus.mine | You got bonus #{place} | حصلت على المكافأة رقم {place} |
| play.firstBonus.won | First {slots} bonus! +{points} | مكافأة أول {slots}! +{points} |
| play.firstBonus.missed | The first-{slots} bonus is all taken | نفدت مكافأة أول {slots} |
| history.firstBonus | First-{slots} bonus | مكافأة أول {slots} |
| builder.firstBonus.title | First players bonus | مكافأة أوائل اللاعبين |
| builder.firstBonus.points | Bonus points | نقاط المكافأة |
| builder.firstBonus.slots | For the first how many players? | لأول كم لاعب؟ |
| builder.firstBonus.preview | The first {slots} players to finish this quest get {points} extra {currency} | أول {slots} لاعب يُنهون هذه المهمة يحصلون على {points} {currency} إضافية |
| builder.firstBonus.locked | {given} players already got this bonus, so its points can't change | حصل {given} لاعب على هذه المكافأة، فلا يمكن تغيير نقاطها |
| builder.firstBonus.belowGiven | At least {given}: that many players already got it | {given} على الأقل، فقد حصل عليها هذا العدد من اللاعبين |
| builder.firstBonus.stop | Stop the bonus | أوقف المكافأة |
| builder.firstBonus.listLeft | First {slots}: {left} left | أول {slots}: بقي {left} |
| record.firstBonus | First-{slots} bonus, place {place} | مكافأة أول {slots}، المركز {place} |
| awards.removeBonusHint | This completion also earned the first-{slots} bonus. Remove that line too if it should go | حصل هذا الإنجاز أيضًا على مكافأة أول {slots}، فاحذف سطرها كذلك إن لزم |
| operator.practice.firstBonus | This scan would also earn the first-{slots} bonus (+{points}) | سيحصل هذا المسح أيضًا على مكافأة أول {slots} (+{points}) |

## Store compliance and personal data

Points are not money and nothing is downloaded; no new data about a person (a slot names an enrollment, which the
ledger already does; erasure keeps completions and ledger rows, so a slot outlives an erased account as "Deleted
account" in the team's record and stays used). No STORE_COMPLIANCE change.

## Tests (test first)

- **Database** (`test/db/first-bonus.int.test.ts` new):
  - **The race (Done when)**: N = 50, 49 claimed; two completions on two connections released together: exactly one
    `first_bonus` entry with place 50, the other paid the quest's points only; repeated 20 times. N = 5 with 40
    concurrent completers on 8 connections: exactly 5 entries, places 1 to 5, unique. A claimer that rolls back after
    taking a slot leaves it free for the next.
  - **The door table** (one row per door: QR, code, location, NFC, screen QR, kiosk, my-QR, vote, live poll, survey,
    share, passport, submission approval and auto-approve, quiz, game, meet both sides): the first completion claims;
    a repeat never; a manual award never and takes no slot; a practice scan never, takes no slot lock (a real claim at the
    same moment gets the last slot) and answers `bonus_points`; the used-up quest pays points only and takes no lock
    (`pg_locks` probe).
  - **Amounts**: never boosted under a running boost; no XP row; balance 0 with the shop closed; score and the returned
    score hold both entries; the category bonus and the quest item still pay once.
  - **The setter**: on, off, points change before any real claim, `first_bonus_paid` after one, `below_given`, raise,
    lower, Stop; an editor out of scope (AN404); archived and results final; an edit during an in-flight claim (crossed:
    the edit waits; a claim during an edit waits and pays the new amount); audit rows.
  - **Rehearsal**: rehearsal accounts claim 3 of 5; the go-live wipe (by the first real completion and by the tick)
    gives the 3 back; Erase rehearsal likewise; points editable after rehearsal claims.
  - **Removal**: the bonus line removed on its own; the quest line's removal leaves it; neither frees the slot; replay;
    `credit_item` gives nothing for the kind.
  - **Readers**: `first_bonus_left` counts; `own_first_bonus` only the caller's completion; `member_event_quests`'s
    place; `live_state`'s set (not played, playable, left > 0); `community_read_slice` counts the bonus; the ledger
    shape CHECK refuses forged rows (no completion, a boost, a negative amount, a second bonus per player and quest).
  - **The completeness map**: `PAYER_MAP` gains `pay_first_bonus: "never: the organizer's fixed bonus (never-boosted
    test)"`; a new assertion that `record_completion` and `pay_completion` both call `pay_first_bonus`, and that every
    function listed as a `caller` reaches one of them.
- **Security**: outsider: the two tables closed to `anon`, `PUBLIC` and the API role; every new function refused to
  `anon` and `PUBLIC`, `pay_first_bonus` not granted to the API role. Cross-tenant: an editor of A sets nothing on B's
  quest; `first_bonus_left` and the quests read of B give A's member nothing; `own_first_bonus` of another player's
  completion is empty. `routes.int.test.ts` unchanged (no new route).
- **Route/unit**: the builder's validation and error maps, the 2-second cache (one query for concurrent callers, a
  fresh one after 2 s, an error not cached), `/live`'s field and ETag change, completion answers on a replay, the
  `practice:` key refused at the routes.
- **App**: ribbon states (left, all taken, mine), the success card's won and missed lines, history label, RTL and
  Arabic, `expo export`. **Web**: builder fields, locked state, Stop, the list line, the remove hint; e2e
  `first-bonus.spec.ts` (desktop and phone): set N = 2, two players complete, the third sees "All taken".
- **Mutation (GitHub)**: `apps/api/src/quests/first-bonus.ts`, `apps/api/src/quests/builder.ts`,
  `apps/api/src/completions/complete.ts`, `apps/api/src/plays/live.ts`, `packages/shared/src/quests/first-bonus.ts`.

## Phases (CTO code review once, at the end)

1. Migration 0062, the database, race, crossed-lock and security tests, the `completion_id` join sweep, the timing by
   hand (stop for the CTO if over budget).
2. API: builder, cache, `/live`, quests read, completion answers, shared types.
3. App, dashboard, strings; docs: API.md, DATA_MODEL.md, SECURITY.md, rules.md lock line, SRS FR-1840 (done),
   FEATURES F-342, DECISIONS, OPEN_QUESTIONS, TASKS (tick), STATE.

## Proposed decisions and questions

- **ADR-260** The count: one row per slot claimed with `FOR UPDATE SKIP LOCKED`, last in the completion, under the
  bonus row `FOR SHARE` (the setter's `FOR UPDATE` serializes edits against claims); a counter row and an advisory lock
  rejected for queueing every claimer on one lock.
- **ADR-261** What counts: a player's first completion of the quest through any door, at its pay moment (approval,
  quiz finish, game result); never a repeat, a period refresh, a manual award or a practice scan; rehearsal claims are
  wiped at go-live; never boosted, no XP; a removal never frees a slot.
- **ADR-262** The builder: 1 to 100,000 points, 1 to 1,000 players; points and switching off lock at the first real
  bonus; N may change to any value ≥ the bonuses given; Stop = N set to given.
- **ADR-263** The live count: counted from the slots, cached per event for 2 s in the API, in `/live` and the quests
  read; the player's own place from SQL.
- **Q-223** A removal (cheating, a mistake) keeps the slot used, so the organizer's N is the most ever paid. Agree, or
  should removing the bonus line give the slot back to the next completer?
- **Q-224** One bonus per player per quest, ever, also on repeatable and daily quests. Agree, or should a daily quest
  have "first N each day"?
- **Q-225** Manual quest awards take no slot and pay no bonus (as boosts). Agree, or should a team award count as one
  of the first N?
- **Q-226** At most 1,000 players per bonus. Enough, or raise it (the slot rows grow with N; 10,000 is still small)?
