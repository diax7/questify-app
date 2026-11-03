# T-712 - View as organizer (plan, tier A)

Delivers FR-1837 (F-339): a platform admin opens an organizer's event dashboard as the team sees it, read-only by
default, with a banner and a log entry for every view. Depends on T-701 (support grants, done). Migration **0133**.
ADR-520 to ADR-525 Proposed; Q-480 to Q-483 Proposed. Tier A (admin powers): plan review, build, one code review,
mutation on GitHub for the access code only.

## 1. What exists and is reused

- **Support grant (T-701, migration 0114, ADR-407 to ADR-409).** `support_open(event, reason, request)` opens a
  `support_grant` row for exactly 15 minutes on one event, never for a member (SG409), 20 an hour per admin (SG429), one
  live grant per admin and event (opening again closes the old one, which is how it is extended). `app_organizer_id()`
  and `app_event_scope()` have a second branch for a live grant of an active platform admin; `app.is_admin` is never set.
  Silent to the organizer (Q-373, Dhia): no organizer banner, no alert, the record is Questify's audit log.
- **Support seat in the API** (`apps/api/src/organizers/support-seat.ts`): `supportSeatOf` seats the admin as an editor
  of the granted events; `supportMayUse` is deny by default (routes of a granted event except device pairing and
  exports; event-less routes only `GET /events`; everything else 404). The organizer scope's hook
  (`apps/api/src/organizers/routes.ts`, `registerOrganizerRoutes`) re-reads the seat on every request.
- **Admin banner** (`apps/web/src/components/OrganizerShell.tsx`, `OrganizerBanners`, `support.banner`): only the admin
  sees it. **Console opener**: `POST /v1/admin/events/:eventId/support` and `POST /v1/admin/support/:grantId/close`
  (`apps/api/src/console/routes.ts`), UI in `apps/web/src/components/ConsoleOversight.tsx`.
- **Route inventory** (`apps/api/src/route-access.ts`, `registerRouteInventory`): every route with method, URL and
  access kind. The view-mode test is generated from it (section 10).
- **Throttle** (`holdBack`, `apps/api/src/auth/throttle.ts` buckets) and the console's audited reads ("ids only").

## 2. The model: a `view` kind on the same grant (ADR-520)

`support_grant` gains `kind text NOT NULL CHECK (kind IN ('view', 'edit'))`. Existing rows become `edit`; the column has
no default afterwards, so every opener names the kind. Everything else is the support seat as it is: one event, a reason
(10 to 300 characters), exactly 15 minutes, opening again extends, any admin can close, `revoke-admin` closes, never for a
member, and the **20-an-hour limit counts both kinds together**. The unique index stays per admin and event, so an admin
holds at most one grant per event: opening `edit` on an event under `view` replaces it (and the reverse), each step its
own audit entry. **View is the default** in the console (the primary button); the edit grant of T-701 becomes "Open
support access (can change)", a secondary action with its own confirm.

Why not a separate table or an organizer-wide grant: the grant row already carries every rule the view needs (expiry,
reason, limit, close, stamp, revoke-admin), and one event keeps the read surface as small as the edit grant's. An
organizer-wide view is Q-480.

## 3. Read-only, enforced twice (ADR-521)

**Layer 1, the API hook.** In the organizer scope's hook, after `principalOf`:
1. If the request's event (`params.eventId`) is under a `view` grant and the method is not GET or HEAD: **403
   `support_view_only`** before any handler runs. Event-less writes are already 404 for support.
2. `supportMayUse` gains a per-kind refused list. View additionally refuses `GET /events/:eventId/codes` (printed quest
   codes and hidden category codes are secrets that pay points; a viewer has no need for them) and
   `GET /events/:eventId/rehearsal` (review MAJOR 1: before go-live its first read opens the rehearsal and makes a join
   code, a write). The exports and device pairing refusals stay for both kinds. Checked and allowed (review MINOR):
   `GET .../invitation-campaigns` (criteria, states and rounded counts, no link or code) and
   `GET .../quests/:questId/nfc-tags` (label, status, tap counts, no tag secret).
3. The throttle (section 6) and the read log (section 5) run here, in their own transactions.
4. The request is then marked read-only for the rest of its life (below).

