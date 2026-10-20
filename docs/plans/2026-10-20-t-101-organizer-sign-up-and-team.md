# T-101 — Organizer sign-up, acceptances, the team, editor limits, owner transfer

**Task (TASKS.md):** organizer sign-up, accepting organizer terms and the data processing agreement, one owner,
invite editors by email, owner transfer, editor event limits. Delivers FR-1401, 1011, 1012, 1013, 1724; FR-1726
**partly** (acceptance at sign-up; re-acceptance after a change is T-707); FR-1723 **partly** (owner invite by the
owner; the admin path for managed events is T-701); FR-1014 is enforced where boards are built (T-106).
Quality bar: **Max** (tenant isolation and admin powers are core).

Revision 2 (after CTO review 1, 82/100; review 2: GO 93/100, its three build notes folded in): M1 route-access kinds, M2 definer functions for acceptance, M3 scope on
enrollments and audit, M4 test migration and the "no staff, no tenant" rule, M5 email abuse budget; m6 re-acceptance
cut to T-707; m7 signed-in create-organizer; m8 editors can leave; m9 scope semantics; m10–m15; NITs.

## Scope note

- **Exists:** `organizer`, `organizer_member` (one owner, `event_scope uuid[]`), `app_is_owner`,
  `create_organizer(name, slug)`, `transfer_ownership(org, new_owner)`, member policies (0005), staff sign-in (T-006),
  reset (T-020), audit (T-004), `GET /v1/staff/me` with memberships, `route-access.ts` (kinds `public`, `staff`;
  staff routes must live under `/v1/staff/`).
- **Missing:** public account creation; acceptances; invites; `/v1/organizers/...` routes and their access kinds;
  the organizer context on requests; scope enforcement in the database; audit in the two functions; dashboard
  screens.
- **Out of scope:** events (T-102: the first draft event route completes FR-1401's "draft events"); activation
  (T-210); billing (Q-089); re-acceptance (T-707); admin-initiated owner invites (T-701); board exclusion (T-106).
- Organizer documents v0.1 exist in `docs/legal/` (organizer-terms, organizer-dpa, organizer-content-rules).

## Rules written down (DATA_MODEL)

1. **No staff member, no tenant.** `app_organizer_id()` returns the organizer setting only when the context's staff
   user is a member of it (or the context is a platform admin). An organizer context without a member staff user
   opens nothing. Future non-staff tenant contexts (jobs, operators, screens) get their own explicit branch when
   built.
2. **Event scope comes from the membership row.** `app_event_scope()` reads the caller's `event_scope` for the
   organizer in context; NULL means every event; an empty array is refused by a CHECK (no "none"). There is no
   scope setting.
3. **A scoped editor cannot create events** (they would land outside their own scope) — enforced in `event_write`
   (`app_event_scope() IS NULL`), not only in the API.
4. Non-member → 404 (indistinguishable from an unknown organizer); member without the right → 403.

## Behaviour

### 1. Route access (M1)

`route-access.ts` gains two kinds bound to the `/v1/organizers/` prefix: `member` and `owner`. One scope hook for
that prefix: `no-store`, the Origin check, the staff session check (shared with `/v1/staff`), then the membership
lookup for `:organizerId` from the database → `request.organizer = { id, role, eventScope }`; non-member → 404; an
`owner` route and an editor caller → `403 owner_only`. The route walk asserts: every `/v1/organizers` route declares
`member` or `owner`; an editor gets 403 on every `owner` route; a non-member gets 404 on every route.
Creating an organizer has no organizer id yet, so it lives under `/v1/staff/organizers` (kind `staff`).

### 2. Sign-up (public): email + password, then the emailed code, then the account exists

1. `POST /v1/staff/auth/sign-up` `{ email, password, organizerName, accept: { terms, dpa, contentRules }, lang }`.
   - `accept.*` must equal the current versions (`organizerDocuments()` accessor over `ORGANIZER_DOCUMENTS` in
     `packages/shared`, so T-707 can swap the source) → else `422 acceptance_required`.
   - `organizerName`: 2–80 characters after trimming, no control characters, and **refused when it looks like a URL
     or domain** (`://`, `www.`, `@`, or a dotted top-level-domain pattern) → `422 invalid_organizer_name` (M5).
   - Password: T-020 policy, breach check (fail closed), argon2id through the verify gate — **on both branches**
     (m10): for an existing email the hash is computed and discarded, so timing is the same.
   - Throttles, checked and recorded before anything else for every email: per address 10 an hour
     (`signup_address`), per email 3 an hour (`signup_email`), and the **global outbound budget** (below).
   - A `staff_signup` row is stored on both branches; `password_hash` is NULL for an existing (or disabled) email,
     whose mailbox gets "you already have an account: sign in and create a new organizer from your account, or reset
     your password" with **no code**. New emails get a six-digit code (10 minutes). Neither email carries text the
     user typed (no organizer name).
   - The answer is `{ challengeToken, expiresInSeconds }` on both branches (byte-identical shape and status; test).
2. `POST /v1/staff/auth/sign-up/code` `{ challengeToken, code }`: the sign-in code step's rules (5 attempts kept
   across resends, failures in `fail_email`/`fail_address`). Correct code → `complete_signup(request_id)` (definer,
   below) creates everything; then a session opens exactly as at sign-in. Answers `{ account, organizerId }`.
   A row with NULL `password_hash` can never complete (refused in the function too). A unique violation on the
   email (account created meanwhile) → `410 challenge_expired`.
