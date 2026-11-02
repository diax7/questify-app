-- T-707: legal document versions with forced re-acceptance, and the help and FAQ content (FR-1781, FR-1782; plan note
-- docs/plans/2026-11-02-t-707-legal-help.md; ADR-445 to ADR-447).
-- The version in force of each of the six legal documents (three for players, three for organizers) moves from code
-- (`playerDocuments()`, `organizerDocuments()`) to `legal_version`, an append-only table an admin adds to. Publishing a
-- version makes it the one in force at once: players are asked at their next launch (profile.legal, unchanged), and an
-- organizer's team is refused writes until the owner accepts (see below). The text of a version is data too: a row with
-- both texts is shown by the legal pages; the seeded 0.1 rows carry none and the pages keep showing the drafts in
-- docs/legal/ for them (the drafts await counsel, T-807).
-- Help and FAQ articles are `help_article`: a question and an answer per language, either language alone is allowed, and
-- one is shown to a reader of the other language when it is the only one there.
-- Deny by default: both tables are closed to every role (RLS forced, no grant), PUBLIC holds EXECUTE on nothing, the
-- public reads and the admin doors go to questify_app only; every admin door starts with console_admin() (QE403).
-- Earlier migrations untouched; nothing here touches points, XP, sign-in or any tenant's data except the organizer
-- acceptance rows an owner adds for their own organizer.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the versions
CREATE TABLE legal_version (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document     text NOT NULL CHECK (document IN ('terms_of_use', 'privacy_policy', 'community_guidelines',
                                                  'organizer_terms', 'organizer_dpa', 'organizer_content_rules')),
  version      text NOT NULL CHECK (version ~ '^[0-9]{1,4}(\.[0-9]{1,4}){0,2}$'),
  body_ar      text CHECK (char_length(body_ar) BETWEEN 1 AND 100000),
  body_en      text CHECK (char_length(body_en) BETWEEN 1 AND 100000),
  note         text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 300),
  published_by uuid,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document, version),
  CHECK ((body_ar IS NULL) = (body_en IS NULL))
);
ALTER TABLE legal_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_version FORCE ROW LEVEL SECURITY;
REVOKE ALL ON legal_version FROM PUBLIC, questify_app;

-- A published version is a legal record: never changed, never removed, for every role (a correction is a newer version).
CREATE FUNCTION legal_version_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a published legal version can never be changed or removed' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION legal_version_append_only() FROM PUBLIC;
CREATE TRIGGER legal_version_no_change BEFORE UPDATE OR DELETE ON legal_version
  FOR EACH ROW EXECUTE FUNCTION legal_version_append_only();
CREATE TRIGGER legal_version_no_truncate BEFORE TRUNCATE ON legal_version
  FOR EACH STATEMENT EXECUTE FUNCTION legal_version_append_only();
ALTER TABLE legal_version ENABLE ALWAYS TRIGGER legal_version_no_change;
ALTER TABLE legal_version ENABLE ALWAYS TRIGGER legal_version_no_truncate;

-- The versions that were in force when T-110 and T-101 shipped; their texts are the drafts in docs/legal/.
INSERT INTO legal_version (document, version, published_at) VALUES
  ('terms_of_use', '0.1', '2026-10-21'), ('privacy_policy', '0.1', '2026-10-21'),
  ('community_guidelines', '0.1', '2026-10-21'), ('organizer_terms', '0.1', '2026-10-21'),
  ('organizer_dpa', '0.1', '2026-10-21'), ('organizer_content_rules', '0.1', '2026-10-21');

-- A version as three numbers, so 0.10 is later than 0.9, 1.0.1 later than 1.0, and 1 is the same version as 1.0.0.
CREATE FUNCTION legal_version_key(version text) RETURNS integer[]
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT parts || array_fill(0, ARRAY[3 - cardinality(parts)])
  FROM (SELECT string_to_array(version, '.')::integer[] AS parts) p
$$;
REVOKE ALL ON FUNCTION legal_version_key(text) FROM PUBLIC;