**Layer 2, the database, fail closed.** `RequestContext` gains `readOnly?: true` (review MINOR: not a request-wide
`AsyncLocalStorage`, so shared work started by a view request, such as a cache load, `mark_ranking_repair` or the
ranking store's rebuild, which run in their own `{}` context, is never marked read-only). The hook sets it on the
principal when the request's event is under a `view` grant (or, for an event-less read, when any grant is a view), and
`organizerContextOf` carries it; the seat helpers that copy `organizerId` and `staffUserId` copy it too, through one
helper `teamSeat(context)`. `withRequestContext` and `withRolledBackContext` open `BEGIN READ ONLY` when it is set. PostgreSQL then refuses every INSERT, UPDATE, DELETE and `nextval` in that transaction, SECURITY DEFINER
doors included (SQLSTATE 25006).

And the grant itself only works inside such a transaction: migration 0133 changes the support branch of
`app_organizer_id()` and `app_event_scope()` to honour a `view` grant only when
`current_setting('transaction_read_only') = 'on'`. A code path that loses the read-only mark (a store that opens its own
transaction, a pool query outside the request's async chain) therefore runs as nobody: RLS returns no rows and the doors
refuse. It never runs as an editor. `edit` grants are unchanged. A transaction cannot be switched to read-write after its
first statement, so a door cannot lift it.

Mixed kinds in one organizer (view on event A, edit on event B): in a read-write transaction the scope is `{B}`; in a
read-only one `{A, B}`. Writes on A are refused by layer 1 and could not see A in layer 2.

## 4. Session scoping and expiry (ADR-522)

No new token or cookie: the admin's own staff session on the dashboard origin, as for the edit grant (Origin check,
no-store). The seat is re-read on every request and the grant re-checked on every statement, so the view ends at the
15-minute mark, on close, on `revoke-admin` or when the admin's account is disabled, at the next request. An expired view
answers 404 like any organizer the admin cannot see; the web shows "This support view has ended" and a link back to the
console. Extending is opening again (same reason field). The admin's account must be an active platform admin at both
open and use; a member of the organizer uses the membership (SG409).

## 5. Every view logged, without personal data (ADR-523)

New definer door `support_view_log(grant uuid, route text, ids jsonb, request uuid)`, called by the hook for every
allowed read, in its own short read-write transaction before the request turns read-only:
- checks the caller is the grant's admin, an active platform admin, and the grant is live and of kind `view`;
- `route` must match `^(GET|HEAD) /[a-zA-Z0-9/:_-]{1,200}$` (the route **pattern** below the organizer prefix, never the
  concrete URL and never the query string, which can carry a search for a name or a phone number);
- `ids` is an object of at most 4 keys whose values are UUIDs (the path parameters, e.g. `enrollmentId`); anything else
  is refused (QA422);
- coalesces: under `pg_advisory_xact_lock(hashtextextended(grant || route || ids, 0))` (one bigint), it writes one `audit_log` row
  (`actor_type 'admin'`, `action 'support.viewed'`, organizer and event columns, `target_type 'support_grant'`,
  `target_id` the grant, `after {route, ids}`) unless the same grant, route and ids were logged in the last 60 seconds
  (a live page polls; Q-481). A partial index `audit_log (target_id, at) WHERE action = 'support.viewed'` keeps the check
  a seek.
- `support.opened` entries carry `kind` in `after`; `support.closed` is unchanged.

The audit text carries ids, the route pattern, the reason the admin typed (already the case) and times: no email, name,
phone or free text from the page. The entries appear on the console's event and organizer pages, where audit rows are
already listed. The organizer does not see them (ADR-409 kept; Q-482). FR-1837's "the access is in the event's log" is
read as Questify's audit log of that event (SRS trace note at build).

## 6. Rate limits

- Opening: the existing 20 grants an hour per admin, both kinds together (SG429).
- Reading: a new bucket `support_view` of 240 requests a minute per admin through `holdBack` with `queue = true` (review
  MAJOR 2: a dashboard page fires several GETs at once; the console helpers queue the same way, so none loses a lock
  race), before the read log, so a runaway page cannot flood the audit log (at most 240 rows a minute before
  coalescing). Past it, 429 with `Retry-After`.
- Cost: each view GET runs about four transactions before its handler's own (membership, support seat, throttle, read
  log); acceptable for one support admin's pages, recorded in ADR-523.
