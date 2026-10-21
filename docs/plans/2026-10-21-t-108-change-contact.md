# T-108 — Change or add a phone or email with a fresh code; the sign-out explanation

Delivers the server side of FR-125 and FR-139, and what FR-1817 needs from the server; FR-123 and FR-124's server half
shipped with T-107 (rotating refresh tokens, sign-out by refresh token). The screens (the change and add forms, the
sign-out confirmation, the once-only add-email card) wait for the app shell (T-009) and are notes on T-111. Core
(sign-in and account data): Max.

## Scope note

- **Reuse:** the T-107 send path (`contactOf` for the shapes, `sendCounts` and `firstFull` for the windows, the platform
  SMS and email budgets, the Msegat sender and the email path, `generateCode`, the keyed hashes), `player_contact` (one
  phone and one email per player, each unique), the player guard, `GET /v1/me`, the ranking repair trigger on contact
  changes (0019: email and phone).
- **Not here:** removing an identifier (no FR asks for it, and an account must keep one); the ban fingerprint check on
  a new contact (the fingerprint table arrives with deletion, T-217: a note there); account recovery when both are lost
  (support, T-7xx).

## Decisions (tactical; for the CTO to challenge)

1. **One flow for change and add (FR-125, FR-139):** the player asks for a code to a phone or email; once the right code
   is entered, that channel's value on `player_contact` becomes the new one, replacing the old value if there was one,
   adding it if not. The other channel is untouched. Sessions stay.
2. **A challenge of its own, bound to the player:** `player_contact_challenge (id, player_id, token_hash, channel,
   contact, contact_key, code_hash, attempts ≤ 3, expires_at 5 minutes, created_at)`, no grant to the API role; the same
   CHECKs on the contact as `player_login_challenge`. A new request ends the player's earlier contact challenge. Swept
   with the sign-in challenges.
3. **Definers:** `start_contact_change(token, channel, contact, key, code_hash)` bound to `app_player_id()` (an active
   player): `unchanged` when it is already the player's, `taken` when another account has it (FR-139 says the app
   explains), else `started`. `confirm_contact_change(token, code_hash)` bound to the same player: `changed`,
   `invalid_code` (attempts left), `expired`, `taken` (someone took it meanwhile: the unique index decides, no 500).
   Both pinned, closed to PUBLIC, granted to `questify_app`.
4. **Limits:** the same send windows as sign-in for the new contact, the install and the address (so changing cannot
   be used to send unlimited SMS), plus a per-player window: 5 codes an hour, 10 a day; wrong codes as sign-in (3 per
   challenge). The platform SMS budget counts these SMS too. "Taken" answers reveal that a contact has an account; that
   is FR-139's behaviour, limited to a signed-in player within these windows.
5. **Telling the old address (account takeover):** when the email changes, or the phone changes on an account with an
   email, an email goes to the old (or current) email saying the change happened, in both languages, with the support
   route (no link that undoes it: support handles that, T-7xx). No SMS to the old phone (cost; the email covers most
   accounts). Best effort: a failed notice is logged, the change stands.
6. **Routes:** `POST /v1/me/contact/code {channel, value, lang?}` → `202 {challengeToken, expiresInSeconds}`;
   `POST /v1/me/contact/verify {challengeToken, code}` → the profile (as `GET /v1/me`). Errors: 400, 401
   `invalid_code` (`details.attemptsLeft`), 409 `contact_taken` / `contact_unchanged`, 410 `challenge_expired`, 422
   `phone_not_supported` / `invalid_email`, 429, 503 `sms_unavailable` / `email_unavailable`. Codes typed with
   Arabic-Indic digits work (`typedCode`).
