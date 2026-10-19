# Roadmap — Questify

> Phased build in dependency order. Drafted in Stage 8, 2026-10-17. No dates (Q-077: the first event is
> not scheduled). Phases are **build order, not releases**: the first public release waits until
> everything except video is done (ADR-069). Task detail: `TASKS.md`.

## Phase 0 — Foundations
- **Delivers:** monorepo and CI, the Saudi staging environment, tenant-safe database with row-level
  security and the outsider suite, audit log, API conventions, staff sign-in, configuration and
  translation services, the Expo shell in Arabic and English, the first cloud builds, the web shell
  (T-001 to T-015).
- **Depends on:** nothing, except three early checks: the cloud and its services (T-014, Q-031), the SMS quotes and sender registration (T-013, Q-034), and the Expo SDK against store rules (T-015, Q-046).

## Phase 1 — Core loop
- **Delivers:** an organizer builds an event; a player signs in with a code, joins, scans a quest QR,
  earns points, sees the 11-row ranking and a celebration. Includes the event web page and join links
  (T-101 to T-119).
- **Depends on:** Phase 0. **This phase alone is a usable thin product**: a real phone runs the whole
  loop (T-118), which proves the riskiest assumption's mechanics early (Q: install and first-coin path).

## Phase 2 — Rewards and fair play
- **Delivers:** the shop and reservations, digital codes, operators and My QR, the prize desk, manual
  awards, bans, flags and the flag hold, activation and limits, rehearsal mode, join fields and guest
  lists, rank prizes, today's ranking (T-201 to T-218), including account deletion and access types.
- **Depends on:** Phase 1 (the completion engine and ranking).
- **Milestone:** ship the build to 12+ testers and **start Google's 14-day closed test** (T-215) so the
  clock runs while later phases are built.

## Phase 3 — Quest depth
- **Delivers:** submissions and review, votes and quizzes, challenge/meet/survey/share/location
  quests, passport and category rules, mini-games, polls and community quests, flash quests, boosts and
  the finale, NFC, kiosks and stations, the help desk (T-301 to T-313).
- **Depends on:** Phase 2 for operators and stations.

## Phase 4 — The Questify layer
- **Delivers:** XP and levels, the profile with items, achievements and passport, gems and shop,
  streaks, the daily challenge and word, consent and interests, Questify home and Explore, invitations,
  the after-event window (T-401 to T-410).
- **Depends on:** Phase 1 (completions) and Phase 3 (quest types for Questify quests).

## Phase 5 — Live and messaging
- **Delivers:** push and the notification center, announcements, the big screen, sessions with
  registration, maps, sponsors, quest ratings and survey results (T-501 to T-510).
- **Depends on:** Phases 2 and 3.

## Phase 6 — Organizer power
- **Delivers:** templates and duplicate, feature switches and preview, branding, the live control room,
  confirmation screens and live-edit choices, the setup wizard, layout, analytics, exports and the PDF
  report (T-601 to T-618).
- **Depends on:** Phases 3 to 5.

## Phase 7 — Console and trust
- **Delivers:** the Questify console: organizer tools, translation matrix, switches, tuning, maintenance
  and banner, player tools, safety tools, templates, legal documents, data requests, health view, the
  review demo tenant (T-701 to T-714).
- **Depends on:** Phases 1 to 6 for what it administers.

## Phase 8 — Launch readiness
- **Delivers:** wallet passes, the onboarding intro, the web build of the player app, the load test, the
  restore rehearsal, the store submission, the counsel batch and the final Arabic copy pass (T-801 to
  T-808).
- **Depends on:** all earlier phases. Release gates: the load test (NFR-003), the restore rehearsal
  (NFR-026), both stores' acceptance, the closed test finished, counsel answers in or recorded.

## Why this order

1. The riskiest unknown is whether the loop works on real phones at a real venue, so Phase 1 is a thin
   slice, not a foundation-only phase.
2. Musts come before Shoulds before Coulds (SCOPE.md) within each phase's area; the Could items sit at
   the end of their phases (for example the photo wall, location check-in, the player web build).
3. The Google closed test needs 14 days and 12 testers, so it starts after Phase 2, not at the end.
4. Wallet passes need the operator and desk flows (Phase 2) and a signing setup, so they come late.
5. If time runs out, the cut starts from the bottom of this order; the user decides (Q-077).
