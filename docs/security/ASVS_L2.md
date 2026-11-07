# ASVS 5.0 Level 2 verification sheet: the core

> T-810, drafted 2026-11-05 before the penetration test (T-809), so the tester starts from it. T-810 stays open until
> T-809's findings are folded in and every gap below is closed or accepted in writing (QUALITY_BASELINE, release gate).

**Standard.** OWASP ASVS 5.0.0, Level 1 and Level 2 (253 controls: 70 at L1, 183 at L2). Numbering and levels come
from OWASP's own export, `5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv` at tag `v5.0.0`
of `github.com/OWASP/ASVS` (fetched 2026-11-04). Each control below is a short paraphrase; read OWASP's text for the
exact wording.

**Scope: the core** (`QUALITY_BASELINE.md` §1, `rules.md` "Quality bar"): the points and XP ledger, sign-in and
sessions, tenant isolation, redemptions and prize handover, admin powers, wallet signing, signed QR/NFC proofs, and
personal data sent outside. Every L1 and L2 control is listed; a control that cannot touch the core is Not applicable
with its reason. **Wallet signing is not built** (T-801 open): no control is marked Met on its account, and T-801 adds
its rows (V11.1, V11.6, V13.3) when it lands.

**Statuses.** Met: the control holds and the evidence proves it. Partly: it holds for part of the core, or holds without
proof. Not met: it does not hold. N/A: it cannot apply, with the reason.

**Evidence.** Paths are from the repository root. A test is named as its file and its exact title. A CI gate names
the step in `.github/workflows/ci.yml`. A doc reference names the section. "Note" marks a fact checked in the code
(by `rg`) with no test behind it.

## Counts

| Status | L1 | L2 | Total |
|---|---|---|---|
| Met | 55 | 105 | 160 |
| Partly | 3 | 19 | 22 |
| Not met | 0 | 0 | 0 |
| N/A | 12 | 59 | 71 |
| **Total** | **70** | **183** | **253** |

## Gaps and what to do

