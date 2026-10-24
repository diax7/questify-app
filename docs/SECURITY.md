# Security — Questify

> One page: what we protect, from whom, and how. Stage 6, 2026-10-17. Not a compliance document
> (that is `STORE_COMPLIANCE.md`). Mitigations here also appear in the SRS or `ARCHITECTURE.md`.

## Assets worth protecting

1. **The points record and prize handover.** Cheating, forged points and stolen prizes are the
   product's main fraud target.
2. **Players' personal data** (phone, email, birth year, photos). A leak harms people and breaks
   PDPL and store rules.
3. **Staff and admin accounts.** An admin can read players, change texts for everyone and switch
   features off (ADR-093).
4. **Organizer data and isolation.** One organizer must never see another's data (NFR-016).
5. **Signing keys:** Apple Pass Type ID certificate, push keys, SMS and cloud credentials.
6. **Uploaded prize codes.**
7. **Availability during a live event.** An outage at a festival is the worst day.

## Trust boundaries

Untrusted input enters at: the sign-in code request; the scanned QR/NFC payloads; the quest
completion call; photo and text uploads; mini-game inputs; join-form answers; all organizer-written
text (shown to players); CSV and code uploads; wallet web-service calls; provider callbacks; the
public event page and join code; and the big-screen/station links.

## Who can do what

| Capability | Anonymous | Player | Operator | Editor | Owner | Admin |
|---|---|---|---|---|---|---|
| View public event page | yes | yes | yes | yes | yes | yes |
| Join, play, reserve | no | yes | only if the owner allows (ADR-057) | no | no | no |
| Scan players, award within caps | no | no | yes (own event, abilities, booth) | no | no | no |
| Hand over prizes | no | no | prize-desk operators | no | no | no |
| Create and edit quests, rewards, announcements | no | no | no | yes (own events, per scope) | yes | via logged support edit |
| Invite editors, set event limits | no | no | no | no | yes | yes |
| Export event data | no | no | no | yes | yes | yes (logged) |
| Activate events, set limits and add-ons | no | no | no | no | no | yes |
| View any player record | no | own only | no | no | no | yes, read-only, logged |
| Change texts, switches, templates platform-wide | no | no | no | no | no | yes |
| Add or remove admins; force sign-outs | no | no | no | no | no | yes |

## Authentication

- Players: phone (+966) or email, one-time code; 5-minute expiry; attempt limits; resend limits per
  number, email and IP; tokens rotate.
- Staff (editors, owners, admins): email + password + email code, sessions expire after inactivity,
  sessions listed and revocable (ADR-078, F-293). The user considers this "very safe" (2026-10-17). It
  means a mailbox takeover can open an admin account, which ADR-078 and ADR-094 accepted.
- Passwords: argon2id (19 MiB, 2 passes, 1 lane); 12 to 128 characters counted as code points after NFKC;
  every set (reset, change, `staff-cli create`) refuses the product names and the email's name part (ASVS V6.2.11) and
  any password in Have I Been Pwned's Pwned Passwords list (k-anonymity: 5 hex characters of the SHA-1 leave the
  server, padding on; T-020); never logged.
- Rotating My QR: a signed token with the player id and a 30-second window, verified server-side;
  the wallet-pass fixed code is accepted too (ADR-091) and is therefore a shareable secret by design.

### Staff sign-in controls (T-006) and where they are proven

