# Audit hardening, crypto keys (plan, tier A: signing keys, sealed reward codes)

Source: security audit run 1 hardening notes (w2-crypto 2, 3 and 4; hunter-edge 9). **No migration** (0191 stays free).
TypeScript: `src/auth/keys.ts`, `src/config.ts`, `src/marketing/opt-out.ts`, `src/rewards/codes.ts`, `src/rewards/builder.ts`,
`src/rewards/reseal.ts`, the opt-out length constants in `apps/web` and `packages/shared`. No new table, grant, route or
string. Delivers no FR. Two Proposed ADRs (amending ADR-317 and ADR-136/ADR-727), one OPEN_QUESTIONS entry; use the next free
numbers.

**Done when:** after an `AUTH_SECRET` rotation, an opt-out link sent before it still turns marketing off while the previous
secret is held, and is refused once it is removed. The same voucher uploaded to two organizers' events leaves two different
`code_hash` values; duplicates within one event are still found, including during a reward-code rotation.

**Order.** (1) failing tests (section 4), (2) TypeScript, (3) hand mutants (section 5), (4) staging: deploy, then
`reward-codes.cjs reseal` and `check`, (5) docs. Run after step 2: touched suites, `test/rewards/*`, `src/config.test.ts`,
`apps/web/src/lib/opt-out.test.ts`, `packages/shared/src/messaging/templates.test.ts`.

## 1. Where things are today

| Object | Where | Today |
|---|---|---|
| opt-out token | src/marketing/opt-out.ts:28-48 | `id16 ‖ channel1 ‖ tag16` (33 bytes); no key id |
| opt-out key | src/auth/keys.ts:119, 143 | `keyed("marketing-opt-out")` from the one `AUTH_SECRET` |
| `AUTH_SECRET` config | src/config.ts:151-155; app.ts:444 | one secret, no id, no previous |
| reward-code key pattern to copy | src/config.ts:300-327, rewards/codes.ts:5-59 | key id 1-255, previous id and secret together, ids and secrets differ |
| opt-out readers and lengths | marketing/routes.ts:118; web lib/opt-out.ts:5-8; invitation-campaigns/message.ts:15-17; shared messaging/templates.ts:45 | 44 base64url characters |
| mark key | rewards/codes.ts:40-48, 137-139 | one HKDF key `questify/reward-code/v1/mark` for every organizer |
| mark writers | builder.ts:876-881; reseal.ts:107-125, 132-150 | `markCode(ring.current, code)` |
| mark scope in SQL | 0025:80 `UNIQUE (event_id, code_hash)`; add_reward_codes 0189:72-110 | compared only inside one event |
| reward AAD | rewards/codes.ts:74-84, 116-121 | header ‖ reward id |
| invitation link | 0073:202, 0153:16, 0173:54, 88, tick.ts:76, 0073:1205-1240 | stored in clear |

## 2. Verdicts

- **w2-crypto 4: real, kept.** ADR-317 accepted that rotating `AUTH_SECRET` breaks old links, but that fails closed on a legal
  duty (IR Art. 12): a player tapping an old link cannot withdraw. Copy the reward-code key id pattern, opt-out purpose only.
- **w2-crypto 3: real, kept, cheap now.** Marks are compared only within one event, so a per-organizer key needs no SQL; the
  organizer is known at both writers (store.ts:252; `reward_code.organizer_id`, 0025:73). No production yet, so the existing
  `reseal` re-marks staging with no migration; after launch this costs a rotation-sized walk.
- **w2-crypto 2: dropped.** `reward_id` is pinned to one event by `FOREIGN KEY (reward_id, event_id)` (0025:82); the row id is
  assigned after sealing, so binding it needs a v3 format and a re-seal of every row; only the database owner can swap ciphers,
  and swapping between codes of one reward exchanges equal vouchers. Record as accepted in SECURITY.md (V11 row).
