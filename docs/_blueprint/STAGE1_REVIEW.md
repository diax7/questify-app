# Stage 1 review — findings and their status

> The second review pass, which the user asked for on 2026-10-17. Four independent reviewers:
> the player journey; the organizer, operator and admin journeys; competitors and the Saudi
> market; consistency and assumptions. This file tracks every finding until it is closed. When
> all are closed, the Stage 1 gate is asked again.

Status:
- **Decide:** the user's call, asked in batches.
- **Fix:** Claude applies it from existing decisions.
- **Done:** closed.

## User decisions

| # | Finding | Reviewers | Status |
|---|---|---|---|
| D1 | Saudi-only storefront blocks tourists, expats with foreign Apple IDs and international visitors (ADR-014). Widen to all non-EU storefronts? | Player, Market | Done |
| D2 | No Saudi legal entity (CR) yet, but SMS senders, ZATCA e-invoicing, VAT, SDAIA and government buyers need one. Who invoices, and when is the company formed? | Market, Ops, Audit | Done |
| D3 | Online-only with no pilot (ADR-029 + ADR-069): queue scans on operator devices only, using signed timestamps? | Market, Ops, Player | Done |
| D4 | Accessibility target (WCAG 2.2 AA, screen readers, large text); the 11-row no-scroll ranking under large text | Player, Audit | Done |
| D5 | Minors 13–17: safer defaults (no promo, no invitation targeting); guardian flow before counsel answers (Q-042) | Player, Audit | Done |
| D6 | Rehearsal on real phones before go-live (data wiped at go-live); "what is this QR?" lookup | Ops | Done |
| D7 | Event grows past its paid size: block, warn, or bill the overage? | Ops | Done |
| D8 | Confirm winners (with open flags shown) before the rank-prize reveal | Ops | Done |
| D9 | Owner vs editor powers; ownership transfer; editors limited to chosen events (agencies); activation request owner-only | Ops, Audit | Done |
| D10 | Teams-lite (a join-field team with a team ranking) for corporate and campus events (ADR-025) | Market | Done |
| D11 | Per-sponsor consented lead sharing for B2B exhibitions (ADR-067) | Market | Done |
| D12 | Audience targeting: a category or reward visible only to a section (women, families, VIP, department) | Market | Done |
| D13 | Event-day start time (Ramadan nights cross midnight); streak = consecutive days or count of active days | Market, Audit | Done |
| D14 | Celebration before server confirmation (and how to reverse it) or after | Player, Audit | Done |
| D15 | XP inflation: who sets difficulty; XP only on the first completion of each quest? | Audit | Done |
| D16 | Prize pickup: location and hours per reward; after the event only digital or still-collectible rewards; winner push with a claim deadline | Player, Ops | Done |
| D17 | One accent color for brand activations (ADR-061) | Market | Done |
| D18 | One person with a phone account and an email account: flag a shared device across sign-in types? | Audit | Done |
| D19 | Player safety: leave an event, unique nicknames, lost-phone recovery and remote sign-out, re-verify before redeeming | Player | Done |
| D20 | Submissions: resubmit after rejection; late approvals after the balance closes | Player | Done |
| D21 | Deleting and re-signing up dodges bans and repeats the welcome reward | Player | Done |
| D22 | Defaults Claude wrote into the SRS without a user answer: FR-1607, FR-1415, FR-1602, FR-213, FR-252, FR-1610, FR-1616, FR-1618, FR-1625, FR-139 | Audit | Done |
| D23 | Dashboard and console sign-in method; MFA for platform admins | Audit | Done |
| D24 | Organizer operations pack: bulk or compensation award, regenerate a QR, batch operator QRs, ability presets, operator auto-expiry, live operator list | Ops | Done |
| D25 | Organizer support: a "Get help" channel, email alerts, a control room that works on a phone | Ops | Done |
| D26 | Streak freeze; "most improved" recognition | Player | Done |
| D27 | Market ideas: ticket-number validation, social proof counts, session-overlap rule, Ramadan and national-day templates, Hijri dates, Saudi-dialect celebration copy, a Resal prize bundle, finale prize sponsor and ranking naming | Market | Done |
| D28 | How many events at once at peak (Q-064); backup and restore targets | Audit | Done |

