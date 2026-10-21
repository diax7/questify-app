# T-116 — The ranking screen

Delivers FR-601, FR-602, FR-603, FR-604 (in part), FR-605. App only: the API (`GET /v1/events/{id}/ranking`, T-106)
already gives the top 10 with `isMe`, the player's own row (`me`, null without points) and the total, ordered by points
then by who reached them first, without banned, removed or excluded players and the organizer's team.

## Scope note

- **Today:** `apps/app/app/event/[eventId]/ranking.tsx` is a plain scrolling list (T-113); Home's card shows my rank and
  the top 3 (`fetchRanking`, `rankingAnswer`).
- **Profile details (FR-604):** players have a username and one of six avatars (FR-117). Frames and titles arrive with
  cosmetics (T-4xx); the row shows what exists and never a placeholder. The API never sends a real name, phone or email.
- **No hide option (FR-605):** none exists anywhere; the test that guards it is the API's (a player cannot leave the
  ranking), and the app adds no setting.
- **Art:** the six avatars from the brand set (`docs/design/assets/icons/avatar-*.png`), reviewed at full size, trimmed
  to their content, faint stray pixels removed, 128 px copies in `apps/app/assets/avatars/` (about 140 KB in all). The
  medal set has only gold, so ranks 1 to 3 get themed badges, not medal art (a note for the brand queue).

## Decisions (tactical; for the CTO to challenge)

1. **The rows (pure `rankingRows`, tested):** the top rows as given (up to 10, none invented: FR-601's 6-player case);
   the player's own row as an 11th row only when `me` is set and none of the top rows `isMe` (FR-602: ranked exactly
   10th → no 11th row); `me` null → a line "Earn points to get a rank" instead of a row. Rows keyed by rank and
   username together.
2. **No scrolling, on every size (FR-603):** no `ScrollView`. The list area measures its own height (`onLayout`); each
   row's height is that height divided by the slots (rows plus the own row), between 32 and 56 points (pure
   `rowHeight`, tested). Text in a row is one line, shrinks to fit (`adjustsFontSizeToFit`), and its font scaling is
   capped (`maxFontSizeMultiplier` 1.4), the one place the app limits large text, so 11 rows always fit; the full
   username is in each row's accessibility label. The smallest supported phone (iPhone SE, 667 pt high) leaves about 420
   points for the list: 38 per row.
3. **A row:** the rank in a badge (1, 2 and 3 in the theme's highlight colours), the avatar image, `@username` (left to
   right inside an Arabic row, as a username is Latin), the score with Western digits and grouping. The player's own row
   is highlighted with a border and its label says "you". An avatar this app does not know shows the username's first
   letter in a circle (F-282).
4. **Freshness:** reads on focus, on return to the front, and every 15 seconds while the screen is open and the app is in
   front (one cached read; the ranking reflects a score within 5 seconds server-side, T-106). A failed refresh keeps the
   last good list with a quiet "can't refresh" line.
5. **States:** loading; failed with retry; `ranking_off` (the organizer hid it); an empty ranking ("No one has points
   yet"); `gone` handling as Home (403 `not_enrolled` or 404 forgets the event).
6. **Shared avatar component:** `Avatar` (image by name, fallback letter) used by the ranking screen and Home's card.

## Tests

- `rankingRows`: the top 10 with me inside, me 37th (11th row with rank 37), me exactly 10th (no 11th row), 6 players,
  no points (`me` null), an empty ranking.
- `rowHeight`: the smallest phone's list height gives every slot at least 32, a tall phone caps at 56, zero height.
- The answer mapping already tested (`rankingAnswer`); add `gone` for 403/404 (today they map to network).
- `expo export`.

## Phases

1. **App:** the avatar copies, `Avatar`, `rankingRows`, `rowHeight`, the screen, Home's card, tests.
2. **Docs:** TASKS (tick; notes for T-4xx frames and titles and the medal art), STATE.

## Revision 1 (after CTO plan review 1, 86/100): overrides the sections above where they differ

- **M1, avatars:** `RankRow` and `me` gain `avatar: string`; `isRow` and `meOk` require a string. An avatar the app
  doesn't know shows the letter fallback; a missing or non-string one makes the answer `network`. Tested.
- **M2, the fit:** `rowHeight(available, slots, gap) = min(56, floor((available - gap × (slots - 1)) / slots))`, with no
  lower bound, so `slots × height + gaps ≤ available` always holds. A loop over many heights tests it, plus the cap
  and zero height. "At least 32 on the smallest phone" is a separate fact check, not a clamp.
  The screen's title and back button are capped (`maxFontSizeMultiplier`), as the rows are. The "can't refresh" line
  sits outside the measured list. T-009's on-phone checklist gains "11 rows fit on the smallest phone at the largest
  text size".
- **M3, two meanings of 404:**
  - `rankingAnswer` checks `ranking_off` first; any other 403 or 404 is `gone`, and 500 is `network`. Four tests.
  - Home's card renders nothing on `gone`: Home's own read stays the one place that forgets the event.
- **m1:** `signed_out` replaces to `/home`.
- **m2, the refresh timer:**
  - It runs only while the screen is focused and the app is in front.
  - It is cleared on blur, background and unmount, with one refresh at a time and no state update after leaving.
  - The 15 seconds stands until the live stream (T-5xx) replaces it.
- **m3:** ranks 1 to 3 get a filled `highlight` badge, the others an outlined one. The own row keeps the `highlight`
  border and a "you" label. No new colour roles.
- **m4:** one bilingual label key, "Rank {rank}, @{username}, {score} points" plus "you", with Western grouped digits
  (`formatNumber`). The points wording avoids an Arabic plural form by using «النقاط: {score}».
- **m5:** the cap is recorded as a Proposed decision (ADR-121), and a question is added (Q-104: a detail view for players
  who need very large text).
- **Nits:**
  - The username gets `writingDirection: "ltr"` in its style.
  - Avatars use `resizeMode="contain"` inside the circle, never cropped.
  - `total` stays unused.

## Revision 2 (Dhia, 2026-10-21, during the build): overrides the font-scaling parts above

Dhia decided that the app has one font at one size for every player (ADR-121, Accepted). `AppText` and every text
field set `allowFontScaling={false}`, so nothing grows with the phone's text size, and the per-row cap
(`maxFontSizeMultiplier`), the capped title and Q-104 are no longer needed. The rows still shrink to fit
(`adjustsFontSizeToFit`), for long usernames.
