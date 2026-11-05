# T-810d - The console on its own hostname (plan, tier A: admin powers, sign-in)

Source: TASKS.md T-810d, Q-663 (Dhia, 2026-11-05: "Yes, console subdomain"), `docs/security/ASVS_L2.md` gap 12 and
row V3.5.4. Decisions: ADR-720 to ADR-724 (Proposed); questions Q-690 to Q-693. Migration 0156 (new; 0155 is
T-810c's, both undeployed).

**Builds on T-810c** (branch `worktree-agent-af620ccd329eacd22`, merged before this build). T-810c moves every
staff session write into definers (`open_staff_session(bytea, text, text)` in 0155, ADR-718) and adds the staff
sessions list and the console end-all. This plan replaces `open_staff_session` in 0156 and reads the session row
that T-810c's `findSession` already returns. If T-810c's merged shape differs, the builder follows the merged code,
not this text, and notes it in the reply.

**Done when** (TASKS.md): the console and the public pages are on different origins on staging, and the sheet's
row moves to Met. In code terms:
1. The console pages answer only on the console host; the public host sends console paths there.
2. The console host serves only the console, sign-in and the staff account page; every other page goes to the
   public host.
3. A console session (the `__Host-qs_session` cookie that may call `/v1/admin/*`) is opened only by a sign-in from
   the console origin, so it is only ever set on the console host. A session opened on the public host is refused
   by every `/v1/admin/*` route, whatever its account.
4. Every cookie request is checked against its own session's origin.

---

## Threat and what each layer does

The threat (Q-663): a script that gets into any public page (event page, station, big screen, organizer content)
runs on the same origin as the console and can call `/v1/admin/*` with a platform admin's cookie. Three layers, each
enough on its own for that threat:

| Layer | Where | What it stops |
|---|---|---|
| Session surface (ADR-720) | API, `staff_session.surface` | A public-host session, even an admin's, never passes the console hook |
| Origin per session (ADR-721) | API, `checkOrigin` | A page on one host driving the other host's session (the two hosts are same-site, so `SameSite=Strict` does not separate them) |
| Host routing (ADR-722) | Web, `proxy.ts` and the forwarder | No public page is ever served on the console origin; the public host never forwards `/v1/admin/*` |

The session surface is the wall; the host routing is what makes the browser keep the two cookies apart and keeps
public content off the console origin. Host routing reads only the `Host` header (step 0 checks CranL keeps it).

---

## 0. Before building: check the Host header on CranL (5 minutes)

The proxy decides the host from `Host`. A redirect probe cannot show what CranL's edge passes (Next makes
same-origin redirects relative: `curl -sI https://questify.nafes.com/` answers `location: /en`). So the unit tests
use `Host` fixtures, and the step 7 probes prove it on staging after the first deploy. If CranL turns out to rewrite
`Host` to the internal name, both hosts read as public and the console path redirects to itself (a loop: it fails
closed, the console is unreachable, never exposed); the fix is Q-691 (read `x-forwarded-host` only from the edge).

## 1. Settings: `CONSOLE_ORIGIN` on both apps (ADR-723)

- `apps/api/src/config.ts`: `auth.consoleOrigin` from a required `CONSOLE_ORIGIN`, read by the existing `origin()`
  helper. Startup fails when it is missing, not an origin, or equal to `DASHBOARD_ORIGIN` (one message per case,
  naming both settings).
- `apps/web/src/lib/config.ts`: `readWebConfig` reads two required origins, `DASHBOARD_ORIGIN` and
  `CONSOLE_ORIGIN`, with the same three refusals and an https rule (http only for `localhost`, `*.localhost` and
  `127.0.0.1`, for local runs and the browser tests). The web app has no public origin setting today; it needs both
  to send each path to the right host.
- Tests: `config.test.ts` in both apps, one per refusal and one accepted pair.
- `apps/api/test/support/auth-app.ts`: `CONSOLE_ORIGIN = "https://console.questify.test"` beside
  `DASHBOARD_ORIGIN`, and a `consoleHeaders()` helper beside the existing one.

