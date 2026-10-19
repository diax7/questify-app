# Scope — Questify

> The boundary of the first release: what's in, what waits, what never ships.
> Last updated: 2026-10-17, after the Stage 1 review. Release decision: ADR-069.

## The v1 rule

**Everything prioritized in `FEATURES.md` ships in v1** (Must, Should and Could), with one
exception: **video submissions (F-89) move to a later update.**

Inside v1, the priority sets the **build order**: Musts first, then Shoulds, then Coulds. If time
ever forces a cut, the cut starts from the bottom of that order. The user decides whether to make
it (ADR-069).

Claude recommended a pilot release of the Musts first, then the rest. The user chose one
complete release. The cost is recorded in ADR-069.

## In scope (v1)

The detail, with IDs, priorities and notes, is in `FEATURES.md`. In summary:

| Area | What v1 contains |
|---|---|
| 1. Joining and onboarding | Four ways to join; sign-in with a +966 phone or email by one-time code; browse before signing in; one-scan join with an event web page; guest lists and company-email lock; welcome reward; mascot intro |
| 2. Quests | 11 quest types, including 3–5 built-in mini-games and share quests; categories (collapsible, completion bonus, in-order or any order, timed, unlocking, daily/weekly, hidden); live polls; community quest; flash quests and boosts; live finale |
| 3. Verification and fair play | Printed QR, operator scan of the player's rotating My QR, NFC tags; rotating screen QR; kiosk; manual awards with caps; permanent points record; exclusion list; flags only, people decide; review queue with optional auto-approve; help desk |
| 4. Points, levels, streaks | Score and balance; fixed Questify XP and lifetime level; event and Questify streaks; currency name and icon; fair live edits |
| 5. Rewards shop | Items, digital codes and experiences; reserve then pick up; uploaded codes; honest stock; rank prizes; prizes as quest rewards; pinned goals |
| 6. Rankings and big screen | The 11-row ranking (top 10 + you); today's and Questify-wide rankings; the event and Questify bars; big-screen scenes including the photo wall |
| 7. The Questify layer | Profile, level titles, achievements, Event Passport, Questify quests, frames, titles, characters, souvenirs, gems and the gem shop, daily challenge, interests and "For you", Questify-run invitations, event recap |
| 8. Home and maps | Event Home (Up next, Happening now, announcements, info); light agenda; any number of maps with optional pins; Questify home and Explore |
| 9. Staff mode | Operator invites and personal operator QR; Operator / Player modes; abilities and assignment; station, prize desk, inbox, today's numbers, practice; renameable words |
| 10. Organizer dashboard | Events, quests, rewards; feature switches; owner and editors; templates; duplicate; lifecycle; invoice activation; logo and banner; live control room; change log; confirmation screens; API-first operations and change sets |
| 11. Messaging | Push with a notification center; organizer announcements; SMS and email login codes; promotional push, email and SMS to opted-in players; per-topic mute |
| 12. Analytics | Participation; quests and categories; rewards and economy; exports; one-page PDF report; survey results; quest ratings |
| 13. Sponsors | Sponsor profiles; presented-by categories; sponsor strip; analytics filtered by sponsor |
| 14. Platform | Questify console; free organizer sign-up; support access; safety tools; data download; multi-tenant; Arabic and English with RTL |
| Stage 1 review | Unique @usernames; leave an event; legal and consent steps; audience targeting; regenerate QR; bulk awards; device pairing; event-day start; one prize desk; confirm winners; batch operator QRs; rehearsal mode; ownership transfer; editor limits; dashboard sign-in and full phone support; organizer terms; email alerts; event time zones; activation with limits and add-ons; usage view; minimum app version (F-228 to F-265) |

## Integrate, don't build (Stage 2, ADR-086)

- **Managed PostgreSQL in a Saudi region:** database, backups, point-in-time restore. Integrate,
  so we don't run our own database operations.
- **Open-source libraries:** sign-in, real-time updates, file storage, an in-memory ranking store,
  animation players (Rive or Lottie), QR and NFC, an admin-panel framework.
- **Built in-house:** the game engine (Questify's core) and a thin notification layer
  (residency and the CST rules).

## Known risk: scope against capacity (Stage 5)

The plan is large: about 510 requirements, with every Must, Should and Could in v1 (ADR-069). The
user chose to keep it that way with **no intermediate release and no review point**, so the first
event waits until everything except video is done. Claude recommended a pre-agreed cut order and a
review point after the Musts. If the build runs long, nothing is cut unless the user decides to
(Q-077).

## Deferred (after v1)

| Item | Where decided |
|---|---|
| Video submissions (F-89) | ADR-069 |
| AI wizard (interactive event builder and editor; the groundwork ships in v1) | ADR-060 |
| Gift cards issued automatically through a supplier (e.g. Resal) | ADR-050 |
| Teams | ADR-025 |
| Public gallery of submissions | ADR-023 |
| Lead sharing with sponsors | ADR-067 |
| Other themes and color branding | ADR-061 |
| A send-when-back queue for scans during signal drops | ADR-029 |
| Every other item on the per-area "Won't (v1)" lists in `FEATURES.md` | `FEATURES.md` |

## Out of scope (never, unless a decision is reversed)

- Purchases of any kind in the app; points, gems and items are never sold (ADR-002, PD-22).
- Raffles, draws, mystery boxes, wheels or any chance reward (ADR-008, ADR-026).
- Apps published per client; the app icon and name never change (ADR-006, PD-30).
- Downloaded features or remote code; new quest mechanics need a store release (ADR-007).
- Ad networks and tracking SDKs (PD-27).
- Background location (PD-09).
- Automatic penalties: the system flags, people decide (ADR-041).

## Assumptions

- Organizers provide and hand over the prizes (ADR-011), and bring staff to act as operators.
- Venues have usable mobile data or Wi-Fi; the app is online-only (ADR-029).
- Pricing, invoicing and payment happen outside the platform; Questify activates each event and
  sets its player limit and add-ons (ADR-076).
- No pilot event is scheduled yet (Q-022 open). Launch timing is planned in Stage 8.

## Constraints

- **Team and tools:**
  - one developer working through Claude Code, on Windows;
  - a borrowed Mac for iOS builds and submission.
- **Stores and market:**
  - every country's storefront except the European Union's at launch (ADR-092);
  - personal developer accounts (ADR-010). Google requires a **closed test with 12+ testers for
    14 consecutive days** before the first public Android release.
- **Product rules:**
  - Arabic and English with full RTL, Western digits (ADR-018);
  - minimum age 13 (ADR-028);
  - scale targets: **50,000+ players in one event** (ADR-062); **10 live events, about 100,000
    players, at once** (ADR-082);
  - recovery: at most 5 minutes of data lost, back within 1 hour (ADR-082).
- **Legal and store compliance:**
  - PDPL: comply as far as practical (ADR-012);
  - the store gates in `STORE_COMPLIANCE.md`;
  - legal questions batched for counsel.
