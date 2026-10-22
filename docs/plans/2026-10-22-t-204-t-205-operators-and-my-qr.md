# T-204 + T-205 — Operator accounts, My QR and the station scan

T-204 delivers FR-901 (amended: email only), 902, 903, 904, 905, 906, 907, 908, 909 (quests; booths later), 1720.
T-205 delivers FR-306 and FR-307 (both amended: a fixed My QR, ADR-137), 920, 921, 922, 923, 924, and the rest of
FR-301 (the quest's verification methods). **Max bar:** admin powers, signed QR proofs and the points ledger. One CTO
cycle for both (Dhia asked for the next two tasks): T-205's scan is what an operator is for, and they share one
migration.

## Dhia's answers (2026-10-22, INBOX)

1. **Invites go by email only.** No SMS invite; adding by phone is not offered (FR-901 amended).
2. **My QR is fixed, not rotating.** Showing it only identifies the player; anything valuable needs the player's own
   confirmation in their account. So a station scan pays the code's owner (a stolen code can only give its owner
   points), and the prize desk (T-206) hands over only after the player accepts in their app. FR-306/307 amended,
   ADR-137 Accepted. A player can reset their code (version bump) if it leaks.
3. **Operator bar:** all five tabs now in FR-920's order; Prize desk, Inbox and the unbuilt Tools entries show
   "coming soon".
4. **Assignment:** an operator reaches every quest by default; the owner may limit them to chosen quests. Booths have
   no model yet: they join FR-909 when a booth exists (Q-107).

## Scope

- **In:** operator invites (personal QR for one named person, batch QRs with a preset, email invite), the claim
  screen, the operators list with who claimed what, removal at once, the seven abilities (on by default), quest
  limits, "may play" with Operator and Player modes; quest verification methods (quest QR, My QR); the fixed My QR
  and its reset; the station scan with green, orange and red results; operators off every board (FR-318).
