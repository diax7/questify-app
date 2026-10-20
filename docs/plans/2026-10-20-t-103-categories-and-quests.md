# T-103 — Categories and quests builder (dashboard)

Delivers FR-1004, 1005, 1006, 1007, 1008, 223, 225, 226, 227, 228, 229, 233, 1505 (docs/TASKS.md). Depends on T-102.

## Scope note

- No `category` or `quest` table exists yet (migrations 0001–0009). This task creates both (migration 0010), the
  dashboard API and pages to build them, and the quest-type registry every later quest task extends.
- Quest types ship in the binary (ADR-004, ADR-007, CONFIGURABILITY "a new quest type is a code change"); rewards,
  rules and text are organizer data. FR-1505: a quest is a type plus a reward plus rules.
- Player-side completion does not exist until T-105 (scan QR, enter code) and later tasks (T-301 submission, T-302
  vote/quiz, T-303 challenge/meet/survey/share/location, T-304 passport, T-305 mini-games). There is no completion
  table and no ledger yet.
- Reuse: the organizer scope and its hook (`registerOrganizerRoutes`), `organizerContextOf`, `parse`/`callerOf`,
  `recordAudit`, `withRequestContext`, the `readEvent(…, lock)` pattern, the event pages' `organizerPage` and
  `OrganizerShell`, `editBodyOf`-style diffs, `requestJson`, the route walk and the OWNED cross-tenant sweep.

## Decisions taken (tactical; for the CTO to challenge)

1. **The registry offers only the types the app can complete.** ADR-105 says a feature not yet in the app gets no
   switch; by the same rule the builder offers a type only once its player flow exists, or an organizer could build an
   event players cannot finish. T-103 ships the registry with **`scan_qr`** and **`enter_code`** (both completed in
   T-105, the next completion work). Each later task adds its type to the registry with its config schema, in the same
   change that builds its player flow. **FR-1005** is delivered for the shipped types and grows with each type;
   **FR-1006** (no video for submissions) moves with the submission type to **T-301**, where the schema refuses
   `video` with a clear message. Recorded as partly delivered in TASKS.
2. **No verification-method column yet.** FR-301 (which methods are on) is T-104's, with the signed QR and its
   version. T-103 quests are created without it; T-104 adds `verification` with the default "the quest's QR".
3. **Category fields are only what T-103 uses:** bilingual name, position. `order_mode` (FR-232 in-order is T-304),
   `completion_bonus` (FR-231, T-304), unlock, refresh, sponsor and audience (ADR-038/085) arrive with their tasks.
   With no order mode, every category is "any order", which is FR-233.
4. **Quest fields in T-103:** category, type, bilingual title (required in one language) and description, points
   (0 to 100,000), repeat cap per player (1 to 100; 1 means once, FR-227), optional opening and closing times (FR-225;
   stored now, enforced by the completion engine in T-105), visible (FR-226), position, `type_config` (validated by
   the type's schema in `shared`). Flash, community goal, QR version, item rewards, sponsor tag, pin, first-N bonus,
   pause and difficulty arrive with their tasks.
5. **The default "General" category** ("عام" / "General") is created by an AFTER INSERT trigger on `event`, so every
   event has one however it is made (FR-228), including the events created before 0010 (backfilled in the migration).
6. **Exactly one category per quest** is the schema (`category_id NOT NULL`, same event enforced by a composite foreign
   key `(event_id, category_id)` → `category(event_id, id)`).
7. **Deleting a category** (FR-1004): the last category of an event cannot be deleted (409 `last_category`). A
   category that holds quests needs a choice in the body: `{quests: "move", to: <categoryId>}` (appended at the end of
   the target) or `{quests: "delete"}`; the dashboard's confirmation names how many quests are affected. The points
   branch ("keep or remove the points players earned") has nothing to act on until completions exist; it arrives with
   T-105/T-207 and is noted as partly delivered.
8. **Live edits (FR-1007, ADR-063, UX 1098):** in an event whose status now is `live`, any change to a quest or
   category, and any delete, needs `{confirm: true}` (409 `confirm_required` otherwise, with the dashboard showing the
   confirmation screen and sending again). The "future only or also past" branch for points and the "keep or remove
   points" branch for deletes have nothing to act on until there are completions; they arrive with the completion
   engine (T-105) and the change tools (T-604). Ended and archived events are read-only for quests and categories (409
   `event_closed`): their results are history.
9. **Limits:** 30 categories and 300 quests per event, names and titles ≤ 120 characters, descriptions ≤ 2,000, an
   entry code 3 to 32 letters or digits. Counts are checked under the event row's lock (`SELECT … FOR UPDATE` on
   the event) so two parallel creates cannot pass the cap; lengths and ranges are database CHECKs too.
