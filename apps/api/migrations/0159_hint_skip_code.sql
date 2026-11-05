-- T-501g follow-up: a category hint whose category was shown (un-hidden) between the fan-out and the claim is skipped
-- with its own code, `category_shown`, instead of `not_member`. The hint has nothing left to reveal, so the push is
-- dropped and the center row stays; the code only says why. Before this, push_hint_ok (0080) answered false for a shown
-- category, notice_audience_ok passed that on, and push_skip_reason called it `not_member`, which a console reader takes
-- for a player who left.
--
-- As 0114's push_skip_reason plus one line, placed after the membership and visibility checks and before the audience
-- rule, so a player who left, or a hint whose category is gone, keeps the code it had. Same signature, so it is replaced
-- in place; PL/pgSQL, as the request-path rule asks (docs/rules.md).
--
-- Deny by default: revoked from PUBLIC by name next to its replace (outsider suite). Catalog only: no table, trigger,
-- policy or other grant changes.
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION push_skip_reason(send bigint) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  SELECT p.status AS player_status, c.player_id AS recipient, e.status AS event_status, d AS device, k.class,
         k.topic, nt AS note, n AS member
  INTO r
  FROM push_send s
  JOIN notification c ON c.id = s.notification_id
  JOIN notice nt ON nt.id = c.notice_id
  JOIN notice_kind k ON k.kind = nt.kind
  JOIN push_device d ON d.id = s.device_id
  LEFT JOIN player p ON p.id = c.player_id
  LEFT JOIN event e ON e.id = nt.event_id
  LEFT JOIN enrollment n ON n.event_id = nt.event_id AND n.player_id = c.player_id
  WHERE s.id = send;
  RETURN CASE
    WHEN r.player_status IS DISTINCT FROM 'active' THEN 'player'
    WHEN r.event_status = 'archived' THEN 'archived'
    WHEN (r.note).event_id IS NOT NULL AND event_suspended((r.note).event_id) THEN 'suspended'
    WHEN (r.device).player_id <> r.recipient OR NOT push_pushable(r.device) THEN 'device'
    WHEN r.class = 'promo' AND NOT push_consented(r.recipient) THEN 'consent'
    WHEN push_muted(r.recipient, r.topic, (r.note).event_id) THEN 'muted'
    WHEN NOT notice_membership_ok(r.note, r.member) THEN 'not_member'
    WHEN (r.note).event_id IS NOT NULL AND NOT notice_visible(r.note, r.member) THEN 'not_visible'
    WHEN (r.note).kind = 'category_hint'
         AND EXISTS (SELECT 1 FROM category x
                     WHERE x.id = push_ref((r.note).refs, 'category') AND x.event_id = (r.note).event_id
                       AND NOT x.hidden) THEN 'category_shown'
    WHEN NOT notice_audience_ok(r.note, r.member) THEN 'not_member'
  END;
END $$;
REVOKE ALL ON FUNCTION push_skip_reason(bigint) FROM PUBLIC;
