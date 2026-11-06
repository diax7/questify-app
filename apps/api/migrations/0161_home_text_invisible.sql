-- Questify home's text check (T-713 review follow-up, docs/FOLLOWUPS.md): `home_text_checked` (0137) refused control and
-- direction characters but let through the zero-width and mark characters U+200B to U+200F, U+061C and U+FEFF, and a
-- required title of spaces alone. The dashboard strips them before it sends, so only a direct caller reached the gap.
-- Restated with the same arguments, result and grant (internal, closed to PUBLIC); nothing else changes. A text of
-- whitespace alone is stored as empty, so a required title that has only that is refused like an empty one.
CREATE OR REPLACE FUNCTION home_text_checked(value jsonb, field text, max_length integer, required boolean) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  blank constant text := '^[[:space:]   -   　]*$';
  ar text;
  en text;
BEGIN
  IF NOT home_only_keys(value, ARRAY['ar', 'en'])
     OR jsonb_typeof(coalesce(value -> 'ar', '""'::jsonb)) <> 'string'
     OR jsonb_typeof(coalesce(value -> 'en', '""'::jsonb)) <> 'string' THEN
    RAISE EXCEPTION '% must hold Arabic and English text', field USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  ar := coalesce(value ->> 'ar', '');
  en := coalesce(value ->> 'en', '');
  IF char_length(ar) > max_length OR char_length(en) > max_length
     OR (ar || en) ~ '[\x01-\x1F\x7F-\x9F؜​-‏ -‮⁦-⁩﻿]' THEN
    RAISE EXCEPTION '% must have at most % characters, none of them control, direction or invisible characters', field, max_length
      USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  IF ar ~ blank THEN
    ar := '';
  END IF;
  IF en ~ blank THEN
    en := '';
  END IF;
  IF required AND ar = '' AND en = '' THEN
    RAISE EXCEPTION '% needs text in Arabic or English', field USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  RETURN jsonb_build_object('ar', ar, 'en', en);
END $$;
REVOKE ALL ON FUNCTION home_text_checked(jsonb, text, integer, boolean) FROM PUBLIC;
