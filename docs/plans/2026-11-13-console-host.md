# T-810d - The console on its own hostname (plan, tier A: admin powers, sign-in)

Source: TASKS.md T-810d, Q-663 (Dhia, 2026-11-05: "Yes, console subdomain"), `docs/security/ASVS_L2.md` gap 12 and row
V3.5.4. Migration **0199** (new; 0198 is the newest on main). Decisions ADR-720 to ADR-724, questions Q-690 to Q-693
(numbers held for T-810d since 2026-11-05, never used on main) and Q-782, Q-783.

**This is a port, with one change of rule.** T-810d was planned (review 86) and built (code review 92) on 2026-11-05 on
branch `t-810d-console-hostname` (plan `docs/plans/2026-11-05-t-810d-console-hostname.md` on that branch). It never
merged: it made `CONSOLE_ORIGIN` required, so it could not ship before Dhia adds the DNS record, and the branch is now
eight days and about 200 commits behind (T-803 P2's player web session rewrote the forwarder and the web settings). This
plan carries the reviewed design onto today's main, keeps its three layers, tests and threat analysis, and changes one
rule (ADR-723, amended):

> **No console host configured (`CONSOLE_ORIGIN` unset on an app) means that app behaves exactly as today.** The code
> can merge and deploy now; the split starts the day the setting is set on both apps after Dhia's DNS step.

**Done when** (TASKS.md): the console and the public pages are on different origins on staging and ASVS V3.5.4 is Met.
That needs Dhia's DNS step, so this task ships the code side; the tick waits on the probes (RUNBOOK checklist, Q-783).

---

## Threat and the three layers (unchanged from review 86)

The threat (Q-663): a script that gets into any public page (event page, station, big screen, organizer content) runs
on the console's origin and can call `/v1/admin/*` with a platform admin's cookie.

| Layer | Where | What it stops |
|---|---|---|
| Session surface (ADR-720) | API, `staff_session.surface` | A public-host session, even an admin's, never passes the console hook |
| Caller and origin per session (ADR-721) | API, staff doors | A page on one host driving the other host's session (the hosts are same-site, so `SameSite=Strict` does not separate them) |
| Host routing (ADR-722) | Web, `proxy.ts` and the forwarder | No public page is served on the console origin; the public host never forwards `/v1/admin/*` |

## 1. Settings (ADR-723, amended: optional, unset is today)

- API `apps/api/src/config.ts`: `auth.consoleOrigin: string | undefined` from an optional `CONSOLE_ORIGIN`. When set it
  must be an origin only (the existing `origin()` check) and differ from `DASHBOARD_ORIGIN`; either fault stops start-up
  with a message naming both settings. Unset or empty: `undefined`.
- Web `apps/web/src/lib/config.ts`: `consoleOrigin: string | undefined`, the same rules plus https (http only on
  `localhost`, `*.localhost` and 127.0.0.1, for local runs and the browser tests). `isWebOrigin` learns `*.localhost`.
- Mismatch between the apps fails closed, never open: API set and web unset, the console pages are served on the public
  host but every `/v1/admin/*` call there carries a dashboard session and gets 404 (or 403 before the lookup), so the
  console is unusable, not exposed. Web set and API unset, the console host serves the console but the API takes only
  the dashboard origin on writes (403) and the public host forwards no `/v1/admin/*`. The RUNBOOK sets both together.
- Tests: `config.test.ts` in both apps: unset and empty give `undefined`; a path, a trailing slash, equal origins and
  (web) plain http on a public host are refused; `console.localhost` over http is accepted.

## 2. Migration 0199: the session's surface (ADR-720)

As 0156 of the old branch, renumbered: `ALTER TABLE staff_session ADD COLUMN surface text NOT NULL DEFAULT 'dashboard'
CHECK (surface IN ('dashboard', 'console'))`; `DROP FUNCTION open_staff_session(bytea, text, text)` and
`CREATE FUNCTION open_staff_session(token bytea, agent text, address text, surface text)` with 0155's body (checked
against main: no later migration redefines it) plus the surface, raising `22023` for anything else; `REVOKE ALL ...
FROM PUBLIC`, `GRANT EXECUTE ... TO questify_app`. The API role still cannot write the column: INSERT was revoked in
0155 and its UPDATE is the 0002 column grant (`last_seen_at`, `revoked_at`). Replace, not overload (ADR-718's
precedent): an old API instance cannot open a staff session for the deploy's minute.