- **hunter-edge 9: dropped.** The link grants only the public event card plus one `opened` count (0073:1225-1238); joins are
  credited by player (0073:1050-1061); rows are purged 90 days after the campaign. Hashing needs the plain link at claim time,
  and a re-claim after a lost acknowledgement would kill a sent link. Correct SECURITY.md's random-tokens row (it wrongly says
  PostgreSQL stores only the SHA-256 of the invitation link) and add the hash design to FOLLOWUPS.

## 3. Changes

### 3.1 Opt-out key ids (w2-crypto 4)
- config.ts `authConfig`: `AUTH_KEY_ID` (1-255, default 1, reuse `keyId`); `AUTH_PREVIOUS_SECRET` and
  `AUTH_PREVIOUS_KEY_ID` go together (as :304-326); ids differ, secrets differ, each secret 32+ characters; messages name the
  setting, never the value. `AuthConfig` gains `keyId` and `previous`.
- keys.ts: `createAuthKeys(secret, optOut?: { keyId; previous?: { id; secret } })` (optional; other callers unchanged). The
  previous secret derives only `marketing-opt-out`. New: `optOutKeyId`, `optOutTagUnder(keyId, playerId, channel)` (undefined
  for an id it does not hold). Tag input `${keyId}\n${playerId}\n${channel}`.
- opt-out.ts: token `id16 ‖ channel1 ‖ keyId1 ‖ tag16`, 34 bytes, 46 base64url characters; channel stays at byte 16. Exact
  length and canonical spelling, named key or null, constant-time compare. No reader for the old 33-byte token (no production
  message was ever sent; only staging links end).
- Length constants: web `lib/opt-out.ts` (34, `{46}`), message.ts `PLACEHOLDER_OPT_OUT` (46), shared templates.ts:45 (46), and
  the 44s in tests (`grep -rn "repeat(44)\|{44}"`).
- app.ts:444 passes `config.auth`. RUNBOOK rotation: new secret, new `AUTH_KEY_ID`, previous pair = old values, redeploy, drop
  the previous pair after 90 days (at once if the old secret leaked).

### 3.2 Per-organizer mark (w2-crypto 3)
- codes.ts: `markKeyFor(key, organizerId)` = `hkdfSync("sha256", key.mark, "", "questify/reward-code/v2/mark/" + organizerId,
  32)`; throws unless a lowercase UUID. `markCode(markKey, code)` takes the derived key. Seal unchanged.
- builder.ts:879-881: derive once per upload from `actor.organizerId` for `ring.current` and `ring.previous`.
- reseal.ts: `codeBatches` also reads `organizer_id::text` and `code_hash`; `plan` treats a row as current only when its cipher
  is current and `code_hash` equals the expected mark, otherwise re-seal and re-mark (one compare-and-set); cache mark keys per
  organizer per batch; `checkCodes` counts a wrong mark as `stale`; re-marks count as `resealed`. Update codes.ts:23-27 and
  reseal.ts:22-26 comments.
- Between deploy and re-seal a re-upload of a code stored under an old mark is not caught (the conflict case reseal.ts:24
  describes); run `reseal` straight after the staging deploy.

## 4. Tests (written first, failing on today's code)
- `src/marketing/opt-out.test.ts`: 34 bytes, byte 17 is the current id, round-trips; a previous-key token opens while held and
  is null once removed; id byte flipped to the other held id: null; unknown id, 33-byte token, non-canonical spelling, a token
  tagged under the previous secret but labelled with the current id: null.
- `src/auth/keys.test.ts`: with a previous secret every other purpose equals `createAuthKeys(current)`; unknown id gives
  undefined.
- `src/config.test.ts`: default 1; 0, 256, `x` refused; previous half alone refused; equal ids, equal secrets, short previous
  refused; no value in messages.
