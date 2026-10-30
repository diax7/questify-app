-- T-507: sponsors (FR-1301 to FR-1305, FR-1307; plan docs/plans/2026-10-30-t-507-sponsors.md; ADR-375).
-- An owner or editor adds sponsor profiles to an event (a name, a tier, a booth) and tags quests, categories and rewards
-- to them. A tag is a row of its own, so the quest, category and reward tables, and every door that writes them, stay
-- untouched. A player reads the event's sponsors and the tags of the items they may see; the app shows "presented by" on
-- those items and a sponsor strip on Home. A sponsor holds no contact detail, no link, no login and no player data
-- (FR-1304): the table has none of those columns, and nothing written for a sponsor reads a player. The logo and the
-- banner are uploads and wait for a storage bucket (Q-149): T-507b adds their columns. Souvenirs are T-507c. Deny by
-- default: the two new tables keep row-level security forced and no grant; every function is closed to PUBLIC in the
-- group that creates it and only the doors are granted to the API role. No EXCEPTION block. Migrations 0087 and earlier
-- untouched.
SET LOCAL lock_timeout = '10s';
-- The event, the quest, the category and the reward are foreign-key targets of the new tables.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE quest IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE category IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE reward IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the tables (ADR-375 (2))
-- A sponsor. A name in one language is enough (the other shows in its place), as a map's is. The tier orders the strip
-- (platinum first, then gold, silver, bronze, partner; the same tier by when it was added). `booth` is the stand's
-- label as the sponsor's printed material gives it ("B14", "Hall 2"). At most 100 per event (the door counts).
CREATE TABLE sponsor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  name_ar      text CHECK (char_length(name_ar) BETWEEN 1 AND 60 AND name_ar !~ '[[:cntrl:]]'),
  name_en      text CHECK (char_length(name_en) BETWEEN 1 AND 60 AND name_en !~ '[[:cntrl:]]'),
  tier         text NOT NULL CHECK (tier IN ('platinum', 'gold', 'silver', 'bronze', 'partner')),
  booth        text CHECK (char_length(booth) BETWEEN 1 AND 40 AND booth !~ '[[:cntrl:]]'),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  UNIQUE (id, event_id),
  CONSTRAINT sponsor_name CHECK (name_ar IS NOT NULL OR name_en IS NOT NULL)
);
CREATE INDEX sponsor_event ON sponsor (event_id, created_at, id);
ALTER TABLE sponsor ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsor FORCE ROW LEVEL SECURITY;
REVOKE ALL ON sponsor FROM PUBLIC, questify_app;

-- A tag: one quest, category or reward of the sponsor's own event. An item has one sponsor at most (the unique indexes:
-- tagging it to another sponsor moves it). Deleting the sponsor, the quest, the category or the reward deletes the tag.
CREATE TABLE sponsor_tag (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  sponsor_id   uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('quest', 'category', 'reward')),
  quest_id     uuid,
  category_id  uuid,
  reward_id    uuid,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sponsor_id, event_id) REFERENCES sponsor (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (category_id, event_id) REFERENCES category (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (reward_id, event_id) REFERENCES reward (id, event_id) ON DELETE CASCADE,
  CONSTRAINT sponsor_tag_shape CHECK (
    (kind = 'quest' AND quest_id IS NOT NULL AND category_id IS NULL AND reward_id IS NULL)
    OR (kind = 'category' AND category_id IS NOT NULL AND quest_id IS NULL AND reward_id IS NULL)
    OR (kind = 'reward' AND reward_id IS NOT NULL AND quest_id IS NULL AND category_id IS NULL))
);
CREATE INDEX sponsor_tag_sponsor ON sponsor_tag (sponsor_id, created_at, id);
CREATE UNIQUE INDEX sponsor_tag_quest ON sponsor_tag (quest_id) WHERE quest_id IS NOT NULL;
CREATE UNIQUE INDEX sponsor_tag_category ON sponsor_tag (category_id) WHERE category_id IS NOT NULL;
CREATE UNIQUE INDEX sponsor_tag_reward ON sponsor_tag (reward_id) WHERE reward_id IS NOT NULL;
ALTER TABLE sponsor_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsor_tag FORCE ROW LEVEL SECURITY;
REVOKE ALL ON sponsor_tag FROM PUBLIC, questify_app;

-- ================================================================ helpers (internal: no grant)
-- The item a tag names, whichever kind it is.
CREATE FUNCTION sponsor_tag_target(t sponsor_tag) RETURNS uuid
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(t.quest_id, t.category_id, t.reward_id)
$$;
REVOKE ALL ON FUNCTION sponsor_tag_target(sponsor_tag) FROM PUBLIC;

-- The order the strip and the list use: the tier's rank, then when the sponsor was added.
CREATE FUNCTION sponsor_tier_rank(tier text) RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_position(ARRAY['platinum', 'gold', 'silver', 'bronze', 'partner']::text[], tier), 99)
$$;
REVOKE ALL ON FUNCTION sponsor_tier_rank(text) FROM PUBLIC;

