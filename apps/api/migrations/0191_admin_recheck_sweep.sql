-- Audit hardening, the admin re-check sweep (0189 hunter-tenant 4 and its CTO NIT; 0190 w2-seats 2 and its CTO NIT;
-- plan docs/plans/2026-11-11-admin-recheck-sweep.md, decisions in its section 8). No table, grant, route or string.
-- The request's admin flag alone (`app_is_admin()`, the `app.is_admin` setting) opens no row-level policy and no
-- trigger or definer gate any more: each asks `app_admin_id()`, which confirms an active platform admin account behind
-- the flag. Each object is restated from its latest definition with its signature, owner and grants unchanged
-- (CREATE OR REPLACE and ALTER POLICY keep them; ALTER POLICY keeps the name, command and roles):
--   app_admin_id()               from 0027  PL/pgSQL now (docs/rules.md); NULL at once when the flag is off
--   53 policies (ALTER POLICY)   from 0002, 0003, 0005, 0006, 0008, 0009, 0010, 0012, 0018, 0019, 0024 to 0028,
--                                0030, 0032, 0034, 0045, 0047, 0114, 0116, 0121, 0134, 0136, 0141, 0189 (one line
--                                each below): the 42 that read `app_is_admin()` and the 11 that asked
--                                `app_admin_id() IS NOT NULL` once per row now ask `(SELECT app_admin_id()) IS NOT
--                                NULL`, an uncorrelated InitPlan run once per query; nothing else in them changes
--   enrollment_status_guard()    from 0019  the flag becomes `app_admin_id() IS NOT NULL`
--   event_spend_rank_guard()     from 0025  the same
--   player_status_guard()        from 0038  the same (`AND app_admin_id() IS NULL`)
--   rank_prize_guard()           from 0034  the same
--   results_frozen(uuid)         from 0034  PL/pgSQL now; the admin is read once, before the query
--   ranking_system()             from 0015  PL/pgSQL now; also refuses a device seat (`app_device_id() IS NULL`), so
--                                           the nine gates without a device test of their own (0015, 0035, 0050,
--                                           0053, 0098, 0144) refuse a kiosk, a station, a screen or a forged id
--   preview_device(bytea, uuid)  from 0189  one read of the operator's assignment, not two
--   play_event_id(text, text)    from 0190  the local `found` (which shadowed PL/pgSQL's FOUND) is `owner_event`
-- Three refusals keep the bare flag on purpose, since `app_admin_id()` would refuse fewer seats: ranking_system
-- (`NOT app_is_admin()`), souvenir_event (0064) and invitation_team_event (0073) (`OR app_is_admin()` refuses).
-- test/db/admin-recheck-catalog.int.test.ts fails on any other function, policy, view, trigger condition, check or
-- default that reads the flag.
--
-- Recursion: `staff_user_own` is `TO questify_app` and now calls `app_admin_id()`, which reads staff_user as the
-- function's owner; the owner is not questify_app, so the policy does not apply to that read and nothing recurses.
-- staff_user is FORCE ROW LEVEL SECURITY (0001), so that read sees rows only because the owner is a superuser or
-- BYPASSRLS. That need is not new: 0027's app_admin_id already had it, and CranL's owner `admin` is a superuser
-- (OPEN_QUESTIONS.md Q-188, RUNBOOK "Database and deploy"). The block below stops the migration when it does not hold,
-- as 0053 does for its own need.
--
-- Locks (ADR-580, as 0146): lock_timeout 1 s, below the app pool's 2 s (src/db/pool-options.ts). ALTER POLICY takes
-- ACCESS EXCLUSIVE on its table until commit, so every touched table is locked once up front in one fixed order, the
-- coldest first and the hottest (event, enrollment, ledger_entry, quest_completion, player, audit_log) last; nothing
-- upgrades a lock mid-file. A clash is 55P03 or 40P01, which the runner retries (src/db/migrate.ts). Not deployed
-- during a live event's peak (RUNBOOK). Catalog-only: no rewrite, no index, no data change; signatures unchanged, so
-- the running API works before and after (every admin context in src carries the admin's own staffUserId).
--
-- Before the policies change, their deparsed text is kept in a temporary table; after, a check raises unless every
-- policy is its old text with only the flag (and the bare `app_admin_id() IS NOT NULL`) replaced by the InitPlan form.
-- 0190 and earlier untouched; 0156 stays reserved.
SET LOCAL lock_timeout = '1s';

-- ================================================================ the owner can read staff_user
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user)
     OR NOT (SELECT r.rolsuper OR r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
             WHERE p.oid = 'app_admin_id()'::regprocedure) THEN
    RAISE EXCEPTION 'the migration owner % can not read staff_user past its row-level security', current_user
      USING HINT = 'app_admin_id() reads staff_user (FORCE ROW LEVEL SECURITY) as its owner: run the migrations as a '
                   'superuser or a BYPASSRLS role, and keep that role the owner of app_admin_id() (RUNBOOK).';
  END IF;
END $$;

LOCK TABLE
  bulk_award, category, content_hold, event_activation_request, event_entitlement, event_exclusion, event_guest,
  event_join_field, event_limit_alert, event_rehearsal, feature_request, join_answer, ledger_note, operator_invite,
  organizer_acceptance, organizer_feature_override, organizer_invite, passport_step, platform_setting, quest_item,
  rank_prize, reward_code, translation, organizer_member, player_contact, staff_assignment, staff_user, staff_session,
  reward, redemption, quest,
  event, enrollment, ledger_entry, quest_completion, player, audit_log
  IN ACCESS EXCLUSIVE MODE;

-- ================================================================ the re-check itself
-- As 0027, in PL/pgSQL (docs/rules.md: a definer with a SET clause on a request path): the flag off answers NULL at
-- once, without reading staff_user; on, the caller's own account, still an active platform admin. NULL otherwise.
CREATE OR REPLACE FUNCTION app_admin_id() RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin uuid;
BEGIN
  IF NOT app_is_admin() THEN
    RETURN NULL;
  END IF;
  SELECT s.id INTO admin FROM staff_user s
  WHERE s.id = app_staff_user_id() AND s.platform_role = 'admin' AND s.status = 'active';
  RETURN admin;
END $$;

-- ================================================================ the policies
-- Their text before, for the check after the last ALTER POLICY.
CREATE TEMP TABLE before_0191 ON COMMIT DROP AS
  SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public';

-- Each statement is its source's USING and WITH CHECK verbatim, with `app_is_admin()` and `app_admin_id() IS NOT NULL`
-- written `(SELECT app_admin_id()) IS NOT NULL`. Grouped by the migration that last defined them (name :line).
-- from 0002: session_read :74
ALTER POLICY session_read ON staff_session
  USING (staff_user_id = app_staff_user_id()
         OR (SELECT app_admin_id()) IS NOT NULL OR token_hash = app_session_token_hash());

-- from 0003: entitlement_insert :44, entitlement_delete :46
ALTER POLICY entitlement_insert ON event_entitlement
  WITH CHECK ((SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY entitlement_delete ON event_entitlement
  USING ((SELECT app_admin_id()) IS NOT NULL);

-- from 0005: player_contact_own :24, member_read :147, member_update :153
ALTER POLICY player_contact_own ON player_contact
  USING (player_id = app_player_id() OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK (player_id = app_player_id() OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY member_read ON organizer_member
  USING (organizer_id = app_organizer_id() OR staff_user_id = app_staff_user_id()
         OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY member_update ON organizer_member
  USING ((SELECT app_admin_id()) IS NOT NULL OR (app_is_owner(organizer_id) AND staff_user_id <> app_staff_user_id()))
  WITH CHECK ((SELECT app_admin_id()) IS NOT NULL OR (app_is_owner(organizer_id) AND role = 'editor'));

-- from 0006: audit_insert :34
ALTER POLICY audit_insert ON audit_log
  WITH CHECK (
    (
      (actor_type = 'admin' AND (SELECT app_admin_id()) IS NOT NULL AND actor_id = app_staff_user_id())
      OR (actor_type = 'staff' AND actor_id = app_staff_user_id()
          AND (organizer_id IS NULL OR organizer_id = app_organizer_id()))
    )
    AND (event_id IS NULL
         OR EXISTS (SELECT 1 FROM event e WHERE e.id = audit_log.event_id AND e.organizer_id = audit_log.organizer_id))
  );

-- from 0008: event_read :58, event_write :66, event_update :68, enrollment_read :77, audit_read :112,
--            member_delete :126, acceptance_read :144, invite_read :278
ALTER POLICY event_read ON event
  USING (
    (organizer_id = app_organizer_id() AND in_event_scope(id, app_event_scope()))
    OR (SELECT app_admin_id()) IS NOT NULL
    OR (access = 'public' AND status IN ('scheduled', 'live', 'ended'))
    OR EXISTS (SELECT 1 FROM enrollment e WHERE e.event_id = event.id AND e.player_id = app_player_id())
  );
ALTER POLICY event_write ON event
  WITH CHECK ((organizer_id = app_organizer_id() AND app_event_scope() IS NULL) OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY event_update ON event
  USING ((organizer_id = app_organizer_id() AND in_event_scope(id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(id, app_event_scope()))
              OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY enrollment_read ON enrollment
  USING (
    (organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
    OR player_id = app_player_id() OR (SELECT app_admin_id()) IS NOT NULL
  );
ALTER POLICY audit_read ON audit_log
  USING (
    (organizer_id = app_organizer_id()
     AND (event_id IS NULL OR in_event_scope(event_id, app_event_scope())))
    OR (SELECT app_admin_id()) IS NOT NULL
  );
ALTER POLICY member_delete ON organizer_member
  USING (
    (SELECT app_admin_id()) IS NOT NULL
    OR (app_is_owner(organizer_id) AND staff_user_id <> app_staff_user_id())
    OR (staff_user_id = app_staff_user_id() AND role = 'editor')
  );
ALTER POLICY acceptance_read ON organizer_acceptance
  USING (organizer_id = app_organizer_id() OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY invite_read ON organizer_invite
  USING (organizer_id = app_organizer_id() OR token_hash = app_invite_token_hash()
         OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0009: event_delete :96
ALTER POLICY event_delete ON event
  USING ((organizer_id = app_organizer_id() AND in_event_scope(id, app_event_scope()) AND status = 'draft')
         OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0010: category_member :123, quest_member :126
ALTER POLICY category_member ON category
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
              OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY quest_member ON quest
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
              OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0012: quest_completion_read :118, ledger_entry_read :122
ALTER POLICY quest_completion_read ON quest_completion
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL
         OR enrollment_id IN (SELECT id FROM enrollment WHERE player_id = app_player_id()));
ALTER POLICY ledger_entry_read ON ledger_entry
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL
         OR enrollment_id IN (SELECT id FROM enrollment WHERE player_id = app_player_id()));

-- from 0018: enrollment_insert :11
ALTER POLICY enrollment_insert ON enrollment
  WITH CHECK ((SELECT app_admin_id()) IS NOT NULL);

-- from 0019: player_own :9, enrollment_update :56, event_exclusion_read :125
ALTER POLICY player_own ON player
  USING (id = app_player_id() OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK (id = app_player_id() OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY enrollment_update ON enrollment
  USING (player_id = app_player_id() OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK (player_id = app_player_id() OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY event_exclusion_read ON event_exclusion
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0024: reward_member :133, redemption_read :136
ALTER POLICY reward_member ON reward
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
              OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY redemption_read ON redemption
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0025: reward_code_read :90
ALTER POLICY reward_code_read ON reward_code
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0026: staff_assignment_read :103, operator_invite_read :108
ALTER POLICY staff_assignment_read ON staff_assignment
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL OR player_id = app_player_id());
ALTER POLICY operator_invite_read ON operator_invite
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0027: activation_request_read :41, limit_alert_read :59
ALTER POLICY activation_request_read ON event_activation_request
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY limit_alert_read ON event_limit_alert
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0028: event_join_field_team :86, join_answer_read :111, event_guest_team :156
ALTER POLICY event_join_field_team ON event_join_field
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
              OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY join_answer_read ON join_answer
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL
         OR enrollment_id IN (SELECT n.id FROM enrollment n WHERE n.player_id = app_player_id()));
ALTER POLICY event_guest_team ON event_guest
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
              OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0030: bulk_award_read :124, ledger_note_read :126
ALTER POLICY bulk_award_read ON bulk_award
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY ledger_note_read ON ledger_note
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0032: event_rehearsal_read :54
ALTER POLICY event_rehearsal_read ON event_rehearsal
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0034: rank_prize_member :82
ALTER POLICY rank_prize_member ON rank_prize
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
              OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0045: passport_step_member :77
ALTER POLICY passport_step_member ON passport_step
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
              OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0047: quest_item_member :41
ALTER POLICY quest_item_member ON quest_item
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL)
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
              OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0114: staff_user_own :18
ALTER POLICY staff_user_own ON staff_user
  USING (id = app_staff_user_id() OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0116: translation_insert :13, translation_update :15, translation_delete :17
ALTER POLICY translation_insert ON translation
  WITH CHECK ((SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY translation_update ON translation
  USING ((SELECT app_admin_id()) IS NOT NULL) WITH CHECK ((SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY translation_delete ON translation
  USING ((SELECT app_admin_id()) IS NOT NULL);

-- from 0121: content_hold_team :49
ALTER POLICY content_hold_team ON content_hold
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR (SELECT app_admin_id()) IS NOT NULL);

-- from 0134: platform_setting_insert :15, platform_setting_update :17
ALTER POLICY platform_setting_insert ON platform_setting
  WITH CHECK ((SELECT app_admin_id()) IS NOT NULL AND key IN ('features', 'tuning', 'maintenance', 'banner'));
ALTER POLICY platform_setting_update ON platform_setting
  USING ((SELECT app_admin_id()) IS NOT NULL AND key IN ('features', 'tuning', 'maintenance', 'banner'))
  WITH CHECK ((SELECT app_admin_id()) IS NOT NULL AND key IN ('features', 'tuning', 'maintenance', 'banner'));

-- from 0136: feature_override_read :33, feature_override_insert :36, feature_override_update :38,
--            feature_override_delete :40
ALTER POLICY feature_override_read ON organizer_feature_override
  USING ((SELECT app_admin_id()) IS NOT NULL
         OR EXISTS (SELECT 1 FROM event e WHERE e.organizer_id = organizer_feature_override.organizer_id));
ALTER POLICY feature_override_insert ON organizer_feature_override
  WITH CHECK ((SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY feature_override_update ON organizer_feature_override
  USING ((SELECT app_admin_id()) IS NOT NULL) WITH CHECK ((SELECT app_admin_id()) IS NOT NULL);
ALTER POLICY feature_override_delete ON organizer_feature_override
  USING ((SELECT app_admin_id()) IS NOT NULL);

-- from 0141: feature_request_close :243
ALTER POLICY feature_request_close ON feature_request
  USING ((SELECT app_admin_id()) IS NOT NULL AND status = 'open')
  WITH CHECK ((SELECT app_admin_id()) IS NOT NULL AND status IN ('allowed', 'declined'));

-- from 0189: feature_request_read :64
ALTER POLICY feature_request_read ON feature_request
  USING ((SELECT app_admin_id()) IS NOT NULL
         OR (organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())));

-- Every policy is its text before with only the flag, and the bare re-check, written as the InitPlan (the deparsed form
-- below, taken from pg_policies); no policy came or went, and the others are identical.
DO $$
DECLARE
  initplan constant text := '(( SELECT app_admin_id() AS app_admin_id) IS NOT NULL)';
  changed  text;
BEGIN
  SELECT string_agg(coalesce(b.tablename, a.tablename) || '.' || coalesce(b.policyname, a.policyname), ', ')
  INTO changed
  FROM before_0191 b
  FULL JOIN (SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public') a
    ON a.tablename = b.tablename AND a.policyname = b.policyname
  WHERE a.policyname IS NULL OR b.policyname IS NULL
     OR a.qual IS DISTINCT FROM replace(replace(b.qual, 'app_is_admin()', initplan),
                                        '(app_admin_id() IS NOT NULL)', initplan)
     OR a.with_check IS DISTINCT FROM replace(replace(b.with_check, 'app_is_admin()', initplan),
                                              '(app_admin_id() IS NOT NULL)', initplan);
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0191 changed more than the admin check, or missed one: %', changed;
  END IF;
END $$;

-- ================================================================ the guards
-- As 0019: a status change by the API's role needs an active admin account, not the flag alone.
CREATE OR REPLACE FUNCTION enrollment_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A wall for the API's own role; the owner connection (migrations, the staff CLI, definers, support work) is trusted.
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF app_admin_id() IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF OLD.player_id = app_player_id() AND OLD.status IN ('pending', 'active') AND NEW.status = 'left' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'this change of enrollment status is not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- As 0025: the owner's choice, or an active admin's.
CREATE OR REPLACE FUNCTION event_spend_rank_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF NOT (app_admin_id() IS NOT NULL OR app_is_owner(OLD.organizer_id)) THEN
    RAISE EXCEPTION 'only the owner changes this' USING ERRCODE = 'QO403';
  END IF;
  IF event_status_now(OLD.status, OLD.starts_at, OLD.ends_at) IN ('live', 'ended', 'archived') THEN
    RAISE EXCEPTION 'spending lowers rank is locked once the event is live' USING ERRCODE = 'QE409';
  END IF;
  RETURN NEW;
END $$;

-- As 0038: a player's status only by an active admin (the API role holds no grant on the column today; this is the
-- second wall).
CREATE OR REPLACE FUNCTION player_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A wall for the API's own role; the owner connection (migrations, definers, support work) is trusted.
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
     AND app_admin_id() IS NULL
  THEN
    RAISE EXCEPTION 'only a Questify admin can change a player''s status' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- As 0034: a write outside the caller's own events (an active admin's aside) is left to row-level security.
CREATE OR REPLACE FUNCTION rank_prize_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev event%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rank_prize:' || NEW.event_id::text, 0));
  IF current_user = 'questify_app' THEN
    -- A write outside the caller's own events is left to row-level security, which refuses it.
    SELECT * INTO ev FROM event e WHERE e.id = NEW.event_id;
    IF NOT FOUND OR ((ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope()))
                     OR app_admin_id() IS NOT NULL) IS NOT TRUE THEN
      RETURN NEW;
    END IF;
    IF results_frozen(ev.id) THEN
      RAISE EXCEPTION 'the results are final' USING ERRCODE = 'RF409', DETAIL = 'results_final';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'removed' THEN
      RAISE EXCEPTION 'a removed rank prize does not change' USING ERRCODE = 'RF409', DETAIL = 'removed';
    END IF;
    IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('live', 'ended', 'archived')
       AND (TG_OP = 'INSERT' OR NEW.rank_from <> OLD.rank_from OR NEW.rank_to <> OLD.rank_to
            OR NEW.status <> OLD.status) THEN
      RAISE EXCEPTION 'rank prizes are locked once the event is live' USING ERRCODE = 'RF409', DETAIL = 'prizes_locked';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.kind = 'item' AND ev.desk_location_ar IS NULL AND ev.desk_location_en IS NULL THEN
      RAISE EXCEPTION 'set the prize desk before adding item prizes' USING ERRCODE = 'DL409';
    END IF;
  END IF;
  IF NEW.status = 'active' AND EXISTS (
    SELECT 1 FROM rank_prize p
    WHERE p.event_id = NEW.event_id AND p.status = 'active' AND p.id <> NEW.id
      AND int4range(p.rank_from, p.rank_to, '[]') && int4range(NEW.rank_from, NEW.rank_to, '[]')) THEN
    RAISE EXCEPTION 'another prize covers these ranks' USING ERRCODE = 'RF409', DETAIL = 'overlap';
  END IF;
  RETURN NEW;
END $$;

-- As 0034, in PL/pgSQL: whether the caller's own organizer's event (or, for an active admin, any event) has confirmed
-- results. The admin is read once, before the query (docs/rules.md: no SET-clause function inside a query).
CREATE OR REPLACE FUNCTION results_frozen(target uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  by_admin boolean := app_admin_id() IS NOT NULL;
  frozen   boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM event_result x
                 WHERE x.event_id = target AND (x.organizer_id = app_organizer_id() OR by_admin))
  INTO frozen;
  RETURN frozen;
END $$;

-- ================================================================ the system's own context
-- As 0015, in PL/pgSQL, with one change: no device either, so a kiosk's, a station's or a screen's context (or a forged
-- device id) passes no system gate. The flag stays bare here: it is a refusal, and `app_admin_id()` would refuse fewer
-- seats. The app runs the system's work in an empty context (src/ranking/ranking.ts, src/events/tick.ts,
-- src/plays/quizzes.ts), which still passes.
CREATE OR REPLACE FUNCTION ranking_system() RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN app_player_id() IS NULL AND app_organizer_id() IS NULL AND app_staff_user_id() IS NULL
    AND app_device_id() IS NULL AND NOT app_is_admin();
END $$;

-- ================================================================ the operator's preview, one read
-- As 0189, with the operator's assignment read once (UNIQUE (event_id, player_id), 0026): none is OP403, one without a
-- pairing ability OA403. `abilities` is NOT NULL.
CREATE OR REPLACE FUNCTION preview_device(code bytea, target_event uuid)
  RETURNS TABLE (kind text, client text, expires_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event%ROWTYPE;
  req     device_request%ROWTYPE;
  granted text[];
BEGIN
  IF app_player_id() IS NOT NULL THEN
    SELECT sa.abilities INTO granted FROM staff_assignment sa
    WHERE sa.event_id = target_event AND sa.player_id = app_player_id();
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
    END IF;
    IF NOT (granted && ARRAY['scan_quests', 'show_rotating_qr']) THEN
      RAISE EXCEPTION 'pairing is off for this operator' USING ERRCODE = 'OA403';
    END IF;
    SELECT * INTO ev FROM event e WHERE e.id = target_event;
  ELSE
    ev := award_event_of(target_event);
  END IF;
  req := device_request_of(code, ev, false);
  RETURN QUERY SELECT req.kind, req.client, req.expires_at;
END $$;

-- ================================================================ the event an object id names
-- As 0190, with its local `found` renamed `owner_event`: it shadowed PL/pgSQL's FOUND. Nothing else changes.
CREATE OR REPLACE FUNCTION play_event_id(kind text, ref text) RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  owner_event uuid;
  target      uuid;
  serial      bigint;
BEGIN
  IF kind = 'join_code' THEN
    SELECT e.id INTO owner_event FROM event e WHERE lower(e.join_code) = lower(play_event_id.ref);
    RETURN owner_event;
  END IF;
  IF kind IN ('game_round', 'meet_pass') THEN
    IF ref !~ '^[1-9][0-9]{0,17}$' THEN
      RETURN NULL;
    END IF;
    serial := ref::bigint;
    IF kind = 'game_round' THEN
      SELECT g.event_id INTO owner_event FROM game_round g WHERE g.id = serial;
    ELSE
      SELECT m.event_id INTO owner_event FROM meet_pass m WHERE m.id = serial;
    END IF;
    RETURN owner_event;
  END IF;
  IF ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  target := ref::uuid;
  IF kind = 'quest' THEN
    SELECT q.event_id INTO owner_event FROM quest q WHERE q.id = target;
  ELSIF kind = 'step' THEN
    SELECT s.event_id INTO owner_event FROM passport_step s WHERE s.id = target;
  ELSIF kind = 'category' THEN
    SELECT c.event_id INTO owner_event FROM category c WHERE c.id = target;
  ELSIF kind = 'reward' THEN
    SELECT r.event_id INTO owner_event FROM reward r WHERE r.id = target;
  ELSIF kind = 'session' THEN
    SELECT x.event_id INTO owner_event FROM event_session x WHERE x.id = target;
  ELSIF kind = 'desk_sale' THEN
    SELECT d.event_id INTO owner_event FROM desk_sale d WHERE d.id = target;
  ELSIF kind = 'redemption' THEN
    SELECT p.event_id INTO owner_event FROM redemption p WHERE p.id = target;
  END IF;
  RETURN owner_event;
END $$;
