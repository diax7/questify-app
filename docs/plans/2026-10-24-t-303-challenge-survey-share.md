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

- `submit_survey(target, answers jsonb, request_key)`: the quest must be a survey (`QT422`), every answer is checked
  against the config, then the completion (method `survey`, `quest.points`) and the response row are written in one
  transaction through `record_completion` (as `vote_quest`: open checks, the enrollment lock, the cap, and the ledger's
  operator-play guard). One response per player and quest (`409 already_completed`). **A replayed key** answers the
  first result only when the answers are the same; other answers under that key are `QK422` (as `vote_quest`
  0041:262-266). A manual award also completes the survey, so the player cannot send it afterwards (ADR-198).
- **Answer rules** (`SA422`, DETAIL the question id, or `shape` for a body that is not an object or names an unknown
  question): a `choice` answer is a string naming one of that question's choices; a `rating` an integer 1 to 5; a
  `text` goes through `clean_submission_text` (NFC, trimmed, control and bidi-override characters refused) and is at most
  500 characters. A missing, null or blank answer to an optional question counts as unanswered; to a required one it is
  refused. A refusal never echoes the answer.
- **Who sees answers:** players never read another's answers (no definer returns them). The team (owners and editors;
  operators not) reads `survey_summary(event, quest)`: the total of responses, and per question the full choice counts,
  the rating count and average, and the newest 50 text answers, **names not shown** (ADR-198). T-508 builds the full
  results page, export and speaker sharing on this. **Dashboard in T-303:** the summary on the quest's page, as T-302's
  vote counts.
- **App:** the survey sheet: one scrolling form (choices as cards, five stars for a rating with a numeric label for
  screen readers, a text box with a counter), required marks, send with retry (rule 5), then "Thanks" and the points.
- **Erasure and rehearsal:** `erase_rows` deletes the player's `survey_response` rows (counts drop, as votes); the
  rehearsal wipe deletes rehearsal accounts' rows before `quest_completion` and counts them.

## Share (ADR-199)

- `share_quest(target, request_key)`: the quest must be a share quest, the event's switch not off (`QF403`), then the
  completion (method `share`, `quest.points`, `repeat_cap` 1: `409 already_completed`) through `record_completion`; a
  replayed key answers the first result.
- **The switch:** new feature `shareQuests` (`gated: false`) in `FEATURES`, on by default. The event's switch off hides
  every share quest from players and refuses the payment (`403 feature_off`). **One API helper**
  (`withoutSwitchedOffQuests`) drops share quests when the composed config has `shareQuests` off, and every player quest
  read goes through it: the quests tab, Home (Up next, done and total), the public quests by code, and the share
  read and pay routes. The database also refuses `share_quest` when the event's own switch is off (the platform's
  switch lives only in the composed config). The builder always accepts the type; the dashboard says when the switch
  is off that players will not see it.
- **The app pays on `sharedAction`** from React Native's `Share.share` with the organizer's message and link. iOS
  reports a dismissed sheet; Android always reports shared, so opening and closing the sheet can earn the points there:
  the cost ADR-034 accepted. The link is shown as text only; the app never opens it itself.
- Players read the message and link through `member_share(quest)` (organizer text, no secret).
- **Store:** STORE_COMPLIANCE gains a share-quest row (Apple 3.2.2(x) allows incentives for in-app actions; Google's
  message-spam rule is met by the system share sheet, where the player picks the recipients and sees the message) and
  an App Review note.

## Tables (deny by default: no API grant; reads and writes through definers; tenant foreign keys, RESTRICT)

| Table | Columns | Notes |
|---|---|---|
| `survey_response` | `organizer_id`, `event_id`, `enrollment_id`, `quest_id`, `answers` jsonb, `completion_id`, `created_at` | PK (enrollment_id, quest_id); `answers` is `{questionId: choiceId \| rating \| text}` with only the answered questions, written only by `submit_survey` |

No table for share or challenge: the completion row is the record.

## Functions (each REVOKEd from PUBLIC; only entry points granted to `questify_app`; each calls `ensure_rehearsal_wiped`)

Player: `submit_survey`, `member_survey(quest)` (the questions and whether I answered), `member_share(quest)`,
`share_quest`. Team: `survey_summary(event, quest)`. Replaced: `record_completion` (the challenge, survey and share
methods), `quest_verification_default` (a challenge defaults to `['my_qr']`), `quest_structure` (a survey branch),
`quest_lock_played` (an EXISTS on `survey_response`) and its trigger (WHEN gains `survey`), `erase_rows`,
`wipe_rehearsal`, and the type and method CHECKs. `operator_stations` changes its output (a `type` column), so it is
DROPped and CREATEd with its REVOKE and GRANT repeated; the outsider suite lists it. `raise_completion_flags` is
unchanged: share and survey completions are the player's own pace and count toward bursts.

## API (API.md)

`GET /v1/quests/{id}/survey`, `POST /v1/quests/{id}/survey {answers}`, `POST /v1/quests/{id}/share` (each unsafe call
takes the Idempotency-Key header; they answer like a completion: `{completionId, points, score, balance, levelUp, rank,
replayed}`). Team: `GET /v1/organizers/{org}/events/{id}/quests/{qid}/survey`. The routes call
`ranking.afterCompletion`. Refusals: 403 `quest_not_open` / `enrollment_inactive` / `operator_play_off` /
`feature_off`, 404, 409 `already_completed`, 422 `not_survey_quest` / `not_share_quest` /
`bad_answer` (with the question id) / `idempotency_key_reused`. The builder's three types; `quest_locked` for a survey.
Every string in `messages.ts` (Arabic via `ux-araby`), RTL checked, Western digits. Answer text never reaches logs,
errors or push text.

## Tests (test first)

- **Database** (`challenge-survey-share.int.test.ts`): a challenge refused by the player's QR and code paths, paid by
  an operator's My QR scan, refused for an operator without `scan_quests` or outside FR-909's quests, listed at the
  station; `challenge` with any verification but `['my_qr']` refused by CHECK, and an insert that names none gets
  `['my_qr']`. Survey: one response, the replay, the same key with other answers (`QK422`), a manual award using it
  up, a second refused, each `bad_answer` (unknown question, missing required, unknown choice, rating 0 and 6, empty and
  501-character text, bidi characters, a number as a choice, 3.5 as a rating; blank optional answers stored as
  unanswered; the refusal never holds the text), the open checks, two parallel submits → one row and one completion, the
  summary's total, counts, average and newest 50 texts with no name, an operator and another event's owner refused the summary, the structure
  lock after the first response, erasure and the rehearsal wipe. Share: pays once, the replay, a second
  refused, refused while the event's switch is off.
- **Security:** outsider and cross-tenant suites list `survey_response`, every new definer and the recreated
  `operator_stations`; a player never reads
  another's answers.
- **Route/unit:** routes and refusals (including `feature_off`), and a switched-off share quest hidden from each player
  read (quests tab, Home's Up next and totals, public quests by code, share read and pay), the registry schemas
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
