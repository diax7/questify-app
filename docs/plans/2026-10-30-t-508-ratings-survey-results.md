# T-508: quest ratings and survey results (plan note)

Tier B (ADR-355): no ledger, sign-in or tenant-boundary logic. A rating writes no points and the player's door reads only their own
row; the team doors run behind `award_event_of`; the one anonymous door opens a single survey quest by the hash of a bearer token and
answers aggregates only (the invitation landing's pattern, ADR-332). Delivers FR-1209, FR-1210, FR-1211, FR-1623, FR-1624.
Migration **0089** (new, undeployed; staging is at 0087, 0088 is deploying). Choices: **ADR-376 / Q-343 (Proposed)**.

## What exists (T-303) and what this adds

- `survey_summary(event, quest)` already gives the total, per-question counts, the rating average and the newest 50 texts; the quest form shows it. T-508
  moves its body into an internal `survey_results_core` (same answer, `survey_summary` restated as a thin wrapper) so the speaker's door reads the same numbers.
- Results show **on existing pages**, so the event menu gains no link (the "Set up is full" follow-up of T-507 is untouched): the quest's own form (as
  before, now with Export and Share) and the **session's row on the Agenda page** (a session that links a survey quest opens that quest's results in its row).
- **Ratings:** `quest_rating` (one row per player and quest: `up`, `down` or `skip`), the event switch `questRatings` (the only event switch that starts
  **off**, so the registry gets `eventOffByDefault`), `rate_quest`, `member_quest_rating`, `quest_rating_scores`. The app asks in the quest sheet under a quest
  the player completed; the dashboard shows "80% liked (8 up, 2 down)" on the quest's row.
- **Speaker's link:** `survey_share` (one per quest, hash of a 256-bit token), `survey_share_state|save|revoke` for owner and editor, `survey_shared_results`
  for the anonymous door `POST /v1/public/survey-results {token}` (body, not path; own throttle bucket; never cached). A page `/{lang}/r#token` reads the
  fragment and shows the results. Text answers that look like an address, a phone number or hidden characters are left out of the speaker's view
  (the shared `textIssue` rule) and counted.
- **Export:** a spreadsheet (CSV with a byte-order mark; formula-inert cells) built from the results already on screen: the response count, each choice's
  count, the rating average, each text answer; a survey nobody answered is one line that says so.

## Not in this task (recorded in TASKS)

- The survey results in the **one-page PDF report** (FR-1624's second half) and a quest's score in **quest analytics** (FR-1211's second half): the report and the
  analytics pages are T-608 and T-607; notes added there. The spreadsheet and the per-quest score on the quest row ship now.

## Care points

- A rating needs the player's own active enrollment, a completion of that quest and the event's switch on **and** the platform's (composed by the API); a stranger,
  an unknown quest, a device and an archived event all answer 404 alike. A skip never replaces a thumb.
- The speaker's link: a new link replaces the old one at once; stopping removes it; the quest's deletion takes it; the table stores only the hash; audit rows name the quest, never the link.
- The share creation is **not** idempotent on purpose: a replayed stored answer would keep the token in the idempotency store.
- No minimum group size: the FRs name none and a response carries no name. Q-343 asks whether a speaker's view should hold back a survey with fewer than a few responses.

## Mutation globs

None required (not tier A).
