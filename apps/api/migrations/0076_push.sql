-- T-501: the push store, the notification center and per-topic mute (FR-1101 to FR-1106, FR-1115; ADR-342 to ADR-350;
-- plan docs/plans/2026-10-28-t-501-push.md). A producer writes one `notice` (notice_create, one insert, nothing else);
-- the in-process push worker fans it out into one center row (`notification`) per recipient and one outbox row
-- (`push_send`) per pushable device, claims the outbox in rounds under 60-second leases and acknowledges each wave;
-- settle expires, cleans up after erasures and purges. Devices belong to a sign-in (the refresh family of T-107), so a
-- sign-out stops pushes without any change to sign-in code. Kinds are seeded rows (`notice_kind`); this migration seeds
-- none. Deny by default: the six tables keep row-level security forced and no grant; every function is closed to PUBLIC
-- in the statement group that creates it and only the doors are granted to the API role. Deployed migrations and 0057
-- to 0075 untouched; erase_rows is restated (0073's body plus the five push deletes).
SET LOCAL lock_timeout = '10s';
-- Every existing table this migration references, up front, at the strongest mode a later statement needs: event and
-- player are foreign-key targets and player gains an index. Never enrollment (read only), ledger_entry, xp_entry,
-- platform_setting or player_refresh (read only): nothing here sits in a payer's or a sign-in's path.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE player IN SHARE ROW EXCLUSIVE MODE;

-- Settle's bounded scan of recent erasures (plan § Review 6): only deleted players are in it.
CREATE INDEX player_deleted_recent ON player (deleted_at) WHERE status = 'deleted';

-- ================================================================ the tables (ADR-343)
-- One row per kind of message, seeded by the slice that wires it (T-501d onward) and read only at run time. `class`
-- decides the audience and the priority; `topic` (NULL: not mutable in the app) belongs to the kind; `membership` is the
-- enrollment a recipient needs; `before_start` kinds (event starting soon) reach real members before the start only.
CREATE TABLE notice_kind (
  kind         text PRIMARY KEY CHECK (kind ~ '^[a-z][a-z_]{0,39}$'),
  class        text NOT NULL CHECK (class IN ('personal', 'event', 'promo')),
  topic        text CHECK (topic IN ('announcements', 'rank', 'community', 'reminders')),
  membership   text NOT NULL DEFAULT 'active' CHECK (membership IN ('active', 'decided', 'none')),
  before_start boolean NOT NULL DEFAULT false,
  priority     smallint NOT NULL,
  ttl          interval NOT NULL CHECK (ttl BETWEEN interval '1 minute' AND interval '7 days'),
  CONSTRAINT notice_kind_promo_topic CHECK (class <> 'promo' OR topic IS NULL),
  CONSTRAINT notice_kind_priority CHECK (priority = CASE class WHEN 'personal' THEN 0 WHEN 'event' THEN 1 ELSE 2 END),
  CONSTRAINT notice_kind_before_start CHECK (NOT before_start OR class = 'event')
);
ALTER TABLE notice_kind ENABLE ROW LEVEL SECURITY;
ALTER TABLE notice_kind FORCE ROW LEVEL SECURITY;
REVOKE ALL ON notice_kind FROM PUBLIC, questify_app;

-- One row per thing that happened. `refs` holds ids only (the kind's quest, category, reward...), `params` the frozen
-- public names (each {ar, en}, cut in SQL to 40 characters) and dates; `dedupe` is the once-only marker. No CHECK a
-- producer's data can fail (plan § Review 2): notice_create derives `audience` and refuses a mismatch by inserting
-- nothing. The worker advances `fan_cursor` (an enrollment id) and sets `fanned_at` when the fan-out is done.
CREATE TABLE notice (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL REFERENCES notice_kind (kind),
  organizer_id uuid,
  event_id     uuid,
  player_id    uuid,
  audience     text NOT NULL CHECK (audience IN ('player', 'event')),
  refs         jsonb NOT NULL DEFAULT '{}',
  params       jsonb NOT NULL DEFAULT '{}',
  dedupe       text NOT NULL UNIQUE,
  fan_cursor   uuid,
  fanned_at    timestamptz,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
CREATE INDEX notice_unfanned ON notice (audience, id) WHERE fanned_at IS NULL;
CREATE INDEX notice_player ON notice (player_id) WHERE player_id IS NOT NULL;
ALTER TABLE notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE notice FORCE ROW LEVEL SECURITY;
REVOKE ALL ON notice FROM PUBLIC, questify_app;

-- The center: one row per recipient per notice, the record of every message (FR-1104, FR-1824). No foreign key on the
-- player: the fan-out must not lock players; settle removes the rows of a player erased while a fan-out raced
-- (plan § Review 6).
CREATE TABLE notification (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notice_id  bigint NOT NULL REFERENCES notice (id) ON DELETE CASCADE,
  player_id  uuid NOT NULL,
  event_id   uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  UNIQUE (notice_id, player_id)
);
CREATE INDEX notification_player ON notification (player_id, id DESC);
CREATE INDEX notification_unread ON notification (player_id) WHERE read_at IS NULL;
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
REVOKE ALL ON notification FROM PUBLIC, questify_app;

-- One row per sign-in on a phone (the refresh family), unique per token: a token registered by another sign-in moves
-- to it. iOS tokens are lower-case hex; Android (FCM) tokens are capped at 2048 characters so the unique index always
-- fits a btree page (ADR-350 (2)). The environment is the device's APNs one (ADR-344 (5)); Android has none.
CREATE TABLE push_device (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id    uuid NOT NULL REFERENCES player (id),
  family       uuid NOT NULL UNIQUE,
  platform     text NOT NULL CHECK (platform IN ('ios', 'android')),
  token        text NOT NULL,
  environment  text CHECK (environment IN ('sandbox', 'production')),
  language     text NOT NULL CHECK (language IN ('ar', 'en')),
  app_version  text NOT NULL CHECK (app_version ~ '^[0-9A-Za-z.+-]{1,20}$'),
  token_set_at timestamptz NOT NULL DEFAULT now(),
  seen_at      timestamptz NOT NULL DEFAULT now(),
  invalid_at   timestamptz,
  invalid_code text CHECK (invalid_code ~ '^[A-Za-z0-9_]{1,40}$'),
  UNIQUE (platform, token),
  CONSTRAINT push_device_environment CHECK ((platform = 'ios') = (environment IS NOT NULL)),
  CONSTRAINT push_device_token CHECK ((platform = 'ios' AND token ~ '^[0-9a-f]{64,200}$')
                                      OR (platform = 'android' AND token ~ '^[A-Za-z0-9_:-]+$'
                                          AND char_length(token) BETWEEN 20 AND 2048))
);
CREATE INDEX push_device_player ON push_device (player_id);
ALTER TABLE push_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_device FORCE ROW LEVEL SECURITY;
REVOKE ALL ON push_device FROM PUBLIC, questify_app;

-- A player's muted topics, for every event (FR-1115). Mute stops the push, never the center row.
CREATE TABLE push_topic_mute (
  player_id uuid NOT NULL REFERENCES player (id),
  topic     text NOT NULL CHECK (topic IN ('announcements', 'rank', 'community', 'reminders')),
  muted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, topic)
);
ALTER TABLE push_topic_mute ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_topic_mute FORCE ROW LEVEL SECURITY;
REVOKE ALL ON push_topic_mute FROM PUBLIC, questify_app;

-- The outbox: one row per center row and device. `attempts` counts requests written to the provider (8 means failed);
-- `code` is a provider code or a skip reason only, never a token or text.
CREATE TABLE push_send (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id bigint NOT NULL REFERENCES notification (id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES push_device (id) ON DELETE CASCADE,
  notice_id       bigint NOT NULL,
  target          text NOT NULL CHECK (target IN ('apns:production', 'apns:sandbox', 'fcm')),
  priority        smallint NOT NULL CHECK (priority BETWEEN 0 AND 2),
  expires_at      timestamptz NOT NULL,
  state           text NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued', 'sending', 'sent', 'unknown', 'failed', 'expired', 'skipped')),
  attempts        smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  lease_token     uuid,
  lease_until     timestamptz,
  code            text CHECK (code ~ '^[A-Za-z0-9_]{1,40}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  finished_at     timestamptz,
  UNIQUE (notification_id, device_id),
  CHECK ((state = 'sending') = (lease_token IS NOT NULL)),
  CHECK ((state = 'sending') = (lease_until IS NOT NULL)),
  CHECK ((state IN ('queued', 'sending')) = (finished_at IS NULL))
);
CREATE INDEX push_send_queue ON push_send (target, priority, notice_id, id) WHERE state = 'queued';
CREATE INDEX push_send_due ON push_send (expires_at) WHERE state = 'queued';
CREATE INDEX push_send_leased ON push_send (lease_until) WHERE state = 'sending';
CREATE INDEX push_send_device ON push_send (device_id);
ALTER TABLE push_send ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_send FORCE ROW LEVEL SECURITY;
REVOKE ALL ON push_send FROM PUBLIC, questify_app;

-- ================================================================ helpers (internal: no grant)
-- The platform switch `features.pushNotifications.enabled`, ON unless set to false. Off, nothing is claimed; settle,
-- the fan-out, the center, mutes and registration go on.
CREATE FUNCTION push_on() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT s.value -> 'pushNotifications' -> 'enabled' IS DISTINCT FROM 'false'::jsonb
                   FROM platform_setting s WHERE s.key = 'features'), true)
$$;
REVOKE ALL ON FUNCTION push_on() FROM PUBLIC;

-- The worker's seat: no player, staff, organizer, admin or device identity, under READ COMMITTED (each statement reads
-- what committed before it, which the lease relies on). PN403 `system_only` otherwise.
CREATE FUNCTION push_system_only() RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT ranking_system() OR app_device_id() IS NOT NULL
     OR current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'pushes are sent in the system context only' USING ERRCODE = 'PN403', DETAIL = 'system_only';
  END IF;
END $$;
REVOKE ALL ON FUNCTION push_system_only() FROM PUBLIC;

-- The calling player of a center, mute or device door: active, in a player request (no device seat). PN401 otherwise.
-- No lock: no push door locks a player (docs/rules.md, the push store's lock order).
CREATE FUNCTION push_player() RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  who uuid;
BEGIN
  SELECT p.id INTO who FROM player p
  WHERE p.id = app_player_id() AND p.status = 'active' AND app_device_id() IS NULL;
  IF who IS NULL THEN
    RAISE EXCEPTION 'active player required' USING ERRCODE = 'PN401';
  END IF;
  RETURN who;
END $$;
REVOKE ALL ON FUNCTION push_player() FROM PUBLIC;

-- A uuid reference of a notice (`refs ->> name`), or NULL when it is absent or not a uuid: a malformed reference never
-- raises inside the worker.
CREATE FUNCTION push_ref(refs jsonb, name text) RETURNS uuid
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN refs ->> name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (refs ->> name)::uuid END
$$;
REVOKE ALL ON FUNCTION push_ref(jsonb, text) FROM PUBLIC;

-- The producer's one write (plan § Review 2): exactly one INSERT ... SELECT from the kind's row. An unknown kind, a
-- missing once-only marker, a personal or promotional kind without a player, an event kind with a player or without an
-- event, or an event of another organizer inserts nothing and raises nothing; a second call with the same marker inserts
-- nothing. The expiry is the producer's `until` capped by the kind's time to live, so a past `until` gives a notice that
-- is already expired. Reads no device, mute, consent or refresh row and writes no center row or send. Returns the new
-- notice's id, or NULL.
CREATE FUNCTION notice_create(new_kind text, org uuid, ev uuid, who uuid, new_refs jsonb, new_params jsonb,
                              marker text, until timestamptz) RETURNS bigint
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO notice (kind, organizer_id, event_id, player_id, audience, refs, params, dedupe, expires_at)
  SELECT k.kind, CASE WHEN ev IS NOT NULL THEN org END, ev, who, CASE WHEN who IS NULL THEN 'event' ELSE 'player' END,
         coalesce(new_refs, '{}'::jsonb), coalesce(new_params, '{}'::jsonb), marker,
         least(coalesce(until, now() + k.ttl), now() + k.ttl)
  FROM notice_kind k
  WHERE k.kind = new_kind AND marker IS NOT NULL
    AND CASE k.class WHEN 'event' THEN who IS NULL AND ev IS NOT NULL ELSE who IS NOT NULL END
    AND (ev IS NULL OR EXISTS (SELECT 1 FROM event e WHERE e.id = ev AND e.organizer_id = org))
  ON CONFLICT (dedupe) DO NOTHING
  RETURNING id
$$;
REVOKE ALL ON FUNCTION notice_create(text, uuid, uuid, uuid, jsonb, jsonb, text, timestamptz) FROM PUBLIC;

-- Whether a member may be shown a quest by name (plan § Review 7, ADR-350 (1)): member_event_quests' own listing rule
-- (the category seen, the quest visible, a flash quest shown) plus its window (opened, not closed). The DB suite runs it
-- against member_event_quests over the same fixtures, so the listing rule is not restated wrongly.
CREATE FUNCTION member_sees_quest(member uuid, target uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM quest q
    JOIN category c ON c.id = q.category_id AND c.event_id = q.event_id
    JOIN enrollment n ON n.id = member AND n.event_id = q.event_id
    WHERE q.id = target AND q.visible AND flash_shown(q) AND sees_category(member, c)
      AND (q.opens_at IS NULL OR q.opens_at <= now()) AND (q.closes_at IS NULL OR q.closes_at > now()));
END $$;
REVOKE ALL ON FUNCTION member_sees_quest(uuid, uuid) FROM PUBLIC;

-- The event's status decides who an event notice reaches (plan § Review 1): before the start, rehearsal accounts only
-- (a `before_start` kind: real members only); live or ended, every active member (a `before_start` kind: no one);
-- archived, no one.
CREATE FUNCTION notice_status_ok(k notice_kind, status_now text, member enrollment) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN status_now IN ('draft', 'scheduled')
      THEN (member.joined_via IS NOT DISTINCT FROM 'rehearsal') <> k.before_start
    WHEN status_now IN ('live', 'ended') THEN NOT k.before_start
    ELSE false END
$$;
REVOKE ALL ON FUNCTION notice_status_ok(notice_kind, text, enrollment) FROM PUBLIC;

-- The membership rule of a notice for an enrollment (plan § Review 1, ADR-347 (2)): `none` needs nothing (the player's
-- own request); `decided` an active or declined enrollment; `active` an active one whose player is not excluded from
-- the event; an event kind also the status rule. Personal kinds ignore the status (archived: no send, in push_plan and
-- the claim). A notice with no event needs no enrollment.
CREATE FUNCTION notice_membership_ok(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  k  notice_kind;
  ev event;
BEGIN
  IF nt.event_id IS NULL THEN
    RETURN true;
  END IF;
  SELECT x.* INTO k FROM notice_kind x WHERE x.kind = nt.kind;
  IF NOT FOUND THEN
    RETURN false;
  ELSIF k.membership = 'none' THEN
    RETURN true;
  ELSIF member.id IS NULL OR member.event_id <> nt.event_id THEN
    RETURN false;
  ELSIF k.membership = 'decided' THEN
    RETURN member.status IN ('active', 'declined');
  ELSIF member.status <> 'active' OR excluded_from_event(member.event_id, member.player_id) THEN
    RETURN false;
  ELSIF k.class <> 'event' THEN
    RETURN true;
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = nt.event_id;
  RETURN notice_status_ok(k, event_status_now(ev.status, ev.starts_at, ev.ends_at), member);
END $$;
REVOKE ALL ON FUNCTION notice_membership_ok(notice, enrollment) FROM PUBLIC;

-- A reward an event notice names reaches only the members in its audience (`in_audience`, 0037); a personal notice
-- names the player's own reward and needs nothing more.
CREATE FUNCTION notice_reward_seen(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN NOT nt.refs ? 'reward' OR nt.audience <> 'event' OR EXISTS (
    SELECT 1 FROM reward r WHERE r.id = push_ref(nt.refs, 'reward') AND r.event_id = nt.event_id
      AND in_audience(member.id, r.audience_kind, r.audience_field_id, r.audience_values));
END $$;
REVOKE ALL ON FUNCTION notice_reward_seen(notice, enrollment) FROM PUBLIC;

-- Whether what a notice names may be shown to the member (plan § Review 7, ADR-347 (2)). Event notices: a category by
-- sees_category, a quest by member_sees_quest, a reward by its audience. Personal and promotional notices name what the
-- player acted on: the category (or the quest's category) by sees_category only, so a closed quest's decision still
-- reaches its player. A named reference that is malformed or not in the event hides the notice.
CREATE FUNCTION notice_visible(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF nt.refs ? 'category' AND NOT EXISTS (
       SELECT 1 FROM category c WHERE c.id = push_ref(nt.refs, 'category') AND c.event_id = nt.event_id
         AND sees_category(member.id, c)) THEN
    RETURN false;
  END IF;
  IF nt.refs ? 'quest' AND nt.audience = 'event' THEN
    RETURN member_sees_quest(member.id, push_ref(nt.refs, 'quest')) AND notice_reward_seen(nt, member);
  END IF;
  IF nt.refs ? 'quest' AND NOT EXISTS (
       SELECT 1 FROM quest q JOIN category c ON c.id = q.category_id
       WHERE q.id = push_ref(nt.refs, 'quest') AND q.event_id = nt.event_id AND sees_category(member.id, c)) THEN
    RETURN false;
  END IF;
  RETURN notice_reward_seen(nt, member);
END $$;
REVOKE ALL ON FUNCTION notice_visible(notice, enrollment) FROM PUBLIC;

-- Both rules: whether the member gets a center row for the notice (at fan-out) and its push (again at the claim).
CREATE FUNCTION notice_member_ok(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN notice_membership_ok(nt, member) AND notice_visible(nt, member);
END $$;
REVOKE ALL ON FUNCTION notice_member_ok(notice, enrollment) FROM PUBLIC;

-- A kind's own audience filter (a poll's non-voters, a positive balance): plain SQL, restated by each wiring slice with
-- a CASE on `nt.kind`. T-501 wires no kind, so every member passes.
CREATE FUNCTION notice_audience_ok(nt notice, member enrollment) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT nt.id IS NOT NULL AND member.id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION notice_audience_ok(notice, enrollment) FROM PUBLIC;

-- The devices that may be pushed (the one rule): not marked invalid, seen in the last 60 days, and their sign-in alive
-- (the family holds a refresh token that is not revoked, not used and not expired: the one rotate_player_refresh hands
-- out next). Sign-out, the 10-family limit and a reused refresh token end the family, so they stop pushes at once. Plain
-- SQL with no SET clause and schema-qualified tables, so the planner inlines it into push_plan's join instead of
-- calling it per device (the promo_pool precedent).
CREATE FUNCTION push_live_devices() RETURNS SETOF push_device
  LANGUAGE sql STABLE AS $$
  SELECT d.* FROM public.push_device d
  WHERE d.invalid_at IS NULL AND d.seen_at > now() - interval '60 days'
    AND EXISTS (SELECT 1 FROM public.player_refresh r
                WHERE r.family = d.family AND r.revoked_at IS NULL AND r.used_at IS NULL AND r.expires_at > now())
$$;
REVOKE ALL ON FUNCTION push_live_devices() FROM PUBLIC;

-- One device against the same rule (the claim's re-check).
CREATE FUNCTION push_pushable(d push_device) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM push_live_devices() x WHERE x.id = d.id);
END $$;
REVOKE ALL ON FUNCTION push_pushable(push_device) FROM PUBLIC;

-- The provider target of a device: FCM for Android, APNs in the device's environment for iOS.
CREATE FUNCTION push_target(platform text, environment text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE platform WHEN 'android' THEN 'fcm' ELSE 'apns:' || environment END
$$;
REVOKE ALL ON FUNCTION push_target(text, text) FROM PUBLIC;

-- Whether a player muted a topic (NULL topic: a kind that cannot be muted).
CREATE FUNCTION push_muted(who uuid, muted_topic text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT muted_topic IS NOT NULL
     AND EXISTS (SELECT 1 FROM push_topic_mute m WHERE m.player_id = who AND m.topic = muted_topic)
$$;
REVOKE ALL ON FUNCTION push_muted(uuid, text) FROM PUBLIC;

-- Whether a promotional push may reach the player now: promo_pool on push (the one consent rule, ADR-348).
CREATE FUNCTION push_consented(who uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM promo_pool('push', NULL, NULL) pp WHERE pp.player_id = who)
$$;
REVOKE ALL ON FUNCTION push_consented(uuid) FROM PUBLIC;

-- Plans the pushes of new center rows: a queued send per pushable device of the recipient, unless the notice expired,
-- its event is archived, the kind's topic is muted or, for a promotional kind, the consent is off. Answers how many.
CREATE FUNCTION push_plan(made bigint[]) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH planned AS (
    INSERT INTO push_send (notification_id, device_id, notice_id, target, priority, expires_at)
    SELECT c.id, d.id, nt.id, push_target(d.platform, d.environment), k.priority, nt.expires_at
    FROM notification c
    JOIN notice nt ON nt.id = c.notice_id
    JOIN notice_kind k ON k.kind = nt.kind
    JOIN push_live_devices() d ON d.player_id = c.player_id
    LEFT JOIN event e ON e.id = nt.event_id
    WHERE c.id = ANY (made) AND nt.expires_at > now()
      AND e.status IS DISTINCT FROM 'archived'
      AND NOT push_muted(c.player_id, k.topic)
      AND (k.class <> 'promo' OR push_consented(c.player_id))
    ORDER BY c.id, d.id
    ON CONFLICT (notification_id, device_id) DO NOTHING
    RETURNING 1)
  SELECT count(*)::integer FROM planned
$$;
REVOKE ALL ON FUNCTION push_plan(bigint[]) FROM PUBLIC;

-- Lease expiry (ADR-345 (4), as ADR-333 (2)): a row whose lease ran out becomes `unknown` with its token cleared, so a
-- late acknowledgement changes nothing and the message is never sent again. At most `lim`, SKIP LOCKED.
CREATE FUNCTION push_expire_leases(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH stale AS (
    SELECT s.id FROM push_send s WHERE s.state = 'sending' AND s.lease_until < now()
    ORDER BY s.lease_until LIMIT lim FOR UPDATE SKIP LOCKED),
  moved AS (
    UPDATE push_send s
    SET state = 'unknown', lease_token = NULL, lease_until = NULL, code = 'lease_expired', finished_at = now()
    FROM stale x WHERE s.id = x.id RETURNING 1)
  SELECT count(*)::integer FROM moved
$$;
REVOKE ALL ON FUNCTION push_expire_leases(integer) FROM PUBLIC;

-- ================================================================ the fan-out (system context only)
-- Personal and promotional notices (one recipient each), up to 500 a call, oldest first: a center row when the player is
-- active and the notice's membership and visibility rules hold, and its sends. Answers the center rows written.
CREATE FUNCTION push_fan_out_personal() RETURNS jsonb
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  due  bigint[];
  made bigint[];
BEGIN
  SELECT coalesce(array_agg(x.id ORDER BY x.id), '{}') INTO due
  FROM (SELECT nt.id FROM notice nt WHERE nt.audience = 'player' AND nt.fanned_at IS NULL
        ORDER BY nt.id LIMIT 500 FOR UPDATE SKIP LOCKED) x;
  IF cardinality(due) = 0 THEN
    RETURN NULL;
  END IF;
  WITH inserted AS (
    INSERT INTO notification (notice_id, player_id, event_id)
    SELECT nt.id, nt.player_id, nt.event_id
    FROM notice nt
    JOIN player p ON p.id = nt.player_id AND p.status = 'active'
    LEFT JOIN enrollment n ON n.event_id = nt.event_id AND n.player_id = nt.player_id
    WHERE nt.id = ANY (due) AND notice_member_ok(nt, n)
    ORDER BY nt.id
    ON CONFLICT (notice_id, player_id) DO NOTHING
    RETURNING id)
  SELECT coalesce(array_agg(i.id), '{}') INTO made FROM inserted i;
  UPDATE notice nt SET fanned_at = now() WHERE nt.id = ANY (due);
  PERFORM push_plan(made);
  RETURN jsonb_build_object('rows', cardinality(made), 'more', cardinality(due) = 500);
END $$;
REVOKE ALL ON FUNCTION push_fan_out_personal() FROM PUBLIC;

-- The oldest unfanned event notice (SKIP LOCKED: two workers take two notices): the next 2,000 enrollments of its event
-- after the cursor, in id order, read without locks; a center row for each active player passing the membership,
-- visibility and audience rules, and its sends; the cursor advances, and the notice is done once a batch comes back
-- short. An archived event's notice is done at once with no row (plan § Review 1).
CREATE FUNCTION push_fan_out_event() RETURNS jsonb
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  nt     notice;
  status text;
  made   bigint[];
  last   uuid;
  seen   integer;
BEGIN
  SELECT x.* INTO nt FROM notice x WHERE x.audience = 'event' AND x.fanned_at IS NULL
  ORDER BY x.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT event_status_now(e.status, e.starts_at, e.ends_at) INTO status FROM event e WHERE e.id = nt.event_id;
  IF status IS NULL OR status = 'archived' THEN
    UPDATE notice x SET fanned_at = now() WHERE x.id = nt.id;
    RETURN jsonb_build_object('rows', 0, 'more', true);
  END IF;
  WITH batch AS MATERIALIZED (
    SELECT n.id, n.player_id,
           p.status = 'active' AND notice_member_ok(nt, n) AND notice_audience_ok(nt, n) AS ok
    FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = nt.event_id AND (nt.fan_cursor IS NULL OR n.id > nt.fan_cursor)
    ORDER BY n.id LIMIT 2000),
  inserted AS (
    INSERT INTO notification (notice_id, player_id, event_id)
    SELECT nt.id, b.player_id, nt.event_id FROM batch b WHERE b.ok ORDER BY b.id
    ON CONFLICT (notice_id, player_id) DO NOTHING
    RETURNING id)
  SELECT (SELECT coalesce(array_agg(i.id), '{}') FROM inserted i),
         (SELECT b.id FROM batch b ORDER BY b.id DESC LIMIT 1),
         (SELECT count(*)::integer FROM batch)
  INTO made, last, seen;
  UPDATE notice x
  SET fan_cursor = coalesce(last, x.fan_cursor), fanned_at = CASE WHEN seen < 2000 THEN now() END
  WHERE x.id = nt.id;
  PERFORM push_plan(made);
  RETURN jsonb_build_object('rows', cardinality(made), 'more', true);
END $$;
REVOKE ALL ON FUNCTION push_fan_out_event() FROM PUBLIC;

-- The fan-out door (ADR-345 (1)): personal notices first (a decision's push about a second after it), else one batch
-- of the oldest event notice. `{rows, more}`: `more` while either may have work left.
CREATE FUNCTION push_fan_out() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  done jsonb;
BEGIN
  PERFORM push_system_only();
  done := push_fan_out_personal();
  IF done IS NULL THEN
    done := push_fan_out_event();
  ELSE
    done := jsonb_build_object('rows', done -> 'rows', 'more', true);
  END IF;
  RETURN coalesce(done, jsonb_build_object('rows', 0, 'more', false));
END $$;
REVOKE ALL ON FUNCTION push_fan_out() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_fan_out() TO questify_app;

-- ================================================================ the claim (system context only; ADR-345 (1))
-- The notices with queued rows for the targets, in priority then notice order, each with the targets it has rows on:
-- a loose index scan of push_send_queue (one probe per notice and target), never a sort over the queue.
CREATE FUNCTION push_queue_heads(allowed text[])
  RETURNS TABLE (priority smallint, notice_id bigint, targets text[])
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH RECURSIVE heads AS (
    SELECT f.target, f.priority, f.notice_id
    FROM unnest(allowed) a (target)
    CROSS JOIN LATERAL (SELECT s.target, s.priority, s.notice_id FROM push_send s
                        WHERE s.state = 'queued' AND s.target = a.target
                        ORDER BY s.priority, s.notice_id LIMIT 1) f
    UNION ALL
    SELECT nx.target, nx.priority, nx.notice_id
    FROM heads h
    CROSS JOIN LATERAL (SELECT s.target, s.priority, s.notice_id FROM push_send s
                        WHERE s.state = 'queued' AND s.target = h.target
                          AND (s.priority, s.notice_id) > (h.priority, h.notice_id)
                        ORDER BY s.priority, s.notice_id LIMIT 1) nx)
  SELECT h.priority, h.notice_id, array_agg(h.target ORDER BY h.target)
  FROM heads h GROUP BY h.priority, h.notice_id ORDER BY h.priority, h.notice_id
$$;
REVOKE ALL ON FUNCTION push_queue_heads(text[]) FROM PUBLIC;

-- Up to `lim` queued rows of one notice on one target, oldest first, locked SKIP LOCKED (an index range of
-- push_send_queue, stopped by the limit).
CREATE FUNCTION push_pick(pri smallint, notice bigint, on_target text, lim integer) RETURNS bigint[]
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(x.id ORDER BY x.id), '{}')
  FROM (SELECT s.id FROM push_send s
        WHERE s.state = 'queued' AND s.target = on_target AND s.priority = pri AND s.notice_id = notice
        ORDER BY s.id LIMIT lim FOR UPDATE SKIP LOCKED) x
$$;
REVOKE ALL ON FUNCTION push_pick(smallint, bigint, text, integer) FROM PUBLIC;

-- Picks up to `want` rows: notices in priority then id order, at most 100 from one notice (shared between its targets),
-- so a small event's push is never stuck behind another tenant's 50,000-row announcement (plan § Review 3).
CREATE FUNCTION push_pick_round(allowed text[], want integer) RETURNS bigint[]
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  picked bigint[] := '{}';
  h      record;
  share  integer;
  left_n integer;
  i      integer;
  got    bigint[];
BEGIN
  FOR h IN SELECT * FROM push_queue_heads(allowed) LOOP
    left_n := least(100, want - cardinality(picked));
    FOR i IN 1 .. cardinality(h.targets) LOOP
      share := ceil(left_n::numeric / (cardinality(h.targets) - i + 1))::integer;
      got := push_pick(h.priority, h.notice_id, h.targets[i], share);
      picked := picked || got;
      left_n := left_n - cardinality(got);
    END LOOP;
    EXIT WHEN cardinality(picked) >= want;
  END LOOP;
  RETURN picked;
END $$;
REVOKE ALL ON FUNCTION push_pick_round(text[], integer) FROM PUBLIC;

-- Why a queued send must not go now, or NULL (checked again at the claim, plan § Review 1, 6 and 7): the player is no
-- longer active (`player`, erasure included), the event is archived (`archived`), the device is not pushable (`device`),
-- a promotional kind lost its consent (`consent`), the topic was muted (`muted`), the enrollment no longer passes the
-- membership rule (`not_member`) or the member can no longer see what the notice names (`not_visible`).
CREATE FUNCTION push_skip_reason(send bigint) RETURNS text
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
    WHEN (r.device).player_id <> r.recipient OR NOT push_pushable(r.device) THEN 'device'
    WHEN r.class = 'promo' AND NOT push_consented(r.recipient) THEN 'consent'
    WHEN push_muted(r.recipient, r.topic) THEN 'muted'
    WHEN NOT notice_membership_ok(r.note, r.member) THEN 'not_member'
    WHEN (r.note).event_id IS NOT NULL AND NOT notice_visible(r.note, r.member) THEN 'not_visible'
    WHEN (r.note).audience = 'event' AND NOT notice_audience_ok(r.note, r.member) THEN 'not_member'
  END;
END $$;
REVOKE ALL ON FUNCTION push_skip_reason(bigint) FROM PUBLIC;

-- The claim door (plan § Review 3): lease expiry first; then up to `size` (200 at most) rows for the targets the worker
-- can send. A picked row past its expiry becomes `expired`; each other row is checked again (push_skip_reason) and
-- skipped with the reason, or leased for 60 s with a fresh token. Returns what the worker needs to render and send, in
-- priority, notice and id order: the device's token and language, the notice's kind, ids and frozen names, the
-- event's terms and time zone, and the attempts so far. Nothing while the switch is off.
CREATE FUNCTION push_claim(targets text[], size integer)
  RETURNS TABLE (send_id bigint, lease uuid, lease_until timestamptz, target text, token text, language text,
                 kind text, class text, topic text, notification_id bigint, event_id uuid, refs jsonb, params jsonb,
                 expires_at timestamptz, priority smallint, attempts smallint, terms jsonb, timezone text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  want    integer := least(greatest(coalesce(size, 0), 0), 200);
  allowed text[];
  picked  bigint[];
BEGIN
  PERFORM push_system_only();
  PERFORM push_expire_leases(1000);
  allowed := ARRAY(SELECT DISTINCT a.t FROM unnest(coalesce(targets, '{}'::text[])) a (t)
                   WHERE a.t IN ('apns:production', 'apns:sandbox', 'fcm') ORDER BY 1);
  IF NOT push_on() OR want = 0 OR cardinality(allowed) = 0 THEN
    RETURN;
  END IF;
  picked := push_pick_round(allowed, want);
  UPDATE push_send s SET state = 'expired', code = 'expired', finished_at = now()
  WHERE s.id = ANY (picked) AND s.expires_at <= now();
  RETURN QUERY
  WITH checked AS (
    SELECT s.id, push_skip_reason(s.id) AS why FROM push_send s WHERE s.id = ANY (picked) AND s.state = 'queued'),
  skipped AS (
    UPDATE push_send s SET state = 'skipped', code = c.why, finished_at = now()
    FROM checked c WHERE s.id = c.id AND c.why IS NOT NULL RETURNING s.id),
  leased AS (
    UPDATE push_send s SET state = 'sending', lease_token = gen_random_uuid(), lease_until = now() + interval '60 seconds'
    FROM checked c WHERE s.id = c.id AND c.why IS NULL
    RETURNING s.*)
  SELECT l.id, l.lease_token, l.lease_until, l.target, d.token, d.language, nt.kind, k.class, k.topic, c.id,
         nt.event_id, nt.refs, nt.params, l.expires_at, l.priority, l.attempts, e.config -> 'terms', e.timezone
  FROM leased l
  JOIN push_device d ON d.id = l.device_id
  JOIN notification c ON c.id = l.notification_id
  JOIN notice nt ON nt.id = c.notice_id
  JOIN notice_kind k ON k.kind = nt.kind
  LEFT JOIN event e ON e.id = nt.event_id
  ORDER BY l.priority, l.notice_id, l.id;
END $$;
REVOKE ALL ON FUNCTION push_claim(text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_claim(text[], integer) TO questify_app;

-- ================================================================ the acknowledgement (system context only)
-- One statement a wave (ADR-345 (2)): each row changes only while it is still `sending` with its lease (a late answer
-- after expiry changes nothing). `sent`, `unknown` and `failed` are final; `requeue` puts the row back to `queued` with
-- its lease cleared (`failed` with code `attempts` once it reached 8); `invalid` is `failed`, and its device is marked
-- invalid unless the token or environment changed after the claim. `attempts` is the worker's count of requests written,
-- never lowered, written as least(n, 8). Devices are locked in id order after the sends. Answers the rows changed.
CREATE FUNCTION push_ack(ids bigint[], leases uuid[], outcomes text[], codes text[], tries smallint[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer := coalesce(cardinality(ids), 0);
  changed integer;
BEGIN
  PERFORM push_system_only();
  IF n = 0 OR n > 200 OR cardinality(leases) IS DISTINCT FROM n OR cardinality(outcomes) IS DISTINCT FROM n
     OR cardinality(codes) IS DISTINCT FROM n OR cardinality(tries) IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'one lease, outcome, code and count per row, 1 to 200 rows' USING ERRCODE = 'PN422', DETAIL = 'ack';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(outcomes) o (v)
             WHERE o.v IS NULL OR o.v NOT IN ('sent', 'unknown', 'failed', 'requeue', 'invalid')) THEN
    RAISE EXCEPTION 'an outcome is sent, unknown, failed, requeue or invalid' USING ERRCODE = 'PN422', DETAIL = 'outcome';
  END IF;
  PERFORM 1 FROM push_send s WHERE s.id = ANY (ids) ORDER BY s.id FOR UPDATE;
  PERFORM 1 FROM push_device d
  WHERE d.id IN (SELECT s.device_id FROM unnest(ids, outcomes) a (id, outcome) JOIN push_send s ON s.id = a.id
                 WHERE a.outcome = 'invalid')
  ORDER BY d.id FOR UPDATE;
  WITH hit AS (
    SELECT s.id, s.device_id, s.lease_until, a.outcome,
           CASE WHEN a.code ~ '^[A-Za-z0-9_]{1,40}$' THEN a.code END AS code,
           least(greatest(coalesce(a.tried, s.attempts), s.attempts), 8)::smallint AS tried
    FROM unnest(ids, leases, outcomes, codes, tries) a (id, lease, outcome, code, tried)
    JOIN push_send s ON s.id = a.id AND s.state = 'sending' AND s.lease_token = a.lease),
  devices AS (
    UPDATE push_device d SET invalid_at = now(), invalid_code = coalesce(h.code, 'invalid')
    FROM hit h
    WHERE h.outcome = 'invalid' AND d.id = h.device_id AND d.invalid_at IS NULL
      AND d.token_set_at <= h.lease_until - interval '60 seconds'
    RETURNING d.id),
  moved AS (
    UPDATE push_send s
    SET state = CASE WHEN h.outcome = 'requeue' AND h.tried < 8 THEN 'queued'
                     WHEN h.outcome IN ('requeue', 'invalid') THEN 'failed' ELSE h.outcome END,
        code = CASE WHEN h.outcome = 'requeue' AND h.tried >= 8 THEN 'attempts' ELSE h.code END,
        attempts = h.tried, lease_token = NULL, lease_until = NULL,
        sent_at = CASE WHEN h.outcome = 'sent' THEN now() END,
        finished_at = CASE WHEN h.outcome = 'requeue' AND h.tried < 8 THEN NULL ELSE now() END
    FROM hit h WHERE s.id = h.id
    RETURNING 1)
  SELECT count(*)::integer INTO changed FROM moved;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION push_ack(bigint[], uuid[], text[], text[], smallint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_ack(bigint[], uuid[], text[], text[], smallint[]) TO questify_app;

-- ================================================================ settle (system context only; switch on or off)
-- Queued rows past their expiry become `expired` through push_send_due (the claim expires only what it picks).
CREATE FUNCTION push_expire_due(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT s.id FROM push_send s WHERE s.state = 'queued' AND s.expires_at <= now()
    ORDER BY s.expires_at LIMIT lim FOR UPDATE SKIP LOCKED),
  moved AS (
    UPDATE push_send s SET state = 'expired', code = 'expired', finished_at = now()
    FROM due x WHERE s.id = x.id RETURNING 1)
  SELECT count(*)::integer FROM moved
$$;
REVOKE ALL ON FUNCTION push_expire_due(integer) FROM PUBLIC;

-- What a producer or a fan-out racing an erasure left behind (plan § Review 6): the personal notices (with their center
-- rows and sends) and the center rows of players deleted in the last 24 hours, read through player_deleted_recent. At
-- most `lim` of each a call.
CREATE FUNCTION push_purge_erased(lim integer) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  gone   uuid[];
  n_note integer;
  n_row  integer;
BEGIN
  gone := ARRAY(SELECT p.id FROM player p
                WHERE p.status = 'deleted' AND p.deleted_at > now() - interval '24 hours');
  IF cardinality(gone) = 0 THEN
    RETURN 0;
  END IF;
  DELETE FROM notice nt WHERE nt.id IN (SELECT x.id FROM notice x WHERE x.player_id = ANY (gone) LIMIT lim);
  GET DIAGNOSTICS n_note = ROW_COUNT;
  DELETE FROM notification c
  WHERE c.id IN (SELECT x.id FROM notification x WHERE x.player_id = ANY (gone) LIMIT lim);
  GET DIAGNOSTICS n_row = ROW_COUNT;
  RETURN n_note + n_row;
END $$;
REVOKE ALL ON FUNCTION push_purge_erased(integer) FROM PUBLIC;

-- Retention (ADR-343 (8)), each walking the primary key from the oldest id and reading at most `lim` rows (ids grow
-- with time, so no created_at index is needed): center rows after 180 days; outbox rows 7 days after their final state;
-- notices once over 180 days old with no center row left. Devices: 7 days after being marked invalid, 60 days unseen,
-- or once their sign-in has ended. Answers the rows deleted.
CREATE FUNCTION push_purge(lim integer) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  total integer := 0;
  n     integer;
BEGIN
  DELETE FROM notification c WHERE c.id IN (
    SELECT h.id FROM (SELECT x.id, x.created_at FROM notification x ORDER BY x.id LIMIT lim) h
    WHERE h.created_at < now() - interval '180 days');
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;
  DELETE FROM push_send s WHERE s.id IN (
    SELECT h.id FROM (SELECT x.id, x.finished_at FROM push_send x ORDER BY x.id LIMIT lim) h
    WHERE h.finished_at < now() - interval '7 days');
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;
  DELETE FROM notice nt WHERE nt.id IN (
    SELECT h.id FROM (SELECT x.id, x.created_at FROM notice x ORDER BY x.id LIMIT lim) h
    WHERE h.created_at < now() - interval '180 days'
      AND NOT EXISTS (SELECT 1 FROM notification c WHERE c.notice_id = h.id));
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;
  DELETE FROM push_device d WHERE d.id IN (
    SELECT x.id FROM push_device x
    WHERE x.invalid_at < now() - interval '7 days' OR x.seen_at < now() - interval '60 days'
       OR NOT EXISTS (SELECT 1 FROM player_refresh r
                      WHERE r.family = x.family AND r.revoked_at IS NULL AND r.used_at IS NULL AND r.expires_at > now())
    LIMIT lim);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN total + n;
END $$;
REVOKE ALL ON FUNCTION push_purge(integer) FROM PUBLIC;

-- Settle (every 10 minutes, with the switch on or off): lease expiry, expiry by index, the erased-player cleanup and
-- the purges, each bounded; `more` when a bound was reached, so the worker calls again.
CREATE FUNCTION push_settle() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n_leases  integer;
  n_expired integer;
  n_erased  integer;
  n_purged  integer;
BEGIN
  PERFORM push_system_only();
  n_leases := push_expire_leases(1000);
  n_expired := push_expire_due(5000);
  n_erased := push_purge_erased(5000);
  n_purged := push_purge(5000);
  RETURN jsonb_build_object(
    'leases', n_leases, 'expired', n_expired, 'erased', n_erased, 'purged', n_purged,
    'more', n_leases >= 1000 OR n_expired >= 5000 OR n_erased >= 5000 OR n_purged >= 5000);
END $$;
REVOKE ALL ON FUNCTION push_settle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_settle() TO questify_app;

-- ================================================================ the device doors (the calling player)
-- The sign-in a request runs under: the live access session whose hash the API passes (sha256 of the bearer token),
-- of the calling active player, with its refresh family. PN401 otherwise (another player's session, a revoked or
-- expired one, a banned or deleted player).
CREATE FUNCTION push_session_family(session bytea) RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := push_player();
  fam uuid;
BEGIN
  SELECT s.refresh_family INTO fam FROM player_session s
  WHERE s.token_hash = session AND s.player_id = who AND s.revoked_at IS NULL AND s.expires_at > now();
  IF fam IS NULL THEN
    RAISE EXCEPTION 'a live session of the calling player is required' USING ERRCODE = 'PN401';
  END IF;
  RETURN fam;
END $$;
REVOKE ALL ON FUNCTION push_session_family(bytea) FROM PUBLIC;

-- A registration's fields, checked (PN422 with the field in DETAIL) and returned as a device row: an iOS token lower-
-- cased and needing an environment, an Android one taking none.
CREATE FUNCTION push_device_fields(plat text, raw_token text, env text, lang text, version text) RETURNS push_device
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  made push_device;
BEGIN
  IF plat IS NULL OR plat NOT IN ('ios', 'android') THEN
    RAISE EXCEPTION 'a platform is ios or android' USING ERRCODE = 'PN422', DETAIL = 'platform';
  END IF;
  made.platform := plat;
  made.token := CASE plat WHEN 'ios' THEN lower(raw_token) ELSE raw_token END;
  IF made.token IS NULL OR (plat = 'ios' AND made.token !~ '^[0-9a-f]{64,200}$')
     OR (plat = 'android' AND (made.token !~ '^[A-Za-z0-9_:-]+$' OR char_length(made.token) NOT BETWEEN 20 AND 2048)) THEN
    RAISE EXCEPTION 'not a device token' USING ERRCODE = 'PN422', DETAIL = 'token';
  END IF;
  made.environment := CASE plat WHEN 'ios' THEN env END;
  IF plat = 'ios' AND (env IS NULL OR env NOT IN ('sandbox', 'production')) THEN
    RAISE EXCEPTION 'an iOS device names its APNs environment' USING ERRCODE = 'PN422', DETAIL = 'environment';
  END IF;
  IF lang IS NULL OR lang NOT IN ('ar', 'en') THEN
    RAISE EXCEPTION 'a language is ar or en' USING ERRCODE = 'PN422', DETAIL = 'language';
  END IF;
  made.language := lang;
  IF version IS NULL OR version !~ '^[0-9A-Za-z.+-]{1,20}$' THEN
    RAISE EXCEPTION 'an app version is 1 to 20 characters' USING ERRCODE = 'PN422', DETAIL = 'appVersion';
  END IF;
  made.app_version := version;
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION push_device_fields(text, text, text, text, text) FROM PUBLIC;

-- Registers this sign-in's device (FR-1104): one row per family; the same token held by another sign-in is deleted
-- first, so a shared phone's token moves to whoever registered last and the other player's queued pushes go with it. A
-- new token or environment sets `token_set_at`, clears an invalid mark and moves the device's queued sends to its new
-- target in the same statement; every call sets `seen_at`. Lock order: this family's row, then the other row holding
-- the token. Two sign-ins racing for one token: the loser retries once after the winner commits.
CREATE FUNCTION push_device_register(session bytea, plat text, raw_token text, env text, lang text, version text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  fam  uuid := push_session_family(session);
  want push_device := push_device_fields(plat, raw_token, env, lang, version);
  turn integer;
BEGIN
  FOR turn IN 1 .. 2 LOOP
    BEGIN
      PERFORM 1 FROM push_device d WHERE d.family = fam FOR UPDATE;
      DELETE FROM push_device d WHERE d.platform = want.platform AND d.token = want.token AND d.family <> fam;
      WITH saved AS (
        INSERT INTO push_device AS d (player_id, family, platform, token, environment, language, app_version)
        VALUES (app_player_id(), fam, want.platform, want.token, want.environment, want.language, want.app_version)
        ON CONFLICT (family) DO UPDATE
        SET platform = EXCLUDED.platform, token = EXCLUDED.token, environment = EXCLUDED.environment,
            language = EXCLUDED.language, app_version = EXCLUDED.app_version, seen_at = now(),
            token_set_at = CASE WHEN (d.platform, d.token, d.environment)
                                     IS DISTINCT FROM (EXCLUDED.platform, EXCLUDED.token, EXCLUDED.environment)
                                THEN now() ELSE d.token_set_at END,
            invalid_at = CASE WHEN (d.platform, d.token, d.environment)
                                   IS DISTINCT FROM (EXCLUDED.platform, EXCLUDED.token, EXCLUDED.environment)
                              THEN NULL ELSE d.invalid_at END,
            invalid_code = CASE WHEN (d.platform, d.token, d.environment)
                                     IS DISTINCT FROM (EXCLUDED.platform, EXCLUDED.token, EXCLUDED.environment)
                                THEN NULL ELSE d.invalid_code END
        RETURNING d.id, d.platform, d.environment)
      UPDATE push_send s SET target = push_target(saved.platform, saved.environment)
      FROM saved
      WHERE s.device_id = saved.id AND s.state = 'queued'
        AND s.target <> push_target(saved.platform, saved.environment);
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      IF turn = 2 THEN
        RAISE;
      END IF;
    END;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION push_device_register(bytea, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_device_register(bytea, text, text, text, text, text) TO questify_app;

-- Removes this sign-in's device (the app calls it before signing out); idempotent.
CREATE FUNCTION push_device_remove(session bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  fam uuid := push_session_family(session);
BEGIN
  DELETE FROM push_device d WHERE d.family = fam AND d.player_id = app_player_id();
END $$;
REVOKE ALL ON FUNCTION push_device_remove(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_device_remove(bytea) TO questify_app;

-- ================================================================ the center and mutes (the calling player)
-- The caller's center rows with id below `before` (NULL: the newest), newest first, at most 50 (default 20): what the
-- API needs to render each in the request's language (kind, class, topic, ids, frozen names, the event's terms and
-- time zone) and whether it was read. Never another player's row.
CREATE FUNCTION own_notifications(before bigint, size integer) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := push_player();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(x.item ORDER BY x.id DESC)
    FROM (SELECT c.id, jsonb_build_object(
                   'id', c.id, 'kind', nt.kind, 'class', k.class, 'topic', k.topic, 'eventId', c.event_id,
                   'refs', nt.refs, 'params', nt.params, 'createdAt', c.created_at, 'read', c.read_at IS NOT NULL,
                   'terms', e.config -> 'terms', 'timezone', e.timezone) AS item
          FROM notification c
          JOIN notice nt ON nt.id = c.notice_id
          JOIN notice_kind k ON k.kind = nt.kind
          LEFT JOIN event e ON e.id = c.event_id
          WHERE c.player_id = who AND (before IS NULL OR c.id < before)
          ORDER BY c.id DESC
          LIMIT least(greatest(coalesce(size, 20), 1), 50)) x), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION own_notifications(bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_notifications(bigint, integer) TO questify_app;

-- The caller's unread center rows, counted up to 100 (the bell's dot and `GET /v1/me`).
CREATE FUNCTION own_unread_notifications() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM (
    SELECT 1 FROM notification c JOIN player p ON p.id = c.player_id AND p.status = 'active'
    WHERE c.player_id = app_player_id() AND c.read_at IS NULL AND app_device_id() IS NULL
    LIMIT 100) x
$$;
REVOKE ALL ON FUNCTION own_unread_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_unread_notifications() TO questify_app;

-- Marks 1 to 100 of the caller's rows read, or (NULL) all of them; another player's ids change nothing. Answers the
-- unread count after. PN422 `ids` for an empty or longer list.
CREATE FUNCTION mark_notifications_read(ids bigint[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := push_player();
BEGIN
  IF ids IS NOT NULL AND coalesce(cardinality(ids), 0) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'name 1 to 100 notifications, or none for all' USING ERRCODE = 'PN422', DETAIL = 'ids';
  END IF;
  UPDATE notification c SET read_at = now()
  WHERE c.player_id = who AND c.read_at IS NULL AND (ids IS NULL OR c.id = ANY (ids));
  RETURN own_unread_notifications();
END $$;
REVOKE ALL ON FUNCTION mark_notifications_read(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_notifications_read(bigint[]) TO questify_app;

-- The caller's four topics, true when on (not muted).
CREATE FUNCTION own_push_topics() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := push_player();
BEGIN
  RETURN (SELECT jsonb_object_agg(t.topic, NOT EXISTS (
                   SELECT 1 FROM push_topic_mute m WHERE m.player_id = who AND m.topic = t.topic))
          FROM unnest(ARRAY['announcements', 'rank', 'community', 'reminders']) t (topic));
END $$;
REVOKE ALL ON FUNCTION own_push_topics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_push_topics() TO questify_app;

-- Replaces the caller's muted set (PN422 `topics` for an unknown topic) and answers the four topics.
CREATE FUNCTION set_push_topics(muted text[]) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who  uuid := push_player();
  want text[] := coalesce(muted, '{}'::text[]);
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(want) t (topic)
             WHERE t.topic IS NULL OR t.topic NOT IN ('announcements', 'rank', 'community', 'reminders')) THEN
    RAISE EXCEPTION 'a topic is announcements, rank, community or reminders' USING ERRCODE = 'PN422', DETAIL = 'topics';
  END IF;
  DELETE FROM push_topic_mute m WHERE m.player_id = who AND NOT (m.topic = ANY (want));
  INSERT INTO push_topic_mute (player_id, topic)
  SELECT DISTINCT who, t.topic FROM unnest(want) t (topic)
  ON CONFLICT (player_id, topic) DO NOTHING;
  RETURN own_push_topics();
END $$;
REVOKE ALL ON FUNCTION set_push_topics(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_push_topics(text[]) TO questify_app;

-- ================================================================ erasure
-- 0073's body plus the five push deletes (plan § Review 6): the player's personal notices (with their center rows and
-- sends), center rows, sends, devices and mutes.
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
  DELETE FROM notice WHERE player_id = me;
  DELETE FROM notification WHERE player_id = me;
  DELETE FROM push_send s USING push_device d WHERE s.device_id = d.id AND d.player_id = me;
  DELETE FROM push_device WHERE player_id = me;
  DELETE FROM push_topic_mute WHERE player_id = me;
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