7. **`GET /v1/me` gains `identifiers: {phone, email}`**, masked (`•••• 4567`, `s•••@najd.sa`) or null, so the app
   knows which one is missing (FR-1817's add-email card, FR-139) without the profile carrying contacts.
8. **Logs:** events carry the channel and the outcome, never the contact (as sign-in).
9. **Sign-out copy (FR-124):** the confirmation text is app copy; the messages land with the screen (T-111 note).

## Data

Migration 0020: `player_contact_challenge`, `start_contact_change`, `confirm_contact_change`, the sweep extended. The
player's `player_contact` row is updated by the definer only (the API role keeps no UPDATE on it: check and narrow
0005's `GRANT UPDATE (phone_e164, email)`).

## Tests

- Database: change and add for each channel; another player's contact is `taken` at start and at confirm (a race); the
  player's own is `unchanged`; wrong codes count and end the challenge at 3; expiry; a new request ends the old
  challenge; bound to the caller (another player's token does nothing); the API role cannot update `player_contact`
  directly; outsider and empty-context probes; the ranking repair mark on change.
- HTTP: every answer and error; the windows (per player, per contact, the platform budget); Arabic digits in the code;
  the old-email notice (sent, and a failure that leaves the change in place); `identifiers` masked; logs hold no contact.
- Mutation on the new modules.

## Phases

1. **Database:** migration 0020, tests.
2. **API:** the module, routes, notices, `identifiers`, tests, mutation.
3. **Docs:** API.md, DATA_MODEL, SECURITY (takeover notice, enumeration), TASKS (T-111 screens, T-217 fingerprint),
   STATE.

## Revision 1 (after CTO plan review 1, 80/100) — overrides the sections above where they differ

- **B1, audited:** `confirm_contact_change` writes `audit_log (actor_type 'system', action 'player.contact_change',
  target 'player', after {channel, kind: added|replaced})` in its transaction, as `create_player` does for
  `player.signup` (the actor types are admin, staff and system; the target names the player). Never the contact.
- **M1:** a wrong code on `POST /v1/me/contact/verify` is **422 `invalid_code`** (`details.attemptsLeft`), as quest
  completion answers; 401 stays "not signed in".
- **M2, no new oracle:** `start` never says `taken`. The code goes to any value that is not the player's own
  (`contact_unchanged` 409 for their own, which tells them nothing new), and `taken` is decided only at `confirm`, by the
  unique index: only someone who holds the contact learns it has an account (FR-139 is met there). Every start counts in
  the per-player window (5 an hour, 10 a day) before anything else. SECURITY.md records it.
- **M3, notices on every change and add:** after a confirmed change or add, a notice goes to the *previous* value of
  the changed channel (if there was one) and to the *other* channel (if present): SMS for a phone, email for an email,
  in Arabic and English, never naming the new value. Best effort; each notice takes from the platform SMS or email
  budget, and a spent budget skips it with `player.notice_skipped` (channel only). SECURITY.md records, as a Proposed
  decision (ADR-120), that changing a contact does not re-prove the old one (ASVS 5.0 V7.5.1 asks for re-authentication;
  a player who lost their number cannot give it) and the compensating controls: a fresh code to the new contact, the
  notices, the audit entry, sessions kept so the real owner can change it back, support for the rest.
- **M4, honest code texts:** an SMS and an email of their own ("your code to add this number/address to a Questify
  account"), and the notice SMS and email, in both languages (ux-araby), Western digits, the SMS in one segment.
- **m1:** `POST /v1/me/contact/verify` takes an Idempotency-Key (the existing layer, as quest completion): a lost answer
  on event Wi-Fi replays `changed`, not `expired`.
- **m2:** `confirm_contact_change` returns the channel, the kind, the previous value of that channel and the other
  channel's value, for the notices (no second read).
- **m3:** wrong codes count in `failureCounts` (per contact and per address) as at sign-in, besides 3 per challenge.
- **m4:** 0020 revokes INSERT and UPDATE on `player_contact` from `questify_app` (every row comes from `create_player`
  and changes through the definer); tests from the API role.
- **m5:** as M3: notices take from the platform budget; tested.
- **m6:** OPEN_QUESTIONS (Q-096): an excluded employee can change a work email or phone and return to a board
  (FR-319 checks the current contact); the audit entry is the trail; the deletion fingerprint (T-217) could hold
  previous contacts. **m7:** a note on T-212 (FR-135): what happens to an enrollment whose player leaves the locked
  domain.
- **Nits:** no `contact_key` on the new challenge; API.md says a resend is a new request (it ends the old challenge,
  counts in the per-player window), so the app's timer follows; the `MyProfile` comment and the `GET /v1/me` row name
  the masked identifiers; an add counts as a change for the notices.

## Result (2026-10-21)

CTO: plan 80 → 94; phases 93, 93, 95 (GO). Found while building:
- The code hash is bound to the challenge token's own hash (`playerCodeHash(hashToken(token), code)`), so verify needs
  no row lookup to know the challenge id.
- Two starts at once raced on the per-player unique index: `start_contact_change` upserts on `player_id`.
- A refused notice SMS answers rather than throws: `notify` branches on the result, and the two notices go side by side
  (`Promise.allSettled`) so slow gateways do not hold the answer.
- The new error code is `contact_in_use` (409): `contact_taken`'s message is sign-up wording.
Mutation: 80.1% on the first run (log events and outage paths were untested); after tests for the send windows, the
platform budgets, the email outage, the English code, skipped and refused notices and every log event: 92.2% on
`contact.ts`, 91.5% on `profile.ts`. Lock contention, a database-failure rethrow and an impossible branch carry reasoned
`Stryker disable` comments.
