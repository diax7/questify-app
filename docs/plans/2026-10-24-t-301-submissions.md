# T-301 — Submission quests (text now; photos in T-301b)

Delivers FR-205, FR-206, FR-324, FR-325, FR-326, FR-327, FR-328, FR-1006, FR-1709, FR-1710, FR-409 (pending points,
owed by T-115), FR-1628 (text marked by the word lists, owed by T-109) and FR-1706 (the first-submission gate, owed by
T-110). FR-204 (photos) moves to **T-301b**; FR-1629 (no submission as a vote option) moves to **T-302**, where vote
options are built. **Core bar** (pending points and the ledger, admin powers over points): one Opus plan review, one
Opus code review, mutation on GitHub. Migration **0040**. Depends on T-105 (done).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-183, ADR-184 and ADR-187 to ADR-189,
and Q-149, Q-150 and Q-152 to Q-155. ADR-185, ADR-186 and Q-151 belong to T-301b.

## Photos are a separate task (ADR-183, Q-149)

CranL Pro allows one bucket per account and `b7r-media` uses it (ADR-107 addendum 2); RUNBOOK has no bucket. So T-301
builds **no photo pipeline**: no image library, no S3 client, no upload route, no storage switch. The quest schema
accepts `text` only and refuses `photo` with "Photo submissions are not available yet" (as `video`, FR-1006);
`submission.kind` keeps the column for later. **T-301b** (blocked on Q-149) holds the photo design: see the end.

## The shape (ADR-184): pending lives on the submission, the ledger holds only points that moved

A pending submission is **not** a ledger entry: it is a `submission` row holding the points it will pay. Approval writes
the ordinary `quest_completion` and `quest` ledger entry, so score, balance, ranking and Questify XP (ADR-179) follow
with no new path. Rejection writes nothing (FR-206/FR-326).

