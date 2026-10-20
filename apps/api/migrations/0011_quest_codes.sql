-- Quest QR codes (T-104). A printed code carries the quest's code version; regenerating bumps it, so every code printed
-- before stops working at once (FR-1711). The code itself is signed by the API (apps/api/src/quests/qr.ts) and is never
-- stored. The closed-event guard of 0010 covers this column like every other.
ALTER TABLE quest ADD COLUMN qr_version integer NOT NULL DEFAULT 1 CHECK (qr_version >= 1);
GRANT UPDATE (qr_version) ON quest TO questify_app;
