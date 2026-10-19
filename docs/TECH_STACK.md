# Tech Stack — Questify

> Every technology chosen, why, and what else was considered. Stage 6, 2026-10-17.
> **Status key:** *Accepted* = the user chose it (ADR-101, ADR-102). *Proposed* = a detail inside an accepted decision (for example Fastify, pg-boss), finalised at build start. Versions are looked up when the build starts, never assumed.

## The constraints that decided this

- One developer working with Claude Code, on **Windows**. A Mac is available only for a short time,
  so iPhone builds and submission must work from Windows (ADR-001, the user's message 2026-10-17).
- **One app for both phones**, not two. The web version of the player app is a plus, not a
  requirement.
- Heavy animation, mini-games, Arabic and English with full RTL, QR and NFC, wallet passes.
- All personal data stays in Saudi Arabia (ADR-070); 99.9% availability, 5-minute data loss at most
  (ADR-074, ADR-082).
- Configuration over code (ADR-004, ADR-007): features are data, new behavior is a store release.

## Stack

| Concern | Choice | Status | Why chosen | Alternatives considered |
|---|---|---|---|---|
| Player app (iOS, Android) | **Expo (React Native)**, TypeScript, Expo Router, development builds (not Expo Go, because NFC needs native code) | **Accepted** (ADR-101) | Builds and submits iPhone apps from Windows through Expo's cloud Macs; one language with the dashboard and server; real DOM on web | **Flutter**: smoother animation and live RTL switching, but a weak web version (canvas, no SEO, no Wasm on iPhone browsers), a second cloud-Mac tool and a second language. **Kotlin Multiplatform**: weakest web and Windows-to-iPhone path. **Two native apps**: ruled out by the user |
| Language | **TypeScript (strict)** in the app, web, server and shared packages | Proposed (ADR-102) | One language lets types, validation rules and the API client be shared; the least switching cost for one developer | Dart (Flutter); Kotlin + Swift |
| Animation | **Reanimated** for UI motion; **Rive** or **Lottie** players for mascot and celebrations; **Skia** canvas for mini-games if plain views are too slow | Proposed | Rive and Lottie have React Native runtimes, so artists' files play unchanged; mini-games are small (memory, slide puzzle, catch, tap rush, word) | Flutter + Flame (better game engine, wrong framework for the other reasons) |
| Phone hardware | `react-native-nfc-manager` (NFC read/write), Expo camera (QR), `expo-notifications`-style direct FCM/APNs registration | Proposed | NFC read and write on both phones through an Expo config plugin; see Q-071 for limits | Flutter `nfc_manager` |
| Build and release | **EAS Build + EAS Submit** from Windows; EAS Update only for fixes inside the reviewed feature set | Proposed | EAS Submit works from Windows; iOS builds run on Expo's Macs. Free plan: 15 iOS + 15 Android builds a month in a slow queue; Starter $19, Production $199 per month with priority queue | Codemagic (works, but a second tool for Expo); a borrowed Mac with Xcode as a fallback |
| Web surfaces | **One Next.js (React) web app** for the event page, station and big-screen pages, account-deletion page, organizer dashboard and Questify console | Proposed (ADR-102) | Event page needs fast load and link previews (server-rendered); dashboard is form-heavy and needs real HTML tables and text selection | Expo web for everything (weaker for the dashboard); Flutter web (poor for SEO and forms); React-Admin / Retool (the setup wizard, live preview and renamable words need custom screens) |
| Player web version (plus) | The same Expo app exported for the browser | Proposed, *Could* (F-318) | Real DOM, shared code. NFC and wallet-pass adding need a phone; camera scanning uses the browser camera | Not shipping a web player at all |
| Backend | **Node.js 22 LTS + Fastify**, one deployable app split into modules (modular monolith) | Proposed (ADR-102) | The simplest thing that meets 20,000 completions a minute (about 330 a second); one thing to run and debug; module borders allow splitting later | NestJS (heavier); Go (fast, but a second language); Supabase (no Middle East region, ADR-086) |
| Data store | **PostgreSQL**, managed, in a live Saudi region; one shared schema with an `organizer_id` on every tenant row and **row-level security** | Proposed. **One-way door** | Data is relational (players, events, quests, completions, an append-only points record); transactions guarantee a completion and its points happen together | Document stores (the points record needs transactions); one database per organizer (too much to run for hundreds of small events) |
| Rankings, rate limits, short-lived codes | **Redis-compatible store** (cloud-managed Redis or Valkey) | Proposed | Sorted sets give top-10 and "where am I" in milliseconds; rebuilt from the points record if lost | Ranking in PostgreSQL only (fine at small scale, slower at 50,000 players) |
| Background jobs | **pg-boss** (jobs stored in PostgreSQL) | Proposed | No extra system; notifications, report generation, scheduled sends | BullMQ on Redis (more throughput, one more thing that must not lose jobs) |
| Files (photos, art, exports) | Cloud object storage in the Saudi region | Proposed | Same residency as the database; signed upload URLs | Storing in PostgreSQL (does not scale) |
| Sign-in | Players: phone or email code. Staff: email + password (argon2id) + email code. Built on a maintained open-source auth library or vetted primitives; chosen at build start after checking maintenance | Proposed; flow Accepted (ADR-078, ADR-089) | Hand-rolled password storage is the classic breach; codes sent through our SMS/email layer | Hosted auth services (paid, data leaves Saudi) |
| Hosting | **CranL Pro, region `riyadh-1`** (managed PostgreSQL, Redis, buckets, CDN, realtime, cron, email) | **Accepted for now** (ADR-107); production-readiness checks open (Q-031) | The user's existing account; fast, cheap, works with Claude's MCP; Saudi regions exist | Oracle Riyadh + Jeddah (best documented); Google Dammam via CNTXT; sccc; Huawei |
| Quality tools | `oxlint`, `oxfmt`, `vitest`, `tsc --noEmit`, Playwright for web, an outsider-seat test suite | Proposed | Global project standards | ESLint/Prettier |
| Repository | One monorepo (pnpm workspaces): `app`, `web`, `api`, `shared` (types, schemas, config schema) | Proposed | Shared types are the point of using one language | Separate repositories |

## Reused open-source (Stage 2 reuse check, ADR-086)

| Project | License | What we reuse | Build-vs-reuse reasoning |
|---|---|---|---|
| Expo / React Native | MIT | The app framework and build service client | The whole point of the framework choice |
| PostgreSQL | PostgreSQL License | The database | Managed service in Saudi; standard SQL, no lock-in |
| Fastify | MIT | The HTTP server | Small and fast; replaces nothing we would write |
| Redis or Valkey | BSD (Valkey) / mixed (Redis) | Sorted sets for rankings | License of the managed offering is the provider's concern |
| `passkit-generator` | MIT | Signs Apple Wallet passes on the server | Building the `.pkpass` zip and signature by hand is possible but needless |
| Rive and Lottie runtimes | MIT | Playing designer-made animations | Designers keep authoring; no custom animation engine |
| `react-native-nfc-manager` | MIT | NFC read/write | Native NFC code is hard; the library supports a development build |
| Game logic (quests, points, XP, shop, rankings) | n/a | **Built** | It is the product. Open-source gamification engines were old or thin (ADR-086) |
| Notification layer | n/a | **Built, thin** | Novu needs MongoDB, Redis and workers; our needs are three provider connections (ADR-086) |

Licenses of everything on this table are re-checked when each package is installed.

## Notes

- **Expo Go cannot run the app** (NFC needs custom native code), so everyone uses development
  builds from day one.
- **Language switching:** in React Native the layout direction is read when the app starts, so
  switching Arabic ↔ English inside the app restarts it. Most players choose a language once at
  first launch (Q-079 asks whether that is acceptable for Settings).
- **Over-the-air updates** must not change the app's purpose or add features (Apple 2.5.2, ADR-007).
  EAS Update carries code and assets only, never personal data. Whether to use it at all is
  Q-033's answer; the default is to use it for bug fixes only.
- **Vitest is pinned to 4.1.12** (not 5.x): with Stryker 10 and Vitest 5 the mutation runner reported false "survived" mutants (score 20% on code the tests fully cover); with Vitest 4.1.12 it is correct (100%). Revisit when Stryker supports Vitest 5.
- **Install size budget:** see NFR-031.
- Decisions: ADR-101 (framework), ADR-102 (technical shape), ADR-103 (SMS shortlist).
