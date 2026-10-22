# T-219 + T-203 — Spending lowers rank (option) and digital reward codes

T-219 delivers FR-1847 (ADR-134, amends ADR-043/ADR-133). T-203 delivers FR-510, FR-511, FR-512 (and the digital half
of FR-505 left partial by T-201). **Max bar:** both write the points ledger (core); T-203 adds a secret at rest. One
CTO cycle for both: they touch the same three definers (`reserve_reward`, `end_reservation`, the redeem CHECKs) and one
migration.

## Scope

- **In:** the event setting `spend_lowers_rank` (off by default, locked from live on), `redeem`/`redeem_return` moving
  the score when it is on, the ranking cache following; the dashboard switch with the trade-off text; the app telling
  the player before they confirm. The `digital` reward kind, encrypted code upload, one code per redemption shown at
  once and kept in history, the low-codes warning, the dashboard upload and counts, the app's code reveal.
- **Out (noted on tasks):** deleting an uploaded code batch (no FR; noted under T-203's line as a follow-up if asked);
  key rotation for the code key (one key now, noted in SECURITY as a known limit); a copy button in the app (a
  selectable text instead, no new dependency).

## Decisions (tactical; for the CTO to challenge)

### T-219

1. **`event.spend_lowers_rank boolean NOT NULL DEFAULT false`**, granted to `questify_app` for UPDATE. A guard trigger
   (the `event_times_guard` pattern, `questify_app` only) refuses a change once `event_status_now` is `live`, `ended`
   or `archived` (QE409). Since the shop opens only when live, no redemption can exist before the lock: an event's
   spends are all on or all off.
2. **The ledger says what moved.** The definers write `score_delta` explicitly; no trigger infers it. `reserve_reward`
   reads the event's setting: on → `score_delta = −price`; off → 0. `end_reservation` gives back **the mirror of the
   redeem entry's own `score_delta`** (read from the ledger), never re-reading the setting, so a return always undoes
   exactly its payment. CHECK `ledger_entry_redeem_shape` widens to `score_delta = 0 OR score_delta = balance_delta`.
3. **Score never goes below zero:** with the option on, score and balance fall together and a player spends only the
   balance; score ≥ balance holds for every enrollment (quests add both, an off-spend lowers only the balance), and the
   existing `score >= 0` CHECK is the backstop.
4. **Order (FR-606):** a spend that moves the score sets `score_version` to its entry id (the existing
   `apply_ledger_entry`), so a player who spends down to X ranks after one who reached X earlier. Accepted behaviour,
   stated in API.md.
5. **The ranking cache:** when a redeem or return moves the score, the definer calls `mark_ranking_repair(event)` in
   the same transaction; the repair tick (every 2 s) rebuilds that event from PostgreSQL. No new Redis write path; a
   player who spends to zero drops out of the ranking (score > 0 rule) at the rebuild. Rank prizes and the finale read
   the score and follow without change.
6. **API and dashboard:** the shop settings (`PUT …/events/{eventId}/shop`) gain `spendLowersRank`; a changed value on
   a live or ended event answers 409 `setting_locked`; the same value passes so the other shop settings stay editable.
   The settings card shows the switch, the trade-off text ("players may keep their points instead of using the shop")
   and, when locked, why. Audited in `event.shop.update`.
7. **The app:** the player's shop view carries `spendLowersRank`; the confirm sheet then says the price also lowers
   their ranking points (ux-araby copy).

### T-203

8. **Kind `digital`** joins `reward_kind_known`. A digital reward's `stock_total` is the number of codes uploaded: it
   is created at 0 (a BEFORE INSERT trigger refuses anything else from `questify_app`), and `questify_app` cannot change
   it directly (guard, RR409 → 409 `stock_from_codes`); only the upload raises it. `units_out` counts codes given, so
   stock left stays `stock_total − units_out` and FR-514's sold out works unchanged.
9. **`reward_code`:** `id bigint identity, organizer_id, event_id, reward_id, code_cipher bytea, code_hash bytea,
   redemption_id uuid UNIQUE NULL, created_at`; `UNIQUE (event_id, code_hash)` so no code exists twice in an event;
   FK `(reward_id, event_id)`; forced RLS. Organizers get INSERT (`reward_id, code_cipher, code_hash`) and SELECT on
   `id, reward_id, redemption_id, created_at` only (column grants: never the cipher or hash); players nothing. Rows
   are never updated except `redemption_id` by the definer, never deleted (a guard trigger).
10. **Encryption in the API, not the database:** AES-256-GCM, a random 12-byte IV, the reward id as associated data
    (a cipher moved to another reward fails to open); stored as `iv ‖ tag ‖ ciphertext`. The hash is HMAC-SHA-256 of
    the trimmed code, so codes can be de-duplicated without being readable. Both keys come from one new secret
    `REWARD_CODE_SECRET` (32+ characters, required at start like `QR_SECRET`) through HKDF with two labels. A database
    dump or backup alone never shows a code.
11. **Upload** `POST …/events/{eventId}/rewards/{rewardId}/codes` (owner or editor, Idempotency-Key, body `{codes:
    string[]}`, 1 to 5 000 per call, each 1 to 200 characters after trimming, no control characters; the dashboard
    accepts pasted lines or a .txt/.csv file read in the browser). In one transaction: lock the reward (`FOR UPDATE`,
    the reserve's order), `INSERT … ON CONFLICT (event_id, code_hash) DO NOTHING`, raise `stock_total` by the rows
    actually inserted. Answers `{added, duplicates, stockTotal, stockLeft}`; uploading the same list twice adds 0. A
    removed or non-digital reward: 404 / 409. Audited `reward.codes.add` with the counts only, never a code.
12. **Redeeming a digital reward is instant and final.** `reserve_reward` for a digital reward takes the oldest unused
    code (`ORDER BY id LIMIT 1 FOR UPDATE`, already serialized by the reward lock), sets its `redemption_id`, and writes
    the redemption as `status = 'delivered'`, `ended_at = now()`, `ended_by = 'delivery'`, `reserved_until` NULL. The
    status CHECKs become: `reserved_until` NOT NULL exactly when reserved; `delivered` only with `ended_by =
    'delivery'`. No pickup, no timeout, no cancel (cancelling answers RE409 `delivered`: the code was already seen).
    The per-player limit counts `reserved` and `delivered`. Sold out when every code is given (units_out =
    stock_total), as for items.
13. **Reveal (FR-511):** `reserve_reward` returns the cipher for a digital redemption; `my_redemptions` returns it for
    the caller's own delivered digital redemptions only. The API decrypts and answers `code` in the reserve answer
    (also on a replay) and in the shop's `redemptions`. A cipher that fails to open logs `reward.code_unreadable`
    (ids only) and answers the redemption without the code plus a `codeUnavailable` flag, never a 500 for the whole
    shop. Codes never reach logs, audit rows or error bodies.
14. **Low codes (FR-512):** low when a digital reward has codes left ≤ max(5, 10% of uploaded) — a named constant,
    computed in the API's reward record (`lowCodes: true`). The dashboard's Rewards page shows a warning banner naming
    each low reward and its remaining codes; a sold-out digital reward is listed too. No warning when none is low.
15. **The app:** a digital reward card shows "Code" instead of pickup wording; confirm says the code appears at once
    and cannot be cancelled; the result screen shows the code (selectable, large, monospace, LTR inside RTL); My
    rewards keeps it under the redemption. Copy through ux-araby.

## Phases

1. **Database (migration 0025)** + integration tests: the setting and its lock (draft, scheduled changeable; live,
   ended refused; the owner connection not blocked); on/off reserve, cancel and expiry ledger rows and score; return
   mirrors the redeem even if the setting flipped by the owner in between; ranking marked when on, not when off; ledger
   sums equal score and balance; digital: create at 0, stock guard, upload raises stock, duplicate refused, two
   players for the last code at once (one gets it, one sold out), no code given twice over 50 concurrent reserves,
   per-player limit counts delivered, cancel refused, expiry skips delivered; outsider and cross-tenant tests for
   `reward_code` (no read of cipher/hash columns by the organizer role, nothing for a player or anon).
2. **API:** config secret, the crypto module (unit tests: round trip, wrong reward id fails, tampered byte fails, hash
   stable and trimmed), upload route, reserve/shop answers with the code, settings field and 409, low-codes flag;
   route integration tests; API.md, DATA_MODEL, SECURITY (the key, what is encrypted, the rotation limit), RUNBOOK
   (`REWARD_CODE_SECRET` on CranL).
3. **Dashboard:** the switch with its text and lock; digital kind in the form (no stock field), the codes panel
   (paste or file, counts, result), the low-codes banner; the rewards browser test extended (switch, upload, banner).
4. **App:** the rank note on confirm, the digital confirm, the code reveal and history; pure logic tests; `expo
   export`.

Mutation testing on `apps/api/src/rewards` (core). Docs: TASKS (T-219, T-203 ticked; FR-505 now whole), SRS
traceability rows, DECISIONS (ADR-135 Proposed: digital redemptions are instant and final, codes encrypted in the API),
INBOX if Dhia says anything, STATE.

## CTO plan review (Opus, 84 → revisions below, re-scored on the code review)

- **M1 (fixed):** only the owner (or a Questify admin) changes `spend_lowers_rank`. The guard trigger also checks
  `app_is_owner(organizer_id) OR app_is_admin()` (QO403 → 403 `owner_only`); an editor sending the same value passes.
  Route test: an editor's change is refused; the audit row names the owner who changed it.
- **M2 (fixed, ADR-135 Proposed, Q-106 for Dhia):** a redeem lowers the score only while the event is `live`
  (`event_status_now`); in the days the shop stays open after the end, spending moves the balance only, so the final
  score never changes after the end. A return mirrors its own redeem, so a post-end cancel of a live-time spend
  restores the score. Test: on, spend after the end, the score is unchanged.
- **M3 (fixed):** the upload is a definer `add_reward_codes(reward, ciphers bytea[], hashes bytea[])` returning
  `(added, duplicates, stock_total, stock_left)`: checks the organizer's scope (or admin), the reward active and digital
  (RN404 / RD409), locks the reward, inserts with `ON CONFLICT DO NOTHING`, raises the stock by what was inserted, fills
  the tenant keys from the reward. `questify_app` has no write grant on `reward_code`. Above 100 000 codes: RC422 → 422
  `too_many_codes`.
- **Minors folded in:** the ranking mark is a direct insert into `ranking_repair` (cancel by a player who left, expiry);
  the tie position after a return is not restored (API.md); no code while `units_out < stock_total` raises (never a
  codeless delivery), a partial index on unused codes, `redemption_id` a real FK; a ledger-sum test that score ≥
  balance in both modes, with a note that any future balance-only credit breaks it; the upload's `bodyLimit` (1.5 MB),
  in-request duplicates removed, NFC before trimming and hashing, a replay answers the first answer; SECURITY notes the
  code must stay out of any shared idempotency cache, and a log-capture test shows no code in the logs; the banner copy
  covers a new reward with no codes; a note on T-211 (rehearsal cannot take back a shown code).
