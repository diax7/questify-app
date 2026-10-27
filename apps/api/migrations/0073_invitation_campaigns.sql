-- T-409: Questify invitations (FR-738 to FR-740; ADR-329 to ADR-333; plan docs/plans/2026-10-27-t-409-questify-invitations.md).
-- The owner requests a campaign for one public event; a Questify admin approves it with a message cap and a send time,
-- which freezes the event's names; the in-process tick fills it from players who opted in to promotional SMS (promo_pool,
-- the one consent rule), claims rounds of at most 5 under a lease, and acknowledges each message once; settle counts
-- joins, publishes rounded counts once a Questify day, ends every campaign and purges recipient rows after 90 days.
-- Deny by default: the three new tables keep row-level security forced and no grant; every function is closed to PUBLIC
-- in the statement group that creates it and only the doors are granted to the API role. Deployed migrations and 0057 to
-- 0072 untouched; set_marketing gains a defaulted fourth argument, marketing_audience is restated system-only over
-- promo_pool, and erase_rows is restated (0070's body plus the recipient rows).
SET LOCAL lock_timeout = '10s';
-- Every existing table this migration alters or references, up front, at the strongest mode a later statement needs: the
-- consent tables gain a column; event, city and staff_user are foreign-key targets. Never player, ledger_entry,
-- enrollment (read only), xp_entry or platform_setting: nothing here sits in a payer's or a sign-in's path.
LOCK TABLE marketing_consent IN ACCESS EXCLUSIVE MODE;
LOCK TABLE marketing_state IN ACCESS EXCLUSIVE MODE;
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE city IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE staff_user IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the consent's language (ADR-331 (6))
-- The language of the player's latest consent row on a channel is the language of a promotion on it; NULL (rows from
-- before 0073, or a 3-argument call during the deploy) is read as Arabic.
ALTER TABLE marketing_consent ADD COLUMN language text CHECK (language IN ('ar', 'en'));
ALTER TABLE marketing_state ADD COLUMN language text CHECK (language IN ('ar', 'en'));

CREATE OR REPLACE FUNCTION marketing_state_apply() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO marketing_state (player_id, channel, opted_in, changed_at, language)
  VALUES (NEW.player_id, NEW.channel, NEW.granted, NEW.created_at, NEW.language)
  ON CONFLICT (player_id, channel) DO UPDATE
    SET opted_in = EXCLUDED.opted_in, changed_at = EXCLUDED.changed_at, language = EXCLUDED.language;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION marketing_state_apply() FROM PUBLIC;

