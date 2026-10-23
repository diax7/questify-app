# T-217 — Account deletion (app and web page)

Delivers FR-126, FR-127, FR-128, FR-1704, FR-1739 (and FR-1776: no restore). **Core bar** (personal data, the points
ledger, prize handovers, sign-in): one Opus plan review, one Opus code review, mutation on GitHub. Migration **0038**.
Depends on T-109 (username history) and T-206 (prize desk): both done. Also builds on T-107/T-108 (sign-in, contact
change), T-207, T-209, T-211, T-212, T-214, T-220, all done; every note on T-217 in `docs/TASKS.md` is answered below.

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-175 to ADR-178 and Q-140 to Q-144.

## The shape (ADR-175): a tombstone, anonymised in place

The ledger is append-only, the keys into `enrollment` are RESTRICT (`quest_completion`, `ledger_entry`,
`redemption`, `flag`, `result_place`) or NO ACTION (`enrollment.player_id`, `redemption.operator_id`/`offer_by`,
`staff_assignment`, `operator_invite.claimed_by`). So deletion **keeps the `player` row as a tombstone** (`id`,
`status = 'deleted'`, `deleted_at`; `username`, `birth_year`, `avatar` cleared) and **keeps every enrollment**, which
then names no one. Event totals, frozen results and the ledger stay correct; nothing personal is left. This answers
Q-086 and Q-092 (points leave the profile and every board; the ledger rows stay, anonymised).

## What happens to each row (one transaction, `erase_player`)

| Row | On deletion | Why / note answered |
|---|---|---|
| `player` | tombstone: `status deleted`, `deleted_at`, `username`/`birth_year`/`avatar` NULL, `my_qr_version + 1` | `username` becomes nullable with CHECK `(username IS NULL) = (status = 'deleted')`; `record_username` skips it. The name is free again (Q-143) |
| `player_contact` (+ `player_contact_challenge` CASCADE) | deleted, after its fingerprints are copied to marks (ADR-176) | T-108 note |
| `player_session`, `player_refresh` | deleted (every family) | T-107/T-109 notes: a deleted player is signed out everywhere at once |
| `username_history`, `player_acceptance` | deleted under `app.erasure = on` (their append-only triggers already allow it) | T-109, T-110 notes; Q-095 (3) recommendation: erase; Q-143 |
| `enrollment` | kept; `active`/`pending` → `left`, `waitlisted` false, `goal_reward_id` NULL; `banned` stays `banned` | Frees the seat, stops pushes; the ban mark survives (ADR-176) |
| `join_answer` | deleted | Q-115 recommendation (answers go with the account) |
| `quest_completion` | kept; `device_id` NULL | T-105, T-209 notes |
| `flag` | the player's flags deleted (`device_id`, `evidence`, `note` go) | T-209 note; the audit keeps the decisions as ids |
| `ledger_entry` | kept, unchanged (append-only); `operator_id` pointing at the tombstone stays | T-204, T-206 notes: the id names no one |
| `ledger_note` of the player's entries | `reason` NULL (owner-only update, inside the definer) | T-207 note |
| `bulk_award.reason` | kept: a group reason, not about one player | T-207 note (Q-144) |
| `redemption` | handed-over and ended rows kept (anonymised); pending ones need consent, see ADR-178; `operator_id`/`offer_by` stay | FR-128, T-206 note |
| `result_place` | kept; the place shows the anonymous label, never reorders | T-214 note: the place stays, the enrollment is not detached (FR-1739) |
| `staff_assignment` (the player as operator) | deleted (`staff_assignment_quest` with it) | T-204 note |
| `operator_invite.claimed_by` | kept (id of the tombstone) | — |
| rehearsal enrollments | anonymised like the rest; go-live's `wipe_rehearsal` removes them | T-211 note: no separate path |
| `audit_log` | unchanged (ids and counts only, never personal data); one new entry `player.delete` with counts | NFR-019 |
| `event_guest`, `event_exclusion` | unchanged: the organizer's own lists (Q-115 retention covers them) | — |
| Redis boards, idempotency entries | `removeFromRanking` for each of the player's events after commit; the player's idempotency keys expire (24 h TTL) and replay only to a session that no longer exists | — |

