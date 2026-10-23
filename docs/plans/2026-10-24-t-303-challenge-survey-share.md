# T-303 — Challenge, survey and share quests

Delivers FR-203 (a challenge completes only when staff confirm), FR-214 (survey quests, results to the organizer only),
FR-219 (share quests on or off per event) and FR-220 (a share quest pays on the share action, once). **Core bar** (all
three pay through the completion engine and the ledger): one Opus plan review, one Opus code review, mutation on
GitHub. Migration **0042**. Depends on T-205 (done) and reuses T-302's play path (`play_enter`, `quest_structure`,
`quest_lock_played`, `pay_completion`).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-196 to ADR-199 and Q-160 to Q-163.

## The split (ADR-196)

T-303 as listed is five quest types plus two fair-play flags. It is split by what each part needs:

- **T-303 (this plan):** challenge, survey, share. No new permission, no new personal data class, no new proof.
- **T-303b:** location check-in with the QR fallback (FR-215, FR-216), the location prompt's timing (FR-1744), and the
  far-from-venue and impossible-speed flags (FR-331, FR-332). One store story (the location permission, purpose strings,
  privacy labels), the venue pin, quest places and the app's reading (ADR-072).
- **T-303c:** meet-someone quests (FR-212, FR-213). My QR is fixed (ADR-137), so it needs its own short-lived proof of
  meeting, pair uniqueness, a daily cap and a two-player payment with a lock order of its own.

## Config (shared registry `QUEST_TYPES`; the database CHECKs what it can)

| Type | `type_config` | `verification` | Rules |
|---|---|---|---|
| `challenge` | `{}` (the quest's description says what to do) | always `['my_qr']` | Completed only by an operator's station scan of the player's My QR (`operator_complete_quest`, ability `scan_quests`, FR-909's quest limits), or by an owner or editor's manual award. `repeat_cap` as `scan_qr` |
| `survey` | `{questions: [{id, text: {ar?, en?}, kind, required, choices?}]}` | none | 1 to 20 questions. `kind`: `choice` (2 to 10 choices, one picked), `rating` (1 to 5), `text` (1 to 500 characters). `required` defaults to true; `choices` only on `choice`. `repeat_cap = 1`. Pays `quest.points` on submit |
| `share` | `{message: {ar?, en?}, link?}` | none | message 1 to 500 characters in at least one language; `link` an `https://` URL of at most 300 characters. `repeat_cap = 1`. Pays `quest.points` on the share action |

`quest_type_known` widens to the three types; `quest_completion.method` gains `survey` and `share` (a challenge pays as
`my_qr`, as a station scan does today). `quest_verification_known` widens: `challenge` ↔ exactly `['my_qr']`.
`quest_vote_quiz_once` widens to `survey` and `share` (repeat_cap 1). A survey's structure (ids, number, order, kinds,
`required`, choice ids) locks after its first response through `quest_structure` / `quest_lock_played` (ADR-194,
`QL409`); text stays editable. A share quest's message and link stay editable (nothing earlier depends on them).

## Challenge (ADR-197)

- **The player cannot complete it.** `record_completion`'s method check gains `(challenge, my_qr)` only; the player's
  quest-QR and code paths refuse it (`QV422 wrong_method`). A challenge has no quest QR (`usesQuestQr: false`).
- **Staff confirm at the station.** `operator_stations` (0026:737) lists `challenge` quests beside `scan_qr` ones
  with `my_qr`, marked as a challenge; the operator picks the quest and scans My QR; the existing 10-second guard, open
  checks, `can_play` and FR-909 limits apply unchanged. No player "request confirmation" queue in T-303.
- **Owner and editor** confirm from the dashboard through manual awards (T-0030's path, method `manual`), unchanged.
- **App (player):** the quest sheet says "A staff member confirms this challenge" with a button to My QR; no scan
  button. **App (operator):** the station list shows a challenge label. **Dashboard:** the builder's challenge type.

## Survey (ADR-198)

- `submit_survey(target, answers jsonb, request_key)`: `play_enter(quest, 'survey')` (open checks, enrollment lock,
  operator `can_play`), one response per player and quest (`409 already_answered`; a replayed key answers the first
  result), then every answer checked against the config: each question id known and answered at most once, every
  `required` one answered, a `choice` id in that question's choices, a `rating` an integer 1 to 5, a `text` NFC-trimmed,
  1 to 500 characters, control and bidi-override characters refused (`SV422`, as submissions). Then the completion
  (method `survey`, `quest.points`) and the response row in one transaction through `record_completion` (as
  `vote_quest`). Any refusal names the question id, never echoes the text.
- **Who sees answers:** players never read another's answers (no definer returns them). The team (owners and editors;
  operators not) reads `survey_summary(event, quest)`: per question the choice counts, the rating count and average,
  and the text answers newest first, **with no player's name** (ADR-198). T-508 builds the full results page, export and
  speaker sharing on this. **Dashboard in T-303:** the summary on the quest's page, as T-302's vote counts.
- **App:** the survey sheet: one scrolling form (choices as cards, five stars for a rating with a numeric label for
  screen readers, a text box with a counter), required marks, send with retry (rule 5), then "Thanks" and the points.
- **Erasure and rehearsal:** `erase_rows` deletes the player's `survey_response` rows (counts drop, as votes); the
  rehearsal wipe deletes rehearsal accounts' rows before `quest_completion` and counts them.

## Share (ADR-199)