| ASVS area | Control | Proof |
|---|---|---|
| V6 authentication | argon2id; same answer and same time for unknown, wrong and disabled; one sliding-window throttle per email and per address (8 and 30 failures in 15 minutes) counted across challenges; 5 code attempts per challenge, kept across resends; 5 challenges an hour; second factor is the emailed code (ADR-078) | `test/auth/sign-in.int.test.ts` |
| V7 session management | 256-bit random token stored as SHA-256; `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Strict`; idle 30 minutes / maximum 12 hours (admins 15 minutes / 8 hours), checked against the user's current role on every request; revoke, list, cap of 10 live sessions; disabled users and revoked sessions stop at the next request | `test/auth/sessions.int.test.ts` |
| V6 recovery and change (T-020) | reset by emailed link: 256-bit token stored as SHA-256, in the URL fragment (never in a log, a proxy or a `Referer`), valid 30 minutes, one use (used up by deleting it), one per person; the request answers the same 202 for every email and works after the answer; 3 an hour per email, 10 per address; a reset ends every session and clears the sign-in lockout; a change needs the current password (counted in the sign-in lockout) and ends every other session (ASVS 5.0 V7.4.3); breached-password check fails closed (3 s, one retry); every change emails a notice (admins: the security mailbox too) | `test/auth/password-reset.int.test.ts`, `test/auth/password-reset-paths.int.test.ts`, `test/db/password-reset.int.test.ts` |
| V4 tenant boundary (T-101) | the organizer context counts only for a member staff user (`app_organizer_id()` reads the membership); editor event limits on events, enrollments, players and event audit entries; members join only through invites (definer functions; no INSERT for the API role); a sign-up completes only with the HMAC of the emailed code, checked in the database; the outbound mail budget (400 a day for sign-up and invite mail) keeps sign-in codes deliverable; organizer names that read as addresses are refused | `test/db/organizer-team.int.test.ts`, `test/db/isolation.int.test.ts`, `test/organizers/team.int.test.ts`, `test/auth/sign-up.int.test.ts`, cross-tenant and route suites |
| V11 cryptography | `crypto.randomInt` for codes, `randomBytes` for tokens, HMAC with per-purpose keys derived from `AUTH_SECRET`, constant-time comparison; quest QR codes signed with HMAC-SHA256 (128-bit tag) under a key derived from its own `QR_SECRET`, decoded strictly (one canonical spelling), bound to their quest and version (ADR-116); digital reward codes encrypted with AES-256-GCM under a key derived from `REWARD_CODE_SECRET` by HKDF-SHA-256 (one label per purpose), a fresh IV each, bound to the reward as associated data, repeats found by a keyed HMAC, so the database holds no readable code (ADR-136) | `src/auth/keys.test.ts`, `src/quests/qr.test.ts`, `src/rewards/codes.test.ts`, `test/rewards/codes-routes.int.test.ts` (no code in logs, audit or the stored cipher) |
| V8 authorization (joining, T-111) | players join only through `join_event`, bound to the session; the enrollment insert policy is admin-only (until 0018 a player could enroll in any event by id, private ones included, and an organizer could enroll any player in their own event and so read that player's row); wrong join codes are counted per address (60 in 10 minutes) and per player (20), right ones cost nothing; a miss is reserved before the lookup, so a burst cannot pass the budget | `test/db/join.int.test.ts`, `test/join/join.int.test.ts` |
| V16 logging | events carry the request id, the event name, the user id (when known) and a 12-character keyed tag of the client address; never the email, the address itself, the password, the code or a token; the request serializer writes method and path only (the URL can hold a players search, `?q=`, which is a username prefix: usernames are public pseudonyms, not personal data; never a body: the code request's contact and accepted versions stay out; a request refused for its versions logs no `player.*` event, T-110); `Set-Cookie` and `Cookie` are redacted | "what the logs hold" test |
| V3 / V4 | default-deny staff scope with an explicit public list; `Origin` check on state-changing requests; `no-store` on every staff answer | route-walk tests |

**Thinner wall on the sign-in paths.** Before a person is identified, sign-in code opens exactly one row through
a narrow setting (`app.auth_email`, `app.session_token_hash`, `app.challenge_token_hash`). Trusted code, not
the caller's identity, opens that row, so row-level security protects less here than on identified requests.
Tests assert that one lookup exposes one row and nothing else, and the request can never supply these values.

**Admin power to record.** Any context with `isAdmin` can overwrite any `password_hash` through the column
grant (the baseline `staff_user_own` policy allows admins). That is an admin power under ADR-094; T-701
must not widen it without a decision.

### Audit log (T-004)

| ASVS area | Control | Proof |
|---|---|---|
| V16 logging (security events, log protection) | every state-changing call writes one entry in the same transaction as the change: actor, action, target, organizer and event, before and after, request id, time set by the database. Append-only for every role, owner included; the API cannot backdate or renumber. Entries never hold a secret, an email, a phone number, an address or a user agent (refused in code at any depth). Sign-in success and session end are entries; failed sign-ins stay in the server log | `test/audit/audit.int.test.ts`, `src/audit/entry.test.ts` |
| V8 authorization | an entry can only be written in the caller's own name and organizer; `system` entries only from the owner connection (CLI, jobs); an organizer reads only its own | same suite, plus `test/db/isolation.int.test.ts` |

Changing the table itself (a migration) is guarded by review only. The only sanctioned future change to past
entries is the anonymisation path for a deleted player (Q-084).

Operators are players, and `audit_log` has no player actor: their actions are recorded where they happen instead. A
quest an operator completes or awards carries `operator_id` on its ledger entry; a submission an operator reviews
carries `reviewed_by_operator`, `reviewed_at` and `review_key`, and its approval's ledger entry carries the
operator too (`actor = 'operator'`, T-301). The team's reviews are audited (`event.submission_approved` / `event.submission_rejected`).
A help-desk ticket an operator answers carries `answered_by_operator`, `closed_at` and `answer_key` (T-310); the team's
answers are audited (`event.ticket_answered` / `event.ticket_solved`, ids and the outcome only, never the text).

**Help-desk tickets (T-310, ADR-247).** Who can do what: the sender reads their own tickets in any enrollment status
(`own_tickets`, never who answered); another player reads nothing on any route; owners and editors in their event
limit read and answer every ticket of the event (`award_event_of`); an operator with `help_desk` reads and answers
open tickets that are event-wide or for a quest inside their limit, never their own, and reads a closed one only if
they answered it; an operator without it, `anon` and `PUBLIC` nothing. **T-312 (ADR-257):** operators never see a `report_player` ticket (HT404 on every door); owners and editors escalate with a note and read their escalated tickets read-only; an active platform admin reads exactly the rows with `queue = 'questify'` through the console (`app_admin_id()` re-read in every function, the request flag alone opens nothing), every read audited per event shown (`console.tickets_read`, `console.ticket_read`, ids only), 120 calls a minute; an event ticket never escalated, or sent back, is the same 404 as a missing one; an admin who is also an organizer member keeps each door to its own rule. Outsider suite: every new function refused to `anon` and `PUBLIC`; test/db/tickets-center crosses organizers A and B and the admin who is also a member. `ticket` has RLS
forced and no grant; every function is closed to PUBLIC (outsider suite, `purge_ended_tickets` included), the table is
classified in the cross-tenant suite, and `test/db/tickets.int.test.ts` crosses organizers, events and players. The text
and the reply never reach a log, an audit row or an error (`test/tickets/routes.int.test.ts` reads the logs).

### Points ledger and completions (T-105)

| ASVS area | Control | Proof |
|---|---|---|
| V8 authorization / business logic | one definer function, `complete_quest`, is the only writer of completions and points; the player is the request's own, never an argument; it checks enrollment, event, quest, proof and cap under a lock on the player's enrollment; points come from the quest row, never the request. The rules hold whatever the API sends; the QR signature and the player's identity are the API's (signed code, bearer session) | `test/db/completion-engine.int.test.ts` (a recorded mutation pass over the function's rules), `test/completions/complete.int.test.ts` |
| V8 usernames (T-109) | the API role cannot write a username or a birth year (revoked; only the definers `create_player` and `rename_player` write them, checking the word lists, folding, the change limit under a lock on the player's row); a CHECK on the characters keeps marks, tatweel and zero-width tricks out of every name; the lists cannot hold an entry that matches every name; the refusal never names the matched word; the history is append-only. Only the username and avatar of a player are shown to others (FR-120) | `test/db/usernames.int.test.ts`, `test/db/core-columns.int.test.ts`, `test/players/profile.int.test.ts`, `test/ranking/ranking.int.test.ts` |
| V8 admin powers (T-210) | console routes live only under `/v1/admin/` (the route inventory refuses anything else there), answer 404 to anyone but an active platform admin, and every activation definer re-reads the account (`app_admin_id()`), so the request's admin flag alone is not enough; the hard player limit is a trigger on `enrollment`, serialized per event, so two joins cannot both take the last seat | `test/security/routes.int.test.ts` (console routes), `test/db/activation.int.test.ts`, `test/activation/activation.int.test.ts` |
| V8 rankings (T-106) | readers are the event's active players only; the reader comes from the session (`app_player_id()`), never an argument; `ranking_rows` refuses any other caller with QR403 and names only ranked rows, for ids the API read from Redis (low-ranked players stay visible only to themselves, ADR-052); rebuild, claim and live-event functions run only in the system context (no identity of any kind); `mark_ranking_repair` takes the system or a player of the event. Exclusions (bans, removals, the organizer's own team) are re-checked as rows are read, and every eligibility change marks a repair, so a stale copy never shows an excluded player for long. Redis holds no names or contacts (ADR-118) | `test/db/ranking.int.test.ts`, `test/ranking/ranking.int.test.ts`, `test/ranking/store.int.test.ts` |
| V11 / V16 integrity | the ledger is append-only for every role through any DML, the owner included (ALWAYS triggers on UPDATE, DELETE, TRUNCATE); a DDL change (dropping a trigger) goes through reviewed migrations only. One exception (ADR-157, T-211): the rehearsal wipe may delete rows marked `rehearsal` (set at insert from the enrollment) of its own event, under a transaction-local setting; the API role has no DELETE right, UPDATE and TRUNCATE stay refused, and the erase is audited with counts (`test/db/rehearsal.int.test.ts`). Score and balance are trigger-kept sums of it | same suite |
| V2 / V11 anti-automation | wrong typed codes are reserved before they are checked, under a lock on the player, so a burst cannot slip past the count: 5 per quest, 20 per player, 30 per install in 10 minutes. `X-Device-Id` is a claim from an honest client (an attacker rotates it); the per-player limits are the real wall | `test/completions/complete.int.test.ts` |
| V3 sessions (players) | bearer tokens of 256 bits stored as SHA-256; a session counts only while the player is active, the session unexpired and not revoked. Issued only by database functions that consume proof in the same transaction (a challenge token and its code, a signup token, a refresh token), never from a bare player id; access 1 hour, refresh 180 days rotated on every use, one family per device (at most 10); a reused refresh token outside the 60-second retry grace ends the family and is audited; sign-out by the refresh token (T-107) | `test/db/player-sign-in.int.test.ts`, `test/players/sign-in.int.test.ts`, `test/db/completion-engine.int.test.ts`, `test/completions/complete.int.test.ts` |
| V15 definer functions (T-107) | every `SECURITY DEFINER` function runs with `search_path = public, pg_temp` (pg_temp last), and no role but the owner may create temporary tables (`TEMPORARY` revoked from `PUBLIC`, migration 0014): a caller cannot shadow a table the function reads with a temporary one of the same name. A new definer function takes the same setting; a test fails the build if one does not | `test/db/player-sign-in.int.test.ts` |

**Residual risk accepted (T-107, plan review minor 1).** Someone who knows a player's phone number can ask for codes
and guess wrong: 30 wrong codes a day lock that number out of SMS sign-in until the window moves on, and 5 codes an
hour (10 a day) stop its codes. Email sign-in still works, and support frees the number (RUNBOOK, "Player sign-in and
SMS"). The windows stay per contact because a per-address limit cannot stop a spread-out attack and would lock out
whole venues.

**Deviation recorded.** The alerts for these signals (email senders down, throttle spikes, one address key
carrying most traffic) are log lines until T-018 wires them; see `TASKS.md`.

### Paired devices and the screen code (T-309, ADR-239, ADR-240)

| ASVS area | Control | Proof |
|---|---|---|
| V3 sessions (devices) | a device's credential is 256 random bits in the `__Host-qs_device` cookie (HttpOnly, Secure, SameSite=Strict, Path=/), stored as its SHA-256, never in a URL, a log line, an audit row or a body; replaced once at activation (the old one lives until the new one is first used or 60 s, CTO 2); a device ends when revoked, its quest or event is deleted, its operator or team member is removed, 24 h after its event ends, or after 30 idle days | `test/db/devices`, `test/devices/routes` (cookie flags, activation, the log and audit scan) |
| V8 authorization | access kind `device` only under `/v1/device`, enforced by its own hook on the route's access kind; device definers read their own row by `app_device_id()` and take no event or quest argument, so a station can never ask for another quest's code; a device cookie opens no player, staff, member, owner or admin route and those credentials open no device route (CTO 11) | `route-access.test.ts`, `test/devices/routes`, `test/security/*` |
| V2 / V11 anti-automation | pairing requests: 60 per 10 minutes per address bucket (a venue's NAT), a reload with a live cookie makes none; claims and previews: 10 a minute per person; unknown codes: 30 an hour per event and per organizer, and above 200 an hour on the platform ops are alerted (`device.claim_misses_high`); codes are 8 of 31 characters (about 40 bits) and live 10 minutes; screen codes: 6 a minute per device and per operator and quest | `test/devices/routes`, `devices.test.ts` |
| V11 business logic (screen code) | the 30-second window is issued and judged on the database clock only; the previous window counts for its first 15 s; the door judges it after the enrollment lock, and pays one player once per 45 s on the quest (CTO 6) | `test/db/devices` (the screen door table, the clock's property test) |

| Threat | Answer |
|---|---|
| A station link shared on WhatsApp (FR-1713) | The address holds nothing: it opens a fresh pairing page that shows no event, no quest and no code |
| A photographed pairing code | Useless without the cookie only the showing browser holds; claiming it pairs that screen, not the photographer's |
| Staff tricked into pairing a stranger's remote browser (social engineering through the type-in) | Its codes still expire within 45 s; its label, client and last seen sit on the Devices page with Revoke |
| A device cookie copied before pairing | Dead after activation (the secret is replaced) |
| Racing the activation with a copied pending secret (CTO plan re-review 3) | The attacker's activation wins the fresh secret and the real screen's old secret dies, so the real screen goes blank (`device_unpaired`) and starts over; the answer is that blank screen plus Revoke on the Devices page, where the device shows as paired and active while the screen in front of staff shows a new code |
| A stolen device cookie | Works until Revoke, the event's end + 24 h, or 30 idle days |
| Guessing a pairing code | Needs a staff account of an event; held at 10 claims a minute per person and 30 unknown codes an hour per event and organizer, with a platform alarm above 200 an hour, against 40 bits that live 10 minutes |
| A screen code photographed and sent on | Refused once more than 15 s past its change (`code_expired`); relayed live within its 45 s it still pays its scanner (ADR-240, risk accepted: bounded by the quest's caps, one pay per window and the burst flags) |
| A flood of pairing requests (CTO 9) | At 5,000 open requests new pairings answer 503 `busy` (logged `device.request_flood`, which the error tracker alerts on) for up to 10 minutes; paired devices are never touched |
| An operator who lost the ability or the quest keeps a station running (CTO 3) | The station shows "Paused by the event team" and no code until the ability or the quest comes back |

### Practice scans (T-311, ADR-249, ADR-250)

A practice scan must never write points. Three walls, each tested alone:

| Wall | Control | Proof |
|---|---|---|
| Database | `operator_practice_scan` runs the real door in a block that always raises (`PX000`), so the subtransaction undoes every row and lock; it is `SECURITY INVOKER` and gains no privilege; a fresh `practice:` key never meets a real one | `test/db/practice-scan` (a whole-database fingerprint before and after, with the transaction around it committing; no advisory or row lock left; keys; crossed scans) |
| API | `withRolledBackContext` always sends `ROLLBACK`, never `COMMIT`; a failed rollback destroys the connection | `src/db/context.test.ts` |
| Route | `POST /v1/operator/scan/practice` is its own route with no ranking and no idempotency store; the real route has no practice flag | `test/operators/practice` (a ranking spy untouched, score unchanged), `practice.test.ts` |

In the app, practice mode lives in memory only; the writing tools (desk, inbox, tickets, manual award, review, NFC
write, rotating QR, pairing) are locked while it is on, and the "Practice · not saved" line comes from the server's
`practice: true`, never from the switch. Outsider: none of the three functions runs for `questify_outsider` or PUBLIC.

### The first-N bonus (T-313, ADR-260 to ADR-263)

No more than N bonuses are ever paid, and nobody outside the event reads or sets one:

| Risk | Control | Proof |
|---|---|---|
| Two players take the Nth bonus | One slot row per place, claimed `FOR UPDATE SKIP LOCKED` as the payer's last write; UNIQUE completion, entry and (quest, enrollment) on the slots, and partial UNIQUE indexes on the ledger | `test/db/first-bonus` (the race at the 50th place, 20 rounds at the last place, 40 claimers on 8 connections, a rolled-back claim) |
| A forged bonus row | `ledger_entry_first_bonus_shape` (a completion and a quest, positive, no boost, actor system), never boosted, no XP | the forged inserts and the never-boosted test |
| A bonus set or read across tenants | `set_quest_first_bonus` through `award_event_of` (AN404); `first_bonus_left` answers no row unless the caller is an active member or the team in scope; `own_first_bonus` the caller's own completion only | `test/db/first-bonus` (another organizer, an editor out of scope, a stranger, a banned member) |
| A client skipping or replaying through the practice path | `practice:` keys are reserved at the API (400 `idempotency_key_invalid`); the practice scan's door claims nothing | `src/conventions.test.ts`, `test/quests/first-bonus` |

Both tables keep row-level security forced with no grant to the API role; `pay_first_bonus` and `first_bonus_place` are
granted to nobody. Outsider suite: every new function refused to `questify_outsider` and PUBLIC.

### Kiosks and the live code (T-309b, ADR-242, ADR-244, ADR-245)

| ASVS area | Control | Proof |
|---|---|---|
| V8 authorization | `kiosk_complete_quest` takes no quest or event: it pays only the device's own quest, only a player enrolled in the device's event, only from an activated, live kiosk (a station's or pending cookie is 401); `kiosk_scan_subject` names only a player of that event; `GET /v1/me/live-code` signs only the bearer's own id | `test/db/kiosks`, `test/devices/kiosk-routes`, `test/security/*` |
| V11 business logic | the live code's window is issued and judged on the database clock; one pay per player per method per 45 s on a quest under the enrollment lock; the `kiosk:` key namespace is the kiosk door's alone (QK422 elsewhere, null-safe); the pairing operator is never paid by their kiosk | `test/db/kiosks` (the kiosk door table, the crossed locks) |
| V2 / V11 anti-automation | 30 scans a minute per kiosk; 10 unreadable or forged codes in a minute pause it until the minute passes; 6 live codes a minute per player | `test/devices/kiosk-routes` |
| V14 configuration | only `/ar/kiosk` and `/en/kiosk` get `camera=(self)` and `'wasm-unsafe-eval'`; every link there is a full page load; the decoder's wasm is self-hosted and hash-checked | `security-headers.test.ts`, `kiosk-decoder.test.ts`, `e2e/kiosks.spec.ts` |

| Threat | Answer |
|---|---|
| A screenshot of a live code | Dead 15 s after its window changed (45 s at most): `expired` |
| The fixed My QR (or a screenshot of it) at a kiosk | `needs_live_code`, nothing paid |
| A live code relayed live by video | Pays its owner once per quest per 45 s, within the caps; burst flags; risk accepted (ADR-242) |
| One code held up twice, or two phones showing one code | One pay (the 45-s rule under the enrollment lock; the page drops a string it just sent for 5 s) |
| The operator who paired the kiosk scanning themselves | `self_scan` |
| Forged or junk codes probing the signature | Not Questify-shaped: dropped in the page; shaped but forged: counted, 10 a minute pause the kiosk |
| A prankster pausing the kiosk with forged codes | At most a minute per 10 codes, from in front of the camera; accepted |
| The tablet taken, or its cookie read through an unlocked browser | Works elsewhere until Revoke, the event's end + 24 h or 30 idle days, and pays only players whose live codes it is shown; the Devices page shows last seen and scans in the last 24 hours; pairing a kiosk shows the lock-the-tablet tip (Guided Access, screen pinning) |
| A device cookie of another kind (a station) | `kiosk-scans` refuses it (401) |
| A kiosk of event A scanning a player of event B | `not_in_event`; the door takes no quest or event argument |
| A removed or de-abilitied operator's kiosk | `paused` at the next scan and poll; a removal revokes it |
| A camera feed | Decoded on the tablet; no frame leaves the page; nothing stored |
| The kiosk's answer kept for retries | The idempotency store keeps each kiosk scan's answer (green or orange, with the @username and avatar; red with the reason only) under the principal `device:{id}` and the scan's key, in the API server's own memory (CranL, `riyadh-1`; never a third party), for 24 hours, then it is gone; no code, player id or score is in it |
| Personal data on a public screen | The @username and the Questify avatar on green and orange only (public on the boards already, FR-120); never a score, balance, rank, status, ban or name; a red card names no one |

## Top abuse cases

| # | Abuse case | Type | Mitigation |
|---|---|---|---|
| 1 | A player on organizer A reads organizer B's data by changing an id | Information disclosure | Authorization check on every object, an `organizer_id` on every tenant row, row-level security in PostgreSQL, and outsider tests using only the public credential (NFR-016, NFR-018) |
| 2 | Scripts spam the completion call, replay requests or forge QR contents | Tampering | Signed QR payloads with a version (regenerate kills old ones); idempotency keys; unique (enrollment, quest); rate limits; flags for bursts and impossible speed (ADR-041) |
| 3 | A fake score from a modified mini-game | Tampering | Built (T-305, ADR-212): the database issues a seeded round with its own clock and frozen level; the API replays the inputs with the round's engine version and never trusts a reported score; impossible inputs, a claimed result the replay does not give, or more play time than the server saw refuse the round (it counts as played, a `minigame` flag is raised, the reason never reaches the player); unlikely play is paid and flagged. Accepted: the seed reaches the phone, so a modified app can see the layout; targets sit below perfect play and the reward is one quest's points once (Q-176) |
| 4 | SMS pumping: someone requests thousands of codes to run up Questify's SMS bill | Denial of service / cost | Saudi mobiles only; every SMS sent (first and resent) counts per number (5 an hour, 10 a day), per install (10 an hour) and per address (200 an hour, a ceiling only: venues and carriers put thousands behind one address); a platform ceiling (5,000 an hour, warning at half, Q-093) refuses with the email offer (T-107). Still to come: the cost alert in the usage view and a challenge after repeated requests (ADR-099 risk) |
| 5 | Phishing or takeover of an admin or owner mailbox | Spoofing / elevation | Password + email code; short sessions; admin session list and forced sign-out; every admin change logged (console reads from T-701, Q-116); alert on new admin sign-in |
| 6 | An operator or kiosk misuses scanning to award points | Elevation of privilege | Per-operator abilities and quest limits (owner only, ADR-139); removal refuses the next scan at once; every station scan needs a signed My QR, pays at most the quest's cap, once per operator, player and quest in 10 seconds, and names the operator in the append-only record (F-110); no station rate limit: T-209 flags bursts |
| 7 | Stolen or shared pass/QR used at the prize desk | Spoofing | My QR is fixed and only identifies the player (ADR-137): a handover needs the player's accept in their own app (T-206); the player can replace a leaked code at once; the desk also checks the reservation and open flags |
| 8 | Uploaded files carry malware or inappropriate content | Tampering | Private storage, type and size checks, images re-encoded, never served from the API origin; report and unpublish (PD-29) |
| 9 | Organizer-written text injects script into the dashboard or app | Tampering | Output encoding everywhere, no raw HTML in texts, content-security policy on web pages |
| 10 | Leaked signing keys (wallet certificate, push keys, `QR_SECRET`, `REWARD_CODE_SECRET`) | Information disclosure | Keys only in the secret store, access limited and logged; expiry alerts; rotation procedure written before launch (`QR_SECRET`, `REWARD_CODE_SECRET`: RUNBOOK). A reward code reaches only the player who redeemed it: never a log, an audit row, an error body or the dashboard; the in-memory idempotency cache holds the reserve answer for its replay, so a shared or persistent cache must exclude it |

## Secrets policy

Secrets live in environment variables injected from the cloud's secret store. Never in code, git,
logs, chat or docs. Separate values per environment. Rotated when a person with access leaves, on
suspicion, and before certificate expiry. A pre-commit and CI secret scan runs on every change.

## Data protection

- In transit: TLS everywhere, HSTS on web pages.
- At rest: encrypted storage by the cloud; extra column encryption for prize codes.
- Residency: all personal data in Saudi Arabia (ADR-070); the exceptions are push tokens/text,
  wallet pass content, device-integrity attestations (Apple App Attest, Google Play Integrity), the Play Install Referrer, any foreign email provider (staff mail, and player sign-in codes by email until Q-034 is
  answered: only the address and the code pass through, ADR-117) and the Pwned Passwords range API (5 hex characters of a password's SHA-1, no personal data), each listed in the data map (NFR-020) and on the
  counsel list.
- Meet codes (T-303c, ADR-209): a 128-bit random token per code, alive one minute, used once; it travels only in a
  request body and in the QR, and only its SHA-256 hash reaches the database (compared by equality on a unique
  index: a guess is a lookup miss). Refusals and logs never echo it. `meet_pass` and `meeting` have no grant and no
  policy; only `issue_meet_pass`, `meet_pass_state` and `meet_player` are executable, by the API role only (outsider
  suite). The scanner learns the other player's username and avatar only; a refusal for the other player's reasons
  is one generic `not_for_them`.
- Location (T-303b, ADR-206): read only while the app is open and only with a request that uses it; it travels in the request body (never a header or query); no coordinate is stored, only rounded distances, accuracy and the mocked mark in `completion_position`, which no API role can read; refusals never echo the numbers; the database must not log bound parameters (a test checks the settings; CranL checked per RUNBOOK before the switch goes on). A check-in proves only what the phone claims.
- Minimisation: no ad networks or tracking SDKs; location only while the app is open; photos only
  through the system picker or camera (NFR-021).
- Deletion (T-217, migration 0038, ADR-175 to ADR-178 Proposed): one transaction (`erase_player`) turns the account into a
  tombstone (id and status only); contacts, sessions, refresh tokens, username history, acceptances, join answers,
  flags, device ids, ledger-note reasons and operator assignments go; the ledger, enrollments, frozen results and
  handed-over prizes stay, naming no one; audit rows hold ids only already. It takes a fresh one-time code (its own
  challenge, which can never sign in; ASVS re-authentication) and a 10-minute single-use deletion token. The public
  code request always writes a challenge and sends after the answer, so a known and an unknown contact look the same.
  The fingerprint is an HMAC under a key derived from `AUTH_SECRET` (`deletionFingerprint`): rotating that secret
  loses the ban and welcome marks (Q-141); a plain hash would not do, every Saudi number can be hashed in minutes.
  The deleted player's remembered idempotency answers are dropped (`forget`), so none of their responses replays. No
  restore after deletion (ADR-094).
- What an organizer reads about a player (closed in T-208, migration 0019): the join card (FR-121, version 0.1)
  discloses the username and avatar, points and quests in the event, and prizes collected (PD-17). Organizers no
  longer read `player` at all; `event_players` returns those columns only (tested: no birth year, no contact, a
  cross-tenant probe). `enrollment_read` still lets the organizer seat read `enrollment.player_id`; the API never
  returns it, and the dashboard reads enrollments through definers as it grows.
- Accepted risk (T-208): the exclusion list can work as a lookup. An owner who adds a phone number and watches the
  board can learn which username has it, though organizers never see contacts. FR-319 needs the behaviour; it is
  kept small: no "excluded" flag in any answer, at most 500 entries an event, every add and remove audited (the kind,
  never the value), phones masked in every answer.
- Changing a phone or email (T-108, ADR-120 Proposed): the code goes to the new contact only; the old one is not
  re-proved (ASVS 5.0 V7.5.1 asks for re-authentication; a player who lost their number cannot give it). Compensating
  controls: a fresh code to the new contact, notices to the old value and the other channel on every change and add,
  the audit entry, sessions kept so the real owner can change it back, support for the rest. No new account-existence
  oracle: whether another account has a contact is said only after its code is entered, so only someone holding it
  learns it; every request counts in the player's window, refused ones too.
- The app's session (MASVS-STORAGE, T-111 app half): the access and refresh tokens are one item in the phone's
  keychain or keystore (`expo-secure-store`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: never in a backup to another device),
  never in AsyncStorage. The first launch of an install clears that item, because the iOS keychain outlives an
  uninstall. A store that cannot be read (a lost Android key) counts as no session. One refresh is in flight at a
  time; only the API's 401 to a refresh ends the session. A release build without its API address, or with plain
  http, stops at start (MASVS-NETWORK).
- Backups (target, NFR-026): point-in-time, copied to a second place in Saudi Arabia that we control, restore rehearsed.
  **Today:** CranL offers neither point-in-time restore nor a second-region copy (ADR-107 addenda); staging holds only
  test data, and the nightly copy with a proven restore is T-019, required before the first real player.

## Tests that prove it

- An **outsider suite** holding only the public credential must be able to do nothing it should not
  (global standard; NFR-017, NFR-018).
- Cross-tenant tests: an editor of organizer A against every route of organizer B returns 403/404.
  Built in T-012 (`apps/api/test/security/`): every table is classified as owned or shared, and for each owned
  table organizer A (or another staff member, or another player) can read none of the other side's rows beyond what
  is public by design (organizer names, public events and their add-ons), change or delete none through any column
  it may update, and forge none. Every route is listed with how it keeps callers apart.
- Load test at 20,000 completions per minute before the first event (NFR-003).
- A restore rehearsal and an SMS-pumping simulation before launch.
