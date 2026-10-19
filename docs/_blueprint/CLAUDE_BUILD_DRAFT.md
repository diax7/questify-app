# Proposed update to the root CLAUDE.md — build phase

> **Draft only. Not applied.** The root `CLAUDE.md` still says PLANNING with no application code. Per
> STATE.md and the project rules, planning ends only when the user approves. When they do, apply this
> diff to `CLAUDE.md`: keep every existing line except the ones marked removed, and add the ones marked
> added. Written in Stage 7, 2026-10-17.

## Change 1 — the phase section

Removed:

```
## Current phase: PLANNING — no application code

- Do not scaffold projects, install packages, or write application code. Planning ends only when
  `docs/_blueprint/STATE.md` says so **and** the user approves.
- The work in this phase is editing docs. Every idea the user shares lands in a doc in the same
  session.
```

Added:

```
## Current phase: BUILD

- The plan is approved (see `docs/_blueprint/STATE.md`). Build in the order of `docs/TASKS.md`; pick up
  the next unchecked task. Never build what `docs/SCOPE.md` excludes.
- Docs stay alive: any idea, change or discovery lands in a doc in the same session. Disagreement
  between code and docs goes to `docs/OPEN_QUESTIONS.md`, never a silent override.
```

## Change 2 — add after "Product principles"

```
## Hard rules (docs/rules.md has the detail)

1. Authorize on the server for every action; the client is untrusted.
2. Deny by default: every table, function and storage area is closed to the public in the change that
   creates it, with an outsider test.
3. Personal data stays in Saudi Arabia and out of logs, errors and push text.
4. Every user-facing string exists in Arabic and English; check right-to-left; Western digits.
5. Every outside call has a timeout, a safe retry and a fallback.
6. The points record and audit logs are append-only; unsafe actions take an idempotency key.
7. Configuration is data and never downloads a feature; STORE_COMPLIANCE.md is a gate.
8. docs/ is the source of truth; new dependencies need a reason.

## Quality bar

Max on the core (points and XP ledger, sign-in, tenant isolation, prize handover, wallet signing,
signed QR/NFC proofs, admin powers). Standard everywhere else. See docs/rules.md.

## Tech stack (summary; reasons in docs/TECH_STACK.md)

- Player app: Expo (React Native) + TypeScript, development builds, EAS Build/Submit.
- Server: Node 22 + Fastify, one modular monolith; PostgreSQL (Saudi region) with shared schema and
  row-level security; Redis-compatible ranking cache; pg-boss jobs.
- Web: one Next.js app (event page, station, big screen, dashboard, console).
- Cloud: open (Q-031). SMS: Msegat or Taqnyat (ADR-103).

## Architecture (summary; detail in docs/ARCHITECTURE.md)

Clients call an internal REST API (`/v1`). Every quest scan is one database transaction that writes the
completion, the append-only ledger entry and the score. Rankings live in the cache and are rebuilt from
the ledger. Workers send SMS, email and push. Configuration is composed server-side and cached on the
phone with a last-working copy.

## Read order for builder agents (replaces "Read order at the start of every session")

1. docs/_blueprint/STATE.md
2. docs/PROJECT_BRIEF.md
3. docs/SCOPE.md
4. docs/SRS.md and docs/FEATURES.md
5. docs/UX_FLOWS.md (and ux/)
6. docs/ARCHITECTURE.md and docs/DATA_MODEL.md (and API.md, SECURITY.md, CONFIGURABILITY.md)
7. docs/rules.md
8. docs/TASKS.md
```

## Kept unchanged

"How the docs are kept", "Product principles" (including the Arabic and brand-deck rules) and
"Tooling for this project".
