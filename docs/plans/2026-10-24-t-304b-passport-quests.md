# T-304b — Passport quests

Delivers FR-224 (F-90): a quest made of steps the organizer chooses, done in any order, each step its own signed QR,
progress "4 of 5", the quest's points paid once on the last needed step. Split from T-304 (ADR-200). **Core bar** (it
pays points through the ledger and adds a signed QR proof): one Opus plan review, one Opus code review, mutation on
GitHub. Migration **0045** (0044 is T-304). Depends on T-104 (signer), T-105 (completion engine), T-304 (gates, bonus).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-203 and Q-167.

## The type

- Registry (`packages/shared/src/quests/registry.ts`): `passport`, `oneTry: false`, `usesQuestQr: false` (the quest
  has no QR of its own; its steps do), `verifications: []`, config `{needed: integer 1..30}`. `quest_type_known` widens.
- `repeat_cap` is 1 for a passport (CHECK `type <> 'passport' OR repeat_cap = 1`): a passport is finished once.
- Steps live in a table, not in `type_config`, so each has an id to sign and a version to reprint.

## Tables (deny by default: no API grant; written only by definers; RLS on, tenant FKs, RESTRICT)

| Table | Columns | Notes |
|---|---|---|
| `passport_step` | `id`, `organizer_id`, `event_id`, `quest_id`, `name_ar`, `name_en`, `position`, `qr_version` (default 1), `created_at` | `(quest_id, event_id)` → `quest (id, event_id)`; at least one name (FR-1008); at most 30 per quest (trigger under the event's advisory lock, as categories) |
| `passport_stamp` | `organizer_id`, `event_id`, `enrollment_id`, `quest_id`, `step_id`, `idempotency_key`, `device_id`, `created_at` | PK `(enrollment_id, step_id)`; UNIQUE `(enrollment_id, idempotency_key)`; `(step_id)` → `passport_step` RESTRICT |

(`passport_stamp` here is a step stamp. The Event Passport's per-event stamp in DATA_MODEL (FR-709, T-4xx) is renamed
`event_stamp` there in the same change, so the two never share a name.)

## Edit rules (builder; live edits take `confirm` as today)

- `needed` must be 1 to the number of steps; a passport with no steps cannot be made visible.
- Once any player has a stamp on the quest: a stamped step cannot be deleted (`409 step_in_use`), and `needed` may
  rise but never fall (`422 invalid_quest {field: "needed"}`): lowering it would leave players at the new count unpaid
  with nothing left to scan. Adding, renaming and reordering steps stay allowed. Raising `needed` takes nothing back
  from a player already paid.
- Deleting a passport quest with stamps answers `has_completions` (`apps/api/src/quests/quests.ts:126`), as one with
  completions; a quest with steps and no stamps deletes its steps first (the quest delete in `quests.ts`, and
  `deleteQuestsOf` in `store.ts` for a category delete).

**Held by the database too** (the `quest_lock_played` pattern, 0042:91-104; the API's checks only give the friendly
answer):
- `quest_lock_passport` BEFORE UPDATE OF `type`, `type_config`, `visible` ON quest, for passports: the type cannot
  change away from `passport` once it has steps (`QL409`); `needed` cannot fall once it has stamps (`QL409`); `needed`
  stays ≤ its step count, and a passport with no steps cannot be visible (`QT422`).
- `passport_step_guard` BEFORE DELETE ON passport_step: refuses a stamped step (`QL409`, the RESTRICT FK backs it) and
  a delete that would leave fewer steps than `needed`, or none on a visible passport (`QT422`).
- `quest_completion_method_check` gains `passport`; `record_completion` gives a passport no player method (only
  `manual`).

## The signed step code (ADR-203)

- `apps/api/src/quests/qr.ts`: purpose `step`, format byte **0x04**, its own derived key; `stepCode(key, stepId,
  version)`, `verifyStepCode(key, token, expectedStepId)` → `{valid, stepId, version} | not_questify |
  forged | wrong_step`, bound to the step in the route's path as `verifyQuestCode` is to its quest (qr.ts:141-157;
  the id comparison is a mutation target). Same 37-byte layout,
  so the `/q/{token}` web page and the app's scanner read it unchanged in shape. A step code never opens as a quest
  code, My QR or invite (format byte and key both differ).