- **Out (noted on tasks):** prize desk (T-206), manual award (T-207), NFC (T-3xx), help-desk inbox, practice mode
  (T-211), the scan sound (ADR-129's set, haptics now), booths (Q-107), today's numbers beyond the station's count.

## Decisions (tactical; for the CTO to challenge)

### Data (migration 0026)

1. **`staff_assignment`**: `id uuid, organizer_id, event_id, player_id, abilities text[] NOT NULL DEFAULT` all seven,
   `can_play boolean NOT NULL DEFAULT false`, `invite_id uuid NULL`, `created_at`; `UNIQUE (event_id, player_id)`;
   FK `(event_id, organizer_id)`. CHECK `abilities <@ '{scan_quests, award, hand_over, review, help_desk, write_nfc,
   show_rotating_qr}'`. **`staff_assignment_quest (assignment_id, event_id, quest_id)`** with composite FKs to the
   assignment and to `quest (id, event_id)`, `ON DELETE CASCADE` from both: no rows = every quest (FR-909). Forced RLS;
   organizer members read their events' rows; a player reads their own; **no write grant**: every write is a definer.
   Removal deletes the row (and its quest rows); the audit log keeps the history (`operator.remove`).
2. **`operator_invite`**: `id uuid, organizer_id, event_id, kind ('personal' | 'email'), label text (the named
   person, 1–60), email text NULL (kind email only), abilities text[], batch_id uuid NULL, created_by staff_user_id,
   created_at, expires_at, claimed_by player_id NULL, claimed_at, revoked_at`. Personal and batch invites expire at the
   event's end; email invites after 7 days or the event's end, whichever comes first. Forced RLS, members read, no
   write grant. At most 500 open invites per event (batch caps at 100 per call).
3. **The invite token is derived, not stored:** the existing 37-byte signed layout (`apps/api/src/quests/qr.ts`)
   gains a format byte per purpose; format `0x03` = an operator invite: the invite id, version 1, an HMAC under a key
   derived from `QR_SECRET` (`questify/qr/v1/operator`). 128-bit MAC, single-use by the row's state, revocable. The
   dashboard can show and print a personal QR again at any time without the token being stored anywhere.
   - **QR content and email link:** `{DASHBOARD_ORIGIN}/{lang}/op#{token}`: the fragment never reaches a server log.
     The web page says "Open this in the Questify app" with the app link; the app's scanner and deep-link handler read
     the token directly.
4. **My QR** (format `0x02`, key `questify/qr/v1/my`): the player id and `player.my_qr_version`, signed. Same 50
   characters; the QR holds the bare token (no URL: a phone camera has nothing to open). Nothing personal is readable
   without the server. `reset_my_qr()` bumps the version (definer, the caller only, audited `player.qr_reset`, at most
   5 a day).
5. **Quest verification (FR-301):** `quest.verification text[]`. For `scan_qr` quests: a non-empty subset of
   `{quest_qr, my_qr}`, default `{quest_qr}`; for `enter_code`: `{}` (the typed code is the method). CHECK in the
   table, 422 `verification_required` in the API. The codes page and print list only quests with `quest_qr`. A
   `my_qr`-only quest has no printed code; the player's quest sheet says "Show your My QR to staff".
6. **One completion engine.** `complete_quest`'s body moves into an internal definer `record_completion(quest,
   player, method, proof_version, typed_code, key, device, operator)` (no grant to `questify_app`). `complete_quest`
   (unchanged signature) calls it with `app_player_id()`; the new `operator_complete_quest(quest, player,
   my_qr_version, key, device)` checks the operator first and calls it with the caller as `operator`. Methods: `qr`
   needs `quest_qr` in the verification; `my_qr` needs `my_qr`; `code` unchanged. `quest_completion.method` widens to
   `my_qr`; `ledger_entry.actor` widens to `operator` (`operator_id` = the operator's player id, already a column);
   a ledger CHECK: `actor = 'operator'` ⇔ `operator_id IS NOT NULL`.
7. **`operator_complete_quest` refusals** (new SQLSTATEs, added to the REFUSALS map): OP403 not an operator of this
   event (removed counts: checked in the same transaction, so removal is at once, FR-905); OA403 ability off
   (`scan_quests`); OS403 quest outside the operator's limit; OM422 My QR version is not the player's current one
   (`old`); OY409 scanning yourself. Then every `record_completion` rule: not enrolled, enrollment inactive, quest not
   open, already completed (orange), wrong method.
8. **Non-playing operators cannot play (FR-906)** in one place: a BEFORE INSERT trigger on `ledger_entry` refuses
   `quest` and `redeem` entries for an enrollment whose player holds an assignment in that event with `can_play =
   false` (QP403 → 403 `operator_not_playing`). It covers the player's own scans, a colleague's station scan and the
   shop. Joining stays allowed (the existing join), so a person who was a player keeps their record; their points stay.
9. **Operators off every board (FR-318):** `ranking_eligible` and `ranked_enrollments` leave out players with an
   assignment in the event (playing or not). Assignment insert and delete mark the event for a ranking repair.
10. **Definers (all `SECURITY DEFINER`, pinned `search_path`, granted to `questify_app` only, audited):**
    `create_operator_invites(event, kind, label, email, abilities, count)` (owner or admin; event not ended or
    archived; returns ids); `revoke_operator_invite`; `claim_operator_invite(invite, preview boolean)` (the caller is the
    player; open, unexpired, event not ended; an email invite needs `player_contact.email` = the invite's email,
    else OE403; preview returns the event and abilities without writing (FR-903's confirm screen); already an operator
    here: the invite is marked claimed and the assignment kept as is); `set_operator(assignment, abilities, can_play,
    quest_ids)` (owner; quest ids must be this event's); `remove_operator`; `operator_events()` (the caller's
    assignments with event name and status, abilities, limit, can_play, enrolled); `operator_station(event, quest)` (the
    station's count of completions today by this operator and in total, FR-921); `enroll_operator(event)` (an operator
    with `can_play` joins as an active player whatever the event's access type: the T-111 note).
11. **Who manages operators:** the owner (and a Questify admin). Editors read the list. API.md's `…/operators/batch`
    row said "owner, editor"; corrected to owner, matching FR-901–909 and ADR-057.

### API

12. Organizer routes (owner; members read): `GET …/events/{eventId}/operators` → `{operators: [{id, playerId, username,
    abilities, canPlay, questIds, claimedVia: {inviteId, label} | null, createdAt}], invites: [{id, kind, label,
    email (masked), abilities, batchId, status: open|claimed|revoked|expired, claimedBy: {username} | null, url?}]}`
    (`url` for open personal invites only, so they print again); `POST …/operators/invites` `{kind: personal,
    label, preset?}` | `{kind: email, email, preset?, lang}` | `{kind: batch, count 1–100, preset}`; `DELETE
    …/operators/invites/{id}`; `PUT …/operators/{id}` `{abilities, canPlay, questIds}`; `DELETE …/operators/{id}`.
    Presets (FR-1720): `scanner` {scan_quests}, `prize_desk` {hand_over}, `moderator` {review, help_desk}, `full`
    (all seven, the default). Email sending reuses the team invite's path (budget, failover; the invite is removed
    when no email can go out: 503 `email_unavailable`).
13. Player routes: `POST /v1/operator-invites/preview {token}` → `{event: {id, name}, abilities, kind}` | 404
    `invite_not_found` (forged, revoked, unknown) | 409 `invite_used` / `invite_expired` | 403 `invite_email_mismatch`;
    `POST /v1/operator-invites/claim {token}` (Idempotency-Key) → `{eventId}`; `GET /v1/me/operator-events`; `GET
    /v1/me/qr` → `{token}`; `POST /v1/me/qr/reset` → `{token}`; `POST /v1/events/{id}/operator/play` (enroll_operator).
14. **`POST /v1/operator/scan`** `{questId, code}` + Idempotency-Key + optional `X-Device-Id` →
    `{result: "completed" | "already_completed" | "refused", reason?, player: {username, avatar} | null, points?,
    occurrence?}` with HTTP 200 for all three outcomes the station shows (the scan reached a judgment); 401, 403
    `not_operator` (removed: the app leaves operator mode), 400 for a malformed body. A token that is not a valid My
    QR answers `refused` / `invalid_code` with `player: null`. Red reasons: `invalid_code`, `old_code`,
    `not_in_event`, `enrollment_inactive`, `quest_not_open`, `ability_off`, `outside_station`, `self_scan`,
    `operator_not_playing`, `wrong_method`. Rate limit: 120 scans a minute per operator (the throttle module).
    Ranking: the completed scan updates the player's Redis entry like a self-scan.
15. `GET /v1/events/{id}/quests` and the builder carry `verification`; the self-scan of a `my_qr`-only quest answers
    `invalid_code` (`wrong_method` in the log).

### Dashboard

16. **Operators page** (`/organizers/{o}/events/{e}/operators`, linked beside Players): the list (username, abilities
    as toggles, may play, quest limit picker, remove with confirm), invites (create personal with a name and preset,
    email invite, batch N with preset; status, claimed by; revoke), and a **print page** for open personal invites
    (the `uqr` QR + the name + the event, like the codes page). Editors see it read-only.
17. **Quest form:** for scan quests, two checkboxes "Player scans the quest's QR" and "Staff scan the player's My
    QR"; at least one.

### App

18. **Claim (FR-903):** the scanner and the deep-link handler recognise `/op#token`; a signed-out person signs in
    first (the pending-join pattern); the screen says "You'll be an operator for {event}" with Confirm and Not now.
    Errors in clear words (used, expired, wrong email).
