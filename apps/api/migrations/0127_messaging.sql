-- T-706: the message templates with their CST rules and the support contact details (FR-1780, FR-1731; plan note
-- docs/plans/2026-11-03-t-706-messaging.md; ADR-460 to ADR-462).
-- `message_template` holds the four templates an admin edits: the login-code SMS and the promotional SMS, email and push
-- (the senders read them from T-706b on). `support_contact` is one row: the WhatsApp number, the phone number and the
-- email the contact page, the app and the legal drafts show. Both are written only by admin-checked, audited doors.
-- The compliance floor holds in the table too, so no write path can break it: a promotional SMS or email without the
-- opt-out placeholder, and a login-code SMS without its code, cannot exist. The wording rules (purpose, brand, SMS
-- parts) live in the shared package, as the invitation name rule does; the door checks the structure again.
-- Deny by default: both tables are closed to every role (RLS forced, no grant), PUBLIC holds EXECUTE on nothing; the
-- public read of the contact and the admin doors go to questify_app only; every admin door starts with console_admin()
-- (QE403). Earlier migrations untouched; nothing here touches points, XP, sign-in or any tenant's data.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the message templates (FR-1780)
CREATE TABLE message_template (
  key        text PRIMARY KEY CHECK (key IN ('login_code_sms', 'promo_sms', 'promo_email', 'promo_push')),
  title_ar   text CHECK (title_ar IS NULL OR char_length(title_ar) BETWEEN 1 AND 150),
  title_en   text CHECK (title_en IS NULL OR char_length(title_en) BETWEEN 1 AND 150),
  body_ar    text NOT NULL CHECK (char_length(body_ar) BETWEEN 1 AND 4000),
  body_en    text NOT NULL CHECK (char_length(body_en) BETWEEN 1 AND 4000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- SMS has no title; email and push have one in both languages.
  CONSTRAINT message_template_title CHECK (
    (key IN ('login_code_sms', 'promo_sms') AND title_ar IS NULL AND title_en IS NULL)
    OR (key IN ('promo_email', 'promo_push') AND title_ar IS NOT NULL AND title_en IS NOT NULL)),
  -- A promotional SMS or email always carries the opt-out link (CST, FR-1114); a login code SMS always carries its code.
  CONSTRAINT message_template_opt_out CHECK (
    key NOT IN ('promo_sms', 'promo_email')
    OR (position('{optOutUrl}' IN body_ar) > 0 AND position('{optOutUrl}' IN body_en) > 0)),
  CONSTRAINT message_template_code CHECK (
    key <> 'login_code_sms' OR (position('{code}' IN body_ar) > 0 AND position('{code}' IN body_en) > 0))
);
ALTER TABLE message_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_template FORCE ROW LEVEL SECURITY;
REVOKE ALL ON message_template FROM PUBLIC, questify_app;

INSERT INTO message_template (key, title_ar, title_en, body_ar, body_en) VALUES
  ('login_code_sms', NULL, NULL,
   'رمز الدخول إلى كويستفاي: {code}. لا تشاركه مع أحد.',
   'Your Questify sign-in code is {code}. Do not share it.'),
  ('promo_sms', NULL, NULL,
   E'كويستفاي: عرض جديد بانتظارك.\nإيقاف العروض: {optOutUrl}',
   E'Questify: a new offer is waiting for you.\nStop offers: {optOutUrl}'),
  ('promo_email', 'عروض جديدة من كويستفاي', 'New offers from Questify',
   E'لدينا عرض جديد لك في كويستفاي.\n\nلإيقاف رسائل العروض: {optOutUrl}',
   E'We have a new offer for you on Questify.\n\nTo stop offers: {optOutUrl}'),
  ('promo_push', 'كويستفاي', 'Questify', 'عرض جديد بانتظارك.', 'A new offer is waiting for you.');

-- The fields an admin edits, as the audit entry and a revert hold them.
CREATE FUNCTION admin_message_template_doc(t message_template) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'title', CASE WHEN t.title_ar IS NULL THEN NULL ELSE jsonb_build_object('ar', t.title_ar, 'en', t.title_en) END,
    'body', jsonb_build_object('ar', t.body_ar, 'en', t.body_en))
$$;
REVOKE ALL ON FUNCTION admin_message_template_doc(message_template) FROM PUBLIC;

