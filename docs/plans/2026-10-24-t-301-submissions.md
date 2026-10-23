# T-301 — Submission quests (photo and text)

Delivers FR-204, FR-205, FR-206, FR-324, FR-325, FR-326, FR-327, FR-328, FR-1006, FR-1709, FR-1710, FR-1629 (the
guard), FR-409 (pending points, owed by T-115), FR-1628 (text marked by the word lists, owed by T-109) and FR-1706 (the
first-submission gate, owed by T-110). **Core bar** (pending points and the ledger, photos of people, admin powers over
points): one Opus plan review, one Opus code review, mutation on GitHub. Migration **0040**. Depends on T-105 (done).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-183 to ADR-189 and Q-149 to Q-155.

## Blocker found: no object storage for Questify yet (ADR-183, Q-149)

TECH_STACK and ARCHITECTURE put photos in object storage in the Saudi region, and ADR-109 counts "one storage bucket per
environment (included in the plan)". But the ADR-107 addendum 2 records that **CranL Pro allows one bucket per account
and `b7r-media` already uses it**. RUNBOOK has no bucket, no storage credentials and no storage env vars. So photos have
nowhere to go today. Plan around it:

- **Text submissions ship in full** (they live in PostgreSQL like every other player text).
- **Photo submissions are built in full behind a `PhotoStore` port** with an S3-compatible adapter. The API starts
  without storage settings; then the quest builder refuses a photo quest (`QS503 storage_unavailable`, a clear
  bilingual message), `/v1/config` says `features.photoSubmissions: false`, and the app hides the photo option. With
  `STORAGE_*` set, it switches on with no code change.
- Tests use an in-memory `PhotoStore` (the boundary is mocked, the logic is not) plus one adapter test against MinIO in
  Docker (S3-compatible, local only, never in CI unless already available).
- **Waiting on Dhia:** a Questify bucket in `riyadh-1` (ask CranL for a second bucket or a plan that allows it), or
  Oracle Object Storage in Riyadh. Sharing `b7r-media` under a prefix is **not** recommended: one credential would
  reach both products' files.

## The shape (ADR-184): pending lives on the submission, the ledger holds only points that moved

