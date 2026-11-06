-- T-404c part 1 of 2: the platform settings side of "levels only" (ADR-760, ADR-762; plan
-- docs/plans/2026-11-06-t-404c-levels-only.md 4.1). The `gems` amounts go and the `xp` setting gains three optional
-- achievement tier amounts. platform_setting alone, in its own transaction: a sync locks player_xp and then reads
-- platform_setting while a scan reads platform_setting before it locks player_xp, so a migration holding both strongly
-- would deadlock with one of them (ADR-291). Until 0164 runs, the old sync falls back to its built-in gem amounts.
-- No new table or function. Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';
-- ADD CONSTRAINT takes ACCESS EXCLUSIVE; taken first so the lock is never upgraded mid-way.
LOCK TABLE platform_setting IN ACCESS EXCLUSIVE MODE;

DELETE FROM platform_setting WHERE key = 'gems';
ALTER TABLE platform_setting DROP CONSTRAINT platform_setting_gems_check;

-- As 0122, plus `bronzeXp`, `silverXp` and `goldXp`: each absent or a whole number 0 to 1000 (ADR-764).
ALTER TABLE platform_setting DROP CONSTRAINT platform_setting_xp_daily_check;
ALTER TABLE platform_setting ADD CONSTRAINT platform_setting_xp_daily_check CHECK (
  key <> 'xp' OR ((CASE WHEN jsonb_typeof(value -> 'questXp') = 'number' AND (value ->> 'questXp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'questXp')::integer BETWEEN 1 AND 99999 ELSE false END)
    AND (NOT value ? 'dailyFinishXp' OR (CASE WHEN jsonb_typeof(value -> 'dailyFinishXp') = 'number' AND (value ->> 'dailyFinishXp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'dailyFinishXp')::integer BETWEEN 0 AND 400 ELSE false END))
    AND (NOT value ? 'dailyRightXp' OR (CASE WHEN jsonb_typeof(value -> 'dailyRightXp') = 'number' AND (value ->> 'dailyRightXp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'dailyRightXp')::integer BETWEEN 0 AND 200 ELSE false END))
    AND (NOT value ? 'dailyWordXp' OR (CASE WHEN jsonb_typeof(value -> 'dailyWordXp') = 'number' AND (value ->> 'dailyWordXp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'dailyWordXp')::integer BETWEEN 0 AND 1000 ELSE false END))
    AND (NOT value ? 'bronzeXp' OR (CASE WHEN jsonb_typeof(value -> 'bronzeXp') = 'number' AND (value ->> 'bronzeXp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'bronzeXp')::integer BETWEEN 0 AND 1000 ELSE false END))
    AND (NOT value ? 'silverXp' OR (CASE WHEN jsonb_typeof(value -> 'silverXp') = 'number' AND (value ->> 'silverXp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'silverXp')::integer BETWEEN 0 AND 1000 ELSE false END))
    AND (NOT value ? 'goldXp' OR (CASE WHEN jsonb_typeof(value -> 'goldXp') = 'number' AND (value ->> 'goldXp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'goldXp')::integer BETWEEN 0 AND 1000 ELSE false END)))) NOT VALID;
ALTER TABLE platform_setting VALIDATE CONSTRAINT platform_setting_xp_daily_check;
