# T-615 - Name display (plan note, tier B with a privacy review)

Delivers FR-1842 (F-344). Decisions: ADR-400 and Q-367 (Proposed). Migration 0109.

## What it builds

An event shows its players by username, full name or both, to its staff only or to every player. The full name is the answer to
the event's Full name join field. The join card tells each player who will see it, and the database keeps that with the enrollment.

## Rules that must hold (checked in the database, not the UI)

1. A full name reaches another player only when the event's audience is `everyone`, the display is not `username`, the enrollment is
   active, the player's recorded notice is `everyone`, and they gave a name (`public_full_name`). Everything else shows the username.
2. The notice is recorded with the join, in its transaction, from what the card showed. A notice that is not the event's now rolls the
   join back and sends the card as it must read.
3. Widening to `everyone` is refused while an active or pending player (not a rehearsal account or an operator) who was not told is in.
   Narrowing is always allowed. A full name needs the Full name field.
4. Staff reads (an operator's scan result, the prize desk) follow the setting alone, behind the same seat checks they had.
5. The full name is never in a push, a log line, an error, analytics or an export beyond the join answer the team already receives.
   A source test lists the API files that may name it.

## Where it shows

Event ranking and today's (`ranking_names`, asked only when the event shows names), revealed results (`event_results`), the big screen's
ranking and finale, the station's result, the prize desk. Not: Questify-wide ranking and profiles, Meet, Cheers, the recap, push.

## Order of work

Migration and DB tests; join recording and card; ranking, results, scenes and staff reads; the dashboard section and preview; the app's
card, rows and staff screens; docs. Outsider and cross-tenant tests with the migration.

## Left out on purpose

Asking earlier players again (a prompt and a state); the session check-in result; names in Meet and Cheers; a bulk "re-notify".