- `src/marketing/routes.test.ts`: previous-key token 204 and the channel goes off; with no previous key 400 `invalid_opt_out`.
- web `opt-out.test.ts`: 46 characters gives its channel, 44 gives null. Shared `templates.test.ts`, `message.test.ts`: the
  worst-case Arabic SMS still fits in 3 parts.
- `src/rewards/codes.test.ts`: two organizers give two marks; one organizer stable; uppercase or non-UUID throws; v2 is not the
  old global mark; an existing sealed fixture still opens.
- `test/rewards/codes-routes.int.test.ts`: organizers A and B store different `code_hash` for one code, both added; a repeat in
  one event is a duplicate; during a rotation, re-uploading a code A stored under the previous key is a duplicate.
- `test/rewards/reseal.int.test.ts`: current cipher with the global mark is re-marked; a second run all `current`; `check`
  lists a wrong mark as stale; conflict and changed paths unchanged.

## 5. Hand mutants (each must turn a section 4 test red)
Opt-out: drop `keyId` from the tag input; reader ignores the id byte; length check accepts 33; previous secret feeds all
purposes; "ids differ" check removed; id byte read at offset 16. Mark: drop `organizerId` from the info; prior marks use
`ring.current`; `plan` ignores the mark; `checkCodes` ignores the mark; lowercase-UUID guard removed.
Mutation (CI): `auth/**`, `config.ts`, `rewards/**`; check whether `marketing/**` is in `stryker.config.json`.

## 6. Risks
SMS grows by 2 characters (template tests confirm the 3-part budget). An old secret kept past the window can only switch
marketing off. Before re-seal, staging misses duplicates (no customer impact). `actor.organizerId` must be the event's
organizer (`lockBuilderEvent`, store.ts:252).

## 7. Docs
SECURITY.md (:247, :262, the `AUTH_SECRET` and `marketing-opt-out` rows, V11 AAD acceptance, random-tokens row), RUNBOOK
("Rotating `AUTH_SECRET`", settings list, staging re-seal step), DECISIONS (two Proposed ADRs), OPEN_QUESTIONS (previous-key
window length), FOLLOWUPS (invitation link hash design; per-event marks option), STATE.md.

## 8. Plan review (CTO, 88) and decisions

These win over the sections above where they differ. Paths under `src/` and `test/` are relative to `apps/api`.

1. `apps/web/e2e/opt-out.spec.ts:9-19` builds the token by hand: it moves to the 34-byte format (key-id byte 1, the
   default `AUTH_KEY_ID` under `testConfig`, and the tag input `${keyId}\n${playerId}\n${channel}`). Playwright is not
   run locally; the spec must typecheck.
2. `apps/api/src/marketing/opt-out.ts` joins `mutate` in `stryker.config.json` (Stryker is not run locally).
3. `OptOutSigner = Pick<AuthKeys, "optOutKeyId" | "optOutTagUnder">` is defined in `opt-out.ts` and used at tick.ts:39,
   marketing/routes.ts:42, questify/routes.ts:45 and the stub at questify/routes.test.ts:38. `optOutTag` goes.
4. The stale comments (message.ts:15, web lib/opt-out.ts:5) and every opt-out 44-character literal (grep `44}` and
   `repeat(44)`, including message.test.ts:107 and marketing/opt-out.test.ts:12, 64) are updated.
5. codes-routes.int adds the rotation duplicate case: organizer A's row uploaded through the API with a ring whose
   current key is today's previous key (a v2 per-organizer mark), then re-uploaded during the rotation, is a duplicate;
   organizer B uploading the same code during the rotation is added, not a duplicate.
6. Saved `promo_sms` templates were checked at save time with the 44-character sample: the save-time sample becomes 46,
   with a test that a template at exactly the 3-part limit under the old sample is refused at save with the new link.
   RUNBOOK notes that templates saved before this change should be re-saved if near the limit.
7. The `reseal.ts` conflict comment (the v1-to-v2 re-mark window) and the `checkCodes` doc comment are updated.
