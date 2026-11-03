-- T-507c: souvenir sponsor tags (FR-1302, FR-1303 for souvenirs, FR-1306's souvenir line; plan
-- docs/plans/2026-11-03-t-507c-souvenir-sponsor-tags.md; ADR-570 to ADR-574). An owner or editor tags a souvenir to one
-- of the event's sponsors; the souvenir's owner then sees "presented by {sponsor}" on it in their locker and on their
-- recap of the event. The tag is a `sponsor_tag` row of a fourth kind, so `souvenir_rule`, its frozen grant identity, the
-- receipts and the recipients' provenance are not touched, and no public item DTO (equipment, public profile, ranking)
-- carries a sponsor. Deny by default: no new table, so row-level security stays forced with no grant on `sponsor_tag`;
-- the one new function is internal (closed to PUBLIC in the group that creates it, no grant) and the doors that change
-- are the ones granted since 0088 (`sponsor_tag_set`) and 0064/0067/0074 (`own_locker`, `event_recap`, the player's own
-- reads). No EXCEPTION block beyond the one 0101 added to the tag door. Migrations through 0141 untouched.
SET LOCAL lock_timeout = '10s';
-- The souvenir rule is the foreign-key target of the new column; the tag table is changed in place.
LOCK TABLE souvenir_rule IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE sponsor_tag IN ACCESS EXCLUSIVE MODE;

-- ================================================================ the tag's fourth kind (ADR-570)
-- A souvenir tag names a rule of the sponsor's own event. Deleting a draft rule (the only rule that can be deleted)
-- deletes its tag; an active or stopped rule keeps it. One sponsor per souvenir, as for the other kinds.
ALTER TABLE sponsor_tag ADD COLUMN souvenir_id uuid;
ALTER TABLE sponsor_tag
  ADD CONSTRAINT sponsor_tag_souvenir_fk
  FOREIGN KEY (souvenir_id, event_id) REFERENCES souvenir_rule (id, event_id) ON DELETE CASCADE;
ALTER TABLE sponsor_tag DROP CONSTRAINT sponsor_tag_kind_check;
ALTER TABLE sponsor_tag DROP CONSTRAINT sponsor_tag_shape;
ALTER TABLE sponsor_tag
  ADD CONSTRAINT sponsor_tag_kind_check CHECK (kind IN ('quest', 'category', 'reward', 'souvenir')),
  ADD CONSTRAINT sponsor_tag_shape CHECK (
    (kind = 'quest' AND quest_id IS NOT NULL AND category_id IS NULL AND reward_id IS NULL AND souvenir_id IS NULL)
    OR (kind = 'category' AND category_id IS NOT NULL AND quest_id IS NULL AND reward_id IS NULL
        AND souvenir_id IS NULL)
    OR (kind = 'reward' AND reward_id IS NOT NULL AND quest_id IS NULL AND category_id IS NULL
        AND souvenir_id IS NULL)
    OR (kind = 'souvenir' AND souvenir_id IS NOT NULL AND quest_id IS NULL AND category_id IS NULL
        AND reward_id IS NULL));
CREATE UNIQUE INDEX sponsor_tag_souvenir ON sponsor_tag (souvenir_id) WHERE souvenir_id IS NOT NULL;

-- ================================================================ helpers (internal: no grant)
-- Restated from 0088: the item a tag names now includes a souvenir.
CREATE OR REPLACE FUNCTION sponsor_tag_target(t sponsor_tag) RETURNS uuid
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(t.quest_id, t.category_id, t.reward_id, t.souvenir_id)
$$;

