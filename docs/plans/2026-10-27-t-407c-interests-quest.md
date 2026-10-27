# T-407c — The "set your interests" Questify quest

Delivers FR-710's "set your interests" example. Depends on T-403b (the evaluator, migration 0066, restated in 0067 and
0068) and T-407 (`player_preference`, migration 0070). **CORE**: `player_metrics` feeds `questify_sync`, which pays XP
and gems. Choices are **Proposed ADR-320 / Q-290**. Never push, deploy, run EAS or run local mutation testing.

The reviewer's call (T-407 code review) holds: the metric counts **interests only**. A city alone is not "set your
interests".

**Plan review fold-in (92, GO):** Q-290 answered by the developer (100 XP, 10 gems); retiring the quest and adding a new
one pays everyone with interests again (noted in Q-290 and ADR-320; the console warns about a second one); the tests that
count seeded quests are updated; two more DB tests (a sync held on `player_xp` does not block a preference save; player
B's interests never count for player A); the outsider test for `player_metrics` already exists
(`security/outsider.int.test.ts`) and is not duplicated; the app compares against the shared `INTERESTS_METRIC`.

**Deploy note:** app builds installed today parse the quest list with the closed metric list (`events`, `cities`,
`quests`) and fail on `interests_set` once 0071 ships. Deploy the server together with a new app build that carries the
tolerant card schema.

## What changes, and what does not

- `questify_sync` (latest body in 0068), `questify_due`, `own_questify_quests` (0067) and `questify_quest_save` (0067)
  are **not restated**. They read `player_metrics` by name at run time, so a new metric row flows through them.
- `player_metrics(who, since, until)` gains one lifetime-only row. Nothing else in the payer's path changes.
- No new table, no new function, no new grant.

## Migration 0071 (new file; 0070 and earlier untouched)

```sql
SET LOCAL lock_timeout = '10s';
-- The only table altered or written. Never player, player_xp, xp_entry or player_preference: nothing here
-- writes them, and a sync waits on questify_quest only before it locks a player (its unlocked pre-check).
LOCK TABLE questify_quest IN ACCESS EXCLUSIVE MODE;

ALTER TABLE questify_quest
  DROP CONSTRAINT questify_quest_metric_check,
  ADD CONSTRAINT questify_quest_metric_check CHECK (metric IN ('events', 'cities', 'quests', 'interests_set')),
  -- A state, not a dated fact: it has no window, so it is always-on, and it is met or not, so its target is 1.
  ADD CONSTRAINT questify_quest_interests_shape
    CHECK (metric <> 'interests_set' OR (campaign_id IS NULL AND target = 1));

INSERT INTO questify_quest (metric, target, title_ar, title_en, xp, gems, position, status)
VALUES ('interests_set', 1, 'اختر اهتماماتك', 'Set your interests', 100, 10, 3, 'active');

CREATE OR REPLACE FUNCTION player_metrics(who uuid, since timestamptz, until timestamptz) ...
  -- 0066's body unchanged, plus:
  UNION ALL
  SELECT 'interests_set', (SELECT count(*) FROM player_preference f
                           WHERE f.player_id = who AND cardinality(f.interests) > 0)::integer
  WHERE since IS NULL AND until IS NULL
REVOKE ALL ON FUNCTION player_metrics(uuid, timestamptz, timestamptz) FROM PUBLIC;
```

- Value: 1 when the player's preference row holds at least one interest, else 0 (no row, an empty list, or a city
  only). The city column is never read.
- Lifetime only, like `top10` and `goals`: a bounded (campaign) call returns no `interests_set` row. The table CHECK
  keeps the metric out of campaigns, so no quest can exist that the evaluator could never meet (a seasonal card would
  otherwise vanish: `own_questify_quests` joins quest to progress on the metric).
- `achievements_due` and `own_achievements` join on `achievement.metric`, whose CHECK has no `interests_set`: the new
  row is filtered out there. `public_player_profile` does not read `player_metrics`; the row never leaves the caller's
  own doors (FR-733: interests are private).
- Seed: live from the deploy, so a player who already chose interests is paid at the next sync (ADR-279 precedent).
  100 XP and 10 gems: a one-tap action earns less than the 300 XP / 25 gems of the play quests. Amounts are data
  (XP editable in the console; gems fixed once the quest can pay, ADR-286). Q-290 asks Dhia.

## Lock order (no new edge)

The tables `player_metrics` reads, and who writes them: `xp_entry`/`ledger_entry` (scans, removals), `enrollment`
(join, leave, erasure), `final_rank` (result reveal), `community_contributor`/`community_goal` (goals), and now
`player_preference`. Only the last is new; its writers and the sync:

| Path | Order |
|---|---|
| `questify_sync` | unlocked pre-check (reads, incl. `questify_quest` and `player_preference`) → `player` FOR KEY SHARE → `player_xp` FOR UPDATE → award, XP, gems. Reads `player_preference` without a lock |
| `set_preferences` | `player` FOR NO KEY UPDATE (`marketing_player`) → `player_preference` upsert |
| `erase_rows` (via `erase_player`) | `player` FOR UPDATE → `player_xp` FOR UPDATE → delete `player_preference` |
| Migration 0071 | `questify_quest` ACCESS EXCLUSIVE only |

- KEY SHARE and NO KEY UPDATE do not conflict: a preference save and a sync never wait on each other. The sync takes no
  lock on `player_preference`, so no cycle can form through it. Erasure vs sync is unchanged (FOR UPDATE vs KEY SHARE;
  the sync re-checks `status = 'active'` after its lock).
- Snapshot: READ COMMITTED, one snapshot per statement. A save that commits before the sync's loop statement is paid in
  this sync; one that commits later is paid in the next. A player who sets and then clears before any sync is never paid
  (the metric is the state at sync time); that is accepted.
