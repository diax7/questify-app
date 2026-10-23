-- Catch and tap rush (T-305c, ADR-216 to ADR-218; plan docs/plans/2026-10-24-t-305c-catch-tap-rush.md). The last two
-- of FR-1804's games run on T-305's rounds unchanged: this migration only widens the game lists and adds the six
-- levels. No new table, function, grant or reason; nothing new to deny.

-- ================================================================ the type (FR-1804)
-- A game quest's config (ADR-213), now with all four games. The rest is 0050's rule unchanged.
ALTER TABLE quest DROP CONSTRAINT quest_game_shape;
ALTER TABLE quest ADD CONSTRAINT quest_game_shape CHECK (
  CASE WHEN type <> 'game' THEN true
       WHEN NOT (jsonb_typeof(type_config) = 'object'
                 AND coalesce(type_config ->> 'game', '') IN ('memory_match', 'slide_puzzle', 'catch', 'tap_rush')
                 AND coalesce(type_config ->> 'level', '') IN ('easy', 'medium', 'hard')) THEN false
       WHEN jsonb_typeof(type_config -> 'attempts') = 'null'
         THEN jsonb_typeof(type_config -> 'cooldownMinutes') = 'number'
              AND (type_config ->> 'cooldownMinutes') ~ '^[0-9]{1,4}$'
              AND (type_config ->> 'cooldownMinutes')::integer BETWEEN 1 AND 1440
       WHEN jsonb_typeof(type_config -> 'attempts') = 'number' AND (type_config ->> 'attempts') ~ '^[0-9]{1,2}$'
         THEN (type_config ->> 'attempts')::integer BETWEEN 1 AND 10
              AND coalesce(jsonb_typeof(type_config -> 'cooldownMinutes'), 'null') = 'null'
       ELSE false END);

ALTER TABLE game_round DROP CONSTRAINT game_round_game_check;
ALTER TABLE game_round ADD CONSTRAINT game_round_game_check
  CHECK (game IN ('memory_match', 'slide_puzzle', 'catch', 'tap_rush'));

-- ================================================================ the levels (ADR-215, ADR-218, Q-182)
-- The same table as packages/shared/src/games/levels.ts (a database test keeps them equal). No caller chooses the
-- numbers a round is played with.
CREATE OR REPLACE FUNCTION game_level(game text, level text) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE game || ':' || level
    WHEN 'memory_match:easy' THEN
      '{"pairs": 6, "columns": 3, "rows": 4, "timeLimitSeconds": 120, "maxMoves": null, "unlikelyLucky": 3}'::jsonb
    WHEN 'memory_match:medium' THEN
      '{"pairs": 8, "columns": 4, "rows": 4, "timeLimitSeconds": 120, "maxMoves": 20, "unlikelyLucky": 4}'::jsonb
    WHEN 'memory_match:hard' THEN
      '{"pairs": 10, "columns": 4, "rows": 5, "timeLimitSeconds": 120, "maxMoves": 22, "unlikelyLucky": 4}'::jsonb
    WHEN 'slide_puzzle:easy' THEN '{"size": 3, "walk": 20, "timeLimitSeconds": 180}'::jsonb
    WHEN 'slide_puzzle:medium' THEN '{"size": 3, "walk": 60, "timeLimitSeconds": 180}'::jsonb
    WHEN 'slide_puzzle:hard' THEN '{"size": 4, "walk": 120, "timeLimitSeconds": 300}'::jsonb
    WHEN 'catch:easy' THEN
      '{"timeLimitSeconds": 45, "items": 30, "fallTicks": 60, "gapMin": 30, "gapMax": 42, "basketHalf": 100,
        "basketSpeed": 40, "catchTarget": 20, "unlikelyForesight": 10}'::jsonb
    WHEN 'catch:medium' THEN
      '{"timeLimitSeconds": 45, "items": 40, "fallTicks": 48, "gapMin": 22, "gapMax": 32, "basketHalf": 80,
        "basketSpeed": 40, "catchTarget": 30, "unlikelyForesight": 12}'::jsonb
    WHEN 'catch:hard' THEN
      '{"timeLimitSeconds": 45, "items": 50, "fallTicks": 36, "gapMin": 18, "gapMax": 25, "basketHalf": 65,
        "basketSpeed": 45, "catchTarget": 40, "unlikelyForesight": 16}'::jsonb
    WHEN 'tap_rush:easy' THEN
      '{"timeLimitSeconds": 30, "columns": 3, "rows": 4, "lifeTicks": 45, "gapMin": 18, "gapMax": 24,
        "scoreTarget": 20, "unlikelyQuick": 8}'::jsonb
    WHEN 'tap_rush:medium' THEN
      '{"timeLimitSeconds": 30, "columns": 3, "rows": 4, "lifeTicks": 33, "gapMin": 14, "gapMax": 19,
        "scoreTarget": 28, "unlikelyQuick": 8}'::jsonb
    WHEN 'tap_rush:hard' THEN
      '{"timeLimitSeconds": 30, "columns": 3, "rows": 4, "lifeTicks": 24, "gapMin": 11, "gapMax": 15,
        "scoreTarget": 34, "unlikelyQuick": 8}'::jsonb
  END
$$;
REVOKE ALL ON FUNCTION game_level(text, text) FROM PUBLIC;