## 2. Migration 0156: the session's surface (ADR-720)

`apps/api/migrations/0156_staff_session_surface.sql`, starting with `SET LOCAL lock_timeout = '10s'`:
- `ALTER TABLE staff_session ADD COLUMN surface text NOT NULL DEFAULT 'dashboard' CHECK (surface IN ('dashboard',
  'console'))`. Existing rows become `dashboard`: after the deploy every admin signs in once more on the console
  host (RUNBOOK note). No grant changes: the API role has no INSERT (revoked in 0155) and cannot UPDATE this column,
  because its UPDATE is the column grant of 0002 (`GRANT UPDATE (last_seen_at, revoked_at)`, 0002:89), not a policy.
- `DROP FUNCTION open_staff_session(bytea, text, text)`; `CREATE FUNCTION open_staff_session(token bytea, agent
  text, address text, surface text)` with T-810c's body plus the surface in the INSERT; `REVOKE ALL ... FROM PUBLIC`
  and `GRANT EXECUTE ... TO questify_app` beside it. A value outside the CHECK raises `22023` from the definer before
  the insert, so the API sees one clear error.
- Replace, not overload (rules: replace, don't deprecate): an API of the old release cannot open a staff session once
  0156 runs, the same minute T-810c already accepts (ADR-718).
- `findSession` (staff-store) returns `surface`; `Authenticated` gains `surface: "dashboard" | "console"`;
  `request.staff` carries it.

DB tests (`apps/api/test/db/staff-session-surface.int.test.ts`): the default is `dashboard`; the CHECK refuses
`admin`; the definer stores each value and refuses a third; the 10-session cap counts both surfaces together (one
account, one cap); the API role cannot `UPDATE staff_session SET surface` (permission or policy error). Security
suites: `open_staff_session(bytea, text, text, text)` is in the function list, executable by the API role only
(`apps/api/test/security/*`, outsider and grants lists); `test/db/rehearsal.int.test.ts` and the community gate map
updated if they list functions.

## 3. API: which origin opens which session, and which session each door takes (ADR-720, ADR-721)

`apps/api/src/auth/staff-guard.ts`:
- `surfaceOf(request, origins)`: `console` when the request's `Origin` equals `consoleOrigin`, else `dashboard`
  (a missing Origin is the lesser surface). The code step opens `console` only for a platform admin: a non-admin
  signing in on the console origin opens a `dashboard` session (review 86, NIT). Used only by the two steps that open a session: `POST
  /v1/staff/auth/code` (sign-in) and `POST /v1/staff/auth/sign-up/code` (sign-up). Sign-up always opens
  `dashboard`: a new account is an organizer and has no console (ADR-720).
- `checkOrigin(request, allowed, cookieRequired)` takes a list. Sign-in steps (no cookie yet) accept either origin;
  every cookie request accepts only **its own session's** origin (`dashboard` -> `DASHBOARD_ORIGIN`, `console` ->
  `CONSOLE_ORIGIN`), so the check moves after `requireSession` for cookie routes. Safe methods stay exempt as today.
- `requireSurface(request, surface)`: throws the door's own refusal (below) and logs `authz.denied` through T-810b's
  central denial helper, with the reason `wrong_surface`.

Per door:

| Door | Origin for unsafe methods | Sessions accepted | Refusal for the other surface |
|---|---|---|---|
| `/v1/admin/*` console hook (`activation/routes.ts`) | `CONSOLE_ORIGIN` | `console` only | hidden 404 (as for a non-admin today) |
| `/v1/staff/*` (`auth/routes.ts`) | the session's own origin; either for the public sign-in steps | both | 403 `csrf_rejected` on an origin mismatch |
| `/v1/organizers/*` (`organizers/routes.ts`) | `DASHBOARD_ORIGIN` | `dashboard` only | hidden 404 (as for a non-member) |