Unset `CONSOLE_ORIGIN`: every session opens as `dashboard` and no door reads the column, so behaviour is today's.

DB tests (`apps/api/test/db/staff-session-surface.int.test.ts`): default `dashboard`; the CHECK refuses another value;
the definer stores both and refuses a third with 22023; the 10-session cap counts both surfaces; the API role cannot
`UPDATE staff_session SET surface`. Security lists (`apps/api/test/security/*`, rehearsal, gate map) updated for the
four-argument function.

## 3. API doors (ADR-720, ADR-721)

`apps/api/src/auth/staff-guard.ts` gets `StaffOrigins = { dashboard: string; console: string | undefined }` and:
- `surfaceOf(request, origins)`: `console` only when a console origin is configured and the request's `Origin` equals
  it; the code step opens `console` only for a platform admin; sign-up always opens `dashboard`.
- `checkCaller(request, allowed, cookieRequired)`, before any session lookup, **only when a console origin is set**: a
  `Sec-Fetch-Site` of `same-site` or `cross-site` is refused on every method, and so is an Origin outside the door's list;
  an unsafe cookie request without Origin is refused. A refused request never refreshes `last_seen_at` or spends limits
  (review 86, item 1).
- `checkSessionOrigin`: after the lookup on `/v1/staff/*`, a sent Origin must be the session's own.
- `requireSurface(request, surface)`: hidden 404, logged `authz.denied` with `reason: wrong_surface` (needs the
  `reason` field on `HttpError` and in `logDenied`).
- `guardStaffDoor(request, reply, deps, door)`: one entry point for the three hooks, so the "unset is today" branch
  lives in one place:

| Door | Console origin unset (today) | Console origin set |
|---|---|---|
| `/v1/admin/*` (`activation/routes.ts`) | `checkOrigin(dashboard)`, session | `checkCaller([console])`, session, `console` surface only (else hidden 404) |
| `/v1/staff/*` (`auth/routes.ts`) | `checkOrigin(dashboard)`, session unless public | `checkCaller([dashboard, console])`, session unless public, then its own origin |
| `/v1/organizers/*` (`organizers/routes.ts`) | `checkOrigin(dashboard)`, session | `checkCaller([dashboard])`, session, `dashboard` surface only (else hidden 404) |

Device doors take the device cookie and keep `checkOrigin(dashboard)`. Team alert digests link to `consoleOrigin ??
dashboardOrigin`. Reset, invite and code emails keep the dashboard origin.

**CORS:** none, now or after. The browser reaches the API only through each host's own same-origin forwarder, so the API
sends no `Access-Control-Allow-*` header and needs none; a cross-origin page cannot read an answer. The integration
suite asserts no such header on a console answer.

**Cookies scoped per host:** the staff cookie is `__Host-qs_session` (no `Domain`, `Path=/`, `Secure`,
`SameSite=Strict`), so the browser binds it to the exact host that set it; the forwarder copies `Set-Cookie` unchanged.
A console sign-in therefore sets it on the console host only, and the public host's cookie jar never holds it. The
player cookie (T-803 P2) and the language cookie are host-only too. Tests: the console sign-in's `Set-Cookie` has no
`Domain`; in the browser, each host holds its own session cookie.

Tests (`apps/api/test/auth/console-surface.int.test.ts`, an app built with `CONSOLE_ORIGIN` set; existing suites keep
the unset default and so prove "exactly as today" unchanged):
- which surface each sign-in opens (console origin admin, dashboard origin, no Origin, non-admin on the console);
- an admin's dashboard session on `/v1/admin/*` (GET and POST) gets 404 with one `wrong_surface` line; the console one
  200; a console session on `/v1/organizers/*` 404 even for a member; on `/v1/staff/me` 200;
