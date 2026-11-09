-- The full-name allow-list from the console (FOLLOWUPS batch 23, FR-1779, ADR-817; plan
-- docs/plans/2026-11-09-name-allow-console.md). `full_name_allow` was edited by migration only; a Questify admin now adds
-- or removes an allow word beside the word lists when a real name is reported as refused. Three doors, as the word-list
-- doors of 0177 (an active admin only, QE403 otherwise; the lists' advisory key first; audited with the word; no reason,
-- no re-authentication, as the word lists):
--   * `console_name_allow` reads a page of the list (50, by word), filtered by a folded part and the language;
--   * `admin_name_allow_add` folds the word as the check reads a name (`full_name_fold`), takes its language from its
--     letters, and refuses a word that is not one word of 2 or more Arabic or English letters (WA400), a word that is
--     itself a list entry (WA409), and a word that would let an abusive name of the corpus through (WA422);
--   * `admin_name_allow_remove` removes one.
-- The list's statement trigger (`full_name_allow_recheck`, 0177) marks the name-flag sweep pending on every change, so a
-- door runs no page itself. New, closed by default: table `full_name_probe` (no grant), the abusive names of the corpus
-- (`test/db/full-name-corpus.ts`, a test keeps the two equal). Nothing here writes points or XP, changes a sign-in, a
-- tenant rule or a redemption; no function is restated. 0184 and earlier untouched; 0156 stays reserved.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the abusive names an allow word must not let through
-- The corpus' abusive names, each refused by `full_name_blocked` as the lists ship (`full-name-filter.int.test.ts`). An
-- allow word added from the console must leave every one of them that is refused now refused. Data, edited by migration
-- with the corpus; never read by a name check.
CREATE TABLE full_name_probe (
  name text PRIMARY KEY CHECK (char_length(name) BETWEEN 1 AND 200)
);
ALTER TABLE full_name_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE full_name_probe FORCE ROW LEVEL SECURITY;
REVOKE ALL ON full_name_probe FROM PUBLIC;