The device doors (`devices/*`) take the device cookie, not a staff session, and are unchanged.

Organizer doors refuse console sessions (deny by default, ADR-720): the console host never shows a dashboard page,
so a console session has no reason to call them. Questify support (ADR-407) works in the organizer's dashboard, so
an admin giving support signs in on the public host too (two sessions, one each; Q-692).

The hidden 404 keeps the console unadvertised on the public host. The console's own pages on the console host show
"not found" for a non-admin, as today.

Emails: `team-alerts/worker.ts` builds the console links from `consoleOrigin` (today `dashboardOrigin`). Reset, invite
and code emails keep the dashboard origin; an admin who resets a password signs in again on the console host.

Tests (`apps/api/test/auth/*`, `test/console/*`, `test/security/routes.int.test.ts`):
- sign-in from the console origin opens a `console` row, from the dashboard origin and with no Origin a `dashboard`
  row; sign-up from the console origin still opens `dashboard`;
- an active admin's `dashboard` session gets 404 on a GET and a POST of `/v1/admin/*`, with one `authz.denied` line
  (`wrong_surface`); the same admin's `console` session gets 200;
- a `console` session POST to `/v1/admin/*` with the dashboard origin, and a `dashboard` session POST to
  `/v1/staff/*` with the console origin, both 403 `csrf_rejected`;