- **Frozen at submission:** the points (`submission.points`) and the repeat cap. Completions + pending < `repeat_cap`
  is checked when the player sends; an approval never re-checks the cap or the quest's open window, so an edit of the
  quest later changes nothing already sent (ADR-063's "future only").
- **Approval re-checks the player and the event:** only while the enrollment is `active` and the event is `live` or
  `ended` (`SE409 not_approvable` otherwise: archived, a rehearsal over, a left, removed or banned player).
- **Approved after the event ended (FR-1710):** score always; balance only while `shop_state(...)` is open, else
  `balance_delta = 0`.
- **Auto-approve (FR-327):** the submit call writes the submission (`approved`, `auto`), the completion and the entry in
  one transaction; it stays in the queue as "not yet seen" (ADR-187).
- **Ranking:** the `quest` entry moves the score like any completion: the same live update the completion path uses,
  and `mark_ranking_repair(event)` when the live update fails. Ties break by the entry's time, so by approval time, not
  by sending time.

## Tables (deny by default; no API write grant; reads through definers)

| Table | Columns | Notes |
|---|---|---|
| `submission` | `id` bigint, `organizer_id`, `event_id`, `enrollment_id`, `quest_id`, `kind` (`text`; `photo` reserved for T-301b, refused by CHECK now), `text` (1–1,000 chars), `points` bigint ≥ 0, `status` (`pending`, `approved`, `rejected`, `removed`), `auto` bool, `marked` bool (FR-1628), `reason`, `reason_system` bool (closed by the system, not a reviewer), `reviewed_by_staff` / `reviewed_by_operator`, `reviewed_at`, `review_key`, `seen_at`, `completion_id` → `quest_completion`, `idempotency_key`, `created_at` | Composite tenant foreign keys, RESTRICT. Unique (enrollment_id, idempotency_key). **One pending per (enrollment, quest):** partial unique index WHERE status = 'pending'. CHECKs: approved ↔ completion_id; rejected/removed ↔ reason |
| `quest` | gains `type = 'submission'`, `type_config {accepts: ["text"], autoApprove, resubmit}` (built: the quest's description is the prompt) | `quest_type_known` widens; `accepts` refuses `photo` and `video` with "not available yet". `quest_completion.method` gains `submission` |

## Functions (each REVOKEd from PUBLIC; only entry points granted to `questify_app`; each new definer calls `ensure_rehearsal_wiped` first)

1. `submit_quest(target, text, request_key, expected_event)` (player). Lock order as `record_completion`: the enrollment
   FOR NO KEY UPDATE. The open checks (active, live phase, visible, opens/closes, audience) move into one internal helper
   shared with `record_completion`, with the existing completion tests as the guard. Then: guidelines accepted (FR-1706,
   `QG403`); the cap (completions + pending); a rejected one blocks unless `resubmit` (FR-1709, `QD409 closed`); the text
   through `text_marked`. Replay by key answers the first result. Auto-approve → the internal approval.
2. `text_marked(text)` (internal): the text is NFC-normalised and trimmed first; control and bidi-override characters and
   empty text are refused in `submit_quest` (`SV422`). It splits on runs of non-letters and checks each piece with
   `username_fold` against `username_word`; a hit marks, never blocks.
3. `review_submission(target_event, submission, decision approve|reject, reason, request_key)` (owner, editor, operator
   with `review`; FR-324/325). Locks the enrollment, then the submission FOR UPDATE; only `pending` moves (a second
   reviewer: `SR409 already_reviewed`). The reviewer's key is stored as `review_key`; a replay by it answers the first
   outcome. Reject needs a reason (`clean_reason`, 1–200). Approve re-checks the player and event (above) and writes the
   completion with the **fixed key `'sub:' || submission.id`** (so no two approvals of one submission can ever pay
   twice), `method = 'submission'`, and the `quest` entry. Sets `seen_at`. Audited.
4. `mark_submissions_seen(target_event, ids bigint[])` (the reviewers): stamps `seen_at` where empty; for auto-approved
   items the team has looked at.
5. **One removal path:** `remove_award` (0030:666, as last replaced in 0034) marks the linked submission `removed` when
   the entry it reverses came from a submission approval. `remove_submission(target_event, submission, reason,
   request_key)` is a thin wrapper that finds the entry and calls it. Owner and editor only (ADR-189).
6. **Closing pending ones:** a trigger on `enrollment` status leaving `active` (ban, removal, leave, and `erase_rows`,
   0038:725, which sets `left`) rejects the player's pending submissions with a system reason (`reason_system`).
   `erase_rows` also clears every submission's `text`. Rows stay for the ledger's sake.
7. **Rehearsal wipe:** `wipe_rehearsal` (0032, the delete list at lines 30–45) deletes the rehearsal accounts'
   submission rows before `quest_completion`.
8. **Burst flags:** `raise_completion_flags` (0031:59) skips completions with `method = 'submission'` whose submission is
   not `auto`, so a reviewer approving a batch fast raises nothing; auto-approved ones still count as the player's pace.
9. **Quest edits:** `has_completions` (`src/quests/builder.ts`, `categories.ts:134`, and their SQL) also counts
   submissions, so a quest or category with any submission cannot be deleted; changing a quest's type or `accepts` while
   it has submissions is refused (`has_completions`).
10. Reads: `event_submissions(target_event, filter, after)` (the queue: pending, auto-approved not seen, marked, done;
    oldest first, keyset paged; operators only with `review`). `own_submissions(target_event)` (the player's statuses,
    reasons and pending total). **No function returns another player's submission to a player** (FR-205). The pending
    total (FR-409) is summed in the event home and activity reads, never a cache column.

## API (API.md)

`POST /v1/quests/{id}/submit {text}` (idempotency key; answers `{status, pendingPoints | points, levelUp}`);
`GET /v1/events/{id}/submissions/mine`. Team: `GET /v1/organizer/events/{id}/submissions?filter=`, `POST
…/submissions/{sid}/review`, `POST …/submissions/{sid}/remove`, `POST …/submissions/seen`; operator: `GET
/v1/operator/events/{id}/submissions`, `POST …/review`. A rate limit on submit per player. Every string in
`messages.ts` (Arabic via `ux-araby`), RTL checked, Western digits. Text never reaches logs, errors or push text.

## Screens

- **App (player):** the quest sheet's text submission: guidelines and terms the first time (FR-1706), a text box with a
  counter, send with retry (rule 5); "+150 pending" or the points; Home and the points history show "+N pending" beside
  the balance (FR-409); a rejection shows its reason and, if allowed, "Send again" (FR-1709).
- **App (operator):** Tools → Review (hidden without `review`): one card at a time, approve, or reject with a reason.
- **Dashboard:** the Submissions page (filters; approve, reject with reason, remove; opening a page marks auto-approved
  items seen) and the quest builder's submission type (auto-approve, resubmit, prompt).

## Tests (test first)

- **Database** (`submissions.int.test.ts`): pending pays nothing (score, balance, XP); approve pays once at the frozen
  amount; two reviewers at once → one approval; a replayed review key; the fixed completion key; reject needs a reason
  and adds nothing; resubmit allowed vs closed; one pending per quest; the cap counts pending; auto-approve pays at once;
  removal through `remove_submission` **and** through `remove_award` marks the submission removed (removal entry, XP
  reversed, original entry unchanged); approval refused for a banned, removed, left and erased player and an archived
  event, and each of those closes pending ones with a system reason; after the end: score only once the shop closed;
  the rehearsal wipe removes submissions; fast batch approvals raise no burst flag while auto-approved bursts do; quest
  and category delete refused with submissions, type/`accepts` change refused; `photo` and `video` refused; guidelines
  gate; `text_marked` (Arabic and English hits inside punctuation, NFC, control and bidi characters refused, empty
  refused); cross-tenant and operator-without-`review` refusals; `mark_submissions_seen`.
- **Security:** outsider and cross-tenant suites list `submission` and the new definers; a player reading another's
  submission gets nothing (FR-205).
- **Route/unit:** the routes, the config schema refusals, the app's flow and pending label; a browser test for the
  dashboard queue (desktop and phone); `expo export`.
- **Mutation (GitHub):** `apps/api/src/submissions/**`, plus `apps/api/src/completions/**` and `apps/api/src/quests/**`
  where the shared helper and `has_completions` change.

## Phases (CTO code review once, at the end)

1. Migration 0040 + DB tests + security suites.
2. API: `src/submissions` routes and the quest builder changes.
3. App: player flow, pending label, operator review.
4. Dashboard: queue and builder; browser test; docs (API, DATA_MODEL, SRS status rows, STORE_COMPLIANCE §1.2 note).

## Proposed decisions and questions

- **ADR-183** Photo submissions are a separate task (T-301b), blocked on a Questify bucket; T-301 ships text. Q-149.
- **ADR-184** Pending points live on the submission; points and the cap are fixed at sending; approval re-checks the
  player and event and writes the ordinary completion (fixed key) and quest entry; rejection writes nothing.
- **ADR-187** Auto-approved items stay in the queue until seen. Q-153.
- **ADR-188** Resubmission: one pending at a time, pending counts against the cap, resubmit off closes the quest. Q-154.
- **ADR-189** Reviewers: owner, editors, operators with `review`; removal: owner and editors. Q-155.
- **Q-150** text up to 1,000 characters. **Q-152** retention of submission text (with Q-075).

## Carried to T-301b (photos; blocked on Q-149)

ADR-185 (upload through the API, re-encoded with `sharp`, `limitInputPixels` set, one image at a time; signed 5-minute
view URLs on the bucket's host), ADR-186 (photo retention, a `media_delete` outbox the worker drains), Q-151 (`sharp`
and `aws4fetch`). The app sends JPEG, not HEIC (`expo-camera` `takePictureAsync`, `expo-image-picker`
`launchImageLibraryAsync` with `photosPermission: false`: no library permission on iOS or Android 13+, checked in Expo's
source). `photo_upload(id, player_id, event_id, media_key, created_at, used_at)`: an upload a player may attach within
30 minutes; a sweep deletes uploads never submitted. Wipe, erase and removal queue the object deletes. FR-204 and
STORE_COMPLIANCE §2.7's camera text widen there.