10. **Reordering** (FR-229): `PUT …/categories/order {ids}` and `PUT …/categories/{id}/quests/order {ids}` take the
    full list and rewrite positions in one statement; a list that is not exactly the current set answers 409
    `order_stale` (someone else changed it; reload). The dashboard uses Up and Down buttons (keyboard and screen-reader
    friendly, no drag library, no new dependency).
11. **Entry codes are secrets:** the `enter_code` config's code is never returned to players (their API arrives in
    T-105 and must strip it); the dashboard shows it to members. Codes compare case-insensitively (stored upper-case).

## Behaviour

### Migration 0010

- `category(id uuid PK, organizer_id, event_id, name_ar, name_en, position int, created_at)`: CHECK one name present,
  lengths ≤ 120, `UNIQUE (event_id, id)` for the quest FK, index `(event_id, position)`.
- `quest(id, organizer_id, event_id, category_id, type text, title_ar, title_en, description_ar, description_en,
  points int CHECK 0..100000, repeat_cap int CHECK 1..100 DEFAULT 1, opens_at, closes_at CHECK closes > opens, visible
  bool DEFAULT true, position int, type_config jsonb NOT NULL DEFAULT '{}', created_at, updated_at)`: CHECK one title,
  lengths; `type` CHECK against the shipped list (`scan_qr`, `enter_code`; each later task widens it); FK
  `(event_id, category_id)` → `category (event_id, id)` ON DELETE RESTRICT (moving or deleting quests is explicit);
  FK `event_id` → `event` ON DELETE CASCADE (a draft event's quests go with it).
- Organizer id is denormalized like `enrollment`, set by a BEFORE INSERT trigger from the event (never trusted from
  the API), and the same `organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())` policies
  for SELECT/INSERT/UPDATE/DELETE, `OR app_is_admin()`. FORCE ROW LEVEL SECURITY, REVOKE ALL FROM PUBLIC, column
  grants to `questify_app` (no `organizer_id`, `id`, `created_at` writes; `event_id` not updatable).
- Trigger `quest_closed_guard`: no insert, update or delete of quests or categories when the event's status now is
  `ended` or `archived` (QQ409), for the API's role.
- Trigger on `event` AFTER INSERT: insert the General category (definer, pinned `search_path`); backfill for existing
  events.
- Players get no access yet (their read API is T-105/T-114, which adds a visible-quests policy).

### Shared: the quest-type registry (`packages/shared/src/quests/`)

- `QUEST_TYPES = { scan_qr: { config: z.strictObject({}) }, enter_code: { config: z.strictObject({ code, hint? }) } }`
  with `QuestType` as the union of its keys, `parseQuestConfig(type, value)` → result, and per-type labels in
  MESSAGES (`quests.type.scan_qr`, …). A new type is one entry plus its messages: the editor, the API and the
  database check pick it up without touching other types (FR-1505); a test asserts every registry key has messages and
  is in the migration's CHECK list (read from the database).

### API (organizer scope, `member` access unless noted)

- `GET …/events/{eventId}/quests` → `{categories: [{…, quests: [...]}]}` in order (one call for the builder).
- `POST …/events/{eventId}/categories` (Idempotency-Key) `{name: {ar?, en?}}` → 201; `PATCH …/categories/{id}`;
  `DELETE …/categories/{id}` `{quests?: "move" | "delete", to?, confirm?}`; `PUT …/categories/order {ids}`.
- `POST …/events/{eventId}/quests` (Idempotency-Key) `{categoryId, type, title, description?, points, repeatCap?,
  opensAt?, closesAt?, visible?, config}` → 201; `PATCH …/quests/{id}` (any field but `type`, which is fixed once
  created: a different type is a different quest; `config` validated against the stored type); `DELETE
  …/quests/{id}`; `PUT …/categories/{id}/quests/order {ids}`. Times as the event's wall clock, read in its zone (the
  T-102 helpers).
