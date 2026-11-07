-- T-813 part 1, indexes and queries (docs/PERFORMANCE_AUDIT.md, "T-813 results"; ADR-816). Four new indexes, one index
-- rebuilt wider and one function restated with the same arguments, so its grants stay: invitation_claim_at. No new table
-- or function, nothing here writes points differently, and no ledger row changes. Deployed migrations untouched.
--
-- Every index below is a plain CREATE INDEX: the runner holds each file in one transaction, so CONCURRENTLY cannot run
-- (ADR-580). As 0162, every existing table this file indexes is locked up front, in one order. ledger_entry before xp_entry
-- and both before audit_log, the order a completion and a removal write them; invitation_recipient before audit_log, as
-- invitation_ack does. SHARE stops writers for the build and lets reads through; DROP INDEX needs ACCESS EXCLUSIVE, so
-- invitation_recipient takes it from the start and no lock is upgraded mid-file. A clash within 10 seconds of lock waiting
-- rolls the file back and the runner retries it. Measured build on 2,000,000 ledger rows: 1.1 s for the largest.
SET LOCAL lock_timeout = '10s';
LOCK TABLE ledger_entry IN SHARE MODE;
LOCK TABLE xp_entry IN SHARE MODE;
LOCK TABLE invitation_recipient IN ACCESS EXCLUSIVE MODE;
LOCK TABLE audit_log IN SHARE MODE;

-- ================================================================ a removal found by the entry it reverses
-- `ledger_entry_removal_key` is partial on kind, so a read of `x.reverses = l.id` with no kind, and the foreign key's own
-- check, cannot use it: member_ledger, manual_awards, quest_bulk_targets, session_bulk_targets and session_points_held
-- scanned the whole table once per line. `ledger_entry_removal_shape` makes this predicate the same rows as that key's, so a
-- quest entry adds nothing here; only a removal writes it.
CREATE INDEX ledger_entry_reverses_idx ON ledger_entry (reverses) WHERE reverses IS NOT NULL;

-- ================================================================ what a rehearsal wipe's foreign keys look up
-- Deleting a rehearsal's completions and ledger rows checks `ledger_entry.completion_id` and `xp_entry.ledger_entry_id`
-- per row. Both had partial keys only, which those checks cannot use, so each deleted row was a full table scan while
-- wipe_rehearsal held its locks. Each index adds one entry per quest row: ADR-816 records that price and what was left out.
CREATE INDEX ledger_entry_completion_idx ON ledger_entry (completion_id) WHERE completion_id IS NOT NULL;
CREATE INDEX xp_entry_ledger_idx ON xp_entry (ledger_entry_id) WHERE ledger_entry_id IS NOT NULL;

-- ================================================================ a player's own audit rows for their data export
-- data_export_support reads four actions of one player. Only three had an index, each its own, so the read scanned
-- audit_log. These actions are rare, so the rest of the log's writes pay nothing.
CREATE INDEX audit_log_player_export_idx ON audit_log (target_id)
  WHERE target_type = 'player'
    AND action IN ('player.signup', 'player.contact_change', 'player.qr_reset', 'player.data_export');

-- ================================================================ the next invitations to send
-- Wider by `id`, so a campaign's queue reads in order and stops at its limit.
DROP INDEX invitation_recipient_queued;
CREATE INDEX invitation_recipient_queued ON invitation_recipient (campaign_id, id) WHERE state = 'queued';

-- As 0073, with one change: each running campaign gives its first 200 queued rows through the index above, where the read
-- fetched and sorted a campaign's whole queue on every claim, on disk at 100,000 rows. The campaign order, the row order,
-- the limit of 200 and SKIP LOCKED are as they were; a row is now locked as the campaign's page is read, not as the loop
-- reaches it, under the campaign lock invitation_claim_lock already holds.
CREATE OR REPLACE FUNCTION public.invitation_claim_at(allowed text[], size integer, at timestamp with time zone)
 RETURNS TABLE(recipient_id bigint, lease uuid, channel text, language text, phone text, player_id uuid, link uuid, name_ar text, name_en text)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
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
    SELECT q.row_id, q.camp, q.who, q.ch, q.token_link, x.event_id AS ev, x.name_ar AS nar, x.name_en AS nen
    FROM invitation_campaign x
    CROSS JOIN LATERAL (
      SELECT z.id AS row_id, z.campaign_id AS camp, z.player_id AS who, z.channel AS ch, z.link AS token_link
      FROM invitation_recipient z
      WHERE z.campaign_id = x.id AND z.state = 'queued' AND z.channel = ANY (chans)
      ORDER BY z.id
      LIMIT 200
      FOR UPDATE SKIP LOCKED) q
    WHERE x.id = ANY (running)
    ORDER BY x.started_at, x.id, q.row_id
    LIMIT 200
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