-- The version in force of every document: the latest version of each. Internal to the definers below (a view would read with
-- its owner's rights, which the outsider suite forbids): no role can call it.
CREATE FUNCTION legal_in_force_rows() RETURNS TABLE (id bigint, document text, version text, published_at timestamptz)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT DISTINCT ON (v.document) v.id, v.document, v.version, v.published_at
  FROM legal_version v ORDER BY v.document, legal_version_key(v.version) DESC
$$;
REVOKE ALL ON FUNCTION legal_in_force_rows() FROM PUBLIC;

-- True while player `p` accepted an earlier version of the terms of use or the privacy policy and not the one in force
-- (ADR-446): the API holds that player's writes. Like organizer_legal_missing, a document with no acceptance at all is not
-- a new version to accept (sign-up records both, so no real player is in that state). One query per player write; only the
-- API role can call it, after the session check.
CREATE FUNCTION player_legal_held(p uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM legal_in_force_rows() f
    WHERE f.document IN ('terms_of_use', 'privacy_policy')
      AND EXISTS (SELECT 1 FROM player_acceptance a WHERE a.player_id = p AND a.document = f.document)
      AND NOT EXISTS (SELECT 1 FROM player_acceptance a
                      WHERE a.player_id = p AND a.document = f.document AND a.version = f.version))
$$;
REVOKE ALL ON FUNCTION player_legal_held(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION player_legal_held(uuid) TO questify_app;

-- ================================================================ public reads (the pages and the apps need them signed out)
-- The documents in force: [{document, version, publishedAt}]. Public information, the same as the legal pages.
CREATE FUNCTION legal_in_force() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('document', document, 'version', version,
                                               'publishedAt', published_at) ORDER BY document), '[]'::jsonb)
  FROM legal_in_force_rows()
$$;
REVOKE ALL ON FUNCTION legal_in_force() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION legal_in_force() TO questify_app;

-- One document in force with its texts (null both when the version has none: the page shows the draft file), or NULL
-- for a name that is not a document.
CREATE FUNCTION legal_text(doc text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('document', f.document, 'version', f.version, 'publishedAt', f.published_at,
                            'ar', v.body_ar, 'en', v.body_en)
  FROM legal_in_force_rows() f JOIN legal_version v ON v.id = f.id
  WHERE f.document = doc
$$;
REVOKE ALL ON FUNCTION legal_text(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION legal_text(text) TO questify_app;

-- ================================================================ the admin doors
-- Every document with its versions, newest first, and which is in force. No texts: a text is read from legal_text.
CREATE FUNCTION admin_legal_list() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'document', d.document,
      'versions', (SELECT jsonb_agg(jsonb_build_object('version', v.version, 'publishedAt', v.published_at,
                                                       'hasText', v.body_ar IS NOT NULL, 'note', v.note,
                                                       'inForce', v.id = f.id)
                                    ORDER BY legal_version_key(v.version) DESC)
                   FROM legal_version v WHERE v.document = d.document)) ORDER BY d.document)
    FROM (SELECT DISTINCT document FROM legal_version) d
    JOIN legal_in_force_rows() f ON f.document = d.document), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION admin_legal_list() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_legal_list() TO questify_app;