19. **My QR (FR-306, ADR-137):** the center button's scanner screen gets a "My QR" toggle; the code is fetched once
    and cached (secure store) so it shows offline; QR drawn from `uqr` (added to the app, already in the web app;
    pure JS) as a grid of views; "Reset my code" behind a confirm in Profile.
20. **Operator mode (FR-907, FR-920–924):** the app's event list shows events where the person is an operator with an
    "Operator" badge; opening one enters `operator/[eventId]` with its own bar: Home (station picker: quests with
    `my_qr` within the limit, preselected when only one; the station's today and total counts), Prize desk (coming
    soon), ● Scan (station mode: scans back to back for the chosen station, FR-923; a full-screen green, orange or red
    result with the player's name and reason and a haptic, ready again within one second, FR-924), Inbox (coming
    soon), Tools (switch to Player mode only when allowed, FR-922; the other four entries listed as coming soon).
    Player mode's Profile shows "Operator mode" for an operator. A 403 `not_operator` ends operator mode with a note.
    The station choice persists per event (AsyncStorage).

## Phases

1. **Database (0026)** + integration tests: invites (create, preview, claim, single use, two claims at once → one
   wins, revoked, expired, email mismatch, event ended), assignment rules (removal at once: a scan after removal
   refused; ability off; limit; self scan), the engine split (every existing completion test still green; `my_qr`
   method, `wrong_method` both ways, ledger actor and operator id), the play trigger (own scan, colleague scan, reserve
   refused; `can_play` true passes), FR-318 board rule both forms and the repair mark, verification CHECKs; outsider
   tests (anon and a plain player can do nothing on the new tables and definers; another organizer reads nothing).
