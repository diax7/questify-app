# Stage 5 — Pressure-test log

> Standard intensity (6 to 8 questions), 2026-10-17. One question at a time, each with Claude's own
> answer. Every finding lands in a document. A finding that reverses a decision is confirmed with the
> user first.

| # | Question | Claude's read | User's answer | Landed in |
|---|---|---|---|---|
| 1 | The plan has 511 requirements and about 300 features and ships all of it in v1 (ADR-069); how do we protect the launch? | Agree a cut order and a review point now | **Keep "all of it in v1" with no review point.** The first public release waits until everything except video is done | Risk recorded in `SCOPE.md` and `OPEN_QUESTIONS.md` (Q-077); ADR-069 stands |
| 2 | What does a player do when the SMS login code does not arrive at a crowded venue? | Offer an email code after 30 seconds, and an organizer default | **Agreed** | F-314, F-315, FR-1812, FR-1813 |
| 3 | Which one reason makes the organizers you know choose Questify? | Sponsor value plus prizes everyone can win | **"All of it."** No single lead reason chosen | Risk in `BUSINESS_MODEL.md` and `GO_TO_MARKET.md`; Claude's lead remains the suggestion |
| 4 | Now that a company exists, do we move the store accounts to it (ADR-010 said to revisit)? | Move to the company's accounts before the first submission | **Stay personal, as ADR-010 says** | ADR-010 stands; consequences and Q-078 recorded |
| 5 | Is "under 60 seconds to the first coin" realistic from the first scan, with install and sign-in? | No. Define it from first app open (90 s) and measure install separately | **Under 3 minutes from the first scan, install included** | ADR-098; `METRICS.md`, `GO_TO_MARKET.md`, `BUSINESS_MODEL.md`, `FEATURES.md`/`ux/PLAYER.md` updated |
| 6 | Will players open Questify on days with no event, justifying daily content from launch? | Weekly at launch, daily once players show up | **Agreed** | F-316, FR-1814, ADR-099 |
| 7 | Who pays for login SMS at a 20,000-player event? | An allowance per size tier, email after it runs out | **Questify absorbs it, watched in the usage view** | ADR-099 (risk); Q-034 |
| 8 | What happens at the prize desk to a player with an open flag? | Hold their items until a person clears the flag | **Agreed** | F-317, FR-1815, ADR-100 |

## Result

Eight questions asked. Five changed the plan (email fallback, the first-coin target, the content
cadence, the flag hold, the Q-078 legal question). Three were declined by the user with the risk
recorded: no review point for the size of the plan (finding 1), no single lead reason for the
pitch (finding 3), and Questify absorbing SMS cost (finding 7). The store accounts stay personal
(finding 4).

Remaining open risks, in order of weight: the size of the plan against one developer and Claude
(Q-077); the install-and-sign-in path at a crowded venue (the 3-minute target); the unknown SMS
price (Q-034); and the unresolved wedge.