- Answers: 404 outside reach (as events), 409 `confirm_required` / `event_closed` / `last_category` /
  `category_not_empty` (delete without a choice) / `order_stale`, 422 `invalid_quest {field}` / `invalid_category
  {field}`, 429 `limit_reached {limit}` for the caps (or 409; CTO's call).
- Audit: `category.create|update|delete|reorder`, `quest.create|update|delete|reorder`, changed fields only; the
  entry code is written as `"***"` in audit rows (a secret, not personal data, still kept out of logs).

### Web

- From the event page, a "Quests" link → `/[lang]/organizers/:id/events/:eventId/quests`: the categories in order,
  each with its quests (title in the page's language with fallback, type, points, repeat cap, hidden badge, window),
  Up/Down for categories and quests, "Add category", "Add quest" per category.
- Quest form (new and edit): type (only shipped types; fixed after creation), category, title AR/EN, description
  AR/EN, points, "can be done more than once" with the cap, opening/closing times in the event's zone, visible, and
  the type's own fields (one small component per type, chosen from the registry).
- Confirmations: deleting a category names its quests and offers move-to or delete; deleting a quest; any change in a
  live event shows "Players see this change at once" and sends `confirm: true`.
- Messages AR/EN for everything (`ux-araby` style).

## Tests

- Database: owner/editor/limited editor/outsider on both tables (the OWNED sweep and probes), the General category on
  insert and backfill, the composite FK refusing a quest in another event's category, the closed-event guard, the
  type CHECK, CHECKs on lengths and ranges, organizer id set from the event (a forged one ignored).
- API integration: CRUD for both; idempotent creates; limits under parallel creates; reorder (exact set, stale set);
  category delete branches (move, delete, last category, not empty without a choice); live edits need confirm; ended
  event read-only; enter-code config validation and upper-casing; type fixed after creation; scope (a limited editor
  sees only their events' quests, 404 otherwise); audit rows with the code masked.
- Shared: the registry (every key has messages and a schema; configs parse and refuse).
- Route walk: the new routes classified. e2e: build a category and two quests in Arabic, reorder, hide one, delete a
  category by moving its quests.
- Mutation scope: `apps/api/src/quests` and `packages/shared/src/quests` added.

## Phases

1. **Database and registry:** migration 0010, the shared registry, database tests.
2. **API:** routes, flows, integration tests, route walk, mutation.
3. **Web and docs:** pages, e2e, API.md, DATA_MODEL.md, TASKS (partly delivered: FR-1005 grows per type, FR-1006 with
   T-301, the points branches of FR-1004/1007 with T-105/T-604), STATE.

## Revision 1 (after CTO plan review 1, 88/100) — overrides the sections above where they differ

- **M1, child rows under the path's event.** Every category and quest is read, changed and deleted by
  `(event_id from the path, id)`: one `readCategory(eventId, id, lock)` and `readQuest(eventId, id, lock)` each, 404
  on a mismatch. Otherwise an editor in scope for two events could send an edit of a live event's quest through a
  draft event's path and skip the confirmation. Integration test: a quest of event B through event A's path → 404.
- **Error code:** the closed-event guard raises `QE409` (as 0009); the API maps it to 409 `event_closed`.
- **Foreign-key errors:** a quest moved to a category of another event, or a category delete whose `to` names another
  event's category or itself, answers 422 `invalid_quest {field: "categoryId"}` / `invalid_category {field: "to"}`
  (23503 is mapped, never a 500). A moved quest goes to the end of its new category, under the same lock.
- **Lock mode:** the builder locks the event row with `FOR NO KEY UPDATE`, which serializes builder writers but does
  not block the foreign-key inserts (enrollments, later completions and ledger rows) a live event makes.
- **Caps answer 409 `limit_reached {limit}`** (a conflict with state, not a rate).
- **Creating in a live event needs no confirmation** (UX table: edits, deletes, show or hide, order); edits, show or
  hide, reorders and deletes do.
- **Entry codes:** ASCII A–Z and 0–9, 4 to 32 characters, stored upper-case; no answer, log or audit row ever echoes
  the code (audit writes `"***"`).
- **Order** is `(position, id)` everywhere. Deleting a category that deletes its quests writes one `category.delete`
  entry with the quest ids and count. Per-type editor components are a `Record<QuestType, Component>`, so a type
  without its editor fails the type check. DELETE bodies go as JSON (`requestJson` sends the content type).
- **Docs in this change:** TASKS (FR-1006 to T-301; FR-1005 grows per type; point branches to T-105/T-604 with the
  interim rule "a quest with completions cannot be deleted, hide it" in T-105; FR-233 in part with T-304; the preview
  with T-114; T-104's per-type verification flag), DATA_MODEL (what 0010 builds; Questify quests in their own table),
  API.md (`apply` arrives with T-604), DECISIONS ADR-114 (Proposed).
- **Database test:** deleting a draft event with categories and quests succeeds (event cascade versus the RESTRICT
  foreign key).

## Build notes

- Phase 1 code review: 93, GO. Folded in: a test that the shared registry and the database's `quest_type_known` list
  agree, and entry-code hints need at least one non-empty language.
- Phase 2 code review: 93, GO. Folded in: a replayed create test, and the two remaining live confirmations under test.
- Entry codes in the audit: the audit layer refuses any `code` key, even masked, so an entry says `entryCode: "set"`
  and an edit says `codeChanged`; the code itself is never written (better than the planned `"***"`).
- The order of answers in a live event is lock, not found, closed, then confirmation, then the field checks. The
  dashboard checks a quest with the shared rules (`questProblem`) before it sends, so a person is never asked to confirm
  a change that would then be refused.
- Duplicated with `events/events.ts`: `blankToNull` and the time read in a zone (two copies; extracted at the third,
  likely rewards in T-201).
