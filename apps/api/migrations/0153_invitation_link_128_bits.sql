-- T-810b item 3 (V11.5.1, ADR-702, Q-670): an invitation link carries 128 random bits. 0073's default,
-- gen_random_uuid(), is a version 4 UUID: 122 random bits, the other 6 fixed. The token in the message is the
-- column's 16 bytes in base64url (invitation-campaigns/message.ts), and the API reads any 16 bytes back, so only the
-- source of the bytes changes: the first 16 bytes of a SHA-256 over two version 4 UUIDs (244 bits from the server's
-- strong random source). PostgreSQL stores any 128 bits in a uuid and never checks its version. pgcrypto is not
-- installed and is not added for this.
--
-- Rows already written keep their link: a sent link keeps opening until its row is purged, and a queued one keeps its
-- 122 bits, still far beyond guessing (the plan review dropped a rewrite of queued rows). Only new rows get the new
-- default. Old and new API releases read the same column, so the deploy has no skew.
--
-- Deny by default: no table, function or grant is created or changed; invitation_recipient stays RLS-forced with no
-- grant. A column default only.
SET LOCAL lock_timeout = '10s';

ALTER TABLE invitation_recipient ALTER COLUMN link SET DEFAULT
  encode(substring(sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())) FROM 1 FOR 16), 'hex')::uuid;
