# T-803: player web build (FR-1816), draft plan

Status: draft, 2026-11-10. Dhia's answers (INBOX 2026-11-10): build now; phone browsers only (no desktop layout); every feature where the browser allows it, QR camera scanning included, with the same design; if the same design cannot work without many changes, drop the web build. Web sign-in lasts as on the phone (ADR-706). Open to anyone at `/play`. Step one is the P0 spike that measures what breaks.

## Where it stands

The app does not build for the web today. `apps/app` has no `react-dom`, `react-native-web` or
`@expo/metro-runtime`, and no `web` block in `app.json` (also noted at `docs/TASKS.md` T-1xx: "Expo web export remains
unavailable"). FR-1816 is a Could, and Dhia called it "a plus, not mandatory" (`docs/INBOX.md`). Size: about 2.5 to 4
worker days. The session part is tier A.

## Native modules on web

| Module | Where | On web |
|---|---|---|
| expo-secure-store | `src/api/app-session.ts` | No web version: the session moves to the forwarder (below) |
| react-native-nfc-manager | `src/nfc/native.ts` | Already lazy and null off phones (ADR-237); hide the NFC entry points |
| expo-camera | scan quests, join scan, operator screens | Hide: the page's `Permissions-Policy` is `camera=()` outside kiosk paths (ADR-245) |
| expo-notifications, expo-application | `src/push/push-native.ts` | A `.web.ts` no-op; the in-app notification centre stays |
| expo-haptics | 10 imports | One wrapper with a `.web.ts` no-op |
| expo-file-system, expo-sharing | data export, recap share | Data export as a Blob download; hide the recap image share; share links with `navigator.share` or copy |
| react-native-view-shot | My QR, recap, rotating QR | Hide the image capture; the QR draws with `uqr` |
| expo-location | location quests | Hide (the page policy blocks geolocation) |
| expo-device, `Platform.OS` | `app/sign-in.tsx`, TicketCenter | Accept `"web"` in `deviceLabelOf` |

`scan-quest.tsx` sends `"android"` for any platform that is not iOS; fix it before web exists. RTL: `I18nManager` is
not honoured by react-native-web, so on web set `document.dir` and `lang`, and a language change reloads the page
(ADR-101's restart rule). The operator screens are hidden on web.

## Session

Tokens never go in AsyncStorage (SECURITY.md, T-111), so on web that rules out localStorage. The API has no CORS, so the
browser goes through the same-origin forwarder, which today drops `authorization`, `x-device-id` and `x-app-version`.

Proposed: the forwarder handles verify, sign-up, refresh and sign-out itself and keeps the tokens in a
`__Host-qs_player` cookie (HttpOnly, Secure, SameSite=Strict), like the staff and device cookies. It strips tokens from
response bodies, turns the cookie into a bearer header on player routes, never forwards a browser-sent `Authorization`,
checks `Origin` on unsafe methods, and forwards `x-device-id` and `x-app-version`. A browser's device id can be rotated,
so the per-install limit is not trusted there; the per-number and per-address limits hold. This is a new sign-in pathway:
SECURITY.md's pathways table and the ASVS V3 and V7 rows change. Constraints: ADR-700, 701, 706, 710, 245, 102.

Rejected: tokens in memory only (every reload costs an SMS against the 5-an-hour limit).

## Hosting

The same CranL web app under `/play`. `Dockerfile.web` runs `expo export --platform web` into `apps/web/public/play`.
`next.config.ts` rewrites `/play/:path*` to the single page. `src/proxy.ts` leaves `/play` out of the language redirect.
`/play` gets its own CSP (`script-src 'self'` or hashes, since the export's scripts carry no nonce; `style-src
'unsafe-inline'` for react-native-web; `connect-src 'self'`). `index.html` is `no-store`. There is no CORS change.

## Quests on web

Playable: `enter_code`, `quiz`, `vote`, `survey`, `submission` (text), `share`, `game` (no haptics), `challenge`
(My QR kept in memory). Half: `meet` (show the code, no scanning, Q4). "Needs the phone app": `scan_qr`, `passport`,
`location`, and any NFC method.

## Phases

- P0, tier C: the dependencies and `app.json`. Gate: `expo export --platform web` passes and Android still builds.
- P1, tier B: `src/platform/capabilities.ts`, `src/quests/web-availability.ts` (every type and method), the `.web.ts`
  shims, the platform fix, hiding operator screens, RTL on web. Tests: the two tables, and a source scan that fails on a
  static import of a native-only module outside its native or web file.
- P2, tier A: `apps/web/src/lib/player-session.ts`, the forwarder and route, `app-session.web.ts`. Tests: cookie flags,
  no token in a body, refresh rotation and reuse, sign-out, Origin refused, a browser `Authorization` never forwarded,
  an API int test that a web family counts against the 10-device cap. Plan review, code review, mutation run.
- P3, tier B: the Dockerfile, Next config, proxy, headers, CI scope; `e2e/play-web.spec.ts` (desktop and phone, both
  languages: sign in, open the event, play a quiz, a scan quest says it needs the app).
- P4, tier C: SRS, TECH_STACK, RUNBOOK, STORE_COMPLIANCE, ADRs.

## Questions for Dhia

- Q1, scope: scan-free as the "Done when" says, with browser-camera scanning split into a T-803b; or FR-1816 whole?
- Q2, web session length: the phone's 180-day refresh and 365-day end (ADR-706), or shorter on a possibly shared
  computer (30 days, or until the browser closes)?
- Q3, address: `questify.nafes.com/play` (same origin, recommended) or a separate player subdomain (CORS, a second app)?
- Q4, meet quests on web: show-only, or hide?
- Q5, web push: none, with the in-app centre only (recommended)?
- Q6, access: open to anyone, or only from an event link?