INSERT INTO full_name_probe (name) VALUES
  ('Sara Bitch'), ('Bastard Khan'), ('B4st4rd Khan'), ('Fuck You'), ('fuckface Ali'), ('Mr Shithead'), ('Ali Asshole'),
  ('Big Cock'), ('B a s t a r d'), ('f.u.c.k'), ('Slut Omar'), ('Ahmed Porn'), ('Porn Star Ali'), ('Mr Shit'),
  ('عبدالله كس'), ('ابن الشرموطة'), ('سكس سكس'), ('منيوك أحمد'), ('خالد السحاقي'), ('خالد اللوطي'), ('سحاقية'),
  ('ك س'), ('fucks'), ('Ali fucked'), ('fuckers'), ('shits'), ('sluts'), ('slutty Sara'), ('whores'), ('bitchy'),
  ('cunts'), ('twats'), ('wanker'), ('wankers'), ('bastards'), ('assholes'), ('niggers'), ('niggas'), ('faggots'),
  ('ياشرموطة'), ('يامنيوك'), ('يالوطي'), ('ياشرموط'), ('وشرموطة'), ('بشرموطة'), ('الشرموطات'), ('متناكين'), ('لوطيين'),
  ('سكسات'), ('طيزك'), ('شرموطتك'), ('كسمك'), ('ابنالشرموطة'), ('ا ل ش ر م و ط ة'), ('ش ر م و ط ة'), ('القحبة'),
  ('ياقحبة'), ('قحبات'), ('العرص'), ('الخول'), ('ياخول'), ('زبك'), ('fυck you'), ('fuсk you'), ('ｆｕｃｋ you'),
  ('fück you'), ('FÜCK you'), ('ﻛﺲ'), ('کس امك'), ('ڪس'), ('Shіt Head'), ('ВІТСН'), ('fuckboy'), ('fuckk'), ('ffuck'),
  ('fucku'), ('ufuck'), ('fuckme'), ('fuckit'), ('fuckah Ali'), ('fuckr'), ('shitt'), ('shitz'), ('sshit'),
  ('bullshitt'), ('bitchh'), ('bitchez'), ('sluttt'), ('slutz'), ('whoree'), ('whorez'), ('cuntt'), ('cuntz'),
  ('twatt'), ('wankk'), ('wanks'), ('wanking'), ('bastardz'), ('assholez'), ('pornz'), ('pornn'), ('porns'),
  ('niggaz'), ('niggerz'), ('faggotz'), ('motherfuckers'), ('pussyy'), ('pussies'), ('dildos'), ('dickk'), ('dicks'),
  ('cockk'), ('cumm'), ('cumz'), ('sexx'), ('sexxy'), ('asss'), ('fagg'), ('faggy'), ('titts'), ('rapee'), ('raper'),
  ('Ali raped'), ('boobies'), ('nigg3r'), ('f4ggot'), ('sh1t'), ('5hit'), ('b1tch'), ('c0ck'), ('d1ck'), ('p0rn'),
  ('wh0re'), ('s h i t'), ('c u n t'), ('w h o r e'), ('p o r n'), ('s l u t'), ('b i t c h'), ('fυckk'), ('ѕhit Ali'),
  ('ｓｈｉｔ'), ('Pörn Star'), ('WHÖRE'), ('Ali''s bitch'), ('الشرموط'), ('شرموطين'), ('شرموطون'), ('شرموطها'),
  ('شرموطهم'), ('يابنالشرموطة'), ('ابن الشرموطه'), ('بنتالشرموطة'), ('للشرموطة'), ('فشرموطة'), ('كشرموطة'),
  ('شرموطتكم'), ('شرموطتها'), ('شرموطاتك'), ('المنيوك'), ('منيوكه'), ('منيوكين'), ('المتناك'), ('متناكه'), ('يامتناك'),
  ('متناكات'), ('اللوطيه'), ('يالوطيه'), ('لوطيون'), ('السحاقيات'), ('ياسحاقيه'), ('العاهره'), ('ياعاهره'), ('عاهرات'),
  ('عاهرتك'), ('عاهرتي'), ('شرموطتي'), ('قحبتي'), ('طيزها'), ('الطيز'), ('طيزكم'), ('كسك'), ('كسها'), ('كسكم'),
  ('الكس'), ('كسمها'), ('كسمكم'), ('الزب'), ('زبه'), ('زبها'), ('القحبات'), ('قحبتك'), ('ياعرص'), ('العرصات'),
  ('عرصين'), ('الخولات'), ('النيك'), ('نيكها'), ('الشاذ'), ('شاذين'), ('ياشاذ'), ('سكسي'), ('السكس'), ('الاغتصاب'),
  ('شرموطا'), ('شرموطو'), ('متناكو'), ('منيوكو'), ('لوطيا'), ('سحاقو'), ('معرص'), ('انيك'), ('ينيك'), ('ك س م ك'),
  ('ز ب ي'), ('ع ر ص'), ('ق ح ب ه'), ('ﺷﺮﻣﻮﻃﺔ'), ('شـرمـوطـة'), ('شَرْمُوطَة'), ('dickhead'), ('Ali Dickheads'),
  ('cocksucker'), ('jackass'), ('jackasses'), ('dumbass'), ('asshat'), ('asswipe'), ('cumslut'), ('cumdump'),
  ('dickface'), ('cuntface'), ('twatface'), ('fatass'), ('fucktard'), ('slutbag'), ('whoreson'), ('كسامك'), ('كسأمك'),
  ('كس_امك'), ('كسامكم'), ('كسختك'), ('كساختك'), ('dick5'), ('dick69'), ('butt69'), ('kike88'), ('ياخولي'),
  ('يا خولي'), ('يا خوله'), ('يا البزاز'), ('يا الشرموطة'), ('يا القحبة'), ('ياالقحبة'), ('يا العرص'), ('Nazi Ali'),
  ('Ali Nazis'), ('Mr Hitler'), ('H1tler Khan'), ('Hitlers Omar'), ('Retard Omar'), ('Ali Retarded'), ('Retards'),
  ('Fukk You'), ('Fuky Ali'), ('Fuker Omar'), ('Fvck You'), ('Fvcking Ali'), ('f v c k'), ('f*ck'), ('F*ck You'),
  ('sh!t'), ('Sh*t Omar'), ('Mr Sh!thead'), ('a$$hole Ali'), ('b!tch'), ('B@stard Khan'), ('wh0r3'), ('Fuuuck'),
  ('Fuuuuuck You'), ('Shiiit'), ('Asssshole'), ('Diiick'), ('Biiitch Ali'), ('كسسس'), ('ꜱex'), ('ꜰᴜᴄᴋ'),
  ('ʙɪᴛᴄʜ Omar'), ('ꜱʜɪᴛ'), ('fսck'), ('ɑsshole'), ('Dickhead Ali'), ('f＊ck'), ('sh！t'), ('ｓｈ！ｔ'), ('a＄＄hole'),
  ('b＠stard'), ('ｆ＊＊ｋ'), ('f∗ck'), ('f⁎ck'), ('sh¡t'), ('sh!!t'), ('b!!tch'), ('F**k'), ('fu*k'), ('fu**ing'),
  ('F**king Ali'), ('a**hole'), ('c**t'), ('b***h'), ('wh*re'), ('f_ck'), ('ｆ＿ｃｋ'), ('f#ck'), ('f٭ck'), ('f✱ck'),
  ('f✲ck'), ('f✳ck'), ('f⚹ck'), ('f❋ck'), ('f⁕ck'), ('f★ck'), ('f•ck'), ('f|ck'), ('sh|t'), ('fuuu*k'), ('f*ccck');

-- ================================================================ the console doors (FR-1779)
-- One page of the allow-list (50, by word), filtered by a part of the word folded as the check folds a name, and the
-- language.
CREATE FUNCTION console_name_allow(search text, only_language text, after_word text) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := console_admin();
  part text := full_name_fold(left(coalesce(search, ''), 60));