-- Restated from 0121 (which restated 0088, with the held-reward check): a souvenir tag is never shown with the event's
-- items. A souvenir is not an item of the event for a member to browse; its sponsor shows on the owner's own locker and
-- recap only (`souvenir_presented_by`), so `member_sponsors` stays three kinds.
CREATE OR REPLACE FUNCTION sponsor_tag_shown(t sponsor_tag, member uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE t.kind
    WHEN 'quest' THEN member_sees_quest(member, t.quest_id)
    WHEN 'category' THEN EXISTS (SELECT 1 FROM category c
                                 WHERE c.id = t.category_id AND c.event_id = t.event_id AND sees_category(member, c))
    WHEN 'reward' THEN EXISTS (SELECT 1 FROM reward r
                               WHERE r.id = t.reward_id AND r.event_id = t.event_id AND r.status = 'active'
                                 AND r.held_at IS NULL
                                 AND in_audience(member, r.audience_kind, r.audience_field_id, r.audience_values))
    ELSE false
  END
$$;

-- The sponsor that presents a souvenir rule, as the souvenir's owner sees it: the name in both languages (one is enough;
-- the other shows in its place) and the tier that rings the mark. NULL for a rule with no tag. Only the owner's own
-- definers (`own_locker`, `event_recap`) call it, with the rule id of an item the owner holds.
CREATE FUNCTION souvenir_presented_by(rule uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'name', jsonb_build_object('ar', coalesce(s.name_ar, s.name_en), 'en', coalesce(s.name_en, s.name_ar)),
    'tier', s.tier)
  FROM sponsor_tag t JOIN sponsor s ON s.id = t.sponsor_id AND s.event_id = t.event_id
  WHERE t.souvenir_id = rule
$$;
REVOKE ALL ON FUNCTION souvenir_presented_by(uuid) FROM PUBLIC;

-- ================================================================ the team's door (ADR-570)
-- Restated from 0101: `tag_kind` may be `souvenir`; the rule must be of this event, in any status (a draft can be tagged
-- before it is activated, a stopped rule keeps its label). Everything else is as 0101 left it.
CREATE OR REPLACE FUNCTION sponsor_tag_set(target_event uuid, tag_kind text, target_item uuid, target_sponsor uuid, request uuid)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := sponsor_event_for_write(target_event);
BEGIN
  IF tag_kind IS NULL OR tag_kind NOT IN ('quest', 'category', 'reward', 'souvenir') THEN
    RAISE EXCEPTION 'check the tag''s kind' USING ERRCODE = 'PS422', DETAIL = 'kind';
  END IF;
  IF (tag_kind = 'quest' AND NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_item AND q.event_id = ev.id))
     OR (tag_kind = 'category' AND NOT EXISTS (SELECT 1 FROM category c WHERE c.id = target_item AND c.event_id = ev.id))
     OR (tag_kind = 'reward' AND NOT EXISTS (SELECT 1 FROM reward r
                                             WHERE r.id = target_item AND r.event_id = ev.id AND r.status = 'active'))
     OR (tag_kind = 'souvenir' AND NOT EXISTS (SELECT 1 FROM souvenir_rule v
                                               WHERE v.id = target_item AND v.event_id = ev.id))
     OR (target_sponsor IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM sponsor s WHERE s.id = target_sponsor AND s.event_id = ev.id)) THEN
    RAISE EXCEPTION 'no such item or sponsor in this event' USING ERRCODE = 'SO404';
  END IF;
  DELETE FROM sponsor_tag t
  WHERE t.event_id = ev.id AND t.kind = tag_kind AND sponsor_tag_target(t) = target_item;
  IF target_sponsor IS NOT NULL THEN
    BEGIN
      INSERT INTO sponsor_tag (organizer_id, event_id, sponsor_id, kind, quest_id, category_id, reward_id, souvenir_id,
                               created_by)
      VALUES (ev.organizer_id, ev.id, target_sponsor, tag_kind,
              CASE WHEN tag_kind = 'quest' THEN target_item END,
              CASE WHEN tag_kind = 'category' THEN target_item END,
              CASE WHEN tag_kind = 'reward' THEN target_item END,
              CASE WHEN tag_kind = 'souvenir' THEN target_item END,
              app_staff_user_id());
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'no such item or sponsor in this event' USING ERRCODE = 'SO404';
    END;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'sponsor.tag', tag_kind, target_item::text,
          jsonb_build_object('sponsor', target_sponsor), request);
  RETURN sponsor_team_list(ev.id);
END $$;

