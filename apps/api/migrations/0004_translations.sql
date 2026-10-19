-- Translation store (T-008): the texts a Questify admin has changed. The shipped texts live in the app;
-- a row here replaces one language of one key, and a missing language or a missing row means "use the shipped text".
-- Deny by default (docs/rules.md): forced row-level security, explicit grants, nothing for PUBLIC.

CREATE TABLE translation (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$'),
  ar         text CHECK (ar IS NULL OR btrim(ar) <> ''),
  en         text CHECK (en IS NULL OR btrim(en) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES staff_user (id),
  -- a row that changes neither language is deleted instead
  CHECK (ar IS NOT NULL OR en IS NOT NULL)
);
ALTER TABLE translation ENABLE ROW LEVEL SECURITY;
ALTER TABLE translation FORCE ROW LEVEL SECURITY;

-- Every app reads the texts before anyone signs in; only a Questify admin changes them.
CREATE POLICY translation_read ON translation FOR SELECT TO questify_app USING (true);
CREATE POLICY translation_insert ON translation FOR INSERT TO questify_app WITH CHECK (app_is_admin());
CREATE POLICY translation_update ON translation FOR UPDATE TO questify_app
  USING (app_is_admin()) WITH CHECK (app_is_admin());
CREATE POLICY translation_delete ON translation FOR DELETE TO questify_app USING (app_is_admin());

GRANT SELECT, INSERT, DELETE ON translation TO questify_app;
GRANT UPDATE (ar, en, updated_at, updated_by) ON translation TO questify_app;
