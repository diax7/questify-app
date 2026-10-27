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
- 2026-10-24 **T-304c done** (core; CTO plan 84 → 93 GO, its two build notes applied: the bonus guard runs under the enrollment lock, a manual award reveals only on a fresh payment; Opus code review owed), not yet run on a phone. Migration 0046 (new file): refresh per event day or 7-day block from the event's first day (cap, done, gates and bonus per period; occurrence lifetime and past 100; scan, code and challenge only), hidden categories (`category_reveal`, `reveal_category`, `sees_category` in every reader and the open check; the public page leaves them out). API: reveal route (0x05, code checked before any read), quests read `refresh`/`resetsAt`, builder fields, secret codes and their regeneration. App: scanner reveal, reset notes. Dashboard: refresh, hidden, secret codes. Tests: 31 database, 7 route, unit (signer, app, web), security suites, browser (quests, codes, passport; desktop and phone), `expo export`. Mutation owed on GitHub (`apps/api/src/quests/qr.ts`, `apps/api/src/reveal/**`, `apps/api/src/quests/categories.ts`, `apps/api/src/quests/codes.ts`, `apps/api/src/quests/quests.ts`, `apps/api/src/quests/store.ts`, `apps/api/src/home/home.ts`). Not pushed.
- 2026-10-24 **T-304d done** (core; CTO plan 84 → 93 GO, its two build notes applied: the new triggers are named `quest_item_*`/`category_item_*` so the item lock is taken before the refresh lock, and a comment says every completion locks the items; Opus code review owed), not yet run on a phone. Migration 0047 (new file): `quest_item` with its own stock and guards (desk, removed stays removed, `item_in_use`), `quest_item_miss`, a redemption's third source (once per completion, once per category and period), `give_item`, the payers lock both items in id order and give the quest's item on the first completion and the category's with its bonus (an item-only bonus writes no ledger entry), removal cancels a pending item and answers it (replay too), `AO409` counts priced reservations only, every reader learns the item and `source`, the shop's popular list skips free items, `member_event_quests` names the items still to win, rehearsal wipe and erasure. API: `…/quest-items` (list, add, edit, remove, misses), `itemId` on quests and categories (`invalid_item`), `item`/`bonus.item` on every pay answer, `source` on desk and player items, the removal's `item`. App: item lines on completion (pending, ran out, desk closed), the item beside quests and in category notes, "Quest reward" labels, no cancel for free items. Dashboard: Quest items on the Prizes page (stock, given by, ran-out warning, who missed), item picker on quest and category forms, warning on the event overview. Deviations recorded in ADR-205's build notes. Tests: 34 database, 5 route, unit (API, app, web), security suites, browser (all 100 on desktop and phone), `expo export`. Mutation owed on GitHub (`apps/api/src/rewards/quest-items.ts`, `apps/api/src/completions/complete.ts`, `apps/api/src/desk/desk.ts`, `apps/api/src/quests/builder.ts`, `apps/api/src/quests/categories.ts`, `apps/api/src/quests/quests.ts`, `apps/api/src/awards/**`). Not pushed.
- 2026-10-23 **T-303b done** (core; CTO plan 82 → 92 GO, its three build notes applied: `position_of` judges shape only so `bad_position` and `stale` answer apart; the check-in limit is counted before the check under the player lock, with a parallel test; Q-172 cites its Apple sources; coordinator notes applied: distances only in `completion_position`, a separate `location_tuning()` with `flag_tuning` untouched, older builds complete a location quest by its QR and this build keeps the QR for unknown types; Opus code review owed), not yet run on a phone (needs a new EAS build: `expo-location` is native). Migration 0048 (new file): `location` quests (place required, quest QR always), quest places and the venue pin, `completion_position` (rounded distances, accuracy, mocked; no grant, no policy; never a coordinate), `complete_quest` and `record_completion` take the reading (every 11-argument payer unchanged), `far_from_venue` and `impossible_speed` flags, `flag_detail` distance, gap and seconds, erasure and the wipe. API: lenient position on scans, strict on check-ins (`location_refused`), own check-in limit, platform switch `locationQuests` off by default (shared `offByDefault`), builder place and venue pin, Home `locationPrompt`. App: check-in sheet with the QR beside it, one-button explanation (on Check in, or once after joining an in-person event with a pin; never at launch), scans and typed codes carry the last fix up to 2 minutes old. Dashboard (Sonnet worker): venue pin, quest place, location note, Flags lines. CranL's log settings meet the rule (RUNBOOK). Tests: 31 database, route and flow (incl. parallel check-ins and no-echo), builder, security suites, app, web and shared units, browser `location.spec.ts` plus flags, rewards, quests, events (desktop and phone), the full suite (4198), `expo export`, gitleaks. Mutation owed on GitHub (`apps/api/src/completions/complete.ts`, `apps/api/src/completions/routes.ts`, `apps/api/src/flags/flags.ts`, `apps/api/src/quests/builder.ts`, `apps/api/src/events/events.ts`, `apps/api/src/home/home.ts`). Not pushed.
- 2026-10-23 **T-303c done** (core; CTO plan 84 → 93 GO, its two build nits applied; Opus code review owed), not yet run on a phone (no native change, no new EAS build). Meet-someone quests: migration 0049 (new file) with `meet_pass` (a one-minute code kept as a SHA-256 hash) and `meeting` (one per pair and quest), `meet_player` pays both players or neither under ADR-211's lock order (payments in player id order for the per-player XP rows), the daily cap from each player's own meet completions, the shown side out of the burst flag, erasure and the wipe. API: three player routes (limits 30, 60, 20), both rankings move, the `meetSomeone` switch (owner), builder `dailyCap`. App: the meet sheet and code screen, the scanner reads meet codes, every refusal line (Arabic checked with ux-araby). Dashboard: the meet type, the switch (`EventFeatureSwitch`), Flags method labels. Tests: 35 database (races on two connections, 50 rounds), 7 route, security suites, API/app/web/shared units, browser `meet.spec.ts` and the touched specs, `expo export`, gitleaks. Mutation owed on GitHub (`apps/api/src/plays/meet.ts`, `apps/api/src/plays/routes.ts`, `apps/api/src/quests/builder.ts`, `apps/api/src/home/home.ts`, `packages/shared/src/quests/meet-code.ts`). Not pushed.

