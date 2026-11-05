-- T-703b follow-up: the `features` and `tuning` blocks of `platform_setting` exist from this migration on, empty, so the
-- console's first save of either has a row to lock. 0134 did this for `maintenance` and `banner`; the two blocks of
-- 0003 were left without a row, and `SELECT ... FOR UPDATE` on a missing row locks nothing: two admins saving different
-- keys of the same block for the first time then each read "nothing stored", wrote only their own key, and the second
-- write replaced the first.
--
-- An empty block reads as a missing one everywhere: the SQL readers (`feature_enabled`, `platform_tuning`) look a key up
-- inside the value and fall back to their default when it is absent, and the API reads `{}` as "no settings stored".
-- Nothing else changes: the policies of 0134 already name both keys, no grant is added or removed, and no function is
-- created.
SET LOCAL lock_timeout = '10s';

INSERT INTO platform_setting (key, value) VALUES ('features', '{}'), ('tuning', '{}')
  ON CONFLICT (key) DO NOTHING;
