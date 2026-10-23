# Blueprint State — Questify

## Stage 0 — Setup (2026-10-16)

**Situation:** greenfield. Empty folder, no code.

**Setup answers.** These were inferred from session 1; the user has not confirmed them yet:

| Question | Answer | Reason |
|---|---|---|
| Experience level | Technical; works through Claude Code | Engineering vocabulary, with a short gloss on store and legal terms |
| Project type | Commercial product (multi-tenant platform for organizers) | Any organizer worldwide, real users, public store listing |
| Depth | Guided: stage by stage, approval at each gate | User asked to "take it step by step" and to make everything clear before development |
| Scope preset | Max | Public launch on two stores, compliance-sensitive, first app, wants nothing left implicit |

**Doc set:** see `docs/README.md`. The final deliverable is `docs/SRS.md`, the master spec. The
other docs feed it and stay as its detailed appendices.

## Stage progress

| # | Stage | Status |
|---|---|---|
| 0 | Setup | Done, pending user confirmation of the answers above |
| 1 | Requirements: features, consultant pass, clarify loop | **Done and approved 2026-10-17** (after a second review pass) |
| 2 | Reuse check (open-source to reuse) | **Done 2026-10-17** (ADR-086) |
| 3 | Business & product (model, pricing, metrics, market, GTM) | **Done 2026-10-17** (ADR-087); market research is `research/COMPETITORS.md` |
| 4 | Design & UX (flows, design system) | UX flows and wireframes drafted 2026-10-17; visual design system deferred |
| 5 | Pressure-test | **Done 2026-10-17** (8 questions; `_blueprint/STAGE5_GRILL.md`) |
| 6 | Tech & architecture (stack, data model, remote config) | **Done 2026-10-17** (ADR-101 to ADR-103; `_blueprint/STAGE6_GRILL.md`) |
| 7 | Agent steering (CLAUDE.md for the build phase, rules, ADRs) | **Done 2026-10-17** (ADR-104; build-phase CLAUDE.md drafted, not applied) |
| 8 | Delivery & quality (roadmap, tasks, tests, risks) | **Drafted 2026-10-17** |
| 9 | Wrap-up: consistency pass, SRS consolidation, build handoff | — |

**Research (2026-10-16):**
- Done: `research/COMPETITORS.md` and `research/GAMIFICATION_PATTERNS.md`. Gaps Questify can own:
  a real rewards store, first-class Arabic, verification that needs no hardware, and premium UX.
- Done: `STORE_COMPLIANCE.md`, checked against Apple's guidelines dated June 8, 2026. It contains
  the pre-submission checklist and 30 proposed product decisions (PD-01–30) waiting for the
  user's review. Its open questions moved to `OPEN_QUESTIONS.md` (Q-040–051).

## Session 2 (2026-10-16)

- The user reviewed the compliance findings → ADR-006 to ADR-012.
- The brand deck was received → ADR-013, `design/REFERENCES.md` R-01.
- BRD v2 (April 2026) was found and imported → `inputs/`, F-53 to F-68.
- The setup answers were not objected to.
- The user wants the first release to contain every feature. The Stage 1 scope view will show
  the cost; the user decides.

## Session 3 (2026-10-16)

- Saudi-only launch → ADR-014.
- Location optional → ADR-015.
- Golden Ticket raffle removed.
- Design approach proposed and awaiting the user's choice:
  1. Image generation through the API, with an OpenAI key (and optionally a Gemini key) in `.env`.
  2. A code-first Design System artifact, with the brand tokens and live components in Arabic
     and English.
  3. Key screens on a Design canvas.
  4. The components ported to the app framework once it is chosen.

## Session 4 (2026-10-16)

- The design comes first; features come after (user).
- Asset production → ADR-016. Codex generates the assets through the user's ChatGPT subscription;
  no API key is needed.
- Created `design/codex-image-2/`:
  - `CODEX_BRIEF.md`: the style rules, prompts, sizes, naming, self-check and phase gate;
  - `ASSET_LIST.md`: 8 anchors, about 115 P1 assets and 18 P2 assets;
  - `reference/`: 8 deck pages and 10 crops.

## Session 5 (2026-10-16)

- Phase 1 anchors reviewed and approved. All icons have real transparency.
- Wood texture v3 tiles cleanly (checked with a 2×2 tile test), although Codex had marked every
  wood tile as failing.
- The approved variants are listed in `ASSET_LIST.md`.
- From Phase 2 on, one variant per asset (user). Only the Arabic wordmark gets 3.

- The user asked for every phase in one run. Phase 3 was expanded into the full app set:
  - venue and map icons, event types;
  - staff, moderation and organizer KPI icons, achievements;
  - a Saudi cultural set;
  - permission-screen and state illustrations;
  - animation parts (compass, chest lid);
  - the splash background and store graphics.

  About 218 assets remain.

## Session 6 (2026-10-16)

- Codex is mid-run: 47 of about 218 assets done at 15:52.
- Interim review in `design/codex-image-2/REVIEW.md`:
  - consistent style, real transparency;
  - padding to be normalized in one processing pass;
  - 3 redos queued.
