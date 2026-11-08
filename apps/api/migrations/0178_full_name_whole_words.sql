-- A full name matches the word lists by whole words (Dhia, 2026-11-08, Q-754; ADR-817). Under 0177 a `part` entry
-- matched inside one word of a full name, so real names holding a list word were refused: Thai names with "porn"
-- (Siriporn, Pornthep), Shittu, Shitole, Shitara, Slutskaya, Skeete, Bastardi, Wankowicz, «کسمایی». Now every entry
-- matches a whole word of the folded name only: "porn star" and "shit" are still refused, "Siriporn" passes, and so does
-- a compound such as "Pornstar Ali" (the trade-off Dhia accepted). An Arabic word is still read with one article and
-- one suffix, as 0177 read the allow-list: «اللوطي», «السحاقي», «سحاقية» and «الشرموطة» are refused as whole words with
-- ال, بال, وال or لل before an entry and ي, يه or ه after it (folded: ية reads يه, ة reads ه). Usernames keep their
-- stricter rule (`username_blocked`, unchanged).
-- Restated with the same signature, owner and grants (none), diffed against 0177: `full_name_blocked` only. The folding
-- (`full_name_fold`), the answer trigger, the sweep and the reads are unchanged.
-- The allow-list keeps the whole words that are list entries (butt, dick, poon, kike, quim, cumming, hooker); the 36
-- entries that only covered a list word inside a longer word are now redundant (the corpus passes without them,
-- `test/db/full-name-corpus.ts`) and are removed. «Kike» stays allowed (Q-754 (2)). Six common compounds of a part
-- entry (fuckface, shithead, ...) join `username_word` as whole words, so the corpus's abusive names stay refused; a
-- username holding one already holds its part entry, so no username's answer changes. Coon and Mong stay refused:
-- they are `word` entries, whole words already (Q-754).
-- The rule changes for stored names with no list row touched, so this file marks the recheck pending (docs/rules.md);
-- the lifecycle tick sweeps the stored answers again (about 9 minutes at 100,000 answers). Until the sweep reaches it,
-- a stored name shows as 0177 flagged it.
-- Nothing here writes points or XP, changes a sign-in, a tenant rule or a redemption. 0177 and earlier untouched.

SET LOCAL lock_timeout = '10s';

-- ================================================================ the check
-- The word-list half of `username_blocked`, by whole words of the folded name: a `word` entry matches a whole word
-- split at digits (as a username is); a `part` entry matches a whole word, also split at digits, with its digits
-- removed or read as letters (0 o, 1 i, 3 e, 4 a, 5 s, 7 t), or an Arabic word with one prefix of ال بال وال لل and
-- one suffix of ي يه ه taken off (each optional). A part entry never matches inside a longer word or across a space.
-- Letters spelled out one by one ("f u c k", "ك س") are read joined. A word of `full_name_allow` is skipped, and so is
-- an Arabic entry's article or nisba form. PL/pgSQL with no SET clause (its callers are definers and the answer
-- trigger, and it runs per row in the recheck; docs/rules.md): the two list reads are each one plan kept per
-- connection and look entries up by the list's unique index on the word, and the name is folded once.
CREATE OR REPLACE FUNCTION full_name_blocked(name text) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  words   text[] := string_to_array(full_name_fold(name), ' ');
  allowed text[];
  tokens  text[] := '{}';
  wholes  text[] := '{}';
  forms   text[];
  piece   text;
  bare    text;
  stem    text;
  spelled text := '';
  hit     boolean;
BEGIN
  IF words IS NULL OR words = '{""}' THEN
    RETURN false;
  END IF;
  -- The words the allow-list covers: as they are, or for an Arabic entry with one prefix and one suffix taken off.
  SELECT coalesce(array_agg(w), '{}') INTO allowed
  FROM unnest(ARRAY(SELECT DISTINCT regexp_replace(x, '[0-9]', '', 'g') FROM unnest(words) x)) w
  WHERE EXISTS (
    SELECT 1
    FROM unnest(ARRAY[w, regexp_replace(w, '^(بال|وال|لل|ال)', '')]) p,
         LATERAL (VALUES (p), (regexp_replace(p, 'ي$', '')), (regexp_replace(p, 'يه$', '')),
                         (regexp_replace(p, 'ه$', ''))) s(stem)
    JOIN full_name_allow a ON a.word = s.stem AND (s.stem = w OR a.language = 'ar'));
  FOREACH piece IN ARRAY words || ''::text LOOP
    bare := regexp_replace(piece, '[0-9]', '', 'g');
    IF char_length(piece) = 1 AND bare <> '' THEN
      spelled := spelled || bare;
      CONTINUE;
    END IF;
    IF char_length(spelled) >= 2 THEN
      tokens := tokens || spelled;
      wholes := wholes || spelled;
    END IF;
    spelled := '';
    IF bare = '' OR bare = ANY (allowed) THEN
      CONTINUE;
    END IF;
    tokens := tokens || regexp_split_to_array(piece, '[0-9]+');
    wholes := wholes || bare || regexp_replace(translate(piece, '013457', 'oieast'), '[0-9]', '', 'g');
    -- An Arabic word also with one article and one suffix taken off (plain expressions, no query; a Latin word, which
    -- the patterns never match, adds nothing).
    IF bare ~ '^(بال|وال|لل|ال)|[يه]$' THEN
      stem := regexp_replace(bare, '^(بال|وال|لل|ال)', '');
      wholes := wholes || stem
        || regexp_replace(bare, 'ي$', '') || regexp_replace(bare, 'يه$', '') || regexp_replace(bare, 'ه$', '')
        || regexp_replace(stem, 'ي$', '') || regexp_replace(stem, 'يه$', '') || regexp_replace(stem, 'ه$', '');
    END IF;
  END LOOP;
  -- A `part` entry is one of the whole words, their forms or their pieces between digits; a `word` entry is one of the
  -- pieces between digits only. One look-up by the list's unique index on the word.
  forms := wholes || tokens;
  SELECT EXISTS (SELECT 1 FROM username_word u
                 WHERE u.word = ANY (forms) AND (u.match = 'part' OR u.word = ANY (tokens)))
  INTO hit;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION full_name_blocked(text) FROM PUBLIC;

-- ================================================================ the allow-list
-- Only whole words that are list entries stay: a list word inside a longer word no longer matches, so the entries for
-- those (Ishaq, Al-Balouti, Yamashita, Harshit, Pornchai, ...) are redundant. The list's statement trigger marks the
-- sweep as well; the explicit mark below is the rule's own (docs/rules.md).
DELETE FROM full_name_allow
WHERE word NOT IN ('butt', 'dick', 'poon', 'kike', 'quim', 'cumming', 'hooker');

-- ================================================================ common compounds
-- A compound insult is one word, which a list word no longer matches inside ("fuckface Ali", "Mr Shithead" passed the
-- first draft of this file). The commonest join the list as whole words. Each holds a `part` entry already (fuck,
-- shit), so no username's answer changes; any other compound passes a full name until the console adds it.
INSERT INTO username_word (word, match, language) VALUES
  ('fuckface', 'part', 'en'), ('fuckhead', 'part', 'en'), ('fucker', 'part', 'en'), ('fuckwit', 'part', 'en'),
  ('shithead', 'part', 'en'), ('shitface', 'part', 'en')
ON CONFLICT (word) DO NOTHING;

-- ================================================================ the recheck
UPDATE full_name_recheck SET pending = true, after_enrollment = NULL, after_field = NULL, changed_at = now();
