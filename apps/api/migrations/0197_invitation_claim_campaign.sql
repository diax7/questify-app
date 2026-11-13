-- The invitation claim names its campaign (FOLLOWUPS 2026-11-11, followups batch CTO review): `invitation_claim_at` and
-- its door `invitation_claim` (0073, 0173) return each claimed row's `campaign_id` as a last column, so the tick's
-- `invitation.sms_parts_over` warning can say which campaign's text ran long. A campaign id is not personal data.
--
-- A function's result columns cannot change in place, so both are dropped and created again: the body is 0173's word for
-- word with that one column added, and the grants are 0073's (PUBLIC revoked from both, only the door granted to
-- questify_app). The door drops first, as it depends on the inner function; both go in this one transaction, so a claim
-- either runs before it on the old pair or after it on the new pair.
SET LOCAL lock_timeout = '10s';

DROP FUNCTION invitation_claim(text[], integer);
DROP FUNCTION invitation_claim_at(text[], integer, timestamptz);

-- As 0173, with `campaign_id` added.
CREATE FUNCTION invitation_claim_at(allowed text[], size integer, at timestamptz)
  RETURNS TABLE (recipient_id bigint, lease uuid, channel text, language text, phone text, player_id uuid, link uuid,
                 name_ar text, name_en text, campaign_id uuid)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  want      integer := least(greatest(coalesce(size, 0), 0), 5);
  camps     uuid[];
  running   uuid[];
  chans     text[];
  r         record;
  got_phone text;
  got_lang  text;
  token     uuid;
BEGIN
  PERFORM invitation_system_only();
  IF NOT invitation_on() THEN
    RETURN;
  END IF;
  camps := invitation_claim_lock();
  PERFORM invitation_expire_leases(camps, 1000);
  running := invitation_claim_campaigns(camps);
  chans := ARRAY(SELECT DISTINCT a.ch FROM unnest(coalesce(allowed, '{}'::text[])) a (ch)
                 WHERE a.ch = 'sms' AND NOT invitation_sms_quiet(at) AND NOT invitation_sms_quiet(at + interval '60 seconds')
                   AND NOT EXISTS (SELECT 1 FROM invitation_channel_hold h WHERE h.channel = a.ch AND h.hold_until > now()));
  IF want = 0 OR cardinality(chans) = 0 OR cardinality(running) = 0 THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT t.id AS row_id, p.camp, t.player_id AS who, t.channel AS ch, t.link AS token_link, p.ev, p.nar, p.nen
    FROM (
      SELECT q.row_id, x.id AS camp, x.event_id AS ev, x.name_ar AS nar, x.name_en AS nen, x.started_at AS began
      FROM invitation_campaign x
      CROSS JOIN unnest(chans) c (ch)
      CROSS JOIN LATERAL (
        SELECT z.id AS row_id
        FROM invitation_recipient z
        WHERE z.campaign_id >= x.id AND z.campaign_id <= x.id AND z.channel = c.ch AND z.state = 'queued'
        ORDER BY z.campaign_id, z.id
        LIMIT 200) q
      WHERE x.id = ANY (running)
      ORDER BY x.started_at, x.id, q.row_id
      LIMIT 200) p
    JOIN invitation_recipient t ON t.id = p.row_id AND t.state = 'queued'
    ORDER BY p.began, p.camp, p.row_id
    FOR UPDATE OF t SKIP LOCKED
  LOOP
    SELECT p.phone, p.language INTO got_phone, got_lang
    FROM promo_pool(r.ch, NULL, NULL) p WHERE p.player_id = r.who;
    IF NOT FOUND THEN
      PERFORM invitation_skip_row(r.row_id, r.camp, 'opted_out');
    ELSIF EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = r.ev AND n.player_id = r.who) THEN
      PERFORM invitation_skip_row(r.row_id, r.camp, 'member');
    ELSE
      UPDATE invitation_recipient q
      SET state = 'sending', lease_token = gen_random_uuid(), lease_until = now() + interval '60 seconds', sent_at = now()
      WHERE q.id = r.row_id RETURNING q.lease_token INTO token;
      recipient_id := r.row_id;
      lease := token;
      channel := r.ch;
      language := coalesce(got_lang, 'ar');
      phone := got_phone;
      player_id := r.who;
      link := r.token_link;
      name_ar := r.nar;
      name_en := r.nen;
      campaign_id := r.camp;
      RETURN NEXT;
      want := want - 1;
      EXIT WHEN want = 0;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION invitation_claim_at(text[], integer, timestamptz) FROM PUBLIC;

-- The claim door (ADR-333 (1)), as 0073 with `campaign_id` added.
CREATE FUNCTION invitation_claim(allowed text[], size integer)
  RETURNS TABLE (recipient_id bigint, lease uuid, channel text, language text, phone text, player_id uuid, link uuid,
                 name_ar text, name_en text, campaign_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM invitation_claim_at(allowed, size, now())
$$;
REVOKE ALL ON FUNCTION invitation_claim(text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_claim(text[], integer) TO questify_app;