- Font Lab published (https://claude.ai/artifact/CxYQ8cNEKfeoA9Yb2uokef): four pairings, each
  supporting both Arabic and Latin. Recommended: Baloo Bhaijaan 2 + Rubik. Open: Q-067, Q-068.

- Fonts chosen: Baloo Bhaijaan 2 + Rubik (ADR-017).
- Western digits everywhere (ADR-018).
- Codex at 16:10: 115 of about 218 assets done.

## Session 7 (2026-10-16)

- **Codex run.** Phase 2 is complete. Phase 3 stopped at the daily image limit (resets
  2026-10-17 14:48 Riyadh).
- **Full review** of 179 assets: 133 keep, 44 redo, 1 remove. See
  `design/codex-image-2/REVIEW.md`.
- **Library** (`design/assets/`): one approved file per asset, `manifest.json` and
  `ASSET_INDEX.md`. Raw outputs and rejects were archived outside the project
  (`NAFES/Questify-raw-archive/`).
- **Codex brief.** It gained the "Hard rules from review". `ASSET_LIST.md` now has Phase 4 (44
  redos + 3 avatar restyles) and Phase 5 (63 new assets that complete the app). 157 queued in
  total.
- **Design System page started** (https://claude.ai/artifact/H4ozsGZUWnR3joDZBnUWSb):
  - written locally: tokens, brand book, 25 components, cover;
  - uploaded: 75 assets;
  - paused until the next batch is reviewed, so rejected art doesn't go in.

## Session 8 (2026-10-16)

- No Arabic wordmark: the English wordmark is the only logo (ADR-020). It was removed from the
  library and the design system.
- A mascot was approved (ADR-021). Five options, two images each, are queued as Phase 6.
  `make_mascot_board.py` merges them into one voting board for the team. The choice is Q-069.

## Session 9 (2026-10-16)

- Stage 1 product answers → ADR-022 to ADR-029: pay per event, organizer-only submissions, four
  join methods, individuals only, no chance rewards, web dashboard + staff mode, age 13+, online
  only.
- Design System v1 published (https://claude.ai/artifact/H4ozsGZUWnR3joDZBnUWSb): tokens, brand
  book, 25 components, 133 assets. Its source is in the session scratchpad; on the next update,
  read the artifact first, because the page publishes its own generated files.

## Session 10 (2026-10-16): feature brainstorming begins

- **Format.** The user approved 14 areas in journey order; the list is at the top of
  `FEATURES.md`.

  For each area:
  - competitors and where we beat them;
  - ideas the user hasn't raised;
  - question batches with a recommendation.

  Each area ends with MoSCoW priorities in `FEATURES.md` plus ADRs. A prioritized feature moves
  out of the "Captured" tables into its area section.
- **Area 1 (joining and onboarding): done.**
  - F-01 and F-69 to F-82 prioritized.
  - ADR-030: sign in with a +966 phone or email, by one-time code.
  - ADR-031: browse first, sign in to earn.
  - ADR-032: nickname and avatar in public; real name per event.
  - PD-14 and PD-20 accepted.
  - Q-070: iOS deferred deep link.
  - Claude's recommendations the user declined (non-Saudi phone numbers, WhatsApp codes) are
    recorded in ADR-030 and the Won't list.

- The user asked to move between areas without being asked (saved to memory).
- **Area 2 (quests): done.**
  - Types and rules are prioritized: F-02 to F-07, F-52 and F-83 to F-92.
  - ADR-033: the quest model and v1 types.
  - ADR-034: share quests on the honor system, against Claude's advice; costs recorded.
  - ADR-035: 3 to 5 built-in mini-games.
  - ADR-036: video submissions up to 30 s.
  - Quiz: one try per question.
  - The user's design: every quest in a collapsible category, with an optional completion bonus
    and any-order or in-order quests (ADR-038; chains are in-order categories).
  - Live polls (F-100).
  - Four roles (ADR-037): platform admin, event owner, operator, player.
  - Community quest (ADR-039).
  - From Claude's ideas, picked: flash quests and boosts, live finale. Not picked: fog-of-war
    map, bingo, bring a friend, quiet-zone boost, kudos; collectible cards go to Area 7.
- **Area 3 (verification and fair play): done.**
  - F-54, F-55, F-67 and F-104 to F-120.
  - ADR-040: three verification methods (player scans the quest QR, operator or kiosk scans the
    player's rotating My QR, NFC tags written from staff mode), plus manual awards with caps.
  - ADR-041: flags only, people decide (Claude's "hold and review" was declined).
  - ADR-042: review queue with optional auto-approve; PD-12 accepted with that exception.
  - Help desk for players (F-118).
  - Q-071: NFC limits.
  - Note: the user first ticked "flag and hold" for shared phones, then wrote "just flag, no
    automated actions". The written rule was followed.
- **Area 4 (points, levels and streaks): done.**
  - F-08, F-11, F-24, F-56, F-57, F-59, F-60 and F-121 to F-126.
  - ADR-043: rank by points earned; balance separate.
  - ADR-044: two layers, the event and Questify. The fixed-XP rule is Claude's proposal.
  - ADR-045: an event streak plus a Questify daily streak.
  - The user opened a large topic: a cross-event Questify profile, items, achievements, Questify
    quests, and a player database for invitations and marketing. Area 7 was renamed "The
    Questify layer" and moved up to be next.
  - Claude raised the data-minimization caution once (in ADR-044).
  - Q-072: player data and consent. Q-073: organizer access to cross-event data.
- **Area 7 (the Questify layer): done.**
  - F-58, F-77 (detail), F-125 (rule) and F-127 to F-143.
  - Items: frames, titles, characters.
  - Earned by level-ups, achievements, Questify quests, event souvenirs, and a gem shop. Gems
    come from Questify quests, achievements and level-ups.
  - ADR-046: items, gems and the shop.
  - ADR-047: broad data collection within PD-09/PD-27, with a marketing opt-in; Questify-run
    invitations, organizers see results only. The user answered "all" on data, read as broad
    collection plus the required opt-ins.
  - ADR-048: shop window, then the balance closes.
  - Daily streak: any Questify activity counts, plus the daily challenge. Event recap only.
- **Area 5 (rewards shop and prize handover): done.**
  - F-10, F-22, F-62 and F-144 to F-153.
  - ADR-049: reserve in the app, pick up at the desk.
  - ADR-050: organizer-uploaded codes.
  - ADR-051: rank prizes, pending counsel (Q-041).
  - Shop ideas picked: prizes as quest rewards, pin a goal. Not picked: score tiers,
    back-in-stock alerts. No shipping.
- **Area 6 (leaderboard and big screen): done.**
  - F-09, F-23, F-61, F-154 to F-164.
  - Fixed XP confirmed (ADR-044 now Accepted).
  - ADR-052: the user's 11-row ranking (top 10 + you), first-to-reach tie-break, everyone
    visible (PD-20 anonymity declined); today's ranking and a Questify-wide ranking.
  - ADR-053: navigation. Event bar: Home, Quests, ● (Scan + My QR), Rewards, Profile; ranking on
    Home; Questify home through the event pill (Q-058 closed).
  - ADR-054: big-screen scenes, with a photo wall by per-photo consent; no freeze.
  - Rank alerts for top-10 moments only.
- **Area 8 (event home, maps, Questify home): done.**
  - F-50, F-63, F-64, F-165 to F-173.
  - Event Home: Up next, Happening now, announcements, info page.
  - ADR-055: maps are uploaded pictures with optional pins, as many as needed (Q-057 closed).
  - ADR-056: light agenda (Claude had recommended none).
  - Questify home bar: Home, Explore, ●, Shop, Profile (ADR-053 extended).
- **Area 9 (staff mode): done.**
  - F-174 to F-187.
  - ADR-057:
    - operators join by owner invite or a personal single-use operator QR;
    - they can't play by default; when allowed, they switch between Operator and Player modes;
    - abilities on by default, optional assignment;
    - operator bar: Home, Prize desk, ●, Inbox, Tools.
  - Station mode, prize-desk mode, inbox and today's numbers; practice mode.
  - ADR-058: per-event renameable words (player, operator, quest, category), Arabic and English,
    singular and plural.
- **Area 10 (organizer dashboard): done.**
  - F-20, F-21, F-25, F-26, F-66, F-68, F-188 to F-198; F-123 updated.
  - ADR-059: owner and editors.
  - ADR-060: the AI wizard is a future version; API-first operations and change sets ship now.
  - ADR-061: adventure theme branding is logo and banner only (Should); colors only with future
    themes (Q-059 closed).
  - ADR-062: scale target of 50,000+ players per event. Q-064 now only asks about events at once.
  - ADR-063: live edits ask "future only" or "also past"; delete asks keep or remove points;
    explanatory confirmation screens everywhere.
  - ADR-064: billing by invoice, activated by Questify.
  - Templates and duplicate; no spreadsheet import; dashboard preview only.
- **Area 11 (notifications and messaging): done.**
  - F-43, F-44, F-199 to F-204.
  - ADR-065: no push cap, no prayer or quiet pauses (Claude recommended both; costs recorded);
    announcements by push and in-app; promotional push, email and SMS to opted-in players.
    PD-24 accepted with promotional SMS allowed.
  - Notification center, permission asked after joining, per-topic mute.
- **Area 12 (analytics and reports): done.**
  - F-65, F-205 to F-210.
  - ADR-066: participation, quests and categories, economy, survey results, quest ratings,
    exports and a one-page PDF. No time or heatmap (Q-056 closed), no comparison or benchmark.
  - **Correction:** community points are participation points, never deducted. The donate mode
    was removed from ADR-039, ADR-043, F-101, F-121 and F-60.
- **Area 13 (sponsors): done.**
  - F-211 to F-214.
  - ADR-067: sponsor profiles, presented-by categories, sponsor strip on Home.
  - No leads, no report link, no sponsor logins.
- **Area 14 (platform admin, trust and safety): done.**
  - F-215 to F-227; platform foundations F-40, F-41, F-42 and F-45 prioritized as Must.
  - ADR-068:
    - free organizer sign-up; activation is the approval;
    - support has full edit access, logged (Claude recommended read-only);
    - one admin role;
    - report, nickname filter, block, platform ban.
  - PD-11 accepted.
  - The "Captured, not yet prioritized" section of `FEATURES.md` is now empty and was removed.

## Session 11 (2026-10-16, after a device restart)

- Docs verified intact after the restart.
- **SCOPE.md written.**
  - v1 is everything prioritized, except video submissions (ADR-069).
  - Claude recommended a pilot of the Musts first; the user chose one complete release.
  - No pilot event yet (Q-022 stays open).
  - Priorities now set the build order inside v1.

- **Compliance review: complete.** Every PD has an outcome (`STORE_COMPLIANCE.md` §6).
  - ADR-070: data hosted in Saudi Arabia.
  - ADR-071: no AI moderation in v1.
  - ADR-072: location while the app is open, never in the background.
  - ADR-073: everything else. PD-29 narrowed to reports and unpublish, after one pushback.
    PD-28 replaced by "store declarations always describe every feature as on".
  - The user asked for the PDs one by one, in plain words. Grouped acceptance didn't work for
    them.

- **SRS v1 drafted** (`SRS.md`).
  - 401 FRs across 14 areas plus §1.16 (rules settled while writing).
  - 24 NFRs, external interfaces, data requirements, and a traceability table (tests pending).
  - Every v1 feature (199) has at least one FR.
  - Four writers drafted areas in parallel; Claude merged and checked coverage.
  - Quality targets (ADR-074): 99.9% availability, iOS 16+ and Android 9+, 20,000 completions per
    minute with 95% confirmed within 1 s, ranking within 5 s.
  - Gaps the writers found, closed by ADR-075:
    - vote options written by the organizer only;
    - a second verified identifier on any account;
    - the year-based age rule;
    - the balance stops at zero;
    - FR-253 (prayer pause) retired.
  - Q-074: tuning values for Stage 6.
- **Stage 1 (requirements) is complete,** pending the user's approval at the gate.

- **Stage 1 review pass (user's request):** done.
  - Four independent reviews: the player journey; organizer, operator and admin; market and
    Saudi; consistency.
  - Then the grilling skill, one question at a time (52 questions), starting with the
    Questify-owner side.
  - The user confirmed the shared understanding twice before anything was written.
  - Outcomes:
    - ADR-076 to ADR-085;
    - F-228 to F-265 (plus a canonical switch list);
    - SRS §1.17 (FR-1701 to FR-1746) and NFR-025 to NFR-030;
    - nickname renamed to username throughout;
    - C1–C20 consistency fixes (CST promotional-SMS window, legal and consent steps,
      anonymization on deletion, time zones, minimum app version, device pairing, stale text).
  - The tracker is `_blueprint/STAGE1_REVIEW.md`.
  - SRS now: 446 FRs, 30 NFRs; all 232 v1 features traced.

## Stage 2 (2026-10-17): reuse check, done

- ADR-086, based on the research.
- Managed Supabase is ruled out by residency (no Middle East region).
- Live Saudi regions: Google Dammam, Oracle Jeddah and Riyadh, Huawei, Alibaba, Tencent. AWS and
  Azure are not yet live.
- **Decisions:**
  - backend: managed PostgreSQL in a Saudi region, plus open-source libraries;
  - game engine: built in-house;
  - notifications: a thin in-house layer;
  - animation, QR/NFC and admin UI: reused components.
- Q-031 narrowed; vendors are picked in Stage 6.

## Stage 3 (2026-10-17): business, done

- Written: `BUSINESS_MODEL.md`, `METRICS.md`, `PRICING.md`, `GO_TO_MARKET.md`. No separate `MARKET.md`: the
  research is in `research/COMPETITORS.md`.
- ADR-087:
  - first customer: organizers and agencies;
  - north-star: activated players per event;
  - per-event tiers plus add-ons, priced outside the platform;
  - riskiest assumption: players will install an app for an event;
  - channels: direct outreach and agencies.
- Codex is running (Phases 3–6) while Stage 3 is written.
- **Targets in METRICS.md are beliefs** (40% activation), to confirm after three events.

## Stage 4 (2026-10-17): UX flows and wireframes, drafted

- The user: "The adventure theme looks okay but we might change it completely, so don't rely on
  it. Focus on user experience and wireframes."
- Layout options were shown as sketches and chosen by the user (listed in `UX_FLOWS.md`).
- Written: `ux/PLAYER.md` (me), `ux/OPERATOR_MODE.md` and `ux/DASHBOARD_AND_CONSOLE.md` (two
  background writers).
- Fixes after merging:
  - the operator doc said a paused player could still collect reservations; FR-1604 says a pause
    blocks handover, so the doc was corrected;
  - FR-1023 updated for the accent color (ADR-085).
- The design system (colors, type, components) is deliberately not decided.
- **Review with the user (same day), ADR-088:**
  - operator mode approved: 10-second Undo, banned player's items held, results stay until the next scan;
  - dashboard and console explained in full and four judgment calls decided (one language required,
    activation any time, last save wins, sideways strip);
  - the XP-by-difficulty setting now has an Off switch, default Off;
  - the user's player-app notes (2026-10-17): flexible layout controlled by the Questify team and
    a guided setup wizard for organizers (ADR-090, `ux/ONBOARDING_WIZARD.md`); Wallet passes
    researched (`research/WALLET_PASSES.md`), decision pending;
  - Wallet decided (ADR-091): full wallet identity on Apple and Google, fixed code, risk accepted;
    organizer layout presets (F-276);
  - admin controls (ADR-093): translation matrix, feature kill switches, tuning numbers, maintenance
    mode, banner; safety tools (draft, rollback, last-working copy) declined with the risk recorded;
  - storefronts widened again: everywhere except the EU (ADR-092);
  - ADR-094: more admin tools (player tools, templates and word lists, legal documents, health,
    organizer tools, admin accounts, ranking seasons) and a last-working configuration on the phone;
  - mini-games specified (ADR-097: four quest games plus the daily word);
  - player onboarding (ADR-096, F-82, F-305 to F-307);
  - sessions with registration (ADR-095, F-295 to F-304);
  - the player app walked through: sign-in now happens at the Join tap (ADR-089); Up next uses an
    organizer pin (F-266) then best points for time; locked quests stay visible. The user then added the notes
    above and **approved the player app**.
- Assumptions to confirm are listed at the end of the operator and dashboard files.

## Codex status (2026-10-17, evening)

- The daily image limit stopped generation again. Seven mascot images and one fennec color
  correction remain. Reset reported for 18 October, 3:09 pm Riyadh time. Mascot heroes done so
  far: falcon, fennec, compass.
- The user confirmed: no account restore after deletion; email + password + code is "very safe";
  Apple allows an event logo on a pass and the lawyer accepts pass data abroad (user statements).

## Stage 5 (2026-10-17): pressure-test, done

- Standard intensity, 8 questions; log in `_blueprint/STAGE5_GRILL.md`.
- Changed the plan: email fallback for SMS login (FR-1812); first-coin target is 3 minutes from
  the first scan (ADR-098); weekly content at launch (ADR-099); a flag holds a prize handover
  (ADR-100); Q-078 added for counsel.
- Declined with the risk recorded: no review point or cut order (Q-077), no single lead reason, SMS
  cost absorbed, store accounts stay personal (ADR-010).
- Also this session: player onboarding (ADR-096), sessions with registration (ADR-095), mini-games
  (ADR-097), admin tools (ADR-093, ADR-094), wallet passes (ADR-091), setup wizard and layout
  (ADR-090). SRS: 515 FRs.

## Stage 6 (2026-10-17): tech and architecture, done; ADR-102 accepted

- The user asked for all options with pros and cons, research first, and a recommendation: one app for
  both phones, built from Windows with a Mac only briefly available, web a plus not a requirement.
- **Decided:** framework = Expo (React Native) + TypeScript (ADR-101, Q-030 closed). SMS = a Saudi
  gateway, Msegat or Taqnyat (ADR-103). **Postponed by the user:** cloud and database (Q-031,
  "I will see later"); Claude's lean is Oracle Riyadh + Jeddah, still to verify managed PostgreSQL there.
- **Accepted after the grill (ADR-102):** TypeScript modular monolith, PostgreSQL with shared schema
  and row-level security (one-way door), Redis-compatible rankings, one Next.js web app for event page,
  dashboard, console and big screen, internal `/v1` REST API.
- Written: `TECH_STACK.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `API.md`, `INTEGRATIONS.md`,
  `CONFIGURABILITY.md`, `SECURITY.md`. Added F-318 (player web build, Could), FR-1816 (516 FRs),
  NFR-031 (50 MB download budget), Q-079 (language-switch restart). Notes added to Q-031, Q-034, Q-070,
  Q-071, Q-076.
- Findings from research worth remembering: Firebase Dynamic Links shut down on 25 Aug 2025; AWS Saudi
  is announced for Dec 2026 and not live; the Apple wallet certificate can be made without a Mac; Saudi
  SMS gateways cost about SAR 0.06–0.14 against Twilio's 0.73.
- Items resting on the user's word, unchecked: Apple allows an organizer logo on a Questify-signed pass.

## Stage 7 (2026-10-17): agent steering, done

- Hard rules: the 8 proposed rules, kept as proposed. Quality bar: Max on the core, Standard elsewhere
  (ADR-104). `rules.md` written. The root `CLAUDE.md` is unchanged (still PLANNING); the proposed
  build-phase diff is in `_blueprint/CLAUDE_BUILD_DRAFT.md`, to apply when planning is approved.
- DECISIONS.md: every accepted recommendation already has an ADR (101 to 104 this stage); no
  re-seeding needed.

## Stage 8 (2026-10-17): delivery and quality, drafted

- Phase order approved by the user (nine phases, Phase 1 = a thin core loop, Google's closed test starts
  after Phase 2). `ROADMAP.md`, `TASKS.md` (107 tasks after the Stage 9 pass; every one of the 517 FRs is delivered by at least
  one task, checked by script), `TEST_STRATEGY.md`, `RISKS.md` (18 risks) written.
- GitHub issue export: not offered (the folder is not a git repository with a GitHub remote).
- Open-question sweep: no new genuine unknowns beyond Q-079 (language switch restart) and the notes added
  to Q-031, Q-034, Q-070, Q-071, Q-076 in Stage 6.
- Legal documents (`legal/`) are left until counsel input (T-807); drafting them from templates is
  possible earlier if the user asks.

## Wireframe review round (2026-10-18)

- The user reviewed the first wireframe and asked for more customization; six brainstorm rounds plus two idea rounds
  are logged in `_blueprint/WIREFRAME_REVIEW.md`. The user approved ("that's it, now update").
- Applied: F-320 to F-348, FR-1818 to FR-1846 (546 FRs), ADR-105 and ADR-106, Q-080 (name display, counsel) and Q-081
  (ticket reply rule), 18 new tasks (125 in all, every FR covered), wizard cut to ten steps (FR-1846).
- The wireframe is being rebuilt with: clickable ten-step wizard, working tabs, view-option switches for the new variants,
  and the new screens (tickets, access types, Home editor, features, cheers, readiness, operator activity, view as organizer).

## Wireframe v2 approved (2026-10-19)

- The user approved wireframe v2 (artifact `4Y63bxDGJQwW2sZgB3NqzC`: 101 screens, ten clickable wizard steps, working tabs and view options). It is a throwaway review aid, not application code.
- Planning is complete except the user's explicit approval to end it. Until then the root `CLAUDE.md` still says PLANNING.

## Blocker research (2026-10-19)

- User chose to resolve blockers before ending planning. Done by research: T-015 / Q-046 (use Expo SDK 57; iOS minimum becomes 16.4, Q-082). Partly done: T-014 / Q-031 (Oracle Riyadh and Jeddah are live; PostgreSQL and cache availability must be confirmed in the OCI console), T-013 / Q-034 (Msegat needs a commercial registration, 3–7 + 3–7 business days; quotes still needed).
- Still needs the user: an OCI account check, written quotes from Msegat and Taqnyat, the Saudi lawyer batch.

## Hosting and SMS decided (2026-10-19)

- **Hosting:** CranL Pro, `riyadh-1` (ADR-107), with conditions before real players. **SMS:** Msegat, existing account with services and ads senders (ADR-103). **Expo SDK 57** (Q-046 answered).
- Blockers the user named are resolved enough to start. Remaining, not blocking Phase 0: the lawyer batch (T-807), the CranL written answers, Msegat's volume quote, the pending mascot images.

## Planning ended, build phase started (2026-10-19)

- The user approved ending planning. Process: `TASKS.md` + Superpowers + `cto-cycle`; Spec Kit not used (ADR-108). Quality bar: `docs/QUALITY_BASELINE.md`.
- Root `CLAUDE.md` switched to BUILD. First work: Phase 0, in `docs/TASKS.md` order (T-001 monorepo and CI, T-002 CranL staging, T-013 SMS (Msegat account exists), T-014 and T-015 done by research, T-119 draft legal text).
- Still open, not blocking: CranL written answers (T-811), the lawyer batch (T-807), Msegat volume quote, mascot images, Q-082 (iOS 16.4).

## Build log

- 2026-10-19 **T-001 done.** Monorepo (pnpm workspace: `apps/api`, `apps/web`, `apps/app`, `packages/shared`), strict TypeScript 7, oxlint, oxfmt, vitest 5, one-job CI (`.github/workflows/ci.yml`, actions pinned by SHA, gitleaks 8.30.1 with a pinned checksum), Dependabot monthly. `pnpm ci:changed` passes. Mutation check on the first real code (`apiError`) caught a broken rule; gitleaks passes a clean tree and fails (exit 1, 2 findings) on planted fake keys. The CI run itself has not happened yet because there is no GitHub remote. Local node is 24; `.nvmrc` pins 22.
- Large assets (`docs/design/assets`, `docs/design/codex-image-2`, brand-deck PDF, BRD) are in `.gitignore`; they need a separate backup.

- 2026-10-19 **T-016 done** (contract tests wait for the OpenAPI file in T-005 and later). Stryker 10 mutation testing on `packages/*` (break below 80%; `apiError` scores 100%), SBOM script (`pnpm sbom:generate`, CycloneDX), audit in CI. Findings: Stryker 10 gives false results with Vitest 5, so Vitest is pinned to 4.1.12; Stryker pulls in `qs` with known moderate issues, so `qs >= 6.16.0` is forced by an override. A planted vulnerable dependency (lodash 4.17.15) made `pnpm audit` exit 1. **Repository:** https://github.com/diax7/questify-app (public, everything in one repo, user's choice); CI passes in 26 s; GitHub secret scanning, push protection and Dependabot alerts are on.

- 2026-10-19 **T-005 done.** `packages/shared`: error envelope, cursor pagination (`encodeCursor`, `decodeCursor`, `parseLimit`), app-version compare, rate-limit header helper. `apps/api`: `registerConventions` (request id, one error envelope that never leaks causes, 426 for old apps, `Idempotency-Key` on routes marked `config.idempotent`, replay of the first answer, 409 while running, 422 on a different body, retry after a 5xx, 24-hour expiry) with an in-memory store (the database store comes with T-003). 82 tests; mutation score 88%. Not yet built: an actual rate limiter (only the headers) and the principal that scopes keys (comes with sign-in, T-006/T-107).

- 2026-10-19 **T-002 partly done.** API server entry, `/healthz` and `/readyz`, esbuild bundle and a Dockerfile (239 MB, non-root, healthcheck, base image pinned by digest) built and tested locally. Deployed to CranL Riyadh (`questify-api-staging`, Nafes project); the health URL answers over HTTPS. Databases confirmed in `riyadh-1` and not reachable from the internet. **Not met yet:** a restore from backup (CranL snapshots are too limited, ADR-107 addendum) and the secret store (environment variables are set per app on CranL). T-002 stays open until T-019 provides a restorable backup.

- 2026-10-19 **T-003 done.** `apps/api/migrations/0001_baseline.sql`: organizers, staff, organizer members, players, events, enrollments; row-level security **forced** on every table; deny by default (PUBLIC has nothing; the API role `questify_app` has explicit, minimal grants and neither superuser nor BYPASSRLS); request context set per transaction by `withRequestContext`; migration runner with checksums, advisory lock and rollback. 42 database tests (outsider, structure, tenant isolation, data rules); deliberately weakening the rules made the tests fail. CI runs them against a PostgreSQL 17 service. **Live on CranL staging** (PostgreSQL 16.15): roles created, migration applied, and `node migrate.cjs --verify` proves the API role is not a superuser, does not bypass row-level security, sees nothing when unidentified, cannot insert, and cannot read the migration table. The owner connection string and the role password are removed from the app after each migration run. Findings: the CranL `run` endpoint returns no output (read it through the app log with the `/proc/1/fd/1` trick in `scratchpad/cranl_api.py`); the CranL database user `admin` is a superuser, so the API must never connect as `admin`; passwords contain non-ASCII bytes, so connection strings must be attached with CranL's `connect` operation instead of copied. Route-level cross-tenant tests wait for the first routes (T-012).

- 2026-10-19 **T-019 deferred by the user** (no backup while staging has only fake data; before real players). T-002 closed for staging. Release gate updated in ADR-107 addendum 2.

- 2026-10-19 **T-006 done (code, tests and review; staging deploy and live check still to do).** Staff sign-in: email + password (argon2id, `@node-rs/argon2`, native, external in the bundle; the Docker image installs it with `pnpm deploy --legacy --prod`), then a six-digit code by email, then a `__Host-` session cookie. Migration `0002` (tables `staff_login_challenge`, `staff_session`, `auth_throttle`; forced row-level security; column grants so the API cannot create accounts or change `platform_role`/`status`; a trigger so a revoked session stays revoked). Sign-in finds exactly one row before identity is known through three narrow settings (`withPreIdentityContext`); the wall is thinner there and `SECURITY.md` says so. One sliding-window throttle (8 failures per email and 30 per address in 15 minutes, counted across challenges; IPv6 as /64), 5 code attempts per challenge kept across resends, 5 challenges an hour, 4 password checks at once. Idle expiry 30 minutes (admins 15), maximum age 12 hours (admins 8), checked against the user's current role on every request; 10 live sessions; list and end sessions. Default-deny staff scope with an explicit public list (route-walk test). Email: Gmail SMTP primary, Resend backup (needs a verified domain, so off until one exists) as a time-limited exception to the in-region rule (Q-083). `staff` CLI (`create`, `clear-throttle`) for the first accounts. Config is required and fails fast; `TRUST_PROXY_HOPS` is required in production.
  **Review:** plan 78 -> 88 (two rounds), phase 1 code 92, phases 2 and 3 code 88, fixes 94 (CTO sub-agent). Findings fixed: a malformed email gave 500; request logs carried the client address; failures could have been rolled back by the error that reported them; a throttle that checked before recording; lock columns that leaked account existence; a missing default-deny scope; native argon2 breaking the image build. Deviations from the plan are listed in the plan's "As built" section.
  **Tests:** 468 (unit plus integration against a real PostgreSQL, none skipped). **Mutation (run under `ci:full`, about 35 minutes):** 93.2% overall; core auth files: keys, limits, http-errors, templates, resend, failover, smtp, verify-gate 100%; routes 98.9, staff-store 97.8, throttle 96.8, normalize 93.7, staff-admin 93.5, password 93.1; after the last tests and written exceptions (equivalent boundary mutants on a moving clock, branches made unreachable by foreign keys, guards the database repeats) a targeted rerun gave sign-in 95.7 and session 96.8. `ci:changed` no longer runs mutation (too slow with database tests); it is part of `ci:full`.
  **Open for T-006:** deploy to staging, run `migrate.cjs`, create a throwaway account with `staff.cjs`, sign in once over HTTPS, delete the account; needs the Gmail app password in the CranL secret store (Dhia). **Follow-ups recorded:** T-020 (password reset, breached-password check), T-004 (sign-in events into the audit log), T-011 (the dashboard proxy and the real proxy-hop check), T-018 (alerts for email down, throttle spikes, one address key carrying most traffic).

- 2026-10-19 **T-007 done.** Configuration service. `packages/shared/src/config`: the registry of features and tuning numbers the reviewed app contains (FR-1504), `composeConfig` (shipped defaults, then platform settings, then the event; a lower level can only narrow a higher one; add-ons stay hidden until unlocked; out-of-range numbers fall back to the default; sorted keys so equal inputs give an equal document), strict save-time validation (unknown features, out-of-range numbers, blank messages, bad versions and typos refused, every problem reported), tolerant reading of stored data, and `parseComposedConfig` for the app (drops blocks it does not know, refuses a document it cannot read so the app keeps its last working copy). API: migration `0003` (`platform_setting`, `event_entitlement`; forced row-level security; only a Questify admin writes platform settings and unlocks), `GET /v1/config[?event=<id>]` with an ETag and 304, a 15-second server cache (a change reaches every copy of the server within that time, the copy that saved it at once), and save functions for admins (platform settings, unlock or lock an add-on) and organizers (their own event's feature switches). **Design point:** add-on unlocks are in their own table, not `event.config`, because the organizer can edit that column and must not unlock paid features for themselves; a test proves it through the database rules and the validator. A private event's configuration answers 404 exactly like a missing one. **Tests:** 593 in total; mutation on the configuration source 98.5% (note: with per-test coverage analysis Stryker under-reports code whose result is cached by an earlier test, so configuration runs use `--coverageAnalysis off`). Not built (belongs to later tasks): admin screens and routes that call the saves (T-703, T-602), maintenance mode and banner (T-703), the translation bundle (T-008).

- 2026-10-19 **T-008 done.** Translation store. `packages/shared/src/i18n`: the shipped Arabic and English texts (`MESSAGES`, with a test that both languages carry the same placeholders and no Arabic-Indic digits), `placeholdersOf` and `interpolate`, `toWesternDigits` and `formatNumber` (Western digits in both languages, asked for explicitly because some devices default Arabic to Arabic-Indic), `validateTranslation` (a save that removes or renames a placeholder is refused, naming it; blank means "use the shipped text"; digits normalized), and `createTranslator` (the admin's text only when it is usable, otherwise the shipped one, so blank, missing, damaged or unreachable values never leave a hole). API: migration `0004` (`translation`, forced row-level security, read by all, written only by an admin), `GET /v1/translations` with an ETag, a 15-second cache, and an admin save that checks every language before writing anything. Shared ETag helpers (`etag.ts`). **Tests:** 686 in total; mutation on the new code 97.9 to 100% per file. The ETag, 304 and admin-only rules are proven in tests against a real database. Not built here (later tasks): the matrix editor (T-702), plural forms (T-117), date and time formatting in Western digits (with the first screen that shows a date).

- 2026-10-19 **T-009 built, device run pending.** Expo app shell (`apps/app`) on **Expo SDK 57** (React Native 0.86, Expo Router 57, development-build ready; SDK 58 came out on 2026-10-15 and waits, see `TECH_STACK.md`). Five tabs (Home, Quests, Ranking, Shop, Profile) that mirror in Arabic; design tokens (`src/theme/tokens.ts`: the deck's seven colours plus two derived neutrals marked for confirmation, spacing, radius, type scale) with a contrast test; Baloo Bhaijaan 2 and Rubik shipped from the `@expo-google-fonts` packages; every text comes from the shared translator, numbers in Western digits; language follows the phone (any other phone language starts in English) and the player's saved choice wins; **ADR-110** (the user chose "ask, then restart" for Q-079). Checks that need no phone: types, lint, 24 tests on the pure logic with 97% mutation, `expo-doctor` 21/21, and Android and iOS bundles that compile to Hermes bytecode (pnpm workspace, `#src` imports and the shared package all resolve). **Still open for T-009:** the run on a real iPhone and a real Android phone in both languages. Needs (Dhia): sign in to Expo (`eas login`, then `eas init`), then an Android development build; the iPhone also needs the Apple Developer account and a registered phone (T-010). `eas.json` has the `development` profile only.

- 2026-10-19 **Foundation review and fixes (ADR-111).** An independent reviewer read and ran the whole Phase 0 foundation: 79/100, "solid with fixes", nothing reachable from outside. It proved live that the API's database role could set a player's own points, lift a ban, join a private draft event, and let an editor make themselves owner. Fixed in migration 0005 (column grants and guard triggers, contact details in `player_contact`, owner-only team changes) with a test for each probe; plus explicit filters in the sign-in queries, one connection helper with the context in one round trip, app-wide route access (a route without `config.access` stops the server; public routes listed exactly), a 204 idempotency fix, the pool size as a setting, the app's restart-loop and splash guards, CI that fails if the database tests would be skipped and now runs the API build, and an API image that installs only the API's packages. The API type check now covers its tests too. User decisions: mutation testing on the core only; T-017 and T-018 stay in Phase 0. Language switch now restarts with Expo's `reloadAppAsync` (the Expo Go "ExpoAsset" error on switching to Arabic).

- 2026-10-19 **T-004 done.** Append-only audit log (migration 0006): no role can change, remove or truncate an entry, the database owner included (triggers set to fire always, tested); the API inserts only named columns, so it cannot backdate or renumber, and only in its own name and organizer (no `system` entries from the API); an organizer reads its own entries, including a Questify admin's support work in its events; no foreign keys, so an event's history outlives it. `recordAudit` writes in the change's own transaction and refuses secrets and contact details at any depth (the change rolls back too). Wired: platform settings, event switches, add-on unlock and lock, translations, staff session open and end, the staff CLI; a save that changes nothing writes nothing. Failed sign-ins stay in the server log. Retention and the player anonymisation path: Q-084. 830 tests; audit mutation 97%. CTO plan review 84, code review 93 (GO); its three minor fixes applied.

- 2026-10-20 **T-012 done.** `apps/api/test/security/`: the outsider suite reads the live catalog (every table, sequence, function, schema); the cross-tenant suite classifies every table as owned or shared and proves, from organizer, staff and player seats, no reads beyond what is public by design, no filtered or bare writes (including from a seat that owns nothing and from A's real seats with test-only detector triggers), no forged inserts, and exactly where the retention sweeps stop; the route suite lists every route with how it keeps callers apart. A new table or route fails CI until classified. Nine planted leaks, all caught. 925 tests. CTO review 86, then 93 (GO).
- 2026-10-20 **T-009 Expo Go finding.** The Arabic switch "did nothing" on the user's phone: Expo Go resets the right-to-left setting on every launch, and the restart guard then fell back to English. The app now keeps the chosen language for the texts; the full mirror needs a development build (ADR-110 note). `extra.supportsRTL` set.
- 2026-10-20 **Arabic layout confirmed on the user's phone (Expo Go).** Each screen frame takes the language's direction and text starts from it (no fixed `textAlign`, which React Native reads relative to the container and so flipped Arabic twice). The tab bar keeps one order in both languages (user's choice, ADR-110 note).
- 2026-10-20 **T-011 started.** Plan `docs/plans/2026-10-20-t-011-web-shell.md` (Next.js 16.4, language in the URL, our own `/v1` forwarder, sign-in screens, Playwright on desktop and phone); CTO plan review 84, then 93 (GO).
- 2026-10-20 **T-011 built, staging check open.** `apps/web`: Next.js 16.4.2 (React 19.2.3, one React across the repo), pages under `/{ar|en}` with `<html lang dir>` from the server, a `/v1` forwarder (allow-listed headers both ways, 1 MB cap, 15 s timeout, no retry, `X-Forwarded-For` passed through, API reached on its internal address only, ADR-113 Proposed), two-step staff sign-in (password, emailed code, resend countdown, Arabic-Indic digits accepted), a signed-in home (organizer names now in `/me`), sign out, CSP with a per-request nonce. Design tokens moved to `packages/shared`. 51 unit tests, 12 browser tests (desktop and a 360 px phone, both languages, keyboard only) on the standalone build the Docker image ships; CI builds the web app and runs the browser tests only when web, shared, API source or migrations change. CTO code review 93 (GO). **Open:** staging deploy and the real-iPhone and Android check, which waits on a working email sender (ADR-112, T-021).
- 2026-10-20 **Email decision (ADR-112).** Gmail API from `questify@nafes.com` (nafes.com already has Workspace, SPF, DKIM and DMARC); dashboard on `questify.nafes.com`; setup steps in RUNBOOK; T-021 builds the sender.

- 2026-10-20 **Staging is live with the new code; T-021 done.** API migrated (0002 to 0006) and verified, owner connection removed afterwards. Web app `questify-web-staging` at https://questify-web-staging-4ecphq.cranl.net (Dockerfile.web at the repo root: CranL builds from the Dockerfile's folder). Email from `questify@nafes.com` via the Gmail API: SPF, DKIM, DMARC PASS. Admin account for the user created with a generated password sent by email. The user chose the CranL address for now; `questify.nafes.com` is attached for later.

- 2026-10-20 **T-011 done.** The user signed in on an iPhone and an Android phone in both languages. Forged `X-Forwarded-For` values did not escape the per-address throttle on either path (ADR-113 proven). Phase 0: 12 of 21 tasks.

- 2026-10-20 **Autonomous build started** (user away for some days; INBOX entry). Store accounts (T-010) and SMS
  (T-013) skipped until the user returns; SMS is built behind its adapter with a fake.
- 2026-10-20 **Swappable visual theme (NFR-024).** The adventure look is one `Theme` value in `packages/shared`
  (colour roles, font roles with weights, text scale, spacing, radius); the app reads it through `useTheme()` /
  `useThemedStyles()`, the web through CSS variables; contrast and Arabic line-height contract tests run for every
  registered theme, and a web test refuses raw colours in style sheets. A new look is a new value plus its fonts.
- 2026-10-20 **T-015 done.** Expo SDK 57 meets every current App Store and Play rule (`docs/compliance/EXPO_SDK_CHECK.md`);
  required-reason APIs added to `app.json`. Before the first TestFlight upload: data types in the privacy manifest;
  move to SDK 58 before Apple requires Xcode 27 (expected spring 2027).
- 2026-10-20 **T-119 done.** v0.1 player terms, privacy policy and community guidelines in `docs/legal/` (Arabic
  first); questions for counsel in its README and Q-085; contradictions found went to Q-086 and Q-087.
- 2026-10-20 **T-020 done.** Password reset by emailed link (fragment token, 30 minutes, one use, one per person,
  same 202 for every email, work after the answer drained on shutdown), change while signed in (keeps this
  session, ends the others), breached-password check on every set including `staff-cli create` (Pwned Passwords,
  k-anonymity, 3 s, one retry, fails closed), product names and the email's name refused, a "password changed"
  notice, reset clears the sign-in lockout (RUNBOOK "A locked-out admin"). Migration 0007. Web: forgot-password,
  reset-password, account pages. CTO: plan 84 → 94, code 88 (one real bug: sign-in deleted pending reset links,
  fixed with a test) → fixes sent. API 843 tests, 20 browser tests.

- 2026-10-20 **T-101 done.** Organizer sign-up (email, password, organizer name, the three organizer documents, then
  the emailed code; the same answer for an email that already has an account, which gets a note with no code),
  creating another organizer while signed in, the team (invite editors by email with an optional event limit,
  change limits, remove, leave), owner transfer by owner invite, and invite acceptance with an existing or a new
  account (a new account still signs in with an emailed code). Migration 0008: the organizer context now comes from
  the caller's membership in the database (a forged organizer id opens nothing), editor event limits apply to events,
  enrollments, players and event audit entries, members join only through invites, and sign-up completes only with
  the HMAC of the emailed code. A daily budget of 400 sign-up and invite emails keeps sign-in codes deliverable.
  Organizer drafts (terms, DPA, content rules) served by the web app. CTO: plan 82 → 93; phases 93, 93, 92 (GO).
  Bugs found on the way: a sub-select in the event and enrollment rules made PostgreSQL report infinite recursion;
  an editor leaving could not write their own audit entry after the delete; the invite page re-checked its link after
  acceptance and lost the code step.
- 2026-10-20 **T-102 done.** The event builder: create, edit and delete events (kind, names and venue in either
  language, time zone, event-day start hour, access, join methods) from the dashboard, with times typed as the event's
  own wall clock and shown with its zone ("Fri, 1 Nov 2030, 09:00 (Dubai time)"). Migration 0009: the API's role can
  never write `status` (new events are always drafts), times lock once an event starts or ends, only drafts are
  deleted, the owner ends a live event early, and the API moves events from scheduled to live to ended every 30
  seconds, audited. CTO: plan 86 → 94; phases 92, 92, 92 (GO). Bugs found on the way: impossible dates (30 February) were
  accepted; a time read back with less precision than stored looked like a change, so an event ended early could not
  be renamed.
- 2026-10-20 **T-103 done.** The quest builder: categories (add, rename, reorder, delete with a choice to move or
  delete their quests; every event has a General category) and quests (scan a QR, enter a code; bilingual title and
  description, points, a repeat cap, an opening window in the event's zone, show or hide, move between categories,
  reorder). Migration 0010; the shared quest-type registry, which each later quest task extends with its player flow
  (FR-1505). In a live event every change asks for a confirmation; an ended event is shown and not changed. Entry codes
  never reach the audit log. CTO: plan 88 → 94; phases 93, 93, 88 → 95 (GO). Bugs found on the way: an editor of two
  events could have edited a live event's quest through a draft event's path (closed before code: every child row is
  read under the path's event); the builder's dialogs opened off-screen on a phone with no focus (now focused and in
  view, focus returned after).
- 2026-10-20 **T-104 done.** Quest QR codes: each scan quest has a signed code (`{dashboard}/q/{token}`: the quest,
  its code version and a 128-bit HMAC under the new `QR_SECRET`), checked strictly and bound to its quest; "New code"
  bumps the version so the printed one stops working at once. The dashboard's Print codes page draws them (`uqr`),
  prints or saves them as PDF through the browser, downloads each as SVG; a phone camera that scans a code outside the
  app lands on a page that says to scan it inside the app. Migration 0011. CTO: plan 87 → 94; phases 93, 92 (GO).
  T-105 verifies scans with `verifyQuestCode` and compares the version. Waiting on Dhia: ADR-115, ADR-116, and
  `QR_SECRET` in staging.
- 2026-10-20 **T-105 done.** The completion engine: a player with a session completes a scan or entry-code quest
  through `POST /v1/quests/{id}/complete`. One database function, the only writer, checks enrollment, event, quest,
  proof and cap under a lock on the player and writes the completion and its points; the points ledger is append-only
  for every role and the score and balance are trigger-kept sums of it. Retries never pay twice (the key is stored with
  the completion), two scans at once pay once (proven over 25 connections), wrong typed codes are limited per quest,
  player and install. No player can sign in yet (T-107 waits on Msegat), so the route sits behind a session lookup that
  T-107 will issue tokens for. Migration 0012. CTO: plan 83 → 94; phases 93 → 95, 95 (GO). Bugs found on the way: a
  replay check that hashed the route pattern instead of the path (one quest's answer could replay for another), and a
  plpgsql variable named `found` that shadowed `FOUND`.
- 2026-10-20 **T-107 done (server side).** Player sign-in: a six-digit code by SMS to a Saudi mobile (Msegat) or by
  email, a profile step for a new contact (username and birth year; under 13 refused), then a 1-hour access token and a
  180-day refresh token that rotates on every use; a reused refresh token ends that device's sign-in. The answer to a
  code request is the same whether or not an account exists. Limits per number, install and address, and platform
  ceilings for SMS (5,000 an hour, Q-093) and player email (1,000 a day, ADR-117). A security sweep found that definer
  functions could be fooled by a caller's temporary table of the same name: migration 0014 closes it for every
  function, and a test fails the build if a new one is not pinned. The Arabic brand name in emails and SMS now follows
  ADR-019 (كويستفاي; the emails had a misspelling). Migrations 0013, 0014. CTO: plan 83 → 94; phases 87 → 95, 93 (GO);
  mutation 96%. The sign-in screens wait for the app shell (moved to T-111). Local test runs needed more database
  connections (`compose.yaml`: 300).
- 2026-10-21 **T-106 done.** Live rankings: each event's ranking orders players by points, ties going to whoever
  reached those points first (the ledger decides, no clocks). A Redis copy per event (ADR-118, Dhia's call: "Redis
  now") answers the top 10 and "my place" in one round trip and is kept current after each completion (the completion
  answer now carries `rank`). PostgreSQL stays the truth: when Redis is down every answer comes from PostgreSQL in the
  same order, and a lost copy is rebuilt without losing writes that land during the rebuild. Banned and removed players
  and the organizer's own team never appear; every change of who may be ranked marks the event for repair through
  database triggers, and a repair job rebuilds within seconds. The owner hides or shows the ranking from the event page
  (FR-607). Measured at 20,000 players: per-row rules took 1.7 s, now about 50 ms (the Redis-down path only).
  Migration 0015. CTO: plan 82 → 93; phases 92, 87 → 94, 93; mutation 92%. A full disk stopped the work for an hour: killed mutation
  runs had left thousands of test databases inside Docker (105 GB); test databases now carry their creation time and
  stale ones are swept (memory note `stryker-stop-cleanup`).
- 2026-10-21 **T-109 done.** Usernames and avatars: a new player picks a username, one of the six default avatars and
  a birth year. Names that read alike (case, أ/إ/آ, ة/ه, ى/ي) count as one; a word list in Arabic and English blocks
  offensive names (started from an open list and reviewed: Dhia's call, ADR-119; false positives like "therapist",
  "basement" and «فرج» were cut). Every name a player had is kept; a rename is allowed once every 30 days and only
  while Questify allows it. The review found the API's database role could still rename players directly, skipping
  the filter: that right is gone, and only the checked functions write names. Other players only ever see the
  username and avatar. Migration 0016. CTO: plan 78 → 93; phases 92, 94; mutation 94%.
- 2026-10-21 **T-110 done.** Consent before data: the sign-in screen must send the terms and privacy versions the
  person accepted, or nothing is stored, counted or logged; the server tells every app which versions are in force
  (`/v1/config`), so a new version needs no app release. Each acceptance is kept with its version and how it was
  given (sign-up, sign-in, re-acceptance, before a first submission); a player sees only their own. The three
  player documents and a contact page are on the web in both languages; the contact page honestly says the details
  are being prepared (a release gate, STORE_COMPLIANCE §4). Migration 0017. CTO: plan 84 → 93; phases 94, 93,
  94; mutation 93.6%. Questions for counsel: Q-095.
- 2026-10-21 **T-111 server half done.** Joining an event: by its code (typed, scanned from the join QR or opened
  from the invite link) or from the public list; anyone can browse public events and their quests before signing in;
  the join card says what the organizer will see, and its version is kept with the membership; a private event's
  joiner waits for approval (T-218). Scoping found a hole that had been in the database since the start: a signed-in
  player could add themselves to any event, private ones included, and an organizer could add any player to their
  event and so read that player's row. Nothing used it yet; now only one checked database function adds members.
  Wrong codes are limited per address and per player; right codes cost nothing, so a crowd's correct scans never
  use up the limit. Migration 0018. CTO: plan 84 → 94; phases 93, 92, 93; mutation 97.8%. The app screens wait for the app
  shell (T-009).
- 2026-10-21 **T-208 done.** Bans, the exclusion list and leaving. The owner bans a player from an event (they leave
  every board, cannot earn or join again, their points record stays) and can lift it; a player who left can still be
  banned, so leaving never dodges a ban. The exclusion list keeps phones and email domains (the organizer's staff,
  sponsors) off the boards while they still play; phones are shown masked to everyone. A player can leave an event.
  The dashboard has a Players page in both languages. The birth-year gap found in T-111 is closed: organizers now see
  only what the join card tells players they will see. Two older faults fixed on the way: editors could change a
  player's standing directly with no audit entry, and a ban or a player leaving left no mark for the board to repair
  until the 5-minute backstop. Redemption pausing moved to T-209 (nothing to pause yet). Migration 0019. CTO: plan
  84 → 94; phases 92, 93, 92; mutation 93.2% (moderation alone 91.5%, then three more survivors killed by tests).
- 2026-10-21 **T-108 server half done.** A player can change their phone or email, or add the second one, with a
  code sent to the new contact; the account takes it only with the right code. Nothing says whether another account
  already has that contact until its code comes back, so the feature cannot be used to find out who has an account. The
  old number or email and the other channel get a notice (SMS or email, both languages) on every change, so a change
  made from someone else's hands is seen; the old contact is not asked for a code (a player who lost their number could
  not give one: ADR-120, Proposed). The API can no longer write contacts directly; every change is audited without the
  contact. The profile now shows masked identifiers. Migration 0020. CTO: plan 80 → 94; phases 93, 93, 95; mutation
  92.2% on contact.ts, 91.5% on profile.ts. The screens wait for the app shell (T-009).
- 2026-10-21 **T-112 web half done.** The event web page `/{lang}/e/{CODE}`: what the join QR and the invite link
  open on a phone without the app. It shows the event, its code, what the organizer will see, and the way to the
  stores; WhatsApp and social apps get a preview with the event's name, place and date and a brand image (tested as a
  WhatsApp bot reads it); unlisted and private events stay out of search; an unknown code says "not available" in both
  languages; when the API cannot answer, the code and the buttons still work. The store buttons wait for the store
  listings (T-010: two web settings), and the app's side (the Android referrer, the iPhone paste) waits for the app
  shell. CTO: plan 81 → 93; phases 92, 95. Found: the Arabic brand spelling drifts in six older strings (Q-098, ADR-019).
  One flaky e2e seen once (the players page on the phone layout, under the full suite; it passed alone and in the next
  full run): watch it.
- 2026-10-21 **T-111 app half built.** The app can now sign a player in (consent, a phone or email code, the profile
  step), keep them signed in safely (tokens only in the phone's keychain, never in a backup; a reinstall starts signed
  out; a lost network does not sign anyone out), open an event's join card from a code, a pasted or shared link or the
  public list, join (after sign-in when needed, and only then), switch between joined events, accept new terms on
  launch and sign out. Arabic-Indic digits work in the code and the birth year. Not yet run on a phone: that is
  T-009, which needs Dhia. CTO: plan 82 → 93; core 88 → 94; screens 84 → 94; mutation 89.6% on the session core.
- 2026-10-21 **T-113 built.** Inside an event the app now has its own bar (Home, Quests, a round Scan button that says
  "coming soon" until T-115, Rewards, Profile; one order in both languages), an event pill on every tab that switches
  events or goes back to Questify home, and the event's Home: a countdown with the right Arabic forms, points,
  balance and progress, a ranking card that opens a plain ranking screen, Up next with Go, and an information page
  that opens the maps app. The app opens in the live event used most recently on the phone. Organizers can pin one
  quest as Up next in the builder. Not yet run on a phone (T-009): also check there that event times show in the
  event's zone (Hermes `Intl` time zones). CTO: plan 79 → 93; phases 94, 95, 92 (its four fixes applied).

- 2026-10-21 **T-114 built.** The Quests tab lists the event's quests by category; each category opens and closes and,
  closed, shows the points earned of those available and the quests finished. Each quest has a card and a details
  sheet saying how it is verified. Entry-code quests can now be completed in the app: the player types the code and
  gets the points (the first quest playable end to end on the phone). Scan quests wait for T-115. The server decides
  each quest's state on its own clock, so Home and the tab agree; a member waiting for approval is told so and keeps
  the event. Quests have no location, time, difficulty, tips or steps yet (Q-102). Not yet run on a phone (T-009).
  CTO: plan 86 → 94; code 92, with its fixes applied.

- 2026-10-21 **T-115 built.** Players can scan a quest's printed QR code inside the app (live camera only), see
  "Scanned! Checking…" at once, then their points with a celebration, or the reason in clear words; finishing a whole
  category plays a full-screen one. Home's points count up to their new value, and a points history lists every point
  earned. Reduce Motion turns all of it off. Android now asks only for internet, vibration and the camera (Expo's
  default storage and overlay permissions are blocked). Not yet run on a phone (T-009): the camera and haptics need a
  real device. CTO: plan 88 → 94; code 92, its fixes applied.

- 2026-10-21 **T-116 built.** The ranking screen shows the top 10 with each player's avatar, the player's own row
  highlighted, and their own row as an 11th with their real rank when they are lower; all of it fits one screen on
  every phone, with no scrolling, and refreshes every 15 seconds while open. Dhia decided the app has one font at one
  size for everyone (ADR-121). Not yet run on a phone (T-009 now lists every on-phone check). CTO: plan 86 → 93; code
  93, its fixes applied.
- 2026-10-21 **T-117 built.** Each event names its currency (both languages, singular and plural, one of five icons)
  and what players and operators are called, from an "Event words" section on the event page with a live preview.
  The app, the quest builder and the players page use those words; sentences that would need Arabic grammar around a
  renamed noun were rephrased (ADR-058). Found and fixed: an unlisted or private event's configuration never reached the
  app, and Home and the ranking read its ranking as off; a player now reads it through `GET /v1/events/{id}/config`
  (ADR-122, Proposed). Q-105 holds the star-vs-XP icon and quest/category renames. 2366 tests, 64 browser tests,
  `expo export` clean; mutation not run (not core, Token budget rule 4). CTO code review 88, then 93 (GO).
- 2026-10-21 **T-118 scripted half built.** `apps/api/test/loop/first-loop.int.test.ts` drives the first loop through
  the real routes: an organizer signs up and builds an event with a QR quest, two players sign up by SMS and join by
  code, one scans, the balance and both rankings update (Redis and PostgreSQL rankings). Found: a player with no points
  is not ranked, so their own row is absent until a first completion (as designed, ADR-052). The phone run is in
  `RUNBOOK.md` and waits on Dhia (staging migrated, a development build). Sonnet code review 86; its fixes
  applied (the dev-client steps, a Redis-only rank check, an exact join check), about 94 by its own estimate.

- 2026-10-22 **T-201 and T-202 done** (one CTO cycle: plan 84 → GO; code 93, GO). Migration 0024: `reward` (stock left derived as `stock_total − units_out`), `redemption`, the `redeem` and `redeem_return` ledger kinds (balance only, ADR-043), `reserve_reward`, `cancel_redemption` and `expire_one_reservation` on the lifecycle tick (one reservation per transaction, ADR-133, Accepted). The dashboard's Rewards page and the app's Rewards tab. 2514 tests, the rewards browser test on desktop and phone, `expo export` clean; mutation 96.3% on `apps/api/src/rewards` (550 of 571). Found by the browser test: saving the shop settings sent empty rules as null and got 400; fixed (`shopRequest`). ADR-134 (spending lowers rank, FR-1847) arrived after the review and became T-219. Docker Desktop stopped at 00:02 during the first mutation run; Postgres needed a restart and 640 leftover test databases were dropped.

- 2026-10-22 **T-219 and T-203 done** (Dhia asked for both in one session; one CTO cycle: plan 84 → 93, code 93, GO). Migration 0025: each event's "spending lowers rank" (owner only, locked from live; only live-time spends move the score, ADR-135 Proposed, Q-106), digital rewards with encrypted codes delivered at once (ADR-136 Proposed; new secret `REWARD_CODE_SECRET`, required at start). Dashboard: the switch, the code upload, the low-codes banner; the reward forms now work on phones (a T-201 layout bug). App: the rank note on confirm, the code shown at once and kept in My rewards. Tests: 22 database, 13 route, unit, the rewards browser test on desktop and phone, `expo export`; mutation 98.35% on `apps/api/src/rewards`.

- 2026-10-22 **T-204 and T-205 done** (Dhia asked for both; one CTO cycle: plan 86 → 93, database and API 92, dashboard and app 86 → 93 after its two majors), not yet run on a phone. Migration 0026 (operators, invites, the fixed My QR, one completion engine, operators off the boards), the owner's operator routes and the player's claim, the station scan, the dashboard's Operators page and `/op` page, the app's operator mode, station scanner, claim screen (through sign-in), My QR. Dhia's answers: email-only invites (ADR-138), a fixed My QR with prizes needing the player's in-app accept (ADR-137); ADR-139 Proposed; FR-306, FR-307, FR-901 amended; Q-107 (booths). Tests: 23 database, 31 route, unit, the operators browser test on desktop and phone, `expo export`. Mutation: about 94% on 576 of 683 mutants before a worker crash; a full rerun is owed (memory note on the crash). Not pushed.
- 2026-10-22 **T-210 and T-212 done** (Dhia asked for both; built earlier by background agents in worktrees, finished, merged onto T-204/T-205 and into `main`, not pushed). T-210: migration 0027, activation requests, the console under `/v1/admin/`, hard and soft player limits; CTO code 92 GO, fixes folded in (one player's last-seat race, audit `before`, console id guard; Q-116 console read audit, Q-117 times after activation). T-212: migration 0028, join fields and answers, guest list with an exact lookup, guest-list-only and domain locks, welcome reward; CTO code 91 GO, fixes folded in. Merge fixes: 0028 had dropped `operator` from `joined_via`; a playing operator takes a seat (`event_full`); 0026 changed in place (never deployed). New task T-220 (FR-1708). 2869 tests, 68 browser tests. Mutation (2026-10-23): `src/activation` 97.4%, `src/join` + `packages/shared/src/join` 90.9%; leftovers cleaned; Stryker now skips `.claude` (the worktrees broke its test finder). Heavy checks run on GitHub by hand from now on (ADR-149: `full.yml`, `mutation.yml`, free while the repository is public). **Not done:** browser tests for the console and the Joining page; the two worktrees under `.claude/worktrees` can be removed.
- 2026-10-23 **T-206 done** (one CTO cycle: plan 86 → 93; code 92, GO, its fixes folded in), not yet run on a phone. Migration 0029 and `src/desk`: the event's one prize desk (place, pin, optional hours, how players confirm), `handed_over` through one handover body that checks the operator, the player, the desk's hours, the mode and the deadline under the locks, the operator's cancel, desk hours closing items and experiences (FR-1717), item rewards needing the desk's place (FR-1716). Dashboard: the desk card. App: the Desk tab, Collect, the accept card on My QR (asks the server only in desk-offer events, at most 3 minutes). Dhia: the owner picks Collect first or Desk offer, no undo, hours optional (ADR-150); ADR-151 Proposed. Tests: 51 database and route desk tests (the races included), unit tests, the rewards browser test on desktop and phone (68 browser tests), `expo export`; Full checks green on GitHub after two test-teardown fixes (a test's own pool now closes before its database is dropped; a race test's refused side is handled at once). Mutation: 96.95% on `src/desk` and `rewards/builder.ts` (desk.ts 98.2%, after unit tests that took it from 73.7%; routes.ts 93.1%; builder.ts 97.2%). **Pushed to branch `t-206-prize-desk`, not `main`:** the push to `main` waits for Dhia.
- 2026-10-23 **T-207 done** (CTO plan 93; CTO code 68 → 94 GO; the blocker (a quest replay reaching another event) is fixed with `expected_event` and tests, minors folded in), not yet run on a phone. Migration 0030 and `src/awards`: manual awards by operators and staff inside the owner's caps (per award, per day; the owner uncapped), removals with a reason by owners and editors (score and balance never below 0, a clamped removal refused while a prize is reserved), bulk awards to a list or a quest's completers, the report. Dashboard: record, Award and Remove on the Players page; the Awards page. App: Tools → Manual award; history shows awards and removals. Dhia's answers in ADR-152; Q-118 (editor bulk inside the per-award cap). FR-320 and FR-1712 amended; FR-1602 moves to T-401; notes on T-214, T-217, T-401, T-505. Tests: database, route, unit, 70 browser tests, `expo export`; mutation 98.4% on `src/awards`. A bulk preview no longer resets when the amount is typed (found by the browser test). Not pushed.
- 2026-10-23 **T-209 done** (CTO plan 88 → folded; code 93 GO, its fixes folded in: a held player's accept reads as no live offer, the paused message tested in the app, a removed account never in a same-phone case), not yet run on a phone. Migration 0031 and `src/flags`: same-phone and burst flags raised by a trigger on every completion (never blocking play, FR-329); the Flags page (clear; close after removing points; the owner pauses or bans); the desk holds a flagged or banned player's items alike ("Held, ask the owner"; never naming the ban: CTO MAJOR), the owner's per-player pause (reserve, Collect and handover) and per-event hold switch; the desk finds by username or phone (FR-1848). FR-331/332 move to T-303, FR-334 to new T-812. ADR-153 to 156 Proposed; Q-119 to Q-121. Tests: database (29 new, races deterministic), route, unit, outsider and cross-tenant, 72 browser tests (desktop and phone; also fixed a flaky players test), `expo export`, the full API/app/web/shared run (3208); mutation `src/flags` 96.6%, `src/desk` 97.8%. Also fixed T-207's `awards.kind.redeem_return` key that broke the key-name test. Not pushed.
- 2026-10-23 **T-211 done** (CTO plan 86 → folded; code 92 GO; minors folded), not yet run on a phone. Migration 0032 and `src/rehearsal`: rehearsal accounts join a Draft or Scheduled event with the event's rehearsal code (XXXX-XXXX, at most 25, no seat, no welcome; a real member cannot rehearse with that account); every writer calls `ensure_rehearsal_wiped` first; rehearsal plays like live (shop open, desk hours ignored, digital rewards show a test code and never spend a real one); at go-live (the tick's own step, or the first live write) one wipe deletes the rehearsal accounts with their completions, ledger entries, reservations, handovers, flags and awards, recomputes stock and repairs the ranking, audited with counts; the team can erase earlier. The ledger's one exception (ADR-157): only that wipe may delete rows stamped `rehearsal`. Dashboard: the rehearsal card (code, change, erase, the go-live notice) and a Players badge; deleting a quest or draft with rehearsal data says "Erase rehearsal first". App: one code box for both codes, the rehearsal join, the strip on player and operator screens, "Rehearsal ended. Join to play.". ADR-157 to 160 and Q-122 to 125 Proposed (NFR-019 sentence Proposed). Tests: 29 database (races at the start, the ledger exception, FK and writer coverage guards), 9 route, unit, outsider and cross-tenant, 74 browser tests, `expo export`, the full API/app/web/shared run (3287); mutation `src/rehearsal` 92.8% (rehearsal.ts 100%, routes 91.1%, service 90.2%). Not pushed.
- 2026-10-23 **T-213 done** (not core; Sonnet code 86 → fixed), not yet run on a phone. Migration 0033: `enrollment.goal_reward_id`, written only by `set_goal` (a member pins one reward of the event's shop, or clears it). `PUT /v1/events/{id}/goal`; the shop gains `goalRewardId`; Home gains `goal` (the pinned reward while it is in the shop, with what is left; else the cheapest reachable reward not yet affordable; none with the shop off). App: Pin as goal / Unpin on reward cards, the goal card on Home opening Rewards. Shop sections were already built (T-201); FR-522 moves to T-304 (ADR-161, Q-126 Proposed). Tests: 6 database, 3 route and 2 Home over HTTP, unit (`pickGoal`, app parsers), the API/app/shared/web run (3136 + 178), `expo export`. Not pushed.
- 2026-10-23 **T-214 done** (CTO plan 80 → 93 GO; code 93 GO; minors folded), not yet run on a phone. Migration 0034 and `src/results`: rank prizes per rank range (locked once live), the owner's confirmation after the end against the places seen (freezes them and stops removals; races with removals tested both ways), the reveal with the owner's claim deadline giving winners price-0 desk items, the official rules as a fixed block built from data (store gate §1.12) plus the organizer's text on a public page and in the app. Dashboard: Prizes and results. App: the win card, rank prize items, the desk label. ADR-162 to ADR-165, Q-127 to Q-131 Proposed (Q-131: counsel on the winner wording); FR-1707, FR-1718 (push left to T-501), FR-1719 amended; notes on T-501, T-307, T-217. Tests: 29 database, 7 route, unit, security suites, 76 browser tests, `expo export`; mutation 92.6% on `src/results`, `rules.ts`, `desk.ts` (one worker crash; orphans and 75 test databases cleaned). Not pushed.
- 2026-10-23 **T-216 done** (not core: no plan review; Sonnet code 91 GO; minors folded), not yet run on a phone. Migration 0035: today's ranking read from the append-only ledger (points inside the current event day, the overall tie rule and exclusions; no table, no trigger change), one Redis copy per event day (`{event}/{day}`) written after each scan and rebuilt by repair and the backstop, the PostgreSQL fallback. `?scope=today` and `today` on the ranking read; the owner's `rankingToday` switch on the dashboard; Whole event / Today tabs in the app. ADR-166, Q-132 Proposed. Tests: 6 database, 4 new route tests, app unit, the events browser test (desktop and phone), security suites, `expo export`; 2262 tests in the touched suites. Not pushed.
- 2026-10-23 **T-218 done** (core: CTO plan 84 → folded; code 93 GO; minors folded: requests pending before declined with a server count and Show more, the Accept-all result shown on an empty queue, no ban or lift of a player who left (ADR-168 amended), the join flow in its own hook, a waitlisted rejoin says so), not yet run on a phone. Migration 0036 and `src/moderation/requests.ts`: a declined request is its own status (no seat, cannot ask again unless invited, ADR-167); seats count accepted players only (ADR-168, amends ADR-141); a full hard-limited event answers `full` and offers the waiting list (`waitlisted` pending rows); the team accepts, declines and accepts all under the seat lock (seats before the row everywhere, no caught `QL409`); bans refuse requests; `enroll_operator` answers `full`. Dashboard: Join requests on the Players page, the access change confirmed in words (ADR-169). App: Request to join, Event is full with Join the waiting list, the waiting card on Home (read every 15 seconds), the declined message. The decision push moves to T-501 (note there). ADR-167 to ADR-169, Q-133 to Q-135 Proposed. Tests: 18 database (races at the last seat for accepts and waitlist joins), 5 route tests, join and Home route tests, app unit, the join-requests browser test (desktop and phone; 78 browser tests green), the whole vitest suite (3,449), security suites, `expo export`. Also fixed T-216's stale config test (`rankingToday`). Mutation 92.5% on `src/moderation/requests.ts` and `routes.ts` (local, 182 mutants; leftover test databases dropped). Not pushed.
- 2026-10-23 **T-220 done** (core: CTO plan 86 → folded; code 93 GO; minors folded; mutation on GitHub run 39936502814), not yet run on a phone. Migration 0037 and `src/audience`: a category or reward can be kept for players whose answer to a choice field is one of chosen options, or for guests with chosen tags (ADR-170 to ADR-173, Q-136 to Q-139 Proposed). Players outside it do not see it; `record_completion` refuses `not_for_you` on every path (player, operator scan, team award) and `reserve_reward` answers 404; `set_goal` refuses. Options are fixed once answered except for adding and relabelling; a targeted field or option cannot go; a returning player keeps earlier answers; a draft event still deletes in one statement. Dashboard: options in the field editor, the guest tag with the invitation hint, "Who sees what" on the Joining page with each rule's reach. App: the picker and the refusal text. Tests: 22 database, 5 route, unit (rules, options, setup, web lib, app join), the audience browser test (desktop and phone; 80 browser tests green), the whole vitest suite (3,510), security suites, `expo export`. Mutation not run locally (Dhia's rule): `apps/api/src/audience` added to `stryker.config.json`. Not pushed.
- 2026-10-24 **T-217 done** (core: CTO plan 86 → folded; code 92 GO; minors folded; mutation owed on GitHub: apps/api/src/deletion/**, auth/keys.ts, idempotency-store.ts), not yet run on a phone. Migration 0038 and `src/deletion`: a deleted account becomes a tombstone (ADR-175 to ADR-178, Q-140 to Q-144 Proposed): contacts, sessions, histories, acceptances, answers, flags, device ids and note reasons go; the ledger, enrollments, frozen results and handed-over prizes stay, naming no one. A fresh code (its own challenge, never a sign-in) gives a 10-minute deletion token; pending prizes are listed and need a forfeit (`end_reservation` with `erasure`). Keyed fingerprints of every contact held leave ban, welcome (until the event ends) and platform marks only. Joins read the caller FOR KEY SHARE, so a join in flight waits and refuses. App: Profile → Delete account. Web: `/{lang}/delete-account` (linked from the privacy policy). Deleted players show as "Deleted player". Also ADR-174 (mutation on GitHub only, batched, 90% bar; Accepted) and the T-220 code-review minors. Tests: 19 database (races with a join, a join request, a reserve and a My QR scan), 7 HTTP, app and web units, the whole API suite (2,684), security suites, 4 new browser tests plus the touched specs (desktop and phone), `expo export`. Mutation not run locally: `apps/api/src/deletion` added to `stryker.config.json`. Not pushed.
- 2026-10-24 **T-401 done** (core: CTO plan 89 → folded; code 94 GO; minors folded (an operator My QR scan pays XP once, DB test; the T-709 curve-edit note); mutation on GitHub run 39945083260), not yet run on a phone. Migration 0039 and `src/questify` in the app: Questify XP follows the event ledger by trigger (ADR-179 to ADR-182, Q-145 to Q-148 Proposed): one credit per (player, quest) from every writer of a quest entry, nothing for rehearsals, awards or repeats, one reversal per removed credit (FR-1602); 100 XP per quest (server-only, CHECKed), 30 levels, six titles; levels reached are kept for T-402's items. `GET /v1/me` gains `questify`, a completion answers `levelUp`. App: Profile level, title and XP bar; the scanner's medium level-up beat. Tests: 21 database (races, a deletion holding the player row, the backfill twice, append-only, closed doors), route, app units, security suites, the whole API suite, `expo export`. Not pushed.
- 2026-10-24 **T-301 planned** (core; CTO plan 80 → revised, re-check owed): `docs/plans/2026-10-24-t-301-submissions.md`, ADR-183, ADR-184, ADR-187 to ADR-189 and Q-149, Q-150, Q-152 to Q-155 Proposed. Text submissions only; pending points live on the submission (points and cap fixed at sending); approval re-checks player and event and writes the ordinary completion (key `sub:<id>`) and quest entry; one removal path through `remove_award`. Photos split to T-301b, blocked on a Questify bucket (Q-149).
- 2026-10-24 **T-302 planned** (core; CTO plan 85, GO at about 93 with its fixes folded in): `docs/plans/2026-10-24-t-302-vote-quiz.md`, migration 0041, ADR-190 to ADR-195 and Q-156 to Q-159 Proposed. Votes and quizzes pay through one shared payment path (`pay_completion`, from T-301's `pay_submission`); the quiz serves one question at a time, times it on the server (2 s grace), pays once at the end (zero right pays nothing), and the lifecycle tick pays an abandoned attempt at the quest's close. Text vote options only (images wait on Q-149).
- 2026-10-24 **T-301 done** (core: CTO plan 80 → 93 GO; code 93 GO; minors folded: approval refused for a platform ban, a reviewer's approval moves the ranking, pending points summed in SQL (`own_pending_points`), the wipe counts submissions, operator reviews recorded per SECURITY.md, no separate submit rate limit; mutation on GitHub run 39949844007; migration 0040 edited in place, never deployed: CranL has migrations through 0039), not yet run on a phone. Text submission quests: migration 0040 and `src/submissions`; pending points live on the submission and never touch the ledger until approved; approval is an ordinary completion (key `sub:<id>`, reserved at the API and in SQL) so score, rank, XP and the shop window follow; rejection with a reason adds nothing; auto-approve pays at once and stays unread in the queue; removal goes through `remove_award`; ban, removal, leaving and deletion close pending ones; the rehearsal wipe, burst flags and the quest builder's delete guard know submissions. App: the quest sheet (guidelines first, text box, pending and rejection lines), "+N pending" on Home, Tools → Review. Dashboard: Submissions page, builder toggles. Tests: 26 database, 6 route, the security suites, app, web and shared units, the submissions and awards browser tests on desktop and phone, `expo export`. Photos are T-301b (blocked on Q-149). Not pushed.
- 2026-10-24 **T-302 done** (core; Opus code review owed), not yet run on a phone. Vote and quiz quests: migration 0041 and `src/plays`. A vote is one completion (method `vote`) with the player's option; the quiz serves one question at a time on the server's clock (2 s grace, the deadline never moves), one try, the right answer only after answering or closing, one payment at the end (right answers × points frozen at start, key `quiz:<id>`; none right pays nothing, still done). Open checks on every step; a member who stops being active voids their attempt; no manual award on a quiz in play; the lifecycle tick and `confirm_results` finish due attempts with an approval's re-checks; played quests lock their structure. App: vote sheet and quiz flow (reduce motion, spoken countdown). Dashboard: vote and quiz types, vote counts. Tests: 25 database, 5 route, security suites, app, web, shared and tick units, the builder browser test on desktop and phone, `expo export`. Mutation owed on GitHub (`apps/api/src/plays/**`, `apps/api/src/quests/builder.ts`). ADR-190 to ADR-195, Q-156 to Q-159 Proposed. Not pushed. CTO plan 85 → folded; code 92 GO; minors folded (2026-10-23: the sweep takes the event FOR KEY SHARE first, a failing attempt is voided with an audit entry and the sweep moves on, integer timer, the ranking moves only on the step that paid; sweep cost noted in Q-157).
- 2026-10-24 **T-303 done** (core; CTO plan 91 GO; code 94 GO; nits folded: a non-boolean `required` reads as required, the share link must be https, `vote_quest` goes through `play_quest` in migration 0043), not yet run on a phone. Split first (ADR-196): location check-in and the location flags are T-303b, meet-someone is T-303c. Migration 0042: challenge quests (only staff: the station's My QR scan or a manual award), survey quests (`survey_response`, one per player, each answer checked, results for owners and editors with names not shown) and share quests (paid once on the share sheet's `sharedAction`; the `shareQuests` switch hides them from every player read and refuses payment). App: survey form, share flow, challenge line, station label. Dashboard: the three types, survey results, the share switch. Tests: 18 database, 10 route, security suites, shared, app and web units, the builder browser test, `expo export`. Mutation owed on GitHub (`apps/api/src/plays/**`, `apps/api/src/quests/switched-off.ts`, `apps/api/src/quests/builder.ts`). ADR-196 to ADR-199, Q-160 to Q-163 Proposed. Not pushed.
- 2026-10-23 **Stabilisation round**: the preview APK crashed at launch because the release Hermes has no `Array#toSorted` (`fontFor`, also in `launch.ts`, `home.tsx` and shared `compose.ts`, `placeholders.ts`); copy-then-sort everywhere, `unicorn/no-array-sort` off for the app and shared, and `apps/app/src/hermes-runtime.test.ts` fails on any call to a built-in the release Hermes lacks. Submissions mutation survivors (run 39949844007: routes 69.5%, submissions 67.4%) answered with `refuse` and SQLSTATE unit tests, queue paging tests and two equivalent-mutant notes; a new GitHub run is owed (`apps/api/src/submissions/**`, `apps/api/src/plays/**`).
- 2026-10-24 **T-304 planned** (core; CTO plan 81, revised: bonus a removable credit of its own, shop-closed balance, explicit calls, no dead ends, kind sites listed; re-check owed): `docs/plans/2026-10-24-t-304-category-rules.md`. Split (ADR-200): T-304 = in order, opens at, unlock after and the points completion bonus (FR-231 to 235; a zero-right quiz counts as done); T-304b passport; T-304c refresh and hidden categories; T-304d item rewards (FR-522, FR-1617); FR-238 to T-501. Migration 0044 (0043 is T-303's `vote_quest` fix). ADR-200 to ADR-202, Q-164 to Q-166 Proposed. Also: T-303's code-review nits folded (0042 edited in place: a non-boolean `required` reads as required, the share link must be https; 0043 `vote_quest` through `play_quest`), and the plays mutation survivors from run 39956001295 killed by `src/plays/plays.test.ts` and route tests (re-run owed on GitHub). Not pushed.
- 2026-10-24 **T-304 done** (core; CTO plan 81 → 93 GO; code 92 GO; minors folded: `bonus.settled` so a removed bonus is never promised again, an unlock category's name hidden outside its audience, `own_category_bonus`'s same-transaction match documented; 0044 edited in place), not yet run on a phone. Migration 0044: category order, opening time, unlock-after and completion bonus; gates in `quest_open_check` (manual awards pass; no dead ends); the bonus paid once by the database (`bonus` ledger kind, balance only while the shop is open, no XP, removable on its own), also for a quiz finished with no right answers. API, app (locks, rules, bonus lines) and dashboard (category form and notes). Also fixed the organizers browser test broken by T-303's second owner-only note. Tests: database 20, route, unit, security, browser (quests and organizers specs), `expo export`. Mutation owed on GitHub (`apps/api/src/quests/categories.ts`, `apps/api/src/quests/store.ts`, `apps/api/src/home/home.ts`, `apps/api/src/completions/complete.ts`, `apps/api/src/plays/**`, `apps/api/src/submissions/submissions.ts`). Next in the area: T-304b, T-304c, T-304d. Not pushed.
- 2026-10-24 **T-304b planned** (core; Opus plan review owed): `docs/plans/2026-10-24-t-304b-passport-quests.md`. Passport quests: steps in their own table, each its own signed code (format 0x04), paid once by the database on the needed-th stamp through `pay_completion`, `needed` never falls once stamped, steps by printed QR only. Migration 0045. ADR-203, Q-167 Proposed. Not pushed.
- 2026-10-24 **T-304b done** (core; CTO plan 84 → 93 GO; code 92 GO; minor folded: a re-scan pays a player left at `needed` unpaid by a `needed` lowered under a stamp in flight; 0045 edited in place), not yet run on a phone. Migration 0045: passport steps and stamps, `stamp_step` pays the quest once on the needed-th stamp through `pay_completion` (key `pass:{quest}`, reserved in every player key check), a deferred step-count check (a quest's delete with its steps passes), `needed` never falls once stamped. API: `POST /v1/steps/{id}/stamp`, `GET /v1/quests/{id}/passport`, `steps` on the quests read and in the builder, a code per step (format 0x04, own key) and its regeneration. App: scanner, progress line, passport list. Dashboard: passport fields, step codes. Tests: 17 database, 5 route, unit, security, browser (passport, codes, quests, survey-share; desktop and phone), the full API suite (2956), `expo export`. Mutation owed on GitHub (`apps/api/src/quests/qr.ts`, `apps/api/src/passport/**`, `apps/api/src/quests/passports.ts`, `apps/api/src/quests/codes.ts`, `apps/api/src/quests/store.ts`, `apps/api/src/quests/quests.ts`, `apps/api/src/plays/run.ts`, `apps/api/src/home/home.ts`). Not pushed.
- 2026-10-24 **T-304c planned** (core; Opus plan review owed): `docs/plans/2026-10-24-t-304c-refresh-hidden-categories.md`. Refresh counts the repeat cap, done, gates and bonus inside the event's day or 7-day block (nothing paid is touched; scan, code and challenge only); hidden categories open per player by a signed secret code (0x05). Migration 0046. ADR-204, Q-168 Proposed. Also: deletion and idempotency-store mutation survivors from run 39960854772 killed (`deletion.int.test.ts`, `idempotency-store.test.ts`; re-run owed). Not pushed.

## Next

1. **Now:** Dhia decides whether to merge branch `t-206-prize-desk` into `main` and push (Full checks and mutation are green on it), then the next unchecked task in `docs/TASKS.md` (T-207, T-209, T-211, T-213, T-214, T-216, T-217, T-218 and T-220 are done on `batch-2026-10-23`; T-207, T-209, T-211, T-214, T-216 and T-218 reviewed GO, T-220 reviewed GO (mutation on GitHub run 39936502814), T-213 reviewed (Sonnet 86 → fixed); T-217 reviewed GO (92), its mutation run on GitHub owed; T-401 reviewed GO (94), mutation on GitHub run 39945083260; T-301 reviewed GO (93), minors folded, mutation on GitHub run 39949844007; T-302 done, awaiting its Opus code review and its mutation run on GitHub; T-303 done (challenge, survey, share), reviewed GO (94), nits folded; T-304 (category rules and bonus) done, reviewed GO (92), minors folded, mutation run owed, T-304b (passport) done, reviewed GO (92), minor folded, mutation run owed, T-304c planned (Opus plan review owed), then T-304d; T-303b (location) and T-303c (meet-someone) are next in that area), then T-118's phone run (RUNBOOK, "The first loop on two phones"): needs Dhia for staging migrations
   0007 to 0023 and an EAS development build (Android: an Expo account only). Otherwise the next unchecked task in
   `docs/TASKS.md`. One task per session (CLAUDE.md, Token budget).
   - Dependabot (2026-10-21): two high alerts, `braces` 3.0.3 and `node-forge` 1.4.0, both only through Expo's build
     tools (`@expo/cli`, Metro), not in the API, the web app or the app's bundle; no patched version yet. Take the fix
     with the next Expo update.
2. **Phase 0 still open:** T-009 device run, T-010 cloud builds (store accounts), T-013 Msegat quote, T-017
   infrastructure as code, T-018 observability. T-019 backups before real players. Staging needs migrations 0007 to
   0023, a managed Redis in the Nafes project with `REDIS_URL` and `maxmemory-policy noeviction` (ADR-118), Msegat's static-IP check (M0037) registered or switched off before the first real SMS, `REWARD_CODE_SECRET` (32+ characters, its own value, backed up apart from the database; migration 0025), the new `QR_SECRET` (32+ characters, from the secret store; the API refuses to start without it) and outbound HTTPS to `api.pwnedpasswords.com` when T-020 and T-101 are deployed.
3. **Waiting on Dhia** (walk-through 2026-10-21, INBOX): **a Questify storage bucket in `riyadh-1` (Q-149, T-301): CranL Pro allows one bucket per account and `b7r-media` uses it, so photo submissions (T-301b) wait for a second bucket (or Oracle Riyadh);** the Apple Developer and Google Play accounts (T-010); installing the first Android development build (EAS build a1411217, started 2026-10-21) on a phone; sending Msegat the volume-quote request; CranL's written answers (Q-031). ADR-113 to 116 and 120 are Accepted. **No staging (ADR-123):** the CranL staging services become production, and the items above that said "staging" (migrations 0007 onward, Redis with `noeviction`, Msegat's static-IP check) are done there; renaming them is its own session. Resend backup skipped while Gmail stays out of spam (Q-083).
4. Open questions: Q-031, Q-034, Q-070, Q-071, Q-075, Q-077, Q-078, Q-083, Q-084, Q-085, Q-086, Q-088, Q-090, Q-093 (login SMS ceiling), Q-095 (player consent, counsel), Q-105 (star icon and XP, quest and category renames). Follow-ups from 2026-10-21: the username hold setting (ADR-124), the brand spelling and billing wording in the copy pass (ADR-125, ADR-128, T-808), the sound set (ADR-129), Saqr's character sheet (ADR-130), the listing name (ADR-131).

## Run complete — 2026-10-18
- Status: COMPLETE for the blueprint run; **planning is not yet closed**: the root `CLAUDE.md` still says
  PLANNING until the user approves ending it (then apply `_blueprint/CLAUDE_BUILD_DRAFT.md`). Future runs:
  Update mode.
- Docs produced this session: `TECH_STACK.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `API.md`,
  `INTEGRATIONS.md`, `CONFIGURABILITY.md`, `SECURITY.md`, `rules.md`, `ROADMAP.md`, `TASKS.md` (107 tasks),
  `TEST_STRATEGY.md`, `RISKS.md`, `_blueprint/STAGE6_GRILL.md`, `_blueprint/CLAUDE_BUILD_DRAFT.md`;
  ADR-101 to ADR-104; F-318, F-319; FR-1816, FR-1817 (517 FRs); NFR-031; Q-079.
- Consistency pass: subagent review, 26 findings; 17 mechanical fixes applied; 4 plan changes approved by
  the user (Phase 0 gates T-013 to T-015, email-invite F-319/FR-1817, data and API gaps filled or marked
  baseline, account deletion moved to Phase 2 and a v0 legal-text task T-119). Nothing dropped silently.
- Recommended toolbox: cto-cycle, security-guidance / cso, setup-playwright, ux-araby (none installed or run).
- Handoff: Claude Code in this project, after the user approves ending planning.
- Open questions at close: see `OPEN_QUESTIONS.md`. Blocking Phase 0: Q-031 (cloud), Q-034 (SMS quotes),
  Q-046 (Expo SDK check). Also open: Q-070, Q-071, Q-075, Q-077, Q-078, Q-079, Q-043, Q-051.
- Codex: mascot images resume after the limit resets (18 Oct, 3:09 pm Riyadh).

