# Pricing — Questify

> Draft 2026-10-17 (Stage 3). **Prices and invoices live outside the platform** (ADR-076). This
> document records the structure, the boundary, and the comparables. It contains no Questify price
> yet: the user sets prices separately.

## Model

**Per event, by player-size tier, plus add-ons** (ADR-022). Attendees are always free.
An event is activated by Questify with a hard, soft or no player limit and the add-ons the event
bought (ADR-076).

## Tiers

| Tier | Players | Price |
|---|---|---|
| 1 | up to 300 | set outside the platform |
| 2 | up to 1,000 | set outside the platform |
| 3 | up to 5,000 | set outside the platform |
| 4 | up to 20,000 | set outside the platform |
| 5 | custom (festival scale, 50,000+) | quoted per deal |

## Free vs paid boundary

- **Free:** attendees; organizer sign-up; building and previewing events in Draft (ADR-068).
- **Paid:** activating an event so players can join (rehearsal with the organizer's own team
  stays possible before activation, ADR-080).
- **Add-ons that can be unlocked separately:** any feature in the per-event switch list
  (`FEATURES.md`). The user chooses which become paid add-ons; the platform supports gating any
  of them.
- Services outside the platform (devices, screens, gifts, staff) are separate and not covered here.

## Path to paid

1. Organizer signs up and builds a Draft event for free.
2. They rehearse with their own team on real phones.
3. They ask for activation; price and payment are agreed outside the platform.
4. Questify activates the event with the agreed size and add-ons.

## Comparables

| Product | Model | Price points | Basis |
|---|---|---|---|
| Goosechase | Per event, by players | $99 (10 players), $299 (40), $499 (100), $749 (175) | `[researched: COMPETITORS.md, 2026-10-16]` |
| Eventfiy (Riyadh) | Per event | $499 Starter, $999 Pro; white-label only on Enterprise | `[researched: COMPETITORS.md]` |
| EventMobi | Per event or yearly | From $3,000 per event, or $8,900 a year unlimited | `[researched: COMPETITORS.md]` |
| Whova | Quote | About $2,299 for up to 500 attendees (2024 public contract) | `[researched: COMPETITORS.md]` |
| Actionbound | Per player count | €350 for 50 up to €2,250 for 2,500 | `[researched: COMPETITORS.md]` |
| Swapcard | Yearly | From $610 a year, annual only | `[researched: COMPETITORS.md]` |

## Reasoning

- The nearest Saudi competitor charges $499–$999 per event; Goosechase tops out at $749 for 175
  players; mid-market full platforms start around $2,300–$3,000. The space between is open
  `[researched: COMPETITORS.md gap 6]`.
- Per-event pricing by player count matches how organizers budget and how the competitors charge.
- A suitable first range sits between Eventfiy and the full platforms, justified by the rewards
  store, Arabic-first design and verification that others lack `[belief]`.
- A yearly plan for repeat buyers is not in v1 (ADR-022); revisit when agencies ask for it.