-- Publishes a version of a document: later than the one in force (LG409), with both texts (LG400). It is in force the
-- moment it commits. Publishing two versions of one document at once is serialised, so the second sees the first.
CREATE FUNCTION admin_legal_publish(doc text, new_version text, text_ar text, text_en text, why text, request uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin_id uuid := console_admin();
  current  text;
  clean_ar text := btrim(text_ar);
  clean_en text := btrim(text_en);
  clean_why text := nullif(btrim(why), '');
  made     legal_version;
BEGIN
  IF doc IS NULL OR doc NOT IN ('terms_of_use', 'privacy_policy', 'community_guidelines', 'organizer_terms',
                                'organizer_dpa', 'organizer_content_rules') THEN
    RAISE EXCEPTION 'unknown document' USING ERRCODE = 'LG400', DETAIL = 'document';
  END IF;
  IF new_version IS NULL OR new_version !~ '^[0-9]{1,4}(\.[0-9]{1,4}){0,2}$' THEN
    RAISE EXCEPTION 'the version must look like 1.2 or 2' USING ERRCODE = 'LG400', DETAIL = 'version';
  END IF;
  IF clean_ar IS NULL OR char_length(clean_ar) NOT BETWEEN 1 AND 100000 OR clean_ar ~ '\x00' THEN
    RAISE EXCEPTION 'the Arabic text must have 1 to 100000 characters' USING ERRCODE = 'LG400', DETAIL = 'text.ar';
  END IF;
  IF clean_en IS NULL OR char_length(clean_en) NOT BETWEEN 1 AND 100000 OR clean_en ~ '\x00' THEN
    RAISE EXCEPTION 'the English text must have 1 to 100000 characters' USING ERRCODE = 'LG400', DETAIL = 'text.en';
  END IF;
  IF clean_why IS NOT NULL AND char_length(clean_why) > 300 THEN
    RAISE EXCEPTION 'the note is at most 300 characters' USING ERRCODE = 'LG400', DETAIL = 'note';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('legal_version:' || doc));
  SELECT version INTO current FROM legal_in_force_rows() WHERE document = doc;
  IF current IS NOT NULL AND legal_version_key(new_version) <= legal_version_key(current) THEN
    RAISE EXCEPTION 'version % is not later than the version in force (%)', new_version, current
      USING ERRCODE = 'LG409', DETAIL = current;
  END IF;
  INSERT INTO legal_version (document, version, body_ar, body_en, note, published_by)
  VALUES (doc, new_version, clean_ar, clean_en, clean_why, admin_id)
  RETURNING * INTO made;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, after, request_id)
  VALUES ('admin', admin_id, 'legal.publish', 'legal_document', doc,
          jsonb_build_object('version', current),
          jsonb_build_object('version', new_version, 'note', clean_why), request);
  RETURN jsonb_build_object('document', doc, 'version', made.version, 'publishedAt', made.published_at);
END $$;
REVOKE ALL ON FUNCTION admin_legal_publish(text, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_legal_publish(text, text, text, text, text, uuid) TO questify_app;

-- ================================================================ organizers re-accept
-- The organizer documents in force that organizer `org` accepted an earlier version of and not this one, as
-- [{document, version}] (empty when none). An organizer is only ever made with all three documents accepted (insert_organizer),
-- so a document with no acceptance at all is not a new version to accept. Only a member of that organizer gets an answer;
-- anyone else gets an empty list, the same as an organizer with nothing to accept.
CREATE FUNCTION organizer_legal_missing(org uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('document', f.document, 'version', f.version) ORDER BY f.document),
                  '[]'::jsonb)
  FROM legal_in_force_rows() f
  WHERE f.document IN ('organizer_terms', 'organizer_dpa', 'organizer_content_rules')
    AND EXISTS (SELECT 1 FROM organizer_member m WHERE m.organizer_id = org AND m.staff_user_id = app_staff_user_id())
    AND EXISTS (SELECT 1 FROM organizer_acceptance a WHERE a.organizer_id = org AND a.document = f.document)
    AND NOT EXISTS (SELECT 1 FROM organizer_acceptance a
                    WHERE a.organizer_id = org AND a.document = f.document AND a.version = f.version)
$$;
REVOKE ALL ON FUNCTION organizer_legal_missing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION organizer_legal_missing(uuid) TO questify_app;