- `share_quest(target, request_key)`: `play_enter(quest, 'share')`, then the completion (method `share`,
  `quest.points`, `repeat_cap` 1: `409 already_completed`); a replayed key answers the first result.
- **The switch:** new feature `shareQuests` (`gated: false`) in `FEATURES`. Creating a share quest is turning share
  quests on; the event's switch off hides every share quest from players and refuses `share_quest` (`403 feature_off`).
  The API checks the composed config (the one place features are composed, T-007) before calling the definer, in the
  share route and in the member quest list. The builder offers the share type only while the switch is on.
- **The app pays on `sharedAction`** from React Native's `Share.share` with the organizer's message and link. iOS
  reports a dismissed sheet; Android always reports shared, so opening and closing the sheet can earn the points there:
  the cost ADR-034 accepted. The link is shown as text only; the app never opens it itself.
- Players read the message and link through the member quest list's row for share quests (organizer text, no secret).

## Tables (deny by default: no API grant; reads and writes through definers; tenant foreign keys, RESTRICT)

| Table | Columns | Notes |
|---|---|---|
| `survey_response` | `organizer_id`, `event_id`, `enrollment_id`, `quest_id`, `answers` jsonb, `completion_id`, `request_key`, `created_at` | PK (enrollment_id, quest_id); `answers` is `{questionId: choiceId \| rating \| text}`, written only by `submit_survey` |

No table for share or challenge: the completion row is the record.

## Functions (each REVOKEd from PUBLIC; only entry points granted to `questify_app`; each calls `ensure_rehearsal_wiped`)

Player: `submit_survey`, `member_survey(quest)` (the questions and whether I answered), `share_quest`. Team:
`survey_summary(event, quest)`. Replaced: `record_completion` (the challenge method), `operator_stations`,
`member_event_quests` (share message and link; survey and challenge done states unchanged), `quest_structure`,
`erase_rows`, `wipe_rehearsal`, and the type and method CHECKs. `raise_completion_flags` is unchanged: share and survey
completions are the player's own pace and count toward bursts.

## API (API.md)

`GET /v1/quests/{id}/survey`, `POST /v1/quests/{id}/survey {answers}`, `POST /v1/quests/{id}/share` (each unsafe call
takes the Idempotency-Key header; they answer like a completion: `{completionId, points, score, balance, levelUp, rank,
replayed}`). Team: `GET /v1/organizers/{org}/events/{id}/quests/{qid}/survey`. The routes call
`ranking.afterCompletion`. Refusals: 403 `quest_not_open` / `enrollment_inactive` / `operator_play_off` /
`feature_off`, 404, 409 `already_answered` / `already_completed`, 422 `not_survey_quest` / `not_share_quest` /
`bad_answer` (with the question id) / `idempotency_key_reused`. The builder's three types; `quest_locked` for a survey.
Every string in `messages.ts` (Arabic via `ux-araby`), RTL checked, Western digits. Answer text never reaches logs,
errors or push text.

## Tests (test first)

- **Database** (`challenge-survey-share.int.test.ts`): a challenge refused by the player's QR and code paths, paid by
  an operator's My QR scan, refused for an operator without `scan_quests` or outside FR-909's quests, listed at the
  station; `challenge` with any verification but `['my_qr']` refused by CHECK. Survey: one response, the replay, a
  second refused, each `bad_answer` (unknown question, missing required, unknown choice, rating 0 and 6, empty and
  501-character text, bidi characters), the open checks, two parallel submits → one row and one completion, the
  summary's counts and average with no name, an operator and another event's owner refused the summary, the structure
  lock after the first response, erasure and the rehearsal wipe. Share: pays once, the replay, a second refused.
- **Security:** outsider and cross-tenant suites list `survey_response` and every new definer; a player never reads
  another's answers.
- **Route/unit:** routes and refusals (including `feature_off` and the hidden share quest), the registry schemas
  (link must be `https://`), the app's survey form and share flow (`sharedAction` pays, `dismissedAction` does not), a
  browser test for the builder's three types and the survey summary (desktop and phone), `expo export`, the Hermes
  built-ins test (no `toSorted`, `Object.groupBy`, new Set methods or `structuredClone`).
- **Mutation (GitHub):** `apps/api/src/plays/**` (or wherever the new routes land), `apps/api/src/quests/builder.ts`,
  and `apps/api/src/operators/**` if the station read changes in TypeScript.

## Phases (CTO code review once, at the end)

1. Migration 0042 + DB tests + security suites.
2. API: survey, share and summary routes; the builder's types; the `shareQuests` feature and its checks.
3. App: challenge sheet, survey form, share flow; the station's challenge label.
4. Dashboard: builder types, survey summary; browser test; docs (API, DATA_MODEL, CONFIGURABILITY, SRS status rows).

## Proposed decisions and questions

- **ADR-196** Split: T-303 (challenge, survey, share), T-303b (location check-in, FR-1744, FR-331, FR-332), T-303c
  (meet-someone). Q-160.
- **ADR-197** A challenge is confirmed by an operator's station scan of My QR, or a manual award; no request queue.
  Q-161.
- **ADR-198** Survey shape (choice, rating 1 to 5, short text; required flag; one response; points on submit); the team
  sees answers without names; locked after the first response; erased with the account. Q-162.
- **ADR-199** Share quests: organizer message and optional https link, paid on the share sheet's `sharedAction`,
  switched off per event by `shareQuests` (on by default; creating one turns it on). Q-163.
