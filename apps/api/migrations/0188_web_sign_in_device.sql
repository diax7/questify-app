-- T-803 P2 (plan docs/plans/2026-11-10-t-803-p2-web-session.md, ADR-818, ADR-820): a browser sign-in through the web
-- app's forwarder is one refresh family with one `player_sign_in_device` row whose platform is 'web'. It counts in the
-- ten live families like a phone (ADR-717); the eleventh sign-in ends the oldest. The forwarder always sends the label
-- `{ "platform": "web" }` and never a model or a user agent (ADR-710), so a 'web' row holds no model, which the second
-- check makes a rule of the table and not only of the API. No function, grant or policy changes: label_player_device
-- (0155) writes the platform it is given, and the table's grants stay as 0155 set them. 0187 and earlier untouched;
-- 0156 stays reserved.
SET LOCAL lock_timeout = '10s';

ALTER TABLE player_sign_in_device
  DROP CONSTRAINT player_sign_in_device_platform_check,
  ADD CONSTRAINT player_sign_in_device_platform_check CHECK (platform IN ('ios', 'android', 'web')),
  ADD CONSTRAINT player_sign_in_device_web_model_check CHECK (platform IS DISTINCT FROM 'web' OR model IS NULL);