Code gaps were one tier A task, **T-810b** (`docs/TASKS.md`), done 2026-11-05 but for row 8, done as T-810f the same day.
Documentation gaps 15 to 17 were written on 2026-11-06 (T-810), and gap 18's proofing steps the same day; the part of gap 18 that needs code (an invite or a forced first password change for `staff.cjs create`) is in `docs/FOLLOWUPS.md`; product and hosting choices are Q-660 to Q-664
(`docs/OPEN_QUESTIONS.md`), answered as T-810b (rows 9 and 11), T-810c, T-810d, T-810e (row 11's notice, done) and T-811.

| # | Controls | Status | Gap | Recommendation | Where |
|---|---|---|---|---|---|
| 1 | V3.4.1, V3.4.3, V3.4.4, V3.4.6 | Met (T-810b) | Web pages send HSTS, nosniff and a CSP with `frame-ancestors 'none'`; `/v1` answers send none of them (the API sets none and the web forwarder passes only its allowlist), and no test asserts HSTS | Set `Strict-Transport-Security`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` on every API answer, pass them through `forward.ts`, test both | T-810b (1) |
| 2 | V15.3.2 | Met (T-810b) | Every outside call (`apps/api/src/players/sms.ts`, `apps/api/src/auth/breached.ts`, `apps/api/src/auth/email/resend.ts`, `apps/api/src/auth/email/gmail.ts`, `apps/api/src/auth/google-token.ts`) uses `fetch`'s default, which follows redirects | `redirect: "error"` on each, with a test per client | T-810b (2) |
| 3 | V11.5.1 | Met (T-810b; 128 bits, not 256, Q-670) | The invitation link token is `gen_random_uuid()` (122 random bits; ASVS says a UUID does not meet 128) | 256-bit random token in a new migration; links already sent keep working until their rows are purged (90 days) | T-810b (3) |
| 4 | V1.2.4, V1.2.9 | Met (T-810b, 0152) | `event_players` (migration 0032, the live definition) escapes `%` and `_` in the search prefix but its backslash step is `replace(…, '\', '\')`, a no-op (0019 and 0031 doubled it): a typed `\` changes the LIKE pattern. Scoped to the organizer's own event, so no data crosses a tenant | Restore `'\\'` in a new migration with a test searching for `\`, `%` and `_` | T-810b (4) |
| 5 | V16.3.2 | Met (T-810b) | A refused request leaves only the access-log line (method, path, status, request id); no event names the caller | One `authz.denied` event (route pattern, status, actor kind and id, never a body) for 403 answers and the 404 that hides a console or another tenant's object | T-810b (5) |
| 6 | V15.3.6, V15.3.7 | Met (T-810b) | Fastify's JSON parser refuses `__proto__` and the shared schemas refuse a repeated query key, but no test proves either | Two tests at the conventions layer | T-810b (6) |
| 7 | V15.1.2 | Met (T-810b; proven on the first release tag) | `pnpm sbom:generate` exists; no workflow runs it, so no release has an SBOM | Generate it on the release path and keep it with the release | T-810b (7) |
| 8 | V11.2.2 | Met (T-810f, 2026-11-05) | Each sealed reward code names its key id; the API holds a previous key during a rotation, and `reward-codes.cjs reseal` then `check` move every code to the new key (RUNBOOK "Rotating `REWARD_CODE_SECRET`") | Done | T-810f |
| 9 | V7.3.2, V7.1.1 | Met (T-810b, 0154) | Player refresh tokens slide (each rotation is a new 180 days, migration 0013), so a player session has no absolute end, and no note justifies the deviation from NIST SP 800-63B | A 365-day end (Q-660) | T-810b (9) |
| 10 | V7.4.3, V7.4.5, V7.5.2 | Met (T-810c, 0155; `docs/plans/2026-11-05-t-810c-signed-in-devices.md`) | A player cannot see or end their other devices; a contact change keeps every session with no "sign out other devices"; an admin can end only a platform admin's sessions from the console (others by SQL, RUNBOOK); ending a staff session asks for no re-authentication | Product choice | Q-661 |
| 11 | V6.3.3, V6.6.1 | Met (written exception T-810b; notice T-810e) | Players sign in with one factor (a code by SMS or email); no stronger method is offered and players are not told SMS's risks | A written exception (Q-662) and one line under the code field: never share the code, Questify never asks for it | T-810b (10), T-810e |
| 12 | V3.5.4 | Partly | The console, the dashboard, the public event page, stations and the big screen share one hostname | Product and domain choice | Q-663 |
| 13 | V4.1.2, V12.1.1, V12.1.2, V12.2.2, V12.3.1, V12.3.3, V12.3.4, V13.2.1, V13.2.4, V13.2.5, V13.3.1, V13.3.2, V16.4.2, V16.4.3 | Partly | Controls that live in CranL: edge TLS versions and ciphers, certificates, HTTP-to-HTTPS behaviour on the API host, TLS to PostgreSQL and Redis on the private network, static database and Redis passwords, no egress allowlist, the secret store's access control, and server logs kept only in CranL's log view | Ask CranL in T-811; decide per item | Q-664 |
| 14 | V15.1.1, V15.2.1 | Met (T-810, 2026-11-06) | Written time frames for fixing a vulnerable dependency: critical 7 days, high 14, moderate 30, the rest in the monthly Dependabot batch; CI's "Dependency audit" fails a pull request on any finding not listed in `auditConfig.ignoreGhsas` | Done | `docs/QUALITY_BASELINE.md` §2, "Fixing a vulnerable dependency" |
| 15 | V11.1.1, V11.1.2 | V11.1.2 Met, V11.1.1 Partly (T-810, 2026-11-06) | The cryptographic inventory and key policy are written (`docs/SECURITY.md` "Cryptographic inventory and key policy"), so V11.1.2 is Met. V11.1.1 stays Partly: rotation is event-driven with no schedule (QUALITY_BASELINE section 4 says "on a schedule"), `AUTH_SECRET` and `QR_SECRET` have no previous-key slot, the RUNBOOK has no steps for the provider keys, who can read the secret store is unconfirmed (Q-664), and the policy is not mapped to NIST SP 800-57 | Q-700's recommendation | Q-700 |
| 16 | V16.1.1 | Partly (inventory written, T-810, 2026-11-06) | The log inventory is written (`docs/SLO.md` section 6). It records that Questify sets no retention for CranL's logs (Q-443) and that the audit log is kept with no period (Q-084), so the control's retention clause is not met | Set the periods when counsel and T-811 answer | Q-443, Q-084 |
| 17 | V6.1.3 | Met (T-810, 2026-11-06) | Done: `docs/SECURITY.md` "Sign-in pathways and their strength" lists every pathway of the product with its proof, the limits that bound guessing, what it opens and its test, and says how the access kinds enforce them alike. The operator's own accounts sit outside the product (Q-701) | Done | `docs/SECURITY.md` "Sign-in pathways and their strength" |
| 18 | V6.4.1, V6.4.4 | V6.4.4 Met, V6.4.1 Partly (RUNBOOK steps written 2026-11-06) | The proofing steps for a lost staff mailbox and a player's lost number are written from the doors that exist (RUNBOOK "Lost mailbox or lost number: proving who is asking"). `staff.cjs create` still accepts any password piped in and nothing forces a change at the first sign-in; the RUNBOOK now pipes a random password nobody sees and sends the person to "Forgot your password?", so no operator holds a working password | Make `create` send an invite, or make the first sign-in choose a new password (a migration and a change to the sign-in path: a plan and a race test) | FOLLOWUPS |
| 19 | V3.3.1, V3.3.3 | Met (T-810, 2026-11-06) | The language cookie (`apps/web/src/lib/language.ts`) is `__Host-qs_lang`; the proxy still reads the old `qs_lang` once, so a saved choice survives, and removes it when it sets the new one | Done | `apps/web/src/lib/language.ts`, `apps/web/src/proxy.ts` |
| 20 | V7.5.1 | Partly | A player's phone or email change is not re-authenticated (accepted deviation, ADR-120, SECURITY "Data protection") | Keep; covered by Q-661's session controls | ADR-120 |
| 21 | V14.1.2, V14.2.4 | Partly | Retention periods wait for counsel (Q-075) | T-807 | Q-075 |
| 22 | V4.2.1 | Partly | Request smuggling rests on Node's parser and CranL's edge; nothing tests it | The tester checks it | T-809 |

## V1 Encoding and Sanitization

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V1.1.1 | 2 | Decode input once, to a canonical form, before validating it | Met | `apps/api/src/quests/qr.test.ts` "refuses the other spellings of the same bytes (only the canonical one counts)"; `apps/api/src/auth/normalize.test.ts` "applies NFKC so full-width letters match plain ones" | |
| V1.1.2 | 2 | Encode output as the last step, or let the interpreter do it | Met | `docs/SECURITY.md` "Top abuse cases" #9 and "Home blocks written by the organizer": React and React Native draw text, SQL takes parameters | |
| V1.2.1 | 1 | Context-correct output encoding in HTTP, HTML and XML | Met | Note: no `dangerouslySetInnerHTML` or `innerHTML` in `apps/web/src` or `apps/app/src`; `apps/web/src/lib/security-headers.test.ts` "allows scripts only with this request's nonce in production, and nothing that evaluates text" | |
| V1.2.2 | 1 | Encode untrusted data in URLs; only safe URL schemes | Met | `packages/shared/src/layout/home-content.test.ts` "what a tap may open" › "refuses %j" (`javascript:`, `intent:`, `http:`); `apps/app/src/event/scan.test.ts` "refuses another host, scheme, path or token" | |
| V1.2.3 | 1 | Encode when building JavaScript or JSON | Met | JSON is written by the framework serializer only; `apps/api/src/conventions.test.ts` "replays the status and content type of the first answer" | |
| V1.2.4 | 1 | Parameterized database queries | Met | Every API query binds parameters; the only dynamic SQL is `EXECUTE format(…%I…)` in `apps/api/migrations/0014_definer_search_path.sql`; `apps/api/test/db/bans.int.test.ts` "takes a backslash in the prefix literally too (T-810b, migration 0152)" | |
| V1.2.5 | 1 | No OS command injection | N/A | Note: no `child_process` anywhere in `apps/` | No OS calls |
| V1.2.6 | 2 | No LDAP injection | N/A | | No LDAP |
| V1.2.7 | 2 | No XPath injection | N/A | | No XML or XPath |
| V1.2.8 | 2 | LaTeX processors locked down | N/A | | No LaTeX |
| V1.2.9 | 2 | Escape regular-expression metacharacters from input | Met | Note: no `new RegExp(` over input in `apps/api` or `packages/shared` (only browser-test helpers); `apps/api/test/db/bans.int.test.ts` "takes a backslash in the prefix literally too (T-810b, migration 0152)" | |
| V1.3.1 | 1 | Sanitize WYSIWYG HTML input | N/A | `docs/SECURITY.md` "Home blocks written by the organizer": plain text only, no HTML or Markdown | No HTML input exists |
| V1.3.2 | 1 | No `eval` or dynamic code execution | Met | Note: no `eval(` or `new Function(` in `apps/`; `apps/web/src/lib/security-headers.test.ts` "allows scripts only with this request's nonce in production, and nothing that evaluates text" | |
| V1.3.3 | 2 | Sanitize data for dangerous contexts (allowed characters, length) | Met | `apps/api/src/rewards/codes.test.ts` "trims, applies NFC and refuses empty, long or control-character codes"; `docs/SECURITY.md` "Questify invitations" (the name rule) | |
| V1.3.4 | 2 | Sanitize user SVG | N/A | | The core accepts no SVG |
| V1.3.5 | 2 | Sanitize Markdown, CSS, XSL and similar | N/A | `docs/SECURITY.md` "Home blocks written by the organizer" | No markup language is accepted |
| V1.3.6 | 2 | SSRF: allowlist outbound destinations | Met | Note: every outbound host is a constant (`apps/api/src/players/sms.ts`, `apps/api/src/auth/breached.ts`, `apps/api/src/auth/email/resend.ts`, `apps/api/src/auth/email/gmail.ts`, `apps/api/src/push/apns.ts`, `apps/api/src/push/fcm.ts`); no URL from a request is fetched | |
| V1.3.7 | 2 | No template built from untrusted input | Met | `packages/shared/src/push/templates.test.ts` (fixed templates, placeholder allowlist); `docs/SECURITY.md` "Push notifications and the center" | |
| V1.3.8 | 2 | JNDI | N/A | | No Java |
| V1.3.9 | 2 | Sanitize before memcache | N/A | | No memcache; Redis keeps ids and scores only (`docs/SECURITY.md` T-105 "V8 rankings") |
| V1.3.10 | 2 | Sanitize format strings | Met | Note: no printf-style formatting over input; SQL `format()` takes `%I` identifiers from the catalog only (0014) | |
| V1.3.11 | 2 | No SMTP or IMAP injection | Met | `apps/api/src/auth/normalize.test.ts` "refuses what NFKC makes too long (one compatibility character becomes many)"; mail is sent through the Gmail and Resend JSON APIs, never raw SMTP from the API | |
| V1.4.1 | 2 | Memory-safe strings and copies | N/A | | Managed runtimes only (Node, PostgreSQL); no native code of ours |
| V1.4.2 | 2 | Prevent integer overflow | Met | `apps/api/test/db/core-columns.int.test.ts` "cannot be set by the organizer or an admin either: only the points ledger may move them"; points come from the quest row and caps (`apps/api/test/db/completion-engine.int.test.ts` "pays a repeatable quest up to its cap, then refuses with the cap") | |
| V1.4.3 | 2 | Free memory, no dangling pointers | N/A | | Garbage-collected runtimes |
| V1.5.1 | 1 | XML parsers without external entities | N/A | | No XML is parsed |
| V1.5.2 | 2 | Safe deserialization | Met | Only `JSON.parse` through Fastify and strict Zod schemas; `apps/api/src/app.test.ts` "refuses a plain-text body, because only JSON reaches a handler" | |

## V2 Validation and Business Logic

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V2.1.1 | 1 | Validation rules documented | Met | `docs/API.md` "Operations (v1 baseline)" (every body); shared schemas in `packages/shared/src` | |
| V2.1.2 | 2 | Rules for combined data documented | Met | `docs/API.md` "Rewards and handover", "Quests and verification" | |
| V2.1.3 | 2 | Business limits documented, per user and global | Met | `docs/SECURITY.md` tables (T-006, T-105, T-309, T-409) and "Top abuse cases" #4; `apps/api/src/auth/limits.ts` | |
| V2.2.1 | 1 | Validate every input against allowlists or structure | Met | `packages/shared/src/sessions/sessions.test.ts` "refuses an unknown field, a price and a control character"; `apps/api/test/players/sign-in.int.test.ts` "refuses an unusable email and a malformed body" | |
| V2.2.2 | 1 | Validate at a trusted service layer | Met | `apps/api/test/db/completion-engine.int.test.ts` "is written by the function only: the API's role inserts nothing itself"; `docs/rules.md` hard rule 1 | |
| V2.2.3 | 2 | Related items checked together | Met | `apps/api/test/desk/routes.int.test.ts` "refuses overlapping, reversed or too many windows"; `apps/api/test/rewards/reserve-order.int.test.ts` "RS403 feature_off before the shop's window" | |
| V2.3.1 | 1 | Flow steps in order, none skipped | Met | `apps/api/test/auth/sign-in.int.test.ts` "reaches nothing after the password step alone, or with the challenge token as a cookie"; `apps/api/test/desk/routes.int.test.ts` "offers, polls, lets the player decline and accept" | |
| V2.3.2 | 2 | Business limits enforced as documented | Met | `apps/api/test/db/completion-engine.int.test.ts` "pays a repeatable quest up to its cap, then refuses with the cap"; `apps/api/test/rewards/rewards.int.test.ts` "keeps the per-player limit, counting reservations held (FR-502)" | |
| V2.3.3 | 2 | All-or-nothing transactions | Met | `apps/api/test/rewards/rewards.int.test.ts` "refuses a balance below the price and changes nothing"; `apps/api/test/db/completion-engine.int.test.ts` "writes one completion and one ledger entry of the quest's points, and moves the score and balance with it" | |
| V2.3.4 | 2 | Locking so limited stock cannot be double-booked | Met | `apps/api/test/rewards/rewards.int.test.ts` "gives the last unit to one of two players reserving at once"; `apps/api/test/db/first-bonus.int.test.ts` (the 50th place race) | |
| V2.4.1 | 2 | Anti-automation on costly or abusable functions | Met | `apps/api/test/players/sign-in.int.test.ts` "allows 5 codes an hour per contact, then 429 with retry-after (first and resent alike)"; `apps/api/test/completions/complete.int.test.ts` "counts a burst of parallel guesses exactly: never more than the limit gets through"; `apps/api/test/players/sign-in-rush.int.test.ts` "sends exactly the cap of 200 parallel code requests, SMS and email" | |

## V3 Web Frontend Security

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V3.2.1 | 1 | Content not rendered in the wrong context | Met | API answers are `application/json`; the data export is an attachment with `nosniff`: `apps/api/test/players/data-export.int.test.ts` "downloads the file as an attachment nothing keeps, three times a day" | |
| V3.2.2 | 1 | Text drawn with safe text functions | Met | `docs/SECURITY.md` "Home blocks written by the organizer" (drawn as text, nothing tappable inside) | |
| V3.3.1 | 1 | Cookies `Secure`, with `__Host-` or `__Secure-` | Met | `apps/api/test/auth/sign-in.int.test.ts` "sets a __Host- cookie that is HttpOnly, Secure, SameSite=Strict, Path=/ and has no Domain"; `apps/api/test/devices/routes.int.test.ts` "answers a pairing request with its code and an HttpOnly __Host- cookie, no-store"; `apps/web/src/lib/language.test.ts` "remembers the language for a year under the __Host- prefix: site-wide, secure, no Domain, readable by the page" | |
| V3.3.2 | 2 | `SameSite` set by purpose | Met | Same sign-in test (`Strict`); the language cookie is `Lax` | |
| V3.3.3 | 2 | `__Host-` unless shared on purpose | Met | As V3.3.1; `apps/web/src/proxy.test.ts` "moves a choice from the old cookie to the new one on the next page" | |
| V3.3.4 | 2 | `HttpOnly` on tokens; set only by `Set-Cookie` | Met | `apps/api/test/auth/sign-in.int.test.ts` "sets a __Host- cookie that is HttpOnly, Secure, SameSite=Strict, Path=/ and has no Domain" | |
| V3.4.1 | 1 | HSTS of at least a year, subdomains at L2 | Met | Pages: `apps/web/src/lib/security-headers.ts` `PAGE_HEADERS` (`max-age=31536000; includeSubDomains`); `apps/web/src/lib/security-headers.test.ts` "sends HSTS for a year with subdomains on every page, the kiosk pages included"; `/v1`: `apps/api/src/conventions.test.ts` "security headers (ADR-700)" › "are on %s", "are on an idempotent replay", "stay on the answer when the idempotency store fails inside its own onSend"; `apps/web/src/lib/forward.test.ts` "security headers (ADR-700)" › "keeps its own values when the API sends weaker ones", "puts them on its own 404, 413 and 502 too"; `apps/api/test/security/routes.int.test.ts` "gets the security headers on every public route and on a refusal of each guarded kind (ADR-700)" | |
| V3.4.2 | 1 | CORS origin fixed or allowlisted | Met | No `Access-Control-Allow-Origin` is ever sent; the browser reaches the API on the page's origin: `docs/API.md` "Conventions" (auth schemes); `apps/web/src/lib/forward.test.ts` "returns every set-cookie and only the allowed response headers" | |
| V3.4.3 | 2 | CSP with `object-src 'none'`, `base-uri 'none'`, nonces | Met | `apps/web/src/lib/security-headers.test.ts` "closes plugins, framing, base rewrites and foreign form targets"; `/v1`: `apps/api/src/conventions.test.ts` "security headers (ADR-700)" › "are on %s", "are on an idempotent replay", "stay on the answer when the idempotency store fails inside its own onSend"; `apps/web/src/lib/forward.test.ts` "security headers (ADR-700)" › "keeps its own values when the API sends weaker ones", "puts them on its own 404, 413 and 502 too"; `apps/api/test/security/routes.int.test.ts` "gets the security headers on every public route and on a refusal of each guarded kind (ADR-700)" | |
| V3.4.4 | 2 | `nosniff` on every response | Met | `apps/web/src/lib/security-headers.test.ts` "never lets a page be cached and turns off sniffing, referrers and device features"; `/v1`: `apps/api/src/conventions.test.ts` "security headers (ADR-700)" › "are on %s", "are on an idempotent replay", "stay on the answer when the idempotency store fails inside its own onSend"; `apps/web/src/lib/forward.test.ts` "security headers (ADR-700)" › "keeps its own values when the API sends weaker ones", "puts them on its own 404, 413 and 502 too"; `apps/api/test/security/routes.int.test.ts` "gets the security headers on every public route and on a refusal of each guarded kind (ADR-700)" | |
| V3.4.5 | 2 | Referrer policy | Met | Same test (`no-referrer`); the invitation and reset pages keep tokens in the fragment | |
| V3.4.6 | 2 | `frame-ancestors` on every response | Met | `apps/web/src/lib/security-headers.test.ts` "closes plugins, framing, base rewrites and foreign form targets"; `/v1`: `apps/api/src/conventions.test.ts` "security headers (ADR-700)" › "are on %s", "are on an idempotent replay", "stay on the answer when the idempotency store fails inside its own onSend"; `apps/web/src/lib/forward.test.ts` "security headers (ADR-700)" › "keeps its own values when the API sends weaker ones", "puts them on its own 404, 413 and 502 too"; `apps/api/test/security/routes.int.test.ts` "gets the security headers on every public route and on a refusal of each guarded kind (ADR-700)" | |
| V3.5.1 | 1 | CSRF defence without relying on preflight | Met | `apps/api/test/auth/sessions.int.test.ts` "refuses a state-changing cookie request without the dashboard's Origin"; `apps/api/test/organizers/paths.int.test.ts` "refuses a cookie request with no Origin, as every change from another site" | |
| V3.5.2 | 1 | No sensitive call without a preflight | Met | `apps/api/src/app.test.ts` "refuses a plain-text body, because only JSON reaches a handler"; the Origin check above | |
| V3.5.3 | 1 | No sensitive action on GET, HEAD or OPTIONS | Met | `docs/API.md` "Conventions" (Idempotency-Key on every unsafe action); `apps/api/src/conventions.test.ts` "is required on an unsafe route" | |
| V3.5.4 | 2 | Separate applications on separate hostnames | Partly | `docs/API.md` "Conventions": one web app serves the dashboard, the console, the event page, stations and the big screen | Gap 12, Q-663 |
| V3.5.5 | 2 | `postMessage` origin and syntax checked | N/A | Note: no `postMessage` listener in `apps/web/src` | Not used |
| V3.7.1 | 2 | Only supported client technologies | Met | CSP `object-src 'none'` (test above); no plugins | |
| V3.7.2 | 2 | Redirects to other hosts only from an allowlist | Met | The web redirects only to its own language paths (`apps/web/src/proxy.ts`); an organizer's link opens after the player sees the host and agrees: `docs/SECURITY.md` "Home blocks written by the organizer" | |

## V4 API and Web Service

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V4.1.1 | 1 | Matching `Content-Type` with charset | Met | `docs/API.md` "Conventions" (JSON, UTF-8; Fastify writes `application/json; charset=utf-8`); `apps/api/src/conventions.test.ts` "replays the status and content type of the first answer" | |
| V4.1.2 | 2 | Only browser endpoints redirect HTTP to HTTPS | Partly | The app refuses a plain-http API address in release (`docs/SECURITY.md` "Data protection", the app's session) | Gap 13: the API host's HTTP behaviour is CranL's, unchecked (Q-664) |
| V4.1.3 | 2 | Intermediary headers cannot be overridden | Met | `apps/api/src/app.test.ts` "takes the address the nearest proxy saw, ignoring what the client put in front of it"; `apps/api/test/auth/sign-in.int.test.ts` "ignores a spoofed X-Forwarded-For when choosing the address to count"; `apps/web/src/lib/forward.test.ts` "passes only the allowed request headers, the client address unchanged" | |
| V4.2.1 | 2 | No request smuggling | Partly | Node's HTTP parser; CranL's edge | Gap 22: untested; T-809 |
| V4.3.1, V4.3.2 | 2 | GraphQL limits; introspection off | N/A | | No GraphQL (2 controls) |
| V4.4.1 | 1 | WebSocket over TLS | N/A | `docs/API.md` "Live updates": polled, no stream built | No WebSocket |
| V4.4.2, V4.4.3, V4.4.4 | 2 | WebSocket origin check and session tokens | N/A | As V4.4.1 | No WebSocket (3 controls) |

## V5 File Handling

The core accepts no file. Prize codes arrive as lines in a JSON body (FR-510); photo uploads belong to submissions
(L1 scope).

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V5.1.1 | 2 | Documented file types and sizes per upload | N/A | | No upload in the core |
| V5.2.1 | 1 | Accept only sizes the server can process | Met | `apps/api/test/rewards/codes-routes.int.test.ts` "refuses an upload past 100 000 codes and keeps nothing of it"; `apps/api/test/auth/sign-in.int.test.ts` "rejects a body over 4 KB"; `apps/web/src/lib/forward.test.ts` "refuses a body above the cap before calling the API" | |
| V5.2.2 | 1 | Extension and content match | N/A | | No file accepted |
| V5.2.3 | 2 | Archive size and count checks | N/A | | No archive accepted |
| V5.3.1 | 1 | Uploaded files never executed | N/A | | No file stored |
| V5.3.2 | 1 | File paths never from user names | N/A | | No file path is built from input |
| V5.4.1 | 2 | Server-chosen `Content-Disposition` filename | Met | `apps/api/test/players/data-export.int.test.ts` "downloads the file as an attachment nothing keeps, three times a day" | |
| V5.4.2 | 2 | Served filenames encoded | Met | Same test; the names are a fixed word and a date (`apps/api/src/privacy/data-export.ts`) or a kind from an allowlist (`apps/api/src/analytics/routes.ts`) | |
| V5.4.3 | 2 | Antivirus on untrusted files | N/A | | The core serves no file from outside |

## V6 Authentication

Staff: email, password and an emailed code (ADR-078). Players: a one-time code by SMS or email (ADR-030). No external
identity provider.

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V6.1.1 | 1 | Brute-force and stuffing defences documented | Met | `docs/SECURITY.md` "Staff sign-in controls (T-006)" (V6 row) and "Top abuse cases" #4; `docs/RUNBOOK.md` "Staff sign-in", "Player sign-in and SMS (T-107)" | |
| V6.1.2 | 2 | Context-specific password words documented | Met | `docs/SECURITY.md` "Authentication" (the passwords bullet: product names and the email's name part) | |
| V6.1.3 | 2 | All pathways documented with their strength | Met | `docs/SECURITY.md` "Sign-in pathways and their strength" (23 pathways, each with its limits and test, and the access-kind rule that enforces them alike); `apps/api/src/route-access.test.ts`; `apps/api/test/security/routes.int.test.ts` | |
| V6.2.1 | 1 | Passwords of at least 8 (15 advised) | Met | `apps/api/src/auth/password.test.ts` "refuses 11 characters and accepts 12" | |
| V6.2.2 | 1 | Users can change their password | Met | `apps/api/test/auth/password-reset.int.test.ts` "keeps the current session, ends the others, and swaps the passwords" | |
| V6.2.3 | 1 | Change needs the current password | Met | `apps/api/test/auth/password-reset.int.test.ts` "refuses a wrong current password with 403 and counts it toward the sign-in lockout" | |
| V6.2.4 | 1 | Checked against the top 3,000 passwords | Met | The breached list covers it: `apps/api/test/auth/password-reset.int.test.ts` "refuses a breached new password and keeps the old one" | |
| V6.2.5 | 1 | No composition rules | Met | `apps/api/src/auth/password.test.ts` "asks for no mix of letters, digits or symbols" | |
| V6.2.6 | 1 | `type=password` fields | Met | Note: `apps/web/src/components/PasswordStep.tsx`, `apps/web/src/components/EmailChangeForms.tsx` | |
| V6.2.7 | 1 | Paste and password managers allowed | Met | Note: no `onPaste` handler in `apps/web/src` or `apps/app/src` | |
| V6.2.8 | 1 | Verified as typed, no truncation or case change | Met | `apps/api/src/auth/password.test.ts` "treats Arabic and emoji passwords as typed, and NFKC-equal forms as the same" (NFKC only, as NIST SP 800-63B allows); `apps/api/test/auth/sign-in.int.test.ts` "answers 401 for a password over 128 characters without touching the throttle" (refused, never cut) | |
| V6.2.9 | 2 | At least 64 characters allowed | Met | `apps/api/src/auth/password.test.ts` "accepts 128 characters and refuses 129" | |
| V6.2.10 | 2 | No forced periodic rotation | Met | Note: no password age is stored or checked (`staff_user`, migration 0002) | |
| V6.2.11 | 2 | Context words refused | Met | `apps/api/src/auth/password.test.ts` "refuses a password that contains the product or company name, in any letter case", "refuses a password that contains the email's name part once it has four characters" | |
| V6.2.12 | 2 | Breached passwords refused | Met | `apps/api/test/auth/password-reset.int.test.ts` "refuses a breached new password and keeps the old one"; `apps/api/src/auth/breached.test.ts` "sends only the first five hex characters of the SHA-1, with padding asked for" | |
| V6.3.1 | 1 | Stuffing and brute-force controls in place | Met | `apps/api/test/auth/sign-in.int.test.ts` "blocks the ninth password attempt for an email, for an unknown email just the same", "blocks a whole address after 30 failures, whatever emails it tries"; `apps/api/test/players/sign-in.int.test.ts` "stops wrong codes for a contact after 10 in 15 minutes, across codes" | |
| V6.3.2 | 1 | No default accounts | Met | Accounts come only from sign-up, invites and `staff.cjs create` (`docs/RUNBOOK.md` "Staff sign-in"); `apps/api/test/auth/staff-admin.int.test.ts` "create grants no role" | |
| V6.3.3 | 2 | Multi-factor, or a documented combination | Met | Staff: `apps/api/test/auth/sign-in.int.test.ts` "opens a session only after the password and then the emailed code"; players: one factor as a written exception with its compensating controls, `docs/SECURITY.md` "Authentication" ("Player sign-in: one factor, accepted for v1", Q-662) | |
| V6.3.4 | 2 | No undocumented pathways; same strength across them | Met | `apps/api/test/security/routes.int.test.ts` "has exactly these public routes and nothing else open"; `apps/api/src/route-access.test.ts` "stops the server from starting when a route does not say who may call it" | |
| V6.4.1 | 1 | Initial secrets random, short-lived, never long-term | Partly | Invites last 7 days and are used once: `apps/api/test/organizers/team.int.test.ts` "lets only the invited account accept it, once"; the invitee sets their own password. `staff.cjs create` pipes a random password nobody sees and the person resets it by email (RUNBOOK "Staff sign-in"); the code does not force it | Gap 18: `staff.cjs create` |
| V6.4.2 | 1 | No hints or secret questions | Met | Note: none exist (`docs/SECURITY.md` "Authentication") | |
| V6.4.3 | 2 | Reset does not bypass the second factor | Met | The reset ends every session; the next sign-in needs the password and the code: `apps/api/test/auth/password-reset.int.test.ts` "ends every session the person had" | |
| V6.4.4 | 2 | Lost factor: identity proofed as at enrolment | Met | `docs/RUNBOOK.md` "Lost mailbox or lost number: proving who is asking" (staff by role, players); owner email change by an admin records how identity was checked: `docs/SECURITY.md` "Owner email change and the team alert", `apps/api/test/console/owner-email.int.test.ts` | Gap 18 (steps written 2026-11-06) |
| V6.5.1 | 2 | One-time codes usable once | Met | `apps/api/test/auth/sign-in.int.test.ts` "does not accept the same code twice", "makes one session when the right code is sent twice at once"; `apps/api/test/db/player-sign-in.int.test.ts` "signs in a returning player and uses the challenge up" | |
| V6.5.2 | 2 | Weak lookup secrets hashed with a password hash | N/A | | No lookup secrets (backup codes); sign-in codes are out-of-band codes, stored as a keyed HMAC (`apps/api/src/auth/keys.test.ts` "binds a code to its challenge and to its digits") |
| V6.5.3 | 2 | Codes from a CSPRNG | Met | `apps/api/src/auth/keys.test.ts` "is always six Western digits, including leading zeros", "uses the whole range" (`crypto.randomInt`) | |
| V6.5.4 | 2 | Codes of at least 20 bits | Met | Same test (6 digits) | |
| V6.5.5 | 2 | Out-of-band codes live at most 10 minutes | Met | `apps/api/test/db/player-sign-in.int.test.ts` "ends after five minutes"; `apps/api/test/auth/sign-in.int.test.ts` "accepts the code until the moment it expires and not after" (5 minutes, `codeLifetimeSeconds: 300`) | |
| V6.6.1 | 2 | SMS only for a validated number, with a stronger option and a risk notice | Met | The number is the one the code proves; email is always offered (`apps/api/test/players/sign-in.int.test.ts` "texts a Saudi mobile, in Arabic by default, and says when to resend and when to offer email"); the one-factor exception is written (`docs/SECURITY.md` "Authentication", Q-662); the code screens say never to share the code and that Questify never asks for it (`apps/app/src/auth/code-notice.test.ts` "tells the person in both languages never to share the code, because Questify never asks for it" and "is shown on the code step of %s"; `apps/web/e2e/sign-in.spec.ts` "signs in and out in Arabic, right to left, without sideways scrolling" and "in English: a wrong password, a wrong code with attempts left, then in, and the language switch") | |
| V6.6.2 | 2 | Codes bound to their own request | Met | `apps/api/src/auth/keys.test.ts` "binds a code to its challenge and to its digits"; `apps/api/test/db/player-sign-in.int.test.ts` "ends when a new code is asked for the same contact (one live code per contact)" | |
| V6.6.3 | 2 | Code mechanism rate limited | Met | `apps/api/test/db/player-sign-in.int.test.ts` "counts parallel wrong guesses one after the other: never more than three"; `apps/api/test/auth/sign-in.int.test.ts` "lets only five of many parallel wrong guesses count" | |
| V6.8.1, V6.8.2, V6.8.3, V6.8.4 | 2 | Identity providers: no spoofing, signed assertions, SAML replay, strength claims | N/A | | No identity provider (4 controls) |

## V7 Session Management

Staff: a 256-bit cookie session, idle 30 minutes and at most 12 hours (admins 15 minutes and 8 hours). Players: a
1-hour access token and a 180-day refresh token rotated on every use, one family per device, at most 10.

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V7.1.1 | 2 | Idle and absolute limits documented and justified against NIST | Met | `docs/SECURITY.md` "Staff sign-in controls (T-006)" (V7 row), "Points ledger and completions (T-105)" (V3 sessions row); players: `docs/SECURITY.md` "Authentication" ("Player sessions end 365 days after the sign-in", the NIST deviation written) | |
| V7.1.2 | 2 | Concurrent sessions per account documented | Met | `apps/api/test/auth/sessions.int.test.ts` "keeps at most ten live sessions, ending the oldest when an eleventh opens"; `apps/api/test/db/player-sign-in.int.test.ts` "keeps at most 10 devices: the oldest is signed out" | |
| V7.1.3 | 2 | Federated session systems documented | N/A | | No SSO or federation |
| V7.2.1 | 1 | Tokens verified by a trusted backend | Met | `apps/api/test/auth/sessions.int.test.ts` "says 'valid' with the account, and 'expired' for a revoked or stale session"; `apps/api/test/db/completion-engine.int.test.ts` "answers the player for a live session only, of an active player" | |
| V7.2.2 | 1 | Dynamic tokens, not static keys | Met | `apps/api/test/auth/sign-in.int.test.ts` "stores the session by hash, never the token itself" | |
| V7.2.3 | 1 | Reference tokens from a CSPRNG, 128 bits or more | Met | `apps/api/src/auth/keys.test.ts` "makes a 256-bit URL-safe token whose hash is its SHA-256", "never repeats" | |
| V7.2.4 | 1 | New token at every authentication | Met | `apps/api/test/players/sign-in.int.test.ts` "rotate on refresh: the new pair works, the old access token ends"; `apps/api/test/auth/sign-in.int.test.ts` "replaces the earlier challenge when a new password step succeeds" | |
| V7.3.1 | 2 | Inactivity timeout | Met | `apps/api/test/auth/sessions.int.test.ts` "accepts a session just under the idle limit and ends one just over it", "gives platform admins shorter limits"; players: the refresh token ends after 180 unused days (migration 0013) | |
| V7.3.2 | 2 | Absolute maximum lifetime | Met | Staff: `apps/api/test/auth/sessions.int.test.ts` "ends a session after its maximum age even if it was used a moment ago"; players: `apps/api/test/db/player-sign-in.int.test.ts` "a family ends 365 days after its sign-in (T-810b, migration 0154)" › "ends a rotation 300 days in at the family's 365th day, and keeps the start", "answers invalid once the family has ended, and its access token is over"; `apps/api/test/players/sign-in.int.test.ts` "answer 401 invalid to a refresh 365 days after the sign-in (T-810b, migration 0154)" | |
| V7.4.1 | 1 | Terminated sessions cannot be used | Met | `apps/api/test/auth/sessions.int.test.ts` "signs out: the session ends, the cookie is cleared, and the cookie no longer works"; `apps/api/test/players/sign-in.int.test.ts` "end on sign-out by the refresh token, even with an expired access token; always 204" | |
| V7.4.2 | 1 | Disabling or deleting an account ends its sessions | Met | `apps/api/test/auth/sessions.int.test.ts` "ends the session of an account that was disabled"; `apps/api/test/db/player-sign-in.int.test.ts` "end, with the family, for a player who is no longer active"; `apps/api/test/db/account-deletion.int.test.ts` "cannot sign in, refresh, or be found by name, and a repeat of the token answers replayed" | |
| V7.4.3 | 2 | Offer to end other sessions after a factor changes | Met | Staff: `apps/api/test/auth/password-reset.int.test.ts` "ends every session the person had", "keeps the current session, ends the others, and swaps the passwords" (now through `set_staff_password`, 0155); players: after a phone or email change the app offers "Sign them out" (`apps/app/app/account.tsx`) with no second code, because the contact code made this family fresh: `apps/api/test/db/signed-in-devices.int.test.ts` "a contact change on this family makes it fresh" | T-810c |
| V7.4.4 | 2 | Visible logout on every signed-in page | Met | `apps/web/e2e/navigation.spec.ts` "the top bar shows the logo, with the language switch and Sign out as named icons"; app: `apps/app/src/auth/player-state.test.ts` "removes the device first, then signs out and clears the player's keys" | |
| V7.4.5 | 2 | Admins can end one user's or everyone's sessions | Met | One staff account: `apps/api/test/console/platform.int.test.ts` "ends a member's sessions at once with a reason, audited with the count" and `apps/api/test/db/signed-in-devices.int.test.ts` "the console ends every session of one staff account"; one player: the sign-in reset, `apps/api/test/console/players.int.test.ts` "resets sign-in: ends the tokens"; everyone at once: the RUNBOOK incident procedure "Ending every session at once" | T-810c, ADR-713 |
| V7.5.1 | 2 | Re-authenticate before changing recovery attributes | Partly | Staff owner email: the current password or a 24-hour hold that applies only with a recorded notice to the old address, `docs/SECURITY.md` "Owner email change and the team alert"; `apps/api/test/db/owner-email-change.int.test.ts`, `apps/api/test/db/owner-email-hold.int.test.ts` | Gap 20: player contact change (ADR-120) |
| V7.5.2 | 2 | Users view and end their sessions, after re-authenticating | Met | Staff: `apps/api/test/auth/sessions.int.test.ts` "asks a session older than 10 minutes for an emailed code, then ends the others"; players: `apps/api/test/players/devices.int.test.ts` "asks a stale sign-in for a fresh code, then ends the others"; checked in the database: `apps/api/test/db/signed-in-devices.int.test.ts` "ends another device when fresh", "the API role cannot end, open or freshen a session itself" | T-810c, ADR-711, Q-680 |
| V7.6.1, V7.6.2 | 2 | Federated re-authentication and consent to new sessions | N/A | | No identity provider (2 controls) |

## V8 Authorization

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V8.1.1 | 1 | Function and data access rules documented | Met | `docs/SECURITY.md` "Who can do what"; `apps/api/test/security/routes.int.test.ts` "lists each route with how it keeps callers apart" | |
| V8.1.2 | 2 | Field-level rules documented | Met | `docs/rules.md` "Structure" (a column that holds money, standing or power gets a column grant or guard trigger); `docs/SECURITY.md` "Admin power narrowed (T-701, ADR-405)" | |
| V8.2.1 | 1 | Function access only with explicit permission | Met | `apps/api/test/security/routes.int.test.ts` "keeps every /v1/admin/ route admin-only and answers any other signed-in person 404", "refuses an editor every owner route with 403"; `apps/api/test/db/group-push.int.test.ts` "refuses everyone but an active platform admin, and the fan door to everyone but the system seat" | |
| V8.2.2 | 1 | Object access only with permission (IDOR, BOLA) | Met | `apps/api/test/security/cross-tenant.int.test.ts` "shows A none of B's rows, apart from what is public by design"; `apps/api/test/security/routes.int.test.ts` "cannot end B's session: 404 like a missing one, and B stays signed in"; `apps/api/test/desk/desk.int.test.ts` "refuses Collect on someone else's, an ended or an overdue reservation" | |
| V8.2.3 | 2 | Field access only with permission (BOPLA) | Met | `apps/api/test/db/core-columns.int.test.ts` "cannot be set by the organizer or an admin either: only the points ledger may move them"; `apps/api/test/db/admin-role.int.test.ts` "gives the API role exactly SELECT and UPDATE (password_hash) on staff_user", "refuses a platform_role or status write from every API context" | |
| V8.3.1 | 1 | Authorization at a trusted layer | Met | `apps/api/test/db/completion-engine.int.test.ts` "needs a player in the request: none, nothing", "is written by the function only: the API's role inserts nothing itself"; `apps/api/test/db/support-grant.int.test.ts` "opens nothing once expired, or when the admin is disabled or no longer an admin" | |
| V8.4.1 | 2 | Cross-tenant controls | Met | `apps/api/test/security/cross-tenant.int.test.ts` "classifies every table as owned (tested here) or shared (with a reason)", "lets A change none of B's rows it can see, through any column it may update"; `apps/api/test/security/outsider.int.test.ts` "has row-level security forced on every table"; `apps/api/test/db/isolation.int.test.ts` "refuses moving an own event to another organizer: the column is not writable at all" | |

## V9 Self-contained Tokens

The signed QR and NFC proofs (quest codes, My QR, step, secret, tag, screen and live codes) and the opt-out link are
self-contained tokens under HMAC-SHA256.

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V9.1.1 | 1 | Signature or MAC checked before use | Met | `apps/api/src/quests/qr.test.ts` "refuses a code with any single byte changed, wherever it is", "refuses a code signed with another key" | |
| V9.1.2 | 1 | Algorithm allowlist, never `none` | Met | One fixed algorithm with no algorithm field: `apps/api/src/quests/qr.test.ts` "refuses a code of another layout" | |
| V9.1.3 | 1 | Keys only from trusted configuration | Met | `apps/api/src/quests/qr.test.ts` "refuses a secret under 32 characters", "differs from a key made for any other purpose of the same secret" | |
| V9.2.1 | 1 | Validity window enforced | Met | `apps/api/src/quests/qr.test.ts` "opens to its quest and window, 50 characters of format 0x07"; windows judged on the database clock: `docs/SECURITY.md` "Kiosks and the live code" (V11 row) and `apps/api/test/db/kiosks.int.test.ts` | |
| V9.2.2 | 2 | Token type and purpose checked | Met | `apps/api/src/quests/qr.test.ts` "never opens a code of one purpose as another, even under the same secret" | |
| V9.2.3 | 2 | Audience checked | Met | `apps/api/src/quests/qr.test.ts` "refuses a real code used on another quest", "refuses a real code of another step" | |
| V9.2.4 | 2 | One key across audiences: audience in the token | Met | Each purpose has its own derived key (`apps/api/src/quests/qr.test.ts` "differs from a key made for any other purpose of the same secret") | |

## V10 OAuth and OIDC

All N/A: Questify is neither an OAuth client of users' accounts, an authorization server, a resource server for
third-party tokens nor an OpenID provider. The one OAuth exchange is the API's own service-account grant to Google
for FCM and Gmail (`apps/api/src/auth/google-token.test.ts`), which carries no user's delegation.

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V10.1.1, V10.1.2 | 2 | Tokens only where needed; flow bound to the user agent | N/A | | No user-facing OAuth (2) |
| V10.2.1, V10.2.2 | 2 | OAuth client CSRF and mix-up defences | N/A | | No OAuth client of users (2) |
| V10.3.1, V10.3.2, V10.3.3, V10.3.4 | 2 | Resource server audience, claims, subject, strength | N/A | | No third-party access tokens (4) |
| V10.4.1, V10.4.2, V10.4.3, V10.4.4, V10.4.5 | 1 | Authorization server: redirect URIs, code reuse and lifetime, grants, refresh replay | N/A | | No authorization server (5) |
| V10.4.6, V10.4.7, V10.4.8, V10.4.9, V10.4.10, V10.4.11 | 2 | Authorization server: PKCE, registration, refresh expiry and revocation, client auth, scopes | N/A | | No authorization server (6) |
| V10.5.1, V10.5.2, V10.5.3, V10.5.4, V10.5.5 | 2 | OIDC client: nonce, subject, issuer, audience, back-channel logout | N/A | | No OIDC (5) |
| V10.6.1, V10.6.2 | 2 | OpenID provider response modes and forced logout | N/A | | No OpenID provider (2) |
| V10.7.1, V10.7.2, V10.7.3 | 2 | Consent management | N/A | | No authorization server (3) |

## V11 Cryptography

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V11.1.1 | 2 | Key-management policy and lifecycle | Partly | `docs/SECURITY.md` "Cryptographic inventory and key policy" (the six-point policy: generation, storage, separation, use, rotation, retirement) and "Secrets policy"; `docs/RUNBOOK.md` "Staff sign-in" (rotating `AUTH_SECRET`, `QR_SECRET`, `REWARD_CODE_SECRET`) | Gap 15, Q-700 |
| V11.1.2 | 2 | Cryptographic inventory | Met | `docs/SECURITY.md` "Cryptographic inventory and key policy": every key, algorithm, use, what it may not be used for, holder and rotation, read from `apps/api/src` and `ops/cranl/*.json`; Questify holds no certificate (TLS is CranL's, Q-664) | |
| V11.2.1 | 2 | Industry-validated implementations | Met | Node's `crypto` and the `argon2` library only: `apps/api/src/auth/password.test.ts` "round-trips and uses argon2id with the current parameters" | |
| V11.2.2 | 2 | Crypto agility: algorithms and keys replaceable | Met | `apps/api/test/auth/sign-in.int.test.ts` "upgrades an old password hash to the current parameters after a good sign-in"; codes carry a format byte (`apps/api/src/quests/qr.test.ts` "opens a tag's token to its id and version, 50 characters of format 0x06"); reward codes carry a key id and are re-sealed (`apps/api/test/rewards/reseal.int.test.ts` "re-seals every code after a rotation so each reveals with the new key alone, then does nothing") | Gap 8 closed (T-810f) |
| V11.2.3 | 2 | At least 128 bits of security | Met | `apps/api/src/auth/keys.test.ts` "gives 32-byte keys that are stable for the same input"; AES-256-GCM and a 128-bit QR tag (`docs/SECURITY.md` T-006 V11 row) | |
| V11.3.1 | 1 | No ECB, no weak padding | Met | AES-256-GCM only: `apps/api/src/rewards/codes.test.ts` "never seals one code twice the same way" | |
| V11.3.2 | 1 | Approved ciphers and modes | Met | Same file, "opens to the same code for the same reward" | |
| V11.3.3 | 2 | Authenticated encryption | Met | `apps/api/src/rewards/codes.test.ts` "does not open for another reward, another key, or a changed byte" | |
| V11.4.1 | 1 | Approved hash functions only | Met | SHA-256 and HMAC-SHA-256 (`apps/api/src/auth/keys.test.ts` "hashes a known value the standard way"); SHA-1 appears only as the Pwned Passwords range prefix, which protects nothing (`apps/api/src/auth/breached.test.ts` "sends only the first five hex characters of the SHA-1, with padding asked for") | |
| V11.4.2 | 2 | Passwords under a slow password hash | Met | argon2id, 19 MiB, 2 passes, 1 lane: `apps/api/src/auth/password.test.ts` "round-trips and uses argon2id with the current parameters", "salts every hash" | |
| V11.4.3 | 2 | Collision-resistant hashes, 256-bit output | Met | `apps/api/src/auth/keys.test.ts` "makes a 256-bit URL-safe token whose hash is its SHA-256" | |
| V11.4.4 | 2 | Key derivation from passwords with stretching | N/A | | No key is derived from a password; keys come from 32-character secrets by HMAC and HKDF |
| V11.5.1 | 2 | Non-guessable values: CSPRNG, 128 bits | Met | `apps/api/src/auth/keys.test.ts` "makes a 256-bit URL-safe token whose hash is its SHA-256"; meet codes 128 bits (`docs/SECURITY.md` "Data protection"); invitation links: `apps/api/test/db/invitation-sending.int.test.ts` "gives a new row a link of 128 random bits, not a version 4 UUID (T-810b, migration 0153)" | |
| V11.6.1 | 2 | Approved public-key algorithms | Met | APNs ES256 and Google RS256 with the providers' keys: `apps/api/src/auth/google-token.test.ts` "refuses to sign with a key that cannot, before any request"; `apps/api/src/config.test.ts` (push providers) | Wallet signing: T-801 |

## V12 Secure Communication

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V12.1.1 | 1 | Only TLS 1.2 and 1.3, 1.3 preferred | Partly | TLS ends at CranL's edge | Gap 13: versions unchecked (Q-664) |
| V12.1.2 | 2 | Recommended cipher suites only | Partly | As V12.1.1 | Gap 13 |
| V12.1.3 | 2 | mTLS client certificates validated | N/A | | No mTLS |
| V12.2.1 | 1 | TLS for every external HTTP service, no fallback | Met | The app refuses a plain-http API address in release (`docs/SECURITY.md` "Data protection", the app's session); every outbound address is `https://` (Note: `apps/api/src`) | |
| V12.2.2 | 1 | Publicly trusted certificates | Partly | CranL-issued certificates | Gap 13: unchecked (Q-664) |
| V12.3.1 | 2 | TLS on every inbound and outbound connection | Partly | Providers over HTTPS; `REDIS_URL` accepts `rediss://` (`apps/api/src/config.ts`) | Gap 13: PostgreSQL and Redis TLS not required (Q-664) |
| V12.3.2 | 2 | TLS clients validate certificates | Met | Note: no `rejectUnauthorized: false` anywhere; `docs/RUNBOOK.md` "Push notifications" (both Apple hosts probed over TLS) | |
| V12.3.3 | 2 | TLS between internal HTTP services | Partly | The web forwarder reaches the API over CranL's private network (`docs/API.md` "Conventions") | Gap 13 (Q-664) |
| V12.3.4 | 2 | Internal certificates trusted only from known CAs | Partly | As V12.3.3 | Gap 13 (Q-664) |

## V13 Configuration

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V13.1.1 | 2 | All communication needs documented | Met | `docs/INTEGRATIONS.md`; `docs/SECURITY.md` "Data protection" (the residency exceptions) | |
| V13.2.1 | 2 | Backend components authenticate without static credentials | Partly | PostgreSQL and Redis take a password in their URLs | Gap 13 (Q-664) |
| V13.2.2 | 2 | Least privilege between components | Met | `apps/api/test/security/outsider.int.test.ts` "makes the app role neither a superuser nor able to skip row-level security"; `apps/api/test/db/player-sign-in.int.test.ts` "refuses temporary tables to the API's role and to outsiders" | |
| V13.2.3 | 2 | No default service credentials | Met | `apps/api/src/auth/keys.test.ts` "refuses a short secret"; `apps/api/src/rewards/codes.test.ts` "refuses a secret shorter than 32 characters"; `docs/RUNBOOK.md` "Staff sign-in" (the app refuses to start without its settings) | |
| V13.2.4 | 2 | Allowlist of outside systems | Partly | Outbound hosts are constants in code (V1.3.6) | Gap 13: no network-level allowlist (Q-664) |
| V13.2.5 | 2 | Server configured with that allowlist | Partly | As V13.2.4 | Gap 13 (Q-664) |
| V13.3.1 | 2 | Secrets in a secrets manager, never in source or builds | Partly | CI "Secret scan (gitleaks 8.30.1)"; `.dockerignore` keeps the .env files out of images; values come from CranL's settings (`docs/SECURITY.md` "Secrets policy") | Gap 13: no vault with its own access log (Q-664) |
| V13.3.2 | 2 | Least privilege on secrets | Partly | `docs/SECURITY.md` "Secrets policy" | Gap 13 (Q-664) |
| V13.4.1 | 1 | No source control metadata deployed | Met | `.dockerignore` (`.git`, `.github`) | |
| V13.4.2 | 2 | Debug modes off in production | Met | `apps/api/src/app.test.ts` "is quieter in production than in development"; `apps/web/src/lib/security-headers.test.ts` "adds what hot reload needs only in development" | |
| V13.4.3 | 2 | No directory listings | Met | `apps/api/test/security/routes.int.test.ts` "has exactly these public routes and nothing else open" (no static file route) | |
| V13.4.4 | 2 | No HTTP TRACE | Met | Same test: no route answers TRACE | |
| V13.4.5 | 2 | Documentation and monitoring endpoints not exposed | Met | Same test; `apps/api/src/app.test.ts` "answers /healthz with the running build" (the release only) | |

## V14 Data Protection

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V14.1.1 | 2 | Sensitive data identified and classified | Met | `apps/api/test/db/personal-data-catalog.int.test.ts` "classifies exactly the tables that can hold a row about a player"; `docs/SECURITY.md` "Assets worth protecting" | |
| V14.1.2 | 2 | Protection requirements per level documented | Partly | `docs/SECURITY.md` "Data protection"; `docs/rules.md` hard rule 3 | Gap 21: retention waits for counsel (Q-075) |
| V14.2.1 | 1 | No sensitive data in URLs | Met | `apps/api/test/auth/password-reset.int.test.ts` "links to the reset page in the asked language, holding the token in the fragment"; `docs/SECURITY.md` "Questify invitations" (the link token in the fragment) | |
| V14.2.2 | 2 | Sensitive data not cached in server components | Met | `apps/api/test/security/routes.int.test.ts` "answers 401 with no-store on every staff route"; the idempotency store is per-process memory (`docs/SECURITY.md` "Top abuse cases" #10) | |
| V14.2.3 | 2 | No sensitive data to trackers | Met | `docs/SECURITY.md` "Data protection" (no ad networks or tracking SDKs); `apps/api/src/telemetry/pii.test.ts` "holds no personal data after requests, refusals and failures carrying some" | |
| V14.2.4 | 2 | Protection controls applied per level | Partly | `apps/api/src/full-name-guard.test.ts` "never puts a full name in a log line, a push or an audit entry"; `apps/api/test/db/account-deletion.int.test.ts` "clears everything personal and keeps the records, naming no one" | Gap 21 (Q-075) |
| V14.3.1 | 1 | Client data cleared at sign-out | Met | `apps/app/src/auth/player-state.test.ts` "cannot restore an account's private profile after sign-out completes", "clears private data immediately and ignores reloads while logout is pending" | |
| V14.3.2 | 2 | `Cache-Control: no-store` on sensitive answers | Met | `apps/web/src/lib/security-headers.test.ts` "never lets a page be cached and turns off sniffing, referrers and device features"; `apps/api/test/security/routes.int.test.ts` "answers 401 with no-store on every staff route" | |
| V14.3.3 | 2 | No sensitive data in browser storage | Met | Note: the web uses `localStorage` only for the kiosk's camera choice (`apps/web/src/components/KioskScanner.tsx`); the app keeps tokens in the keychain or keystore (`docs/SECURITY.md` "Data protection", the app's session) | |

## V15 Secure Coding and Architecture

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V15.1.1 | 1 | Remediation time frames for vulnerable components documented | Met | `docs/QUALITY_BASELINE.md` §2, "Fixing a vulnerable dependency" (critical 7 days, high 14, moderate 30, the rest monthly); `.github/dependabot.yml` (monthly, 7-day cooldown) | |
| V15.1.2 | 2 | SBOM maintained, trusted sources | Met | `package.json` script `sbom:generate`; `pnpm install --frozen-lockfile` in CI; `.github/workflows/sbom.yml` keeps `sbom.cdx.json` on each `release-*` tag's GitHub Release (`docs/RUNBOOK.md` "Database and deploy", ADR-704); releases before 2026-11-05 have none | |
| V15.1.3 | 2 | Resource-heavy functions documented with defences | Met | `docs/SLO.md` "1. Targets"; `docs/SECURITY.md` "Top abuse cases" #4; `docs/TASKS.md` T-804 (the load test) | |
| V15.2.1 | 1 | Components within their remediation time frames | Met | CI "Dependency audit" (`pnpm audit`) on every pull request fails on a finding not listed in `auditConfig.ignoreGhsas` (`pnpm-workspace.yaml`); each listed one has a dated reason and is re-checked monthly (`docs/QUALITY_BASELINE.md` §2) | |
| V15.2.2 | 2 | Defences against resource exhaustion | Met | `apps/api/src/auth/verify-gate.test.ts` "never runs more than the limit at once"; `apps/api/test/auth/edges.int.test.ts` "answers busy and gives back the reserved attempt" | |
| V15.2.3 | 2 | No test or sample code in production | Met | CI "API build (the bundle the Docker image ships)"; `.dockerignore` (the test server bundle, coverage, docs) | |
| V15.3.1 | 1 | Only the needed fields returned | Met | `apps/api/test/security/routes.int.test.ts` "shows the team to its members, owner first, with emails and no other account fields"; `packages/shared/src/questify/ranking.test.ts` "refuses a row with an extra key (an id, gems), more than 10 rows, or a row without XP" | |
| V15.3.2 | 2 | Outbound calls do not follow redirects | Met | `apps/api/src/outbound-redirect.test.ts` 'passes redirect: "error" on every one'; `apps/api/src/outbound-redirect.outsider.test.ts` "a provider that answers with a redirect" (each client fails and the second server sees nothing); the APNs and FCM sends use the HTTP/2 client, which never follows one | |
| V15.3.3 | 2 | Mass-assignment defences | Met | `packages/shared/src/sessions/sessions.test.ts` "refuses an unknown field, a price and a control character"; `apps/api/test/db/isolation.int.test.ts` "refuses moving an own event to another organizer: the column is not writable at all" | |
| V15.3.4 | 2 | Client IP from trusted proxy fields only | Met | `apps/api/src/app.test.ts` "takes the address the nearest proxy saw, ignoring what the client put in front of it", "trusts no header at all when no proxy is configured" | |
| V15.3.5 | 2 | Strict types and comparisons | Met | CI "Lint, format, types, tests" (`pnpm ci:changed`: strict `tsc`, oxlint); `apps/api/src/auth/keys.test.ts` "treats different lengths as not equal instead of throwing" | |
| V15.3.6 | 2 | No prototype pollution | Met | Fastify's JSON parser refuses `__proto__` by default (`createServer` in `apps/api/src/app.ts` keeps it); `apps/api/src/app.test.ts` "refuses a body with %s before any handler or database work", "pins the poisoning options, so a framework default change cannot loosen them"; `apps/api/test/security/routes.int.test.ts` "refuses a poisoned body or a bad query before writing any throttle row (V15.3.6)" | |
| V15.3.7 | 2 | No HTTP parameter pollution | Met | Strict schemas refuse an array where one value is expected; `apps/api/src/app.test.ts` "refuses a repeated query key where the schema takes one value" | |

## V16 Security Logging and Error Handling

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V16.1.1 | 2 | Log inventory | Partly | `docs/SLO.md` "6. Log inventory: every layer" (each layer, its events, format, store, readers and retention); sections 3 and 4 | Gap 16: retention is not set for CranL's logs (Q-443) and the audit log has no period (Q-084) |
| V16.2.1 | 2 | When, where, who, what in each entry | Met | `apps/api/test/auth/edges.int.test.ts` "names every event with its fields and a keyed address tag"; `apps/api/test/audit/audit.int.test.ts` "does not let the API choose the time or the number of an entry" | |
| V16.2.2 | 2 | Synchronised clocks, UTC | Met | Log lines carry pino's epoch-millisecond `time` (UTC); audit times are set by the database (same audit test) | |
| V16.2.3 | 2 | Logs only to documented destinations | Met | Standard output only (`docs/QUALITY_BASELINE.md` §4); `apps/api/src/telemetry/pii.test.ts` "uses only attribute keys on the list, on every span and every metric point" | |
| V16.2.4 | 2 | A common, machine-readable format | Met | JSON lines (pino); `apps/api/src/app.test.ts` "logs a request as method and path only, never the client address" | |
| V16.2.5 | 2 | Sensitive data logged by its protection level | Met | `apps/api/src/app.test.ts` "removes credentials, session cookies and idempotency keys from every log line"; `apps/api/test/players/sign-in.int.test.ts` "never writes a phone, an email, a code or a token to the log"; `apps/api/test/rewards/codes-routes.int.test.ts` "shows the player their code at once and in history, never in a log" | |
| V16.3.1 | 2 | Every authentication, success and failure, logged | Met | `apps/api/test/auth/sessions.int.test.ts` "records the sign-in events with the request id, and none of the secrets or addresses"; `apps/api/test/players/flow.int.test.ts` "logs a wrong code, and nothing for an expired challenge", "logs the new player and a returning sign-in with the player id" | |
| V16.3.2 | 2 | Failed authorization logged | Met | The access log line (method, route, status, request id); `apps/api/src/conventions.test.ts` "the authz.denied line (ADR-703)" › "logs a 403 and a hidden 404 once each, and a plain 404 not at all"; `apps/api/test/security/routes.int.test.ts` "writes exactly one authz.denied line, with B's id and the route pattern, for every organizer-A and console route" | A 404 that row-level security hides inside the database is not logged (Q-671) |
| V16.3.3 | 2 | Security events and bypass attempts logged | Met | `apps/api/test/auth/edges.int.test.ts` "logs each kind of throttle with the step that hit it"; `apps/api/test/db/player-sign-in.int.test.ts` "treat a reuse after the successor was used, or after 60 seconds, as theft: the family ends, audited"; `docs/RUNBOOK.md` "Staff sign-in" (`quest.refused` reasons) | |
| V16.3.4 | 2 | Unexpected errors and control failures logged | Met | `apps/api/src/conventions.test.ts` "logs an unexpected error without the player's input"; `apps/api/test/auth/password-reset-paths.int.test.ts` "logs the breach check being down, and fails loudly on any other breach-check error" | |
| V16.4.1 | 2 | Log injection prevented | Met | JSON encoding of every field; `apps/api/src/app.test.ts` "writes a path no route answers as `unmatched`, since a caller can type anything there (T-018)" | |
| V16.4.2 | 2 | Logs protected from change and unauthorised reading | Partly | The audit log: `apps/api/test/audit/audit.int.test.ts` "refuses the owner connection too", "keeps its guards firing even when a session turns ordinary triggers off" | Gap 13: server logs sit in CranL's log view (Q-664) |
| V16.4.3 | 2 | Logs sent to a separate system | Partly | Metrics and alerts go to the monitoring app (`docs/RUNBOOK.md` "Monitoring stack on CranL (T-018b, ADR-620 to ADR-626)") | Gap 13: log lines do not (Q-664) |
| V16.5.1 | 2 | Generic error messages | Met | `apps/api/src/conventions.test.ts` "hides the cause of an unexpected failure", "keeps a database error's code and names but never its DETAIL or WHERE" | |
| V16.5.2 | 2 | Secure operation when outside resources fail | Met | `apps/api/test/players/sign-in.int.test.ts` "answers 503 with an email offer when Msegat refuses, and ends that code"; `apps/api/test/auth/sign-in.int.test.ts` "still signs the admin in when the alert cannot be sent"; `apps/api/test/console/owner-email.int.test.ts` "closes a held change and answers 503 when the old address cannot be told"; `docs/RUNBOOK.md` "Rankings and Redis (T-106, ADR-118)" | |
| V16.5.3 | 2 | Fail closed | Met | `apps/api/src/auth/breached.test.ts` "fails closed when the retry fails too"; `apps/api/test/auth/password-reset.int.test.ts` "changes nothing when the breach check cannot answer, and asks to retry" | |

## V17 WebRTC

| ID | L | Control | Status | Evidence | Gap |
|---|---|---|---|---|---|
| V17.1.1, V17.2.1, V17.2.2, V17.2.3, V17.2.4, V17.3.1, V17.3.2 | 2 | TURN, media and signalling servers | N/A | | No WebRTC (7 controls) |
