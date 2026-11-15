-- The media database, migration 1 (T-814, ADR-839; plan docs/plans/2026-11-15-photos-in-postgres.md sections 2.1, 3.1).
-- Its own series (`m0001_...`), run by `node migrate.cjs --media` as this database's owner, never into the main one.
-- A dumb byte store: the bytes of each player photo and organizer image, keyed by the main database's
-- `media_object.key`. Nothing else lives here (no player, organizer or event row): the main database decides who may
-- read a key and when it goes (ADR-828), and the worker deletes here what it queued there.
-- Personal data (T-708): `media_blob.body` holds player photos. It leaves with the delete queue after an erasure, a
-- rejection, a sweep or the 365-day purge, and the daily reconcile removes any row the main database no longer names.
-- Deny by default: no grant on the table, RLS forced with no policy; `questify_media_app` runs the four definers only.
-- Lock order: one table; each definer touches only the rows of the keys it is given, in one statement; no function
-- reads more than one key's body.
SET LOCAL lock_timeout = '10s';

CREATE TABLE media_blob (
  key          text PRIMARY KEY,
  content_type text NOT NULL,
  bytes        integer NOT NULL,
  sha256       bytea NOT NULL,
  body         bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The main database's key shape (media_object_key_prefix): organizer, event, purpose, object id, extension.
  CONSTRAINT media_blob_key_shape CHECK (key ~ ('^o/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    || '/e/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    || '/[a-z]{2,20}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$')),
  CONSTRAINT media_blob_type CHECK ((content_type = 'image/jpeg' AND right(key, 4) = '.jpg')
    OR (content_type = 'image/png' AND right(key, 4) = '.png')),
  -- A 2,048 px JPEG 82 or PNG is far under 4 MiB.
  CONSTRAINT media_blob_size CHECK (bytes = octet_length(body) AND bytes BETWEEN 1 AND 4194304),
  CONSTRAINT media_blob_hash CHECK (octet_length(sha256) = 32)
);
-- JPEG and PNG are compressed already: TOAST keeps them out of line without trying to compress them again.
ALTER TABLE media_blob ALTER COLUMN body SET STORAGE EXTERNAL;
ALTER TABLE media_blob ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_blob FORCE ROW LEVEL SECURITY;
REVOKE ALL ON media_blob FROM PUBLIC;

-- Stores one key's bytes. True when written now; false when the key already holds the same bytes (a retried put). A key
-- that holds other bytes is MB409: keys are never reused, so a second image can never take an old key's place. The hash
-- must be the body's own (MB422), so a row's sha256 is always true.
CREATE FUNCTION blob_put(object_key text, object_type text, object_sha256 bytea, object_body bytea) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  held bytea;
BEGIN
  IF object_body IS NULL OR object_sha256 IS DISTINCT FROM sha256(object_body) THEN
    RAISE EXCEPTION 'the hash is not the body''s' USING ERRCODE = 'MB422';
  END IF;
  INSERT INTO media_blob (key, content_type, bytes, sha256, body)
  VALUES (object_key, object_type, octet_length(object_body), object_sha256, object_body)
  ON CONFLICT (key) DO NOTHING;
  IF FOUND THEN
    RETURN true;
  END IF;
  SELECT b.sha256 INTO held FROM media_blob b WHERE b.key = object_key;
  IF held = object_sha256 THEN
    RETURN false;
  END IF;
  RAISE EXCEPTION 'this key holds other bytes' USING ERRCODE = 'MB409';
END $$;
REVOKE ALL ON FUNCTION blob_put(text, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION blob_put(text, text, bytea, bytea) TO questify_media_app;

-- One key's bytes, or no row.
CREATE FUNCTION blob_get(object_key text)
  RETURNS TABLE (content_type text, bytes integer, sha256 bytea, body bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.content_type, b.bytes, b.sha256, b.body FROM media_blob b WHERE b.key = object_key;
$$;
REVOKE ALL ON FUNCTION blob_get(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION blob_get(text) TO questify_media_app;

-- Deletes the given keys in one statement (at most 500); a key already gone is fine. Answers how many rows went.
CREATE FUNCTION blob_delete(keys text[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  gone integer;
BEGIN
  IF cardinality(keys) > 500 THEN
    RAISE EXCEPTION 'at most 500 keys a call' USING ERRCODE = 'MB422';
  END IF;
  DELETE FROM media_blob b WHERE b.key = ANY (keys);
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END $$;
REVOKE ALL ON FUNCTION blob_delete(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION blob_delete(text[]) TO questify_media_app;

-- The reconcile's pages: keys only, in key order after `after`, of rows written before `older_than`, at most 500.
CREATE FUNCTION blob_keys_page(after text, older_than timestamptz, n integer) RETURNS TABLE (key text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.key FROM media_blob b
  WHERE b.key > coalesce(after, '') AND b.created_at < older_than
  ORDER BY b.key
  LIMIT least(greatest(coalesce(n, 500), 1), 500);
$$;
REVOKE ALL ON FUNCTION blob_keys_page(text, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION blob_keys_page(text, timestamptz, integer) TO questify_media_app;

-- Only the media role and this database's owner connect; the main API role and every other role do not.
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO questify_media_app, %I', current_database(), current_user);
END $$;
