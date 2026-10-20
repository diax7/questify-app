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
| V11 cryptography | `crypto.randomInt` for codes, `randomBytes` for tokens, HMAC with per-purpose keys derived from `AUTH_SECRET`, constant-time comparison; quest QR codes signed with HMAC-SHA256 (128-bit tag) under a key derived from its own `QR_SECRET`, decoded strictly (one canonical spelling), bound to their quest and version (ADR-116) | `src/auth/keys.test.ts`, `src/quests/qr.test.ts` |
| V16 logging | events carry the request id, the event name, the user id (when known) and a 12-character keyed tag of the client address; never the email, the address itself, the password, the code or a token; the request serializer writes method and path only; `Set-Cookie` and `Cookie` are redacted | "what the logs hold" test |
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

**Deviation recorded.** The alerts for these signals (email senders down, throttle spikes, one address key
carrying most traffic) are log lines until T-018 wires them; see `TASKS.md`.

## Top abuse cases

| # | Abuse case | Type | Mitigation |
|---|---|---|---|
| 1 | A player on organizer A reads organizer B's data by changing an id | Information disclosure | Authorization check on every object, an `organizer_id` on every tenant row, row-level security in PostgreSQL, and outsider tests using only the public credential (NFR-016, NFR-018) |
| 2 | Scripts spam the completion call, replay requests or forge QR contents | Tampering | Signed QR payloads with a version (regenerate kills old ones); idempotency keys; unique (enrollment, quest); rate limits; flags for bursts and impossible speed (ADR-041) |
| 3 | A fake score from a modified mini-game | Tampering | The server issues a seeded round and replays the inputs; a reported score is never trusted (FR-1805) |
| 4 | SMS pumping: someone requests thousands of codes to run up Questify's SMS bill | Denial of service / cost | Per-number, per-IP and global limits and cost alert in the usage view; email fallback; Saudi numbers only; challenge after repeated requests (ADR-099 risk) |
| 5 | Phishing or takeover of an admin or owner mailbox | Spoofing / elevation | Password + email code; short sessions; admin session list and forced sign-out; every admin read and change logged; alert on new admin sign-in |
| 6 | An operator or kiosk misuses scanning to award points | Elevation of privilege | Per-operator abilities and booth limits; owner caps; every award in the append-only record with the operator id (F-110) |
| 7 | Stolen or shared pass/QR used at the prize desk | Spoofing | The desk checks the reservation, the player's profile and open flags; a held item needs a person to clear the flag (ADR-100) |
| 8 | Uploaded files carry malware or inappropriate content | Tampering | Private storage, type and size checks, images re-encoded, never served from the API origin; report and unpublish (PD-29) |
| 9 | Organizer-written text injects script into the dashboard or app | Tampering | Output encoding everywhere, no raw HTML in texts, content-security policy on web pages |
| 10 | Leaked signing keys (wallet certificate, push keys, `QR_SECRET`) | Information disclosure | Keys only in the secret store, access limited and logged; expiry alerts; rotation procedure written before launch (`QR_SECRET`: RUNBOOK) |

## Secrets policy

Secrets live in environment variables injected from the cloud's secret store. Never in code, git,
logs, chat or docs. Separate values per environment. Rotated when a person with access leaves, on
suspicion, and before certificate expiry. A pre-commit and CI secret scan runs on every change.

## Data protection

- In transit: TLS everywhere, HSTS on web pages.
- At rest: encrypted storage by the cloud; extra column encryption for prize codes.
- Residency: all personal data in Saudi Arabia (ADR-070); the exceptions are push tokens/text,
  wallet pass content, device-integrity attestations (Apple App Attest, Google Play Integrity), the Play Install Referrer, any foreign email provider and the Pwned Passwords range API (5 hex characters of a password's SHA-1, no personal data), each listed in the data map (NFR-020) and on the
  counsel list.
- Minimisation: no ad networks or tracking SDKs; location only while the app is open; photos only
  through the system picker or camera (NFR-021).
- Deletion: real deletion on request, anonymising audit rows; the one-way fingerprint keeps bans
  (ADR-084). No restore after deletion (ADR-094).
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