-- A sponsor as the dashboard lists it with its tags. A reward that was removed from the shop is no longer listed.
CREATE FUNCTION sponsor_team_item(s sponsor) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'nameAr', s.name_ar, 'nameEn', s.name_en, 'tier', s.tier, 'booth', s.booth,
    'tags', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', t.kind, 'targetId', sponsor_tag_target(t))
                                       ORDER BY t.created_at, t.id)
                      FROM sponsor_tag t
                      WHERE t.sponsor_id = s.id
                        AND (t.kind <> 'reward'
                             OR EXISTS (SELECT 1 FROM reward r WHERE r.id = t.reward_id AND r.status = 'active'))),
                     '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION sponsor_team_item(sponsor) FROM PUBLIC;

-- The event's sponsors in the strip's order.
CREATE FUNCTION sponsor_team_list(target_event uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(sponsor_team_item(s) ORDER BY sponsor_tier_rank(s.tier), s.created_at, s.id), '[]'::jsonb)
  FROM sponsor s WHERE s.event_id = target_event
$$;
REVOKE ALL ON FUNCTION sponsor_team_list(uuid) FROM PUBLIC;

-- Whether a member may be shown a tag: only on an item they may see, so a hidden quest or category and a reward outside
-- their audience are never named. A quest follows the Quests tab's own rule (visible, opened, not closed, its category
-- seen), a category the category rule, a reward the shop's (active, in the member's audience).
CREATE FUNCTION sponsor_tag_shown(t sponsor_tag, member uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE t.kind
    WHEN 'quest' THEN member_sees_quest(member, t.quest_id)
    WHEN 'category' THEN EXISTS (SELECT 1 FROM category c
                                 WHERE c.id = t.category_id AND c.event_id = t.event_id AND sees_category(member, c))
    ELSE EXISTS (SELECT 1 FROM reward r
                 WHERE r.id = t.reward_id AND r.event_id = t.event_id AND r.status = 'active'
                   AND in_audience(member, r.audience_kind, r.audience_field_id, r.audience_values))
  END
$$;
REVOKE ALL ON FUNCTION sponsor_tag_shown(sponsor_tag, uuid) FROM PUBLIC;

-- The event's sponsor writes take turns: one advisory lock per event, so the cap and "an item has one sponsor" are
-- checked on a state nobody else is changing. It is the only lock a sponsor door takes before its own rows.
CREATE FUNCTION sponsor_lock(target_event uuid) RETURNS void
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('event-sponsors:' || target_event::text, 0))
$$;
REVOKE ALL ON FUNCTION sponsor_lock(uuid) FROM PUBLIC;

-- The caller's event for a write: AN404 when it is not theirs, SO409 `event_closed` when it is archived.
CREATE FUNCTION sponsor_event_for_write(target_event uuid) RETURNS event
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF ev.status = 'archived' THEN
    RAISE EXCEPTION 'the event is archived' USING ERRCODE = 'SO409', DETAIL = 'event_closed';
  END IF;
  PERFORM sponsor_lock(ev.id);
  RETURN ev;
END $$;
REVOKE ALL ON FUNCTION sponsor_event_for_write(uuid) FROM PUBLIC;

