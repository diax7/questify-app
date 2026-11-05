# T-810f - Reward code key id and re-seal (plan, tier A: reward codes, admin powers)

Source: `docs/TASKS.md` T-810f; T-810b plan section 8 (the outline); ADR-705 (Accepted: key id header, legacy under key
1, a re-seal command on the owner connection); ADR-136 (how codes are sealed today); Q-673; `docs/security/ASVS_L2.md`
gap row 8 and row V11.2.2. Decisions: ADR-725 to ADR-729 (Proposed). Questions: Q-694 to Q-696.
Migration: **0157** (new). T-810d holds 0156 on its unmerged branch (`worktree-agent-a77495185b3a0998e`, waiting on DNS),
so this task takes 0157; if T-810d is dropped the number stays (a gap is harmless) or is renumbered before merge.
Delivers no FR.

**Done when** (TASKS.md): a rotation followed by the re-seal leaves every code readable, tested, and the sheet's row 8
is Met.

**Order.** One build, one commit per step: (1) `codes.ts` keyring and format with unit tests, (2) config, (3) 0157 and
its DB tests, (4) upload and reveal wired to the keyring, (5) the re-seal command and its tests, (6) docs (RUNBOOK
rotation procedure, SECURITY.md V11 row, ASVS sheet, DATA_MODEL). The security suites (`apps/api/test/security/*`) and
`test/db/rehearsal.int.test.ts` run after step 3.

---

## 1. Today

`REWARD_CODE_SECRET` gives two HKDF keys (`seal`, `mark`; `apps/api/src/rewards/codes.ts`). A code is stored as
`iv(12) ‖ tag(16) ‖ ciphertext` (AES-256-GCM, AAD = reward id) in `reward_code.code_cipher`, and its HMAC mark in
`code_hash`, unique per event (0025). Only `add_reward_codes` writes rows and only `reserve_reward` and the player's
redemption list hand a cipher back; the API opens it in one place (`apps/api/src/rewards/shop.ts`, `reveal`). Nothing
says which key sealed a row, so a new secret makes every code unreadable (RUNBOOK "REWARD_CODE_SECRET").

## 2. Seal format (ADR-705, ADR-726)

- **New seals:** `0x51 0x02 keyId ‖ iv(12) ‖ tag(16) ‖ ciphertext`. `keyId` is 1 to 255. AAD is the 3 header bytes
  followed by the reward id, so a header cannot be swapped onto another key's body (GCM refuses it either way; the AAD
  makes it explicit and costs nothing). Shortest value 32 bytes; 0025's CHECK (29 to 1,024) holds, so no column change.
- **Opening** (`openCode(ring, rewardId, sealed)`):
  1. If the value starts `0x51 0x02` and the ring holds key `sealed[2]`, open it as the new format. Success returns.
  2. Otherwise, if the ring holds key 1, open the whole value as the legacy format under key 1 (AAD = reward id).
     This covers a legacy IV whose first bytes happen to be `0x51 0x02 x` (1 in 65,536 of legacy rows).
  3. Otherwise undefined. A wrong key is always a GCM refusal, never a wrong code.
- `openCode` also returns which path opened it (`{ code, keyId }`, legacy reported as key 1 with `legacy: true`) so the
  re-seal can tell "already current" from "needs re-seal" without SQL byte tests.
- **Keys:** derivation per secret is unchanged (same HKDF salt and labels), so key 1 is exactly today's key.

## 3. Config (ADR-725)

