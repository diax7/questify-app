# Stage 6 — Technical grill log

> Three questions, 2026-10-17, one at a time, each with Claude's recommended answer.

| # | Question | Claude's read | User's answer | Landed in |
|---|---|---|---|---|
| 1 | If one PostgreSQL primary is too slow at peak, what is the plan? | Load-test before launch, scale up first | **Agreed** | `ARCHITECTURE.md` grill findings; NFR-003 launch gate |
| 2 | After a restore to 5 minutes earlier, what happens to players confirmed in those minutes? | Accept the loss and tell players | **Agreed** | `ARCHITECTURE.md`; ADR-082 stands |
| 3 | If the SMS gateway fails at the start of a big event, what is the plan? | Use Msegat and Taqnyat with automatic failover | **Declined:** one gateway, email as the only fallback | `INTEGRATIONS.md` SMS; ADR-103 risk |

## Result

Three questions. Two confirmed the proposal. One changed the plan against Claude's advice: no
automatic second SMS gateway. The risk is recorded in ADR-103 and `INTEGRATIONS.md`.