2. **API:** codec generalisation (format bytes, three keys; unit tests per format and cross-format refusal), routes,
   the scan result mapping, rate limit, emails; route tests; API.md, DATA_MODEL, SECURITY (the matrix: owner-only
   management), RUNBOOK if a setting appears.
3. **Dashboard:** Operators page, print page, quest form checkboxes; a browser test on desktop and phone.
4. **App:** claim, My QR, operator mode; pure logic tests (token routing, result mapping, station choice); `expo
   export`.

Mutation testing on `apps/api/src/operators` and the codec (core). Docs: TASKS (T-204, T-205 ticked; partial FRs
named), SRS (FR-306, FR-307, FR-901 amended; traceability), FEATURES, DECISIONS (ADR-137 Accepted: fixed My QR with
in-app confirmation for prizes; ADR-138 Proposed: operator management is owner-only, invites email-only), OPEN_QUESTIONS
(Q-107 booths), INBOX (Dhia's answers), T-206 note (handover needs the player's in-app accept), STATE.

## CTO plan review (Opus, 86 → revisions below)

- **M1 (fixed):** invite `url`s and the print page go to the owner and admins only; editors get the list without
  them (403 on print). Route test: an editor's list has no `url`.
- **M2 (fixed):** a fixed code held up in station mode is read again and again. (a) The app ignores the same token at
  the same station for 5 s after a result; (b) `operator_complete_quest` answers `already_completed` (the earlier
  completion, no new one) when this operator completed this player at this quest in the last 10 s, under the
  enrollment lock. Test: two scans 1 s apart on a cap-3 quest give one completion.
- **Minors folded in:** ADR-137 names the proxy-play risk and its mitigations (name and avatar on the station
  result, T-209's burst and speed flags, reset) and T-303 gets a note (meet-someone with a fixed code); operator
  scans store `device_id` NULL (the station phone is not the player's device; `operator_id` records who scanned);
  `operator_complete_quest` reads the assignment `FOR SHARE`, so a removal waits for an in-flight scan; the replay
  branch also requires the same `operator_id` (else QK422) and the operator's answer never carries the player's
  score or balance; `verification` joins the quest column grants (INSERT, UPDATE), existing rows backfilled, set by a
  BEFORE INSERT trigger from the type when absent, the CHECK the guard; `not_in_event` answers `player: null`;
  claiming when already an operator here answers 409 `already_operator` and leaves the invite open; invite emails
  stored lower-case with a CHECK and cleared when claimed, revoked or expired (the `organizer_invite` sweep), the app
  tells a phone-only player to add their email; the station's today count uses the event's timezone, with a partial
  index on `ledger_entry (operator_id, quest_id, created_at) WHERE operator_id IS NOT NULL`; `preview_operator_invite`
  and `claim_operator_invite` are two definers; the codec gets sibling sign/verify functions per format around one
  core; ledger CHECKs: `actor <> 'operator' OR kind = 'quest'`, `ledger_entry_system_returns_only` kept; a commit
  after each phase; a T-217 note (`staff_assignment.player_id`, `ledger_entry.operator_id` on deletion).