| Setting | Meaning |
| --- | --- |
| `REWARD_CODE_SECRET` | the current secret, 32+ characters (unchanged) |
| `REWARD_CODE_KEY_ID` | its id, 1 to 255, default 1 (today's secret is key 1) |
| `REWARD_CODE_PREVIOUS_SECRET` | optional; the secret being retired, read only to open and re-seal |
| `REWARD_CODE_PREVIOUS_KEY_ID` | required with the previous secret, 1 to 255, different from the current id |

Refused at start (fail fast, message names the setting, never the value): an id outside 1 to 255 or not an integer;
one of the two previous settings without the other; equal ids; the previous secret equal to the current one; a
previous secret under 32 characters. One previous key at a time instead of ADR-705's list (`id:secret,...`): a list
needs a separator the secret may contain, and the re-seal empties the previous key before the next rotation (Q-694).

`config.rewardCodeSecret: string` becomes `config.rewardCodes: { current: { id, secret }, previous?: { id, secret } }`;
`createRewardCodeKeyring(config.rewardCodes)` replaces `createRewardCodeKey` (one call site in `app.ts`; the test
config in `test/support/auth-app.ts`). `RewardCodeKey` becomes `RewardCodeKeyring`:
`{ current: { id, seal, mark }, keys: ReadonlyMap<number, { seal, mark }> }`.

## 4. Duplicates during a rotation (migration 0157, ADR-727)

While a previous key is loaded, an old unused code has its mark under the old key, so a new upload of the same code
would not hit `UNIQUE (event_id, code_hash)`.

- `DROP FUNCTION add_reward_codes(uuid, bytea[], bytea[])`; `CREATE FUNCTION add_reward_codes(target uuid,
  ciphers bytea[], hashes bytea[], prior_hashes bytea[] DEFAULT '{}')`, the 0025 body plus: `prior_hashes` is empty or
  pairs with `ciphers` (else `invalid_parameter_value`); the insert takes `unnest(ciphers, hashes, prior_hashes) WITH
  ORDINALITY` and skips an item when `prior_hashes` is not empty and a row of the event has `code_hash =` its prior
  mark. Skipped items count as duplicates (`given - inserted`, unchanged).
- The default keeps three-argument calls working, so the old API instance uploads normally between the migration and
  the switch-over (no deploy window).
- `SET LOCAL lock_timeout = '10s'`; `REVOKE ALL ... FROM PUBLIC` and the same single `GRANT EXECUTE ... TO
  questify_app` next to the create; nothing else granted. The security suites' function lists and the rehearsal list
  take the new signature.
- **Races.** The prior check reads the statement's snapshot; a re-seal that commits before the statement turns the old
  mark into the current mark, which `ON CONFLICT (event_id, code_hash)` catches; one that commits after it leaves the
  old mark visible to the check. Either way the code is counted once. A DB test runs the upload and a re-seal of the
  same code in two connections in both orders.
- `builder.ts` `addRewardCodes`: seals and marks under the current key; `prior_hashes` are the marks under the
  previous key when one is loaded, else empty.

## 5. Re-seal command (ADR-705, ADR-728)

`apps/api/src/reward-codes-cli.ts`, bundled as `dist/reward-codes-cli.cjs` and copied to `/srv/reward-codes.cjs`
(build script and Dockerfile, like `staff.cjs`). Run inside the API container with `DATABASE_ADMIN_URL` (the owner, as
`migrate.cjs`) and the API's reward code settings. Logic in `apps/api/src/rewards/reseal.ts` (pure of the CLI, tested).

- `node reward-codes.cjs reseal [--by <name>]`
  - Stops before any write unless the connection is a superuser or `BYPASSRLS` (`reward_code` has FORCE row-level
    security and no owner policy): "the owner ... cannot read reward_code; run with DATABASE_ADMIN_URL".
  - Walks `reward_code` by id, 500 rows a batch, each batch one transaction. For each row: open it with the ring; if it
    opened under the current key in the new format, skip (`current`); if it cannot be opened, report its id
    (`unreadable`) and leave it; else seal and mark under the current key and
    `UPDATE reward_code SET code_cipher = $new, code_hash = $mark WHERE id = $id AND code_cipher = $old` (`resealed`;
    0 rows updated is `changed`, picked up by the next run). A unique violation on the mark (the same code twice in one
    event, only possible from data before this task) runs under a savepoint, is reported by id (`conflict`) and skipped.
  - Every row, used or not: a player who redeemed a code sees it again in the redemption list.
  - Writes one audit entry at the end (`reward.codes.reseal`, system actor, `--by` else the OS user, counts only), as
    `staff.cjs grant-admin` does.
  - Prints one JSON line of counts (`current`, `resealed`, `unreadable`, `conflict`, `changed`) and row ids for the
    last three; never a code, cipher or mark. Exit 0 when `unreadable`, `conflict` and `changed` are all 0, else 1.
- `node reward-codes.cjs check`: the same walk without writes and with only the current key: counts rows that open under
  the current key in the new format and lists the ids that do not. Exit 0 only when every row does. This is the
  operator's proof before removing the previous secret.
- Idempotent and resumable: a stopped run is simply run again. A concurrent `reserve_reward` locks the row `FOR UPDATE`
  and sets only `redemption_id`; the re-seal's update waits or goes first, and either cipher opens while both keys are
  loaded.
- No new door: nothing is granted to `questify_app`; the command exists only in the container.

## 6. Reveal

`shop.ts` `reveal` opens with the ring. The `reward.code_unreadable` log line gains the header's key id when there is
one (an id, not a secret) so a missing previous key shows in the logs.

## 7. Rotation procedure (RUNBOOK, replaces "ask each organizer to upload again")

1. Choose the next id (current + 1). In the host's secret store: `REWARD_CODE_PREVIOUS_SECRET` = the current value,
   `REWARD_CODE_PREVIOUS_KEY_ID` = the current id, `REWARD_CODE_SECRET` = a new value (32+ characters, generated in the
   store, never in chat or a file), `REWARD_CODE_KEY_ID` = the next id. Redeploy.
2. `node reward-codes.cjs reseal` until it exits 0 (conflicts: resolve with the organizer by row id, then rerun).
3. `node reward-codes.cjs check` exits 0.
4. Remove the two previous settings; redeploy. Back up the new secret apart from the database, as today. Database
   backups taken before step 2 need the old secret: keep it with them until they expire.

## 8. Tests

- `src/rewards/codes.test.ts`: round trip in the new format; legacy values open under key 1 only; a header for a key
  not in the ring falls back to legacy and is refused; a legacy value whose IV starts `0x51 0x02 0x01` opens; a header
  swapped to another key id is refused; a byte changed anywhere is refused; the header is in the AAD (same body,
  other header refused); marks under each key differ.
- `src/config.test.ts`: every refusal in section 3; defaults; previous key absent.
- `test/db/` (0157): prior marks catch an old code; empty `prior_hashes` behaves as 0025; mismatched lengths refused;
  the two-connection race in both orders; the outsider and cross-tenant suites (signature updated, still nothing for
  `questify_outsider`, `questify_app` still cannot read `code_cipher` or `code_hash`).
- `test/rewards/reseal.int.test.ts`: legacy rows, then a rotation, re-seal, check; every code reveals to its player
  with only the new key loaded; a second run resealed 0; a stopped run (batch size 2, aborted after one batch) finishes
  on rerun; a planted conflict reported by id and the run exits 1; an unreadable row reported; a reservation during the
  re-seal still gets a readable code; a non-owner connection is refused before any write; the output and the audit
  entry hold no code (sentinel check).
- `test/rewards/codes-routes.int.test.ts`: upload during a rotation counts an old code as a duplicate.

Mutation targets (tier A, changed core files): `apps/api/src/rewards/codes.ts`, `apps/api/src/rewards/reseal.ts`.

## 9. Docs

RUNBOOK (section 7, the new settings in "Staff sign-in" settings line), SECURITY.md V11 row (key id, re-seal) and
threat row 10 (rotation procedure written), DATA_MODEL (`code_cipher` format, `add_reward_codes` signature), ASVS sheet
gap row 8 and V11.2.2 to Met, TASKS tick, STATE bullet. The legacy opening path stays (Q-695).

## Needs Dhia

Nothing to build it. One optional step after the deploy (Q-696, asked with AskUserQuestion then): a rehearsed rotation
on staging, where Dhia sets the four settings of section 7 step 1 in CranL's secret settings (the new secret typed or
generated there, never sent in chat), the coordinator runs `reseal` and `check`, and Dhia removes the two previous
settings. Without it the proof is the integration tests only.
