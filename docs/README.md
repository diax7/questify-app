# Questify Docs — Map

All planning lives here. **`SRS.md` is the master spec.** It is built during planning and
consolidated at the end. The other docs hold the detail it points to.

## Working files (used every session)

| File | Holds |
|---|---|
| `_blueprint/STATE.md` | Where planning stands; what's next |
| `INBOX.md` | Raw ideas, dated, before they are sorted into the docs below |
| `OPEN_QUESTIONS.md` | Every unknown, with why it matters and when we resolve it |
| `DECISIONS.md` | Every big decision and its reason (ADR log) |
| `_blueprint/STAGE1_REVIEW.md` | The Stage 1 review: every finding and its outcome |
| `_blueprint/STAGE5_GRILL.md` | The Stage 5 pressure-test: 8 questions and where each landed |
| `_blueprint/STAGE6_GRILL.md` | The Stage 6 technical grill: 3 questions and where each landed |
| `inputs/` | Earlier documents from the user, kept as received (BRD v2, April 2026). Superseded where they conflict with the docs here |

## Product

| File | Holds | Status |
|---|---|---|
| `PROJECT_BRIEF.md` | What we're building, for whom, and why | Draft |
| `FEATURES.md` | Every feature, grouped and prioritized | Prioritized: all 14 areas done (2026-10-16) |
| `SCOPE.md` | What's in v1, what's later, what's never | v1 = everything except video (2026-10-16) |
| `SRS.md` | Numbered requirements (FR/NFR) with acceptance criteria. The master spec | v1 draft 2026-10-17, revised after the Stage 1 review: 546 FRs, 31 NFRs; consolidated in Stage 9 |
| `USER_STORIES.md` (not created; optional) | Features from each user's side, if needed beyond the SRS | Optional |

## Business

| File | Holds | Status |
|---|---|---|
| `research/COMPETITORS.md` | Event and gamification apps worldwide and in MENA | Done 2026-10-16 |
| `research/GAMIFICATION_PATTERNS.md` | Mechanics that work, anti-cheat, ethics | Done 2026-10-16 |
| `BUSINESS_MODEL.md` · `PRICING.md` · `METRICS.md` · `GO_TO_MARKET.md` | Who pays, for what, how we know it works, how the first organizers arrive | Draft 2026-10-17 (Stage 3) |

## Design & UX

| File | Holds | Status |
|---|---|---|
| `design/REFERENCES.md` + `design/references/` | The user's visual references and what to take from each | Brand deck added (R-01) |
| `design/assets/` + `ASSET_INDEX.md` | **The approved image library**: one reviewed file per asset, with a dictionary of what each shows. `promote_assets.py` adds new ones; `build_index.py` rebuilds the dictionary | 134 approved (2026-10-16) |
| `design/codex-image-2/` | Codex's brief (with the hard rules from review), the asset list (Phases 1–5) and reference crops. `out/` is Codex's inbox; `REVIEW.md` is the review log | Phases 3–5 queued: 157 assets |
| Design System page (https://claude.ai/artifact/H4ozsGZUWnR3joDZBnUWSb) | Tokens, components with live previews, brand book | In progress; resumes after the next asset batch |
| `UX_FLOWS.md` + `ux/` | Index; screens, wireframes and states for players, operators, the dashboard and console. Theme-agnostic | Draft 2026-10-17 (Stage 4) |
| `research/WALLET_PASSES.md` | What Apple Wallet and Google Wallet passes can and cannot do for Questify | Researched 2026-10-17 |
| `design/DESIGN_SYSTEM.md` (not yet created; visual system deferred) | Color, type, 3D icon style, motion, components, white-label tokens | Stage 4 |

## Technical

| File | Holds | Status |
|---|---|---|
| `TECH_STACK.md` · `ARCHITECTURE.md` · `DATA_MODEL.md` · `API.md` · `INTEGRATIONS.md` | Stack with reasons; how pieces fit; data; contracts; SMS/email/push providers | Done 2026-10-17 (Stage 6); ADR-101 to ADR-103 |
| `CONFIGURABILITY.md` | What can change from the dashboard without a store release, and how | Drafted 2026-10-17 |
| `SECURITY.md` | What we protect, from whom; outsider tests | Drafted 2026-10-17 |

## Compliance & delivery

| File | Holds | Status |
|---|---|---|
| `STORE_COMPLIANCE.md` | Apple, Google Play and Saudi (PDPL, SMS) rules, as a pre-submission checklist, plus the product decisions they force (PD-01–30) | Done 2026-10-16; all PDs decided 2026-10-17 (ADR-070 to ADR-073) |
| `legal/` + `legal/README.md` | Player terms of use, privacy policy and community guidelines (Arabic first, English alongside), placeholders and the counsel question list. Prize rules and organizer terms come later | v0.1 drafts 2026-10-20 (T-119); counsel review T-807 |
| `ROADMAP.md` · `TASKS.md` · `TEST_STRATEGY.md` · `RISKS.md` | Build order (9 phases), 132 tasks covering all 546 requirements, testing, 18 risks | Drafted 2026-10-17 (Stage 8) |
| `RUNBOOK.md` | How to run the checks, create staff accounts, free a locked-out person, and what to do when sign-in email is down | Started 2026-10-19 (T-006) |
| `QUALITY_BASELINE.md` | The standards every phase and release is checked against (OWASP ASVS/MASVS, tests, infrastructure, operations) | Written 2026-10-19 (ADR-108) |
| `rules.md` | Hard rules, quality bar, coding standards, Definition of Done | Drafted 2026-10-17 (Stage 7) |
| `_blueprint/CLAUDE_BUILD_DRAFT.md` | The proposed build-phase changes to the root `CLAUDE.md`; applied when planning is approved | Draft, not applied |

Files marked with a stage are created when that stage runs, not before. No empty placeholders.