-- Every template.
CREATE FUNCTION admin_message_templates() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN coalesce((
    SELECT jsonb_agg(admin_message_template_doc(t) || jsonb_build_object('key', t.key, 'updatedAt', t.updated_at)
                     ORDER BY t.key)
    FROM message_template t), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION admin_message_templates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_message_templates() TO questify_app;

-- One text of a template: trimmed, 1 to max_length characters, no control or direction character, every `{name}` one of
-- `allowed`, every one of `required` present (CA400 with the field in DETAIL). Internal.
CREATE FUNCTION message_template_text(value text, field text, max_length integer, required text[], allowed text[])
  RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  clean    text := btrim(value);
  stripped text;
  name     text;
BEGIN
  IF clean IS NULL OR char_length(clean) NOT BETWEEN 1 AND max_length
     OR clean ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F‎‏‪-‮⁦-⁩]' THEN
    RAISE EXCEPTION '% must have 1 to % characters, without control or direction characters', field, max_length
      USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  stripped := clean;
  FOREACH name IN ARRAY allowed LOOP
    stripped := replace(stripped, '{' || name || '}', '');
  END LOOP;
  IF stripped ~ '[{}]' THEN
    RAISE EXCEPTION '% holds a placeholder this template does not take', field USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  FOREACH name IN ARRAY required LOOP
    IF position('{' || name || '}' IN clean) = 0 THEN
      RAISE EXCEPTION '% must hold {%}', field, name USING ERRCODE = 'CA400', DETAIL = field;
    END IF;
  END LOOP;
  RETURN clean;
END $$;
REVOKE ALL ON FUNCTION message_template_text(text, text, integer, text[], text[]) FROM PUBLIC;

