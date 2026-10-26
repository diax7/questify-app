# T-403 — Achievements, Event Passport, event history and Questify quests

**Plan only; nothing is built until an independent plan review returns GO (>=90, zero unresolved BLOCKER/MAJOR).**
Delivers FR-707, FR-708, FR-709, FR-710, FR-711 and completes FR-701/FR-702 (achievements, passport, the owner's
event history). Depends on T-401 (XP), T-402 (profile), T-214 (results), T-306b (community goals), all done. This
one plan covers all three parts below; T-403b and T-403c need no plan of their own. Never push, deploy, run EAS or
run local mutation testing. Choices are **Proposed ADR-273 to ADR-279 / Q-239 to Q-245**.

## Split (ADR-273, Q-239)

One worker cannot build and prove a new evaluator, two admin doors, a ledger source and three app/web surfaces in
one run (T-402b, a smaller core task, took three code reviews). Split by risk so the display work can go to a cheaper
model and a lighter review:

| Part | Bar | Delivers | Migration |
|---|---|---|---|
| **T-403** | **CORE** (public/private profile boundary, a confirm-results change, the evaluator every reward will hang on) | Event city; final-rank snapshot; Event Passport and owner history reads; achievement catalog, earned tiers, the sync evaluator; public profile gains achievements and passport | 0065 |
| **T-403b** | **CORE** (writes the XP ledger, admin powers) | Always-on and seasonal Questify quests: catalog, campaigns, console API doors, awards paid through `xp_entry` | 0066 |
| **T-403c** | **STANDARD** (display and copy) | App: profile achievements/passport/history, public profile sections, Questify quests screen, sync calls and the earned toast. Dashboard: event city picker. Console: campaign and quest editor pages. All strings | none |

T-403 is checked when its API and DB suites pass and its code review is GO; "Done when" (a finished event adds a
stamp; unearned achievements show as silhouettes) is proven on screen by T-403c, which ticks FR-708/709 on screen.

**Out of scope (SCOPE.md and existing tasks):** item or gem rewards for achievements/Questify quests (ADR-046's gems are
T-404, which will read the earned rows added here, once per row, like `level_reached`); the event logo (T-602; a
stamp shows a fallback emblem until then, the FR-1759 precedent); "set your interests" (T-407 adds the metric and calls
the same evaluator); "follow Questify" (Q-245, store risk, below); editing achievement thresholds in the console
(T-709); notifications (T-501); exports (T-708). No money, trading, random rewards, new service or dependency.

## Shared definitions (ADR-274, Q-240, Q-241)

- **Played an event** = the player holds at least one *standing* quest XP credit there: an `xp_entry` with
  `source = 'quest'` and no reversal, through `ledger_entry → enrollment`, where the enrollment is not `banned` or
  `removed` and `joined_via <> 'rehearsal'`. XP credits already exist only for non-rehearsal first completions from
  every writer (scan, typed code, My QR, team award; T-401), so nothing new is written in the scan path and a player
  cannot create a fact the server did not already record. "Events attended" (FR-707, FR-710) means played.