- The console route's own `adminIdempotent` limits stay.

## 7. Personal data in the view (ADR-524)

The view shows what an editor of that event sees, unmasked, as the edit grant already does: the purpose is to see the
organizer's problem as they see it, and the edit grant (stronger) has shown the same data since T-701. The data stays
behind the same limits: no exports, no quest codes, no device pairing, one event, 15 minutes, every page logged with
ids. Masking every player field only in view mode would touch most read stores for little gain (Q-483).

## 8. API and web

- `POST /v1/admin/events/:eventId/support` body: `{ kind: "view" | "edit", reason }`, `kind` required (strict schema;
  the console sends it). Answer adds `kind`. `GET /v1/staff/me` memberships: each support grant carries `kind`;
  `own_support_grants()` and `event_support_grants()` return it.
- New error `support_view_only` (403) in `apps/api/src/auth/http-errors.ts`, with Arabic and English text.
- Web: `OrganizerBanners` shows `support.viewBanner` for a view grant: "You are viewing this event as Questify support,
  read-only, until {time}. Every page you open is recorded in Questify's log." (Arabic through `ux-araby`); the dashboard
  maps `support_view_only` to "This is a read-only support view. Nothing was changed." Controls are not hidden page by
  page (the suspension banner set this precedent, ADR-406); the server refuses. The console's event page gets "View as
  organizer" (primary) beside the existing support button, the reason field shared, and lists each live grant's kind.
- `SupportGrant` (`apps/api/src/auth/staff-store.ts`) and the shared type gain `kind`.

## 9. Migration 0133 (deny by default)

1. `ALTER TABLE support_grant ADD COLUMN kind text NOT NULL DEFAULT 'edit' CHECK (kind IN ('view','edit'))`, then
   `ALTER COLUMN kind DROP DEFAULT`.
2. `DROP FUNCTION support_open(uuid, text, uuid)`; `CREATE FUNCTION support_open(target uuid, kind text, reason text,
   request uuid)` (same body plus the kind, `kind` in the audit `after`). `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ...
   TO questify_app` beside it.
3. `own_support_grants()` and `event_support_grants(uuid)`: DROP and CREATE with `kind`; revoke from PUBLIC, grant to
   `questify_app`.
4. `CREATE OR REPLACE` `app_organizer_id()` and `app_event_scope()`: the support branch adds
   `AND (g.kind = 'edit' OR current_setting('transaction_read_only') = 'on')`. Membership branch untouched.
5. `support_view_log(...)` SECURITY DEFINER, `search_path = public, pg_temp`; revoke from PUBLIC, grant to
   `questify_app`.
6. `CREATE INDEX audit_log_support_view_idx ON audit_log (target_id, at) WHERE action = 'support.viewed'`.
7. `SET LOCAL lock_timeout = '10s'`. No new table. Not deployed anywhere yet; frozen once CranL runs it.

Deploy note: the API and migration ship together; during the window between them the old API's `support_open` call
fails (support opening only, admin-facing).

## 10. Tests (test first)

