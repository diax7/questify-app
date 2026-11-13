# T-812 Device-integrity flag (FR-334): short plan

Source: `docs/TASKS.md` T-812, FR-334 (`docs/SRS.md:194`), ADR-153 (flags in v1; integrity later), ADR-154 (a flag
holds the desk only through the owner's hold, never play). Flag kinds so far: `shared_device`, `burst` (0031),
`far_from_venue`, `impossible_speed` (0048), `minigame` (0050), `nfc_copy` (0056). Migration **0198**. ADR-833 and
Q-779 onwards (check the newest numbers again before writing).

**Done when:** a phone whose Play Integrity verdict or App Attest attestation/assertion fails raises a
`device_integrity` case on the Flags page for every account of a live event that played on that install, and the
player still plays and redeems (the case holds the desk only while the owner's hold is on, as every flag). Without
keys the API starts and behaves exactly as today: the challenge door answers `{ enabled: false }`.

## Server
1. **Challenge** `POST /v1/me/device-integrity/challenge` `{ platform }` (player, X-Device-Id required): a stateless
   challenge, `v1.<expiry>.<random>.<mac>`, the HMAC over player, install and expiry with a key derived from
   `AUTH_SECRET` (purpose `device_integrity`), valid 10 minutes. No table: the vendor verdict carries it back
   (Play Integrity `nonce` or `requestHash`; App Attest `clientDataHash = SHA-256(challenge)`), and App Attest's
   counter stops an assertion replay. `{ enabled: false }` when the platform has no keys.
2. **Check** `POST /v1/me/device-integrity` (player, X-Device-Id, 10 an hour per player):
   - Android `{ platform, challenge, token }`: Google's `decodeIntegrityToken` with a service-account token (the
     existing `createGoogleTokenSource`, scope `playintegrity`), 4 s timeout each. Fails on: not
     `MEETS_DEVICE_INTEGRITY`, app not `PLAY_RECOGNIZED`, wrong package, nonce/requestHash not ours, older than
     10 minutes, or a token Google calls invalid (400).
   - iOS `{ platform, challenge, keyId, attestation }` once, then `{ …, keyId, assertion }`: CBOR and DER parsed in
     house (no new dependency): chain to Apple's App Attestation root, the nonce extension
     `1.2.840.113635.100.8.2`, key id = SHA-256 of the key, rpId = SHA-256(`TEAM.bundle`), counter 0, `aaguid`
     production (or development when set), credential id. Assertion: ECDSA over SHA-256(authData‖clientDataHash),
     rpId, counter strictly above the stored one (locked row).
   - Answer `{ next: "done" }` whatever the verdict (the player is never told it failed, ADR-154), `{ next: "attest" }`
     for an unknown or other-install key, and `{ next: "later" }` when Google could not answer (nothing recorded,
     rule 5 fallback; the app tries again next launch). Logs carry only the platform, the outcome and reason codes.
3. **Data (0198):** `device_check` (install id PK, platform, verdict, reasons, the last player, checked_at) and
   `app_attest_key` (key id PK, install, player, SPKI, counter, environment), both RLS forced, no grant, written by
   definers on the active player seat (`push_player()`), erased when the player becomes a tombstone (trigger).
   `flag` gains `device_integrity` (with `device_id`, once per account and install, like `shared_device`); raised
   by `record_device_check` for the install's accounts in live events and by an AFTER INSERT trigger on
   `quest_completion` for a later scan from a failed install. `event_flags`/`flag_detail` show it with its
   evidence `{ platform, reasons, checkedAt }`.
4. **Config:** `PLAY_INTEGRITY_SERVICE_ACCOUNT` + `PLAY_INTEGRITY_PACKAGE`; `APP_ATTEST_TEAM_ID` +
   `APP_ATTEST_BUNDLE_ID` (+ `APP_ATTEST_DEVELOPMENT=true` for development builds). Each pair all or none.

## Web
The dashboard's Flags page and the console learn the kind ("Device failed the integrity check") and the evidence
lines (platform, reasons). Arabic and English.

## App
Both vendors need a native module (App Attest's `DCAppAttestService`, Play's `IntegrityManager`); none is in the
app. No dependency is added here: the plan for the build goes in T-812's notes (RUNBOOK "Needs a new build").

## Tests (offline)
Unit: CBOR, DER, challenge, App Attest with a test root built at test time (a fabricated chain signed in the test),
Play Integrity against a local HTTP fake of Google's token and decode endpoints (pass, each failure, 400, 500,
timeout). Config: off without keys, all-or-none errors. DB: the flag on record and on a later scan, once per account,
none for a pass, never blocking a scan, erasure. Security suites: the two tables and the new definers.