- **Metrics**, all from server facts, computed by one internal STABLE function `player_metrics(player, since, until)`
  (NULL bounds = lifetime; bounds filter by the credit's `created_at`, half-open `[since, until)`):
  `events` (played events), `quests` (standing quest credits), `cities` (distinct non-null `event.city_id` of played
  events), `top10` (revealed `final_rank` ≤ 10 on non-banned enrollments), `goals` (distinct `community_goal` with
  `status = 'reached'` where the player's enrollment is a `community_contributor`). `top10` and `goals` are lifetime only.
- **Earned is permanent.** Achievement tiers and Questify quest awards are append-only rows; a later removal that drops
  a count below a threshold takes nothing back (FR-1602's rule for items). The passport is derived on read, so a fully
  reversed event leaves it.
- **One evaluator, one door.** `questify_sync()` (definer, granted to `questify_app`) is the only writer of earned rows.
  The app calls it when Profile or Questify quests gains focus, on foreground (at most every 5 minutes) and after a
  completion result. Nothing is added to the completion transaction (scan latency, no new locks beside scans). FR-710's
  "completes when they play a third event" is met at the next sync, seconds later; SRS gets that amendment at build.

## T-403 (CORE) — migration 0065

All new tables: ENABLE and FORCE RLS, REVOKE ALL FROM PUBLIC and `questify_app`; definers `SET search_path = public,
pg_temp`, PUBLIC EXECUTE revoked in the same statement group; only the doors named here get `questify_app` EXECUTE.
Each door rechecks an active caller through `app_player_id()` (or `app_admin_id()`), not only the HTTP guard.

| Object | Shape | Notes |
|---|---|---|
| `city` | `id text PK` (`^sa-[a-z0-9-]{2,30}$`), `name_ar`, `name_en` (1–60, no control/bidi chars), `position smallint`, `active bool` | Seeded with about 20 Saudi cities (Riyadh, Jeddah, Makkah, Madinah, Dammam, Khobar, Dhahran, Taif, Abha, Tabuk, Buraidah, Hail, Jazan, Najran, Al-Ahsa, AlUla, Yanbu, Al Baha, Jubail, Khamis Mushait). Read through `city_list()`. T-407 reuses it for the player's city; console editing is T-703/T-709 (ADR-277, Q-244) |
| `event.city_id` | `text NULL REFERENCES city` | Added to the API role's INSERT/UPDATE column grants (owner/editor under the existing event RLS). CHECK `kind <> 'virtual' OR city_id IS NULL`. The times guard (`0009`, latest body) gains: frozen once live, so a played event's city never moves. Existing events stay NULL and count no city |
| `final_rank` | `event_id`, `enrollment_id`, `rank int ≥ 1`; PK (event_id, enrollment_id), UNIQUE (event_id, rank); composite FK to `enrollment (id, event_id)`; index (enrollment_id) | Every ranked enrollment's place, written once by `confirm_results` in the statement after `result_place`, from the same ordering (`current_places` refactored to `all_places(ev)` + LIMIT so both share one ORDER BY). Append-only (0012 trigger, ENABLE ALWAYS); kept on erasure tombstones. Backfill for already confirmed events: `result_place` ranks first, then the remaining ranked enrollments after them (ADR-275, Q-242) |
| `achievement` | `id text PK`, `metric` UNIQUE CHECK IN (events, quests, cities, top10, goals), `bronze < silver < gold` (each 1–100000), `name_ar/en`, `visual_key` (shipped allowlist), `position` | Seeded 5 rows: events 1/5/15, quests 10/50/200, cities 2/4/8, top10 1/3/10, goals 1/5/15 (Q-240). Data, not code: T-709 edits thresholds/names later; a threshold change never removes an earned row |
| `achievement_earned` | `player_id → player_xp`, `achievement_id → achievement RESTRICT`, `tier` bronze/silver/gold, `earned_at`; PK (player, achievement, tier) | Append-only for every role (no UPDATE/DELETE/TRUNCATE, ENABLE ALWAYS). Points at `player_xp`, like the XP rows, so its FK checks never wait on `erase_player`'s player lock. Kept on the tombstone (no personal data; ADR-175's list gains a row). A jump writes every tier passed |

New index for the evaluator: `community_contributor (enrollment_id)`; `final_rank (enrollment_id)` above. Index use
is asserted with EXPLAIN in one DB test.

**`questify_sync()`** — lock order: the caller's `player` FOR KEY SHARE (active, else the existing inactive-player
refusal), then `player_xp` FOR UPDATE, then reads (no locks) and inserts. Completions take enrollment then `player_xp`
and no player lock after it (T-402); erasure takes player FOR UPDATE → enrollments → `player_xp`. Sync and erasure meet
on the player row first, and nothing holding `player_xp` waits for a player lock, so there is no cycle; two syncs
serialize on `player_xp` and the second reports nothing new. It computes
lifetime metrics once, inserts each tier now met `ON CONFLICT DO NOTHING RETURNING`, and answers
`{achievements: [{id, tier}]}` for what this call wrote (T-403b adds `quests` and `levelUp`). No Idempotency-Key: the
call carries no client input and a replay writes nothing. Rate limit: 20 a minute per player (existing buckets).

**Reads (definers, caller-bound, no player parameter):**
- `own_achievements()`: all five, each `{id, name, visualKey, tier|null, progress, next|null}`; `tier` null is the
  silhouette (FR-708). Progress is computed live; the tier shown is the highest earned row.
- `own_event_passport(before, page ≤ 50)`: played events newest first, each `{eventId, name {ar,en}, date (the event's
  local start date, 'YYYY-MM-DD' from `starts_at AT TIME ZONE timezone`), city {ar,en}|null, rank|null, rankState, isPublic}`.
  `rankState`: `live` (event not ended, `event_status_now`), `pending` (ended, results not revealed), `final` (revealed,
  rank from `final_rank`), `unranked` (revealed, no row: zero points or team). FR-709's "no final rank while running".
- `own_event_history(before, page ≤ 50)`: every non-rehearsal enrollment of the caller except `pending`/`declined`, newest
  join first: `{eventId, name, startsAt, endsAt, timezone, eventStatus, memberStatus, score, rank|null, played}`. Owner only.
- `public_player_profile(username)` (T-402, replaced in 0065) gains `achievements: [{id, tier|null}]` (all five, tiers
  only, no progress) and `passport: [{name, date, city, rank|null}]`: at most the 50 newest stamps of events whose
  `access = 'public'` **at read time** (ADR-276, Q-243). Unlisted and private events never appear publicly; no event id,
  score, member status, join answer, history, count of hidden stamps or progress is in the public DTO. Achievement
  counts include private events (a tier shows a number, never which event).
- `city_list()`: active cities by position.

**API** (`apps/api/src/questify/`; the name `passport` is taken by the T-304b quest type, so this is "event passport"):

| Route | Access | Answer |
|---|---|---|
| `POST /v1/me/questify/sync` | player | `{achievements: [{id, tier}]}` newly earned |
| `GET /v1/me/achievements` | player | `[{id, name, visualKey, tier, progress, next}]` |
| `GET /v1/me/event-passport?cursor&limit` | player | `{stamps: [...], next}` |
| `GET /v1/me/event-history?cursor&limit` | player | `{events: [...], next}` |
| `GET /v1/players/{username}` | player | T-402 DTO + `achievements`, `passport` (exact allowlist test) |
| `GET /v1/cities` | public | `[{id, name {ar,en}}]`, ETag |
| event create/update (dashboard) | owner/editor | gains `cityId`; unknown city 400, virtual with city 400, live change 409 `city_locked` |

Shared zod schemas in `packages/shared/src/questify/`. Staff sessions cannot enter player doors (T-402 pattern).

## T-403b (CORE) — migration 0066: Questify quests (ADR-278, Q-245)

Configuration is data the Questify team edits in the console (product principle 1); the metric list is closed code,
so configuration never downloads a feature (rule 7). Questify quests are platform-wide and separate from event quests:
they never pay event points, never touch `ledger_entry`, and count event facts only through `player_metrics`.

| Table | Shape | Notes |
|---|---|---|
| `questify_campaign` | `id uuid`, `name_ar/en` (1–80, no control/bidi), `starts_at < ends_at` (timestamptz), `status` draft/published/retired, `created_by`, timestamps | Seasonal window. The console enters Saudi time (Asia/Riyadh, no DST) and sends ISO with offset; stored as instants. Published: shown when `starts_at <= now() < ends_at` (FR-711). After publish, `starts_at` is frozen once started and `ends_at` may only move later while running; retire at any time hides it and keeps awards |
| `questify_quest` | `id uuid`, `campaign_id NULL → campaign` (NULL = always-on), `metric` CHECK IN (events, cities, quests), `target` 1–1000, `title_ar/en` (1–80), `xp` 1–10000, `position`, `status` draft/active/retired | At most 20 per campaign and 50 active always-on (trigger, advisory lock). Metric, target and campaign are frozen once any award names the quest (guard); a changed `xp` applies to later awards only. Delete only a draft with no award |
| `questify_award` | `id bigint identity`, `player_id → player_xp`, `quest_id → questify_quest RESTRICT`, `earned_at`; UNIQUE (player_id, quest_id) | Append-only, ENABLE ALWAYS; kept on the tombstone |
| `xp_entry` (altered) | `source` gains `questify`; `ledger_entry_id`, `quest_id` DROP NOT NULL; `questify_award_id bigint UNIQUE → questify_award` | CHECK rewritten: quest/removal exactly as 0039 (both ids NOT NULL); questify → delta > 0, both ledger ids NULL, `reverses` NULL, award id set. `xp_reverse` only follows `ledger_entry_id`, so a removal can never reverse a Questify award. Brief table lock in the migration; T-408's monthly sum includes Questify XP by design |

**Evaluator extension** (inside `questify_sync`, after the tiers, same lock): for each active always-on quest, lifetime
metrics; for each active quest of a published campaign with `starts_at <= now() < ends_at + 3 days`, metrics bounded to
`[starts_at, ends_at)`. Facts before the start never count, so a new campaign needs no backfill and veterans cannot
complete it on day one. The 3-day grace only lets a qualifying play near the end be rewarded at a late sync; the list
stops offering the quest at `ends_at`. Each met quest: insert `questify_award ON CONFLICT DO NOTHING`; if written, insert
the `xp_entry` (`xp` read under the lock) and call T-401's `xp_apply(player, entry, xp)`, so `player_xp`, the level,
`level_reached` and T-402's level items all follow in the same transaction. The answer gains `quests: [{id, title,
xp}]` and `levelUp` (the highest `level_reached` this call wrote). A new always-on quest reaches a veteran who already
qualifies at their next sync (the app syncs on Questify quests focus), so no backfill job exists.

**Reward visibility:** a Questify quest shows its XP ("+300 XP"); Q-146's hidden per-quest XP is about event quests.
Seeded always-on: "Attend 3 events" (events 3, 300 XP) and "Play in 2 cities" (cities 2, 300 XP) (Q-240).

**Follow Questify is not built (Q-245).** Rewarding an action outside the app with XP may read as "other compensation"
under App Store 3.2.2(x) (`STORE_COMPLIANCE.md` only clears in-app actions such as the share sheet), on top of Meta's
rule that ADR-034 accepted. FR-710 lists it as an example; attend 3 events and play in 2 cities meet the requirement.
If Dhia accepts the risk, a `follow` metric with an allowlisted https URL and an honor-system door is a small addition.

**Admin doors** (definers, each checks `app_admin_id()` itself, audited `questify.campaign_*`/`questify.quest_*` with ids
and changed field names only, Idempotency-Key on every write route under `/v1/admin/questify/`, ADMIN_PREFIX guard):
`questify_campaign_save`, `questify_campaign_publish`, `questify_campaign_retire`, `questify_quest_save`,
`questify_quest_retire`, `questify_admin_list`. Player doors: `own_questify_quests()` →
`GET /v1/me/questify-quests`: `{alwaysOn: [q], seasonal: [{campaign {id, name, endsAt}, quests: [q]}]}`, each
`q = {id, title, metric, target, progress, xp, done}`; progress uses the same bounds as the evaluator.

## T-403c (STANDARD) — surfaces

- **App** (`apps/app`): Profile gains an Achievements row (five badges; silhouette = dark tint + lock; tier ring from
  bronze/silver/gold theme tokens, added if missing; progress to the next tier on own profile only), an Event Passport
  section (stamp grid: emblem from the event's first letter until T-602's logo, local date, city, rank or "Results
  soon"/"Not ranked"; private stamps marked "Only you see this") and History (own only). The public profile shows
  achievements and the public passport, nothing else. A Questify quests screen (always-on, then each live campaign with
  "Ends in N days"/"Ends today" from `endsAt`, progress bars, done state). `useQuestifySync` calls sync on focus,
  foreground (≥5 minutes apart) and after a completion result, then shows one light toast per new tier/quest and the
  existing medium level-up beat when `levelUp` is set (Reduce Motion respected).
- **Dashboard**: event form city picker from `/v1/cities`, hidden for virtual events, read-only once live.
- **Console**: `/console/questify` — campaigns (create, edit window in Saudi time, publish, retire) and quests
  (always-on and per campaign: title ar/en, metric, target, XP, order, retire), with the API's refusals shown.
- Strings: every label in `packages/shared/src/i18n/messages.ts` in Arabic and English; achievement and seeded quest
  names reviewed with `ux-araby` (working names: Wanderer رحّالة, Quest Hunter صائد المهام, City Roamer جوّاب المدن,
  Top Ten نخبة العشرة, Teamwork يدٌ واحدة); RTL layouts checked; Western digits everywhere (ADR-018); no
  `toSorted`/`toReversed`/`Object.groupBy`/new Set methods/`structuredClone` (Hermes guard).

## Tests (test first)

**T-403 DB** (`apps/api/test/db/achievements.int.test.ts`, `event-passport.int.test.ts`, `final-rank.int.test.ts`):
- Stamps: first credit makes a stamp, a repeat adds none; rehearsal, award-only and welcome-only make none; a fully
  reversed event drops out, a partly reversed one stays; banned/removed enrollments drop out; two events, two stamps;
  operator scan and team quest award count; `rankState` live → pending (ended, unrevealed) → final/unranked (revealed).
- `final_rank`: confirm writes every ranked enrollment once; its top ranks equal `result_place`; zero-point/team members
  get none; append-only refusals; backfill on a confirmed fixture; erasure keeps tombstone rows; a 20,000-member
  confirm stays inside a stated time bound (opt-in timing test, like T-402b's 20,001-recipient run).
- Evaluator (deterministic fixtures with fixed timestamps): each metric at threshold − 1, at, and past; a jump writes
  three tiers; replay writes nothing; two concurrent syncs on two connections write once and only one reports it;
  dropping below keeps the tier; top10 needs reveal; goals need `reached` and contribution; cities ignore NULL and
  virtual; sync crossing `erase_player` and a completion in both orders (no deadlock, no row after erasure commits).
- Privacy: the public DTO has exactly the allowlisted keys; private and unlisted events never listed (also after an
  event moves public → private); no history, score, progress or join answer; owner sees private stamps flagged.
- City: virtual with city refused, unknown city refused, live change refused, editor outside their event limit refused.
- Append-only: UPDATE/DELETE/TRUNCATE refused for the owner role on `achievement_earned` and `final_rank`.

**T-403b DB** (`questify-quests.int.test.ts`): one award per (player, quest) under replay and two concurrent syncs;
draft/retired quests and unpublished/retired campaigns award nothing; window boundaries (a fact at `starts_at` counts,
at `ends_at` does not; a sync at `ends_at + 3 days − 1s` grants, at `+ 3 days` does not); XP CHECKs for every source;
an award's level-up writes `level_reached` and grants the T-402 item; `remove_award` never reverses a Questify entry;
frozen-field guard after an award; caps; bidi/control names refused; every admin door refuses a player, an organizer
staff session, a device context and the anonymous role, and audits.

**Security** (`apps/api/test/security/*`): outsider EXECUTE probe gains every new function; cross-tenant suite lists the
new tables (an organizer reads no achievement, award, rank or city change of another tenant); the rehearsal guard list
and community gate map gain the new tables. **Route/unit:** shapes, auth, rate limit, staff refused on player doors,
admin prefix, the shared schemas. **T-403c:** app unit tests for the sync hook throttle and toasts, silhouettes, rank
states, RTL snapshots; browser specs for the console page and the dashboard city field (both languages, phone width);
`npx expo export`; full browser suite after a fresh web build.

## Mutation (GitHub only, ADR-174) and review levels

- T-403: `apps/api/src/questify/**/*.ts` and the public-profile mapper it changes in `apps/api/src/players/`, plus
  `packages/shared/src/questify/*.ts`; tests excluded. Most logic is SQL, covered by the DB suites (T-401 precedent).
- T-403b: the `apps/api/src/questify/` files it adds or changes (quests, admin), `packages/shared/src/questify/*.ts`.
- T-403c: none (standard).
- Reviews: this plan, one independent plan review (core, covers all three parts). T-403 and T-403b: one independent
  core code review each (re-review only after a BLOCKER or several MAJORs). T-403c: one standard code review and one
  Arabic review; both can run on a cheaper model.

## Docs touched at build

DATA_MODEL (city, event.city_id, final_rank, achievement tables, Questify quest tables, xp_entry source), API (routes
above), SRS status rows and the FR-709 logo/FR-710 sync amendments, TASKS notes (T-404 gems per earned row; T-407 the
interests metric and the player's city from `city`; T-602 the stamp logo; T-708 export of achievements, awards,
passport and history; T-709 achievement thresholds), STORE_COMPLIANCE (Questify quests reward only in-app play).

## Proposed decisions and questions

- **ADR-273 / Q-239** the three-part split, CORE/STANDARD labels.
- **ADR-274 / Q-241** played = a standing quest XP credit; derived passport; one sync evaluator; earned rows permanent;
  no change to the completion transaction.
- **ADR-275 / Q-242** final rank from a confirm-time snapshot of every ranked member, shown only after the reveal.
- **ADR-276 / Q-243** public passport lists only events public at read time; private stamps are owner-only.
- **ADR-277 / Q-244** a seeded city catalog; event city set by owner/editor, frozen once live, none for virtual.
- **ADR-278 / Q-245** Questify quests as console data with a closed metric list; seasonal counts in-window facts with a
  3-day grant grace; XP through `xp_entry` source `questify`; follow Questify not built pending store risk.
- **ADR-279 / Q-240** seeded thresholds, quests and XP amounts; no item/gem rewards before T-404.