-- 0070's body, and `lang` (ar or en, MK422 `language` otherwise) recorded on every row it writes. Defaulted, so the
-- running API's 3-argument call keeps working while 0073 deploys (RUNBOOK).
DROP FUNCTION set_marketing(jsonb, text, text);
CREATE FUNCTION set_marketing(channels jsonb, how text, version text, lang text DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who   uuid := marketing_player();
  ch    text;
  val   jsonb;
  want  boolean;
  cur   boolean;
  adult boolean := marketing_adult((SELECT p.birth_year FROM player p WHERE p.id = who));
BEGIN
  IF how IS NULL OR how NOT IN ('signup', 'settings') THEN
    RAISE EXCEPTION 'unknown method' USING ERRCODE = 'MK422', DETAIL = 'method';
  END IF;
  IF version IS NULL OR version !~ '^[0-9]+(\.[0-9]+){0,2}$' THEN
    RAISE EXCEPTION 'unknown text version' USING ERRCODE = 'MK422', DETAIL = 'textVersion';
  END IF;
  IF lang IS NOT NULL AND lang NOT IN ('ar', 'en') THEN
    RAISE EXCEPTION 'a language is ar or en' USING ERRCODE = 'MK422', DETAIL = 'language';
  END IF;
  IF channels IS NULL OR jsonb_typeof(channels) <> 'object' OR channels = '{}'::jsonb THEN
    RAISE EXCEPTION 'name at least one channel' USING ERRCODE = 'MK422', DETAIL = 'channels';
  END IF;
  FOR ch, val IN SELECT e.key, e.value FROM jsonb_each(channels) e LOOP
    IF ch NOT IN ('push', 'sms', 'email') OR jsonb_typeof(val) <> 'boolean' THEN
      RAISE EXCEPTION 'a channel is push, sms or email, set to true or false' USING ERRCODE = 'MK422', DETAIL = 'channels';
    END IF;
  END LOOP;
  FOR ch, val IN SELECT e.key, e.value FROM jsonb_each(channels) e ORDER BY e.key LOOP
    want := val::text::boolean;
    SELECT s.opted_in INTO cur FROM marketing_state s WHERE s.player_id = who AND s.channel = ch;
    IF want AND NOT adult AND cur IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'marketing needs a player of full legal capacity' USING ERRCODE = 'MK403', DETAIL = 'age';
    END IF;
    IF cur IS NULL OR cur <> want THEN
      INSERT INTO marketing_consent (player_id, channel, granted, method, text_version, language)
      VALUES (who, ch, want, how, CASE WHEN want THEN version END, lang);
    END IF;
  END LOOP;
  RETURN own_marketing();
END $$;
REVOKE ALL ON FUNCTION set_marketing(jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_marketing(jsonb, text, text, text) TO questify_app;

-- ================================================================ the one consent rule (ADR-331 (7), amends ADR-318 (1))
-- 0070's age rule, the same body without the SET clause (it reads no table), so the planner inlines it into promo_pool
-- instead of calling it, with a search_path switch, once per player of a 100,000-player fill.
CREATE OR REPLACE FUNCTION marketing_adult(born smallint) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT born IS NOT NULL AND extract(year FROM now() AT TIME ZONE 'Asia/Riyadh')::integer - born >= 19
$$;
REVOKE ALL ON FUNCTION marketing_adult(smallint) FROM PUBLIC;

-- The players a promotion on channel `ch` may reach now: active, of full legal capacity (marketing_adult), opted in on
-- `ch`, with a phone for SMS; optionally in a city and holding any of the interests. Their phone and consent language
-- come with them. Plain SQL, not a definer, no SET clause, so the planner can inline it; tables schema-qualified; no
-- grant: only definers (the audience, the fill and the claim's re-check) read through it.
CREATE FUNCTION promo_pool(ch text, in_city text, any_of text[])
  RETURNS TABLE (player_id uuid, phone text, language text)
  LANGUAGE sql STABLE AS $$
  SELECT s.player_id, c.phone_e164, s.language
  FROM public.marketing_state s
  JOIN public.player p ON p.id = s.player_id AND p.status = 'active' AND public.marketing_adult(p.birth_year)
  LEFT JOIN public.player_contact c ON c.player_id = s.player_id
  LEFT JOIN public.player_preference f ON f.player_id = s.player_id
  WHERE s.channel = ch AND s.opted_in
    AND (ch <> 'sms' OR c.phone_e164 IS NOT NULL)
    AND (in_city IS NULL OR f.city_id = in_city)
    AND (any_of IS NULL OR cardinality(any_of) = 0 OR f.interests && any_of)
$$;
REVOKE ALL ON FUNCTION promo_pool(text, text, text[]) FROM PUBLIC;

-- 0070's audience door, restated over promo_pool and allowed only in the system context (a promotional sender's own
-- connection, no player, staff, admin or device): MK403 `system_only` otherwise.
CREATE OR REPLACE FUNCTION marketing_audience(ch text, in_city text, any_of text[], after_player uuid, page integer)
  RETURNS TABLE (player_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF NOT ranking_system() OR app_device_id() IS NOT NULL THEN
    RAISE EXCEPTION 'the promotional audience is read in the system context only'
      USING ERRCODE = 'MK403', DETAIL = 'system_only';
  END IF;
  RETURN QUERY
    SELECT p.player_id FROM promo_pool(ch, in_city, any_of) p
    WHERE after_player IS NULL OR p.player_id > after_player
    ORDER BY p.player_id
    LIMIT least(greatest(coalesce(page, 100), 1), 1000);
END $$;
REVOKE ALL ON FUNCTION marketing_audience(text, text, text[], uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marketing_audience(text, text, text[], uuid, integer) TO questify_app;

-- ================================================================ the tables
-- One campaign per request (request_id and fingerprint: the souvenir_command precedent). The names are copied at
-- approval and every message is rendered from the copy (Finding 1 (a)). Counters only grow; organizers read only the
-- published_* copies, rounded in SQL (invitation_bucket).
CREATE TABLE invitation_campaign (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id     uuid NOT NULL,
  event_id         uuid NOT NULL,
  request_id       uuid NOT NULL UNIQUE,
  fingerprint      text NOT NULL,
  requested_by     uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  city_id          text REFERENCES city (id),
  interests        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(interests) <= 3),
  history          text NOT NULL DEFAULT 'none' CHECK (history IN ('none', 'recent', 'own')),
  size             integer NOT NULL CHECK (size BETWEEN 50 AND 100000),
  send_after       timestamptz,
  state            text NOT NULL DEFAULT 'requested'
                   CHECK (state IN ('requested', 'approved', 'sending', 'sent', 'cancelled', 'refused')),
  -- T-501 widens this to push.
  channels         text[] CHECK (cardinality(channels) >= 1 AND channels <@ ARRAY['sms']),
  cap              integer CHECK (cap BETWEEN 50 AND 100000),
  send_at          timestamptz,
  name_ar          text,
  name_en          text,
  admin_note       text CHECK (char_length(admin_note) BETWEEN 1 AND 500),
  decided_by       uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  decided_at       timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  final_at         timestamptz,
  end_reason       text CHECK (end_reason IN ('owner', 'admin', 'too_small', 'event_changed', 'event_over')),
  planned          integer NOT NULL DEFAULT 0 CHECK (planned >= 0),
  sent             integer NOT NULL DEFAULT 0 CHECK (sent >= 0),
  unknown          integer NOT NULL DEFAULT 0 CHECK (unknown >= 0),
  failed           integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  skipped          integer NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  cancelled        integer NOT NULL DEFAULT 0 CHECK (cancelled >= 0),
  opened           integer NOT NULL DEFAULT 0 CHECK (opened >= 0),
  joined           integer NOT NULL DEFAULT 0 CHECK (joined >= 0),
  published_sent   integer CHECK (published_sent >= 0),
  published_opened integer CHECK (published_opened >= 0),
  published_joined integer CHECK (published_joined >= 0),
  published_at     timestamptz,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  CONSTRAINT invitation_campaign_approved_shape CHECK (state NOT IN ('approved', 'sending', 'sent')
    OR (channels IS NOT NULL AND cap IS NOT NULL AND send_at IS NOT NULL AND (name_ar IS NOT NULL OR name_en IS NOT NULL))),
  CONSTRAINT invitation_campaign_refused_shape CHECK (state <> 'refused' OR admin_note IS NOT NULL),
  CONSTRAINT invitation_campaign_end_shape CHECK (CASE state
    WHEN 'cancelled' THEN end_reason IS NOT NULL
    WHEN 'sent' THEN end_reason IS NULL OR end_reason = 'event_over'
    ELSE end_reason IS NULL END),
  CONSTRAINT invitation_campaign_finished_shape CHECK (state NOT IN ('cancelled', 'sent') OR finished_at IS NOT NULL)
);
CREATE UNIQUE INDEX invitation_campaign_open ON invitation_campaign (event_id)
  WHERE state IN ('requested', 'approved', 'sending');
CREATE INDEX invitation_campaign_due ON invitation_campaign (state, send_at);
ALTER TABLE invitation_campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_campaign FORCE ROW LEVEL SECURITY;
REVOKE ALL ON invitation_campaign FROM PUBLIC, questify_app;

-- One row per chosen player: personal data (who was invited), never shown to an organizer, deleted 90 days after its
-- campaign finished and at once by erasure. `link` is the bearer token in the message's fragment. Contact and text are
-- never stored: the claim reads the phone and language fresh through promo_pool.
--
-- No foreign keys: their per-row checks took most of a 100,000-row fill's time (ADR-334 (3)), and the player's
-- would take FOR KEY SHARE on every player a fill picks, which no invitation door may do (docs/rules.md). Rows are
-- written only by the fill, under its campaign's lock, for players read through promo_pool; players are never deleted
-- (erasure tombstones them and deletes their rows here); a deleted campaign takes its rows with it (the trigger below).
CREATE TABLE invitation_recipient (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link        uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  player_id   uuid NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('push', 'sms', 'email')),
  state       text NOT NULL DEFAULT 'queued'
              CHECK (state IN ('queued', 'sending', 'sent', 'unknown', 'failed', 'skipped', 'cancelled')),
  lease_token uuid,
  lease_until timestamptz,
  -- A provider's code only (a number, `M0037`, `timeout`): never contact or text.
  error_code  text CHECK (error_code ~ '^[A-Za-z0-9_]{1,40}$'),
  skip_reason text CHECK (skip_reason IN ('opted_out', 'member', 'event_over', 'event_changed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  opened_at   timestamptz,
  joined_at   timestamptz,
  UNIQUE (campaign_id, player_id),
  CHECK ((state = 'sending') = (lease_token IS NOT NULL)),
  CHECK ((state = 'sending') = (lease_until IS NOT NULL)),
  CHECK ((state = 'skipped') = (skip_reason IS NOT NULL)),
  CHECK (state NOT IN ('sending', 'sent', 'unknown') OR sent_at IS NOT NULL)
);
CREATE INDEX invitation_recipient_queued ON invitation_recipient (campaign_id) WHERE state = 'queued';
-- The foreign key's ON DELETE CASCADE, by hand: a campaign goes only with its event (an admin deleting an event).
CREATE FUNCTION invitation_campaign_gone() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM invitation_recipient q WHERE q.campaign_id = OLD.id;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION invitation_campaign_gone() FROM PUBLIC;
CREATE TRIGGER invitation_campaign_gone AFTER DELETE ON invitation_campaign
  FOR EACH ROW EXECUTE FUNCTION invitation_campaign_gone();
CREATE INDEX invitation_recipient_leased ON invitation_recipient (lease_until) WHERE state = 'sending';
CREATE INDEX invitation_recipient_player ON invitation_recipient (player_id, sent_at);
ALTER TABLE invitation_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_recipient FORCE ROW LEVEL SECURITY;
REVOKE ALL ON invitation_recipient FROM PUBLIC, questify_app;

-- An account refusal (balance, sender, address, unreachable) pauses a whole channel for 15 minutes (ADR-333 (3)).
CREATE TABLE invitation_channel_hold (
  channel    text PRIMARY KEY CHECK (channel IN ('push', 'sms', 'email')),
  hold_until timestamptz NOT NULL,
  code       text NOT NULL CHECK (code ~ '^[A-Za-z0-9_]{1,40}$')
);
ALTER TABLE invitation_channel_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_channel_hold FORCE ROW LEVEL SECURITY;
REVOKE ALL ON invitation_channel_hold FROM PUBLIC, questify_app;

-- ================================================================ helpers (internal: no grant)
-- The platform switch `features.invitationCampaigns.enabled`, OFF when absent (ADR-330 (7)).
CREATE FUNCTION invitation_on() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT s.value -> 'invitationCampaigns' -> 'enabled' = 'true'::jsonb
                   FROM platform_setting s WHERE s.key = 'features'), false)
$$;
REVOKE ALL ON FUNCTION invitation_on() FROM PUBLIC;

-- The sender's seat: no player, staff, organizer, admin or device identity, under READ COMMITTED (each statement reads
-- what committed before it, which the lease and the counters rely on). IV403 `system_only` otherwise.
CREATE FUNCTION invitation_system_only() RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT ranking_system() OR app_device_id() IS NOT NULL
     OR current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'invitations are sent in the system context only' USING ERRCODE = 'IV403', DETAIL = 'system_only';
  END IF;
END $$;
REVOKE ALL ON FUNCTION invitation_system_only() FROM PUBLIC;

-- Why an event cannot take an invitation, or NULL (ADR-330 (2)): public only, scheduled or live, joinable by link, not
-- guest-list-only, no email-domain lock, and (unless `from_claim`) ending at least 24 hours from now. The request and
-- the approval apply the 24-hour rule; the start and every claim do not (the approval already bounds the send time to an
-- hour before the end). Names are the name rule's (TypeScript), not this function's.
CREATE FUNCTION invitation_event_ok(ev event, from_claim boolean) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN ev.id IS NULL OR ev.access <> 'public' THEN 'not_public'
    WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live') THEN 'not_running'
    WHEN NOT from_claim AND ev.ends_at < now() + interval '24 hours' THEN 'ends_soon'
    WHEN NOT ('link' = ANY (ev.join_methods)) THEN 'link_off'
    WHEN ev.guest_list_only THEN 'guest_list_only'
    WHEN cardinality(ev.email_domains) > 0 THEN 'email_domains'
  END
$$;
REVOKE ALL ON FUNCTION invitation_event_ok(event, boolean) FROM PUBLIC;

-- An organizer's view of a count (ADR-332 (4)): NULL before the first publish, `fewerThan 10` below 10, otherwise
-- rounded down to a multiple of 10. The only way a count reaches an organizer.
CREATE FUNCTION invitation_bucket(n integer) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN n IS NULL THEN NULL
              WHEN n < 10 THEN jsonb_build_object('fewerThan', 10)
              ELSE jsonb_build_object('atLeast', (n / 10) * 10) END
$$;
REVOKE ALL ON FUNCTION invitation_bucket(integer) FROM PUBLIC;

-- The fixed quiet band for promotional SMS (FR-1738): 22:00 to 08:59 Riyadh time. TypeScript adds Ramadan's band.
CREATE FUNCTION invitation_sms_quiet(at timestamptz) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT extract(hour FROM at AT TIME ZONE 'Asia/Riyadh') >= 22
      OR extract(hour FROM at AT TIME ZONE 'Asia/Riyadh') < 9
$$;
REVOKE ALL ON FUNCTION invitation_sms_quiet(timestamptz) FROM PUBLIC;

-- One audit row about a campaign: its state, criteria, cap and send time, never a count (ADR-332 (4)). `actor` is
-- staff, admin or system.
CREATE FUNCTION invitation_audit(c invitation_campaign, actor text, action text, request uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES (actor, CASE WHEN actor <> 'system' THEN app_staff_user_id() END, c.organizer_id, c.event_id, action,
          'invitation_campaign', c.id::text,
          jsonb_build_object('state', c.state, 'endReason', c.end_reason, 'cityId', c.city_id,
                             'interests', to_jsonb(c.interests), 'history', c.history, 'size', c.size,
                             'sendAfter', c.send_after, 'channels', to_jsonb(c.channels), 'cap', c.cap,
                             'sendAt', c.send_at),
          request)
$$;
REVOKE ALL ON FUNCTION invitation_audit(invitation_campaign, text, text, uuid) FROM PUBLIC;

-- A campaign as its organizer reads it: criteria, state and the rounded published counts; nothing exact.
CREATE FUNCTION invitation_org_json(c invitation_campaign) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'state', c.state, 'endReason', c.end_reason, 'cityId', c.city_id,
    'interests', to_jsonb(c.interests), 'history', c.history, 'size', c.size, 'sendAfter', c.send_after,
    'cap', c.cap, 'sendAt', c.send_at, 'note', c.admin_note, 'requestedAt', c.requested_at,
    'decidedAt', c.decided_at, 'startedAt', c.started_at, 'finishedAt', c.finished_at, 'publishedAt', c.published_at,
    'counts', jsonb_build_object('sent', invitation_bucket(c.published_sent),
                                 'opened', invitation_bucket(c.published_opened),
                                 'joined', invitation_bucket(c.published_joined)))
$$;
REVOKE ALL ON FUNCTION invitation_org_json(invitation_campaign) FROM PUBLIC;

-- A campaign as the console reads it: the organizer's view plus exact counts, the channels and the frozen names.
CREATE FUNCTION invitation_admin_json(c invitation_campaign) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'state', c.state, 'endReason', c.end_reason,
    'organizer', jsonb_build_object('id', o.id, 'name', o.name),
    'event', jsonb_build_object('id', e.id, 'joinCode', e.join_code,
                                'name', jsonb_build_object('ar', e.name_ar, 'en', e.name_en)),
    'cityId', c.city_id, 'interests', to_jsonb(c.interests), 'history', c.history, 'size', c.size,
    'sendAfter', c.send_after, 'channels', to_jsonb(c.channels), 'cap', c.cap, 'sendAt', c.send_at,
    'note', c.admin_note, 'approvedNames', jsonb_build_object('ar', c.name_ar, 'en', c.name_en),
    'requestedAt', c.requested_at, 'decidedAt', c.decided_at, 'startedAt', c.started_at,
    'finishedAt', c.finished_at, 'finalAt', c.final_at, 'publishedAt', c.published_at,
    'counts', jsonb_build_object('planned', c.planned, 'sent', c.sent, 'unknown', c.unknown, 'failed', c.failed,
                                 'skipped', c.skipped, 'cancelled', c.cancelled, 'opened', c.opened,
                                 'joined', c.joined))
  FROM event e JOIN organizer o ON o.id = e.organizer_id
  WHERE e.id = c.event_id