- each session only with its own origin (403 `csrf_rejected` across);
- same-site and cross-site reads and forged writes are refused before the lookup and leave `last_seen_at` alone;
- every `/v1/admin/*` route from the inventory refuses a dashboard session with 404 and the public origin with 403;
- with `CONSOLE_ORIGIN` unset, an admin's dashboard session still reads `/v1/admin/*` and a same-site fetch still passes
  (today's rule), in the same file.

## 4. Web: host routing and redirects (ADR-722)

`apps/web/src/lib/console-host.ts` (new, pure): `hostKind(host, origins)` (exact `Host` match with port, case aside;
`x-forwarded-host` is never read, Q-691) and `routeFor(kind, url, origins)`:
- no console origin: always `serve` (today);
- public host: `/{lang}/console/**` 308 to the console origin with the same path and query (**old `/console` links and
  bookmarks keep working**);
- console host: `/` 307 to `/{lang}/console` (negotiated language); `/{lang}` likewise; `/{lang}/console/**`,
  `/{lang}/sign-in`, `/{lang}/account` served (Q-693); `/play` and every other page 308 to the public origin.
Redirects join the configured origin and the path as strings, never resolve against the request's `Host`, so
`//evil.example` stays on the configured host.

`proxy.ts` runs the host step before the language step (split into small functions under the limits). The forwarder
(`forward.ts`) answers its own 404 to `/v1/admin/*` on the public host when a console origin is set, without calling
the API, and passes `Sec-Fetch-Site` to the API (`forward-headers.ts`). The player cookie steps are untouched: on the
console host there is no player cookie and `/v1/auth/*` writes fail the forwarder's web-origin check.

Cross-host links (only when the console origin is set; relative otherwise, as today): the home page's Console button,
support's "open the dashboard" (`ConsoleOversight`), and the console page guard sends a signed-in non-admin on the
console host to the public home. A link helper `consoleHref`/`dashboardHref` keeps it one rule.

**CSP and framing:** unchanged and correct for two hosts. Every page policy has `frame-ancestors 'none'` (neither host
can frame the other), `form-action 'self'` and `connect-src 'self'`, and `'self'` is each host's own origin, so a console
page can only call the console host's forwarder. The API's answers carry `frame-ancestors 'none'` too. A proxy test
pins `frame-ancestors 'none'` on a console-host page.

Tests: `console-host.test.ts` (each rule; unset; upper case and port; `/en/consoleX`; `x-forwarded-host`; `//evil`),
`proxy.test.ts` (308s both ways, the console home, CSP on the console host, unset is today), `forward.test.ts` (public
host `/v1/admin/x` is 404 with no fetch; console host forwards; unset forwards; `sec-fetch-site` is passed).

## 5. Browser tests (ADR-724, amended)

The existing specs keep running on one host with no console origin (today). `playwright.config.ts` starts a second
pair: the e2e API bundle on port 4102 with `E2E_CONSOLE_ORIGIN` (own throw-away database, codes file
`.e2e/codes-console.json`, control port 4103, one seeded platform admin per browser size), and the same web build on
port 3102 with `DASHBOARD_ORIGIN=http://localhost:3102`, `CONSOLE_ORIGIN=http://console.localhost:3102`,
`HOSTNAME=0.0.0.0` (Next makes a redirect to its own listening host relative, which loops across hosts; as built on
the old branch). Chromium resolves `*.localhost` to loopback and treats it as a secure context, so `__Host-` cookies
work over http. New `e2e/console-host.spec.ts`, desktop and phone, English and Arabic (RTL): `/en/console` on the public
host lands on the console host's sign-in; the admin signs in there and only the console host holds the session; the
public host's `/v1/admin/*` answers 404; `/en/organizers` on the console host goes to the public host; `/ar` on the
console host opens the Arabic console with no sideways scroll.

## 6. DNS and CranL (Dhia's step, not in this task)

RUNBOOK "The console on its own host" gets the checklist (Cloudflare CNAME, CranL domain on the same web app, the two
settings on both apps, deploy, probes, the admins' sign-in again, rollback). OPEN_QUESTIONS Q-783 asks Dhia for it.
Nothing touches CranL in this task.

## 7. Docs

API.md (conventions: the doors table), DATA_MODEL.md (`staff_session.surface`), SECURITY.md (the three layers, known
risks: support seats from a dashboard session; same-site subdomains, Q-690), ARCHITECTURE.md (one web app, two hosts),
RUNBOOK, ASVS sheet (row stays Partly until staging shows it), TASKS (note; tick waits for staging), STATE.

## Mutation targets (core: sign-in and admin access)

`apps/api/src/auth/staff-guard.ts`, `apps/api/src/auth/session.ts`, `apps/api/src/activation/routes.ts` (hook),
`apps/api/src/organizers/routes.ts` (hook), `apps/web/src/lib/console-host.ts`.

## Not in this task

A separate registrable domain (Q-690); "Console"/"Dashboard" beside each session in the sessions lists; production's
`console.questify.sa` (same two steps at the production set-up).
