-- Translation matrix editor (T-702): the store's writes check the admin in the database, not only the request's flag.
-- Until now a write needed `app_is_admin()`, the flag the API sets from the signed-in account; the policies below ask
-- `app_admin_id()` (migration 0027), which also confirms the account is still an active platform admin, so an admin who
-- was retired after signing in cannot change a text with a session that has not ended yet.
-- Reads stay open: every app downloads the texts before anyone signs in.

GRANT EXECUTE ON FUNCTION app_admin_id() TO questify_app;

DROP POLICY translation_insert ON translation;
DROP POLICY translation_update ON translation;
DROP POLICY translation_delete ON translation;

CREATE POLICY translation_insert ON translation FOR INSERT TO questify_app
  WITH CHECK (app_admin_id() IS NOT NULL);
CREATE POLICY translation_update ON translation FOR UPDATE TO questify_app
  USING (app_admin_id() IS NOT NULL) WITH CHECK (app_admin_id() IS NOT NULL);
CREATE POLICY translation_delete ON translation FOR DELETE TO questify_app
  USING (app_admin_id() IS NOT NULL);
