-- T-611 follow-up (Q-363 (a), ADR-396): the big-screen ranking scene follows an event set to places only (FR-1832).
-- 0083 sends each row's `score`. Now the score is left out of every row unless the event's layout says it is shown
-- (`config.layout.looks.ranking.scores`), the same reading the API uses (`readLooks`, `scoresOf`): no stored value is the
-- old behaviour (scores shown); a value that is there and is not "shown" is places only, and so is a `ranking` entry that
-- is not an object. Every other rule of 0083 is unchanged: the event of the calling screen, the shut reasons, the ten best
-- in the board's order, only a username, an avatar and a place. The grants are those of 0083 (closed to PUBLIC, one grant
-- to the API role). 0083 is deployed and untouched; no new function, so nothing new to close.
CREATE OR REPLACE FUNCTION screen_ranking() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev          event := screen_event();
  shut        text := screen_shut(ev);
  looks       jsonb := ev.config #> '{layout,looks,ranking}';
  show_scores boolean;
BEGIN
  IF shut IS NULL AND NOT ranking_on(ev) THEN
    shut := 'ranking_off';
  END IF;
  IF shut IS NOT NULL THEN
    RETURN jsonb_build_object('shut', shut);
  END IF;
  show_scores := looks IS NULL
    OR (jsonb_typeof(looks) = 'object' AND ((looks -> 'scores') IS NULL OR looks -> 'scores' = '"shown"'::jsonb));
  RETURN jsonb_build_object('shut', NULL, 'rows', coalesce((
    SELECT jsonb_agg(
      CASE WHEN show_scores
           THEN jsonb_build_object('place', u.place, 'username', p.username, 'avatar', p.avatar, 'score', e.score)
           ELSE jsonb_build_object('place', u.place, 'username', p.username, 'avatar', p.avatar) END
      ORDER BY u.place)
    FROM unnest(rank_top_ten_ids(ev.id)) WITH ORDINALITY AS u(enrollment_id, place)
    JOIN enrollment e ON e.id = u.enrollment_id
    JOIN player p ON p.id = e.player_id), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION screen_ranking() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION screen_ranking() TO questify_app;
