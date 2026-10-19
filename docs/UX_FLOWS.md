# UX Flows — Questify

> The user experience at planning level, theme-agnostic: flows, screens, wireframes and states.
> **No visual styling.** The adventure theme may be replaced completely (user, 2026-10-17); nothing
> here depends on it. Draft 2026-10-17 (Stage 4).

| Part | File | Covers |
|---|---|---|
| Player app | [ux/PLAYER.md](ux/PLAYER.md) | Joining, Home, Quests, Scanner, Ranking, Rewards, Profile, Questify home; 23 screens with states |
| Operator mode | [ux/OPERATOR_MODE.md](ux/OPERATOR_MODE.md) | Becoming an operator, station mode, prize desk, inbox, tools |
| Dashboard and console | [ux/DASHBOARD_AND_CONSOLE.md](ux/DASHBOARD_AND_CONSOLE.md) | Organizer dashboard (phone-first), live control room, Questify console, confirmation pattern |
| Guided setup | [ux/ONBOARDING_WIZARD.md](ux/ONBOARDING_WIZARD.md) | The organizer's step-by-step setup wizard, with explained options and skipping |

## Layout choices made by the user (player app)

Event Home: one stack with "Up next" first. Quests: accordion of categories. Quest details: bottom
sheet. Ranking: card on Home, full screen on tap. Center button: camera with a Scan | My QR toggle.
Rewards: balance on top, grid. Profile: identity on top, rows below. Joining: join card first,
sign-in at the first reward.

## Rules for every screen

- One primary action per screen.
- Five states defined: loading, empty, error, success, populated. Empty and error are written out.
- Online-only: every error says why and offers a retry (ADR-029).
- Arabic first, right-to-left; Western digits (ADR-018, PD-25).
- Renameable words are written as {player}, {operator}, {quest}, {category} (ADR-058).

## Hand-off

Visual design is a separate, later step and is not decided (the current adventure theme may be
replaced). Brand deck and assets: `design/`. This plan only requires that the design system
supplies the components named at the end of `ux/PLAYER.md`.
