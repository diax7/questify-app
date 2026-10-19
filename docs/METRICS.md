# Success Metrics — Questify

> The numbers that define winning. Draft 2026-10-17 (Stage 3). Targets are `[belief]` until the
> first events give real data; benchmarks come from `research/`.

## North-star metric

**Activated players per event:** the share of players who joined an event and completed at least
one quest (FR-1625: active = at least one completed quest).
- **Baseline:** EventMobi customer case, about 20% played `[researched: GAMIFICATION_PATTERNS §4]`.
  A well-run overlay reached 72% activation `[researched: same]`.
- **Target (first events):** 40% or more `[belief]`. Revisit after three events.
- **Why this one:** it shows the game delivers value for players, which is what organizers pay for
  and renew on. Sign-ups or installs alone would hide a dead event.

## Funnel

| Stage | Metric | Target | How measured |
|---|---|---|---|
| Acquisition | Players who open the event page or scan the join code, per event | Tracked, no target yet | Event page and join-source analytics (F-65) |
| Activation | Joined players who complete a first quest; median time from the first scan to the first coin, install included, with install time also reported separately | 40%; under 3 minutes `[belief]` | Participation analytics (FR-1625); timestamps in the points record |
| Retention | Players who return on another day of the event; players who join a second event | Tracked | Event streak data; the Questify profile (F-127) |
| Revenue | Paid events per month; share of organizers who rebook | 3 paid events before building more (see validation) | Questify console, activation queue (F-257) |
| Referral | Organizers who come through another organizer or agency | Tracked | Asked at sign-up |

Revenue figures are kept outside the platform (ADR-076); the console counts events, not money.

## Validation targets

These test the riskiest assumption in BUSINESS_MODEL.md (players will install to play):
1. At the first three events, activation of 40% or more `[belief]`.
2. Median first-scan-to-first-coin under 3 minutes, install included, on the join-by-scan path; the install part reported separately because the venue's network decides it.
3. At least one organizer rebooks or recommends Questify after their event.
4. If activation is under 20% at two events in a row, stop and fix the join flow before adding
   features.

## Ties back to

`PROJECT_BRIEF.md` goals: pass store review first time, change without releasing, and craft that
stands out. The north-star measures the third: players choose to play.
