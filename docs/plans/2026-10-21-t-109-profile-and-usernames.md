# T-109 — Profile at sign-up and username rules

Delivers FR-117, FR-118, FR-119 (already enforced by T-107's `create_player`; kept and tested), FR-120, FR-704, FR-705,
FR-1412, FR-1701, FR-1702; FR-1628 in part (the word lists and the check exist; marking player text arrives with the
first player text, T-301 submissions and the help desk). Depends on T-107. Core (sign-in and account data): Max.
ADR-119 (Accepted 2026-10-21): the first word lists come from LDNOOBW, cut and reviewed.

## Scope note

- **Server and shared rules only.** The profile screens are the app's (T-111 sign-in screens, the profile tasks in
  `ux/PLAYER.md`); this task gives them the endpoints and the shared rules.
- **Builds:** the avatar at sign-up (from Questify's six default avatars), usernames unique after Arabic and case
  folding (أ/إ/آ→ا, ة→ه, ى→ي), the word lists and the check in the database, the username history, `GET /v1/me` and
  `PATCH /v1/me` (avatar any time; username only while the platform allows changes and not more often than the tuned
  number of days), avatars on the ranking rows (FR-120: only username and avatar are ever shown to other players).
- **Not built:** the console screen to edit the word lists (FR-1779, the console tasks); marking player text (FR-1628,
  with the first player text); frames, titles and characters beyond the six defaults (the shop, T-4xx); account
  deletion (T-217).
- **Reuse:** `checkUsername` (T-107), `create_player`, the player guard, the settings registry (a platform feature and
  a tuning number), the throttle helpers, the conventions.

## Decisions (tactical; for the CTO to challenge)

1. **Avatars:** `AVATARS = ["falcon", "fox", "camel", "owl", "lantern", "explorer-hat"]` in `packages/shared` (the art
   exists: `docs/design/codex-image-2`, `avatar-*`). `player.avatar text NOT NULL DEFAULT 'falcon'` with a CHECK on
   the same six ids (the set is shipped art, so it is code, not configuration). Sign-up requires one.
2. **Folding:** `username_fold(text)` (IMMUTABLE SQL): lower case, then أ/إ/آ→ا, ة→ه, ى→ي. The unique index moves from
   `lower(username)` to `username_fold(username)`. The shared package has the same `foldUsername` for the app's hint;
   the database is the rule. NFKC and the character rules stay in `checkUsername`.
3. **Word lists (ADR-119):** `username_word (id, word, match 'word'|'part', language 'ar'|'en', created_at)`, words
   stored folded; forced RLS, no grants (the console edits it later through definers). `username_blocked(name)` (plain
   SQL, owner-only): folds the name; a `word` entry must equal a token (the name split at `_` and digits); a `part`
   entry may appear anywhere in the name with `_` and digits removed. Seeded by the migration from the cut lists
   (English ≈ 380 entries, Arabic ≈ 33). Entries of four letters or fewer are `word`, except a few that never occur
   innocently (fuck, shit, cunt, jizz, slut, twat, porn, wank); multi-word entries are joined without spaces.
4. **The check runs in the database** inside `create_player` and the new `rename_player`, so no route can skip it:
   outcome `username_blocked`. The API answers 422 `username_blocked` with one message ("choose another"), never the
   matched word.
5. **History (FR-1702):** `username_history (player_id, username, changed_at)`, append-only (an ALWAYS trigger refuses
   UPDATE and DELETE), written by a trigger on `player` insert and username update; no grant to the API role (admins
   read it through the console later). Every username a player had stays there; the old name is free for others once
   changed (FR-1701 only requires current names to be unique) — Claude's assumption, to confirm (Q-094).
6. **Changes (FR-702/705/1702):** a platform feature `usernameChanges` (not gated, on by default) and a tuning number
   `usernameChangeDays` (default 30, 1 to 365). `PATCH /v1/me {username}`: 403 `username_changes_off` when the feature
   is off; `rename_player(new_name, days)` (definer, the caller from `app_player_id()`) refuses `too_soon` with the next
   allowed time when the last change (from the history) is less than `days` ago, plus `username_taken`,
   `username_blocked`; the same name (folded equal to the current) is a no-op. 429 `username_too_soon {nextChangeAt}`.
   Avatar changes are free and unlimited (no rate limit needed: no one else sees a history of them).
7. **`GET /v1/me`:** `{id, username, avatar, usernameChange: {allowed, nextChangeAt}}`. No contact, no birth year in
   the answer (the app does not show them back; the birth year is kept only for the age rule).
8. **FR-120:** the ranking rows gain `avatar` (`ranking_rows`, `ranking_top`); a test asserts the ranking answer has
   exactly `rank, username, avatar, score, isMe` per row.
9. **Third-party notice:** `docs/legal/THIRD_PARTY.md` credits LDNOOBW (CC BY 4.0) with the link and "modified".

## Tests

- Shared: `foldUsername` table; `AVATARS`.
- Database: folding makes أحمد/احمد and SARA/sara collide; every list entry kind (word token, part anywhere, Arabic
  folded, underscores and digits); a clean name passes; blocked at sign-up and rename; history on insert and rename;
  history append-only; rename rate limit, no-op, taken, blocked; grants closed; outsider; definer search path.
- HTTP: sign-up with and without an avatar, a bad avatar; `GET /v1/me`; `PATCH /v1/me` avatar and username paths
  (feature off 403, too soon 429 with `nextChangeAt`, blocked 422, taken 409, invalid 422); the ranking row shape.
- Mutation on the new modules.

## Phases

1. **Database:** migration 0016 (avatar, folding index, word lists with the seed, history, `rename_player`, the
   `create_player` change, ranking rows with the avatar), database tests.
2. **API and shared:** `AVATARS`, `foldUsername`, the feature and tuning entries, sign-up body, `/v1/me` routes,
   errors, tests, mutation.
3. **Docs:** API.md, DATA_MODEL, SECURITY, RUNBOOK (editing the lists until the console exists), THIRD_PARTY.md,
   OPEN_QUESTIONS (Q-094 old names), TASKS, STATE.

## Revision 1 (after CTO plan review 1, 78/100) — overrides the sections above where they differ

- **B1, the check really is the only way in:** 0016 revokes `INSERT` on `player` and `UPDATE (username, birth_year)`
  from `questify_app` (sign-up and renames go only through the definers; the birth year is the age record) and grants
  `UPDATE (avatar)` (scoped by `player_own`). The core-columns test flips: a direct rename and a direct insert are
  refused. A second wall: `CHECK` on `player.username` mirroring `checkUsername`'s characters (Arabic U+0621–063A,
  U+0641–064A, `A-Za-z`, `0-9`, `_`, 3–30), so tatweel, tashkeel, zero-width marks and `ٱ` can never reach folding.