- 2026-10-24 **T-305 done** (core; CTO plan 84 → 92 GO, its two build notes applied; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Mini-games: migration 0050 (new file) with `game_round` (seed, the level's numbers, points and engine version frozen at issue; the inputs never kept), `start_game_round` (an attempt used at issue, idempotent by key, cooldown for unlimited attempts), `finish_game_round` (the API's replay verdict, the clock check, one payment on the first pass, a refused round written as a row and flagged `minigame`), the sweep, the leave trigger, `quest_done` for spent attempts, the config lock once played, erasure and the wipe. Shared engines for memory match and slide puzzle (integer PRNG with golden vectors, `canInput` gate = the replay's rules; 5,000-seed honest-play tests). API: three player routes (426 for an older engine; limits 30 and 20), the `miniGames` switch, builder `game` (catch and tap rush "not available"). App: the sheet (Play, Retry while a result waits, Passed, attempts), the full-screen games with `Animated` and haptics, results in Arabic and English. Dashboard: the game type, the switch, flag lines. Tests: 42 database (races on two connections, 50 rounds), 12 route, security suites, shared/API/app/web units, browser `games.spec.ts` and the touched specs, `expo export`, gitleaks. Mutation owed on GitHub (`packages/shared/src/games/**/*.ts`, `apps/api/src/plays/games.ts`, `apps/api/src/plays/routes.ts`, `apps/api/src/plays/limits.ts`). Not pushed.
- 2026-10-24 **T-305c done** (core; CTO plan 84 → 93 GO, its five build notes applied; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Catch and tap rush on T-305's rounds: shared `ticks.ts` (30 Hz, integer `tickAt`/`tickStartMs`), `catch/v1.ts` (`advance` on the tick, basket speed capped by the world, foresight per ADR-217) and `tap-rush/v1.ts` (seeded 3 × 4 schedule, 120 ms gate, 150 ms grace for an empty cell only, score = hits − misses); `RealtimeEngine` type; levels and thresholds from calibration (ADR-217 build note). Migration 0051 (new file): both games in `quest_game_shape` and `game_round`'s check, `game_level` with six rows; 0050 edited in place (undeployed) so the flag case's rounds carry their `result`. API: registry and builder take all four (`COMING_GAMES`, `unavailableGame` and the builder's `not_available` deleted); the sheet carries `engineVersion`. App: `realtime.ts` (paused-aware game clock, the 3-2-1 count kept covered and out of `t`, the round ended on return when the window left < game time left + 30 s, `frame`), catch and tap rush screens (`PanResponder`, `Animated` pool, `onPressIn`), the sheet's update line for a game or engine version the build lacks. Dashboard: four games with the quick-sight note; the flag line shows the count that tripped `unlikely`. Also: T-305's many-seed tests moved to `*.calibration.test.ts`, which Stryker now skips (`vitest.stryker.config.ts`; mutation run 40030086932 had timed out on them); `pnpm test` still runs them. Tests: shared engines and calibration, app frame/pause/honest-play properties (500 seeds a level through `frame` and the tap gate), 43 database, 17 route, security suites, web units, browser `games.spec.ts` and flags specs, `expo export`. Mutation owed on GitHub (`packages/shared/src/games/ticks.ts`, `packages/shared/src/games/catch/v1.ts`, `packages/shared/src/games/tap-rush/v1.ts`, `packages/shared/src/games/registry.ts`, `packages/shared/src/games/levels.ts`). Not pushed. CTO code review 91 GO; fixes folded in: the pause line is a
statement ("Paused."), replay-cost bound 50 ms (calibration) and 150 ms (unit, run by Stryker), tap rush rounds at most
30 s, the foreseen flag's limit written into ADR-217 and Q-181. Accepted: an app build from before T-305c shows
"failed" (not the update line) on a catch or tap rush quest; no store build of that kind exists.
- 2026-10-24 **T-306 done** (core; CTO plan 84 → 93 GO, its four re-review notes applied; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Live polls: migration 0052 (new file): a vote quest's `live` block (one or several choices, results after voting, at close or never, 1 to 1,440 minutes), `quest.poll_sent_at`, `quest_vote` one row per option (one completion, one payment), `vote_quest(uuid, text[], text)` (`VC422 too_many_choices`, the replay compares the set), `send_poll`/`close_poll` (owner, editor; audited; live event, or a running rehearsal), the API-seat guard on a live poll's window and `quest_lock_played` on `live`, choices and minutes (`PL409`), live polls left out of `category_done`/`category_cleared`/the in-order check (a category of only live polls is cleared, never done; a category holding one never refreshes), `member_poll`, `poll_results` (policy, `PR403`), `quest_vote_counts` with `voters`, `live_state` (empty for anyone not an active member), `event_has_open_poll`, the wipe puts rehearsal-sent polls back to draft and counts votes per player and quest. API: vote body `{optionIds}`, `GET /v1/quests/{id}/poll`, `GET /v1/events/{id}/live` (weak ETag without `serverNow`, 304, `Server-Now`, 3 s per-event cache, 30 a minute per player in each instance's memory), `…/send` and `…/close`, builder `poll_locked {field}` and a live poll's window kept as Send/Close set it. App: the pop-up card over the event tabs (only on a calm screen: no sheet, not Scan, never over a game, quiz or camera; Later puts it off for the session), the poll sheet (radio or checkboxes, countdown on the server's clock, results as shares of voters), the one-time results card, `livePollSeconds` tuning (10). Dashboard (web): Live poll fields with the "ideas, never looks" line, the window fields hidden for a live poll, Draft/Open/Closed with Send now and Close now (each confirmed) and counts every 5 s while open, shares of voters. T-306b's plan section gained the `pg_stat_activity` build notes (CTO re-review 3). Tests: 25 database, 5 route (+ live unit), builder and shared units, security suites, app and web units, browser `live-polls.spec.ts` and `vote-quiz.spec.ts` (desktop and phone), `expo export`, gitleaks. Mutation owed on GitHub (`apps/api/src/plays/votes.ts`, `apps/api/src/plays/live.ts`, `apps/api/src/quests/polls.ts`, `apps/api/src/quests/builder.ts`, `packages/shared/src/quests/registry.ts`). Not pushed.
- 2026-10-24 **Mutation survivors of GitHub run 40036668119 chased** (plays meet, games, limits, routes; home; quests builder and store; the game engine and memory match; awards routes): tests only, plus one bug the survivors showed: `GET /v1/events/{id}/quests` built each quest's `meet` and `game` but never sent them, so the app's meet sheet never showed today's meetings (fixed in `home/routes.ts`, API.md). New: `test/support/fake-pool.ts` (a pool answering canned rows and errors) and its unit tests for the race-only refusals; `test/quests/store.int.test.ts`; memory match reads its board inside each test (a board read while the file is collected made Stryker treat `start` as static). `stryker.config.json` leaves out `packages/shared/src/games/testing/**`. Re-run owed on GitHub.

- 2026-10-24 **T-306b done** (core; CTO plan 91 GO, its eight notes folded; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Community quests: migration 0053 (new file, undeployed): five closed tables (`community_goal`, `_step`, `_reach`, `_contributor`, `_payout`; RLS forced, PUBLIC revoked, no grant), ledger kind `community` (system, balance only while the shop is not closed, no XP, unique per step and player), the settle point from `pg_stat_activity` for the API's and the owner's sessions (`CV500 settle_blind`; the migration and `--verify` assert the owner sees them, nothing granted; READ COMMITTED only, `CI500`), `settle_goal` (30 s lag, settled slice plus shown tail, contributors from every row read, the `contributors` top-up, the read capped at the goal's reach, final once the settle point passes the reach or the window's end), `pay_community_batch` (event `KEY SHARE`, rows `SKIP LOCKED`, enrollments in id order, skips `inactive`/`no_play`/`results_final`), the builder (one goal at a time, at most 20, locked at start but texts, `event_ended`), the owner's `settle_community` (`CS409 community_settling`), `confirm_results` `RF409 community_paying`, the event switch's trigger, `remove_award`/`member_ledger`/`member_activity` for the kind, `live_state.community`, `event_has_live` replacing `event_has_open_poll`. API: `apps/api/src/community/` (builder routes, the 5 s tick with `community.settle_behind {goals, blockerPid, blockerApp}`, `payout_stuck`, `settle_blind` logs, the 2 s pay budget, Settle and pay now), `PUT …/community`, the confirm's `community_paying {goals, due}`, quest/category delete `goal_in_use`, the pool's 10 s `idle_in_transaction_session_timeout` (`db/pool-options.ts`). App: one live read for the tabs (`LiveProvider`), the wooden community bar on Home (gold fill from the reading direction's start, milestone markers, time left, "Counting the last points…", Reached/Not reached), one-time cards for a reached moment and a paid step, `history.community`. Dashboard: the Community page (list with progress and payouts every 5 s while running, form with milestones and a bar preview, delete before the start), the event switch, Settle and pay now on the results page. Timing (by hand): first settle over 20,000 completions 2.25 s, steady tick 73 ms, 10,001 players paid in 5.5 s. Tests: 34 database, 3 crossed-lock, 7 route, tick/goal/results/pool units, security suites, app and web units, browser `community.spec.ts` (desktop and phone; `builder.ts`'s Quests link now exact), `expo export` (android). Mutation owed on GitHub (`apps/api/src/community/**`, `apps/api/src/plays/live.ts`, `apps/api/src/results/results.ts`, `apps/api/src/db/pool-options.ts`). Not pushed.- 2026-10-24 **T-306c done** (core; CTO plan 84, re-review 92 GO, its two notes folded: the category bonus at a miss is accepted as paid only by a completion, ADR-227 build note and Q-194, tested; `community_lock_missed` counts a milestone left unreached on a goal that ended reached, tested; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Unlock rewards: migration 0054 (new file, undeployed): `community_step.reward` takes `unlock` with one of three target columns (composite keys to the event, partial unique indexes: a target is locked once), the internal gate (`quest_community_lock`, `category_community_lock`, `reward_community_lock`, `community_lock_missed`, `quest_lock_missed`, `community_lock_note`, `category_rule_lock`, `community_unlock_target`, `community_check_unlocks`), `category_lock` checks the lock first (every door through `quest_open_check`; owners' and editors' manual awards pass, an operator's is refused in `record_completion`), the category rules leave missed-locked quests out, `reserve_reward` `RW403 community_locked`, `send_poll` `PL409`, the sheets serve nothing (`member_game` QN403), `live_state`'s closed results, `public_event_quests`, `operator_award_quests`, `member_event_quests`/`shop_rewards` with notes (DROP and CREATE), the bar's target only to a member who sees it, the builder's `unlock_target`/`unlock_counted`/`unlock_taken`, and a `BEFORE DELETE` trigger on `event` so a draft event with goals can be deleted (0053 had the same trap). API: `communityLock` on quests, categories, the shop and Home's goal (`pickGoal` skips locked rewards), the unlock body, `409 unlock_taken`, `422 invalid_goal {issues: unlock_target|unlock_counted}`, Send's `409 community_locked`, `goal_in_use` for a step, `/live`'s `target`. App: the lock line by the goal's measure (or its start, or missed), the category note, the shop line instead of Redeem, Home's pinned-goal line, the bar's padlock step (named or "a surprise"; an unknown reward kind keeps its marker), the one-time unlocked card and the refetch on the reach. Dashboard: Unlock in the reward picker with the target picker (live polls and the counted items left out, taken targets disabled), the preview line, the title hint, the event switch's warning. Tests: 69 database (the door table over 19 doors by quest and by category, readers, builder, missed and switched off, CTO 2, rehearsal, index probes, the completeness map, 2 crossed-lock), 5 route, API/app/web units, security suites, browser `community.spec.ts` (desktop and phone), `expo export`. Mutation owed on GitHub (`apps/api/src/community/goals.ts`, `apps/api/src/community/lock-note.ts`, `apps/api/src/home/home.ts`, `apps/api/src/home/goal.ts`, `apps/api/src/rewards/shop.ts`, `apps/api/src/plays/live.ts`, `apps/api/src/quests/polls.ts`). Not pushed.
- 2026-10-24 **T-307 done** (core; CTO plan 84, re-review 93 GO, its three notes folded; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Flash quests and double-point boosts: migration 0055 (new file, undeployed): `quest.flash`/`flash_launched_at` with their checks and guard, the closed `boost` table, `ledger_entry.boost_id` (quest and removal only; `LB500` for a real entry naming a rehearsal boost), `boost_in_force` (one rule for payers and readers), every payer restated (`pay_completion` with `device` and `fixed_at` and no defaults; now for scans, votes, surveys, shares, passports and meetings; the send, the quiz's start and the round's issue for the frozen ones; never manual), every reader with `flash_shown`, the category rules without flash quests, `member_event_quests`/`member_activity`/`member_ledger` dropped and created, `live_state`'s `flash` and `boosts`, `event_has_live`'s 15-minute tail, pending points at the send's boost, the wipe and the event delete. API: `quests/flash.ts` (Launch, End now), `boosts/` (list, save, edit, delete, Stop, platform switch), `PUT …/flash-quests` and `…/double-points`, `boost` on every completion answer, `flash`/`boost` on the quests read, `/live`'s cards, `multiplier` on the activity and the team's record, `409 boost_in_use`. App: lightning badge (icon-lightning, 128 px) and "Ends …", the ×2 seal (an isolated run in Arabic) with "Double points until …", "Double points!" on every paid line, one-time live cards with the refetch, "×2" in the history. Dashboard: the Flash quest box, Launch now (minutes) and End now on the list, the Double points page, the two switches. Tests: 79 database (the door table over 15 doors, the payer table over 15 payers ×3, the frozen crossings, never-boosted rows, readers, Launch/End, the builder, rehearsal and CTO note 2, removal, places, today's ranking, a community points goal, the payer completeness map, 3 crossed-lock), 8 route, API/app/web units, security suites, browser `flash-boosts.spec.ts` (desktop and phone), `expo export` (android). Mutation owed on GitHub (`apps/api/src/boosts/**`, `apps/api/src/quests/flash.ts`, `apps/api/src/quests/builder.ts`, `apps/api/src/plays/live.ts`, `apps/api/src/completions/complete.ts`, `apps/api/src/home/home.ts`). Not pushed.
- 2026-10-24 **T-308 planned** (core; CTO plan review 86 → 92 GO): `docs/plans/2026-10-24-t-308-nfc-tags.md`. Q-071 answered with research (react-native-nfc-manager v4.1.0 on Expo SDK 57 reads and writes NDEF on both phones). Basic tags only (Dhia, Q-198): signed tags will not be built (ADR-235, ADR-236 rejected).
- 2026-10-24 **T-308 done** (core; CTO plan 92 GO, notes A to C folded; Opus code review owed), not yet run on a phone (Android release APK built 2026-10-24, see the CranL note below). Migration 0056 (deployed on CranL 2026-10-24): closed `nfc_tag` and `nfc_tap`, the `nfc` method only on scan quests and only with the quest QR, `record_completion` restated with `nfc`, `tap_quest` (unknown or another event's tag NT404, the retry replayed on its own quest first, the sticker check, `nfc_copy` from the second mismatch since the last closed case, `platform` taps unchecked), `prepare_nfc_tag`/`register_nfc_tag` (operator, `write_nfc`, quest limit, ended event, the sticker swap under the quest row and the event's lock, 50 a quest, 2,000 an event, `already_registered`), the Tags panel's reads and Move/Revoke/Revoke all, the event delete. API `src/nfc`: tag code purpose 0x06, the 5-minute write ticket (HMAC from `QR_SECRET`), `POST /v1/taps`, prepare, confirm and the operator's page, the team routes, `nfcTags` platform switch, 60 a minute limits, `tags_in_use` on quest delete. App: `react-native-nfc-manager` 4.1.0 (config plugin, NDEF/TAG entitlement, no select identifier; loaded lazily), the scanner's NFC (Android reader mode, iOS button and auto-start from the quest sheet), Tools → Write NFC tag (lock on by default, read-back, Rewrite, retry of a lost confirm). Dashboard: the NFC method box (QR kept and locked), the Tags panel (taps, possible copies, unchecked), the `/t/` page, the `nfc_copy` flag line. Tests: 29 database (door table, writes, crossed locks), 7 route, ticket/qr/app/web units, security suites and the completeness maps, browser `nfc-tags.spec.ts` (desktop and phone), `expo export` (android, ios). Mutation owed on GitHub (`apps/api/src/nfc/**`, `apps/api/src/quests/qr.ts`). Needs Dhia: a new EAS development build (Android and iOS), then the phone test with NTAG213/215 stickers (the iPhone must send the sticker's id). Not pushed.
- 2026-10-24 **T-308 phone-test fix (Android NFC, app only)**: on Dhia's phone (APK cf9ec23b) a sticker and a card met Android's "Could not find an app that supports this NFC tag" on Write NFC tag. Cause: the sessions never asked for reader mode (the library fell back to foreground dispatch) and the library's cancel turned the registration off a second later under the next session. `apps/app/src/nfc/native.ts` now holds reader mode itself for each session, one session at a time; blank stickers (NdefFormatable) are formatted with the link; NFC off and unusable tags (MIFARE Classic) are said in the app (ADR-243, Q-205 Proposed). Tests: `native.test.ts` (7; 6 fail on the old code), app units, `expo export`. **Needs a new APK.** Then the fob "written OK" but unknown on tap: CranL holds no `nfc_tag` row or `nfc_tag.*` audit entry, so no confirm ever committed; the app shows success only on a 2xx confirm, so the likely path is a write that failed after the NDEF write (fob moved before the read-back or the lock) and a second tap answering `taken` ("already holds a Questify quest"). Now a write that went through is registered (unlocked if the lock missed, said on screen), and the `taken` copy says the link may not be registered. Tests: `native.test.ts` 10.

- 2026-10-24 **T-309 done** (core; CTO plan 84, re-review 92 GO, its three notes folded; Opus code review owed), not yet run on a phone or a TV (no native module, no new EAS build). Pairing for stations, kiosks and big screens, the device credential and the rotating screen QR: migration 0057 (new file, undeployed; CranL is at 0056): `device_request` and `paired_device` (RLS forced, PUBLIC revoked, no grant), the screen method `screen_qr` (scan quests only, never with the printed QR), `record_completion`/`complete_quest` restated (the window on the database clock, QV422 `expired`, one pay per player per 45 s), activation's secret swap (`previous_hash` UNIQUE, accepted only while `previous_until` is ahead, a second old-secret activation draws a fresh secret without extending it), removal triggers on `staff_assignment`, `organizer_member` and `staff_user` (no-op without devices; an event being deleted takes its devices), paused when the pairing operator loses the ability or quest. API: `src/devices` (the `device` access kind under `/v1/device` with its guard, the `__Host-qs_device` cookie, pairing with the address limit and the reload case, preview, claim, Revoke, the miss throttles and their alarm, the `stations` switch), screen code purpose 0x07 and the completion proof `screen` (422 `code_expired`). App: the scanner's `/s/` codes, "Scan the code on the screen", Tools → Rotating QR, Pair a device (stations only until T-309b), My paired devices. Web: `/{lang}/station`, `/screen`, `/kiosk` (pairing only), `/s/` and `/pair` landing pages, the Devices page, the quest form's screen QR box, the operator removal note. Build notes on ADR-239 and ADR-240; Q-206 (the unused `screenQrRotationSeconds` tuning). Tests: full Vitest 5110 passed (52 database, 17 device route, the security suites; 0 unhandled errors); browser `stations.spec.ts` (desktop and phone) plus `nfc-tags`, `quests`, `operators` specs; `expo export` (android); gitleaks clean. Mutation owed on GitHub (`apps/api/src/devices/**`, `apps/api/src/quests/qr.ts`, `apps/api/src/completions/complete.ts`, `apps/api/src/completions/routes.ts`, `apps/api/src/route-access.ts`). Not pushed.
- 2026-10-24 **T-309b done** (core; CTO plan 92 GO, its five notes and two nits folded; Opus code review owed), not yet run on an iPad or an Android tablet (no native module, no new EAS build). The kiosk and the live code (F-107, FR-315): migration 0058 (new file, undeployed; CranL is at 0056, 0057 undeployed too, only its stale comment changed): the method `kiosk` (scan quests, with any other scan method), `kiosk_scan` (RLS forced, PUBLIC revoked, no grant; cascades with its completion, kept by erasure), `record_completion` restated with exactly four changes (the null-safe `kiosk:` key check, the method row, the window, the one-pay rule per method keeping `quest_completion_window_idx` usable), `kiosk_complete_quest` (device `FOR SHARE`, `DV403 paused`, `OY409` the pairing operator, a UUID key namespaced `kiosk:{device}:{key}`, install id NULL, `boosted` from the ledger on replays too), `kiosk_scan_subject`, `live_code_window`, `device_quest_state`, `device_view`/`device_json` (`scans`)/`operator_devices` (`kioskQuests`) restated. API: purpose 0x08 `live`, `GET /v1/me/live-code`, `POST /v1/device/kiosk-scans` (the code opened in the API: `needs_live_code` for My QR, `invalid_code` counted), the platform `kiosks` switch (also `shut: feature_off` on `GET /v1/device`), 30 scans and 10 bad codes a minute per kiosk, 6 live codes a minute per player, the ranking after a fresh completion. App: My QR's tabs (For kiosks: fetched on open and again at `changesInMs` plus jitter, never cached, offline and off states, kept awake, the emptying bar), the quest sheet's "Show your live code at the kiosk", Pair a device for kiosks with the lock-the-tablet tip, scans on My paired devices. Web: `/{lang}/kiosk` (`KioskScanner`: the camera on a tap, front by default with Switch camera, `zxing-wasm/reader` loaded by this page alone at 4 frames a second, the Questify-shape filter, a 5-s drop, one scan in flight, one retry with the same key, never queued, the 4-s green/orange/red card with no one named on red, offline and slowed banners), `camera=(self)` and `'wasm-unsafe-eval'` on `/ar/kiosk` and `/en/kiosk` only, every link there a plain `<a>`, the committed wasm with its hash test, the Devices page's kiosk pairing, scans in the last 24 hours and page links, the quest form's Kiosk method; the web image and `pnpm start` now copy `public/` (the currency icons were missing from the image too). Tests: 31 database (the kiosk door table, keys incl. a NULL key, cross-tenant, cascades, flags, 5 crossed-lock), 9 kiosk route, the security suites, qr/kiosk/decoder/headers/devices units, app units, browser `kiosks.spec.ts` (a tablet's fake camera reads a live code and pays; the click-through from the Devices page; wasm served as `application/wasm`) plus `stations`, `quests`, `nfc-tags` specs; `expo export` (android). Mutation owed on GitHub (`apps/api/src/devices/kiosk.ts`, `apps/api/src/devices/live-code.ts`, `apps/api/src/devices/routes.ts`, `apps/api/src/devices/limits.ts`, `apps/api/src/devices/devices.ts`, `apps/api/src/devices/claims.ts`, `apps/api/src/quests/qr.ts`). Not pushed.
- 2026-10-24 **T-310 done** (core; CTO plan 86 → 93 GO, its two notes folded; Opus code review owed), not yet run on a phone. The help desk (F-118, F-180): migration 0059 (new file, undeployed; CranL is at 0056): `ticket` (RLS forced, no grant), `open_ticket` (an active member; 3 open and 10 a day per player and event under the enrollment lock, a key replayed under the lock; `sending_closed` in a draft or archive or 30 days after the end; `feature_off`), `staff_answer_ticket` (audited, no text) and `operator_answer_ticket` (one answer closes it, replays and `already_closed` under the ticket lock, `event_closed` once archived), `own_tickets` (one event or every event, never who answered), `mark_tickets_seen` (NULL event allowed, the CTO note), the merged `operator_inbox` and its count, `event_tickets`, erasure, the rehearsal wipe (`tickets`) and `purge_ended_tickets` (90 days, the lifecycle tick). API `src/tickets`, Home's `help.unread`, the `helpDesk` switch. App: Get help (Info, the profile tab, Home's strip, the quest sheet's "Report a problem with this quest", Contact Questify), the profile's Your requests, staff mode's Inbox with a 30-second badge and the ticket screen. Dashboard: Help desk page, nav link with the open count, Features switch. Tests: 34 database (crossed locks: two answerers, the open cap, one key twice, erasure and the sweep beside an answer), 7 HTTP (logs never hold the text), unit and app tests, security suites, the full vitest suite, 2 new browser tests plus the touched specs, `expo export`. Mutation owed on GitHub: `apps/api/src/tickets/**`, `apps/api/src/home/home.ts`, `apps/api/src/events/tick.ts`. Not pushed.
- 2026-10-24 **T-311 done** (core; CTO plan 92 GO, its notes folded; Opus code review owed), not yet run on a phone (no native module, no new EAS build). Operator tools (F-181, F-182): migration 0060 (new file, undeployed; CranL is at 0056): `operator_practice_scan` (invoker; the real door in a block that always raises, so every row and lock is undone), `practice_wipe_owed` (PW409 `going_live` while the go-live wipe is owed), `operator_station_today` (everyone's completions of the station in the event's day and the last hour). API: `POST /v1/operator/scan/practice` (own route, no key, no ranking, `withRolledBackContext` always rolls back, a failed rollback destroys the connection), `GET …/stations/:questId/today` (60 a minute). App: Tools → Practice mode (memory only), the strip on every staff screen from the shared frame, the lock card on desk, inbox, tickets, award, review, NFC write, rotating QR, pairing; the result line from the server's `practice: true`; a mode change forgets the last code; Home's Today at this station with one shared Inbox poll ("You today" on the station list). T-311b no longer depends on T-311. Tests: 23 database (a whole-database fingerprint around every case with a committing transaction, every refusal compared with the real door, locks gone, keys, crossed scans, the owed wipe, the day boundary), 6 HTTP, API and app units, security suites, the full vitest suite, `expo export`. Mutation owed on GitHub: `apps/api/src/operators/practice.ts`, `apps/api/src/operators/station-today.ts`, `apps/api/src/db/context.ts`. Not pushed.
- 2026-10-24 **T-311b done** (Standard bar; code review owed), not yet run on a phone (no native module, no new EAS build). The event's quest and category words (FR-942) and the event's words in staff mode (Q-214, FR-941): `EventTerms` gains `quest` and `category` (no migration, no route change); `wordParams` fills `{questOne}`, `{questMany}`, `{questOneCap}`, `{questCap}` (and for category and player) in every text through the translator (app root defaults, `TermsScope` in `EventProvider` and `OperatorProvider`; the web translator takes optional terms for the Event words preview, which now has quest and category fields and lines). About 85 texts of the player app and staff mode rewritten (ADR-253: Arabic noun only where it needs no article or agreement, else rephrased). Staff mode loads the event's configuration like the player app (ADR-254), uses its currency in the review queue and desk, and the manual award search no longer names the player. Tests: shared terms and the translator (parity ignores the word placeholders), the app's `words.test.ts` (substitution, no unfilled placeholder, no hard-coded quest/category in the keys staff and event screens name, no hard-coded player in staff texts), web terms, API terms route. ADR-252 to ADR-254 and Q-215 to Q-217 Proposed. Dashboard builder texts split to T-311c.
- 2026-10-25 **T-311c done** (Standard bar; code review owed). The event's quest and category words in the dashboard (FR-942): the event layout (`events/[eventId]/layout.tsx`) reads the event's terms on the server (`fetchEventTerms`) and offers them through `TermsScope`; components use `useTranslator`; `translatorFor` keeps one function per set of words (bounded to 32 events). About 120 texts rewritten (ADR-264; builder, codes, operators, audience, community, flash, boosts, quest items, devices, event switches). Saving the Event words refreshes the layout. Tests: `words.test.ts` (substitution, no unfilled placeholder, no hard-coded quest or category in any key the dashboard names, no direct `translatorFor` in a component that names a word), `event-terms.test.ts`, `language.test.ts` (same function for the same words); browser: `terms.spec.ts` extended (both languages, list reads counted), 17 other specs follow the new Arabic. ADR-264, Q-227 and Q-228 Proposed.
- 2026-10-25 **Dashboard request loop fixed.** `translatorFor` built a new function on every render, and six
  panels (Boosts, Devices, Events, NFC tags, Prizes, Team) list `t` in their hook dependencies, so each reloaded its
  list after every render (CI run 40134112004: 12,378 boost reads in 90 s; the save's own reload landed after the
  Edit click and shut the form, failing `flash-boosts.spec.ts`; not a clock or midnight issue). It now returns one
  translator per language; the Boosts form closes before its list is read again; `flash-boosts.spec.ts` counts the
  list reads; `stations.spec.ts` reloads instead of riding the loop. All browser tests pass under `TZ=UTC`.

## Coordinator handoff (2026-10-25, for the next session)

Work runs in **coordinator mode** (CLAUDE.md "How work runs"; brief: `docs/agents/WORKER_BRIEF.md`). The session
of 2026-10-23 to 25 closed T-304c, T-304d, T-303b, T-303c, T-305, T-305c, T-306, T-306b, T-306c, T-307, T-308,
T-309, T-309b, T-310, T-311, T-311b, T-311c, T-312 and T-313, each with its CTO plan and code reviews (GO) and
fixes folded; everything is on `main` and pushed. Progress: **74 of 152 tasks** (splits keep adding tasks).
Dhia paused the work on 2026-10-25 ("let's have a break"); the queue below is where to resume.
- **CranL** (the only environment, fake data) runs migrations through **0056** (0048 to 0056 applied 2026-10-24 from
  green commit 80a85bb, CI run 40084164841; `--verify` ok with `ownerSeesSessions: true`; owner connection removed
  afterwards); the frozen-migration rule applies to ≤0056. API and web redeployed from 80a85bb the same day:
  `/healthz`, `/readyz` and `/{en,ar}/sign-in` answer 200. Demo event "Questify Demo Day", join code **77XBUB**. The
  release APK (preview profile) works on Dhia's Android phone (confirmed 2026-10-24); the one for the NFC phone test
  (react-native-nfc-manager in) is EAS build cf9ec23b, APK https://expo.dev/artifacts/eas/oizO-3k1mo421W8h9KqEyrsVDmQagzGxIVJ0KjAR4rI.apk (app code as 80a85bb). No iPhone build until the
  Apple Developer account (T-010). The 500-row community payer batch was not timed: the runbook asks for it before the
  first real event with a community quest, against a CranL copy, which does not exist yet. Msegat allows CranL's
  outbound IP 130.94.119.140.
  - **NFC test setup on 77XBUB (2026-10-24, fake data):** the platform switch `nfcTags` is on (no platform override
    stored; on by default). In "General", the scan quest "Tap the NFC sticker" (15 pts, quest QR and NFC ticked). Dhia's
    player account `dhia` is an operator of the event (personal invite "Dhia NFC test", preset full, so `write_nfc`;
    may play, no quest limit), so the app's Tools → Write NFC tag offers that quest; a prepare call answered on CranL
    (no tag registered yet). Write an NTAG213/215 sticker in the app, then tap it as a player.
    Three more scan quests were added in "General" the same way (staff API, temporary sessions revoked afterwards):
    "NFC test 2", "NFC test 3" and "NFC test 4" (15 pts each, quest QR and NFC ticked, visible now). Dhia's operator
    has no quest limit, so Write NFC tag now lists all four; a prepare call answered for each (no tag registered).
  - **Phone-test setup on 77XBUB (2026-10-23, fake data):** category "Daily challenges" refreshes daily (typed codes
    `SUNRISE` 10 pts, `CHECKIN` 5 pts); hidden category "Secret garden" (typed code `ROSE` 25 pts inside) whose secret
    QR is in the dashboard's printable codes (event, Codes, "Secret garden"; version 1); in "General", "Find the
    treasure chest" (code `TREASURE`) gives the quest item "Questify sticker" (stock 2) and "Golden pin hunt" (code
    `GOLD`) gives "Golden pin" (stock 0, the ran-out case). Items show on the Prizes page, Quest items.
  - CranL Postgres log settings (read 2026-10-23, for T-303b): `log_parameter_max_length` -1,
    `log_parameter_max_length_on_error` 0, `log_min_duration_statement` -1, `log_statement` none,
    `log_min_error_statement` error.
- 2026-10-25 **T-312 built** (core; CTO plan 86 → re-review 91 GO with the routing CHECK fixed: a NULL `escalated_at` no longer passes, forged-insert test added, the return CHECK tightened). Migration 0061 (undeployed): six ticket kinds routed by kind, Report a player (owners and editors only, never operators), app problems and suggestions with no event (device facts, `expo-device` 57.0.2 loaded lazily), escalation with a note, Questify's queue for active platform admins (`queue = 'questify'` only, every read audited per event), send back, retention by the latest hop. API (`apps/api/src/tickets/**`, console routes under the T-210 hook, 120 calls a minute per admin), app ticket center, dashboard With Questify and Escalate, console Tickets. Tests: database (tickets, tickets-center), security, routes, unit, app, web, browser (help-desk, console-tickets), `expo export`. Opus code review 93 GO (minors folded: atomic lookup cap, `moved` on a stale reply); pushed. Owed: mutation on GitHub, a new development build (Dhia).
- 2026-10-25 **T-313 built** (core; CTO plan 84 → re-review 92 GO, its three notes folded: a quiz the tick sweeps while the event is live claims, one swept after it does not; the live set includes bonuses with 0 left; `claimed_at = clock_timestamp()`). Migration 0062 (undeployed): `quest_first_bonus` and one `quest_bonus_slot` row per place, claimed `FOR UPDATE SKIP LOCKED` as each payer's last write under a shared advisory lock (the setter's exclusive), the `first_bonus` ledger kind (never boosted, no XP), the setter with Stop, the readers, the rehearsal wipe; `practice:` keys reserved at the API. API (`apps/api/src/quests/first-bonus.ts`, a 2-second per-event count cache, `/live` and the quests read, `firstBonus` on every player completion answer, the practice scan's `bonusPoints`), app (gold ribbon fed by `/live`, success-card beat, history, practice line), dashboard (bonus fields, locked points, Stop, list count, record place, remove hint). Burst timing by hand (two pools of 10, 300 at once, N = 50, median p95 of six rounds): plain 59.7 ms, bonus 73.2 ms (+22.7%), used-up 60.0 ms; over the plan's 20% by 13 ms, Q-229 asks Dhia to accept. `completion_id` join sweep: no SQL or API query reads ledger rows by completion without a kind filter (all filter `kind = 'quest'`). Tests: database (first-bonus, 54), security, routes, unit, app, web, browser (first-bonus spec), `expo export`. Opus code review 92 GO (burst cost accepted, Q-229 recommends agree; minors folded: live gate, Stop with only rehearsal claims switches off, forced crossed orders); pushed. Owed: mutation on GitHub.
- **Queue for the coordinator (2026-10-25):**
  1. Mutation: read GitHub run 40139062524 (tickets, practice, station today, context, home, tick, devices,
     completions routes; still running at the pause). Then dispatch T-313's globs (`apps/api/src/quests/first-bonus.ts`,
     `quests/builder.ts`, `quests/quests.ts`, `completions/complete.ts`, `plays/live.ts`, `plays/run.ts`, `home/home.ts`,
     `packages/shared/src/quests/first-bonus.ts`, always with `!**/*.test.ts`). Chase survivors only while a file is
     under 90%, in a worktree.
  2. Deploy to CranL when Dhia asks: migrations 0057 to 0062 are undeployed (pairing, kiosks, help desk, practice,
     ticket center, first-N bonus); then a new EAS build (adds `expo-device`, `expo-keep-awake` and the NFC fixes
     42b7291, 832ba03, 25ebd30 beyond APK 6059a3f3).
  3. Phase 3 left: T-301b and T-305b (blocked on Q-149), T-307b (needs T-504), T-312b (needs T-501). So the next
     unchecked task is Phase 4: **T-402** (Questify profile), then T-403, T-404.
  4. Coordinator rules learned this session (also in WORKER_BRIEF): every worker runs the full vitest with the DB env
     and, for UI copy, the full browser suite before reporting; an owner-only switch updates the count in
     `apps/web/e2e/organizers.spec.ts`; before pushing, check `git log origin/main..main` for a mid-task worker's
     partial commits (memory: push-check-worker-commits).
- **Parked by Dhia:** Q-149, a storage bucket for photos (T-301b), "revisit later".
- **Phone tests owed (Dhia):** NFC basic tags on Android (APK 6059a3f3; the fob passed after Rewrite; retry the sticker
  after pressing Start writing; quests "NFC test 2" to "NFC test 4" on 77XBUB); T-304c/T-304d (secret QR, quest
  items); location (needs the switch and a build), meet-someone, the four mini-games, practice mode, the kiosk on a
  tablet, the station page on a TV; iPhone tests wait for the Apple account (T-010).
- **Dhia's open decisions:** Q-170 to Q-229 (except those answered: Q-198 basic NFC tags only, Q-206 removed,
  Q-215 split agreed); the historical handoff's ADR-206–264 are Proposed except decisions resolved above. Highest value: Q-229 (accept +13 ms burst cost, CTO says agree),
  Q-219 (FR-1411 vs FR-1822 player reports), Q-207/Q-208 (kiosk), Q-210/Q-220 (retention).

- 2026-10-25 **Coordinator handoff taken over:** recorded Dhia's model and reasoning policy as Accepted ADR-265
  and updated the active coordinator/worker instructions (fresh independent session or subagent for every review).
  Mutation run **40139062524 remains active** per handoff; do not dispatch another run while it is active. **T-402**
  remains the next build task after the mutation queue. Dhia answered **"Keep building; deploy later"**: defer CranL
  migrations 0057–0062 and the new Android build; continue the build queue. UI copy changes require the full browser
  suite after a fresh web build; this update changes docs only and stops for independent review before further work.

- 2026-10-25 **T-402 plan committed for independent review (no implementation yet):**
  `docs/plans/2026-10-25-t-402-profile.md` covers own-only cosmetics/equipment, atomic edits, each level's guaranteed
  item/backfill, next reward, public-profile allowlist, ranking cosmetics and erasure races. Proposed ADR-266–268 /
  Q-230–232 record the split and catalog choices. T-402b immediately follows for organizer souvenirs (FR-723/1622);
  T-403 completes FR-701/702's real achievements/passport and owner history. No requirements cut. Next task action:
  fresh independent Sol High plan review, >=90 and no BLOCKER/MAJOR, then the worker's three build phases. Mutation
  queue remains independent; coordinator holds push while the current run is active. Keep building; deploy later.
- 2026-10-25 **T-402 plan review 86/100 NO-GO; revised for fresh re-review, no implementation:** migration now drains
  old in-flight erasures with player EXCLUSIVE before XP/reached barriers and requires both pre-0063 upgrade schedules;
  table-lock compatibility was verified with two local connections and rolled back, without data changes. Removed
  large-text promises to honor Accepted ADR-121, kept fixed row/avatar bounds and full accessible labels, and added
  T-402 to T-403's dependencies. Coordinator must receive fresh independent GO before build starts.

- 2026-10-25 **T-402 implementation in progress after independent plan GO94**: migration 0063, own/public profile
  API, ranking cosmetics and app locker/edit/public screens are written, not yet committed or reviewed. Focused
  checks PASS: 11 files/577 tests (DB/Redis), including both actual pre-0063 upgrade/erasure schedules and all
  security suites; API/app typechecks pass. Fresh Arabic UX review87 NO-GO identified ambiguous reward copy and
  title/error labels; author is applying those before a fresh re-review. Final full vitest, fresh web build/full
  browser suite, Expo export and fresh core code review remain. Coordinator created the requested recurring usage-
  reset heartbeat `resume-questify-after-usage-resets`, first 05:50 Riyadh (reported reset05:44); resume this active
  work after limits rather than restarting or skipping gates. Keep building; deploy later; never worker-push.

- 2026-10-25 **T-402 durable implementation checkpoint (WIP, no push; task still unchecked):** independent plan
  reviews86→94 GO, Arabic UX review87 NO-GO then copy revised and fresh review pending. Focused run11 files/577
  tests PASS with DB/Redis (both actual upgrade races, all security, ownership/privacy, ranking/app parsing); API
  and app types PASS. After that run, added PostgreSQL-microsecond pagination and both-order runtime erase/equip/seen
  tests (not yet rerun). Source/catalog/screens are written; label fixes applied per Arabic review. Remaining:
  add the upgrade/in-flight-XP schedule, app parser/frame/reward-message tests, finish short-function refactors and
  session/late-response review, update DATA_MODEL/API/SECURITY/SRS/TASKS implementation records accurately, normalize
  touched files to LF, then full vitest with DB/Redis, fresh web build + FULL browser suite, Expo export, lint/types/
  formatting/audit/secret checks. Fresh core code review only after final green checks; mark pending until GO>=90
  without BLOCKER/MAJOR. T-402b remains next, then T-403. Mutation40139062524 remains active; coordinator holds push.
  Recurring heartbeat resumes this task after actual reset05:44:06 Riyadh, first wake05:50; reschedule for future
  actual resets. Worker owns this WIP; do not restart/rebuild an unrelated feature. No CranL/EAS/deployment.

- 2026-10-25 **WIP commit af6345e saved; Arabic re-review GO96/100** (fresh independent Sol High, no
  BLOCKER/MAJOR). Current full-vitest diagnostic command uses TEST_DATABASE_URL at127.0.0.1:55432 and TEST_REDIS_URL
  at127.0.0.1:56379; running exec session **10434**. JSON report will be saved to
  `C:/Users/xdhia/AppData/Local/Temp/questify-t402-full-vitest.json`. Poll that session/read the report first on resume.
  After it ends: fix any failures, add the missing in-flight-XP-vs-upgrade test plus app profile/frame/multi-item-message
  tests, complete changed-function size refactors and late-response owner guards, then update DATA_MODEL/API/SECURITY/
  SRS/TASKS with actual coverage and pending core review. Repeat final checks if subsequent source changes warrant.
  Still owed fresh web build/full browser suite, Expo export, full workspace lint/types/format/audit/secret check and
  fresh core code review. This is WIP, not task completion; no tick, push or deploy. Mutation40139062524 stays active.

- 2026-10-25 **T-402 resumed after quota reset:** old diagnostic5666 passed/8 failed/3 skipped; exact causes
  fixed (revoked-avatar legacy assertions, ranking DTO, Hermes z.union false-positive, Questify-wide word exceptions,
  expensive upgrade-fixture setup moved into existing beforeEach hook budget). Focused regression73 tests PASS;
  app contracts/frame/reward-message + request-log redaction18 tests PASS. Added actual in-flight-XP upgrade schedule.
  Workspace lint/format/types and API/fresh web builds PASS; Android/iOS exports PASS, baseline web export lacks
  react-native-web. Audit completed exit0, two preexisting high advisories ignored by existing policy. Pinned
  official Gitleaks8.30.1 asset digest verified; committed-task scan PASS, final staged scan pending. Final full
  vitest session68090/report `C:/Users/xdhia/AppData/Local/Temp/questify-t402-final-vitest.json` is running.
  Small final owner-load gate now distinguishes loading/offline retry from signed-out (no new copy); recheck
  app guards/types/native exports after it. Full browser suite and fresh core code review remain. Mutation run
  40139062524 completed SUCCESS; coordinator dispatched T-313 mutation40156105166, so push remains held.

- 2026-10-25 **T-402 final verification underway:** source/docs complete and task remains unchecked for fresh core
  review. API/fresh web production builds, workspace lint/format/types, Android/iOS exports and dependency audit
  PASS (two existing high advisories remain ignored by unchanged policy). Default Expo web export is unavailable
  on the baseline because react-native-web is not installed; explicit native bundles are supported and no dependency
  was added. Final full vitest session68090 is running; focused current app/Hermes/word guards30 tests PASS, and
  native exports are refreshing after the small owner-load gate. Next: read final vitest JSON, run full browser suite
  against the fresh web build, final staged Gitleaks redacted scan, commit source/docs and request fresh core review.
  No deploy/EAS/push. Usage-reset heartbeat already woke successfully05:50; next scheduled10:55 Riyadh after the
  actual10:50:18 reset. Mutation40156105166 is active (T-313); coordinator owns that run and push sequencing.

- 2026-10-25 **T-402 final gates PASS; fresh core code review pending (task unchecked):** final full DB/Redis
  vitest **354 files/5681 tests passed,3 timing opt-ins skipped**,244.10s; report
  `C:/Users/xdhia/AppData/Local/Temp/questify-t402-final-vitest.json`. All three actual pre-0063 upgrade schedules,
  runtime erasure races, outsider/cross-tenant/public privacy, app contracts/Hermes and request-log masking pass.
  Fresh web build + FULL browser suite **139 passed,1 intentional phone-camera skip**,9.2m. Workspace lint/types/
  format, API build, final Android/iOS exports, audit (two existing high advisories ignored by unchanged policy)
  and digest-verified portable Gitleaks8.30.1 redacted task/staged scans PASS. Default Expo web export lacks baseline
  react-native-web; no dependency added. Real-phone Arabic/RTL and narrow cosmetic appearance remain owed; no export
  is claimed as device proof. Plan GO94 and fresh Arabic UX GO96 stand. Source/docs/refactors/upgrade-XP/app coverage
  now complete; all diagnostic sessions ended. Next: final local commit, fresh independent Sol High core code review
  >=90 with no BLOCKER/MAJOR; keep T-402 unchecked until GO, then T-402b immediately (FR-723/1622); T-403 completes
  FR-701/702. Proposed ADR-266–268/Q-230–232 stay Proposed. Pending integration: test-only branch
  `codex/t312-mutation-tests` at `137cf4416dc141994ec6cf119e2a085f5eec68c7` (`f77b531` plus minor fix), fresh
  independent review GO96 and its isolated full suite5694 passed/3 skipped,262.81s. Not integrated or pushed; ticket
  mutation90% remains unverified. Root integrates only after this worker's final clean commit and fresh core review;
  then queues a GitHub rerun of the three ticket globs after current T-313 run40156105166 finishes. That active
  mutation remains coordinator-owned/push hold;
  no push/deploy/EAS. Existing usage-reset heartbeat next10:55 Riyadh after10:50:18 reset; no duplicate created.

- 2026-10-25 **T-402 core review88 NO-GO, client fix checkpoint (task unchecked):** one MAJOR, a delayed
  provider `/me` response could restore an ended account/private cosmetics. Fix extracts the actual provider loader
  with generation checks after both awaits, invalidation on sign-out/forced end/new load/cleanup, immediate private
  state removal and no reload during logout. Deferred real-session behavioral regressions + session/profile/Hermes/
  word guards **48 tests/5 files PASS**; workspace lint/types/format PASS. Fix committed017070b. Refreshed full
  DB/Redis vitest **355 files/5690 tests PASS,3 timing opt-ins skipped**,216.76s, JSON
  `C:/Users/xdhia/AppData/Local/Temp/questify-t402-review-fix-vitest.json`; session34781 ended exit0.
  Final Android/iOS exports PASS (session72680 ended exit0); redacted secret checks PASS, source LF. Next: fresh
  independent Sol High core re-review >=90, no BLOCKER/MAJOR; author checks are not approval. Prior fresh web/full browser139 passed/1 intentional
  skip stands (no server/web/shared/copy changes). Arabic GO96 unchanged. Root integrates T-312 only after this fix
  is committed/clean and fresh core GO; no T-402b work by this author. Mutation40156105166 push hold unchanged.

- 2026-10-25 **T-402 fresh core re-review88→95 GO; ready for final integration gate (unchecked):** zero
  BLOCKER/MAJOR; independent53 native and43 DB/API checks PASS, including StrictMode/account fences. Cheap MINOR
  folded: ProfileScreen's missing identity now renders existing ProfileGate retry/error while preserving help,
  account and sign-out controls; no new copy. All native app tests **603/59 files PASS**, workspace lint/types/
  format PASS; Android/iOS exports refreshed after the fold. Previous full DB/Redis5690 PASS/3 timing skips and
  browser139 PASS/1 intentional skip remain evidence; root now cherry-picks reviewed T-312 tests, runs ONE combined
  full DB/Redis suite including this fold, and only then requests the task tick/final doc commit. Progress still
  **74 of153 tasks checked**, counted from TASKS (T-402b added); T-402 not prematurely counted. Core review is GO,
  migration0063 remains undeployed, GitHub mutation and real-phone Arabic/RTL/cosmetic visual checks are owed.
  No push/deploy/EAS. Mutation40156105166 and ticket rerun queue remain root-owned; existing heartbeat10:55 Riyadh.

- 2026-10-25 **Coordinator integration checkpoint:** T-402 code re-review GO95 (previous88 MAJOR fixed), Arabic
  GO96, and the small profile retry improvement are saved through a4178a4. Reviewed T-312 test-only commits
  f77b531/137cf44 (GO96, 5694 tests passed) were integrated on main as 162edc0/d601097; no production ticket
  code changed. Main is now d601097. The final combined DB/Redis Vitest run is active in exec session4546;
  report `C:/Users/xdhia/AppData/Local/Temp/questify-combined-t402-t312-final.json`, log with the same prefix
  ending `.log`. Read the report/poll that session first on resume. T-402 remains unchecked (74/153) until
  this integration gate passes; then record completion and continue with a fresh T-402b worker. Mutation
  40156105166 (T-313, remote main179e55d) is still active: hold push until it completes, inspect its results,
  then push only reviewed green commits after checking origin/main..main. The three ticket-file mutation
  rerun is still owed; target90 is unverified. T-402 mutation and phone visuals are also owed. No deployment
  or EAS build. Reset-resume heartbeat is active for10:55 Riyadh after reported reset10:50:18; reschedule
  it after the next actual reset. No reset credits or purchases used.

- 2026-10-25 **T-402 complete locally, reviewed and integration-green:** core code review88→95 GO (session race fixed), Arabic96 GO; retry minor folded. Reviewed ticket test-only changes are integrated as162edc0/d601097. Final combined DB/Redis suite:5728 passed,3 optional timing tests skipped,0 failures; report `C:/Users/xdhia/AppData/Local/Temp/questify-combined-t402-t312-final.json` (exec4546 exited0). Full browser139 passed/1 intentional camera skip, current native Android/iOS exports, lint/types/format, audit and redacted secret scans also passed. TASKS now75/153 checked. Migration0063 remains undeployed; T-402 mutation and real-phone/RTL visuals remain owed per batched mutation/device gates. Current mutation40156105166 is still active: all local commits remain unpushed. Next: fresh T-402b plan worker; when the active run completes inspect its results, check origin/main..main, push only finished reviewed green work, then queue the three ticket-file mutation rerun. Heartbeat next10:55 Riyadh; deployment/EAS remain deferred.
- 2026-10-25 **User resumed work; progress verified75/153 (49.02% by task count):** main clean at e5e4404 with T-402 complete/reviewed95 and final combined5728 tests passed. T-402b worker previously hit quota before writing a plan; resume that same incomplete task, do not start a duplicate. T-313 mutation40156105166 completed SUCCESS (54.43 wall minutes,0 billable): requested API first-bonus.ts88.71 and quests.ts89.38 still need targeted tests in a separate worktree; all other requested files reached90+, shared first-bonus100. Ticket test improvements are integrated and independently reviewed96; their three-file GitHub rerun remains next after reviewed-main push and green CI. No CI run is currently active. New actual quota reset15:00:55 Riyadh; same heartbeat rescheduled15:05 before work. No reset credits or purchases. Keep building, deploy later.
- 2026-10-25 **T-402b plan saved; no implementation, independent review pending:**
  `docs/plans/2026-10-25-t-402b-souvenirs.md` covers all FR-723/1622 audiences, frozen targets, rank snapshot depth,
  immutable0063 ownership extension, private source events, scoped organizer/system doors, generation-fenced bounded
  grants and erasure/rehearsal/upgrade lock schedules. Proposed ADR-269–271 / Q-233–235, not user acceptance.
  Fresh independent Sol High plan review >=90 and zero BLOCKER/MAJOR is required before code. No source/migration/
  dependency changed; no application tests/build claimed at this document-only gate. T-402b stays unchecked,
  progress75/153 (49.02%). Main6f5a899 already pushed; CI40171311885 running per coordinator: hold further push
  until it is green; root queues T-312's three-file GitHub mutation afterward. T-313 mutation40156105166 finished
  successfully; two under90 files are being handled in a separate worktree, not this docs task. Migration0063,
  real-device/CranL/EAS/deployment remain deferred. Resume heartbeat15:05 Riyadh after reset15:00:55.

- 2026-10-25 **T-313 mutation follow-up, isolated test-only verification:** run40156105166's requested API
  `quests/first-bonus.ts`88.71 and `quests/quests.ts`89.38 were the only targets below90 (historical cached files
  excluded). Added deterministic cache eviction/in-flight success and failure regressions, real-DB builder service
  bonus-boundary refusals with unchanged quest/bonus/audit state, setter outcome logging and omitted-bonus preservation.
  Full DB/Redis Vitest **359 files/5735 tests passed,3 optional timing tests skipped**,272.57s; report
  `C:/Users/xdhia/AppData/Local/Temp/questify-t313-followup-full-vitest.json`. Focused16 tests PASS; workspace
  lint/format/types, API build, audit (two existing high advisories ignored by unchanged policy), digest-verified
  Gitleaks8.30.1 redacted scan PASS. Only API test files and this state note change; fresh web/browser checks are
  unnecessary under the existing CI scope. Production code, fallback/security/cache contracts and dependencies
  remain unchanged. Fresh independent core review GO96; remote90% scores remain unverified. Coordinator owns
  integration and the two-file GitHub rerun after its current queue; no local mutation, push, deploy or EAS.

- 2026-10-25 **T-402b independent plan review88 NO-GO; revised, fresh re-review pending:** one MAJOR fixed in
  the plan: active player FOR SHARE through grant commit serializes the existing admin non-key status UPDATE;
  KEY SHARE did not. Added deterministic ban-first/evaluator-first tests, enrollment/XP blocking schedules and
  compatibility analysis for level/community payers, erasure, equip and admin status/ranking triggers. MINOR
  corrected: no data-download assembly exists; new personal souvenir records/private provenance are explicit
  T-708 integration obligations, not export infrastructure built here. ADR-269–271 remain Proposed. Documentation
  only; no application source/migration/test changed or tests/build claimed. Fresh independent Sol High plan
  review >=90 with zero BLOCKER/MAJOR required before implementation; T-402b unchecked,75/153 (49.02%).
  Current main e8f7c8e includes reviewed T-313 test follow-up (GO96;5735 passed/3 timing skips), same production
  source as6f5a899. CI40171311885 SUCCESS. T-312 targeted mutation40172088017 active on remote6f5a899: push hold
  remains; coordinator owns later T-313 two-file rerun. Migration0063 undeployed, devices/CranL/EAS deferred;
  heartbeat15:05 Riyadh remains. Commit this plan revision and stop for fresh review; no build or push by worker.

- 2026-10-25 **PAUSED AT DHIA'S REQUEST after the active plan review; do not resume automatically.** Progress75/153 (49.02%). T-402 is implemented, reviewed95 and pushed in6f5a899; CI40171311885 SUCCESS (10.9 wall minutes,0 billed). T-402b remains PLAN ONLY: independent plan reviews88→96 GO, zero BLOCKER/MAJOR, no implementation. On explicit resume, first fold the two cheap review clarifications: receipt uses composite rule/enrollment references only (no redundant direct event FK after enrollment, which would invert0053 confirmation's event→enrollment order); worker guard/refusal tests explicitly reject device-only app_device_id context in addition to player/organizer/staff/admin. Proposed ADR-269–271/Q-233–235 remain Proposed; T-402b stays unchecked.
  Ticket mutation40172088017 SUCCESS (4.5 wall minutes,0 billed): console.ts100 and routes.ts95.45 meet target; console-routes.ts85.07 still needs survivor tests in an isolated worktree, then independent review/full checks/GitHub rerun. Do not chase the two files already above90. T-313 test improvements55bccb7 are integrated locally, fresh independent GO96,5735 full DB/Redis tests passed/3 optional skips; only tests/docs changed. Their two-file remote mutation rerun is still owed and scores remain unverified. Latest local commits after pushed6f5a899 include the approved souvenir plan and reviewed test improvements; nothing after6f5a899 has been pushed. Before any future push inspect origin/main..main, require finished reviewed work, and do not interrupt desired active CI. No workflows/tests/build processes remain active at this pause.
  The existing reset-resume heartbeat resume-questify-after-usage-resets is PAUSED; its former15:05 schedule must not wake this chat while Dhia is taking a break. Wait for his explicit instruction to resume, then inspect real usage limits and re-enable/reschedule the SAME heartbeat if he wants the earlier automatic-reset behavior restored. No reset credits or purchases used. CranL migrations after0056, deployment, EAS builds and real-phone/RTL/cosmetic checks remain deferred. All current review evidence and pending work are saved; no worker is authorized to begin implementation during the break.
- 2026-10-25 **RESUMED explicitly by Dhia ("keep working now"); the break is over.** Progress75/153, T-402 complete. T-402b approved plan96 GO; before implementation retain composite rule/enrollment receipt FKs (no redundant direct event FK after enrollment) and explicitly deny device-only app_device_id worker context. Resume the same T-402b author, then fresh independent code review after full green gates. The previously requested reset heartbeat is ACTIVE again, next03:12 Riyadh on2026-10-26 after reported03:07:04 reset. No credits purchased or consumed. All earlier PAUSED notes are history overridden by this explicit resume. Deployment/EAS remain deferred.
  Current main041efc7 includes the approved plan and reviewed T-313 test-only improvements (GO96,5735 full tests passed/3 optional skips), not yet pushed after6f5a899. No CI/mutation run is active; latest CI40171311885 and mutation40172088017 succeeded. Publish only the reviewed clean checkpoint before starting build work, wait for its CI, then queue the T-313 two-file mutation proof. Separately chase only ticket console-routes.ts85.07 in an isolated worktree; console.ts100/routes.ts95.45 are already above90. T-402/T-402b mutation batch remains owed; never local Stryker.
- 2026-10-25 **T-402b implementation WIP after approved plan88→96 GO; unchecked75/153:** migration0064 now
  extends typed ownership with closed rules/targets/receipts, generation-fenced work/scans and durable scoped
  command replay; rank depth extends confirmed snapshots, result-place facts enqueue work without changing0053's
  confirmation body. System guard excludes device-only identity, grants hold player FOR SHARE through commit,
  receipt composite FKs avoid a direct event-lock inversion, and cleanup extends0063. Organizer forms/controls,
  shipped previews and private locker event attribution are connected. Fresh independent Arabic84→94 GO,
  no BLOCKER/MAJOR; cheap wording minor folded. Focused29 souvenir/lock and518 results/security/rehearsal tests
  passed; initial11 profile ownership tests passed. New upgrade/refusal/browser cases, final full DB/Redis,
  web build/full browser/native exports/lint/types/audit/secrets and fresh core code review remain owed. No
  implementation completion or release is claimed. Main4bca465 reviewed checkpoint was pushed; CI40224593807
  SUCCESS,404000ms (6.73wallmin),0 billed. Root's reviewed optional mutation-force config is side-branch only;
  forced console mutation40226079637 active/queued, T-313 two-file rerun and profile/souvenir batch remain root-owned.
  No worker push/local Stryker/deploy/EAS; migration0064 undeployed and phone/RTL checks deferred. Heartbeat03:12
  Riyadh2026-10-26 after actual03:07:04 reset remains active. Continue this same worker; no other main writer.

- 2026-10-25 **T-402b durable implementation checkpoint; final verification pending, NOT complete:**
  Source is frozen for the final rerun after self-audit fixes. Since a4ab626: activation accepts the legitimate
  300-quest target body (activation-only512KiB limit plus HTTP regression); catalog writers serialize on item;
  repair/enqueue skips already-owned rule/player pairs; audit records settings without free names; final scoped
  UI retry/read fencing, private native event provenance, HTTP/security/native/shared and Arabic browser cases
  are saved. Arabic84→94 GO and plan88→96 GO remain source/plan evidence, not core-code approval. TASKS remains
  unchecked75/153 (49.02%); Proposed ADR-269–271/Q-233–235 remain Proposed. Migration0064 remains undeployed.
  Final fresh web build exec3002 PASS (exit0), log `C:/Users/xdhia/AppData/Local/Temp/questify-t402b-web-final-build.log`.
  Current workspace shared/API/app/web types PASS exec47984. Its lint failed only the manual benchmark console.log;
  changed that to process.stdout.write, so final lint rerun is owed. Earlier API build/audit PASS (two existing high
  advisories ignored by unchanged policy); Android export6359 PASS, log `Temp/questify-t402b-android.log` and output
  `Temp/questify-t402b-android`. iOS export is owed. Focused evidence: original11 ownership;29 souvenir/locks;
  518 results/security/rehearsal; updated HTTP/shared/native/copy15 passed. Final-focused51807 had12 pass/1 fail:
  optimized repair changed scan order; fixture fixed and targeted expired-lease rerun PASS1/6 filtered skips.
  Log `Temp/questify-t402b-final-focused.log`; no known unresolved focused failure, but full rerun remains required.
  Initial full Vitest99199 and browser56935 were deliberately cancelled after real source fixes, NOT passing runs.
  Logs `Temp/questify-t402b-full.log` and `Temp/questify-t402b-browser.log`; initial browser discovered142 cases.
  No local check process remains active:3002/47984 completed; cancelled suites left no3100/4100 listeners. The
  final DB/Redis Vitest slot is available; coordinate before running ONE full suite. Full final DB/Redis Vitest,
  FULL browser142 from the fresh build, iOS export,20k convergence benchmark, final lint/format/API build/redacted
  secret scans and fresh independent core code review remain owed. Benchmark source is manual support script
  `apps/api/test/support/souvenir-benchmark.ts`, not yet run; bundle alongside test-db in support before execution,
  set TEST_DATABASE_URL and optional SOUVENIR_BENCH_REPORT. Do not claim20k latency until actual report exists.
  Reviewed remote main4bca465 CI40224593807 SUCCESS,404000ms/6.73wallmin,0 billed. Mutation-force configfb0fba4
  GO98 is side-branch only. Forced console40226079637 SUCCESS98.51% (65Killed+1Timeout,1Survived,3Ignored),
  983000ms/16.38wallmin,0 billed; artifacts `Temp/questify-forced-console-40226079637`; no further console chase.
  Forced T-313 two-file run40227738340 ACTIVE per coordinator; root owns it and the push hold. T-402/T-402b mutation
  batch remains owed, never local Stryker. Heartbeat ACTIVE03:12 Riyadh2026-10-26 after03:07:04 reset; no credits.
  Save this checkpoint locally, do not push or commission core review before remaining gates. Continue the SAME
  worker after reset; physical-phone RTL/cosmetic visuals, CranL migrations/deployment/EAS remain deferred.

- 2026-10-26 **T-402b resumed from b0944d3; frozen-source final gates running:** full DB/Redis Vitest exec4924,
  log/report `C:/Users/xdhia/AppData/Local/Temp/questify-t402b-final-vitest.{log,json}`. iOS export48842 PASS,
  output/log `Temp/questify-t402b-ios`; lint/format67520 PASS; current API build PASS, audit61415 pending.
  Redacted Gitleaks8.30.1 scan of4bca465..b0944d3 PASS. No source edits since the checkpoint. Fresh web build3002,
  workspace types47984 and Android6359 remain current evidence. Full browser142 follows the full suite, then20k
  benchmark runs alone; final docs/staged scan and fresh independent core review still owed. T-402b unchecked75/153.
  Coordinator verified forced T-31340227738340 SUCCESS: API first-bonus93.55%, quests90.27%, both>=90, no chase;
  1386000ms/23.10wallmin,0 billed. Artifacts `Temp/questify-forced-first-bonus-40227738340`. All prior T-312/T-313
  mutation follow-ups are now closed; T-402/T-402b batch remains owed. No current remote CI/mutation; main WIP
  push hold remains. Configfb0fba4 stays isolated until root integrates after this worker's green checkpoint.
  Heartbeat ACTIVE08:22 Riyadh after coordinator-reported actual08:16:06 reset; no credits. Continue same worker.

- 2026-10-26 **Final-gate diagnosis, no production changes:** full4924 completed324.45s with5786 passed,
  3 optional timing skips and3 failures; retain its JSON/log as failed evidence, not a green gate. Fixed test-only
  issues: community gate-map classifies souvenir_action through actual staff/tenant guards; outsider table query
  now schema-qualified; rehearsal test creates an immutable rehearsal enrollment and proves a real member still
  receives the item. Focused4996 then97 passed/1 failed: PostgreSQL's FK guard preceded the intended truncate
  trigger; changed the test to TRUNCATE CASCADE. Targeted truncate rerun1 passed/24 filtered skips in5.36s.
  Logs `Temp/questify-t402b-failures-rerun.log` and `Temp/questify-t402b-truncate-rerun.log`. Final full rerun remains
  required. All current production/web/native build evidence remains valid.20,001-recipient benchmark exec4363
  is running alone; JSON/log `Temp/questify-t402b-20k.{json,log}`. No full/browser/export overlaps this measurement.
  Audit61415 PASS under unchanged two-high-advisory exceptions. Next: benchmark result, then final full Vitest,
  FULL browser142, final changed-test static checks/docs/secrets, local green checkpoint for independent core review.

- 2026-10-26 **T-402b synthetic20k benchmark PASS; final full rerun active:** exec4363 completed exit0.
  Report/log `C:/Users/xdhia/AppData/Local/Temp/questify-t402b-20k.{json,log}`:20,001 owned,0 due,0 failed,
  443,198ms convergence;20,001-row source enqueue storm23,401ms.7,399 back-to-back calls/213 nonempty passes,
  max160 recipients/pass below500; slowest2,764ms because2s budget is checked between transactions, not a hard
  deadline. Isolated local Docker/one joined rule, no full/browser/export overlap; normal5s cadence and production
  capacity/all-audience100-rule load are not measured. Generated support bundle safely removed after completion.
  Full frozen-production-source Vitest rerun exec66372 now active, JSON/log `Temp/questify-t402b-final-vitest-rerun`.
  Test-only corrections from the failed run are included; no production change or stale-build claim. Browser142,
  final static/docs/staged secret scan and independent core review remain owed. Keep T-402b unchecked75/153.

- 2026-10-26 **Final rerun66372 not green:5788 passed/3 optional skips/1 upgrade timeout,324.02s.**
  All prior3 failures are resolved. First actual0063-erasure upgrade test exceeded30s; old trace identifies only
  the test start, not the exact phase. Prior full-run durations for these three setup-in-body tests were20.27s,
  19.37s,17.62s; this run30.01s(timeout),23.68s,12.90s. Do not claim proven production failure or proven setup
  phase from that trace. Moved preSouvenir database construction/63 migrations into beforeEach (existing60s hook),
  cleanup into afterEach; behavioral crossed-lock assertions retain the existing30s test budget. Failure-only
  diagnostics now distinguish incomplete fixture from behavior/cleanup and report fixture time. No production
  change or global timeout increase. Focused upgrade lifecycle exec13575 PASS3/3 in14.54s, log
  `Temp/questify-t402b-upgrade-lifecycle.log`; affected-file lint and API types PASS. Save this test-fix checkpoint
  and run the required final full again. Logs/reports of both failed
  full runs are preserved. Lint/format/types19666 PASS before this lifecycle-only refinement; recheck affected file.

- 2026-10-26 **Test-fix checkpoint4c1ac36 saved clean; final full exec90390 active:**
  `Temp/questify-t402b-verified-vitest.{json,log}`. Focused upgrade3 passed/14.54s; affected lint/API types and
  redacted staged secrets PASS. Production remains b0944d3's frozen source, current builds/native exports valid.
  Browser142 follows the completed full run; no local mutation/push/deploy/EAS. Keep T-402b unchecked75/153.

- 2026-10-26 **Final DB/Redis suite GREEN at4c1ac36:** exec90390 exit0,366 files/5789 tests passed,
  3 optional timing skips,0 failures in288.94s. Report/log `Temp/questify-t402b-verified-vitest.{json,log}`.
  Full browser142 now exec1127, report/log `Temp/questify-t402b-browser-final.{json,log}`, against the current fresh
  production web build3002 plus freshly bundled test API. First launch failed before tests because PowerShell
  split an unquoted reporter comma; corrected argument, no application change, diagnostic retained separately in
  `Temp/questify-t402b-browser-startup.log`. Full Vitest slot released. No production source change this resume;
  full/native/static/benchmark evidence remains current. Browser completion, final docs/staged secrets/local commit
  and fresh independent core review remain. Keep T-402b unchecked75/153; root owns later reviewed config integration.

- 2026-10-26 **Browser found real souvenir page forwarder bug; full1127 continues, not green:**
  Desktop case64 timed out waiting for Add because useSouvenirs used /api/v1 instead of the existing /v1 forwarder.
  Its trace proves307 to /ar/api/v1 then404; page showed the intended load-error state. Diagnostics preserved in
  `apps/web/.e2e/results/souvenirs-creates-and-edit-06250-d-stops-a-permanent-promise-desktop/trace.zip` and
  error-context.md. Corrected only the new hook's prefix in source; running browser still serves the OLD build,
  so do not interpret later pass/fail as verification of that edit. Let FULL142 complete without cancellation.
  Next: make the existing real-forwarder browser regression assert its actual GET response, fresh web build,
  focused souvenir desktop/phone, checkpoint the verified repair, final full frozen-source Vitest and FULL browser.
  No API/SQL/native/shared/copy change; iOS/Android/20k evidence remains valid.5789-pass suite90390 is prior to this
  web fix; its required final rerun is owed. Parent has enough quota; do not rush or mark T-402b done.

- 2026-10-26 **First FULL142 browser completed with139 passed/1 intentional skip/2 failed (10.3min):**
  Both souvenir desktop/phone cases reproduce the same /api/v1 forwarder bug. Full report/log preserved at
  `Temp/questify-t402b-browser-final.{json,log}`; original default .e2e/results traces retained. Source repair is
  one prefix in use-souvenirs.ts (/v1), and the existing real-API browser flow now explicitly awaits its exact
  forwarded GET200 before interacting. No mocking or proxy allowlist workaround. Fresh web build exec64981/log
  `Temp/questify-t402b-web-forwarder-build.log` active. Next focused desktop/phone souvenir browser using a separate
  output directory, checkpoint repair, final static/type checks, required final Vitest and FULL142 browser reruns.
  No native/API/SQL/shared/copy change; their exports/benchmark remain current. Task still unchecked75/153.

- 2026-10-26 **Souvenir forwarder repair focused-GREEN:** fresh web build64981 PASS, workspace lint/format
  and all four types PASS. The real forwarder browser assertion now observes /v1/.../souvenirs GET200. First
  focused34704 then exposed only an ambiguous draft-status selector matching Edit/Delete button text; changed to
  anchored status text, preserving the production UI. Focused86804 PASS desktop+phone2/2 in18.4s, including all four
  audience helpers, create/edit, activation permanence/current membership, stop and360px RTL overflow assertion.
  Logs/reports `Temp/questify-t402b-browser-focused-rerun.{log,json}`; earlier failed focused report/traces preserved
  under `Temp/questify-t402b-browser-focused` and `Temp/questify-t402b-focused-browser-results`. Production repair
  remains just the new hook's /v1 prefix. Save repair checkpoint before final full Vitest and FULL142 browser;
  native/API/SQL/shared/copy/20k evidence unaffected. Final task/core review still pending,75/153 unchecked.

- 2026-10-26 **Repair checkpointc2353c9 saved clean; final frozen-source full Vitest18450 active:**
  report/log `Temp/questify-t402b-forwarder-vitest.{json,log}`. FULL142 browser rerun follows using fresh web64981;
  retain all prior failed/cancelled evidence. No further source changes planned. Final docs and independent core
  review remain; task unchecked75/153, no worker push/deploy/EAS/local mutation.

- 2026-10-26 **Final frozen-source Vitest18450 GREEN atc2353c9:**366 files/5789 tests passed,3 optional timing
  skips,0 failures,290.78s. Report/log `Temp/questify-t402b-forwarder-vitest.{json,log}`. Current web build64981
  includes the observed forwarder fix; focused desktop/phone2/2 PASS. FULL142 browser verified rerun started next,
  output `Temp/questify-t402b-verified-browser-results`, report/log `Temp/questify-t402b-browser-verified.{json,log}`.
  Earlier failing traces remain intact in the original paths. Native exports,20k measurement and static/audit
  evidence remain current. Full Vitest slot released; only browser completion/final docs/secrets/commit then fresh
  independent core review remain. Keep task unchecked75/153, no push/deploy/EAS/local Stryker.

- 2026-10-26 **T-402b author verification GREEN; ready for fresh independent core CODE review, NOT complete:**
  Production source cutoffc2353c9. Final full DB/Redis exec18450 PASS366 files/5789 tests,3 optional timing skips,
  0 failures,290.78s; `Temp/questify-t402b-forwarder-vitest.{json,log}`. Fresh production web build64981 PASS;
  FULL142 browser37282 PASS141/1 intentional phone-camera skip,0 failures,417.28s; report/log
  `Temp/questify-t402b-browser-verified.{json,log}`. Focused real-forwarder desktop/phone86804 PASS2/2. Original
  failed/cancelled runs and traces remain explicitly documented, never substituted for passing evidence. The real
  /api/v1→/v1 integration fix and anchored draft-status assertion are committed; no source changes afterc2353c9.
  Current Android6359/iOS48842 exports PASS. Workspace lint/format/all types, API build and audit PASS (unchanged
  two existing high-advisory exceptions). Redacted committed-range/repair/final staged Gitleaks8.30.1 scans PASS;
  source LF and staged diff clean. Generated benchmark bundle removed; no local command or browser server remains.
  Isolated20,001-recipient benchmark PASS:443,198ms,0 due/failed,max160 recipients/pass; detailed bulk-enqueue and
  back-to-back-cadence limitations remain in RUNBOOK, not a production capacity claim. Plan88→96 GO and Arabic
  84→94 GO already independent; no fresh Arabic review needed because no copy changed during this resume.
  Keep T-402b UNCHECKED75/153 (49.02%) until fresh Sol High core code review >=90 with zero BLOCKER/MAJOR. Proposed
  ADR-269–271/Q-233–235 remain Proposed. Root owns review and subsequent configfb0fba4 integration/push/CI.
  Suggested mutation targets (GitHub-only, only changed core files): apps/api/src/souvenirs/*.ts,
  apps/api/src/players/items.ts, apps/api/src/players/item-routes.ts, packages/shared/src/souvenirs.ts,
  packages/shared/src/players/items.ts; reviewer/coordinator may narrow pure wiring/format branches. No broad repo
  mutation. T-402/T-402b batch and physical-phone RTL/cosmetic checks remain owed.0063/0064 undeployed; CranL,
  deployment and EAS remain deferred. T-312/T-313 forced proofs are closed, no current remote CI/mutation active.
  Latest reviewed remote4bca465 CI40224593807 SUCCESS6.73wallmin/0 billed. T-31340227738340 requested files93.55/
  90.27 meet target; console40226079637 98.51 meets target, no survivor chase. Heartbeat ACTIVE08:22 Riyadh after
  coordinator-reported08:16:06 reset; no credits. Worker commits this green evidence and STOPS for core review.

- 2026-10-26 **Coordinator integrates independently reviewed mutation CI maintenance:** fb0fba4, authored in
  isolated codex/mutation-force-input from4bca465, received fresh independent GO98 with no findings. Optional
  boolean force=false uses an environment binding and exact-true --force alongside unchanged incremental mode,
  cache, permissions and dependencies. Installed Stryker10 source/help verified; author15 and reviewer24 stubbed
  Bash cases/YAML checks passed, plus baseline full DB/Redis5735 passed/3 optional skips, lint/format/types,
  API build/audit/redacted history+commit scans. No local mutation ran. The nine stale static schema survivors in
  run40172088017 were cache reuse, not missing boundary tests. Forced console40226079637 now proves98.51%
  (16.38wallmin,0 billed); forced T-31340227738340 proves first-bonus93.55%/quests90.27%
  (23.10wallmin,0 billed). All these targets meet90; no further chase. STATE conflict resolved by retaining the
  complete current souvenir verification/history and current queue rather than the older branch queue.
  Fresh independent core reviewer /root/t402b_code_review is active on immutable4bca465..db53d11, production
  cutoffc2353c9. This integration changes workflow/docs only; no task source or tests changed. No push until core
  GO and required checks. Heartbeat ACTIVE08:22 Riyadh after actual08:16:06 reset; no credits/deploy/EAS.

- 2026-10-26 **Fresh independent core review84 NO-GO: one BLOCKER, one MAJOR; task remains unchecked.**
  Reviewer reproduced editor POST201, then only event_scope revoked to another event of the SAME organizer;
  GET404 but identical POST key replayed201 with idempotent-replayed:true and the private old rule list.
  Existing organizer membership checks were insufficient because membership stayed active. Added all-six-route
  real cache middleware regressions; red run review-auth-red2 reproduced six failures. Earlier red fixture-only
  missing join_code failure is separately retained. Repair is scoped to souvenir routes: preValidation now runs
  current SQL event authorization before global cached preHandler; handler SQL still authorizes every write.
  No global rewrite or claim about unrelated routes. API/SECURITY notes document this invariant.
  MAJOR missing new-door proof addressed with actual automatic work/evaluator tests: finished zero-right quizzes
  for category/all, last-attempt short games, still-open games, unlimited games, and a forced completion that
  holds its queue write while waiting for XP against concurrent evaluation and old-generation acknowledgment.
  Added activation-versus-confirmation both lock orders with5s lock timeouts, exact committed snapshot depth,
  receipts/items and stale-preview refusal/refresh. Focused routes/new doors18 passed25.78s; confirmation locks
  2 passed8.42s. Small test helper extraction for the 100-line limit followed; combined focused rerun passed all 20 tests in 26.56s (exec 5871, Temp/questify-t402b-review-matrix.log).
  Lint/all types PASS; no SQL/native/shared/copy or payer change, so native/Arabic/20k evidence remains valid.
  Save focused repair checkpoint before final full DB/Redis, fresh web build/FULL browser, API build/audit/secrets
  and NEW fresh independent re-review (different reviewer). No push/deploy/EAS/local Stryker. Main5c87d29 includes
  root's reviewed mutation-force workflow/config integration; no current remote CI/mutation. Keep75/153.

- 2026-10-26 **Review repair checkpoint 7c0843b committed; final gates active:** all 20 focused regressions
  passed together in 26.56s. Extracted helper needed a compile-time literal tuple annotation; API types passed
  after that correction. Workspace lint/format and staged redacted secrets PASS. Full DB/Redis exec 90379,
  `Temp/questify-t402b-review-full.{json,log}`; fresh web build exec 56569,
  `Temp/questify-t402b-review-web-build.log`; API build/audit exec 60003 (build passed, audit pending).
  FULL browser must use a freshly rebuilt test API bundle after these gates because the route hook changed.
  SQL/payer/shared/native/copy are unchanged: prior native exports, Arabic review and 20k benchmark remain valid.
  Current source is frozen; only a concrete failure justifies another edit. No current remote CI/mutation.
  Keep T-402b unchecked 75/153; root commissions a NEW independent reviewer after green final evidence.

- 2026-10-26 **Review-repair full DB/Redis GREEN at 7c0843b:** exec 90379 passed 368 files / 5,803 tests,
  3 optional timing skips, 0 failures in 311.69s; `Temp/questify-t402b-review-full.{json,log}`. Fresh web build
  56569 and API build/audit 60003 PASS (two existing high advisories ignored by unchanged policy). Test API bundle
  rebuilt with the current pre-replay authorization hook. FULL 142 browser exec 83776 active; report/log
  `Temp/questify-t402b-review-browser.{json,log}`, unique output `Temp/questify-t402b-review-browser-results`.
  No production change after the repair checkpoint. Browser completion, final docs/redacted secret scan/commit and
  NEW independent core re-review remain. The last independent verdict is still 84 NO-GO, never author-approved.
  Task unchecked 75/153. Native exports, Arabic review and SQL benchmark evidence remain current; no push/deploy/EAS.

- 2026-10-26 **Review repairs and final author gates GREEN at source 7c0843b; NEW core re-review required:**
  Scoped souvenir preValidation resource authorization now precedes global cached replay on all six mutation
  doors, including process. The actual middleware regressions reproduced all six leaks before repair and passed
  afterward. The 20-case new-door/race matrix passed, including zero-right quiz automatic work, exhausted/open/
  unlimited games, queue-before-XP completion against evaluator/old ack, and activation/confirmation both lock
  orders with finite 5s waits and exact depth/receipt/item outcomes. No SQL or payer change was needed.
  Final full DB/Redis exec 90379: 368 files / 5,803 passed, 3 optional timing skips, 0 failures, 311.69s;
  report/log `Temp/questify-t402b-review-full.{json,log}`. Fresh web build 56569 PASS and rebuilt test API;
  FULL browser 83776 PASS: 141 passed / 1 intentional phone-camera skip, 0 failures, 436.30s, report/log
  `Temp/questify-t402b-review-browser.{json,log}`. Workspace lint/format/all types, current API build and audit
  PASS with unchanged two existing high-advisory exceptions. Redacted committed-range/staged Gitleaks scans PASS;
  all task source LF and staged diff clean. No active local command or browser server remains.
  Native Android/iOS exports, Arabic 84→94 approval and the isolated 20k SQL/worker benchmark remain valid because
  no corresponding source changed. Last independent CORE verdict remains 84 NO-GO; author verification does
  not replace it. Root must use a NEW independent Sol High reviewer, excluding author and first code reviewer,
  and obtain >=90 with zero unresolved BLOCKER/MAJOR before ticking T-402b. Keep 75/153 (49.02%) unchecked.
  Proposed ADR-269–271 / Q-233–235 unchanged. API/SECURITY document the pre-replay authorization invariant; no
  claims or broad rewrite of unrelated routes. Prior red/failed/cancelled evidence is retained. Root owns reviewed
  push/CI and later T-402/T-402b mutation batch; no current remote CI/mutation. Config integration 5c87d29 is already
  independently reviewed. No worker push/deploy/EAS/local mutation; physical phone/CranL/migrations remain deferred.
  This worker commits the green repair evidence and STOPS for the new independent re-review.

- 2026-10-26 **Coordinator checkpoint: fresh independent core re-review ACTIVE, no approval yet.**
  Reviewer /root/t402b_code_review_2 reviews immutable4bca465..8f32f05 (production cutoff7c0843b), separate from
  author and first reviewer. First review84 NO-GO found cached replay after event-scope revocation and missing
  evaluator/forced-lock proof; author repairs and all final gates are saved in7c0843b/8f32f05. Root independently
  parsed final reports:5803 passed/3 optional skips/0 failed; browser141 passed/1 intentional skip/0 flaky.
  Main remains unpushed after reviewed remote4bca465. No local check, remote CI or mutation is active; author
  stopped, no duplicate worker. Quota89% used; next reset08:16:06 Riyadh, same heartbeat ACTIVE08:22. Preserve
  re-review findings/verdict before any push; only GO>=90 with no BLOCKER/MAJOR closes this gate. No credits.

- 2026-10-26 **Fresh independent re-review could not run: automated safeguard failure, no verdict.**
  /root/t402b_code_review_2 failed with: "This content was flagged for possible cybersecurity risk."
  No review score or approval was returned. Do not treat this failure as GO, silently substitute author approval,
  or route around the safeguard. The provider message suggests a supported review-access path before retrying.
  Human action is needed to arrange a permitted independent review path; retain the unpublished source at
  7c0843b and green evidence8f32f05. Main also contains coordination checkpoint8958447; remote remains4bca465.
  All final tests/builds and both repair matrices remain saved, but the last valid independent core verdict is
  still84 NO-GO until a fresh reviewer validates closure. T-402b stays unchecked75/153 (49.02%). No active local
  commands, workers, remote CI or mutation. No push/deploy/EAS/credits. Keep heartbeat ACTIVE08:22 Riyadh;
  while this condition is unchanged, stay quiet and do not resubmit the blocked review automatically.

- 2026-10-26 **PAUSED by Dhia for handoff to a new Codex session.** His instruction: finish saving the current
  task checkpoint, take a break, and give a short takeover prompt. The implementation cannot be declared complete:
  the fresh independent re-review remains blocked without a verdict. All source, repairs and green evidence are
  committed locally (source7c0843b/evidence8f32f05; main3e0529d before this documentation commit), no push.
  `docs/agents/COORDINATOR_HANDOFF.md` is the concise durable takeover map. Progress remains75/153, T-402b unchecked.
  Heartbeat resume-questify-after-usage-resets is now PAUSED, overriding all earlier ACTIVE schedules. No active
  worker, local check/server, remote CI or mutation remains. This coordinator stops; the new session must retain
  the supported-review requirement, existing gates and deployment/EAS deferral. No credits used.

- 2026-10-26 **T-402b re-review 87 NO-GO repaired; fresh independent re-review of the delta pending.** The re-review
  of 4bca465..8f32f05 closed both 84 findings and found grants correct, but the repair sweep never ended: every minute
  it re-queued all non-recipients of rank/category rules. Production repair 81d5054 (undeployed 0064 edited in place;
  CranL stays at 0056): finite passes per activation/Process that wait for live and delete themselves, rank rules
  without a pass, triggers for operator play/removal and account reinstatement, least(ready_at), an unlocked evaluator
  pre-check, lease release for unevaluated claims, control/bidi name refusal in schema and SQL (22P05→400), 409
  souvenir_data for deleting a draft event with souvenirs, work erased last. Proposed ADR-272, Q-236 (design) and
  Q-237 (central replay-before-scope fix for other routes). Focused souvenir/security/rehearsal/event suites green;
  full DB/Redis 5819 passed / 3 optional skips; lint/format/types PASS. No web code changed, so no browser rerun.
  T-402b stays unchecked, 75/153 (49.02%). No push, deploy, EAS or mutation. Follow-up: category/quest deletion that a
  souvenir names still answers 500.

- 2026-10-26 **T-402b DONE: repair re-review GO 93; three fold-ins committed.** The third code review (8f32f05..81d5054
  plus the coordinator's Arabic fix 6a53ef2) returned GO 93 with zero BLOCKER/MAJOR. It was run by the in-house CTO
  reviewer (Claude Opus): **the recorded GPT-6.1 Sol review policy (ADR-265) could not be used from the Claude Code
  session; Dhia should know the gate ran on another model.** Independent Arabic review of the event-delete string 72,
  fixed in 6a53ef2. Fold-ins 6d7dd9c/597c009: 409 `souvenir_in_use` (three new bilingual strings in http-errors.ts, awaiting Arabic review) for
  deleting a category a souvenir rule names or a quest an activated souvenir froze (was 500); the every-quest-only
  completion/ack lock test; enqueue triggers renamed `enqueue_souvenir_on_*` so they fire before `mark_ranking_on_*`
  (removes a rare 40P01 with a rejoin) plus a trigger-order assertion. Focused 983 passed; full DB/Redis 5824 passed / 3 optional skips / 0 failed;
  lint/format/types PASS; no web code changed. No new ADR/Q (ADR-272, Q-236, Q-237 stay Proposed). Progress
  **76/153 (49.67%)**. No push, deploy, EAS or mutation by the worker; 0063/0064 remain undeployed (CranL at 0056).

- 2026-10-26 **T-402b pushed; CI green; mutation dispatched (coordinator).** `4bca465..6286d41` (18 commits) pushed
  after the Docker gitleaks scan (419 commits, no leaks) and a fresh Sonnet Arabic review of the three `souvenir_in_use`
  strings (84; quest and category-with-quests wording fixed in 6286d41, Q-238 added for fixed refusal wording vs renamed
  terms). CI run 40356348454: success, 14 min, browser 141 passed / 1 skipped. Mutation run 40358820903 (GitHub only,
  one at a time) targets `apps/api/src/souvenirs/*.ts`, `apps/api/src/players/{items,item-routes}.ts`,
  `packages/shared/src/souvenirs.ts`, `packages/shared/src/players/items.ts`, tests excluded; chase only files under 90.
  CLAUDE.md gains Dhia's cost cap (one sub-agent at a time, two only for review plus next build; the strongest model
  only for core work). Progress **76/153 (49.67%)**. No deployment, EAS, phone or local mutation.

- 2026-10-26 **T-403 plan written, awaiting independent plan review.** `docs/plans/2026-10-26-t-403-achievements.md`
  covers three parts (ADR-273): **T-403 CORE** (event city, final-rank snapshot at confirm, Event Passport and owner
  history reads, achievement tiers through one `questify_sync` evaluator, public profile achievements and public-event
  stamps only; 0065), **T-403b CORE** (always-on and seasonal Questify quests, console API, XP source `questify`; 0066),
  **T-403c STANDARD** (app, dashboard and console screens, copy). No change to the scan transaction; follow Questify not
  built (store risk). Proposed ADR-273 to ADR-279, Q-239 to Q-245. TASKS gains T-403b/T-403c (now 155 tasks). No code.

- 2026-10-26 **T-403 built (core), awaiting the independent core code review; not ticked.** First commit folded the plan
  review's amendments (88, one MAJOR) into the plan, ADR-273..279 and Q-239..245 (ADR-276: other players see a played
  event only once it has ended or been archived, public and not workplace; never while live). Migration 0065 (new,
  undeployed; 0063/0064 untouched): `city` (20 seeded), `event.city_id` with `event_city_guard` (fixed once live, every
  role, `CY409`), `final_rank` written with `result_place` in one CTE over `all_places` plus `backfill_final_ranks`
  under an `event_result` lock, `achievement` (five seeded) and append-only `achievement_earned`, one
  `played_enrollment` rule, `questify_sync` (unlocked pre-check, player KEY SHARE → `player_xp`), `own_achievements`,
  `own_events`, `public_player_profile` with tiers and at most 50 ended public stamps. API `apps/api/src/questify/`:
  `POST /v1/me/questify/sync` (20/min), `GET /v1/me/achievements`, `GET /v1/me/event-history?played=` (cut 1's single
  door; `/v1/me/events` is the switcher's), public `GET /v1/cities`; event `cityId` (422 unknown/virtual, 409
  `city_locked`); the public profile is parsed through the shared allowlist; shared `packages/shared/src/questify/`.
  Tests: focused 53 files / 727 passed (DB achievements 15, event-passport 9, final-rank 4 + opt-in 20,000-member
  confirm under 10 s, routes 4, events city 3, security suites); full `npx vitest run` 374 files, 5863 passed / 4
  skipped / 0 failed; oxfmt, oxlint --deny-warnings and tsc clean for api and shared. No app or web code changed. No
  new ADR/Q (build notes in the plan). Mutation owed on GitHub with T-403b (one dispatch, cut 7).

- 2026-10-26 **T-403 done (core), ticked; progress 77/155.** Code review GO 93 by the in-house CTO reviewer on Claude
  Opus (the recorded Sol policy could not be used from the Claude Code session); plan review 88, then folded. Its MINOR
  folded in 0065 in place (undeployed): `top10` counts a final place only on a membership with a standing credit, so
  welcome points alone never earn Top Ten (new DB test). `GET /v1/cities` sends `cache-control: public, max-age=3600`;
  API.md, DATA_MODEL.md and the plan's build notes updated (lock-order note to T-403b, `rank_state` note to T-403c; a
  NULL `profile_player()` in event history left as an empty page). Not pushed by the worker.

- 2026-10-26 **T-403b built (core), awaiting the independent core code review; not ticked.** Migration 0066 (new,
  undeployed; 0063 to 0065 untouched) takes `xp_entry` then `player_xp` up front in scan order under a 10 s lock
  timeout: `questify_campaign`, `questify_quest` (seeded active: attend 3 events, play in 2 cities, 300 XP each),
  append-only `questify_award`; `xp_entry` source `questify` (no ledger entry, CHECK `xp_entry_shape`, never reversed);
  the window as `standing_credits`/`player_metrics(player, since, until)` on `ledger_entry.created_at`; `questify_sync`
  pays each met quest once (award, XP entry, `xp_apply`, level items) and answers `quests` and `levelUp`;
  `own_questify_quests`; six console doors that re-read the admin and audit ids and field names. API
  `GET /v1/me/questify-quests` and `/v1/admin/questify/*` (Idempotency-Key on every write; `409 questify_conflict
  {reason}`, `422 invalid_questify {field}`); shared `packages/shared/src/questify/quests.ts`. Tests: DB
  questify-quests 18, routes quests 3 and questify 4, unit 6, achievements 16, security suites 492; full suite 377
  files / 5892 passed / 4 skipped / 0 failed;
  oxfmt, oxlint --deny-warnings and tsc clean for api and shared. Proposed ADR-280 / Q-246 (console rules; ADR-093's
  "seasonal campaigns" read as configuration, not FR-711). No app or web code changed.

- 2026-10-26 **T-403b done (core), ticked; progress 78/155 (50.32%).** Code review GO 94 of 7b8b981 by the in-house CTO
  reviewer on Claude Opus (the recorded Sol policy could not be used from the Claude Code session); no re-review. Two
  minors folded in 0066 in place (undeployed): `questify_admin()` raises `QY403` and only that maps to 404, so a real
  42501 (a lost EXECUTE grant) answers 500 (unit and HTTP tests); a published campaign that has started refuses a new
  quest, `409 questify_conflict {reason: started}` (DB and HTTP tests). API.md, ADR-280 and the plan's build notes
  updated. Focused suites (questify-quests DB, test/questify, src/questify, security) 525 passed; oxfmt, oxlint and
  tsc clean for api and shared. Not pushed by the worker.

- 2026-10-26 **First GitHub mutation result for T-402/T-402b:** run 40358820903 on 6286d41, 8 files mutated (the
  report's other rows are stale from earlier runs). souvenirs.ts 98.11, souvenirs/routes.ts 97.89; under 90, to chase
  with tests only: souvenirs/payer.ts 84.42 (11 no-cov, 1 survived), souvenirs/tick.ts 0.00 (65 no-cov: no test
  imports it), players/items.ts 80.65 (12 survived), players/item-routes.ts 79.31 (6 survived, 6 no-cov),
  `packages/shared/src/souvenirs.ts` 58.56 (45 survived), `packages/shared/src/players/items.ts` 0.00 (43 survived,
  11 no-cov; no unit test of its own). Cause: `stryker.config.json`'s default `mutate` list leaves out
  `apps/api/src/souvenirs/**`, `apps/api/src/questify/**`, `packages/shared/src/souvenirs.ts` and
  `packages/shared/src/questify/**`; only the dispatch input mutated them. Proposed after the chase (needs Dhia's OK,
  not done): add those globs to the default list.

- 2026-10-26 **Mutation chase tests added for the six T-402/T-402b files under 90 (tests only, no source change):**
  new unit tests, all without a database: `souvenirs/payer.test.ts` 17, `souvenirs/tick.test.ts` 14 (fake pool and
  timers), `players/items.test.ts` 21, `players/item-routes.test.ts` 30 (Fastify inject over a fake pool),
  `packages/shared/src/souvenirs.test.ts` +15 (issue codes, paths and messages), `packages/shared/src/players/items.test.ts`
  27. About 4 mutants are left as equivalent (tick.ts `timer !== undefined` is always true and
  `Date.parse(null)` is NaN; souvenirs.ts `rankTo === null` and `visual === null` are covered by JS coercion). A hand
  check (a changed condition in tick.ts, payer.ts) failed the new tests; the sources are unchanged. Awaiting the
  coordinator's push and one GitHub mutation re-run on these six files.

- 2026-10-26 **T-403c built (standard).**
  App: achievements (shipped badges, tier rings, padlock silhouettes), the Event Passport on the profile, `/event-history`,
  `/questify-quests`, the public profile's tiers and ended public stamps, and `QuestifySyncProvider` (scheduler:
  focus, launch, foreground at 5 minutes, a trailing 15 s debounce after a completion, a silent 429; toasts and the
  level-up card). Dashboard: the event city picker. Console: `/console/questify`. Shared: the public profile's
  `achievements` and `passport` are required; theme gains three tier colours; `formatLocalDate`. 103 new strings
  in `messages.ts` (own `ux-araby` pass). Tests: app and web units (scheduler, notices, stamps, API client, console
  checks), the shared suites, `events.spec.ts` and `console-questify.spec.ts` (desktop and phone), `expo export`
  (android and ios). Proposed ADR-281 / Q-247. Needs a phone check. No CI minutes used.

- 2026-10-26 **T-403c done (standard), ticked; progress 79/155 (50.97%).** Standard code review GO 92 of
  9f4af20..fb699f6 by the in-house reviewer (Sonnet; the recorded Sol policy could not be used from the Claude Code
  session); no re-review. Folded in: `ConsoleQuestify` split (`RetireDialog`, under 100 lines); the sync scheduler treats
  a rejected call as done; the own-profile badge label carries the next-tier line; "Show more" is single-flight and
  deduplicates by `eventId` (`event-pages.ts`); the level-up card is modal for screen readers and hides the screen
  beneath; the new-string count is 103; Arabic polish on the console conflict, invalid-number, retire and city-hint
  lines (the quest-limit line now says retired quests are not counted, drafts are); migration 0065 seed names set in
  place (`العشرة الأوائل`, `يد واحدة`; undeployed, no test pins them). Publishing a campaign has no confirmation:
  Q-248. Phone checks still owed. No CI minutes used.

- 2026-10-26 **CI red on 569190d, fixed by the coordinator.** Run 40392290636: 6119 passed, 3 failed, all in
  `apps/api/src/players/item-routes.test.ts`. The mutation-chase tests built a fake public profile without
  `achievements`/`passport`, which T-403c made required in the shared schema, so the route's own parse answered 500.
  The T-403c worker ran `apps/api/test/players` but not `apps/api/src/players`. Fixture fixed (two fields); players unit
  suite 99 passed; one CI re-run. Lesson for worker briefs: after a shared-schema change, run the unit tests of every
  package that imports the schema (`npx vitest run apps/api/src/<area>`), not only the integration suites.

- 2026-10-26 **Second GitHub mutation result (run 40386286433 on 7a0faa8) and the chase for the files under 90 (tests
  only, no source change).** Scores: souvenirs files 96.9 to 98.7, `players/items.ts` 100; under 90: `questify/questify.ts`
  67.65 (17 survived, 5 no-cov), `questify/admin-routes.ts` 88.64 (3 + 2), shared `questify/quests.ts` 0.00 (47 no-cov),
  `questify/events.ts` 29.63 (19), `questify/achievements.ts` 27.27 (8), shared `players/items.ts` 23.64 (42) and
  `souvenirs.ts` 81.08 (21). New unit tests, none needing a database: `questify/questify.test.ts` 32 (fake pool: the
  `PI401` 401, rethrown faults, null/missing lists, event mapping, cursor paging and every cursor refusal),
  `questify/admin-routes.test.ts` 34 (Fastify inject: the PUT campaign write, the publish/retire arguments, a window
  ending when it starts, no staff on the request), `questify/routes.test.ts` 15 (the `no-store` headers),
  `packages/shared/src/questify/{achievements 13, events 20, quests 49}.test.ts` (accept/reject at every boundary,
  trimmed text, direction characters with message and path, offset-required instants, every enum value). 21 of the 22
  `questify.ts` mutants and all 5 `admin-routes.ts` and all shared `questify/*` mutants should now die; the one
  equivalent is `questify.ts:101` (an emptied `catch` still ends in the same 400, because `safeParse(undefined)` fails).
  Hand checks (10 broken lines, each failed the new tests, restored). The shared `items.ts` and `souvenirs.ts`
  survivors are **not test gaps**: 9 of 10 applied by hand (empty schemas, bounds, enum values, `refine` removed) fail
  the existing tests and the tenth, `souvenirs.ts:27` (`rankTo === null` replaced by `false`), is equivalent (`5 > null`
  is true in JS). Every survivor is import-time schema code while the in-function mutants of the same files were killed;
  the incremental cache (restored from run 40358820903) most likely kept their old result.
  If a forced run still leaves import-time schema mutants alive, the lever is `ignoreStatic` for those files, not tests.

- 2026-10-27 **Forced mutation run 40400940399 on 9345a17 (all 9 files retested): every file passes, no chase
  needed, no `ignoreStatic`.** API `questify/`: `admin-routes.ts` 100, `admin.ts` 100, `routes.ts` 100,
  `questify.ts` 98.53 (1 survivor, the known equivalent at line 101). Shared: `questify/{achievements,events,quests}.ts`
  100, `players/items.ts` 94.55 (3 survived), `souvenirs.ts` 98.20 (2 survived). This confirms that the earlier low shared
  scores came from incremental-report leftovers. The T-402 and T-403 mutation chase is closed.

- 2026-10-27 **ADR-283 built (answers Q-248).** The console's Questify campaign page asks for confirmation before Publish
  (`PublishDialog` in `ConsoleQuestify.tsx`, same `ConfirmDialog` as retire; new messages `console.questify.publishTitle`
  and `publishBody`, Arabic and English). Only the dialog's confirm button sends the publish call. Browser spec
  `console-questify.spec.ts` covers cancel (no call), confirm (one call) and the English text.

- 2026-10-27 **T-404 built (core, server; core code review pending).** Migration 0067 (undeployed; 0063 to 0066
  untouched) takes the plan's lock list up front (player, player_xp, level_reached, achievement_earned, questify_quest,
  questify_award, item, player_item, level_item, souvenir_rule; never platform_setting). Gems: `player_xp.gems` (CHECK ≥ 0),
  append-only `gem_entry` with four sources bound by composite keys, paid only by `questify_sync` once per level,
  tier and paying Questify award (retroactive; `gem_amounts()` falls back to 20/10/25/50, no setting row yet; seeded
  quests 25, quest gems frozen once it can pay). Shop: `gem_shop_item` (six titles 40–80, six "ring" frames 80–150 on
  `frame-15`…`frame-20`), `gem_purchase`, the locker's `shop` source, exclusive sources with level rewards and
  souvenirs; `gem_shop()`, `gem_buy()` (seen price, one copy, too few gems, replay by key with the current balance),
  `own_gems()`. API: `GET /v1/me/gem-shop`, `POST /v1/me/gem-shop/purchases` (UUID Idempotency-Key, 10 a minute), `gems`
  on `/v1/me`, the sync answer and the quests list; shared `questify/gems.ts`. STORE_COMPLIANCE 1.6 row and review note
  added. New suites `test/db/gems.int`, `gem-shop.int`, `gems-upgrade.int` (a scan in flight across the migration, the
  lock list checked against the SQL); security suites extended. Full suite: 400 files passed, 3 skipped; 6359 tests
  passed. Proposed ADR-290 / Q-255 (build choices), ADR-291 / Q-256 (two rare deploy-time lock clashes accepted).
  Mutation owed on GitHub (core files only). Progress 80/156 (51.28%).
  Core code review GO 93 (independent, no re-review); folded in: the STORE_COMPLIANCE demo-account line (played to
  level 3 before submission, T-806 note), T-022 added (migration retry on 40P01/55P03, before real players; ADR-291),
  the sync's missing-row fallback now throws, one shared `idempotency_key_invalid` error. ADR-290/291 Accepted,
  Q-255/256 answered. Progress 80/157 (50.96%).

- 2026-10-27 **T-404b built (gems on screen, standard).** App: `app/gem-shop.tsx` (balance; "Gems are earned by playing.
  They can't be bought." always; frame and title cards with the price in gems; "Get" / احصل عليه opening a confirmation
  sheet; `createPurchaser` sends the same key again only after a lost answer, a 5xx or a 409 `request_in_progress`,
  and takes a new key after every other answer, 409 and 429 included; a changed price keeps the sheet open and asks
  again; too few gems says how gems are earned; owned and retired refresh; "Equip now" through `PATCH /v1/me`); the gem
  count and the shop door on the Profile and the locker; the locker's "From the gem shop" line; "+N gems" on the
  Questify quests list and one "You earned N gems" toast per sync (a gems-only sync counts as written and reloads the
  profile); Arabic gem counts by helper (`gems.ts`: جوهرة واحدة, جوهرتان/جوهرتين, 3-10, 11+). Shared: `frame-15` to
  `frame-20` as an explicit table (colours outside the level palette, 3:1 on the page, tested), about 40 new strings.
  Console: the quest form's Gems field (0 to 1000, disabled once the quest can pay) and gems in the list row. Tests: new
  unit tests (api outcomes, key rule, flow steps, Arabic counts, toast, frames, console draft/body/`questCanPay`),
  `console-questify.spec` extended (seeded quest's fixed gems, bad gems named, new quest at 0, both languages, phone
  width). `npx expo export` (Android, Hermes bundle) passes; full browser suite after a fresh web build: 151 passed, 1
  skipped; full `npx vitest run`: 404 files passed, 3 skipped; 6431 tests passed, 4 skipped. Proposed ADR-292, ADR-293 /
  Q-257, Q-258. Phone check owed when a build exists (RTL, Reduce Motion, the sheet, VoiceOver/TalkBack labels, the six
  rings). No mutation (standard task). Progress 81/157 (51.59%).
- 2026-10-27 **Mutation chase for `players/profile.ts` (run 40418719633: 88.54%, 17 survived, 5 no coverage), tests only.** New
  `apps/api/src/players/profile.test.ts` (14 unit tests over `fakePool` and a fake settings service) kills the level
  threshold (null stays null), the gem balance (no row or null answers 401), the username-change rules (switch, tuned days,
  30-day fallback, settings that do not compose: off, 403 on rename), the `retry-after` arithmetic and the null
  `next_change_at` of a 429, and "no settings read for the rename when the username is not sent". Equivalent, left alone:
  line 244 (`?? { outcome, next_change_at }`: with no row the switch matches nothing either way), line 116 (the fallback
  equals `TUNING.usernameChangeDays.default`, 30), line 287 (`rules` is null exactly when `body.username` is undefined, so
  `&&`, `||` and either `true` behave the same). Expected score about 96%; confirmed by run 40422438219: **95.83%**
  (6 survived, 2 no coverage). T-404 mutation closed: questify `gems.ts` 95.00, `questify.ts` 98.70, `routes.ts` 100,
  players `items.ts` 100, shared `questify/gems.ts` 100, `questify/quests.ts` 100, `players/items.ts` 92.98.
- 2026-10-27 **T-405 plan written (core; awaiting the independent CTO plan review).** `docs/plans/2026-10-27-t-405-streaks.md`:
  split into T-405 (core: migration 0068, API, shared) and T-405b (standard: screens, dashboard Streak panel, strings;
  added to TASKS). Event streak: day rows per enrollment and open event day (organizer closed weekdays and dates neither
  count nor break; recorded on every multi-day event, on or off), a flat bonus from day 2 as ledger kind `streak`, paid
  by a `ledger_streak` trigger on the quest entry (after `apply_ledger_entry`, before `ledger_xp`) so every door pays
  it; an owner-only settings door. Daily streak: one 04:00 Riyadh day, written by the same trigger only while the
  platform key `dailyStreak` is on, length read not stored, XP milestones (3 to 365 days) once ever through
  `questify_sync` (`xp_entry` source `streak`); no gem or points source (FR-421). Lock list up front (enrollment
  EXCLUSIVE first; never `platform_setting` or `player`). STORE_COMPLIANCE gate: nothing sold, no loss copy or
  countdowns. Proposed ADR-294 to ADR-301 / Q-259 to Q-266. Progress 81/158 (51.27%; T-405b added). CTO plan review 86 (approve with revisions, no re-review): the day row stays append-only (bonus entry first, then a plain INSERT), approval-day and manual completions count (ADR-301), error class ST, UNIQUE completion_id, the day-boundary race, closed weekdays frozen once started, quest_id joins in the build check.

- 2026-10-27 **T-405 built (core, server; core code review pending).** Migration 0068 (undeployed; 0057 to 0067
  untouched) takes the plan's lock list up front (enrollment EXCLUSIVE, event and quest_completion SHARE ROW EXCLUSIVE,
  xp_entry and ledger_entry ACCESS EXCLUSIVE, player_xp SHARE ROW EXCLUSIVE; never platform_setting or player).
  Event streak: `event_streak` (owner-only `set_event_streak`, class `ST`, `RF409` for final results, audited
  `event.streak_set`; `event_streak_settings` for owners and editors), append-only `event_streak_day` (UNIQUE
  completion), ledger kind `streak` (shape CHECK, unique per completion, never boosted, no XP), written by the
  `ledger_streak` trigger (after `apply_ledger_entry`, before `ledger_xp`): the later-day probe, the length from the
  previous open day, the bonus entry first and then the day row by a plain INSERT (no UPDATE, no ON CONFLICT). Daily
  streak: `questify_day` (04:00 Riyadh), `questify_streak_day` (no FK), append-only milestones and rewards, `xp_entry`
  source `streak` paid once ever by `questify_sync` (pre-check `streak_due`), the platform key `dailyStreak`. Readers
  restated with `streak` (remove_award, the operator guard, community points goals, member_activity, member_ledger) and
  a quest's `earned` leaves it out (the `completion_id`/`quest_id` join list is in the plan's build notes). API
  `apps/api/src/streaks/` (`GET`/`PUT …/streak`), `streakBonus` on every answer that carries `firstBonus`, Home
  `streak`, `streakDays` in the history and the team record, `dailyStreak` on `/v1/me` and the sync, log
  `completion.streak_bonus {days}`; shared `streaks/`. New suites `test/db/event-streak.int` (50, the door table, ADR-301,
  the boundary race, crossed locks), `daily-streak.int` (14), `streaks-upgrade.int` (3), `test/streaks/routes.int` (5),
  unit and shared tests; security suites and the list guards extended. Burst timing by hand
  (`test/perf/streak-timing.int`): +12% to +24% at p95 (10 to 18 ms) over the 10% target, Proposed ADR-303 / Q-268 to
  accept; build choices ADR-302 / Q-267. Full suite (second run): 409 files passed, 4 skipped; 6562 tests passed, 5 skipped; 2 failed: one stale submissions unit fixture (fixed, re-run green) and the known first-N bonus Stop timing test under full-suite load (passes alone). Mutation owed on GitHub (core files only). Progress
  82/158 (51.90%).
  Core code review GO 93 (independent, no re-review); folded in: a non-object body or an unknown key with no listed field at
  fault is a plain 400 `invalid_request` (tested); `set_event_streak` takes the event FOR KEY SHARE before the
  final-results check, as `remove_award` does (0068 edited in place, undeployed; a DB test crosses a confirmation and fails
  without the lock); ADR-303's target became a burst budget of about 20 ms at p95 within NFR-002 (CTO rerun +17.7%, about
  13 ms; re-time with T-406, TASKS note); the T-405b note that a closed day reads `closedToday` first; the first-N bonus
  Stop test (`first-bonus.int`, CTO 4) is load-independent (4,000 players claimed back to back; Stop must return within a
  loose 15 s guard and the lanes keep claiming after it; a setter made to wait for the claims to pause fails it). ADR-294
  to ADR-303 Accepted, Q-259 to Q-268 answered.
- 2026-10-27 **T-405b built (standard, screens and dashboard; code review pending).** App `src/streaks/`: `daysLabel`
  (English one or many; Arabic one, two by role, 3 to 10, 11 and over singular), the card's states (a closed day is read
  first, then today played, then a live streak, then "Start a new streak today"), tolerant readers for Home's `streak`,
  a completion's `streakBonus` and `/v1/me`'s `dailyStreak`, and the lines, the success line and the sync toasts. Event
  Home gets a Day streak card (hidden while Home sends null); the scan celebration a streak beat after the first-N beat
  (`PopIn`, so Reduce Motion is respected), and quest-sheet, vote, survey, share, poll, game and quiz answers carry
  "Streak day N! +P" in their line; history reads "Streak bonus, day N"; the profile shows the daily streak beside the
  gems (hidden while null) and one toast per milestone paid. The flame is the redone `icon-flame` (upright, one connected
  shape; passed the full-size review) at 128 px. Dashboard: a Day streak panel on the event page (owner form with one
  Save and an Idempotency-Key, weekday chips, upcoming dates only with started ones fixed, a preview line, refusals worded
  by reason; editors read it and see "Only the owner can change this."; a single-day event explains why it has no
  streak). Tests: app units (`streaks/*.test`, plus the readers in `event`, `quests`, `plays`, `games`, `celebration`,
  `amount`, `player-state`, `sync-notices`), web `lib/streak.test`, `e2e/streak.spec` (desktop and phone, English and
  Arabic) and the organizers spec's note count (8 to 9), `npx expo export`. Proposed ADR-304, ADR-305 / Q-269, Q-270.
  Phone check owed (RTL, Reduce Motion, the streak beat, VoiceOver/TalkBack labels). No mutation (standard task).
  Progress 83/158 (52.53%).
- 2026-10-27 **T-023 done (standard, infrastructure).** The function limits of `docs/rules.md` now have a ratchet
  (Q-271): `scripts/function-limits.mjs` (`pnpm lint:limits`) runs oxlint with `.oxlintrc.limits.json` (only the
  ratchet reads it; tests, `apps/*/test` and e2e left out) and compares with `scripts/function-limits-baseline.json`
  (323 limit violations today). A new offender or a grown value fails; shrunk or gone ones are listed; `--update`
  only lowers the baseline. It is in `ci:changed`, so `ci:full` and the CI lint step run it; no workflow change. Unit
  tests in `scripts/function-limits.test.ts` (vitest now also includes `scripts/**/*.test.ts`). No mutation (standard
  task). Split offenders when their files are next touched.
- 2026-10-27 **Mutation chase: `completions/complete.ts` (run 40433111492, 89.93%, 22 survived and 7 uncovered).**
  Tests only: `apps/api/src/completions/complete.test.ts` (fake pool; the DB-backed `test/completions` suites do not
  count under Stryker). Kills the QP403 refusal, the release-failure log (event, fields, `unknown`), the missing-detail
  reason, no release for a QR scan, the item/level/boost/bonus row guards, `locationQuestsOn` and when the location
  switch is read. Hand-checked: 20 mutants applied one by one, each failed a test. Equivalent, left alone: line 431 (`code`
  undefined), 435 hint default (`parseInt` of any non-number is NaN), 474 `kind` guard, the three `kind: "ready"`
  strings (only `"refused"` is read), 539 `? false` (position already null). Expected score about 100% of the killable
  mutants (all but 7 equivalents); the next `mutation.yml` run confirms.
- 2026-10-27 **T-406 plan written (core; awaiting the independent CTO plan review).** `docs/plans/2026-10-27-t-406-daily.md`:
  split into T-406 (core: migration 0069, API, shared), T-406b (standard: app screens) and T-406c (standard: console
  pages), both added to TASKS. Periods on the Questify day, weekly Sunday to Saturday, a cadence per kind from the next
  day (weekly at launch); a two-language question bank, three questions a period, one five-letter word per language,
  all used once and frozen once started; XP only (challenge 20 + 10 per right answer, word 50 when solved) as
  `xp_entry` source `daily`, paid by the finishing door after the daily streak row and before `player_xp` (T-405's
  order); no points or gems; hidden answers and words never in a read before the caller finished; a sponsor is a
  disclosed name on a period's challenge (no logo, link, tracking or data; no prizes). Lock list: `xp_entry` then
  `player_xp`, nothing else. Proposed ADR-306 to ADR-312 / Q-272 to Q-278; for Dhia: Q-279 (sponsor terms), Q-280
  (disclosure wording, counsel), Q-281 (word list licences). Progress 84/161 (52.17%; T-406b, T-406c added). CTO plan
  review 84 (approve with revisions; short re-review pending): explicit FOR UPDATE on content and the clock after the lock,
  `questionId` in the answer (`changed`), the cadence door locks today's row and drops a same-cadence pending row, XP
  field ranges that fit the 1000 CHECK, the FK to `player` kept, a 33-letter shared Arabic set and a display form.

## Next

1. **T-406 independent core plan review** (strongest model), then the T-406 core build (re-time the entrance burst,
   ADR-303), T-406b and T-406c. Still open: the GitHub mutation run on T-405's core files. Still open from T-404: the GitHub mutation run on T-404's core files. Waiting for Dhia: his OK on the `stryker.config.json` globs, Q-247 items 2 and 3, Q-249 to Q-258, Q-279 to Q-281. No deployment/EAS/
   local Stryker; phone/CranL obligations remain deferred (T-403c's phone check included). Follow-up: Q-237 central
   replay-before-scope fix for other idempotent organizer routes.
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