-- ================================================================ the team's doors (ADR-375 (3))
-- Whether the caller may write this event's sponsors: AN404 otherwise. The API asks before it replays a stored answer to
-- a retried write, so a team member whose access ended gets nothing back.
CREATE FUNCTION sponsor_authorize(target_event uuid) RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM award_event_of(target_event);
END $$;
REVOKE ALL ON FUNCTION sponsor_authorize(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sponsor_authorize(uuid) TO questify_app;

-- The event's sponsors with their tags. AN404 for an event that is not the caller's.
CREATE FUNCTION sponsor_list(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN sponsor_team_list(ev.id);
END $$;
REVOKE ALL ON FUNCTION sponsor_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sponsor_list(uuid) TO questify_app;

-- Adds a sponsor (`target_sponsor` NULL) or replaces one's fields. The draft holds nameAr and nameEn (one is enough), tier
-- and booth, already checked by the API. AN404, SO404 (no such sponsor in the event), PS422 (a field, as the detail),
-- SO409 (`event_closed`, `limit`: 100 sponsors). Audited `sponsor.save`.
CREATE FUNCTION sponsor_save(target_event uuid, draft jsonb, target_sponsor uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := sponsor_event_for_write(target_event);
  n_ar    text;
  n_en    text;
  level   text;
  stand   text;
  item    sponsor;
BEGIN
  IF jsonb_typeof(draft) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'check the sponsor' USING ERRCODE = 'PS422', DETAIL = 'sponsor';
  END IF;
  n_ar := session_text(draft, 'nameAr', 60, false);
  n_en := session_text(draft, 'nameEn', 60, false);
  IF n_ar IS NULL AND n_en IS NULL THEN
    RAISE EXCEPTION 'a sponsor needs a name' USING ERRCODE = 'PS422', DETAIL = 'name';
  END IF;
  level := CASE WHEN jsonb_typeof(draft -> 'tier') = 'string' THEN draft ->> 'tier' END;
  IF level IS NULL OR sponsor_tier_rank(level) = 99 THEN
    RAISE EXCEPTION 'choose the sponsor''s tier' USING ERRCODE = 'PS422', DETAIL = 'tier';
  END IF;
  stand := session_text(draft, 'booth', 40, false);
  IF target_sponsor IS NULL THEN
    IF (SELECT count(*) FROM sponsor s WHERE s.event_id = ev.id) >= 100 THEN
      RAISE EXCEPTION 'an event holds 100 sponsors at most' USING ERRCODE = 'SO409', DETAIL = 'limit';
    END IF;
    INSERT INTO sponsor (organizer_id, event_id, name_ar, name_en, tier, booth, created_by)
    VALUES (ev.organizer_id, ev.id, n_ar, n_en, level, stand, app_staff_user_id())
    RETURNING * INTO item;
  ELSE
    UPDATE sponsor s SET name_ar = n_ar, name_en = n_en, tier = level, booth = stand, updated_at = now()
    WHERE s.id = target_sponsor AND s.event_id = ev.id RETURNING s.* INTO item;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such sponsor in this event' USING ERRCODE = 'SO404';
    END IF;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'sponsor.save', 'sponsor', item.id::text,
          jsonb_build_object('created', target_sponsor IS NULL, 'tier', item.tier), request);
  RETURN sponsor_team_item(item);
END $$;
REVOKE ALL ON FUNCTION sponsor_save(uuid, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sponsor_save(uuid, jsonb, uuid, uuid) TO questify_app;

-- Deletes a sponsor with its tags. Answers how many tagged items lost it. AN404, SO404. Audited `sponsor.delete`.
CREATE FUNCTION sponsor_delete(target_event uuid, target_sponsor uuid, request uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := sponsor_event_for_write(target_event);
  lost integer;
BEGIN
  SELECT count(*)::integer INTO lost FROM sponsor_tag t WHERE t.sponsor_id = target_sponsor AND t.event_id = ev.id;
  DELETE FROM sponsor s WHERE s.id = target_sponsor AND s.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such sponsor in this event' USING ERRCODE = 'SO404';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'sponsor.delete', 'sponsor', target_sponsor::text,
          jsonb_build_object('tags', lost), request);
  RETURN lost;
END $$;
REVOKE ALL ON FUNCTION sponsor_delete(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sponsor_delete(uuid, uuid, uuid) TO questify_app;

-- Tags an item to a sponsor, or removes its sponsor (`target_sponsor` NULL). `tag_kind` is quest, category or reward
-- (PS422 `kind`); the item must be of this event (a reward also still in the shop), else SO404, and so must the sponsor.
-- An item tagged to another sponsor moves to this one. Answers the event's sponsors with their tags. Audited
-- `sponsor.tag`.
CREATE FUNCTION sponsor_tag_set(target_event uuid, tag_kind text, target_item uuid, target_sponsor uuid, request uuid)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := sponsor_event_for_write(target_event);
BEGIN
  IF tag_kind IS NULL OR tag_kind NOT IN ('quest', 'category', 'reward') THEN
    RAISE EXCEPTION 'check the tag''s kind' USING ERRCODE = 'PS422', DETAIL = 'kind';
  END IF;
  IF (tag_kind = 'quest' AND NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_item AND q.event_id = ev.id))
     OR (tag_kind = 'category' AND NOT EXISTS (SELECT 1 FROM category c WHERE c.id = target_item AND c.event_id = ev.id))
     OR (tag_kind = 'reward' AND NOT EXISTS (SELECT 1 FROM reward r
                                             WHERE r.id = target_item AND r.event_id = ev.id AND r.status = 'active'))
     OR (target_sponsor IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM sponsor s WHERE s.id = target_sponsor AND s.event_id = ev.id)) THEN
    RAISE EXCEPTION 'no such item or sponsor in this event' USING ERRCODE = 'SO404';
  END IF;
  DELETE FROM sponsor_tag t
  WHERE t.event_id = ev.id AND t.kind = tag_kind AND sponsor_tag_target(t) = target_item;
  IF target_sponsor IS NOT NULL THEN
    INSERT INTO sponsor_tag (organizer_id, event_id, sponsor_id, kind, quest_id, category_id, reward_id, created_by)
    VALUES (ev.organizer_id, ev.id, target_sponsor, tag_kind,
            CASE WHEN tag_kind = 'quest' THEN target_item END,
            CASE WHEN tag_kind = 'category' THEN target_item END,
            CASE WHEN tag_kind = 'reward' THEN target_item END,
            app_staff_user_id());
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'sponsor.tag', tag_kind, target_item::text,
          jsonb_build_object('sponsor', target_sponsor), request);
  RETURN sponsor_team_list(ev.id);
END $$;
REVOKE ALL ON FUNCTION sponsor_tag_set(uuid, text, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sponsor_tag_set(uuid, text, uuid, uuid, uuid) TO questify_app;

-- ================================================================ the player's door (ADR-375 (4))
-- The event's sponsors for an active member, in the strip's order, and the tags on the items the member may see (a tag
-- names the item and its sponsor and nothing else). It reads no row about the caller or any other player, and sends
-- nothing to a sponsor (FR-1304). AM403 for anyone who is not an active member of a non-archived event.
CREATE FUNCTION member_sponsors(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment := session_member(target_event);
BEGIN
  RETURN jsonb_build_object(
    'sponsors', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id,
               'name', jsonb_build_object('ar', coalesce(s.name_ar, s.name_en), 'en', coalesce(s.name_en, s.name_ar)),
               'tier', s.tier, 'booth', s.booth)
             ORDER BY sponsor_tier_rank(s.tier), s.created_at, s.id)
      FROM sponsor s WHERE s.event_id = target_event), '[]'::jsonb),
    'tags', coalesce((
      SELECT jsonb_agg(jsonb_build_object('kind', t.kind, 'targetId', sponsor_tag_target(t), 'sponsorId', t.sponsor_id)
                       ORDER BY t.created_at, t.id)
      FROM sponsor_tag t WHERE t.event_id = target_event AND sponsor_tag_shown(t, member.id)), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION member_sponsors(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_sponsors(uuid) TO questify_app;