**DB** (`apps/api/test/db/support-view.int.test.ts`, and `support-grant.int.test.ts` updated for the new signature):
the kind check and no default; a view grant in a read-write transaction gives `app_organizer_id()` NULL and an empty
scope, and in a read-only one the organizer and the event; a write door in a read-only transaction fails with 25006; an
edit grant behaves as before in both; mixed kinds give `{B}` and `{A,B}`; expiry, close, a disabled admin, a demoted
admin, a member (SG409); 20 an hour across kinds; `support_view_log` refuses another admin's grant, an edit grant, an
expired grant, a bad route, a query string, non-UUID ids, five keys; it coalesces within 60 seconds and logs again after
(time moved by the test's clock helper or a back-dated row); two concurrent calls with the same key write one row; the
audit `after` holds only `route` and `ids` (no email, no name).

**Generated route test** (`apps/api/test/organizers/view-mode.int.test.ts`): built from the app's route inventory, so a
new organizer route is covered without editing the test.
- For every route under `ORGANIZER_PREFIX` whose method is not GET or HEAD: inject it with the view session, params
  filled from the seed (`organizerId`, the granted `eventId`, any other `:param` a random UUID), body `{}`, an
  Idempotency-Key: expect 403 `support_view_only`. Afterwards no audit row other than `support.viewed`, and no change
  in any table's contents: an md5 of every public table's rows (the throttle and audit tables compared without the
  sweep's own `support_view` and `support.viewed` rows), taken directly before and after on the test's own database
  (review MINOR: not `pg_stat_user_tables`).
- The same routes on the granted event under an **edit** grant do not answer `support_view_only` (the refusal is the
  kind's, not the method's).
- For every GET under the prefix: under the view grant it answers 2xx, 404 (missing child row) or the refused list's
  404, never 5xx, and the same table md5 holds before and after. The seed's granted event is before go-live with no
  rehearsal opened (review MAJOR 1), so a first-read write is reached. This catches a GET that writes (it fails in the
  read-only transaction, or changes the md5 when it writes as the system).
- Each allowed GET answers the same status under the view grant as under an edit grant on the same event (the edit
  sweep runs after the view sweep): a seat helper that drops `readOnly` runs read-write, where the view grant opens
  nothing, and shows up here.
- Parallel GETs of one page (six at once) under the view grant all answer 200 (review MAJOR 2).
- A guard: the inventory has more than 100 organizer writes, so an empty sweep fails.

**Security suites:** `outsider.int.test.ts` (the new and replaced functions refuse anonymous callers and hold no PUBLIC
grant); `cross-tenant.int.test.ts` (a view grant on organizer A's event reads nothing of organizer B and nothing of A's
other events, by API and by direct statement); `routes.int.test.ts` entries updated for the console route.

**Unit:** `withRequestContext` and `withRolledBackContext` open `BEGIN READ ONLY` only for a `readOnly` context;
`supportMayUse` for the view refused list; the hook's order (403 before the handler, the log before the read).

**Web:** `e2e/console-support.spec.ts` (or the T-701 spec): open the view, the banner shows, a save shows the read-only
message; `layout.spec.ts` covers the banner in both languages.

## 11. Docs touched at build

SECURITY.md (support grants paragraph: kinds, the read-only transaction, the read log), API.md (console route body, the
error), DATA_MODEL.md (`support_grant.kind`), SRS trace for FR-1837, TASKS.md tick, STATE.md bullet, messages.ts.

## 12. Risks

- **A GET that writes** (marks something seen, audits a read, refreshes a cache row) fails in view mode. The generated
  GET sweep finds each one; the fix is per route (refuse it in view, or move its write out of the read).
- **`readOnly` propagation.** A seat built without it runs read-write, where the view grant opens nothing: the database
  fails closed (no rows, refused doors), never open; the view-versus-edit comparison in the GET sweep finds it.
- **Read-only in a definer door.** `transaction_read_only` is per transaction and cannot be lifted after the first
  statement; a door that uses `dblink` or a background worker would escape it. None exist; the migration rehearsal list
  test flags new extensions.
- **Audit volume.** Coalescing and the 240-a-minute limit bound it.
- **Function signature change** breaks `support_open` for the old API during deploy (admin-only, minutes).

## 13. Decisions and questions (recorded with this plan)

- ADR-520 view is a kind of the support grant; ADR-521 read-only enforced in the API and by read-only transactions the
  grant requires; ADR-522 session and expiry as the edit grant; ADR-523 every allowed read logged with the route pattern
  and ids, coalesced per minute; ADR-524 the view shows what an editor sees, codes refused; ADR-525 the view stays
  silent to the organizer.
- Q-480 organizer-wide view; Q-481 is coalescing within 60 seconds "every view"; Q-482 should the organizer see
  views; Q-483 mask player contact fields in the view.

## 14. Mutation targets (GitHub only)

`apps/api/src/organizers/support-seat.ts`, `apps/api/src/organizers/routes.ts` (the hook only),
`apps/api/src/db/context.ts`, `apps/api/src/organizers/context.ts`, `apps/api/src/console/organizers.ts` (the support
opener).
