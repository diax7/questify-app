# T-306c — Unlock rewards

FR-247's last reward: a community step that **unlocks a quest, a category or a shop reward** (F-101; split from T-306
by ADR-219). T-306b built the goals, their steps and `community_reach` (a step reached stays reached); this task adds
the `unlock` reward and the one gate every quest and shop door and reader must pass. **Core bar**: the gate sits in
`quest_open_check` (through `category_lock`) and `reserve_reward`, the completion and redemption paths: one Opus plan
review, one Opus code review, mutation on GitHub. Migration **0054** (new file; CranL runs through 0047, so 0053's
functions are changed here by restating them, never by editing 0053). Depends on T-306b (goals, steps, reach), T-304
(the category locks this copies), T-304c (hidden categories), T-211 (rehearsal), all done.

Dhia is away: open choices are my recommendation, written as **Proposed** ADR-227 to ADR-229 and Q-191 to Q-193.

**CTO plan review 2026-10-24: 84/100, findings folded in** (operators no longer pass the lock; a missed lock no longer
blocks other quests or categories; the completeness test covers every granted reader; the counted quest's category
refused; Arabic wording without the counted noun and a "starts" note; the switch-off warning; closed poll results and
Send; the Home goal card; one lock computed per row; the ADRs and Qs written to DECISIONS and OPEN_QUESTIONS). Each is
marked "(CTO n)" below.

## What T-306b built that this plan builds on

- `community_step.reward` is `points | moment | nothing` (0053:73); the builder writes steps wholesale before the start
  and `community_locked_field` (0053:584) freezes them after it, so an unlock's step and target cannot move under
  players once the goal starts (the T-306b note in TASKS).
- `community_reach (step_id PK, reached_at, progress)` is written once by `settle_goal` (on settled plus the shown
  tail, so a reach lands within one 5 s tick) and never deleted (`RESTRICT`); a later removal never un-reaches.
- Every community writer runs `ensure_rehearsal_wiped` first; no community row names a rehearsal account; goals never
  run in rehearsal (Q-186).
- `member_community` (0053:1077) builds the bar's steps for `live_state`; the app reads `/live` once for the event's
  tabs (`LiveProvider`).

## The unlock (FR-247; ADR-227)