- Migration vs live traffic: a sync in flight holds ACCESS SHARE on `questify_quest` until it commits; the migration
  waits for it. A sync that starts after the migration queued blocks in its pre-check, before it holds any row lock.
  Scans, daily plays and preference saves never touch `questify_quest`. `lock_timeout` 10 s fails the deploy rather
  than stalling traffic.

## Idempotency and paid once

- Unchanged machinery: two crossing syncs serialize on `player_xp` FOR UPDATE; the second's loop re-runs
  `questify_due` (its `NOT EXISTS` award check) on a fresh snapshot; `UNIQUE (player_id, quest_id)` with `ON CONFLICT
  DO NOTHING` is the backstop, and `xp_entry.questify_award_id UNIQUE` and gems' one-row-per-award keep XP and gems to
  one each.
- Clearing interests later never takes the award back: `questify_award` is append-only and no removal path follows a
  `questify` XP row. The card stays `done`.
- The sync's HTTP door already takes no idempotency key (a replay pays nothing new); unchanged.

## API, shared, console, app

- `packages/shared/src/questify/quests.ts`: `QUESTIFY_METRICS` gains `interests_set` (console schemas). The
  player-facing `questifyQuestSchema.metric` becomes a plain bounded string (`z.string().min(1).max(32)`): the app never
  branches on an unknown metric, so a metric added later cannot make an installed build fail to parse the whole list.
  `questBodySchema`/`questPatchSchema` stay closed.
- `apps/api/src/questify/admin-routes.ts`: a `questOf(body)` check like `campaignOf`: `interests_set` with a target
  other than 1 answers 422 `invalid_questify {field: "target"}`; on create with a `campaignId`, `{field: "metric"}`.
- `apps/api/src/questify/admin.ts`: a 23514 on `questify_quest_interests_shape` (a PATCH that moves a campaign's draft
  quest to `interests_set`) answers `{field: "metric"}`; any other 23514 keeps the bare answer.
- Console (`ConsoleQuestify.tsx`): the metric option with its label (`console.questify.metric.interests_set`: «اختيار
  الاهتمامات» / "Interests chosen"); for that metric the target field shows 1 and is read-only, and the option is not
  offered for a campaign's quest.
- App: the quest card for `interests_set`, not done, shows a "Choose interests" button («اختر اهتماماتك») to
  `/interests` in place of "0 of 1". `InterestsScreen` calls `syncNow()` after a save that holds at least one interest,
  so the award notice appears at once. Strings in `messages.ts` in both languages; RTL checked; Western digits.

## Tests (test first)

DB, `test/db/questify-quests.int.test.ts`, a new `describe("set your interests (T-407c)")`:
1. The seed: one active always-on `interests_set` quest, target 1, 100 XP, 10 gems, position 3.
2. No preference row, an empty list, and a city with no interests: progress 0, a sync pays nothing.
3. One interest: the sync pays one award, one `questify` XP entry, `player_xp` total and level follow, one gem entry of
   10; the answer lists the quest; a replay pays nothing.
4. Two syncs crossing (two connections, the first held open after its award): one award, one XP entry, one gem entry;
   only the first reports it.
5. A preference save held open (uncommitted, holding `player` FOR NO KEY UPDATE) does not block a sync (it answers
   within the test's statement timeout) and that sync pays nothing; after the commit the next sync pays.
6. Clearing interests after the award: the award, XP and gems stay; the card is `done`, progress 0.
7. Set then clear before any sync: nothing is paid.
8. `player_metrics(who, since, until)` with bounds has no `interests_set` row; unbounded has it; `own_achievements`
   still lists exactly its five achievements.
9. Refusals: the table refuses `interests_set` in a campaign and with target 2 (owner insert, 23514 named); the console
   door refuses both; a PATCH of a campaign draft to `interests_set` fails on the named constraint.
10. A deleted or banned player: the sync refuses (PI401) and nothing is written.

Upgrade, new `test/db/interests-quest-upgrade.int.test.ts` (the `streaks-upgrade` pattern): a database at 0070 with a
veteran who chose interests; a sync in flight blocks the migration until it commits; the migration's first statements
lock exactly `questify_quest` ACCESS EXCLUSIVE; after it, the veteran's next sync pays once; the seeded quests and old
awards are unchanged.

Security: no new table or function, so the outsider and cross-tenant lists keep their entries; the existing outsider
assertion that `player_metrics(uuid, timestamptz, timestamptz)` is closed (`security/outsider.int.test.ts`) covers the
restatement (CREATE OR REPLACE keeps the ACL; the migration revokes anyway). Rehearsal and
gate-map guards run in the final full suite.

Unit and route: shared schema (`QUESTIFY_METRICS`, the player card accepts an unknown metric, the console schemas
refuse one); `admin-routes.test.ts` (target 2 → field `target`, campaign → field `metric`, a good body passes);
`admin.test.ts` (the named 23514 → field `metric`, another 23514 → bare); app (`QuestCard` shows the button only for an
undone `interests_set`; `InterestsScreen` calls `syncNow` after a save with interests and not after an empty save or a
failure); web console unit test for the option, the locked target and the campaign case; `console-questify.spec.ts`
run.

Mutation targets (GitHub, core TS only, files this task changes): `apps/api/src/questify/admin.ts`,
`apps/api/src/questify/admin-routes.ts`, `packages/shared/src/questify/quests.ts`.

## Docs

`DATA_MODEL.md` (the metric list and CHECK), `API.md` (metric values, the 422 fields, the tolerant card schema),
`SRS.md` FR-710 trace row, `DECISIONS.md` ADR-320, `OPEN_QUESTIONS.md` Q-290, `TASKS.md`, `STATE.md`.