- a `console` session on `/v1/organizers/*` gets 404 even for a member; on `/v1/staff/me` it gets 200;
- route inventory: every `admin` route refuses a `dashboard` session (driven from `registerRouteInventory`, the way
  T-810b's cross-tenant test drives every route, so a new console route cannot skip it);
- outsider: no cookie, either origin, every `/v1/admin/*` route is 404 or 401 as today;
- the team alert email's links start with the console origin.

## 4. Web: host routing (ADR-722)

`apps/web/src/lib/console-host.ts` (new, pure, unit-tested):
- `hostKind(host, config)`: `console` when the lower-cased `Host` equals the console origin's host (with port), else
  `public`. Anything unknown is `public`.
- `routeFor(kind, pathname)`: what the proxy does with a page path.
  - Public host: `/{lang}/console` and below -> 308 to `CONSOLE_ORIGIN` + same path and query.
  - Console host: `/` and `/{lang}` -> 307 to `/{lang}/console` (language negotiated as today); allowed:
    `/{lang}/console/**`, `/{lang}/sign-in`, `/{lang}/account` (the admin's own sessions and password, T-810c; Q-693);
    everything else -> 308 to `DASHBOARD_ORIGIN` + same path and query.
- `proxy.ts` calls these before its language step; its matcher is unchanged.

`apps/web/src/lib/forward.ts` / `app/v1/[...path]/route.ts`: on the public host, `/v1/admin/*` answers the
forwarder's own 404 without calling the API. Every other path forwards on both hosts (the API decides).

Links that cross hosts become absolute (server components read the config; client components get the origin as a
prop): the home page's Console button (`app/[lang]/page.tsx`), and any console link to a dashboard page or
dashboard link to a console page. The builder finds them with
`rg -n 'href=\{`/\$\{lang\}/(console|organizers|account|e/)' apps/web/src` and checks each. Console links inside the
console stay relative.

The sign-in page on the console host sends an admin to `/{lang}/console` after sign-in; a non-admin who signs in
there sees the console's not-found page with a link to the public host's sign-in (one new string pair,
`console.wrongHost`, Arabic with the ux-araby skill).

The proxy's matcher skips any path whose last part has a dot (files such as `robots.txt`), so such a path never meets
the host step; no page path (an event code, a slug) contains a dot, and a console page reached that way on the public
host still gets nothing, because the forwarder there never passes `/v1/admin/*` on.

Tests: `console-host.test.ts` (each rule above, with and without query, upper-case host, the port, a path that only
starts with `console`, such as `/en/consoleX`; `x-forwarded-host: console…` with a public `Host` is public; redirects
use the configured origins, never the request's `Host`, and a path such as `//evil.example` stays on them); `forward.test.ts` (`/v1/admin/x` on the public host is 404 and calls
no fetch; on the console host it forwards); `proxy` test for the 308 and the console-host home redirect.

## 5. Browser tests (ADR-724)

- `apps/web/playwright.config.ts`: `CONSOLE_ORIGIN = http://console.localhost:3100` (Chromium resolves
  `*.localhost` to loopback and treats it as secure, so `__Host-` cookies work over http); both origins passed to the
  web server and the e2e API server (`E2E_CONSOLE_ORIGIN`). If Chromium refuses the cookie there, use
  `http://127.0.0.1:3100` and record it in ADR-724.
- The `console-*.spec.ts` files run on the console origin (`test.use({ baseURL: CONSOLE_ORIGIN })`, from
  `e2e/paths.ts`); specs that go from the console into an organizer's dashboard (support) sign in on both.
- New `e2e/console-host.spec.ts`, desktop and phone, Arabic and English for the visible parts:
  `/en/console` on the public host lands on the console host; an admin signs in on the console host and the
  public host's cookie jar has no session; the same admin signed in on the public host gets 404 from
  `/v1/admin/activation-requests` fetched from a public page; the console host's `/en/organizers` lands on the
  public host.
- Locally: a fresh web build, `e2e:api`, then `layout.spec.ts`, `console-host.spec.ts` and two console specs, one
  worker (WORKER_BRIEF). CI runs the rest.

## 6. Docs

`docs/API.md` Conventions (two origins, the surface rule, the per-door table), `docs/DATA_MODEL.md`
(`staff_session.surface`), `docs/SECURITY.md` (the three layers), `docs/ARCHITECTURE.md` (one web app, two hosts),
`docs/RUNBOOK.md` (both settings on both apps, the deploy order below, the admin sign-in after deploy, the probes),
`docs/security/ASVS_L2.md` (gap 12 and V3.5.4 to Met once staging shows it), `docs/TASKS.md`, STATE.

## 7. Deploy order and staging proof

1. Dhia adds the DNS record and the CranL domain ("Needs Dhia"); the console host then serves today's app, harmless.
2. The coordinator sets `CONSOLE_ORIGIN=https://console.questify.nafes.com` on both CranL apps (API and web), then
   deploys (migration 0156 with T-810c's 0155). Without the setting both apps refuse to start, by design.
3. Probes (no CI minutes): `curl -sI https://questify.nafes.com/en/console` -> 308 to the console host;
  `curl -sI https://console.questify.nafes.com/en/organizers` -> 308 to the public host;
  `curl -sI https://console.questify.nafes.com/en/sign-in` -> 200; a `POST` to the public host's
  `/v1/admin/activation-requests` -> 404 from the forwarder. Then Dhia's admin signs in on the console host.
4. Rollback is fixing forward (review 86, item 2): 0155 already revoked INSERT on `staff_session`, so the release
   before T-810c cannot open a session on this schema at all, and the T-810c release calls the three-argument definer
   that 0156 drops. The RUNBOOK ("T-810d rollback") has the SQL that puts the three-argument opener back beside the
   new one, for a redeploy of the T-810c release while the fix is made. Know this before merging.
5. After the deploy, `curl -s -o /dev/null -w "%{http_code}" https://questify.nafes.com/en` answers 200 (the public
   home still serves; review 86, item 6).

## Plan review (86)

The review's items, all built in this task:

1. **MAJOR: a same-site GET reached the console session.** The two hosts are the same site, so a public page's GET (an
   image, a fetch) to `console…/v1/admin/*` carried the console cookie, refreshed `last_seen_at` (defeating the idle
   timeout) and spent the admin player-read limit. Now, on `/v1/admin/*` and every other staff session door, the
   check runs **before** `requireSession`: a `Sec-Fetch-Site` of `same-site` or `cross-site` is refused, and so is an
   Origin outside the door's list (`/v1/admin/*`: the console origin only). On `/v1/staff/*` the Origin must be one of
   the two before the lookup and the session's own after it. The forwarder passes `Sec-Fetch-Site` on. Tests
   (`test/auth/console-surface.int.test.ts`): a same-site GET to the console is refused and `last_seen_at` does not
   move; a forged POST does not touch the session; the console's own same-origin read does.
2. **Rollback is fixing forward.** 0155 already revokes INSERT on `staff_session`; the RUNBOOK gives the SQL and the
   order (§7, step 4).
3. **`console-host.test.ts`:** `x-forwarded-host: console…` with a public `Host` is public; redirects use the
   configured origins, never the request's `Host` (no open redirect). The proxy matcher skips paths whose last part
   has a dot, so slugs never contain one (§4).
4. **SECURITY.md:** support seats remain an admin power usable from a dashboard session (`organizers/routes.ts`,
   `principalOf` and `supportSeatOf`), stated as a known risk.
5. **NITs:** §2 credits the column grant (0002:89), not a policy; the device row left the §3 door table; a non-admin
   signing in on the console origin opens a dashboard session.
6. **Post-deploy probe:** `https://questify.nafes.com/en` answers 200 (§7, step 5; RUNBOOK).

ADR-720, ADR-722, ADR-723, ADR-724 and Q-690 to Q-693 were judged acceptable and stay Proposed for the coordinator.

### As built

- Next makes a proxy redirect relative when its target host is the server's own, and counts `localhost`, 127.0.0.1
  and ::1 as one host. Production listens on `0.0.0.0` (Dockerfile.web), so its redirects stay absolute; the browser
  tests now start the web server with `HOSTNAME=0.0.0.0` too, and the 127.0.0.1 fallback of ADR-724 cannot work.
- A signed-in non-admin on the console host is sent to the public host's home rather than shown a not-found page
  with a link, so no new string pair was needed.
- The browser specs keep the public `baseURL`: `makeAdmin` (e2e/hosts.ts) signs the admin in on the console host, and
  console API calls run in a console-host page (`consoleRequest`).

## Order of commits

1 (settings), 2 (0156 and DB tests), 3 (API doors and tests), 4 (web routing and unit tests), 5 (browser tests),
6 (docs). Full vitest once at the end into a log file.

## Mutation targets (core: sign-in and admin access)

`apps/api/src/auth/staff-guard.ts`, `apps/api/src/auth/session.ts`, the console hook in
`apps/api/src/activation/routes.ts`, the organizer hook in `apps/api/src/organizers/routes.ts`,
`apps/web/src/lib/console-host.ts`.

## Not in this task

- A separate registrable domain for the console (stronger than a subdomain: the two hosts stay same-site; the
  per-session origin check covers it). Q-690.
- Showing "Console" or "Dashboard" beside each session in the sessions lists (T-810c's pages). FOLLOWUPS if wanted.
- Production hostnames: `console.questify.sa` when production's web app gets `questify.sa` (T-811 and the production
  set-up), the same two steps.

## Needs Dhia (when the code is ready; asked with AskUserQuestion then)

1. **Cloudflare, zone `nafes.com`:** add a `CNAME` record, name `console.questify` (so
   `console.questify.nafes.com`), target the same address the existing `questify` record points to (the staging web
   app, `questify-web-staging-4ecphq.cranl.net`, or whatever CranL's domain screen asks for), proxy **off** (DNS
   only, grey cloud), like `questify.nafes.com`.
2. **CranL, web app `questify-web-staging`:** Domains -> add `console.questify.nafes.com` and wait for its
   certificate to show as issued. Same app, no new CranL app (three-app budget).
3. Then sign in once on `https://console.questify.nafes.com/en/sign-in`; the console no longer opens from
   `questify.nafes.com`.