-- ================================================================ the owner's two reads (ADR-571)
-- As 0067, plus `presented_by`: the sponsor of the souvenir's rule ({name, tier}), NULL for a level or shop item and for
-- a souvenir with no tag. `item` is still `item_json` alone: no sponsor reaches a public item DTO.
DROP FUNCTION own_locker(timestamptz, text, integer);
CREATE FUNCTION own_locker(before_time timestamptz, before_item text, page_size integer)
 RETURNS TABLE(item jsonb, earned_at timestamptz, source_level smallint, source_event jsonb, seen boolean, source text,
               presented_by jsonb)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT item_json(o.item_id), o.earned_at, o.source_level,
  CASE WHEN o.source = 'souvenir' THEN jsonb_build_object('id', o.source_event_id, 'name', jsonb_build_object(
   'ar', coalesce(e.name_ar, e.name_en, 'فعالية سابقة'), 'en', coalesce(e.name_en, e.name_ar, 'Past event'))) END,
  o.seen_at IS NOT NULL, o.source,
  CASE WHEN o.source = 'souvenir' THEN souvenir_presented_by(o.source_rule_id) END
 FROM player_item o LEFT JOIN event e ON e.id = o.source_event_id
 WHERE o.player_id = profile_player() AND (before_time IS NULL OR (o.earned_at, o.item_id) < (before_time, before_item))
 ORDER BY o.earned_at DESC, o.item_id DESC LIMIT least(greatest(coalesce(page_size, 30), 1), 101)