- Codes page (`apps/api/src/quests/codes.ts`): a passport lists one code per step (name, URL, version), each
  regenerated on its own (`qr_version + 1`; old prints answer `invalid_code {problem: "old"}`).

## Stamping (paid by the database)

`stamp_step(step uuid, proof_version integer, request_key text, device uuid)` (SECURITY DEFINER, player only):

1. The request key: 1 to 255 characters, not starting `sub:`, `quiz:` or `pass:`. **`pass:` is reserved in every
   player key check** (`record_completion`, the submission send at 0040:293, the play paths at 0041:788 and the
   others), with tests on `/complete` and on a submission.
2. Find the step and its quest (`QC404` if none); `QT422` unless `quest_row.type = 'passport'`;
   `ensure_rehearsal_wiped`; lock the enrollment `FOR NO KEY UPDATE` (the lock every payer holds, so two parallel
   last stamps pay once).
3. Replay: a stamp with this key returns its earlier answer, the paying one included (`completed` with `levelUp` and
   `bonus` read again through `own_level` and `own_bonus` by its completion); the same key on another step → `QK422`.
4. `quest_open_check(quest, enrolled)`: live event, window, visible, audience and T-304's category gates.
5. Already finished (a completion on the quest, by stamps or a manual award) → `QD409` cap 1.
6. Version, after the replay and the refusals above: `proof_version <> step.qr_version` → `QV422 old` (an old print).
7. Same step stamped before → the progress with `stamped: false` (nothing written).
8. Insert the stamp (with `device_id`). When the stamps are now **≥ `needed` and the quest has no completion**, call
   `pay_completion(enrolled, quest, points, 'passport', 'pass:' || quest_id, NULL, NULL)` once. The completion key
   is fixed-length and unique per enrollment and quest (a player key would break the 255 limit, 0012:44); a replay
   finds the paying stamp's completion through it. The payment brings the quest credit, XP through `ledger_xp`, the
   category bonus through T-304's payer and the shop-closed balance rule. `device_id` stays on the stamp row (the
   paying completion has none; account erasure clears the stamp's). Returns `{completion_id | null, stamped, done,
   needed, score, balance, replayed}`.

Steps pay nothing on their own (FR-224). Removal stays ADR-152: the quest credit is removable; the completion and the
stamps stay, so it is never paid again. A manual award finishes the quest without stamps. No station or My QR path for
steps in this task (Q-167).

## API (API.md)

- `POST /v1/steps/{stepId}/stamp` `{code}` + `Idempotency-Key` → `{questId, stamped, done, needed, completed:
  Completed | null}` (`completed` the usual completion answer with `levelUp` and `bonus` when the stamp finished the
  passport). Refusals as `/complete`: `400`, `401`, `403 quest_not_open {reason}` / `enrollment_inactive`, `404`,
  `409 already_completed`, `422 invalid_code {problem: not_questify | forged | old}` (forged logged as today, never the
  token; a valid code of **another step** answers `not_questify`), `422 key_reused`, `422 invalid_quest` (not a
  passport). The ranking is updated after a paying stamp, as `/complete` does.
- `GET /v1/events/{id}/quests`: each quest gains `steps: {done, needed} | null`; `member_event_quests` is DROPped
  and CREATEd from 0044's version with `steps_done`, `steps_needed` (REVOKE and GRANT repeated).
- `GET /v1/quests/{id}/passport` (active member, quest visible to them) → `{needed, steps: [{id, name, done}]}` in
  `position` order. Never a step's code.
- Builder: the quest object gains `needed` and `steps: [{id, name, position}]`; `POST/PATCH/DELETE
  …/quests/{id}/steps[/{stepId}]`.

## Cleanup paths (each replaced from 0044's latest version)

- `wipe_rehearsal`: deletes the rehearsal's `passport_stamp` rows before its completions and ledger rows.
- `erase_rows` (account erasure; 0038's RESTRICT FKs): deletes the player's `passport_stamp` rows.
- Quest and category delete: steps go first when no stamps exist (above).

## App and dashboard

- **App:** the scanner reads format 0x04 (`stepIdOf`) and posts to the stamp route; the sheet says "Stamp {done} of
  {needed}" or, on the last one, the usual success with points and bonus. The quest card shows "{done} of {needed}"
  and a passport detail lists the steps with a tick on each done one. An old print reuses the existing `old` copy
  (the code was replaced; ask the organizers for the new one). Strings in `messages.ts` (Arabic via
  `ux-araby`), RTL checked, Western digits.
- **Dashboard:** the quest form's passport fields (needed, the step list: add, rename, reorder, delete) and the codes
  page's step codes (print each).
- **Web:** `/q/{token}` accepts a step token the same way as a quest token (opens the app).

## Tests (test first)

- **Database** (`passport.int.test.ts`): 4 of a "5 of 8" is not paid and reads 4 of 5; the fifth pays once (ledger,
  XP, category bonus); two parallel last stamps pay once; the same step twice writes nothing; a replayed key returns
  the same answer, **the paying stamp's replay too (completed, levelUp, bonus)**; a reused key on another step
  refuses; `pass:` keys refused on `/complete`, a submission and a stamp; a non-passport quest's step refuses
  (`QT422`); **"refuses an old step print" (`QV422 old`)**, checked after a replay; the triggers (type change with
  steps, `needed` falling with stamps, `needed` above the steps, visible with no steps, stamped step delete); a stamp after a manual award
  refuses; every gate (not live, window, hidden, audience, category locked, in order); shop closed moves the score
  only; edit rules (stamped step delete, lowering `needed`, 31st step, no steps visible); removal never repays;
  rehearsal wipe and erasure delete stamps; quest delete with stamps refused.
- **Security:** outsider and cross-tenant suites list both tables, `stamp_step` and the recreated readers; a player
  of event A cannot stamp a step of event B.
- **Unit:** `stepCode`/`verifyStepCode` (round trip, other purposes never open, canonical form), the app's
  `stepIdOf` and progress lines, the registry config.
- **Route:** the stamp route's answers and refusals, **a valid code of another step → 422 `not_questify`**; the passport read; the builder's step routes. One browser test
  for the step form (desktop and phone); `expo export`; the Hermes built-ins test.
- **Mutation (GitHub):** `apps/api/src/quests/qr.ts`, `apps/api/src/passport/**`, `apps/api/src/quests/codes.ts`,
  `apps/api/src/quests/builder.ts`, `apps/api/src/home/home.ts`.

## Phases (CTO code review once, at the end)

1. Migration 0045 + database tests + security suites.
2. API: signer, stamp route, reads, builder routes, codes page.
3. App (scanner, sheet, card, detail), dashboard (form, codes), web `/q/`; browser test; docs (API, DATA_MODEL, SRS
   FR-224 status, TASKS).

## Proposed decisions and questions

- **ADR-203** A passport is a quest with 1 to 30 steps in their own table, each its own signed code (format 0x04,
  own key, bound to its step); paid once by the database when distinct stamps reach `needed` and no completion
  exists, through `pay_completion` with the key `pass:{quest}`; finished once; a stamp after it is finished refuses;
  `needed` never falls once anyone has stamped (database triggers); the stamp holds the device id; steps by printed
  QR only. Q-167.

## Plan review (2026-10-24)

CTO 84. Folded in: step binding (`wrong_step`), the fixed `pass:{quest}` key and the prefix reserved everywhere, the
database triggers, `QT422` for a non-passport, the `≥ needed` check, the paying replay, the cleanup paths, the check
order, the device id, the named `old` test. Re-check owed.