-- Saves one template (the four are seeded, so there is nothing to make: CA404 for any other key). A promotional SMS or
-- email must hold {optOutUrl} in both languages and a login-code SMS {code}; email and push take a title in both
-- languages, SMS none (CA400). A save that changes nothing writes nothing. `revert_of` is the audit entry a revert undoes
-- (NULL for a save); the door reads its `before` under the row's lock.
CREATE FUNCTION admin_message_template_save(template_key text, doc jsonb, revert_of bigint, request uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old      message_template;
  made     message_template;
  needs    text[];
  body_max integer;
  has_title boolean;
  t_ar     text;
  t_en     text;
  b_ar     text;
  b_en     text;
  edited   jsonb;
BEGIN
  PERFORM console_admin();
  SELECT * INTO old FROM message_template t WHERE t.key = template_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such template' USING ERRCODE = 'CA404';
  END IF;
  IF revert_of IS NOT NULL THEN
    doc := catalog_revert_doc('message_template', template_key, revert_of);
  END IF;
  needs := CASE template_key WHEN 'login_code_sms' THEN ARRAY['code'] WHEN 'promo_push' THEN '{}'
                             ELSE ARRAY['optOutUrl'] END;
  body_max := CASE template_key WHEN 'promo_email' THEN 4000 WHEN 'promo_push' THEN 140 ELSE 300 END;
  has_title := template_key IN ('promo_email', 'promo_push');
  IF has_title THEN
    t_ar := message_template_text(doc #>> '{title,ar}', 'title.ar', CASE template_key WHEN 'promo_push' THEN 60 ELSE 150 END,
                                  '{}', '{}');
    t_en := message_template_text(doc #>> '{title,en}', 'title.en', CASE template_key WHEN 'promo_push' THEN 60 ELSE 150 END,
                                  '{}', '{}');
  ELSIF coalesce(doc -> 'title', 'null'::jsonb) <> 'null'::jsonb THEN
    RAISE EXCEPTION 'this template has no title' USING ERRCODE = 'CA400', DETAIL = 'title';
  END IF;
  b_ar := message_template_text(doc #>> '{body,ar}', 'body.ar', body_max, needs, needs);
  b_en := message_template_text(doc #>> '{body,en}', 'body.en', body_max, needs, needs);
  edited := jsonb_build_object(
    'title', CASE WHEN has_title THEN jsonb_build_object('ar', t_ar, 'en', t_en) END,
    'body', jsonb_build_object('ar', b_ar, 'en', b_en));
  IF admin_message_template_doc(old) = edited THEN
    RETURN edited || jsonb_build_object('key', old.key, 'updatedAt', old.updated_at);
  END IF;
  UPDATE message_template t SET title_ar = t_ar, title_en = t_en, body_ar = b_ar, body_en = b_en, updated_at = now()
  WHERE t.key = template_key RETURNING * INTO made;
  PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.message_template.revert'
                             ELSE 'catalog.message_template.update' END,
                        'message_template', template_key, admin_message_template_doc(old), edited, request);
  RETURN edited || jsonb_build_object('key', made.key, 'updatedAt', made.updated_at);
END $$;
REVOKE ALL ON FUNCTION admin_message_template_save(text, jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_message_template_save(text, jsonb, bigint, uuid) TO questify_app;

-- ================================================================ the support contact (FR-1731)
-- One row, made here; a column is NULL until the admin sets it. Numbers are international (plus sign, 8 to 15 digits), the
-- form wa.me and tel: links take.
CREATE TABLE support_contact (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  whatsapp   text CHECK (whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  phone      text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  email      text CHECK (char_length(email) <= 254 AND email ~ '^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$'),
  updated_at timestamptz
);
ALTER TABLE support_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_contact FORCE ROW LEVEL SECURITY;
REVOKE ALL ON support_contact FROM PUBLIC, questify_app;
INSERT INTO support_contact (id) VALUES (true);

-- The fields an admin edits, as the audit entry holds them.
CREATE FUNCTION admin_support_contact_doc(c support_contact) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('whatsapp', c.whatsapp, 'phone', c.phone, 'email', c.email)
$$;
REVOKE ALL ON FUNCTION admin_support_contact_doc(support_contact) FROM PUBLIC;

-- What the contact page, the app and the legal pages show: the three fields, public (a signed-out reader sees them too).
CREATE FUNCTION support_contact_public() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT admin_support_contact_doc(c) FROM support_contact c
$$;
REVOKE ALL ON FUNCTION support_contact_public() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_contact_public() TO questify_app;

CREATE FUNCTION admin_support_contact() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN (SELECT admin_support_contact_doc(c) || jsonb_build_object('updatedAt', c.updated_at)
          FROM support_contact c);
END $$;
REVOKE ALL ON FUNCTION admin_support_contact() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_support_contact() TO questify_app;

-- One field of the contact: NULL or empty clears it, anything else must match the pattern (CA400 with the field).
CREATE FUNCTION support_contact_field(value text, field text, pattern text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  clean text := nullif(btrim(coalesce(value, '')), '');
BEGIN
  IF clean IS NOT NULL AND (char_length(clean) > 254 OR clean !~ pattern) THEN
    RAISE EXCEPTION '% is not valid', field USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  RETURN clean;
END $$;
REVOKE ALL ON FUNCTION support_contact_field(text, text, text) FROM PUBLIC;

-- Saves the three fields at once (an absent or empty one is cleared). A save that changes nothing writes nothing.
CREATE FUNCTION admin_support_contact_save(doc jsonb, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old    support_contact;
  made   support_contact;
  wa     text;
  ph     text;
  mail   text;
  edited jsonb;
BEGIN
  PERFORM console_admin();
  wa := support_contact_field(doc ->> 'whatsapp', 'whatsapp', '^\+[1-9][0-9]{7,14}$');
  ph := support_contact_field(doc ->> 'phone', 'phone', '^\+[1-9][0-9]{7,14}$');
  mail := support_contact_field(doc ->> 'email', 'email', '^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$');
  SELECT * INTO old FROM support_contact c FOR UPDATE;
  edited := jsonb_build_object('whatsapp', wa, 'phone', ph, 'email', mail);
  IF admin_support_contact_doc(old) = edited THEN
    RETURN edited || jsonb_build_object('updatedAt', old.updated_at);
  END IF;
  UPDATE support_contact c SET whatsapp = wa, phone = ph, email = mail, updated_at = now() RETURNING * INTO made;
  PERFORM catalog_audit('catalog.support_contact.update', 'support_contact', 'main', admin_support_contact_doc(old),
                        edited, request);
  RETURN edited || jsonb_build_object('updatedAt', made.updated_at);
END $$;
REVOKE ALL ON FUNCTION admin_support_contact_save(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_support_contact_save(jsonb, uuid) TO questify_app;