3. `POST /v1/staff/auth/sign-up/resend`: sign-in resend rules; an existing-email row gets the "already" email again
   with the same spacing.
4. Slug: lower-case ASCII from the name plus 6 random characters; a name with no ASCII letters (Arabic) gets a
   random-only slug; one retry on a unique collision (m11).

### 3. Create another organizer while signed in (m7)

`POST /v1/staff/organizers` `{ name, accept }` (kind `staff`) → `create_organizer` plus the three acceptances in one
transaction (shared SQL with `complete_signup`), `201 { organizerId }`. Same name rules. 5 a day per staff user.

### 4. The team (owner only, FR-1011–1013, FR-1724)

- `GET /v1/organizers/:id/members` (`member`): members (email, role, event scope, joined) and pending invites.
  Emails, not names (no name exists; NIT recorded in OPEN_QUESTIONS against UX §3.12).
- `POST /v1/organizers/:id/invites` (`owner`) `{ email, eventScope?: uuid[] }` → `201 { id }`; role is always editor
  (FR-1013; a request naming another role → 422). Scope ids must belong to this organizer, non-empty when given
  (422). Inviting a current member → 409 `already_member`; inviting yourself → 422. Re-inviting an email replaces its
  pending editor invite (no Idempotency-Key needed: replace semantics; noted in API.md). Caps: 20 pending per
  organizer; 30 invites a day per activated organizer, **10 a day before activation** (M5).
- Invite email: bilingual, the organizer name rendered as plain text, the link
  `DASHBOARD_ORIGIN/{lang}/invite#token=<token>`, valid 7 days.
- `DELETE /v1/organizers/:id/invites/:inviteId` (`owner`) → 204.
- `PATCH /v1/organizers/:id/members/:staffUserId` (`owner`) `{ eventScope: uuid[] | null }` → 204; `[]` → 422.
- `DELETE /v1/organizers/:id/members/:staffUserId` (`owner`) → 204; the owner themselves → `409 owner_required`.
- `DELETE /v1/organizers/:id/members/me` (`member`, editors) → leave (m8); the owner → 409 `owner_required`.
  Policy branch: `staff_user_id = app_staff_user_id() AND role = 'editor'`.
- Audit for each change in the same transaction (`organizer.member.invite`, `.invite_cancel`, `.scope`, `.remove`,
  `.leave`), ids only.
- Expired invites are swept after 30 days.

### 5. Accepting an invite (FR-1012, M2, m12)