-- The organizer's owner accepts the given {document, version} pairs for the organizer. Each pair must be an organizer
-- document at the version in force (LG412 otherwise, nothing recorded); accepting twice changes nothing. Raises
-- insufficient_privilege (QE403) for anyone who is not the organizer's owner. One audit entry in the owner's name.
CREATE FUNCTION accept_organizer_documents(org uuid, documents jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_staff_user_id();
  item jsonb;
BEGIN
  IF me IS NULL OR NOT EXISTS (SELECT 1 FROM organizer_member m
                               WHERE m.organizer_id = org AND m.staff_user_id = me AND m.role = 'owner') THEN
    RAISE EXCEPTION 'only the organizer''s owner accepts its documents' USING ERRCODE = 'QE403';
  END IF;
  IF jsonb_typeof(documents) IS DISTINCT FROM 'array' OR jsonb_array_length(documents) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'name one to three documents' USING ERRCODE = 'LG412';
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(documents) LOOP
    IF NOT EXISTS (SELECT 1 FROM legal_in_force_rows() f
                   WHERE f.document = item ->> 'document' AND f.version = item ->> 'version'
                     AND f.document IN ('organizer_terms', 'organizer_dpa', 'organizer_content_rules')) THEN
      RAISE EXCEPTION 'not the version in force' USING ERRCODE = 'LG412';
    END IF;
  END LOOP;
  INSERT INTO organizer_acceptance (organizer_id, document, version, accepted_by)
  SELECT org, i ->> 'document', i ->> 'version', me FROM jsonb_array_elements(documents) i
  ON CONFLICT DO NOTHING;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, after)
  VALUES ('staff', me, org, 'organizer.legal.accept', 'organizer', org::text, jsonb_build_object('documents', documents));
END $$;
REVOKE ALL ON FUNCTION accept_organizer_documents(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_organizer_documents(uuid, jsonb) TO questify_app;

-- ================================================================ help and FAQ
CREATE TABLE help_article (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,63}$'),
  position    integer NOT NULL CHECK (position BETWEEN 1 AND 1000),
  question_ar text NOT NULL DEFAULT '' CHECK (char_length(question_ar) <= 200),
  question_en text NOT NULL DEFAULT '' CHECK (char_length(question_en) <= 200),
  answer_ar   text NOT NULL DEFAULT '' CHECK (char_length(answer_ar) <= 4000),
  answer_en   text NOT NULL DEFAULT '' CHECK (char_length(answer_en) <= 4000),
  published   boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- A language is complete or empty: a question never shows with the other language's answer.
  CHECK ((question_ar <> '') = (answer_ar <> '') AND (question_en <> '') = (answer_en <> '')),
  CHECK (question_ar <> '' OR question_en <> '')
);
ALTER TABLE help_article ENABLE ROW LEVEL SECURITY;
ALTER TABLE help_article FORCE ROW LEVEL SECURITY;
REVOKE ALL ON help_article FROM PUBLIC, questify_app;

-- The fields an admin edits, as the audit entry and a revert hold them.
CREATE FUNCTION admin_help_doc(h help_article) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'question', jsonb_build_object('ar', h.question_ar, 'en', h.question_en),
    'answer', jsonb_build_object('ar', h.answer_ar, 'en', h.answer_en),
    'position', h.position, 'published', h.published)
$$;
REVOKE ALL ON FUNCTION admin_help_doc(help_article) FROM PUBLIC;

-- The published articles in order, for the help screens (public: signed-out readers see help too).
CREATE FUNCTION help_articles() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'question', admin_help_doc(h) -> 'question',
                                               'answer', admin_help_doc(h) -> 'answer')
                            ORDER BY h.position, h.id), '[]'::jsonb)
  FROM help_article h WHERE h.published
$$;
REVOKE ALL ON FUNCTION help_articles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION help_articles() TO questify_app;

-- Every article, the unpublished ones too.
CREATE FUNCTION admin_help_articles() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN coalesce((
    SELECT jsonb_agg(admin_help_doc(h) || jsonb_build_object('id', h.id, 'updatedAt', h.updated_at)
                     ORDER BY h.position, h.id)
    FROM help_article h), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION admin_help_articles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_help_articles() TO questify_app;

-- A help text an admin typed: trimmed, at most max_length characters, empty allowed, no control or direction character.
CREATE FUNCTION help_text(value text, field text, max_length integer) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  clean text := btrim(coalesce(value, ''));
BEGIN
  IF char_length(clean) > max_length
     OR clean ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F‎‏‪-‮⁦-⁩]' THEN
    RAISE EXCEPTION '% must have at most % characters, without control or direction characters', field, max_length
      USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  RETURN clean;