BEGIN
  RETURN jsonb_build_object(
    'words', coalesce((
      SELECT jsonb_agg(jsonb_build_object('word', w.word, 'language', w.language, 'addedAt', w.created_at)
                       ORDER BY w.word)
      FROM (SELECT x.* FROM full_name_allow x
            WHERE (part = '' OR position(part IN x.word) > 0)
              AND (only_language IS NULL OR x.language = only_language)
              AND (after_word IS NULL OR x.word > after_word)
            ORDER BY x.word LIMIT 50) w), '[]'::jsonb),
    'total', (SELECT count(*) FROM full_name_allow x
              WHERE (part = '' OR position(part IN x.word) > 0)
                AND (only_language IS NULL OR x.language = only_language)));
END $$;
REVOKE ALL ON FUNCTION console_name_allow(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_name_allow(text, text, text) TO questify_app;

-- Adds an allow word. Outcomes: added, exists. The word is stored as the check reads a name: `full_name_fold` (NFKC,
-- accents and marks dropped, the username fold, Persian and look-alike letters made the list's), so «Nāsser», «ناصر» with
-- a Persian letter or a full-width word is stored as the check will meet it; its language is its letters' (an Arabic
-- word also covers its prefix and nisba forms, ADR-817). Refusals:
--   WA400  not one word of 2 or more letters, all Arabic or all English, typed in 60 characters or fewer (a space, a
--          digit or a symbol is left after the fold, or the table's CHECK refuses it);
--   WA409  the word is itself a `username_word` entry: allowing it would undo the entry for every name (a real name
--          that is a list word, such as Butt, stays a migration's decision, reviewed);
--   WA422  with the word allowed, an abusive name of `full_name_probe` that the check refuses now would pass.
-- Lock order, as the word doors: the lists' advisory key exclusive, then reads of the lists and the probes (no lock),
-- the new row, the sweep row (the list trigger), never an answer. The probes checked are only those holding the word
-- (the word skips only a word of a name, so a probe whose folded letters do not hold it cannot change); each is checked
-- before the insert and again after it, a few probes at most, under 50 ms.
CREATE FUNCTION admin_name_allow_add(new_word text, request uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me      uuid := console_admin();
  folded  text := full_name_fold(left(coalesce(new_word, ''), 61));
  lang    text;
  refused text[];
BEGIN
  lang := CASE WHEN folded ~ '^[ء-غف-ي]{2,}$' THEN 'ar' WHEN folded ~ '^[a-z]{2,}$' THEN 'en' END;
  IF lang IS NULL OR char_length(new_word) > 60 THEN
    RAISE EXCEPTION 'not a word for the allow-list' USING ERRCODE = 'WA400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('username_word', 0));
  IF EXISTS (SELECT 1 FROM full_name_allow a WHERE a.word = folded) THEN
    RETURN 'exists';
  END IF;
  IF EXISTS (SELECT 1 FROM username_word u WHERE u.word = folded) THEN
    RAISE EXCEPTION 'the word is on the word lists' USING ERRCODE = 'WA409';
  END IF;
  SELECT coalesce(array_agg(p.name), '{}') INTO refused
  FROM full_name_probe p
  WHERE strpos(replace(full_name_fold(p.name), ' ', ''), folded) > 0 AND full_name_blocked(p.name);
  BEGIN
    INSERT INTO full_name_allow (word, language) VALUES (folded, lang);
  EXCEPTION
    WHEN check_violation THEN
      RAISE EXCEPTION 'not a word for the allow-list' USING ERRCODE = 'WA400';
  END;
  IF EXISTS (SELECT 1 FROM unnest(refused) n WHERE NOT full_name_blocked(n)) THEN
    RAISE EXCEPTION 'the word would let an abusive name through' USING ERRCODE = 'WA422';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'full_name_allow.add', 'full_name_allow', folded, jsonb_build_object('language', lang), request);
  RETURN 'added';
END $$;
REVOKE ALL ON FUNCTION admin_name_allow_add(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_name_allow_add(text, uuid) TO questify_app;

-- Removes an allow word, folded as it is added. Outcomes: removed, not_found. The names that hold it are refused again
-- at the join, and hidden again by the sweep the list trigger marks.
CREATE FUNCTION admin_name_allow_remove(old_word text, request uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := console_admin();
  gone full_name_allow;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('username_word', 0));
  DELETE FROM full_name_allow a WHERE a.word = full_name_fold(left(coalesce(old_word, ''), 60)) RETURNING a.* INTO gone;
  IF gone.word IS NULL THEN
    RETURN 'not_found';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, request_id)
  VALUES ('admin', me, 'full_name_allow.remove', 'full_name_allow', gone.word,
          jsonb_build_object('language', gone.language), request);
  RETURN 'removed';
END $$;
REVOKE ALL ON FUNCTION admin_name_allow_remove(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_name_allow_remove(text, uuid) TO questify_app;

-- The definers read the probes as the migration owner, which must bypass their forced row-level security (as 0177).
DO $$
BEGIN
  IF (SELECT count(*) FROM full_name_probe) = 0 THEN
    RAISE EXCEPTION 'the migration owner cannot read full_name_probe (row-level security is forced): grant it BYPASSRLS';
  END IF;
END $$;
