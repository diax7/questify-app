-- T-813 part 1, the invitation queue (docs/PERFORMANCE_AUDIT.md, "T-813 results"; ADR-816). One index rebuilt wider and
-- one function restated with the same arguments, so its grants stay: invitation_claim_at. Its own file, so the ACCESS
-- EXCLUSIVE lock DROP INDEX needs is held for this rebuild alone (milliseconds at 100,000 queued rows), not for the ledger
-- builds of 0172. Locked up front, invitation_recipient before anything, as invitation_ack does; no lock is upgraded.
SET LOCAL lock_timeout = '10s';
LOCK TABLE invitation_recipient IN ACCESS EXCLUSIVE MODE;

-- ================================================================ the next invitations to send
-- Wider by `channel` and `id`, so a campaign's queue on one channel reads in order, from the index alone, and stops at
-- its limit.
DROP INDEX invitation_recipient_queued;
CREATE INDEX invitation_recipient_queued ON invitation_recipient (campaign_id, channel, id) WHERE state = 'queued';

-- As 0073, with one change: each running campaign gives its first 200 queued rows per channel through the index above,
-- where the read fetched and sorted a campaign's whole queue on every claim, on disk at 100,000 rows. That page is read
-- with no lock; the rows are then locked one by one as the loop fetches them (FOR UPDATE OF t SKIP LOCKED over the page,
-- in the page's order, so no sort sits under the lock), and `t.state = 'queued'` is checked again on the locked row. So a
-- claim of 5 locks about 10 rows, the loop's first fetch, as 0073 did, not the whole page. The campaign order, the row
-- order, the limit of 200 and SKIP LOCKED are as they were, and two claims cannot take one row: both hold the campaign
-- FOR NO KEY UPDATE from invitation_claim_lock first. One difference: a page row another session holds is skipped and
-- not replaced by the 201st, so a page can give fewer than 200 rows; the loop needs 5.
-- The page bounds `campaign_id` by a range, not `=`, and orders by it: with `=` the planner drops that column from the
-- order and may walk the primary key instead, betting the queued rows come early, which reads every finished row in
-- front of them (a first fetch read 14,582 buffers that way on the seeded data, 79 this way, ADR-816).
CREATE OR REPLACE FUNCTION invitation_claim_at(allowed text[], size integer, at timestamptz)
  RETURNS TABLE (recipient_id bigint, lease uuid, channel text, language text, phone text, player_id uuid, link uuid,
                 name_ar text, name_en text)
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
      RETURN NEXT;
      want := want - 1;
      EXIT WHEN want = 0;
    END IF;
  END LOOP;
END $$;