END $$;
REVOKE ALL ON FUNCTION help_text(text, text, integer) FROM PUBLIC;

-- Saves one article, making it when the id is new (CA409 when someone made that id a moment ago). A language is complete
-- (question and answer) or empty, and one language at least is there (CA400). A save that changes nothing writes nothing.
-- `revert_of` is the audit entry a revert undoes (NULL for a save); the door reads its `before` under the row's lock.
CREATE FUNCTION admin_help_article_save(article_id text, doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old     help_article;
  made    help_article;
  q_ar    text;
  q_en    text;
  a_ar    text;
  a_en    text;
  place   integer;
  shown   boolean;
  edited  jsonb;
  existed boolean;
BEGIN
  PERFORM console_admin();
  IF article_id IS NULL OR article_id !~ '^[a-z][a-z0-9-]{0,63}$' THEN
    RAISE EXCEPTION 'the id must be lower-case letters, digits and hyphens' USING ERRCODE = 'CA400', DETAIL = 'id';
  END IF;
  SELECT * INTO old FROM help_article h WHERE h.id = article_id FOR UPDATE;
  existed := FOUND;
  IF revert_of IS NOT NULL THEN
    IF NOT existed THEN
      RAISE EXCEPTION 'no such article' USING ERRCODE = 'CA404';
    END IF;
    doc := catalog_revert_doc('help_article', article_id, revert_of);
  END IF;
  q_ar := help_text(doc #>> '{question,ar}', 'question.ar', 200);
  q_en := help_text(doc #>> '{question,en}', 'question.en', 200);
  a_ar := help_text(doc #>> '{answer,ar}', 'answer.ar', 4000);
  a_en := help_text(doc #>> '{answer,en}', 'answer.en', 4000);
  IF (q_ar = '') <> (a_ar = '') OR (q_en = '') <> (a_en = '') OR (q_ar = '' AND q_en = '') THEN
    RAISE EXCEPTION 'each language needs its question and its answer, and one language is required'
      USING ERRCODE = 'CA400', DETAIL = 'languages';
  END IF;
  place := (doc ->> 'position')::integer;
  shown := (doc ->> 'published')::boolean;
  IF place IS NULL OR place NOT BETWEEN 1 AND 1000 OR shown IS NULL THEN
    RAISE EXCEPTION 'position and published are required' USING ERRCODE = 'CA400', DETAIL = 'position';
  END IF;
  edited := jsonb_build_object('question', jsonb_build_object('ar', q_ar, 'en', q_en),
                               'answer', jsonb_build_object('ar', a_ar, 'en', a_en),
                               'position', place, 'published', shown);
  IF existed THEN
    IF admin_help_doc(old) = edited THEN
      RETURN edited || jsonb_build_object('id', old.id, 'updatedAt', old.updated_at);
    END IF;
    UPDATE help_article h SET question_ar = q_ar, question_en = q_en, answer_ar = a_ar, answer_en = a_en,
           position = place, published = shown, updated_at = now()
    WHERE h.id = article_id RETURNING * INTO made;
  ELSE
    LOCK TABLE help_article IN SHARE ROW EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM help_article h WHERE h.id = article_id) THEN
      RAISE EXCEPTION 'an article with that id was just made' USING ERRCODE = 'CA409';
    END IF;
    INSERT INTO help_article (id, position, question_ar, question_en, answer_ar, answer_en, published)
    VALUES (article_id, place, q_ar, q_en, a_ar, a_en, shown) RETURNING * INTO made;
  END IF;
  PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.help.revert' ELSE 'catalog.help.update' END,
                        'help_article', article_id, CASE WHEN existed THEN admin_help_doc(old) END, edited, request);
  RETURN edited || jsonb_build_object('id', made.id, 'updatedAt', made.updated_at);
END $$;
REVOKE ALL ON FUNCTION admin_help_article_save(text, jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_help_article_save(text, jsonb, bigint, uuid) TO questify_app;
