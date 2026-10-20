-- Categories and quests (T-103). Every quest sits in exactly one category of its own event (FR-228); every event has a
-- "General" category from the moment it exists. Deny by default (docs/rules.md): forced row-level security, column
-- grants, definer functions with a pinned search_path, nothing for PUBLIC. Players get no access yet: their read path
-- arrives with the completion engine (T-105) and the Quests tab (T-114).

-- ================================================================ tables
CREATE TABLE category (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES organizer (id),
  event_id     uuid NOT NULL REFERENCES event (id) ON DELETE CASCADE,
  name_ar      text CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en      text CHECK (length(name_en) BETWEEN 1 AND 120),
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (name_ar IS NOT NULL OR name_en IS NOT NULL),
  -- The target of the quest's composite key: a quest's category is always in the quest's own event.
  UNIQUE (event_id, id)
);
CREATE INDEX category_event_order ON category (event_id, position, id);

CREATE TABLE quest (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id   uuid NOT NULL REFERENCES organizer (id),
  event_id       uuid NOT NULL REFERENCES event (id) ON DELETE CASCADE,
  category_id    uuid NOT NULL,
  -- The types the app ships (packages/shared/src/quests/registry.ts); each quest task widens this list.
  type           text NOT NULL CONSTRAINT quest_type_known CHECK (type IN ('scan_qr', 'enter_code')),
  title_ar       text CHECK (length(title_ar) BETWEEN 1 AND 120),
  title_en       text CHECK (length(title_en) BETWEEN 1 AND 120),
  description_ar text CHECK (length(description_ar) BETWEEN 1 AND 2000),
  description_en text CHECK (length(description_en) BETWEEN 1 AND 2000),
  points         integer NOT NULL CHECK (points BETWEEN 0 AND 100000),
  repeat_cap     integer NOT NULL DEFAULT 1 CHECK (repeat_cap BETWEEN 1 AND 100),
  opens_at       timestamptz,
  closes_at      timestamptz,
  visible        boolean NOT NULL DEFAULT true,
  position       integer NOT NULL DEFAULT 0,
  type_config    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(type_config) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (title_ar IS NOT NULL OR title_en IS NOT NULL),
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at),
  -- Moving or deleting a category's quests is always explicit (FR-1004); the event's own delete cascades past this.
  FOREIGN KEY (event_id, category_id) REFERENCES category (event_id, id) ON DELETE RESTRICT
);
CREATE INDEX quest_category_order ON quest (category_id, position, id);
CREATE INDEX quest_event ON quest (event_id);

-- ================================================================ the organizer comes from the event
-- Never trusted from the API: a forged event id of another organizer gets that organizer's id here, which the
-- insert policy then refuses.
CREATE FUNCTION set_organizer_from_event() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT organizer_id INTO NEW.organizer_id FROM event WHERE id = NEW.event_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION set_organizer_from_event() FROM PUBLIC;
CREATE TRIGGER category_organizer BEFORE INSERT ON category
  FOR EACH ROW EXECUTE FUNCTION set_organizer_from_event();
CREATE TRIGGER quest_organizer BEFORE INSERT ON quest
  FOR EACH ROW EXECUTE FUNCTION set_organizer_from_event();

CREATE FUNCTION quest_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_touch() FROM PUBLIC;
CREATE TRIGGER quest_touch BEFORE UPDATE ON quest FOR EACH ROW EXECUTE FUNCTION quest_touch();

-- ================================================================ an ended event's quests are history
-- Judged on the status now (event_status_now, migration 0009), for the API's role, which reads its own event under
-- row-level security; the owner connection and the event's own cascade (a draft) never meet it.
CREATE FUNCTION quest_closed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END;
BEGIN
  IF current_user = 'questify_app' AND EXISTS (
       SELECT 1 FROM event e
       WHERE e.id = target AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('ended', 'archived')
     ) THEN
    RAISE EXCEPTION 'an ended event''s categories and quests do not change' USING ERRCODE = 'QE409';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION quest_closed_guard() FROM PUBLIC;
CREATE TRIGGER category_closed_guard BEFORE INSERT OR UPDATE OR DELETE ON category
  FOR EACH ROW EXECUTE FUNCTION quest_closed_guard();
CREATE TRIGGER quest_closed_guard BEFORE INSERT OR UPDATE OR DELETE ON quest
  FOR EACH ROW EXECUTE FUNCTION quest_closed_guard();

-- ================================================================ the General category (FR-228)
CREATE FUNCTION add_general_category() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO category (event_id, name_ar, name_en, position) VALUES (NEW.id, 'عام', 'General', 0);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION add_general_category() FROM PUBLIC;
CREATE TRIGGER add_general_category AFTER INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION add_general_category();

INSERT INTO category (organizer_id, event_id, name_ar, name_en, position)
SELECT organizer_id, id, 'عام', 'General', 0 FROM event;

-- ================================================================ who may do what
ALTER TABLE category ENABLE ROW LEVEL SECURITY;
ALTER TABLE category FORCE ROW LEVEL SECURITY;
ALTER TABLE quest ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest FORCE ROW LEVEL SECURITY;
REVOKE ALL ON category, quest FROM PUBLIC;

GRANT SELECT, DELETE ON category, quest TO questify_app;
GRANT INSERT (event_id, name_ar, name_en, position) ON category TO questify_app;
GRANT UPDATE (name_ar, name_en, position) ON category TO questify_app;
GRANT INSERT (event_id, category_id, type, title_ar, title_en, description_ar, description_en, points, repeat_cap,
              opens_at, closes_at, visible, position, type_config) ON quest TO questify_app;
-- The type is fixed once created: a different type is a different quest.
GRANT UPDATE (category_id, title_ar, title_en, description_ar, description_en, points, repeat_cap, opens_at,
              closes_at, visible, position, type_config) ON quest TO questify_app;

CREATE POLICY category_member ON category FOR ALL TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin())
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());
CREATE POLICY quest_member ON quest FOR ALL TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin())
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());