$$;
REVOKE ALL ON FUNCTION invitation_admin_json(invitation_campaign) FROM PUBLIC;

-- The players a campaign may invite, with their fixed draw (the fill orders by it; the console's estimate counts them):
-- through promo_pool on SMS with the campaign's city and interests, its history rule, never anyone with an enrollment in
-- the event (any status), never anyone this event already invited, and at most one invitation per player per 7 days (a
-- queued or sending row always counts, a sent or unknown one while its sent_at is under 7 days old). Like promo_pool,
-- plain SQL with no SET clause and schema-qualified tables, so its callers (definers) inline it rather than collect
-- 100,000 rows in a tuplestore first.
CREATE FUNCTION invitation_candidates(target uuid) RETURNS TABLE (player_id uuid, draw text)
  LANGUAGE sql STABLE AS $$
  SELECT p.player_id, md5(c.id::text || p.player_id::text)
  FROM public.invitation_campaign c
  CROSS JOIN LATERAL public.promo_pool('sms', c.city_id, c.interests) p
  WHERE c.id = target
    AND (c.history = 'none'
         OR (c.history = 'recent' AND EXISTS (
               SELECT 1 FROM public.enrollment n
               WHERE n.player_id = p.player_id AND n.status NOT IN ('pending', 'declined')
                 AND n.joined_via IS DISTINCT FROM 'rehearsal' AND n.joined_at >= now() - interval '365 days'))
         OR (c.history = 'own' AND EXISTS (
               SELECT 1 FROM public.enrollment n
               WHERE n.player_id = p.player_id AND n.organizer_id = c.organizer_id AND n.event_id <> c.event_id
                 AND n.status NOT IN ('pending', 'declined') AND n.joined_via IS DISTINCT FROM 'rehearsal')))
    AND NOT EXISTS (SELECT 1 FROM public.enrollment n WHERE n.event_id = c.event_id AND n.player_id = p.player_id)
    AND NOT EXISTS (SELECT 1 FROM public.invitation_recipient r JOIN public.invitation_campaign o ON o.id = r.campaign_id
                    WHERE r.player_id = p.player_id AND o.event_id = c.event_id
                      AND r.state IN ('queued', 'sending', 'sent', 'unknown'))
    AND NOT EXISTS (SELECT 1 FROM public.invitation_recipient r
                    WHERE r.player_id = p.player_id
                      AND (r.state IN ('queued', 'sending')
                           OR (r.state IN ('sent', 'unknown') AND r.sent_at > now() - interval '7 days')))
$$;
REVOKE ALL ON FUNCTION invitation_candidates(uuid) FROM PUBLIC;

-- Lease expiry (ADR-333 (2)): rows of the given campaigns (already locked by the caller in id order) whose lease ran out
-- become `unknown` with the lease token cleared, so a late acknowledgement changes nothing and the message is never sent
-- again. At most `lim` rows, SKIP LOCKED.
CREATE FUNCTION invitation_expire_leases(camps uuid[], lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH stale AS (
    SELECT q.id FROM invitation_recipient q
    WHERE q.campaign_id = ANY (camps) AND q.state = 'sending' AND q.lease_until < now()
    ORDER BY q.lease_until LIMIT lim FOR UPDATE SKIP LOCKED),
  moved AS (
    UPDATE invitation_recipient q SET state = 'unknown', lease_token = NULL, lease_until = NULL
    FROM stale s WHERE q.id = s.id RETURNING q.campaign_id),
  counted AS (
    UPDATE invitation_campaign c SET unknown = c.unknown + m.n
    FROM (SELECT moved.campaign_id, count(*)::integer AS n FROM moved GROUP BY 1) m
    WHERE c.id = m.campaign_id RETURNING m.n)
  SELECT coalesce(sum(counted.n), 0)::integer FROM counted
$$;
REVOKE ALL ON FUNCTION invitation_expire_leases(uuid[], integer) FROM PUBLIC;

-- Skips the queued rows of the given campaigns (already locked by the caller) for a reason that holds for the whole
-- campaign (`event_over`, `event_changed`); at most `lim`, SKIP LOCKED. The count goes to `skipped`.
CREATE FUNCTION invitation_skip_queued(camps uuid[], why text, lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT q.id FROM invitation_recipient q
    WHERE q.campaign_id = ANY (camps) AND q.state = 'queued'
    LIMIT lim FOR UPDATE SKIP LOCKED),
  moved AS (
    UPDATE invitation_recipient q SET state = 'skipped', skip_reason = why
    FROM due d WHERE q.id = d.id RETURNING q.campaign_id),
  counted AS (
    UPDATE invitation_campaign c SET skipped = c.skipped + m.n
    FROM (SELECT moved.campaign_id, count(*)::integer AS n FROM moved GROUP BY 1) m
    WHERE c.id = m.campaign_id RETURNING m.n)
  SELECT coalesce(sum(counted.n), 0)::integer FROM counted
$$;
REVOKE ALL ON FUNCTION invitation_skip_queued(uuid[], text, integer) FROM PUBLIC;

-- ================================================================ the owner's doors (ADR-330 (1))
-- The event of the caller's organizer, inside the caller's event scope, for an active owner or editor; IV404 otherwise
-- (another tenant's event, an event outside a limited editor's scope and a missing one look the same).
CREATE FUNCTION invitation_team_event(target uuid) RETURNS event
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev event;
BEGIN
  IF app_player_id() IS NOT NULL OR app_device_id() IS NOT NULL OR app_is_admin() OR NOT EXISTS (
       SELECT 1 FROM organizer_member m JOIN staff_user s ON s.id = m.staff_user_id
       WHERE m.organizer_id = app_organizer_id() AND m.staff_user_id = app_staff_user_id()
         AND m.role IN ('owner', 'editor') AND s.status = 'active') THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'IV404';
  END IF;
  SELECT e.* INTO ev FROM event e
  WHERE e.id = target AND e.organizer_id = app_organizer_id() AND in_event_scope(e.id, app_event_scope());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'IV404';
  END IF;
  RETURN ev;
END $$;
REVOKE ALL ON FUNCTION invitation_team_event(uuid) FROM PUBLIC;

-- A request body's criteria, checked (IV422 with the field in DETAIL) and returned as a campaign row with its
-- fingerprint: the API's schema checks the same body first.
CREATE FUNCTION invitation_criteria(body jsonb) RETURNS invitation_campaign
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  made invitation_campaign;
BEGIN
  IF body IS NULL OR jsonb_typeof(body) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(body) k WHERE k NOT IN ('cityId', 'interests', 'history', 'size', 'sendAfter')) THEN
    RAISE EXCEPTION 'unknown request field' USING ERRCODE = 'IV422', DETAIL = 'body';
  END IF;
  made.city_id := CASE jsonb_typeof(body -> 'cityId') WHEN 'string' THEN body ->> 'cityId' END;
  IF coalesce(jsonb_typeof(body -> 'cityId'), 'null') NOT IN ('null', 'string')
     OR (made.city_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM city c WHERE c.id = made.city_id)) THEN
    RAISE EXCEPTION 'unknown city' USING ERRCODE = 'IV422', DETAIL = 'cityId';
  END IF;
  IF coalesce(jsonb_typeof(body -> 'interests'), 'null') = 'null' THEN
    made.interests := '{}';
  ELSIF jsonb_typeof(body -> 'interests') = 'array' AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(body -> 'interests') x WHERE jsonb_typeof(x) <> 'string') THEN
    made.interests := interests_clean(ARRAY(SELECT jsonb_array_elements_text(body -> 'interests')), 3);
  END IF;
  IF made.interests IS NULL THEN
    RAISE EXCEPTION 'interests are catalog ids, no repeats, at most 3' USING ERRCODE = 'IV422', DETAIL = 'interests';
  END IF;
  made.history := coalesce(body ->> 'history', 'none');
  IF coalesce(jsonb_typeof(body -> 'history'), 'null') NOT IN ('null', 'string')
     OR made.history NOT IN ('none', 'recent', 'own') THEN
    RAISE EXCEPTION 'history is none, recent or own' USING ERRCODE = 'IV422', DETAIL = 'history';
  END IF;
  IF jsonb_typeof(body -> 'size') IS DISTINCT FROM 'number' OR (body ->> 'size') !~ '^[0-9]{1,6}$'
     OR (body ->> 'size')::integer NOT BETWEEN 50 AND 100000 THEN
    RAISE EXCEPTION 'a size is a whole number from 50 to 100000' USING ERRCODE = 'IV422', DETAIL = 'size';
  END IF;
  made.size := (body ->> 'size')::integer;
  IF coalesce(jsonb_typeof(body -> 'sendAfter'), 'null') NOT IN ('null', 'string') THEN
    RAISE EXCEPTION 'sendAfter is a time' USING ERRCODE = 'IV422', DETAIL = 'sendAfter';
  END IF;
  BEGIN
    made.send_after := (body ->> 'sendAfter')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN
    RAISE EXCEPTION 'sendAfter is a time' USING ERRCODE = 'IV422', DETAIL = 'sendAfter';
  END;
  made.fingerprint := md5(concat_ws('|', coalesce(made.city_id, '-'), array_to_string(made.interests, ','),
                                    made.history, made.size, coalesce(extract(epoch FROM made.send_after)::text, '-')));
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION invitation_criteria(jsonb) FROM PUBLIC;