## Claude's fixes (from existing decisions)

| # | Fix | Status |
|---|---|---|
| C1 | Promotional SMS: the CST send window (no promotional SMS 22:00–09:00, Ramadan 01:00–12:00) and opt-out within 24 h; update STORE_COMPLIANCE §3.2, §5 and PD-24 | Done |
| C2 | Legal and consent FR group: terms at sign-up (version logged), privacy policy before collection, terms before the first submission, community guidelines, Settings → Legal, contact page, per-event rules URL | Done |
| C3 | Account deletion vs the permanent record: anonymize, don't erase; "permanently" becomes "until the account is deleted"; open reservations return; recorded ranks are frozen | Done |
| C4 | Event time-zone field (default Riyadh); the Questify-layer day uses Riyadh time | Done |
| C5 | Minimum app version per feature, "update to play", forced update | Done |
| C6 | Station pages and kiosks paired from staff mode and revocable; big-screen links regenerable; both covered by outsider tests | Done |
| C7 | Draft and unpaid events are not public: the event page, invite links and joining go live only after activation | Done |
| C8 | Store- and law-required Shoulds raised to Must: block (F-222), promotional opt-out, data download (F-224) | Done |
| C9 | One table of every switch, per event and platform-wide, including flash quests and boosts, NFC, kiosk, finale, photo wall, hidden categories, sponsors, invitations, share quests | Done |
| C10 | Stale text: STORE_COMPLIANCE §5 and §6 (organization membership, image moderation, PD-11 "under discussion", PD rows without outcomes); ADR-008, 010, 042; F-81 note; PROJECT_BRIEF goal 2, Q-001 and the "XP" currency name | Done |
| C11 | Priority mismatches: F-171, F-173, F-23, FR-1110; the FR-1418 / FR-1627 duplicate | Done |
| C12 | Review demo event: exempt from the lifecycle and invoicing; reviewer progress reset per build; the reviewer is an operator allowed to play | Done |
| C13 | NFR-006: maintenance in low-traffic hours (events can run 45 days) | Done |
| C14 | Install size budget with event art downloaded on demand; SMS code autofill; "Get ready" prompt on the event page | Done |
| C15 | Each quest's detail names its verification method with a direct action ("Show My QR to staff"); points are recorded whether or not Claim is tapped | Done |
| C16 | Time and language display: device language by default with a setting to change it; times shown in the event's time zone | Done |
| C17 | Location-flag rules: off for virtual events; the location prompt's timing and explanation | Done |
| C18 | Retention periods table: proposed now, to counsel with Q-051 | Done |
| C19 | Close Q-023 (Arabic and English from day one, F-45) | Done |
| C20 | Exports of player data logged (NFR-019) | Done |

## Outcome (2026-10-17)

- **All 28 decisions and 20 fixes are closed.**
  - The owner side (D2, D7, D9, D23, D25, D28) was grilled one question at a time.
  - Then D1, D3–D6, D8, D10–D22, D24, D26 and D27.
- **Written to:**
  - `DECISIONS.md` (ADR-076 to ADR-085);
  - `FEATURES.md` ("Stage 1 review additions", F-228 to F-265, and the canonical switch list);
  - `SRS.md` (§1.17, FR-1701 to FR-1746, NFR-025 to NFR-030, and rewritten rows);
  - `SCOPE.md`, `STORE_COMPLIANCE.md`, `OPEN_QUESTIONS.md` (Q-075), `PROJECT_BRIEF.md`.
- **Recommendations the user declined, recorded with their costs:**
  - email codes for admins (no authenticator);
  - no offline queue on staff devices;
  - no accessibility target;
  - no rules for minors;
  - no teams or leads;
  - storefronts in Saudi Arabia and the GCC only;
  - one admin role;
  - none of the research or market extras.
