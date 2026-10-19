# Project Brief — Questify

> Draft v0.1 (2026-10-16), from planning session 1. Refined as planning continues.

## One line

**"Turn Every Event Into an Adventure."** Questify turns any event into a game. Attendees complete quests, earn points, climb the
leaderboard and win real prizes. Organizers set it all up from one dashboard, with no code.

## The problem

Events (conferences, exhibitions, festivals, campus days, corporate activities) struggle to keep
attendees engaged. Sponsors and booths struggle to get visits. Organizers can't easily measure
what people actually did. Engagement tools exist, but they are either a small add-on buried in a
heavy event platform or a single-purpose game (a quiz, a scavenger hunt).

## The product

- **Attendee app (iOS + Android, one codebase):** join an event and see its quests. Earn points by:
  - scanning a QR code
  - completing a challenge
  - submitting something
  - voting
  - answering a question

  Watch your progress and rank. Redeem points in the event's store for real prizes.
- **Admin dashboard (organizers):** create events, quests, prizes and the leaderboard; choose the
  event's currency (points, coins, or a custom name; XP belongs to the Questify layer); turn features on or off; brand the event.
- **Platform admin (Questify):** manage organizers, defaults and features across the platform.

It works as an add-on to a physical event, and also for fully virtual events and workplace
activities.

## Who it's for

| User | Wants |
|---|---|
| Attendee / player | A fun reason to explore the event, visible progress, a prize worth chasing |
| Organizer / event planner | Higher engagement, sponsor value, data on what attendees did, zero dev work |
| Event staff (operators) | Fast verification: scan, approve submissions, add points, hand out prizes. No access to settings (ADR-037) |
| Sponsors / exhibitors | Booth visits and visibility. In v1 they are profiles the organizer manages, with no login and no player data (ADR-067) |
| Companies (HR / culture teams) | Team activities and internal events made interactive |

**Customer segments** (from the brand deck; not final):
1. Event organizers and festivals
2. Government and tourism authorities: city-wide exploration quests
3. Theme parks, malls and destinations
4. Corporates: onboarding and team building
5. Schools and universities: orientation
6. Brands and sponsors: sponsored quests
7. Exhibitions and conferences (B2B): booth traffic, lead generation
8. Hospitality and travel: guest engagement

**Services beyond the app** (deck; priced outside the platform, ADR-022, ADR-076):
- on-ground help booths, either an open booth or a full-service staffed booth;
- uniformed staff.

## Goals

1. **Pass App Store and Google Play review on the first submission.**
2. **Change without releasing.** Feature switches, content, currency, rewards, branding and copy are
   controlled from the dashboard. Store releases are for new capabilities only.
3. **White-label ready.** Each organizer's event can carry its own brand.
4. **Craft that stands out.** The brand deck's adventure-game style (ADR-013): wood, parchment and
   gold, 3D icons, rich animation, progress you can feel.
5. **Built to extend.** New quest types and new ways to interact plug in without rewiring the app.

## Constraints

- First app the founder is launching on both stores.
- Development on Windows with Claude Code. A Mac is available for testing and submission only.
- One codebase for iOS and Android, with a near-native feel.
- No payments in v1. SMS and email messaging are in.
- Primary market is Saudi Arabia (Arabic + English, RTL), usable worldwide.

## Success

Defined in Stage 3 (`METRICS.md`). Open items are in `OPEN_QUESTIONS.md`.