-- The owner's request (FR-738): the platform switch on (IV403 `feature_off`), the event eligible (IV409
-- `event_not_eligible`, the reason in HINT), one open campaign per event (IV409 `invitation_open`), the criteria (IV422).
-- A replay of the same request key answers the first campaign; the key with another body or event is IV409
-- `idempotency_mismatch`. Editors are refused (IV403 `owner_only`). The API checks the event's names first.
CREATE FUNCTION invitation_request(target uuid, body jsonb, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := invitation_team_event(target);
  wanted  invitation_campaign;
  made    invitation_campaign;
  why     text;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'only the owner requests invitations' USING ERRCODE = 'IV403', DETAIL = 'owner_only';
  END IF;
  IF request IS NULL THEN
    RAISE EXCEPTION 'a request key is required' USING ERRCODE = 'IV422', DETAIL = 'request';
  END IF;
  wanted := invitation_criteria(body);
  PERFORM pg_advisory_xact_lock(hashtextextended('invitation-request:' || request::text, 0));
  SELECT * INTO made FROM invitation_campaign c WHERE c.request_id = request;
  IF FOUND THEN
    IF (made.event_id, made.requested_by, made.fingerprint)
       IS DISTINCT FROM (ev.id, app_staff_user_id(), wanted.fingerprint) THEN
      RAISE EXCEPTION 'this request key was used for another request'
        USING ERRCODE = 'IV409', DETAIL = 'idempotency_mismatch';
    END IF;
    RETURN invitation_org_json(made);
  END IF;
  IF NOT invitation_on() THEN
    RAISE EXCEPTION 'invitations are switched off' USING ERRCODE = 'IV403', DETAIL = 'feature_off';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = ev.id FOR SHARE;
  why := invitation_event_ok(ev, false);
  IF why IS NOT NULL THEN
    RAISE EXCEPTION 'this event cannot take an invitation'
      USING ERRCODE = 'IV409', DETAIL = 'event_not_eligible', HINT = why;
  END IF;
  IF wanted.send_after IS NOT NULL AND wanted.send_after >= ev.ends_at THEN
    RAISE EXCEPTION 'the earliest send is before the event ends' USING ERRCODE = 'IV422', DETAIL = 'sendAfter';
  END IF;
  INSERT INTO invitation_campaign AS c (organizer_id, event_id, request_id, fingerprint, requested_by, city_id,
                                        interests, history, size, send_after)
  VALUES (ev.organizer_id, ev.id, request, wanted.fingerprint, app_staff_user_id(), wanted.city_id, wanted.interests,
          wanted.history, wanted.size, wanted.send_after)
  ON CONFLICT DO NOTHING
  RETURNING c.* INTO made;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this event already has an open invitation' USING ERRCODE = 'IV409', DETAIL = 'invitation_open';
  END IF;
  PERFORM invitation_audit(made, 'staff', 'invitation.request', request);
  RETURN invitation_org_json(made);
END $$;
REVOKE ALL ON FUNCTION invitation_request(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_request(uuid, jsonb, uuid) TO questify_app;

-- The owner withdraws a campaign that has not started: requested or approved, else IV409 `wrong_state`. Nothing was
-- sent, so it is final at once (Finding 2).
CREATE FUNCTION invitation_cancel(target uuid, campaign uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := invitation_team_event(target);
  c  invitation_campaign;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'only the owner cancels invitations' USING ERRCODE = 'IV403', DETAIL = 'owner_only';
  END IF;
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = campaign AND x.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'IV404';
  END IF;
  IF c.state NOT IN ('requested', 'approved') THEN
    RAISE EXCEPTION 'only a campaign that has not started can be withdrawn' USING ERRCODE = 'IV409', DETAIL = 'wrong_state';
  END IF;
  UPDATE invitation_campaign x
  SET state = 'cancelled', end_reason = 'owner', finished_at = now(), final_at = now()
  WHERE x.id = c.id RETURNING x.* INTO c;
  PERFORM invitation_audit(c, 'staff', 'invitation.cancel', request);
  RETURN invitation_org_json(c);
END $$;
REVOKE ALL ON FUNCTION invitation_cancel(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_cancel(uuid, uuid, uuid) TO questify_app;

-- The event's campaigns for its owners and editors in scope, newest first (at most 50), and whether requests are open.
-- Counts are the published, rounded ones only (FR-739).
CREATE FUNCTION invitation_list(target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := invitation_team_event(target);
BEGIN
  RETURN jsonb_build_object(
    'enabled', invitation_on(),
    'campaigns', coalesce((
      SELECT jsonb_agg(invitation_org_json(c) ORDER BY c.requested_at DESC, c.id DESC)
      FROM invitation_campaign c
      WHERE c.id IN (SELECT x.id FROM invitation_campaign x WHERE x.event_id = ev.id
                     ORDER BY x.requested_at DESC, x.id DESC LIMIT 50)), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION invitation_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_list(uuid) TO questify_app;

-- ================================================================ the console's doors (ADR-329 (1))
-- Each re-reads the admin from the account (questify_admin: QY403 for anyone else); IV404 a missing campaign.
CREATE FUNCTION invitation_admin_queue() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM questify_admin();
  RETURN jsonb_build_object('campaigns', coalesce((
    SELECT jsonb_agg(invitation_admin_json(c)
                     ORDER BY (c.state IN ('requested', 'approved', 'sending')) DESC,
                              CASE WHEN c.state IN ('requested', 'approved', 'sending') THEN c.requested_at END,
                              coalesce(c.finished_at, c.decided_at, c.requested_at) DESC, c.id)
    FROM invitation_campaign c
    WHERE c.state IN ('requested', 'approved', 'sending')
       OR c.id IN (SELECT x.id FROM invitation_campaign x WHERE x.state IN ('sent', 'cancelled', 'refused')
                   ORDER BY coalesce(x.finished_at, x.decided_at, x.requested_at) DESC, x.id DESC LIMIT 100)),
    '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION invitation_admin_queue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_admin_queue() TO questify_app;

-- One campaign for the console: exact counts, why the event cannot take it now (the 24-hour rule only while it waits
-- for approval), the event's current names (the API renders the messages and the name rule's verdicts from them), the
-- audience estimate while it has not started, the queued count and an open channel hold.
CREATE FUNCTION invitation_admin_get(campaign uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c  invitation_campaign;
  ev event;
BEGIN
  PERFORM questify_admin();
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = campaign;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'IV404';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = c.event_id;
  RETURN jsonb_build_object(
    'campaign', invitation_admin_json(c),
    'eventIssue', invitation_event_ok(ev, c.state <> 'requested'),
    'eventEndsAt', ev.ends_at,
    'names', jsonb_build_object('ar', ev.name_ar, 'en', ev.name_en),
    'estimate', CASE WHEN c.state IN ('requested', 'approved')
                     THEN (SELECT count(*) FROM invitation_candidates(c.id)) END,
    'queued', (SELECT count(*) FROM invitation_recipient q WHERE q.campaign_id = c.id AND q.state = 'queued'),
    'hold', (SELECT jsonb_build_object('channel', h.channel, 'holdUntil', h.hold_until, 'code', h.code)
             FROM invitation_channel_hold h WHERE h.hold_until > now() ORDER BY h.channel LIMIT 1));
END $$;
REVOKE ALL ON FUNCTION invitation_admin_get(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_admin_get(uuid) TO questify_app;

-- Approves a requested campaign (Finding 1 (a)): the event FOR SHARE, then the campaign. The names the console showed
-- must still be the event's (IV409 `event_renamed`); they are copied onto the campaign and every message is rendered
-- from that copy. The event must still qualify (IV422 `event_not_eligible`, the reason in HINT); channels {sms} in v1,
-- the cap 50 to 100,000, the send time from a minute ago to an hour before the event ends, a note of at most 500
-- characters (IV422 with the field). The API has moved the send time out of quiet hours and run the name rule.
CREATE FUNCTION invitation_approve(campaign uuid, chans text[], new_cap integer, at timestamptz, note text,
                                   expected_ar text, expected_en text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin uuid := questify_admin();
  c     invitation_campaign;
  ev    event;
  why   text;
BEGIN
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = campaign;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'IV404';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = c.event_id FOR SHARE;
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = campaign FOR UPDATE;
  IF c.state <> 'requested' THEN
    RAISE EXCEPTION 'only a requested campaign can be approved' USING ERRCODE = 'IV409', DETAIL = 'wrong_state';
  END IF;
  why := invitation_event_ok(ev, false);
  IF why IS NOT NULL THEN
    RAISE EXCEPTION 'this event cannot take an invitation'
      USING ERRCODE = 'IV422', DETAIL = 'event_not_eligible', HINT = why;
  END IF;
  IF expected_ar IS DISTINCT FROM ev.name_ar OR expected_en IS DISTINCT FROM ev.name_en THEN
    RAISE EXCEPTION 'the event was renamed since the console read it' USING ERRCODE = 'IV409', DETAIL = 'event_renamed';
  END IF;
  IF nullif(btrim(ev.name_ar), '') IS NULL AND nullif(btrim(ev.name_en), '') IS NULL THEN
    RAISE EXCEPTION 'the event has no name to send' USING ERRCODE = 'IV422', DETAIL = 'name';
  END IF;
  IF chans IS NULL OR cardinality(chans) = 0 OR NOT chans <@ ARRAY['sms'] THEN
    RAISE EXCEPTION 'channels are sms in v1' USING ERRCODE = 'IV422', DETAIL = 'channels';
  END IF;
  IF new_cap IS NULL OR new_cap NOT BETWEEN 50 AND 100000 THEN
    RAISE EXCEPTION 'a cap is 50 to 100000' USING ERRCODE = 'IV422', DETAIL = 'cap';
  END IF;
  IF at IS NULL OR at < now() - interval '1 minute' OR at > ev.ends_at - interval '1 hour' THEN
    RAISE EXCEPTION 'the send time is from now to an hour before the event ends' USING ERRCODE = 'IV422', DETAIL = 'sendAt';
  END IF;
  IF note IS NOT NULL AND char_length(btrim(note)) > 500 THEN
    RAISE EXCEPTION 'a note is at most 500 characters' USING ERRCODE = 'IV422', DETAIL = 'note';
  END IF;
  UPDATE invitation_campaign x
  SET state = 'approved', channels = ARRAY(SELECT DISTINCT unnest(chans) ORDER BY 1), cap = new_cap, send_at = at,
      admin_note = nullif(btrim(note), ''), name_ar = nullif(btrim(ev.name_ar), ''),
      name_en = nullif(btrim(ev.name_en), ''), decided_by = admin, decided_at = now()
  WHERE x.id = c.id RETURNING x.* INTO c;
  PERFORM invitation_audit(c, 'admin', 'invitation.approve', request);
  RETURN invitation_admin_json(c);
END $$;
REVOKE ALL ON FUNCTION invitation_approve(uuid, text[], integer, timestamptz, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_approve(uuid, text[], integer, timestamptz, text, text, text, uuid) TO questify_app;

-- A note the owner reads: 1 to 500 characters (IV422 `note`).
CREATE FUNCTION invitation_note(note text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF note IS NULL OR char_length(btrim(note)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a note of 1 to 500 characters is required' USING ERRCODE = 'IV422', DETAIL = 'note';
  END IF;
  RETURN btrim(note);
END $$;
REVOKE ALL ON FUNCTION invitation_note(text) FROM PUBLIC;

-- Refuses a requested campaign with a note (IV409 `wrong_state` otherwise). Nothing was sent.
CREATE FUNCTION invitation_refuse(campaign uuid, note text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin uuid := questify_admin();
  said  text := invitation_note(note);
  c     invitation_campaign;
BEGIN
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = campaign FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'IV404';
  END IF;
  IF c.state <> 'requested' THEN
    RAISE EXCEPTION 'only a requested campaign can be refused' USING ERRCODE = 'IV409', DETAIL = 'wrong_state';
  END IF;
  UPDATE invitation_campaign x SET state = 'refused', admin_note = said, decided_by = admin, decided_at = now()
  WHERE x.id = c.id RETURNING x.* INTO c;
  PERFORM invitation_audit(c, 'admin', 'invitation.refuse', request);
  RETURN invitation_admin_json(c);
END $$;
REVOKE ALL ON FUNCTION invitation_refuse(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_refuse(uuid, text, uuid) TO questify_app;

-- An admin stops a campaign that is requested, approved or sending, with a note (Finding 2): `finished_at` now; one
-- that never started is final at once; a sending one's queued rows become `cancelled` (rows already handed to the
-- sender finish by their acknowledgement or lease expiry, and settle closes the results later).
CREATE FUNCTION invitation_admin_cancel(campaign uuid, note text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin   uuid := questify_admin();
  said    text := invitation_note(note);
  c       invitation_campaign;
  dropped integer := 0;
BEGIN
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = campaign FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'IV404';
  END IF;
  IF c.state NOT IN ('requested', 'approved', 'sending') THEN
    RAISE EXCEPTION 'this campaign has ended already' USING ERRCODE = 'IV409', DETAIL = 'wrong_state';
  END IF;
  IF c.state = 'sending' THEN
    WITH moved AS (
      UPDATE invitation_recipient q SET state = 'cancelled'
      WHERE q.campaign_id = c.id AND q.state = 'queued' RETURNING 1)
    SELECT count(*) INTO dropped FROM moved;
  END IF;
  UPDATE invitation_campaign x
  SET state = 'cancelled', end_reason = 'admin', admin_note = said, finished_at = now(),
      final_at = CASE WHEN x.started_at IS NULL THEN now() END, cancelled = x.cancelled + dropped
  WHERE x.id = c.id RETURNING x.* INTO c;
  PERFORM invitation_audit(c, 'admin', 'invitation.cancel', request);
  RETURN invitation_admin_json(c);
END $$;
REVOKE ALL ON FUNCTION invitation_admin_cancel(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_admin_cancel(uuid, text, uuid) TO questify_app;

-- ================================================================ the sender (ADR-333; system context only)
-- Starts the oldest due approved campaign (one a call). Another server holding the fill lock skips this tick. The event
-- FOR SHARE, then the campaign; an event that is over or no longer qualifies (without the 24-hour rule) cancels it, and
-- so does a fill under 50 players (`too_small`); otherwise it is `sending` with its planned count. Only the copied names
-- are ever used, so a rename after approval never cancels a campaign. Outcomes: off, busy, idle, started, event_over,
-- event_changed, too_small.
CREATE FUNCTION invitation_start_due() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET work_mem = '64MB' AS $$
DECLARE
  c   invitation_campaign;
  ev  event;
  n   integer := 0;
  why text;
BEGIN
  PERFORM invitation_system_only();
  IF NOT invitation_on() THEN
    RETURN 'off';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('invitation_fill')) THEN
    RETURN 'busy';
  END IF;
  SELECT x.* INTO c FROM invitation_campaign x
  WHERE x.state = 'approved' AND x.send_at <= now() ORDER BY x.send_at, x.id LIMIT 1;
  IF NOT FOUND THEN
    RETURN 'idle';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = c.event_id FOR SHARE;
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = c.id FOR UPDATE;
  IF c.state <> 'approved' THEN
    RETURN 'idle';
  END IF;
  why := CASE WHEN ev.ends_at <= now() THEN 'event_over'
              WHEN invitation_event_ok(ev, true) IS NOT NULL THEN 'event_changed' END;
  IF why IS NULL THEN
    INSERT INTO invitation_recipient (campaign_id, player_id, channel)
    SELECT c.id, k.player_id, c.channels[1] FROM invitation_candidates(c.id) k ORDER BY k.draw LIMIT c.cap;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n < 50 THEN
      DELETE FROM invitation_recipient q WHERE q.campaign_id = c.id;
      why := 'too_small';
    END IF;
  END IF;
  IF why IS NOT NULL THEN
    UPDATE invitation_campaign x
    SET state = 'cancelled', end_reason = why, finished_at = now(), final_at = now()
    WHERE x.id = c.id RETURNING x.* INTO c;
    PERFORM invitation_audit(c, 'system', 'invitation.end', NULL);
    RETURN why;
  END IF;
  UPDATE invitation_campaign x SET state = 'sending', planned = n, started_at = now()
  WHERE x.id = c.id RETURNING x.* INTO c;
  PERFORM invitation_audit(c, 'system', 'invitation.start', NULL);
  RETURN 'started';
END $$;
REVOKE ALL ON FUNCTION invitation_start_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_start_due() TO questify_app;

-- The claim's locks: every sending campaign and every campaign with an expired lease, FOR NO KEY UPDATE in id order,
-- in one statement before any row (docs/rules.md, the invitation sender's lock order).
CREATE FUNCTION invitation_claim_lock() RETURNS uuid[]
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(l.id ORDER BY l.id), '{}'::uuid[])
  FROM (SELECT c.id FROM invitation_campaign c
        WHERE c.state = 'sending'
           OR c.id IN (SELECT q.campaign_id FROM invitation_recipient q
                       WHERE q.state = 'sending' AND q.lease_until < now())
        ORDER BY c.id FOR NO KEY UPDATE) l
$$;
REVOKE ALL ON FUNCTION invitation_claim_lock() FROM PUBLIC;

-- Of the locked campaigns, the sending ones whose event is still running and still qualifies. The queued rows of the
-- others are skipped (`event_over`, `event_changed`: made unlisted or private, guest-list-only, a domain lock, link
-- joining off), 1000 a call.
CREATE FUNCTION invitation_claim_campaigns(camps uuid[]) RETURNS uuid[]
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  over    uuid[];
  changed uuid[];
BEGIN
  SELECT coalesce(array_agg(x.id) FILTER (WHERE e.ends_at <= now()), '{}'::uuid[]),
         coalesce(array_agg(x.id) FILTER (WHERE e.ends_at > now() AND invitation_event_ok(e, true) IS NOT NULL),
                  '{}'::uuid[])
  INTO over, changed
  FROM invitation_campaign x JOIN event e ON e.id = x.event_id
  WHERE x.id = ANY (camps) AND x.state = 'sending';
  PERFORM invitation_skip_queued(over, 'event_over', 1000);
  PERFORM invitation_skip_queued(changed, 'event_changed', 1000);
  RETURN ARRAY(SELECT x.id FROM invitation_campaign x
               WHERE x.id = ANY (camps) AND x.state = 'sending' AND NOT (x.id = ANY (over || changed)));
END $$;
REVOKE ALL ON FUNCTION invitation_claim_campaigns(uuid[]) FROM PUBLIC;

-- One queued row skipped for a reason of its own (`opted_out`, `member`); its campaign is locked by the claim.
CREATE FUNCTION invitation_skip_row(target bigint, campaign uuid, why text) RETURNS void
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  UPDATE invitation_recipient q SET state = 'skipped', skip_reason = why WHERE q.id = target;
  UPDATE invitation_campaign c SET skipped = c.skipped + 1 WHERE c.id = campaign;
$$;
REVOKE ALL ON FUNCTION invitation_skip_row(bigint, uuid, text) FROM PUBLIC;

-- The claim at a given moment (the door passes now(); tests pass a fixed one). SMS is dropped while the Riyadh hour of
-- `at` or `at` + 60 s is in 22:00 to 08:59, whatever the API passed, and while a hold is open. Lease expiry first. Each
-- queued row is checked again: consent through promo_pool (`opted_out`), no enrollment in the event (`member`); a row
-- that passes is leased for 60 s with a fresh token and `sent_at` now. At most `size` (5 at most), the contact and the
-- consent language read fresh, the names from the campaign's copy.
CREATE FUNCTION invitation_claim_at(allowed text[], size integer, at timestamptz)
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
    SELECT q.id AS row_id, q.campaign_id AS camp, q.player_id AS who, q.channel AS ch, q.link AS token_link,
           x.event_id AS ev, x.name_ar AS nar, x.name_en AS nen
    FROM invitation_recipient q JOIN invitation_campaign x ON x.id = q.campaign_id
    WHERE q.campaign_id = ANY (running) AND q.state = 'queued' AND q.channel = ANY (chans)
    ORDER BY x.started_at, x.id, q.id
    LIMIT 200
    FOR UPDATE OF q SKIP LOCKED
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
REVOKE ALL ON FUNCTION invitation_claim_at(text[], integer, timestamptz) FROM PUBLIC;

-- The claim door (ADR-333 (1)): `allowed` are the channels the API may send now, `size` the round (at most 5).
CREATE FUNCTION invitation_claim(allowed text[], size integer)
  RETURNS TABLE (recipient_id bigint, lease uuid, channel text, language text, phone text, player_id uuid, link uuid,
                 name_ar text, name_en text)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM invitation_claim_at(allowed, size, now())
$$;
REVOKE ALL ON FUNCTION invitation_claim(text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_claim(text[], integer) TO questify_app;

-- What became of one claimed message, recorded only while the row is still `sending` with this lease (a late answer after
-- expiry changes nothing). `sent`, `unknown` and `failed` move the row and its counter. `hold` (a refusal for the
-- account) writes one hold for the channel (15 minutes) and puts the row back to `queued` with no attempt counted, only
-- while its campaign is still sending; otherwise the row is `cancelled` (Finding 2). Answers recorded, held or stale.
CREATE FUNCTION invitation_ack(recipient bigint, lease uuid, outcome text, code text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  clean text := CASE WHEN code ~ '^[A-Za-z0-9_]{1,40}$' THEN code END;
  camp  uuid;
  c     invitation_campaign;
  r     invitation_recipient;
BEGIN
  PERFORM invitation_system_only();
  IF outcome IS NULL OR outcome NOT IN ('sent', 'unknown', 'failed', 'hold') THEN
    RAISE EXCEPTION 'an outcome is sent, unknown, failed or hold' USING ERRCODE = 'IV422', DETAIL = 'outcome';
  END IF;
  SELECT q.campaign_id INTO camp FROM invitation_recipient q WHERE q.id = recipient;
  IF camp IS NULL THEN
    RETURN 'stale';
  END IF;
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = camp FOR NO KEY UPDATE;
  SELECT * INTO r FROM invitation_recipient q
  WHERE q.id = recipient AND q.state = 'sending' AND q.lease_token = lease FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'stale';
  END IF;
  IF outcome <> 'hold' THEN
    UPDATE invitation_recipient q
    SET state = outcome, lease_token = NULL, lease_until = NULL, error_code = CASE WHEN outcome <> 'sent' THEN clean END
    WHERE q.id = r.id;
    UPDATE invitation_campaign x
    SET sent = x.sent + (outcome = 'sent')::integer, unknown = x.unknown + (outcome = 'unknown')::integer,
        failed = x.failed + (outcome = 'failed')::integer
    WHERE x.id = c.id;
    RETURN 'recorded';
  END IF;
  IF c.state = 'sending' THEN
    UPDATE invitation_recipient q SET state = 'queued', lease_token = NULL, lease_until = NULL, sent_at = NULL
    WHERE q.id = r.id;
  ELSE
    UPDATE invitation_recipient q SET state = 'cancelled', lease_token = NULL, lease_until = NULL, error_code = clean
    WHERE q.id = r.id;
    UPDATE invitation_campaign x SET cancelled = x.cancelled + 1 WHERE x.id = c.id;
  END IF;
  INSERT INTO invitation_channel_hold AS h (channel, hold_until, code)
  VALUES (r.channel, now() + interval '15 minutes', coalesce(clean, 'unknown'))
  ON CONFLICT (channel) DO UPDATE SET hold_until = greatest(h.hold_until, EXCLUDED.hold_until), code = EXCLUDED.code;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after)
  VALUES ('system', 'invitation.hold', 'invitation_channel', r.channel,
          jsonb_build_object('channel', r.channel, 'code', coalesce(clean, 'unknown')));
  RETURN 'held';
END $$;
REVOKE ALL ON FUNCTION invitation_ack(bigint, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_ack(bigint, uuid, text, text) TO questify_app;

-- Settle's locks: every campaign settle may change (approved, sending, and ended ones whose results are still open) and
-- any with an expired lease, FOR UPDATE in id order, in one statement before any row.
CREATE FUNCTION invitation_settle_lock() RETURNS uuid[]
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(l.id ORDER BY l.id), '{}'::uuid[])
  FROM (SELECT c.id FROM invitation_campaign c
        WHERE c.state IN ('approved', 'sending')
           OR (c.state IN ('sent', 'cancelled') AND c.started_at IS NOT NULL AND c.final_at IS NULL)
           OR c.id IN (SELECT q.campaign_id FROM invitation_recipient q
                       WHERE q.state = 'sending' AND q.lease_until < now())
        ORDER BY c.id FOR UPDATE) l
$$;
REVOKE ALL ON FUNCTION invitation_settle_lock() FROM PUBLIC;

-- An approved campaign whose event ended before it started: cancelled `event_over`, final at once (Finding 2).
CREATE FUNCTION invitation_settle_unstarted(camps uuid[]) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  c invitation_campaign;
  n integer := 0;
BEGIN
  FOR c IN
    UPDATE invitation_campaign x
    SET state = 'cancelled', end_reason = 'event_over', finished_at = now(), final_at = now()
    FROM event e
    WHERE x.id = ANY (camps) AND x.state = 'approved' AND e.id = x.event_id AND e.ends_at <= now()
    RETURNING x.*
  LOOP
    PERFORM invitation_audit(c, 'system', 'invitation.end', NULL);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION invitation_settle_unstarted(uuid[]) FROM PUBLIC;

-- Joined (ADR-332 (3)): a recipient that was handed to the provider (sent or unknown) and holds an enrollment in the
-- event that is not pending or declined, joined at or after its sent_at, within the results window (the event's end or
-- 30 days after the campaign finished, whichever is first). Each counted once; at most `lim` a call. No enrollment is
-- locked or marked.
CREATE FUNCTION invitation_settle_joined(camps uuid[], lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH hit AS (
    SELECT q.id, n.joined_at FROM invitation_recipient q
    JOIN invitation_campaign c ON c.id = q.campaign_id
    JOIN event e ON e.id = c.event_id
    JOIN enrollment n ON n.event_id = c.event_id AND n.player_id = q.player_id
    WHERE c.id = ANY (camps) AND c.started_at IS NOT NULL AND c.final_at IS NULL
      AND q.state IN ('sent', 'unknown') AND q.joined_at IS NULL
      AND n.status NOT IN ('pending', 'declined') AND n.joined_via IS DISTINCT FROM 'rehearsal'
      AND n.joined_at >= q.sent_at
      AND n.joined_at <= least(e.ends_at, coalesce(c.finished_at, now()) + interval '30 days')
    LIMIT lim FOR UPDATE OF q SKIP LOCKED),
  moved AS (
    UPDATE invitation_recipient q SET joined_at = h.joined_at FROM hit h WHERE q.id = h.id RETURNING q.campaign_id),
  counted AS (
    UPDATE invitation_campaign c SET joined = c.joined + m.n
    FROM (SELECT moved.campaign_id, count(*)::integer AS n FROM moved GROUP BY 1) m
    WHERE c.id = m.campaign_id RETURNING m.n)
  SELECT coalesce(sum(counted.n), 0)::integer FROM counted
$$;
REVOKE ALL ON FUNCTION invitation_settle_joined(uuid[], integer) FROM PUBLIC;

-- A sending campaign with no queued or sending row left is `sent`; `event_over` when the event ended with rows still
-- queued (they were skipped as `event_over`, Finding 2). When its event is over its results are final at once, with the
-- final counts published.
CREATE FUNCTION invitation_settle_finish(camps uuid[]) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  c invitation_campaign;
  n integer := 0;
BEGIN
  FOR c IN
    UPDATE invitation_campaign x
    SET state = 'sent', finished_at = now(),
        end_reason = CASE WHEN EXISTS (SELECT 1 FROM invitation_recipient q
                                       WHERE q.campaign_id = x.id AND q.skip_reason = 'event_over')
                          THEN 'event_over' END,
        final_at = CASE WHEN e.ends_at <= now() THEN now() END,
        published_sent = CASE WHEN e.ends_at <= now() THEN x.sent + x.unknown ELSE x.published_sent END,
        published_opened = CASE WHEN e.ends_at <= now() THEN x.opened ELSE x.published_opened END,
        published_joined = CASE WHEN e.ends_at <= now() THEN x.joined ELSE x.published_joined END,
        published_at = CASE WHEN e.ends_at <= now() THEN now() ELSE x.published_at END
    FROM event e
    WHERE x.id = ANY (camps) AND x.state = 'sending' AND e.id = x.event_id
      AND NOT EXISTS (SELECT 1 FROM invitation_recipient q
                      WHERE q.campaign_id = x.id AND q.state IN ('queued', 'sending'))
    RETURNING x.*
  LOOP
    PERFORM invitation_audit(c, 'system', 'invitation.finish', NULL);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION invitation_settle_finish(uuid[]) FROM PUBLIC;

-- An ended campaign's results close (final) once the window passed (the event's end or 30 days after it finished,
-- whichever is first) and no message is still out; the final counts are published.
CREATE FUNCTION invitation_settle_final(camps uuid[]) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  c invitation_campaign;
  n integer := 0;
BEGIN
  FOR c IN
    UPDATE invitation_campaign x
    SET final_at = now(), published_sent = x.sent + x.unknown, published_opened = x.opened,
        published_joined = x.joined, published_at = now()
    FROM event e
    WHERE x.id = ANY (camps) AND x.state IN ('sent', 'cancelled') AND x.started_at IS NOT NULL
      AND x.final_at IS NULL AND e.id = x.event_id
      AND now() >= least(e.ends_at, x.finished_at + interval '30 days')
      AND NOT EXISTS (SELECT 1 FROM invitation_recipient q WHERE q.campaign_id = x.id AND q.state = 'sending')
    RETURNING x.*
  LOOP
    PERFORM invitation_audit(c, 'system', 'invitation.final', NULL);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION invitation_settle_final(uuid[]) FROM PUBLIC;

-- The organizer's numbers, refreshed on the first settle of each Questify day (04:00 Riyadh) after the start day.
CREATE FUNCTION invitation_settle_publish(camps uuid[]) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH done AS (
    UPDATE invitation_campaign x
    SET published_sent = x.sent + x.unknown, published_opened = x.opened, published_joined = x.joined,
        published_at = now()
    WHERE x.id = ANY (camps) AND x.started_at IS NOT NULL AND x.final_at IS NULL
      AND questify_day(coalesce(x.published_at, x.started_at)) < questify_day(now())
    RETURNING 1)
  SELECT count(*)::integer FROM done
$$;
REVOKE ALL ON FUNCTION invitation_settle_publish(uuid[]) FROM PUBLIC;

-- Retention (ADR-332 (5)): every recipient row of a final campaign that finished over 90 days ago, whatever its state;
-- at most `lim` a call. The counters stay on the campaign.
CREATE FUNCTION invitation_purge(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH old AS (
    SELECT q.id FROM invitation_recipient q JOIN invitation_campaign c ON c.id = q.campaign_id
    WHERE c.final_at IS NOT NULL AND c.finished_at < now() - interval '90 days'
    LIMIT lim FOR UPDATE OF q SKIP LOCKED),
  gone AS (DELETE FROM invitation_recipient q USING old o WHERE q.id = o.id RETURNING 1)
  SELECT count(*)::integer FROM gone
$$;
REVOKE ALL ON FUNCTION invitation_purge(integer) FROM PUBLIC;

-- Settle (every 10 minutes, with the switch on or off): lease expiry, the event-over rules, the joined pass, finish,
-- final, the daily publish and the purge, each bounded; `more` when a bound was reached, so the tick calls again.
CREATE FUNCTION invitation_settle() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  camps       uuid[];
  n_expired   integer;
  n_cancelled integer;
  n_skipped   integer;
  n_joined    integer;
  n_finished  integer;
  n_final     integer;
  n_published integer;
  n_purged    integer;
BEGIN
  PERFORM invitation_system_only();
  camps := invitation_settle_lock();
  n_expired := invitation_expire_leases(camps, 1000);
  n_cancelled := invitation_settle_unstarted(camps);
  n_skipped := invitation_skip_queued(
    ARRAY(SELECT x.id FROM invitation_campaign x JOIN event e ON e.id = x.event_id
          WHERE x.id = ANY (camps) AND x.state = 'sending' AND e.ends_at <= now()), 'event_over', 5000);
  n_joined := invitation_settle_joined(camps, 5000);
  n_finished := invitation_settle_finish(camps);
  n_final := invitation_settle_final(camps);
  n_published := invitation_settle_publish(camps);
  n_purged := invitation_purge(5000);
  RETURN jsonb_build_object(
    'expired', n_expired, 'cancelled', n_cancelled, 'skipped', n_skipped, 'joined', n_joined,
    'finished', n_finished, 'final', n_final, 'published', n_published, 'purged', n_purged,
    'more', n_expired >= 1000 OR n_skipped >= 5000 OR n_joined >= 5000 OR n_purged >= 5000);
END $$;
REVOKE ALL ON FUNCTION invitation_settle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_settle() TO questify_app;

-- The landing page's door (ADR-332 (2)): the token from the link's fragment. The first open of a message that was
-- handed to the provider sets opened_at and counts once, while the results are open. Answers the public event card, or
-- NULL for an unknown or purged link and an event that is over. Never anything about the player.
CREATE FUNCTION invitation_open(target uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  camp uuid;
  c    invitation_campaign;
  ev   event;
  r    invitation_recipient;
BEGIN
  SELECT q.campaign_id INTO camp FROM invitation_recipient q WHERE q.link = target;
  IF camp IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = camp FOR NO KEY UPDATE;
  SELECT * INTO ev FROM event e WHERE e.id = c.event_id;
  IF ev.ends_at <= now() THEN
    RETURN NULL;
  END IF;
  SELECT * INTO r FROM invitation_recipient q WHERE q.link = target FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF r.opened_at IS NULL AND r.state IN ('sending', 'sent', 'unknown') AND c.final_at IS NULL THEN
    UPDATE invitation_recipient q SET opened_at = now() WHERE q.id = r.id;
    UPDATE invitation_campaign x SET opened = x.opened + 1 WHERE x.id = c.id;
  END IF;
  RETURN (SELECT jsonb_build_object(
            'id', p.id, 'joinCode', p.join_code, 'name', jsonb_build_object('ar', p.name_ar, 'en', p.name_en),
            'venue', jsonb_build_object('ar', p.venue_ar, 'en', p.venue_en), 'kind', p.kind, 'timezone', p.timezone,
            'startsAt', p.starts_at, 'endsAt', p.ends_at, 'statusNow', p.status_now)
          FROM public_event(ev.join_code) p);
END $$;
REVOKE ALL ON FUNCTION invitation_open(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_open(uuid) TO questify_app;

-- ================================================================ erasure
-- 0070's body plus the player's recipient rows (ADR-332 (5)); the campaigns' counters stay.
CREATE OR REPLACE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM player_xp x WHERE x.player_id = me FOR UPDATE;
  DELETE FROM player_equipment WHERE player_id = me;
  PERFORM set_config('app.erasure','on',true);
  DELETE FROM player_item WHERE player_id = me;
  DELETE FROM souvenir_receipt WHERE player_id = me;
  PERFORM set_config('app.erasure','',true);
  -- The append-only histories let a DELETE through under this flag only, for this transaction.
  PERFORM set_config('app.erasure', 'on', true);
  DELETE FROM username_history WHERE player_id = me;
  DELETE FROM player_acceptance WHERE player_id = me;
  DELETE FROM marketing_consent WHERE player_id = me;
  PERFORM set_config('app.erasure', '', true);
  DELETE FROM marketing_state WHERE player_id = me;
  DELETE FROM player_preference WHERE player_id = me;
  DELETE FROM invitation_recipient WHERE player_id = me;
  DELETE FROM player_fingerprint WHERE player_id = me;
  -- Open sign-in codes for the account's contacts (they hold the contact in clear).
  DELETE FROM player_login_challenge l
  WHERE l.contact_key = key
     OR l.contact IN (SELECT unnest(ARRAY[pc.phone_e164, pc.email]) FROM player_contact pc WHERE pc.player_id = me);
  DELETE FROM player_contact WHERE player_id = me;
  DELETE FROM player_contact_challenge WHERE player_id = me;
  DELETE FROM player_session WHERE player_id = me;
  DELETE FROM player_refresh WHERE player_id = me;
  DELETE FROM player_deletion_challenge WHERE player_id = me;
  DELETE FROM staff_assignment WHERE player_id = me;
  DELETE FROM ticket WHERE player_id = me;
  DELETE FROM join_answer WHERE enrollment_id = ANY (enrolled);
  DELETE FROM flag WHERE enrollment_id = ANY (enrolled);
  DELETE FROM completion_position WHERE enrollment_id = ANY (enrolled);
  DELETE FROM meeting m WHERE m.scanner_enrollment = ANY (enrolled) OR m.shown_enrollment = ANY (enrolled);
  DELETE FROM meet_pass p WHERE p.enrollment_id = ANY (enrolled);
  UPDATE quest_completion SET device_id = NULL WHERE enrollment_id = ANY (enrolled) AND device_id IS NOT NULL;
  UPDATE ledger_note t SET reason = NULL
  FROM ledger_entry l WHERE l.id = t.entry_id AND l.enrollment_id = ANY (enrolled) AND t.reason IS NOT NULL;
  UPDATE enrollment n
  SET status = CASE WHEN n.status IN ('active', 'pending') THEN 'left' ELSE n.status END,
      waitlisted = false, goal_reward_id = NULL, redeem_paused_at = NULL
  WHERE n.id = ANY (enrolled);
  UPDATE submission s
  SET body = NULL, reason = CASE WHEN s.reason_system THEN s.reason END, erased_at = now()
  WHERE s.enrollment_id = ANY (enrolled) AND s.erased_at IS NULL;
  DELETE FROM quest_vote WHERE enrollment_id = ANY (enrolled);
  DELETE FROM survey_response WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_bonus WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_reveal WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quest_item_miss WHERE enrollment_id = ANY (enrolled);
  DELETE FROM passport_stamp WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  DELETE FROM game_round g WHERE g.enrollment_id = ANY (enrolled);
  -- Last: the staff_assignment delete above enqueues while the enrollments are still active (enqueue_souvenir_on_staff).
  DELETE FROM souvenir_work WHERE enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
REVOKE ALL ON FUNCTION erase_rows(uuid,uuid[],bytea) FROM PUBLIC;