Reads that show a player (organizer players list, flags, results, desk, boards) already join `player`; a deleted
player renders as "Deleted player" / «لاعب محذوف» (no avatar). Live boards already drop non-`active` players
(`ranking_eligible`, 0015:49).

## Fingerprints (ADR-176, FR-1704)

- The API derives a new purpose key `deletionFingerprint` in `src/auth/keys.ts` (HMAC-SHA256 over the normalised
  contact with a key derived from the server secret, like `contactThrottleKey`). A plain hash would not do: every
  Saudi mobile number can be hashed in minutes.
- `player_contact` gains `phone_fp`, `email_fp` (bytea, 32 bytes, set exactly when the contact is set). The API passes
  the fingerprint when a code is requested (`start_player_challenge`, `start_contact_change` gain a parameter; stored on
  the challenge), and `create_player` / `confirm_contact_change` copy it. No row is deployed yet, so no backfill; test
  helpers that insert contacts get the column.
- On deletion only what is needed is kept, as **marks**: `erased_mark (fingerprint, event_id NULL, kind banned|
  welcomed, created_at)`, a unique index on `(fingerprint, event_id, kind)` NULLS NOT DISTINCT; no grant, forced RLS, no player id. One
  `banned` mark per event where the player was banned, one `welcomed` mark per event where they got the welcome
  reward, and a platform mark (`event_id` NULL) if the account was platform-banned. An account with neither leaves no
  mark (FR-128's "no record of it is kept").
- Checks: the join definers refuse (`not_allowed`, as for a ban today) when a joiner's `phone_fp` or `email_fp` has a
  `banned` mark for the event; `enrollment_welcome` skips the reward when one has a `welcomed` mark; `create_player`
  and `start_contact_change` refuse a contact with a platform mark (the sign-in's `banned` answer). A mark goes with
  its event's data (`ON DELETE CASCADE` on `event_id`).

## Verifying and confirming (ADR-177, FR-126, FR-127)

One flow for the app and the web page, always with a **fresh one-time code** (ASVS L2 re-authentication; an unlocked
phone alone cannot delete):

- `POST /v1/me/deletion/code {channel?}` (player; sends to the account's own phone, else email) and
  `POST /v1/deletion/code {channel, value, lang?}` (public, the web page; the sign-in throttles; always `202` with the
  same body, and a code is sent only when an account uses that contact) → `{challengeToken, expiresInSeconds: 300}`.
  Codes go through the sign-in challenge table with a new `purpose = 'deletion'`; a deletion code can never sign in.
- `POST /v1/deletion/verify {challengeToken, code}` → `{deletionToken, expiresInSeconds: 600, pending: [{eventId, event,
  reward, state}]}`: the pending handovers, so the screen explains them before anything happens.
- `POST /v1/deletion/confirm {deletionToken, forfeit: boolean}` + **Idempotency-Key** → `204`. `409 handover_pending
  {items}` when a handover is pending and `forfeit` is false. The deletion token is single-use and bound to the player.
- A platform-banned account may delete too (deletion is a legal right; the platform mark keeps the ban).
- Immediate, no grace period, no restore (FR-1776; the admin console has no restore).

## Pending handovers (ADR-178, FR-128)

"Pending" = a redemption `reserved`, or a desk item `collecting`/`offered` (rank prizes, T-214). Confirming with
`forfeit: true` cancels them in the same transaction through the existing cancel path (stock returns, `ended_by =
'erasure'`, the ledger refund entry as today) before the tombstone is written. Handed-over records stay, anonymised:
once the enrollment names no one they are no longer personal data, so FR-128's legal period (Q-051, counsel) only
decides what the deletion screens say. Q-142 asks counsel whether that is enough.

## Locks and races

`erase_player` locks the `player` row `FOR UPDATE` first (sign-in, refresh and contact change read it), then follows
the existing order of the cancel path for reservations (read during the build; reward, then enrollment), then the
player's enrollments ordered by id `FOR NO KEY UPDATE` (the lock `record_completion` takes, 0032:647). After commit
every session is gone, so in-flight requests fail on their next call. DB race tests: deletion vs a completion,
vs a reservation, vs a desk handover, vs a contact change, vs a second deletion (idempotent).

## Screens

- **App** (`account.tsx` → "Delete account"): what is deleted and what is kept (the store text), the code, the
  pending handovers with a forfeit tick, a final confirmation; then the phone forgets the session and cached data.
- **Web** `/{lang}/delete-account` (public, no app needed; the store listing's deletion URL): the same text, contact
  and code, the same confirmation. Linked from the legal pages. Arabic and English, RTL, Western digits.

## Tests

DB: every row in the table above after deletion; the tombstone cannot sign in, refresh, or be found by
`event_players` search; ban mark refuses a re-sign-up's join; welcome mark skips the reward; platform mark refuses
sign-up and contact change; no mark without a ban or welcome; frozen results keep order and label; ledger sums
unchanged; append-only triggers still refuse outside `app.erasure`; the races above. Security: `erase_player`,
`erased_mark` closed to the public role and another organizer; the public code endpoint answers the same for unknown
contacts; a deletion code cannot sign in; a deletion token cannot be replayed or used for another player. Routes,
app unit, browser test of the web page (desktop and phone), `expo export`.

## Out of scope

Admin legal-request deletion (FR-1778, its own task; it will call `erase_player`), data export (FR-1418), retention
jobs for handover records and guest lists (Q-051, Q-115), Sign in with Apple token revocation (not built).

**Mutation targets** (core, GitHub only): `apps/api/src/deletion/**`, `apps/api/src/auth/keys.ts`.

## CTO plan review (86, approve with revisions): folded in

ADR-175 to ADR-178 and Q-140 to Q-144 stay Proposed. These replace the matching lines above where they differ.

1. **Joins in flight (MAJOR):** `join_event`, `join_invited`, `enroll_operator` and `join_rehearsal` read the caller
   `FOR KEY SHARE` with the `active` filter, before any enrollment lock, so a join waits for a deletion in flight and
   then refuses. Paths on an existing enrollment (reserve, completion, the operator's My QR scan) lock the enrollment,
   which the deletion has already set to `left`, and refuse on its status. Race tests: deletion vs a join, a join
   request, a reserve, an operator My QR scan.
2. **Lock order (MAJOR):** player `FOR UPDATE` → the player's enrollments by id `FOR NO KEY UPDATE` → `end_reservation`
   for each pending item (its own order is enrollment → reward → redemption, 0034:198) → the deletes and updates.
3. **Forfeit (MAJOR):** `end_reservation(id, 'cancelled', 'erasure', 'system', NULL)` directly (`cancel_redemption`
   needs a player and refuses rank prizes). `redemption_ended_by_check` gains `erasure`; `ledger_entry_system_returns_only`
   and `redemption_operator_named` already accept it (system return, no operator). A forfeited rank prize stays on
   `result_place` as cancelled and is not passed down; the forfeit copy says so.
4. **Laundering through a contact change:** `player_fingerprint (player_id, fingerprint)` keeps the fingerprint of every
   contact the account ever held (fingerprints only); the checks and the marks use all of them.
5. **Welcome marks** expire when the event ends (`expires_at = ends_at`); ban marks stay. In Q-141. The deletion
   screens and the privacy policy name the fingerprints kept against fraud.
6. **Fingerprint test:** `create_player` and `confirm_contact_change` store exactly `deletionFingerprint(normalised
   contact)` (phones as `+9665…`).
7. **Public code:** always creates a challenge; the code is sent after the answer (the deferred queue), only when an
   account uses the contact. Test: a known and an unknown contact get the same status and body.
8. **Deletion token:** its hash and expiry sit on the deletion challenge row, consumed in `erase_player`'s transaction.
   The public routes cannot take Idempotency-Keys (route-access rule), so the token is the key: a confirm repeated
   with a consumed token answers `204` while the row lives (an hour).
9. **Null username:** nullable in the types and schemas; every reader that can reach a tombstone (players list, ledger
   lines, results, operator invites, flags) returns `username: null` and the screens show "Deleted player". One test per
   surface.
10. **Idempotency store:** `forget(scope)` drops the player's entries at deletion.
11. **Nit:** ADR-175 names the loss of flag history (the audit log keeps the decisions as ids).

Also changed while folding: the avatar is reset to the default (one of six pictures, not personal), not NULL; boards
drop the player through the repair marks the status change already writes (no extra Redis call).