$$;
REVOKE ALL ON FUNCTION own_locker(timestamptz, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_locker(timestamptz, text, integer) TO questify_app;

-- Restated from 0074: each souvenir the event gave the player carries `presentedBy` ({name, tier} or null) beside the
-- item's own fields. Everything else is as 0074.
CREATE OR REPLACE FUNCTION event_recap(target uuid)
  RETURNS TABLE (status_now text, name jsonb, local_date text, city jsonb, rank integer, rank_state text,
                 quests_done integer, souvenirs jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT st.now,
         jsonb_build_object('ar', coalesce(e.name_ar, e.name_en), 'en', coalesce(e.name_en, e.name_ar)),
         to_char(coalesce(e.starts_at, e.created_at) AT TIME ZONE e.timezone, 'YYYY-MM-DD'),
         CASE WHEN c.id IS NOT NULL THEN jsonb_build_object('ar', c.name_ar, 'en', c.name_en) END,
         CASE WHEN r.revealed_at IS NOT NULL THEN f.rank END,
         CASE WHEN st.now NOT IN ('ended', 'archived') THEN 'live'
              WHEN r.revealed_at IS NULL THEN 'pending'
              WHEN f.rank IS NULL THEN 'unranked'
              ELSE 'final' END,
         (SELECT count(DISTINCT l.quest_id)::integer FROM ledger_entry l
          WHERE l.enrollment_id = n.id AND l.kind = 'quest'
            AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.kind = 'removal' AND x.reverses = l.id)),
         (SELECT coalesce(jsonb_agg(item_json(o.item_id)
                                    || jsonb_build_object('presentedBy', souvenir_presented_by(o.source_rule_id))
                                    ORDER BY o.earned_at, o.item_id), '[]'::jsonb)
          FROM player_item o
          WHERE o.player_id = n.player_id AND o.source = 'souvenir' AND o.source_event_id = e.id)
  FROM enrollment n JOIN event e ON e.id = n.event_id
  LEFT JOIN city c ON c.id = e.city_id
  LEFT JOIN event_result r ON r.event_id = e.id
  LEFT JOIN final_rank f ON f.event_id = e.id AND f.enrollment_id = n.id
  CROSS JOIN LATERAL (SELECT event_status_now(e.status, e.starts_at, e.ends_at) AS now) st
  WHERE n.event_id = target AND n.player_id = profile_player()
    AND n.status NOT IN ('pending', 'declined', 'banned', 'removed') AND n.joined_via IS DISTINCT FROM 'rehearsal'
$$;

-- ================================================================ duplicating an event (ADR-572)
-- Restated from 0098: a duplicate copies no souvenir rule, so it copies no souvenir tag. Everything else is as 0098.
CREATE OR REPLACE FUNCTION public.event_copy_extras(src event, tgt event, shift interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  day_shift integer := coalesce(event_day(tgt.starts_at, tgt) - event_day(src.starts_at, src), 0);
  who       uuid := app_staff_user_id();
  sessions  integer;
  maps      integer;
  pins      integer;
  sponsors  integer;
  tags      integer;
BEGIN
  INSERT INTO event_streak (event_id, organizer_id, enabled, bonus_points, closed_weekdays, closed_days)
  SELECT tgt.id, tgt.organizer_id, s.enabled, s.bonus_points, s.closed_weekdays,
         ARRAY(SELECT d + day_shift FROM unnest(s.closed_days) AS d ORDER BY d)
  FROM event_streak s WHERE s.event_id = src.id;

  INSERT INTO event_session (id, organizer_id, event_id, kind, title_ar, title_en, description_ar, description_en,
                             place_ar, place_en, speakers, starts_at, ends_at, access, seats, closes_at,
                             registration_open, walk_ins, reminder_minutes, quest_id, points, created_by)
  SELECT copy_id(s.id, tgt.id), tgt.organizer_id, tgt.id, s.kind, s.title_ar, s.title_en, s.description_ar,
         s.description_en, s.place_ar, s.place_en, s.speakers, s.starts_at + shift, s.ends_at + shift, s.access,
         s.seats, s.closes_at + shift, s.registration_open, s.walk_ins, s.reminder_minutes,
         CASE WHEN EXISTS (SELECT 1 FROM quest d WHERE d.id = s.quest_id AND d.deleted_at IS NOT NULL) THEN NULL ELSE copy_id(s.quest_id, tgt.id) END,
         s.points, who
  FROM event_session s WHERE s.event_id = src.id;
  GET DIAGNOSTICS sessions = ROW_COUNT;

  INSERT INTO event_map (id, organizer_id, event_id, name_ar, name_en, position, created_by)
  SELECT copy_id(m.id, tgt.id), tgt.organizer_id, tgt.id, m.name_ar, m.name_en, m.position, who
  FROM event_map m WHERE m.event_id = src.id;
  GET DIAGNOSTICS maps = ROW_COUNT;
  INSERT INTO map_pin (id, organizer_id, event_id, map_id, kind, amenity, name_ar, name_en, details_ar, details_en, x, y,
                       quest_id, created_by)
  SELECT copy_id(p.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(p.map_id, tgt.id), p.kind, p.amenity, p.name_ar,
         p.name_en, p.details_ar, p.details_en, p.x, p.y, copy_id(p.quest_id, tgt.id), who
  FROM map_pin p WHERE p.event_id = src.id AND NOT EXISTS (SELECT 1 FROM quest d WHERE d.id = p.quest_id AND d.deleted_at IS NOT NULL);
  GET DIAGNOSTICS pins = ROW_COUNT;

  INSERT INTO sponsor (id, organizer_id, event_id, name_ar, name_en, tier, booth, created_by)
  SELECT copy_id(s.id, tgt.id), tgt.organizer_id, tgt.id, s.name_ar, s.name_en, s.tier, s.booth, who
  FROM sponsor s WHERE s.event_id = src.id;
  GET DIAGNOSTICS sponsors = ROW_COUNT;
  -- A tag on a reward that was removed has nothing to point at, and a souvenir's rule is not copied.
  INSERT INTO sponsor_tag (id, organizer_id, event_id, sponsor_id, kind, quest_id, category_id, reward_id, created_by)
  SELECT copy_id(t.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(t.sponsor_id, tgt.id), t.kind,
         copy_id(t.quest_id, tgt.id), copy_id(t.category_id, tgt.id), copy_id(t.reward_id, tgt.id), who
  FROM sponsor_tag t
  WHERE t.event_id = src.id AND t.kind <> 'souvenir'
    AND NOT EXISTS (SELECT 1 FROM quest d WHERE d.id = t.quest_id AND d.deleted_at IS NOT NULL)
    AND (t.reward_id IS NULL OR EXISTS (SELECT 1 FROM reward r WHERE r.id = t.reward_id AND r.status = 'active'));
  GET DIAGNOSTICS tags = ROW_COUNT;

  INSERT INTO big_screen (event_id, organizer_id, scenes, updated_by)
  SELECT tgt.id, tgt.organizer_id, b.scenes, who FROM big_screen b WHERE b.event_id = src.id;

  RETURN jsonb_build_object('sessions', sessions, 'maps', maps, 'pins', pins, 'sponsors', sponsors,
                            'sponsorTags', tags);
END $$;

-- ================================================================ a sponsor's totals (ADR-573)
-- Restated from 0103 (FR-1306 names souvenirs): `souvenirs` lists the souvenirs tagged to the sponsor that are active or
-- stopped (a draft promised nothing yet) with how many players earned each, counted from the receipts. Exact counts and
-- no player; the API leaves out the counts a sponsor may not see. Everything else is as 0103.
CREATE OR REPLACE FUNCTION analytics_sponsor(target_event uuid, target_sponsor uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
  sp sponsor;
BEGIN
  SELECT s.* INTO sp FROM sponsor s WHERE s.id = target_sponsor AND s.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such sponsor in this event' USING ERRCODE = 'AN404';
  END IF;
  RETURN (
    WITH removed AS MATERIALIZED (
      SELECT x.completion_id FROM ledger_note t JOIN ledger_entry x ON x.id = t.entry_id
      WHERE t.event_id = ev.id AND t.bulk_id IS NULL AND x.kind = 'removal' AND x.completion_id IS NOT NULL),
    sel AS MATERIALIZED (
      SELECT q.id, q.title_ar, q.title_en, q.position, q.category_id,
             (EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.quest_id = q.id AND t.sponsor_id = sp.id)
              OR (NOT EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.quest_id = q.id)
                  AND EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.category_id = q.category_id
                              AND t.sponsor_id = sp.id))) AS own
      FROM quest q
      WHERE q.event_id = ev.id AND q.visible AND q.deleted_at IS NULL
        AND (EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.quest_id = q.id AND t.sponsor_id = sp.id)
             OR EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.category_id = q.category_id AND t.sponsor_id = sp.id))),
    standing AS MATERIALIZED (
      SELECT c.quest_id, c.enrollment_id FROM quest_completion c
      WHERE c.quest_id IN (SELECT s.id FROM sel s) AND c.id NOT IN (SELECT r.completion_id FROM removed r)),
    quests AS (
      SELECT s.id, s.title_ar, s.title_en, s.position,
             (SELECT count(DISTINCT d.enrollment_id) FROM standing d WHERE d.quest_id = s.id)::integer AS players
      FROM sel s WHERE s.own),
    categories AS (
      SELECT g.id, g.name_ar, g.name_en, g.position,
             (SELECT count(DISTINCT d.enrollment_id) FROM standing d JOIN sel s ON s.id = d.quest_id
              WHERE s.category_id = g.id)::integer AS players
      FROM category g
      WHERE g.event_id = ev.id AND EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.category_id = g.id AND t.sponsor_id = sp.id)),
    rewards AS (
      SELECT rw.id, rw.name_ar, rw.name_en, rw.position,
             (SELECT count(*) FROM redemption r WHERE r.reward_id = rw.id
                AND r.status IN ('reserved', 'delivered', 'handed_over'))::integer AS redeemed
      FROM reward rw
      WHERE rw.event_id = ev.id
        AND EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.reward_id = rw.id AND t.sponsor_id = sp.id)
        AND (rw.status = 'active' OR EXISTS (SELECT 1 FROM redemption r WHERE r.reward_id = rw.id
                                              AND r.status IN ('reserved', 'delivered', 'handed_over')))),
    souvenirs AS (
      SELECT v.id, i.name_ar, i.name_en, v.created_at,
             (SELECT count(*) FROM souvenir_receipt s WHERE s.rule_id = v.id)::integer AS earned
      FROM souvenir_rule v JOIN item i ON i.id = v.item_id
      WHERE v.event_id = ev.id AND v.status <> 'draft'
        AND EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.souvenir_id = v.id AND t.sponsor_id = sp.id))
    SELECT jsonb_build_object(
      'sponsor', jsonb_build_object('id', sp.id, 'name', jsonb_build_object('ar', sp.name_ar, 'en', sp.name_en)),
      'visits', (SELECT count(DISTINCT d.enrollment_id) FROM standing d JOIN sel s ON s.id = d.quest_id WHERE s.own),
      'completions', (SELECT count(*) FROM standing d JOIN sel s ON s.id = d.quest_id WHERE s.own),
      'redemptions', (SELECT coalesce(sum(w.redeemed), 0) FROM rewards w),
      'quests', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'id', x.id, 'title', jsonb_build_object('ar', x.title_ar, 'en', x.title_en), 'players', x.players)
          ORDER BY x.position, x.id) FROM quests x), '[]'::jsonb),
      'categories', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'id', x.id, 'name', jsonb_build_object('ar', x.name_ar, 'en', x.name_en), 'players', x.players)
          ORDER BY x.position, x.id) FROM categories x), '[]'::jsonb),
      'rewards', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'id', x.id, 'name', jsonb_build_object('ar', x.name_ar, 'en', x.name_en), 'redeemed', x.redeemed)
          ORDER BY x.position, x.id) FROM rewards x), '[]'::jsonb),
      'souvenirs', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'id', x.id, 'name', jsonb_build_object('ar', x.name_ar, 'en', x.name_en), 'earned', x.earned)
          ORDER BY x.created_at, x.id) FROM souvenirs x), '[]'::jsonb)));
END $$;