- `POST /v1/staff/invites/inspect` `{ token }` (public, throttled per address) → `{ organizerName, role, email,
  accountExists }` or 410.
- `POST /v1/staff/invites/accept` `{ token }` (kind `staff`) → `accept_invite(token_hash, request_id)` (definer).
- `POST /v1/staff/invites/accept-new` `{ token, password }` (public, throttled per address: it costs a hash and a
  breach call) → T-020 policy and breach check, then `accept_invite_new(token_hash, password_hash, request_id)`
  (definer) creates the account and the membership; then a **sign-in challenge** opens (code emailed) and the answer
  is `{ challengeToken, expiresInSeconds }`, so the web reuses `CodeStep`. No session from the link alone (ADR-078).
  An account created between inspect and accept → 409 "sign in to accept".
- Invitees accept no organizer documents (the DPA binds the organizer); recorded in OPEN_QUESTIONS.

`accept_invite` (definer, `search_path` pinned) in the database: lock the invite `FOR UPDATE`; refuse expired; the
email of `app_staff_user_id()`'s account must equal the invite's (else `invite_other_account`) and be active; for an
owner invite, `invited_by` must still be the owner (else 410); insert the member (editor, with the invite's scope)
unless already one; for an owner invite run the role swap through an internal helper `swap_owner(org, new_owner)`
whose EXECUTE is revoked from `questify_app` (shared with `transfer_ownership`); write the audit entries; delete
the invite.

### 6. Owner transfer (FR-1723, owner path)

`POST /v1/organizers/:id/ownership` (`owner`) `{ email }` → an `owner` invite (7 days, one pending per organizer:
partial unique index). Accepting it (same accept routes) makes the invitee a member if needed and swaps the roles;
the old owner becomes an editor and may leave (§4). An expired transfer invite answers 410 "ask for a new one". A
completed transfer leaves the new owner's other pending invites valid (stated). `transfer_ownership` and
`create_organizer` gain their audit entries.

### 7. Email abuse budget (M5)

A global daily cap on sign-up and invite email (throttle bucket `outbound_mail`, one global key): 400 a day, well
under Gmail's quota, so sign-in and reset codes always have room. Over the cap: sign-up answers `503
email_unavailable` (the cap is global, so the answer reveals nothing about an account; never a silent "code sent"),
invites answer `429 mail_cap`; both log `staff.outbound_cap` (an alert line in RUNBOOK).

## Data (migration `0008_organizer_team.sql`)

```sql
-- staff_signup: token-found pending sign-ups (pre-identity kind 'signup', app.signup_token_hash)
--   id, token_hash bytea UNIQUE(32), code_hash bytea(32), email text, password_hash text NULL,
--   organizer_name text, accepted_terms text, accepted_dpa text, accepted_content text,
--   attempts 0..5, resends 0..3, last_sent_at, expires_at, created_at
--   forced RLS: SELECT/DELETE by token; INSERT by token; UPDATE (attempts, resends, code_hash, last_sent_at) by token;
--   DELETE older than a day (sweep); nothing for PUBLIC
-- organizer_acceptance (organizer_id, document, version, accepted_by, accepted_at; PK org+document+version)
--   append-only: SELECT for members, INSERT only through the definer functions; no UPDATE/DELETE grants
-- organizer_invite (id, organizer_id, email, role editor|owner, event_scope uuid[] CHECK non-empty,
--   token_hash UNIQUE, invited_by, expires_at, created_at; UNIQUE(organizer_id, email);
--   one owner invite per organizer: partial unique index)
--   owner reads/creates/deletes their organizer's invites; the token context (kind 'invite') reads one row
-- organizer_member: CHECK (event_scope IS NULL OR cardinality(event_scope) > 0); member_delete gains the
--   self-leave branch for editors
-- app_organizer_id(): definer; the setting only for a member staff user or an admin
-- app_event_scope(), app_event_in_scope(event): definer, read the caller's membership row
-- policies (InitPlan form where touched): event (read/update/delete add scope; write requires scope IS NULL),
--   enrollment (scope on the organizer branch), audit_read (scope on the event-row branch)
-- functions (definer, search_path pinned, EXECUTE to questify_app only, PUBLIC revoked, outsider tests):
--   complete_signup(request_id), create_organizer(name, terms, dpa, content, request_id) REPLACES the old
--   create_organizer(name, slug) (dropped; one door, always with acceptances and audit; complete_signup shares its SQL),
--   accept_invite(token_hash, request_id), accept_invite_new(token_hash, password_hash, request_id),
--   swap_owner(org, new_owner) (internal; no EXECUTE for questify_app);
--   transfer_ownership: audit entries; uses swap_owner
```

Each definer function validates everything itself (row lock, expiry, attempts, status) and takes `request_id` for
its audit entries (m13).

## Tests

- **Migration of existing tests (M4):** `test/db/isolation.int.test.ts`, `test/db/core-columns.int.test.ts`,
  `test/settings/config.int.test.ts`, `test/audit/audit.int.test.ts` and the security suites move their
  `{ organizerId }` contexts to member contexts (`{ organizerId, staffUserId }` of a seeded member); a kept test
  asserts that `organizerId` without a membership opens nothing.
- Database: scope on event, enrollment and audit (an editor limited to A, bare `SELECT` on B → 0 rows; update and
  delete of B → 0 rows); a scoped editor cannot insert an event; forged `app.organizer_id` opens nothing; editor
  self-leave works, owner self-leave refused; each definer function from the outsider seat refused.
- Sign-up: identical answers for new, existing and disabled emails; existing gets no code and can never complete;
  throttles; outbound cap; acceptance versions; name rules (URL-like refused, Arabic name → random slug); breach;
  code step; resend; race on the email.
- `/members/me` beside `/members/:staffUserId`: an owner deleting their own id → 409; an editor deleting another
  id → 403 `owner_only`. Organizer-level audit rows (no event) stay visible to scoped editors (recorded in DATA_MODEL).
- Team, invites, transfer: owner only (route walk), FR-1013 role refusal, foreign scope ids refused, self-invite,
  re-invite replaces, caps before and after activation, accept existing (right and wrong account), accept-new with
  the chained code, expired, cancelled, transfer (old owner editor, audit), stale owner invite after the inviter lost
  ownership (410).
- Security suites: classify the three new tables; outsider on every new function; route walk for the new kinds.
- Mutation scope: `src/organizers/**`, `src/auth/sign-up.ts` (also listed in `QUALITY_BASELINE.md`).

## Web

`/[lang]/sign-up` (email, password ×2, organizer name, three checkboxes linking the documents) then `CodeStep`;
`/[lang]/invite` (reads `#token`; accept while signed in, or set a password then `CodeStep`); `/[lang]/team`
(members, invites, scope picker — "no events yet" until T-102 —, remove, leave, transfer); "New organizer" on home
for signed-in staff; "New organizer? Sign up" on the sign-in page. Messages AR/EN. E2E: sign up → code → home shows
the new organizer as owner; owner invites an editor → link → password → code → editor sees the organizer as editor
with no team actions; an existing staff user creates a second organizer.

## Docs

API.md (routes; non-member 404 vs scoped editor 403), DATA_MODEL.md (the rules above, the tables), SECURITY.md (roles
table proofs; outbound mail budget), RUNBOOK (`staff.outbound_cap`), TASKS (FR-1726 and FR-1723 partial with homes),
OPEN_QUESTIONS (invitees accept no documents; team list shows emails, not names), STATE.

## Phases

1. **Database and access** — migration 0008, pre-identity kinds, route-access kinds and the organizer hook, the test
   migration (M4), database tests and security suites.
2. **Sign-up and create-organizer API** — routes, flows, emails, outbound budget, tests.
3. **Team, invites, transfer, leave API** — routes, definer functions' use, tests, mutation.
4. **Web and docs** — pages, e2e, docs.
