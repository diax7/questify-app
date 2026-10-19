# Business Model — Questify

> How the product creates and captures value, in prose. Draft 2026-10-17 (Stage 3).
> Claims marked `[researched: …]` come from `research/COMPETITORS.md`; `[belief]` means untested.

## Value proposition

Questify turns any event into a game that attendees want to play: quests, a points economy with a
real rewards shop, live rankings, and a lifetime profile that follows players from event to
event. For the organizer it replaces "top 10 win a prize" with a game every attendee can win at,
in Arabic first, with no hardware and no developer. `[researched: COMPETITORS.md gaps 1–4]`

## Customer segments

| Role | Who | What they want |
|---|---|---|
| **Payer (first)** | Event organizers and event agencies | Engagement, sponsor value, proof of what happened |
| Payer (later) | Corporate HR and culture teams; schools; government and tourism | Seasons, onboarding, city-wide quests |
| User | Attendees (13+) | A fun reason to explore, visible progress, real prizes |
| Influencer | Sponsors and exhibitors | Booth visits and visibility. No login or data in v1 (ADR-067) |

Payer and user differ, so both must be won: organizers buy only if players actually play.

## Value loop

More events → more players with a lifetime profile (ADR-044) → a player base that organizers
want to reach (Questify-run invitations, ADR-047) → more organizers choose Questify → more
events. `[belief]` The loop starts to matter only after several events have run.

## Revenue streams

1. **Per-event fee by player-size tier** (ADR-022): up to 300 / 1,000 / 5,000 / 20,000 / custom.
2. **Add-ons unlocked per event** (ADR-076), such as the big screen, NFC, kiosks, souvenirs,
   sponsors, branding and invitations. Which ones and at what price: PRICING.md.
3. **Anything provided outside the platform** (devices, screens, gifts, staff) is dealt with and
   paid for separately. It is not a platform feature and is outside these documents (user,
   2026-10-17).

Pricing, invoicing and payment all happen outside the platform (ADR-076).

## Cost drivers

- Managed PostgreSQL and hosting in a live Saudi region (ADR-070, ADR-086).
- SMS: login codes and promotional messages; the usage view tracks it (ADR-076).
- Email and push providers; storage for photos.
- The Questify team's time: three or more people covering activations, the WhatsApp hotline,
  reports (1 h live) and daily questions (ADR-079).
- Store accounts and legal/compliance work (a lawyer review, SDAIA).

## Key partners and resources

- Saudi cloud provider; a CST-registered SMS provider (Q-034).
- Event agencies as resellers (GO_TO_MARKET.md).
- The company that sells Questify (an existing company of the user, ADR-076).
- App Store and Google Play review.

## Unsettled: the one sharp reason

The wedge has not been narrowed to one reason (Stage 5). The candidates are sponsor value, prizes
everyone can win, a premium Arabic-first experience, and attendee data. Until the first three
organizers are asked, this stays a belief.

## Riskiest assumption

**Players will install a new app to play an event's game.** If installing is too much friction at
an event, activation stays low and organizers do not rebook.
- **Test:** activation rate and install-to-first-quest time at the first events (METRICS.md).
- **Mitigations already decided:** one-scan join through the store (F-71), a web event page
  (F-72), the 3-minute target to first coin (install included), browse-before-sign-in (ADR-031).
- **Open technical risk:** the iPhone half of the one-scan join (Q-070).