A step whose `reward = 'unlock'` names **exactly one target** in its own event, in one of three new columns:
`unlock_quest_id`, `unlock_category_id`, `unlock_reward_id` (composite keys `(x, event_id)` to `quest`, `category`,
`reward`, all of which already have `UNIQUE (id, event_id)`). The keys are `NO ACTION`, not `RESTRICT`: a direct delete
of the target is refused the same way, but a draft event's cascading delete checks at the statement's end, whatever
order the cascade visits goal and target in (a test deletes a draft event holding an unlock goal; the same test runs
for 0053's `RESTRICT` goal keys, and if it fails there a change to `NO ACTION` for those goes into 0054 too).

- **What is locked, and when.** A target is locked while a step names it and that step has no `community_reach` row.
  The lock starts the moment the goal is saved (even before its window opens: "locked until the community gets there")
  and ends at the reach. It is **the same for every player** (the reach is the crowd's), so the gate takes no member.
  Deleting a goal before it starts (the only time it can be deleted) removes its locks.
- **One lock a target**: unique partial indexes on each of the three columns (across every step of the event, reached
  or not), so a target unlocked once can never be locked again by a later goal (`GL409 unlock_taken`).
- **Refused targets** (`CG422`, DETAIL `unlock`, HINT the reason; the API's `422 invalid_goal {issues}`): not in this
  event (`unlock_target`), a live poll (Send and Close own its window, ADR-220), a removed reward, the quest or category
  the goal itself counts, or the category of the quest it counts (`unlock_counted`, CTO 4: a `completions`/`players`
  goal on quest X could never count past 0 if its step locks X or X's category). A `points` or "every quest" goal may
  lock any other quest.
- **A missed step stays locked** for the rest of the event (ADR-229): the goal was missed, so its reward is not given.
  The event switch off ends running goals as `missed` (ADR-226), so their unreached unlocks stay locked too; the
  switch's confirm dialog and the builder form say so ("Turning this off ends the running goal; what it would unlock
  stays locked", CTO 6). The platform switch off lets running goals finish (ADR-226), and a reach there still unlocks.
- **A missed lock never blocks anything else** (CTO 2). A quest whose own lock is missed can never be done, so
  `category_cleared`, `category_done` and the in-order check of `category_lock` leave it out, as they leave out live
  polls (0052:62-105); a category locked as a whole whose lock is missed counts as met for a category that unlocks
  after it, as an unrevealed hidden one does (0046:251). A lock still **waiting** counts as today (its quests are not
  done): leaving it out would open the later quest or category and then shut it again at the reach, since these checks
  are evaluated live. Tests: in-order successor of a missed quest opens; `unlock_after` successor of a missed category
  opens; the category of a missed quest still pays its bonus once the rest is done; a waiting lock holds all three.
- **What passes the lock**: an owner's or editor's manual award (`skip_category` with no operator), exactly as it
  passes every category rule (0046:277). **An operator's capped award does not** (CTO 1): `operator_award` (0030:502)
  reaches `record_completion` with `proof_method = 'manual'` too (0032:819), so `record_completion` checks
  `quest_community_lock` itself when `proof_method = 'manual' AND operator IS NOT NULL` (`QN403 community_locked`), and
  `operator_award_quests` (0030:550) leaves locked quests out. Also passing: a replayed request (same key, first
  answer); the desk handing over a redemption made before the goal was saved; a submission sent before the lock
  appeared and approved after (approval does not re-check the window, as today for a closed quest).
- **Builder body**: a step's `reward` gains `{kind: 'unlock', target: {kind: 'quest' | 'category' | 'reward', id}}`.
  `community_body_steps` returns the three target columns; `community_locked_field`'s step comparison includes them
  (a started goal's unlock is `goal_locked`, field `steps`); `community_goals` returns each target with its names and
  kind for the Community page.
- **Deleting a target** a step names: the quest and category builders already map `23503` on `community_goal` to `409
  goal_in_use` (`quests/builder.ts:410`); the mapping gains the table `community_step`. Rewards are never deleted, only
  `removed` (a status update, which a foreign key does not block).

### The gate (internal, `REVOKE ALL … FROM PUBLIC`)

- `quest_community_lock(quest_row quest) RETURNS uuid`: the step holding the quest shut, the quest's own first, then its
  category's; NULL when free. Two primary-key-sized lookups by the partial unique indexes, then the reach by its key.
- `reward_community_lock(reward_row reward) RETURNS uuid`: the same for a reward.
- `community_lock_missed(step uuid) RETURNS boolean`: the step's goal is final (or `missed`) without a reach. Used by
  the CTO 2 rules above.
- `community_lock_note(step uuid) RETURNS jsonb` (no member, CTO 11): what a player is told, NULL for a NULL step:
  `{goalId, title: {ar, en}, measure, threshold, state: 'scheduled' | 'waiting' | 'missed', startsAt}` (`scheduled`
  while the goal's `settled_until` is NULL, so the note can say when it starts, CTO 5; `missed` as above). It names the
  goal and its numbers only, never the target.

## Every door and reader the gate reaches

Latest definitions found by grepping the migrations; "via" means the function is not restated and reaches the gate
through the one it calls.

| Path (latest file) | How the gate reaches it | Test (`test/db/community-unlocks.int.test.ts` unless said) |
|---|---|---|
| `category_lock` (0052:82), restated | `community_locked` checked **first** (`quest_community_lock(quest_row) IS NOT NULL`), then 0052's `category_not_started`, `category_locked` (a missed whole-category lock counts as met), `order_locked` (missed-locked quests left out) | each reason's precedence with a lock present; the missed cases (CTO 2) |
| `category_cleared`, `category_done` (0052:62-78), restated | missed-locked quests left out (CTO 2) | successor and bonus tests above |
| `quest_open_check` (0046:279) | via `category_lock`: `QN403 community_locked`; `skip_category` (manual award) passes, as for every category rule | an owner's manual award of a locked quest pays |
| `record_completion` (0050), restated | `proof_method = 'manual' AND operator IS NOT NULL` → `quest_community_lock` checked (CTO 1) | door table: operator award refused |
| `operator_award_quests` (0030:550), restated | `AND quest_community_lock(q) IS NULL` (CTO 1) | locked quest absent, present after the reach |
| `record_completion` (0050) and its callers `complete_quest` (0048: scan, typed code, location), the operator's scan (`operators/scan.ts`), `vote_quest` (0052) | via `quest_open_check` | **door table** (below) |
| `stamp_step`, `submit_quest` (0045) | via `quest_open_check` | door table |
| `play_enter` (0041): quiz start and answer (0041), survey and share (0042), `start_game_round` (0050) | via `quest_open_check` | door table; a quiz started before the lock appeared is refused on its next answer |
| `meet_may_play` (0049): `meet_player`, `issue_meet_pass`, `finish_game_round` (0050) | via `quest_open_check` | door table; a game round open when the lock appeared is refused at finish |
| `live_state` (0053:1105), restated | `polls` via `category_lock(q, …) IS NULL` (already there); `closed` gains `AND quest_community_lock(q) IS NULL` (CTO 7: it read `sees_category` only) | a live poll in a locked category is neither offered nor its results shown |
| `send_poll` (0052:321), restated | refuses a poll whose quest or category is community-locked (`PL409 community_locked`; the dashboard says why) (CTO 7) | Send refused while locked, sends after the reach |
| `member_event_quests` (0050:699), DROP and CREATE | `lock` can read `community_locked`; new column `community_lock jsonb` (`community_lock_note` of the quest's step, the category's included). The step is computed **once per row** in a `LATERAL` and both columns read it (CTO 10) | listed with the note: `scheduled`, `waiting`, gone after the reach; `missed` |
| `member_vote`, `member_quiz`, `member_survey`, `member_share`, `member_passport` (0046), `member_game` (0050:421), `member_poll` (0052:249), restated | `AND quest_community_lock(q) IS NULL`: no row (the sheet's content is part of the reward) | each answers nothing while locked, its content after the reach |
| `public_event_quests` (0046:483), restated | leaves out a quest whose quest or category is community-locked, as it leaves out hidden categories | public page omits, then lists after the reach |
| `member_community` (0053:1077), restated (feeds `live_state.community`) | a step's reward `{kind: 'unlock', target?: {kind, id, name: {ar, en}}}`; `target` only when the player sees it (below) | hidden unrevealed, revealed, out of audience, removed reward |
| `shop_rewards` (0047:924), DROP and CREATE | new column `community_lock jsonb` (the reward's note) | listed with the note; after the reach without |
| `reserve_reward` (0037:423), restated | after the reward `FOR UPDATE` and the audience check, before the shop state: `RW403 community_locked` | refused while locked, reserves after the reach; replayed key still answers |
| `event_shop`, `my_redemptions`, the desk readers | unchanged: no per-reward offer; a redemption made before the lock is handed over as usual | handover of an earlier redemption |
| `reveal_category` (0046) | unchanged: revealing a hidden, community-locked category shows it, locked | reveal then list with `community_locked` |
| `set_goal` (0037:284) and the Home goal card (`home/goal.ts` `pickGoal` over `shop_rewards`) | a player may still pin a locked reward (it is a thing to aim for); the card shows its lock note instead of "{n} to go"; the automatic pick skips locked rewards (CTO 8) | DB: pin a locked reward; route: the card's `communityLock`; unit: `pickGoal` skips locked |
| Home (`home/home.ts`) | reads `member_event_quests` and `shop_rewards`: covered | route test: Home's quest and shop rows carry `communityLock` |
| `/live` (`plays/live.ts`) | `live_state` above | route test: the step reward and the ETag moving at the reach |
| Public event page (`join/join.ts` → `public_event_quests`) | SQL above | route test |

**The door table**: one table-driven test, one row per door above (scan, typed code, location, operator scan, owner's
manual award, operator's award, vote, live poll vote, quiz start, quiz answer, survey, share, passport stamp,
submission, game start, game finish, meet code, meet pass, reserve), each run twice: the quest (or reward) locked itself
and its category locked. While locked each answers `QN403 community_locked` (`RW403` for reserve; the owner's manual
award pays); after `settle_goal` reaches the step each succeeds.

**The completeness test** (CTO 3): it lists every function `questify_app` may execute
(`has_function_privilege('questify_app', oid, 'EXECUTE')`) whose source (`pg_proc.prosrc`) reads `quest`, `category`
or `reward` (`\m(quest|category|reward)\M` after a FROM or JOIN), and checks each against a map checked into the test:
`gated` (a door or reader above, each with its test), `staff` (a team or console door that authorizes an owner, editor
or operator first; operator doors that offer quests are gated, above), or `exempt` with a one-line reason (for example
`my_redemptions`: a redemption already made). A function missing from the map, or mapped to a name that no longer
exists, fails the test, so a later reader or door cannot skip the gate unseen.

## How the app shows a locked item (ADR-228)

The locked item stays **listed** where the player could already see it, with a lock line; it is never shown where it
was not shown before:

- **No leak of hidden categories.** Every reader keeps its `sees_category` / `in_audience` filters before the gate: an
  unrevealed hidden category, or one outside the player's audience, is still absent. The lock note names the goal
  (title, measure, threshold), never the target. The bar's unlock marker carries a `target` only when the player
  sees it: a category by `sees_category`; a quest by `q.visible` and `sees_category` of its category; a reward by
  `status = 'active'` and `in_audience`. Otherwise the marker reads "Unlocks a surprise" with no kind, id or name. The
  dashboard form says that the goal's title is shown to every player, so it should not name a hidden category.
- **Quests tab**: the quest's state is `locked` with lock `community_locked`; the line under it: "Unlocks at {threshold}
  community points" (by measure, below), or "Not unlocked: the community goal was missed". A category locked as a whole
  gets the line once as a category note (`categoryNotes` gains `{kind: 'community', note}`), as `unlockAfter` does.
  The sheet does not open the entry of a locked quest (as for every lock today).
- **Shop**: the card shows the same line instead of the price button; tapping it explains, never reserves.
- **The bar**: a step marker with a padlock and the target's name, or "a surprise".
- **On the reach**: `LiveProvider` notices a step with an unlock reward newly `reachedAt` and refetches the quests and
  shop reads (they are not cached on the server; Home and the tabs refetch now); a one-time card ("Unlocked: {name}" or
  "Something new is unlocked") joins the poll card's queue and remembered list.
- **Older apps** (F-282): an unknown lock shows the generic "Locked" line (`quests-api.ts` keeps unknown locks out of
  `LOCKS`); an unknown shop field is ignored and a reserve answers `403 reward_not_open {reason: 'community_locked'}`,
  which they already show as "not open"; an unknown bar reward kind shows the marker without text. App tests prove
  each.

Strings (Arabic via `ux-araby` at build, Western digits, RTL checked; drafts):

| Key | English | Arabic |
|---|---|---|
| community.unlock.points | Unlocks at {threshold} community points | يُفتح حين تبلغ النقاط الجماعية {threshold} |
| community.unlock.completions | Unlocks at {threshold} community completions | يُفتح حين تبلغ المهام المنجزة جماعيًا {threshold} |
| community.unlock.players | Unlocks at {threshold} players taking part | يُفتح حين يبلغ عدد المشاركين {threshold} |
| community.unlock.starts | Unlocks with a community goal that starts {time} | يُفتح مع هدف جماعي يبدأ {time} |
| community.unlock.missed | Not unlocked: the community goal was missed | لم يُفتح: لم يتحقّق الهدف الجماعي |
| community.reward.unlock | Unlocks {name} | يفتح {name} |
| community.reward.surprise | Unlocks a surprise | يفتح مفاجأة |
| community.unlocked | Unlocked: {name} | فُتح: {name} |
| community.unlockedSurprise | Something new is unlocked | فُتح شيء جديد |
| questsTab.notOpen.communityLocked | Opens when the community goal is reached | يُفتح عند تحقيق الهدف الجماعي |
| shop.communityLocked | Unlocks with the community goal | يُفتح مع الهدف الجماعي |

The Arabic keeps the number after its noun phrase (no counted noun), so it reads right for every number (CTO 5); the
`ux-araby` pass at build keeps that rule. A `scheduled` note uses `community.unlock.starts`; the waiting ones are
shown once the goal runs.

Plus the builder's labels ("Unlock", "What it unlocks", "A quest", "A category", "A shop reward", the title hint), the
switch-off warning (CTO 6: "Turning this off ends the running goal; what it would unlock stays locked" / "إيقافها
يُنهي الهدف الجاري، ويبقى ما كان سيفتحه مقفلًا"), Send's `community_locked` refusal, and the builder's refusals
(`unlock_taken`, `unlock_counted`, `unlock_target`).

## Rehearsal and the go-live wipe (ADR-229)

- The gate only **reads** steps and reach rows. Reach rows exist only after a goal ran, and goals run only after the
  go-live wipe (every community writer wipes first, T-306b), so no reach is ever a rehearsal's and the wipe never has a
  community row to delete: nothing re-locks at go-live, and nothing is unlocked by rehearsal play.
- The doors keep their order: `ensure_rehearsal_wiped` first (play_enter, record_completion's callers,
  `reserve_reward`), then the locks, then the gate inside `quest_open_check` / after the reward lock. The gate adds no
  write, so it needs no ordering of its own.
- **In rehearsal a target shows locked**, as players will see it at the start (goals do not run in rehearsal, Q-186),
  and the rehearsal shop (always open) refuses it. The Community page's preview shows the unlocked marker. Test: a
  rehearsal account sees the lock; the event goes live; the wipe runs; the lock holds until the step is reached.

## Races and lock order

| Case | Outcome |
|---|---|
| A goal saved while a player reserves its target reward | the step insert takes `KEY SHARE` on the reward (its foreign key); `reserve_reward` takes the reward `FOR UPDATE`, so one waits for the other; the gate is a later statement, so under READ COMMITTED it sees the committed step. Exact. Crossed-lock test, both orders. |
| A goal saved while a player completes its target quest | completions do not lock the quest row, so a completion whose check ran before the save committed is paid. Accepted: the lock is "not yet", and nothing is paid twice (ADR-227). |
| The reach while a player plays | the reach only opens: a play refused just before it succeeds on retry. |
| Lock order | `save_community_goal` unchanged (rehearsal → advisory → goal → steps, whose inserts take `KEY SHARE` on the targets); `reserve_reward` unchanged (rehearsal → enrollment → reward); the save never locks an enrollment, so no cycle. rules.md's lock-order paragraph gains the target's `KEY SHARE`. |

The gate's cost: `member_event_quests` calls `quest_community_lock` per row (two index probes on the partial unique
indexes, usually empty). There is no quest-list timing test today; the database test reads `EXPLAIN` of
`quest_community_lock` once to prove both probes use the partial indexes (no new timing file).

## API

- Team: the goal body's step reward `unlock` (`community/goals.ts` schema); refusals `422 invalid_goal {issues}` with
  `unlock_target` / `unlock_counted`, `409 unlock_taken`; `GET …/community-goals` returns each step's `unlock {kind, id,
  name}`. Quest and category delete: `409 goal_in_use` also for `community_step`.
- Player: `GET /v1/events/{id}/quests` (and Home): `lock` may be `community_locked`, each quest gains `communityLock:
  {goalId, title, measure, threshold, state} | null`; the shop's rewards gain the same `communityLock`; reserve refusal
  `403 reward_not_open {reason: 'community_locked'}`; completion and play refusals `403 quest_not_open {reason:
  'community_locked'}` (the existing `QN403` mapping). `/live`: a step's `reward` may be `{kind: 'unlock', target?}`.
- Public: `GET` of the event page leaves locked quests out (no shape change).
- `http-errors.ts` gains the new codes; `routes.int.test.ts` already classifies every route touched (none new).

## Data (migration 0054)

- `community_step`: drop and re-add the reward check with `unlock`; the three target columns and their composite keys
  (`NO ACTION`); `CHECK ((reward = 'unlock') = (num_nonnulls(unlock_quest_id, unlock_category_id, unlock_reward_id) =
  1))` and no target on another kind; unique partial indexes on each target column. No new table, no grant change (the
  table stays closed, RLS forced).
- Functions (each `REVOKE ALL … FROM PUBLIC` here; grants unchanged on the restated doors): new internal
  `quest_community_lock`, `reward_community_lock`, `community_lock_missed`, `community_lock_note`; restated
  `category_lock`, `category_cleared`, `category_done`, `record_completion`, `operator_award_quests`, `reserve_reward`,
  `member_vote`, `member_quiz`, `member_survey`, `member_share`, `member_passport`, `member_game`, `member_poll`,
  `live_state`, `send_poll`, `public_event_quests`, `member_community`, `community_locked_field`,
  `save_community_goal`, `community_goals`;
  DROP and CREATE `community_body_steps`, `member_event_quests`, `shop_rewards` (their outputs change; every grant
  re-issued).
- `wipe_rehearsal` and `erase_rows` are not restated: no new row names a player.

## Store compliance

The unlock opens content already in the event's data, decided by the server (Apple 2.5.2, remote config changes data
only). No money and no chance: a locked shop reward is bought with event points like any other once open. The review
notes gain one line; the demo event's running goal gets an unlock milestone.

## Tests (test first)

- **Database** (`test/db/community-unlocks.int.test.ts`): the door table; the readers above; builder: each refused
  target, `unlock_taken` across goals and after a reach, `unlock_counted`, a started goal's unlock `goal_locked`,
  delete before the start frees the target; target deletes `goal_in_use` (quest, category); the draft event delete with
  an unlock goal; reached stays reached after a removal lowers progress; missed stays locked (`state: 'missed'`); the
  event switch off; the platform switch off still unlocks; manual award passes; the rehearsal case; `category_lock`
  precedence; the missed-lock rules (CTO 2); operator award refused and `operator_award_quests` (CTO 1); closed poll
  results and Send (CTO 7); pinning a locked reward (CTO 8); the `unlock_counted` category case (CTO 4); the
  completeness check (CTO 3).
- **Crossed locks** (two connections): goal save and reserve of its target reward, both orders: either the reserve
  happened before the lock, or it is refused; never both a reservation and a lock that predates it.
- **Security**: outsider (the three new functions, `anon` and `PUBLIC`); cross-tenant: a goal of organizer A naming
  organizer B's quest, category or reward (`unlock_target`, never a foreign-key leak of B's ids); `live` never names a
  target the player does not see.
- **Route**: builder body and refusals; quests, Home, shop and `/live` shapes; reserve and completion refusals; public
  page.
- **App**: quest line and category note, shop card line, bar marker (named, surprise, unknown kind), the unlocked card
  and the refetch on reach, older-app fallbacks, RTL and Arabic; `expo export`. **Web**: the form's Unlock reward with
  the target picker (live polls and the counted quest absent, locked targets disabled) and its preview; e2e
  `community.spec.ts` gains an unlock milestone (desktop and phone).
- **Mutation (GitHub)**: `apps/api/src/community/goals.ts`, `apps/api/src/home/home.ts`, `apps/api/src/rewards/shop.ts`,
  `apps/api/src/plays/live.ts`.

## Phases (CTO code review once, at the end)

1. Migration 0054 + database, crossed-lock and security tests.
2. API: builder body and refusals, quests/Home/shop/`/live` shapes, refusal mappings, delete mapping + route tests.
3. App lines, notes, bar marker, unlocked card and refetch; dashboard form, picker and preview; strings; docs (API.md,
   DATA_MODEL.md, SRS FR-247 status and trace row, FEATURES, STORE_COMPLIANCE review note, rules.md lock order, TASKS,
   STATE).

## Proposed decisions and questions

- **ADR-227** The unlock: one target per step (quest, category or shop reward) in its own column; one lock per target
  for the event's life; locked from the goal's save until its step's reach, the same for every player; a live poll,
  the goal's own counted quest or category, a removed reward or another event's item cannot be a target; a manual
  award by an owner or editor passes it like every category rule, an operator's award does not; a missed lock never
  blocks another quest or category; a completion racing the save may be paid (a reservation cannot). Q-191.
- **ADR-228** Showing it: a locked item stays listed where the player already saw it, with a line naming the goal and
  its threshold, never the target; its sheet's content is not served; the public page leaves it out until unlocked;
  the bar names the target only to a player who sees it ("a surprise" otherwise); the app refetches on the reach and
  shows a one-time card. Q-192.
- **ADR-229** Missed and rehearsal: a missed step (or one ended by the event switch) leaves its target locked for the
  event, with no owner override; in rehearsal targets stay locked; the gate reads only reach rows, all written after
  the go-live wipe. Q-193.
- **Q-191** A community goal's unlock locks its quest, category or reward as soon as the goal is saved, even before the
  goal starts. Agree?
- **Q-192** A locked quest or shop reward is shown as locked with "Unlocks at 5,000 community points" (a teaser), not
  hidden until it unlocks; the public event page hides it. Agree, or hide it everywhere until unlocked?
- **Q-193** If the community misses the step, the item stays locked for the rest of the event and there is no "Unlock
  now" button; switching community quests off for the event ends its running goal as missed, so what it would unlock
  stays locked for good (the switch warns); during a rehearsal locked items stay locked. Agree, or add an owner's
  "Unlock now"?