- **M1:** `DROP FUNCTION create_player(bytea, text, integer, bytea, bytea, uuid)` before creating the new signature (with
  `avatar`); `ranking_rows` and `ranking_top` are dropped and recreated (their result gains `avatar`), each with
  `REVOKE ALL FROM PUBLIC` and `GRANT EXECUTE TO questify_app` again. A test asserts the old signature is gone.
- **M2:** `username_fold(text)` is a SQL-standard body (`RETURN translate(lower($1), 'أإآةى', 'اااهي')`, IMMUTABLE,
  bound at creation), `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO questify_app` (index expressions run as the writer).
  A comment says a change needs a REINDEX. Tests: the grant, and a forced non-HOT update of `player` as the app role
  (the avatar update on a filled page).
- **M3:** `username_word` gets `CHECK (word ~ '^[a-z\u0621-\u063A\u0641-\u064A]{2,}$')`, `CHECK (word =
  username_fold(word))` and `UNIQUE (word)`. Seed normalization: lower case, fold, keep letters only (spaces, hyphens,
  apostrophes, `&` and digits removed), drop anything under two letters; entries that become duplicates collapse. A
  test refuses an empty and a punctuated entry.
- **M4:** `username_history.reason` (`signup` | `rename`); the change limit and `nextChangeAt` count `rename` rows only.
  A sign-up name can be changed at once (FR-705's first case).
- **M5:** before building the folded index, a `DO` block raises with the colliding player ids and the remedy when two
  existing names fold equal (no silent renames). `player_username_key` is dropped and recreated under the same name.
  Existing names that match a list word are kept; the list applies to new names.
- **M6:** `rename_player(new_name, days)` locks the caller's row (`FOR UPDATE`) before reading the history, refuses a
  player who is not active, refuses `days` that is null or outside 1–365, and maps a `unique_violation` to
  `username_taken`. A parallel-rename test: two renames at once, exactly one wins and one history row is written.
- **m1, platform-level features:** `FeatureDefinition` gains `level?: "platform"`; `validateEventConfig` refuses event
  switches for platform-level keys; `usernameChanges` is `{ gated: false, level: "platform" }` and the route reads
  `forEvent(undefined)`.
- **m2:** no `foldUsername` in shared (no consumer); `AVATARS` stays.
- **m3, erasure:** the history's append-only guard refuses DELETE unless the transaction set `app.erasure = on`, which
  only an erasure definer (T-217) will do; `player_id` references `player` ON DELETE RESTRICT. A note goes on T-217.
- **m4:** the history trigger function is a pinned definer, revoked from PUBLIC; the migration backfills one `signup`
  row per existing player (`username`, `created_at`).
- **m5:** the ranking's `me` gains `avatar`; the sign-in, sign-up and refresh answers carry `player: {id, username,
  avatar}`.
- **m6:** `part` entries are also checked against a second form of the name with common digit spellings mapped
  (0→o, 1→i, 3→e, 4→a, 5→s, 7→t) instead of removed; the RUNBOOK lists the bypasses the lists still miss (joined
  words against `word` entries, repeated letters) so an admin adds `part` entries; the reviewed seed marks the few
  Arabic short entries that are safe as `part` (none of the two-letter ones).
- **NITs taken:** decision 6 cites FR-1702; a rename that differs only by case or look-alike letters is a real rename
  (history row, counts), exact equality is the no-op; `username_blocked` keeps the signup token like
  `username_taken`; T-106 lands before 0016; TASKS says FR-1702 "in part" (the admin view of the history comes with
  the console).