The ledger stays "points that moved" (append-only, score and balance are its sums). A pending submission is **not** a
ledger entry: it is a `submission` row holding the points it will pay. Approval writes the ordinary `quest_completion`
and `quest` ledger entry, so the score, the balance, the ranking, the flags and Questify XP (ADR-179's trigger) all
follow with no new path. Rejection writes nothing to the ledger (FR-206/FR-326: "nothing was added").

- **Points are frozen at submission** (`submission.points`): the player saw "+150 pending"; an edit of the quest later
  does not change what an approval pays (ADR-063's "future only" default).
- **Approved after the event ended (FR-1710):** score always; balance only while `shop_state(...)` is open, else
  `balance_delta = 0`. The approval path therefore does not reuse `record_completion`'s "event is live" check; the
  open checks run at **submission** time, not at approval.
- **Auto-approve (FR-327):** the submit call writes the submission (`approved`, `auto`), the completion and the entry in
  one transaction. Auto-approved items still appear in the team's queue as "not yet seen", so someone looks (the store's
  "points only after moderation" note, STORE_COMPLIANCE §2.8; ADR-042's accepted risk stays small).
- **Removal later (FR-328):** `remove_submission` marks it `removed` and writes a `removal` entry through
  `remove_award`'s rules (owner or editor, reason required, the original entry unchanged; XP reverses by ADR-179).

## Tables (deny by default; no API write grant; reads through definers)

| Table | Columns | Notes |
|---|---|---|
| `submission` | `id` bigint, `organizer_id`, `event_id`, `enrollment_id`, `quest_id`, `kind` (`photo`, `text`), `text` (≤ 1,000 chars, NULL for photo), `media_key` (NULL for text; NULL again once the file is deleted), `points` bigint ≥ 0, `status` (`pending`, `approved`, `rejected`, `removed`), `auto` bool, `marked` bool (word-list hit, FR-1628), `reason` (reject or remove reason), `reviewed_by_staff` / `reviewed_by_operator`, `reviewed_at`, `seen_at`, `completion_id` → `quest_completion` (set on approval), `idempotency_key`, `created_at` | Composite tenant foreign keys, RESTRICT. Unique (enrollment_id, idempotency_key). **One pending per (enrollment, quest)**: partial unique index WHERE status = 'pending'. CHECKs: kind ↔ text/media_key; approved ↔ completion_id; rejected/removed ↔ reason |
| `media_delete` | `id`, `media_key`, `due_at`, `done_at` | Outbox: a rejected, removed or erased photo is queued here in the same transaction; the worker deletes the object (retry with backoff, timeout) and stamps `done_at`. The database never calls out |
| `quest` | gains `type = 'submission'`, `type_config {accepts: ["photo"] or ["text"] or both, autoApprove, resubmit, prompt {ar,en}}` | `quest_type_known` widens; the config schema refuses `video` with "Video is not available yet" (FR-1006). `quest_completion.method` gains `submission` |

## Functions (each REVOKEd from PUBLIC; only the entry points are granted to `questify_app`)

1. `submit_quest(target, kind, text, media_key, request_key, expected_event)` (player). Lock order as
   `record_completion`: the enrollment FOR NO KEY UPDATE. The same open checks (active, live phase, visible, opens/closes,
   audience); the first-submission gate (guidelines accepted, FR-1706: `QG403`); kind allowed by the quest; cap: completions
   + pending < `repeat_cap`; a rejected one blocks unless `resubmit` (FR-1709: `QD409 closed`); text through
   `username_word` → `marked`. Replay by key answers the first result. Auto-approve → `approve_submission_internal`.
   The open checks move into one internal helper shared with `record_completion` (two callers now, a third with T-302),
   with the existing completion tests as the guard.
2. `review_submission(target_event, submission, decision approve|reject, reason, request_key)` (operator with
   `review`, editor, owner; FR-324/325). Locks the enrollment, then the submission FOR UPDATE; only `pending` moves
   (a second reviewer gets `SR409 already_reviewed`; a replay by key answers the first outcome). Reject needs a reason
   (`clean_reason`, 1–200). Approve writes the completion (`method = 'submission'`, next occurrence) and the `quest`
   entry (points frozen, balance per the shop window). Audited.
3. `remove_submission(target_event, submission, reason, request_key)` (owner, editor): approved → removed, the
   `removal` entry, the photo queued for deletion.
4. `event_submissions(target_event, status, after)` (the team; the operator only with `review`): the queue, oldest
   first, keyset paged; `marked` first-class. `own_submissions(target_event)` (the player): their own statuses, reasons
   and pending total. **No function ever returns another player's submission to a player** (FR-205).
5. The pending total for FR-409: summed in the event home and activity reads (`pending_points`), never a cache column.
6. Account deletion (`erase_rows`): the player's submissions lose `text` and `media_key`; keys go to `media_delete`.
   Rehearsal wipe: the same. Rows stay for the ledger's sake.

## Photos (ADR-185, ADR-186)

- **Taking one:** the in-app camera (`expo-camera`, already in the app, `takePictureAsync`) or the system picker
  (`expo-image-picker` `launchImageLibraryAsync`: PHPicker on iOS, the Android photo picker on 13+; checked in Expo's
  source via context7: no library permission is asked). Its config plugin set with `photosPermission: false`;
  `READ_MEDIA_IMAGES` stays blocked; the merged manifest is checked (STORE_COMPLIANCE §2.7). The camera text widens to
  the draft in STORE_COMPLIANCE §1 (both languages).
- **Upload through the API**, not a presigned URL: `POST /v1/quests/{id}/photo` (≤ 8 MB, JPEG/PNG/HEIC by magic bytes),
  the API **re-encodes** to JPEG ≤ 2,048 px with `sharp` (strips EXIF, so no GPS or device data is stored, and kills
  polyglot files; SECURITY threat 8), stores it under an unguessable key `sub/{organizer}/{event}/{uuid}.jpg` and answers
  the key, which `submit_quest` then takes (a key is accepted only if this player uploaded it in the last 30 minutes:
  `photo_upload` row). New dependencies with reasons: `sharp` (re-encoding), `aws4fetch` (S3 SigV4 signing, no
  transitive deps). Q-151.
- **Viewing:** the team gets a signed GET URL valid 5 minutes, on the bucket's host, never the API origin. Photos and
  text never reach logs, errors or push text (rule 3).

## API (API.md)

`POST /v1/quests/{id}/photo`; `POST /v1/quests/{id}/submit {kind, text | photoKey}` (idempotency key; answers
`{status, pendingPoints | points, levelUp}`); `GET /v1/events/{id}/submissions/mine`. Team: `GET
/v1/organizer/events/{id}/submissions?status=`, `POST …/submissions/{sid}/review`, `POST …/submissions/{sid}/remove`;
operator: `GET /v1/operator/events/{id}/submissions`, `POST …/review`. Rate limits on upload and submit per player.
Every string in `messages.ts` (Arabic via `ux-araby`), RTL checked, Western digits.

## Screens

- **App (player):** the quest sheet's submission flow: guidelines + terms on the first time (FR-1706), then camera or
  picker or text box, a preview, send with progress and retry (rule 5); the result says "+150 pending" or the points;
  Home and the points history show "+N pending" beside the balance (FR-409); a rejection shows its reason and, if
  allowed, "Send again" (FR-1709).
- **App (operator):** Tools → Review (hidden without `review`): one card at a time, approve, or reject with a reason.
- **Dashboard:** the Submissions page (queue with filters pending / auto-approved unseen / marked / done; approve,
  reject with reason, remove), and the quest builder's submission type (accepts, auto-approve, resubmit, prompt).

## Tests (test first)

- **Database** (`submissions.int.test.ts`): pending pays nothing (score, balance, XP unchanged); approve pays once, the
  frozen amount; two reviewers at once → one approval; reject needs a reason and adds nothing; resubmit allowed vs
  closed; one pending per quest; cap counts pending; auto-approve pays at once and is removable (removal entry, XP
  reversed, original entry unchanged); approval after the end: score only once the shop closed; rehearsal and deleted
  accounts; guidelines gate; word-list marking; replay by key; cross-tenant refusals; an operator without `review`
  refused; `erase_rows` and the wipe clear text and queue keys; `media_delete` rows.
- **Security:** outsider and cross-tenant suites list `submission`, `media_delete`, `photo_upload` and the new definers;
  a player reading another's submission gets nothing (FR-205).
- **Route/unit:** upload (size, type, re-encode strips EXIF: a GPS-tagged fixture comes out clean), storage off →
  `QS503` and the feature off, the config schema refusing `video`; the app's flow and pending label; browser test for
  the dashboard queue (desktop and phone); `expo export`.
- **Mutation (GitHub):** `apps/api/src/submissions/**`, `apps/api/src/storage/**`, plus `src/completions` if the
  shared helper touches it.

## Phases (CTO code review once, at the end)

1. Migration 0040 + DB tests + security suites (text submissions end to end in SQL).
2. API: `src/storage` (port, S3 adapter, in-memory), `src/submissions` routes, config flag.
3. App: player flow, pending label, operator review.
4. Dashboard: queue and builder; browser test; docs (API, DATA_MODEL, SRS status rows, STORE_COMPLIANCE §2.7, RUNBOOK
   `STORAGE_*` settings, SECURITY threat 8 marked built).

## Proposed decisions and questions

- **ADR-183** Photos wait for a Questify bucket; text ships now; storage off switches photo quests off. Q-149.
- **ADR-184** Pending points live on the submission, frozen at submission; approval writes the ordinary completion and
  quest entry; rejection writes nothing.
- **ADR-185** Upload through the API with re-encoding (`sharp`), not presigned uploads; signed 5-minute view URLs.
  Q-151.
- **ADR-186** Photo retention: rejected and removed photos are deleted at once (outbox); approved ones follow event
  retention (Q-075). Q-152.
- **ADR-187** Auto-approved items stay in the queue as "not yet seen". Q-153.
- **ADR-188** A rejected submission with resubmit off closes the quest for that player; with it on, a new submission is
  allowed while the quest is open, still one pending at a time and within the cap. Q-154.
- **ADR-189** Reviewers: owner, editors, and operators with `review`; removal: owner and editors only (as ADR-152).
  Q-155.
- **Q-149** the bucket (ask CranL for a second bucket, or Oracle Riyadh). **Q-150** text length 1,000 and photo size
  8 MB / 2,048 px. **Q-151** the two new dependencies. **Q-152** retention. **Q-153** auto-approved seen-marking.
  **Q-154** resubmission rules. **Q-155** who reviews and who removes.
