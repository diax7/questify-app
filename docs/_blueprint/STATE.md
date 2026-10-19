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

## Next

1. **Phase 0 still open:** T-009 device run (Expo Go works in English; Arabic restart fixed, to retest), T-010 cloud builds, T-011 web shell, T-004 audit log, T-012 cross-tenant suites on routes, T-017 infrastructure as code, T-018 observability, T-013 Msegat quote, T-119 draft legal text. T-019 backups before real players.
2. **Waiting on Dhia:** the Gmail app password in the CranL secret store (T-006 staging check); later the Apple Developer account (T-010); a domain for the Resend backup (Q-083).
3. Open questions: Q-031, Q-034, Q-070, Q-071, Q-075, Q-077, Q-078, Q-082, Q-083.

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

