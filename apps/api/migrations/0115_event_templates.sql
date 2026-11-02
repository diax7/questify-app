-- T-601b: event templates (FR-1015; plan docs/plans/2026-11-02-t-601b-event-templates.md; ADR-404).
-- A template is a curated starting setup: categories with quests, rewards without stock, event switches, an accent and a
-- layout preset, in Arabic and English. The four shipped templates (conference, festival, campus, corporate) are rows of
-- `event_template` seeded below; after that they are data the Questify console edits (FR-1403), never code.
-- Two doors, nothing else new is granted:
--   event_templates()                      the enabled templates for a signed-in team member (AN404 for anyone else);
--   event_apply_template(event, key, req)  fills the empty draft the caller just made, inside their own organizer.
-- A template never holds a player, a point, a code or a secret: the quests are the type's own defaults, a typed entry code and
-- a quiz are not in a template, rewards are experiences and digital ones with no stock (item rewards need the prize desk's
-- place, which a new draft lacks: reward_desk_guard, FR-1716).
-- Deny by default: the table is closed to everyone but the definer doors (forced row-level security, no policy, no grant, as
-- `city` and `interest`), the helpers hold EXECUTE for nobody, PUBLIC holds none anywhere. No EXCEPTION block; earlier
-- migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the table
CREATE TABLE event_template (
  key            text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,29}$'),
  position       smallint NOT NULL UNIQUE CHECK (position >= 1),
  name_ar        text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 120),
  name_en        text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 120),
  description_ar text NOT NULL CHECK (length(btrim(description_ar)) BETWEEN 1 AND 300),
  description_en text NOT NULL CHECK (length(btrim(description_en)) BETWEEN 1 AND 300),
  -- {config, categories[], rewards[]}: the shape packages/shared/src/templates checks on every read.
  body           jsonb NOT NULL CHECK (
    jsonb_typeof(body) = 'object'
    AND coalesce(jsonb_typeof(body -> 'config'), '') = 'object'
    AND coalesce(jsonb_typeof(body -> 'categories'), '') = 'array'
    AND coalesce(jsonb_typeof(body -> 'rewards'), '') = 'array'),
  enabled        boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE event_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_template FORCE ROW LEVEL SECURITY;
REVOKE ALL ON event_template FROM PUBLIC, questify_app;

-- ================================================================ helpers (internal)
-- One category of a template with its quests, in order. Answers how many quests were added.
CREATE FUNCTION template_add_category(tgt event, cat jsonb, cat_position integer) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  cat_id uuid := gen_random_uuid();
  item   jsonb;
  placed integer := 0;
BEGIN
  INSERT INTO category (id, organizer_id, event_id, name_ar, name_en, position, order_mode, completion_bonus)
  VALUES (cat_id, tgt.organizer_id, tgt.id, cat ->> 'nameAr', cat ->> 'nameEn', cat_position,
          cat ->> 'orderMode', (cat ->> 'completionBonus')::integer);
  FOR item IN SELECT q FROM jsonb_array_elements(cat -> 'quests') AS q LOOP
    INSERT INTO quest (organizer_id, event_id, category_id, type, title_ar, title_en, description_ar, description_en,
                       points, repeat_cap, position, type_config)
    VALUES (tgt.organizer_id, tgt.id, cat_id, item ->> 'type', item ->> 'titleAr', item ->> 'titleEn',
            item ->> 'descriptionAr', item ->> 'descriptionEn', (item ->> 'points')::integer,
            (item ->> 'repeatCap')::integer, placed, item -> 'typeConfig');
    placed := placed + 1;
  END LOOP;
  RETURN placed;
END $$;
REVOKE ALL ON FUNCTION template_add_category(event, jsonb, integer) FROM PUBLIC;

-- The template's rewards, none with stock: an experience waits for the organizer's number, a digital reward for its codes.
CREATE FUNCTION template_add_rewards(tgt event, rewards jsonb) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO reward (organizer_id, event_id, kind, name_ar, name_en, description_ar, description_en, price, stock_total,
                      per_player_limit, section, tag_new, tag_limited, position)
  SELECT tgt.organizer_id, tgt.id, r.value ->> 'kind', r.value ->> 'nameAr', r.value ->> 'nameEn',
         r.value ->> 'descriptionAr', r.value ->> 'descriptionEn', (r.value ->> 'price')::integer, 0,
         (r.value ->> 'perPlayerLimit')::integer, r.value ->> 'section', (r.value ->> 'tagNew')::boolean,
         (r.value ->> 'tagLimited')::boolean, (r.ordinality - 1)::integer
  FROM jsonb_array_elements(rewards) WITH ORDINALITY AS r(value, ordinality);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION template_add_rewards(event, jsonb) FROM PUBLIC;

-- ================================================================ the doors
-- The enabled templates in order, for a signed-in team member. The API checks every body against the shared schema.
CREATE FUNCTION event_templates() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_staff_user_id() IS NULL THEN
    RAISE EXCEPTION 'the team only' USING ERRCODE = 'AN404';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'key', t.key,
             'name', jsonb_build_object('ar', t.name_ar, 'en', t.name_en),
             'description', jsonb_build_object('ar', t.description_ar, 'en', t.description_en),
             'body', t.body) ORDER BY t.position)
    FROM event_template t WHERE t.enabled), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION event_templates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_templates() TO questify_app;

-- Fills `target_event`, the empty draft the caller just made or opened, from the template `template_key`. Owner or editor of
-- the event (award_event_of; AN404 for an event of another organizer or outside an editor's limit); ET404 for a key that is
-- unknown or switched off; ED409 unless the target is an empty draft (T-601's rule: no quest, reward, item, join field or
-- enrollment, and only the General category every event starts with, which the template's categories replace). The template's
-- switches and accent are laid over the event's own; the layout preset is named in the answer for the API to apply. Audited
-- `event.template` with the key and the counts.
CREATE FUNCTION event_apply_template(target_event uuid, template_key text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tgt     event := award_event_of(target_event);
  tpl     event_template;
  cfg     jsonb;
  cat     jsonb;
  quests  integer := 0;
  cats    integer := 0;
  rewards integer;
BEGIN
  SELECT * INTO tpl FROM event_template t WHERE t.key = template_key AND t.enabled;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such template' USING ERRCODE = 'ET404', DETAIL = 'unknown_template';
  END IF;
  SELECT * INTO tgt FROM event e WHERE e.id = tgt.id FOR NO KEY UPDATE;
  IF tgt.status <> 'draft' OR NOT event_copy_target_ok(tgt.id) THEN
    RAISE EXCEPTION 'the event must be an empty draft' USING ERRCODE = 'ED409', DETAIL = 'target_not_empty';
  END IF;
  DELETE FROM category c WHERE c.event_id = tgt.id;
  FOR cat IN SELECT c FROM jsonb_array_elements(tpl.body -> 'categories') AS c LOOP
    quests := quests + template_add_category(tgt, cat, cats);
    cats := cats + 1;
  END LOOP;
  rewards := template_add_rewards(tgt, tpl.body -> 'rewards');
  cfg := tpl.body -> 'config';
  UPDATE event e SET
    config = e.config
      || jsonb_build_object('features', coalesce(e.config -> 'features', '{}'::jsonb) || (cfg -> 'features'))
      || jsonb_build_object('branding', jsonb_build_object('accent', cfg -> 'accent')),
    config_version = e.config_version + 1
  WHERE e.id = tgt.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), tgt.organizer_id, tgt.id, 'event.template', 'event', tgt.id::text,
          jsonb_build_object('template', tpl.key, 'categories', cats, 'quests', quests, 'rewards', rewards), request);
  RETURN jsonb_build_object('template', tpl.key, 'categories', cats, 'quests', quests, 'rewards', rewards,
                            'layoutPreset', cfg ->> 'layoutPreset');
END $$;
REVOKE ALL ON FUNCTION event_apply_template(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_apply_template(uuid, text, uuid) TO questify_app;

-- ================================================================ the four shipped templates
INSERT INTO event_template (key, position, name_ar, name_en, description_ar, description_en, body) VALUES
  ($q$conference$q$, 1, $q$مؤتمر$q$, $q$Conference$q$,
   $q$جلسات وأجنحة وتعارف: نقاط للحضور والتفاعل والتقييم.$q$,
   $q$Sessions, booths and networking: points for showing up, joining in and giving feedback.$q$,
   $tpl${
 "config": {
  "features": {
   "miniGames": false,
   "questRatings": true
  },
  "accent": "sky",
  "layoutPreset": "classic"
 },
 "categories": [
  {
   "nameAr": "ابدأ يومك",
   "nameEn": "Start your day",
   "orderMode": "any",
   "completionBonus": 0,
   "quests": [
    {
     "type": "scan_qr",
     "titleAr": "سجّل حضورك",
     "titleEn": "Check in",
     "descriptionAr": "امسح الرمز عند مكتب التسجيل.",
     "descriptionEn": "Scan the code at the registration desk.",
     "points": 50,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "scan_qr",
     "titleAr": "اعثر على القاعة الرئيسية",
     "titleEn": "Find the main hall",
     "descriptionAr": "امسح الرمز عند مدخل القاعة الرئيسية.",
     "descriptionEn": "Scan the code at the main hall entrance.",
     "points": 30,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "survey",
     "titleAr": "عرّفنا بنفسك",
     "titleEn": "Tell us about you",
     "descriptionAr": "أجب عن سؤالين قصيرين.",
     "descriptionEn": "Answer two short questions.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {
      "questions": [
       {
        "id": "reason",
        "text": {
         "ar": "ما الذي جاء بك اليوم؟",
         "en": "What brings you here today?"
        },
        "kind": "choice",
        "required": true,
        "choices": [
         {
          "id": "learn",
          "text": {
           "ar": "التعلّم",
           "en": "Learning"
          }
         },
         {
          "id": "network",
          "text": {
           "ar": "بناء علاقات",
           "en": "Networking"
          }
         },
         {
          "id": "jobs",
          "text": {
           "ar": "فرص عمل",
           "en": "Job opportunities"
          }
         },
         {
          "id": "support",
          "text": {
           "ar": "دعم أحد المتحدثين",
           "en": "Supporting a speaker"
          }
         },
         {
          "id": "other",
          "text": {
           "ar": "سبب آخر",
           "en": "Something else"
          }
         }
        ]
       },
       {
        "id": "heard",
        "text": {
         "ar": "كيف عرفت بالمؤتمر؟",
         "en": "How did you hear about the conference?"
        },
        "kind": "choice",
        "required": true,
        "choices": [
         {
          "id": "social",
          "text": {
           "ar": "وسائل التواصل",
           "en": "Social media"
          }
         },
         {
          "id": "email",
          "text": {
           "ar": "بريد إلكتروني",
           "en": "Email"
          }
         },
         {
          "id": "friend",
          "text": {
           "ar": "صديق أو زميل",
           "en": "A friend or colleague"
          }
         },
         {
          "id": "site",
          "text": {
           "ar": "موقع الفعالية",
           "en": "The event website"
          }
         },
         {
          "id": "other",
          "text": {
           "ar": "غير ذلك",
           "en": "Something else"
          }
         }
        ]
       }
      ]
     }
    }
   ]
  },
  {
   "nameAr": "تعارف",
   "nameEn": "Meet people",
   "orderMode": "any",
   "completionBonus": 50,
   "quests": [
    {
     "type": "meet",
     "titleAr": "تعرّف على شخص جديد",
     "titleEn": "Meet someone new",
     "descriptionAr": "أحدكما يعرض رمز التعارف في التطبيق والآخر يمسحه، ويحصل كلاكما على المكافأة.",
     "descriptionEn": "One of you shows the meet code in the app and the other scans it. You both get the reward.",
     "points": 20,
     "repeatCap": 10,
     "typeConfig": {
      "dailyCap": 5
     }
    },
    {
     "type": "challenge",
     "titleAr": "سلّم على أحد المتحدثين",
     "titleEn": "Say hello to a speaker",
     "descriptionAr": "تحدّث مع أحد المتحدثين، ثم أرِ المشغّل رمزك الخاص ليؤكدها.",
     "descriptionEn": "Talk to a speaker, then show your own code to a staff member to confirm it.",
     "points": 100,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "submission",
     "titleAr": "شاركنا أهم فكرة",
     "titleEn": "Share your takeaway",
     "descriptionAr": "اكتب في سطرين أو ثلاثة أفضل فكرة سمعتها اليوم.",
     "descriptionEn": "In two or three lines, write the best idea you heard today.",
     "points": 100,
     "repeatCap": 1,
     "typeConfig": {
      "accepts": [
       "text"
      ],
      "autoApprove": false,
      "resubmit": false
     }
    }
   ]
  },
  {
   "nameAr": "الأجنحة",
   "nameEn": "Booths",
   "orderMode": "any",
   "completionBonus": 100,
   "quests": [
    {
     "type": "scan_qr",
     "titleAr": "زر الجناح 1",
     "titleEn": "Visit booth 1",
     "descriptionAr": "امسح الرمز المعروض عند الجناح.",
     "descriptionEn": "Scan the code displayed at the booth.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "scan_qr",
     "titleAr": "زر الجناح 2",
     "titleEn": "Visit booth 2",
     "descriptionAr": "امسح الرمز المعروض عند الجناح.",
     "descriptionEn": "Scan the code displayed at the booth.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "scan_qr",
     "titleAr": "زر الجناح 3",
     "titleEn": "Visit booth 3",
     "descriptionAr": "امسح الرمز المعروض عند الجناح.",
     "descriptionEn": "Scan the code displayed at the booth.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {}
    }
   ]
  },
  {
   "nameAr": "ختام اليوم",
   "nameEn": "Wrap up",
   "orderMode": "any",
   "completionBonus": 0,
   "quests": [
    {
     "type": "survey",
     "titleAr": "قيّم يومك",
     "titleEn": "Rate your day",
     "descriptionAr": "رأيك يساعدنا على التحسين.",
     "descriptionEn": "Your opinion helps us improve.",
     "points": 60,
     "repeatCap": 1,
     "typeConfig": {
      "questions": [
       {
        "id": "day",
        "text": {
         "ar": "كيف كان يومك؟",
         "en": "How was your day?"
        },
        "kind": "rating",
        "required": true
       },
       {
        "id": "improve",
        "text": {
         "ar": "ما الذي نحسّنه في المرة القادمة؟",
         "en": "What should we improve next time?"
        },
        "kind": "text",
        "required": false
       }
      ]
     }
    }
   ]
  }
 ],
 "rewards": [
  {
   "kind": "experience",
   "nameAr": "مقعد في الصف الأول",
   "nameEn": "Front-row seat",
   "descriptionAr": "احجز مقعدك في الصف الأول لجلسة من اختيارك.",
   "descriptionEn": "Reserve a front-row seat for a session of your choice.",
   "price": 350,
   "perPlayerLimit": null,
   "section": "experiences",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "experience",
   "nameAr": "مقعد في ورشة عمل",
   "nameEn": "Workshop seat",
   "descriptionAr": "احجز مكانك في ورشة عمل تطبيقية.",
   "descriptionEn": "Hold your place in a hands-on workshop.",
   "price": 450,
   "perPlayerLimit": null,
   "section": "experiences",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "experience",
   "nameAr": "لقاء مع المتحدثين",
   "nameEn": "Meet the speakers",
   "descriptionAr": "انضم إلى لقاء صغير مع المتحدثين.",
   "descriptionEn": "Join a small meet-and-greet with the speakers.",
   "price": 500,
   "perPlayerLimit": null,
   "section": "featured",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "digital",
   "nameAr": "قسيمة قهوة",
   "nameEn": "Coffee voucher",
   "descriptionAr": "قسيمة لفنجان قهوة من ركن الضيافة.",
   "descriptionEn": "A voucher for a coffee at the hospitality corner.",
   "price": 150,
   "perPlayerLimit": null,
   "section": "food",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "digital",
   "nameAr": "رمز خصم من الشركاء",
   "nameEn": "Partner discount code",
   "descriptionAr": "رمز خصم من أحد شركاء المؤتمر.",
   "descriptionEn": "A discount code from one of the conference partners.",
   "price": 250,
   "perPlayerLimit": null,
   "section": null,
   "tagNew": false,
   "tagLimited": false
  }
 ]
}$tpl$::jsonb),
  ($q$festival$q$, 2, $q$مهرجان$q$, $q$Festival$q$,
   $q$جولة بين المسارح والأركان: ألعاب وتحديات وتصويت ونقاط لكل لحظة.$q$,
   $q$A day between stages and stalls: games, challenges, polls and points for every moment.$q$,
   $tpl${
 "config": {
  "features": {},
  "accent": "ember",
  "layoutPreset": "play_first"
 },
 "categories": [
  {
   "nameAr": "مرحبًا بك",
   "nameEn": "Welcome",
   "orderMode": "any",
   "completionBonus": 0,
   "quests": [
    {
     "type": "scan_qr",
     "titleAr": "ادخل المهرجان",
     "titleEn": "Enter the festival",
     "descriptionAr": "امسح الرمز عند البوابة.",
     "descriptionEn": "Scan the code at the gate.",
     "points": 50,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "scan_qr",
     "titleAr": "اعثر على المسرح الرئيسي",
     "titleEn": "Find the main stage",
     "descriptionAr": "امسح الرمز عند المسرح الرئيسي.",
     "descriptionEn": "Scan the code at the main stage.",
     "points": 30,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "game",
     "titleAr": "لعبة الإحماء",
     "titleEn": "Warm-up game",
     "descriptionAr": "أنجز اللعبة لتحصل على مكافأتك.",
     "descriptionEn": "Finish the game to get your reward.",
     "points": 30,
     "repeatCap": 1,
     "typeConfig": {
      "game": "memory_match",
      "level": "easy",
      "attempts": 3,
      "cooldownMinutes": null
     }
    }
   ]
  },
  {
   "nameAr": "على المسارح",
   "nameEn": "On the stages",
   "orderMode": "any",
   "completionBonus": 0,
   "quests": [
    {
     "type": "vote",
     "titleAr": "كيف مزاجك؟",
     "titleEn": "How are you feeling?",
     "descriptionAr": "اختر ما يصفك الآن.",
     "descriptionEn": "Pick what describes you right now.",
     "points": 20,
     "repeatCap": 1,
     "typeConfig": {
      "options": [
       {
        "id": "pumped",
        "text": {
         "ar": "متحمّس",
         "en": "Pumped"
        }
       },
       {
        "id": "fun",
        "text": {
         "ar": "مستمتع",
         "en": "Having fun"
        }
       },
       {
        "id": "coffee",
        "text": {
         "ar": "أحتاج قهوة",
         "en": "Need a coffee"
        }
       }
      ]
     }
    },
    {
     "type": "scan_qr",
     "titleAr": "زر المسرح الثاني",
     "titleEn": "Visit the second stage",
     "descriptionAr": "امسح الرمز عند المسرح الثاني.",
     "descriptionEn": "Scan the code at the second stage.",
     "points": 30,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "challenge",
     "titleAr": "تحدّي الرقص",
     "titleEn": "Dance challenge",
     "descriptionAr": "شارك في تحدّي الرقص أمام أحد المشغّلين، ثم أرِ المشغّل رمزك الخاص ليؤكدها.",
     "descriptionEn": "Join the dance challenge in front of a staff member, then show your own code to a staff member to confirm it.",
     "points": 100,
     "repeatCap": 1,
     "typeConfig": {}
    }
   ]
  },
  {
   "nameAr": "الأركان والطعام",
   "nameEn": "Stalls and food",
   "orderMode": "any",
   "completionBonus": 80,
   "quests": [
    {
     "type": "scan_qr",
     "titleAr": "جرّب شيئًا لذيذًا",
     "titleEn": "Try something tasty",
     "descriptionAr": "امسح الرمز عند ركن الطعام.",
     "descriptionEn": "Scan the code at the food stall.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "scan_qr",
     "titleAr": "زر ركن الحرف",
     "titleEn": "Visit the craft corner",
     "descriptionAr": "امسح الرمز عند ركن الحرف.",
     "descriptionEn": "Scan the code at the craft corner.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "meet",
     "titleAr": "تعرّف على شخص جديد",
     "titleEn": "Meet someone new",
     "descriptionAr": "أحدكما يعرض رمز التعارف في التطبيق والآخر يمسحه، ويحصل كلاكما على المكافأة.",
     "descriptionEn": "One of you shows the meet code in the app and the other scans it. You both get the reward.",
     "points": 20,
     "repeatCap": 5,
     "typeConfig": {
      "dailyCap": 5
     }
    }
   ]
  },
  {
   "nameAr": "شارك اللحظة",
   "nameEn": "Share the moment",
   "orderMode": "any",
   "completionBonus": 0,
   "quests": [
    {
     "type": "share",
     "titleAr": "انشر الحماس",
     "titleEn": "Spread the word",
     "descriptionAr": "شارك رسالتنا مع أصدقائك.",
     "descriptionEn": "Share our message with your friends.",
     "points": 50,
     "repeatCap": 1,
     "typeConfig": {
      "message": {
       "ar": "أستمتع الآن بالمهرجان! تعال والعب معي.",
       "en": "I'm having a great time at the festival! Come play with me."
      }
     }
    },
    {
     "type": "submission",
     "titleAr": "أجمل لحظة",
     "titleEn": "Best moment",
     "descriptionAr": "اكتب لنا عن أجمل لحظة عشتها حتى الآن.",
     "descriptionEn": "Tell us about the best moment you have had so far.",
     "points": 80,
     "repeatCap": 1,
     "typeConfig": {
      "accepts": [
       "text"
      ],
      "autoApprove": false,
      "resubmit": false
     }
    },
    {
     "type": "survey",
     "titleAr": "قيّم المهرجان",
     "titleEn": "Rate the festival",
     "descriptionAr": "رأيك يساعدنا على التحسين.",
     "descriptionEn": "Your opinion helps us improve.",
     "points": 50,
     "repeatCap": 1,
     "typeConfig": {
      "questions": [
       {
        "id": "overall",
        "text": {
         "ar": "كيف كان المهرجان؟",
         "en": "How was the festival?"
        },
        "kind": "rating",
        "required": true
       },
       {
        "id": "best",
        "text": {
         "ar": "ما الذي أعجبك أكثر؟",
         "en": "What did you enjoy most?"
        },
        "kind": "choice",
        "required": true,
        "choices": [
         {
          "id": "shows",
          "text": {
           "ar": "الموسيقى والعروض",
           "en": "The music and shows"
          }
         },
         {
          "id": "food",
          "text": {
           "ar": "الطعام",
           "en": "The food"
          }
         },
         {
          "id": "games",
          "text": {
           "ar": "الألعاب",
           "en": "The games"
          }
         },
         {
          "id": "vibe",
          "text": {
           "ar": "الأجواء",
           "en": "The atmosphere"
          }
         },
         {
          "id": "other",
          "text": {
           "ar": "غير ذلك",
           "en": "Something else"
          }
         }
        ]
       }
      ]
     }
    }
   ]
  }
 ],
 "rewards": [
  {
   "kind": "experience",
   "nameAr": "جولة خلف الكواليس",
   "nameEn": "Backstage tour",
   "descriptionAr": "شاهد المسرح من الداخل مع فريق التنظيم.",
   "descriptionEn": "See the stage from the inside with the crew.",
   "price": 450,
   "perPlayerLimit": null,
   "section": "featured",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "experience",
   "nameAr": "صورة مع الفنانين",
   "nameEn": "Photo with the performers",
   "descriptionAr": "التقط صورة تذكارية مع فنانين من الحفل.",
   "descriptionEn": "Take a souvenir photo with performers from the show.",
   "price": 350,
   "perPlayerLimit": null,
   "section": "experiences",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "experience",
   "nameAr": "دخول بلا طابور",
   "nameEn": "Skip the line",
   "descriptionAr": "ادخل من مسار سريع في إحدى الفعاليات.",
   "descriptionEn": "Use the fast lane at one of the attractions.",
   "price": 200,
   "perPlayerLimit": null,
   "section": "experiences",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "digital",
   "nameAr": "قسيمة مشروب",
   "nameEn": "Drink voucher",
   "descriptionAr": "قسيمة لمشروب من أحد الأركان.",
   "descriptionEn": "A voucher for a drink at one of the stalls.",
   "price": 100,
   "perPlayerLimit": null,
   "section": "food",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "digital",
   "nameAr": "رمز خصم على الطعام",
   "nameEn": "Food discount code",
   "descriptionAr": "رمز خصم في أحد أركان الطعام.",
   "descriptionEn": "A discount code at one of the food stalls.",
   "price": 150,
   "perPlayerLimit": null,
   "section": "food",
   "tagNew": false,
   "tagLimited": false
  }
 ]
}$tpl$::jsonb),
  ($q$campus$q$, 3, $q$فعالية جامعية$q$, $q$Campus event$q$,
   $q$تعرّف على الحرم والأندية والخدمات عبر يوم من التحديات والتعارف.$q$,
   $q$Get to know the campus, clubs and services through a day of challenges and meeting people.$q$,
   $tpl${
 "config": {
  "features": {
   "questRatings": true
  },
  "accent": "lagoon",
  "layoutPreset": "play_first"
 },
 "categories": [
  {
   "nameAr": "تعرّف على الحرم",
   "nameEn": "Know the campus",
   "orderMode": "any",
   "completionBonus": 60,
   "quests": [
    {
     "type": "scan_qr",
     "titleAr": "زر المكتبة",
     "titleEn": "Visit the library",
     "descriptionAr": "امسح الرمز عند مدخل المكتبة.",
     "descriptionEn": "Scan the code at the library entrance.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "scan_qr",
     "titleAr": "اعثر على مكتب شؤون الطلاب",
     "titleEn": "Find the student services office",
     "descriptionAr": "امسح الرمز عند مكتب شؤون الطلاب.",
     "descriptionEn": "Scan the code at the student services office.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "scan_qr",
     "titleAr": "زر الصالة الرياضية",
     "titleEn": "Visit the sports hall",
     "descriptionAr": "امسح الرمز عند مدخل الصالة الرياضية.",
     "descriptionEn": "Scan the code at the sports hall entrance.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "scan_qr",
     "titleAr": "مرّ بالمقصف",
     "titleEn": "Stop by the cafeteria",
     "descriptionAr": "امسح الرمز عند المقصف.",
     "descriptionEn": "Scan the code at the cafeteria.",
     "points": 30,
     "repeatCap": 1,
     "typeConfig": {}
    }
   ]
  },
  {
   "nameAr": "الأندية والأنشطة",
   "nameEn": "Clubs and activities",
   "orderMode": "any",
   "completionBonus": 80,
   "quests": [
    {
     "type": "scan_qr",
     "titleAr": "زر ركن النادي الأول",
     "titleEn": "Visit club booth 1",
     "descriptionAr": "امسح الرمز عند ركن النادي.",
     "descriptionEn": "Scan the code at the club booth.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "scan_qr",
     "titleAr": "زر ركن النادي الثاني",
     "titleEn": "Visit club booth 2",
     "descriptionAr": "امسح الرمز عند ركن النادي.",
     "descriptionEn": "Scan the code at the club booth.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "challenge",
     "titleAr": "شارك في نشاط نادٍ",
     "titleEn": "Join a club activity",
     "descriptionAr": "جرّب نشاطًا في أحد الأندية، ثم أرِ المشغّل رمزك الخاص ليؤكدها.",
     "descriptionEn": "Try an activity at one of the clubs, then show your own code to a staff member to confirm it.",
     "points": 100,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "vote",
     "titleAr": "ما النشاط الذي تريده أكثر؟",
     "titleEn": "Which activity do you want more of?",
     "descriptionAr": "اختر نشاطًا واحدًا.",
     "descriptionEn": "Pick one activity.",
     "points": 20,
     "repeatCap": 1,
     "typeConfig": {
      "options": [
       {
        "id": "sports",
        "text": {
         "ar": "الرياضة",
         "en": "Sports"
        }
       },
       {
        "id": "arts",
        "text": {
         "ar": "الفنون",
         "en": "Arts"
        }
       },
       {
        "id": "tech",
        "text": {
         "ar": "التقنية",
         "en": "Technology"
        }
       },
       {
        "id": "volunteer",
        "text": {
         "ar": "التطوع",
         "en": "Volunteering"
        }
       },
       {
        "id": "culture",
        "text": {
         "ar": "الثقافة",
         "en": "Culture"
        }
       }
      ]
     }
    }
   ]
  },
  {
   "nameAr": "تعارف الطلاب",
   "nameEn": "Meet classmates",
   "orderMode": "any",
   "completionBonus": 0,
   "quests": [
    {
     "type": "meet",
     "titleAr": "تعرّف على زميل جديد",
     "titleEn": "Meet a new classmate",
     "descriptionAr": "أحدكما يعرض رمز التعارف في التطبيق والآخر يمسحه، ويحصل كلاكما على المكافأة.",
     "descriptionEn": "One of you shows the meet code in the app and the other scans it. You both get the reward.",
     "points": 20,
     "repeatCap": 8,
     "typeConfig": {
      "dailyCap": 5
     }
    },
    {
     "type": "game",
     "titleAr": "استراحة ذهنية",
     "titleEn": "Brain break",
     "descriptionAr": "أنجز اللعبة لتحصل على مكافأتك.",
     "descriptionEn": "Finish the game to get your reward.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {
      "game": "slide_puzzle",
      "level": "easy",
      "attempts": 3,
      "cooldownMinutes": null
     }
    },
    {
     "type": "share",
     "titleAr": "شارك يومك",
     "titleEn": "Share your day",
     "descriptionAr": "شارك رسالتنا مع زملائك.",
     "descriptionEn": "Share our message with your classmates.",
     "points": 40,
     "repeatCap": 1,
     "typeConfig": {
      "message": {
       "ar": "أقضي يومًا رائعًا في الفعالية الجامعية! انضم إلينا.",
       "en": "I'm having a great day at the campus event! Join us."
      }
     }
    }
   ]
  },
  {
   "nameAr": "رأيك يهمنا",
   "nameEn": "Your feedback",
   "orderMode": "any",
   "completionBonus": 0,
   "quests": [
    {
     "type": "survey",
     "titleAr": "رأيك في اليوم",
     "titleEn": "Your view of the day",
     "descriptionAr": "رأيك يساعدنا على التحسين.",
     "descriptionEn": "Your opinion helps us improve.",
     "points": 50,
     "repeatCap": 1,
     "typeConfig": {
      "questions": [
       {
        "id": "day",
        "text": {
         "ar": "كيف كان اليوم؟",
         "en": "How was the day?"
        },
        "kind": "rating",
        "required": true
       },
       {
        "id": "year",
        "text": {
         "ar": "في أي سنة دراسية أنت؟",
         "en": "Which year are you in?"
        },
        "kind": "choice",
        "required": true,
        "choices": [
         {
          "id": "first",
          "text": {
           "ar": "السنة الأولى",
           "en": "First year"
          }
         },
         {
          "id": "second",
          "text": {
           "ar": "السنة الثانية",
           "en": "Second year"
          }
         },
         {
          "id": "third",
          "text": {
           "ar": "السنة الثالثة",
           "en": "Third year"
          }
         },
         {
          "id": "fourth",
          "text": {
           "ar": "السنة الرابعة فأكثر",
           "en": "Fourth year or above"
          }
         }
        ]
       }
      ]
     }
    }
   ]
  }
 ],
 "rewards": [
  {
   "kind": "experience",
   "nameAr": "غداء مع أحد أعضاء هيئة التدريس",
   "nameEn": "Lunch with a faculty member",
   "descriptionAr": "تناول الغداء مع أحد أعضاء هيئة التدريس في جلسة صغيرة.",
   "descriptionEn": "Have lunch with a faculty member in a small group.",
   "price": 450,
   "perPlayerLimit": null,
   "section": "featured",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "experience",
   "nameAr": "حجز غرفة دراسة",
   "nameEn": "Study room booking",
   "descriptionAr": "احجز غرفة دراسة لك ولزملائك.",
   "descriptionEn": "Book a study room for you and your classmates.",
   "price": 200,
   "perPlayerLimit": null,
   "section": "experiences",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "digital",
   "nameAr": "قسيمة من المقصف",
   "nameEn": "Cafeteria voucher",
   "descriptionAr": "قسيمة لوجبة خفيفة من المقصف.",
   "descriptionEn": "A voucher for a snack at the cafeteria.",
   "price": 100,
   "perPlayerLimit": null,
   "section": "food",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "digital",
   "nameAr": "رمز خصم من المكتبة",
   "nameEn": "Bookstore discount code",
   "descriptionAr": "رمز خصم على مشترياتك من المكتبة.",
   "descriptionEn": "A discount code for your bookstore purchases.",
   "price": 150,
   "perPlayerLimit": null,
   "section": null,
   "tagNew": false,
   "tagLimited": false
  }
 ]
}$tpl$::jsonb),
  ($q$corporate$q$, 4, $q$فعالية الشركة$q$, $q$Company event$q$,
   $q$يوم لفريق العمل: تعارف بين الإدارات وتحديات جماعية وأفكار تُسمع.$q$,
   $q$A day for the team: meeting across departments, group challenges and ideas worth hearing.$q$,
   $tpl${
 "config": {
  "features": {
   "miniGames": false,
   "shareQuests": false
  },
  "accent": "violet",
  "layoutPreset": "prizes_first"
 },
 "categories": [
  {
   "nameAr": "انطلاقة الفريق",
   "nameEn": "Team kick-off",
   "orderMode": "any",
   "completionBonus": 0,
   "quests": [
    {
     "type": "scan_qr",
     "titleAr": "سجّل حضورك",
     "titleEn": "Check in",
     "descriptionAr": "امسح الرمز عند مكتب الاستقبال.",
     "descriptionEn": "Scan the code at the reception desk.",
     "points": 50,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "survey",
     "titleAr": "تعارف سريع",
     "titleEn": "Quick intro",
     "descriptionAr": "أجب عن سؤال واحد.",
     "descriptionEn": "Answer one question.",
     "points": 30,
     "repeatCap": 1,
     "typeConfig": {
      "questions": [
       {
        "id": "tenure",
        "text": {
         "ar": "منذ متى تعمل معنا؟",
         "en": "How long have you been with the company?"
        },
        "kind": "choice",
        "required": true,
        "choices": [
         {
          "id": "new",
          "text": {
           "ar": "أقل من سنة",
           "en": "Less than a year"
          }
         },
         {
          "id": "one",
          "text": {
           "ar": "من 1 إلى 3 سنوات",
           "en": "1 to 3 years"
          }
         },
         {
          "id": "three",
          "text": {
           "ar": "من 3 إلى 5 سنوات",
           "en": "3 to 5 years"
          }
         },
         {
          "id": "five",
          "text": {
           "ar": "أكثر من 5 سنوات",
           "en": "More than 5 years"
          }
         }
        ]
       }
      ]
     }
    }
   ]
  },
  {
   "nameAr": "تعارف بين الإدارات",
   "nameEn": "Across departments",
   "orderMode": "any",
   "completionBonus": 100,
   "quests": [
    {
     "type": "meet",
     "titleAr": "تعرّف على زميل من إدارة أخرى",
     "titleEn": "Meet a colleague from another department",
     "descriptionAr": "أحدكما يعرض رمز التعارف في التطبيق والآخر يمسحه، ويحصل كلاكما على المكافأة.",
     "descriptionEn": "One of you shows the meet code in the app and the other scans it. You both get the reward.",
     "points": 30,
     "repeatCap": 5,
     "typeConfig": {
      "dailyCap": 5
     }
    },
    {
     "type": "challenge",
     "titleAr": "غداء مع زميل جديد",
     "titleEn": "Lunch with someone new",
     "descriptionAr": "اجلس مع زميل لا تعمل معه عادة، ثم أرِ المشغّل رمزك الخاص ليؤكدها.",
     "descriptionEn": "Sit with a colleague you don't usually work with, then show your own code to a staff member to confirm it.",
     "points": 100,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "challenge",
     "titleAr": "صورة جماعية",
     "titleEn": "Team photo",
     "descriptionAr": "التقط صورة جماعية مع فريقك، ثم أرِ المشغّل رمزك الخاص ليؤكدها.",
     "descriptionEn": "Take a group photo with your team, then show your own code to a staff member to confirm it.",
     "points": 80,
     "repeatCap": 1,
     "typeConfig": {}
    }
   ]
  },
  {
   "nameAr": "أفكار وتصويت",
   "nameEn": "Ideas and votes",
   "orderMode": "any",
   "completionBonus": 0,
   "quests": [
    {
     "type": "submission",
     "titleAr": "فكرة للفريق",
     "titleEn": "One idea for the team",
     "descriptionAr": "اكتب فكرة تجعل العمل عندنا أفضل.",
     "descriptionEn": "Write one idea that would make work better for us.",
     "points": 100,
     "repeatCap": 1,
     "typeConfig": {
      "accepts": [
       "text"
      ],
      "autoApprove": false,
      "resubmit": false
     }
    },
    {
     "type": "vote",
     "titleAr": "ماذا نريد أكثر؟",
     "titleEn": "What should we do more of?",
     "descriptionAr": "اختر ما تريده أكثر.",
     "descriptionEn": "Pick what you would like more of.",
     "points": 20,
     "repeatCap": 1,
     "typeConfig": {
      "options": [
       {
        "id": "events",
        "text": {
         "ar": "فعاليات الفريق",
         "en": "Team events"
        }
       },
       {
        "id": "training",
        "text": {
         "ar": "التدريب",
         "en": "Training"
        }
       },
       {
        "id": "flex",
        "text": {
         "ar": "مرونة العمل",
         "en": "Flexible work"
        }
       },
       {
        "id": "community",
        "text": {
         "ar": "مبادرات مجتمعية",
         "en": "Community initiatives"
        }
       }
      ]
     }
    }
   ]
  },
  {
   "nameAr": "الختام",
   "nameEn": "Wrap up",
   "orderMode": "any",
   "completionBonus": 0,
   "quests": [
    {
     "type": "scan_qr",
     "titleAr": "احضر الجلسة الختامية",
     "titleEn": "Join the closing session",
     "descriptionAr": "امسح الرمز عند مدخل الجلسة الختامية.",
     "descriptionEn": "Scan the code at the closing session entrance.",
     "points": 50,
     "repeatCap": 1,
     "typeConfig": {}
    },
    {
     "type": "survey",
     "titleAr": "رأيك في الفعالية",
     "titleEn": "Your view of the event",
     "descriptionAr": "رأيك يساعدنا على التحسين.",
     "descriptionEn": "Your opinion helps us improve.",
     "points": 60,
     "repeatCap": 1,
     "typeConfig": {
      "questions": [
       {
        "id": "useful",
        "text": {
         "ar": "ما مدى فائدة هذا اليوم؟",
         "en": "How useful was today?"
        },
        "kind": "rating",
        "required": true
       },
       {
        "id": "more",
        "text": {
         "ar": "ما الذي نضيفه في المرة القادمة؟",
         "en": "What should we add next time?"
        },
        "kind": "text",
        "required": false
       }
      ]
     }
    }
   ]
  }
 ],
 "rewards": [
  {
   "kind": "experience",
   "nameAr": "غداء مع الإدارة",
   "nameEn": "Lunch with the leadership",
   "descriptionAr": "تناول الغداء مع أحد أعضاء الإدارة العليا.",
   "descriptionEn": "Have lunch with a member of the leadership team.",
   "price": 500,
   "perPlayerLimit": null,
   "section": "featured",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "experience",
   "nameAr": "غداء لفريقك",
   "nameEn": "Team lunch",
   "descriptionAr": "غداء لفريقك كله على حساب الشركة.",
   "descriptionEn": "A lunch for your whole team, on the company.",
   "price": 450,
   "perPlayerLimit": null,
   "section": "experiences",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "experience",
   "nameAr": "موقف سيارة مميز",
   "nameEn": "Premium parking spot",
   "descriptionAr": "موقف سيارة مميز لمدة أسبوع.",
   "descriptionEn": "A premium parking spot for a week.",
   "price": 300,
   "perPlayerLimit": null,
   "section": "experiences",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "digital",
   "nameAr": "قسيمة قهوة",
   "nameEn": "Coffee voucher",
   "descriptionAr": "قسيمة لفنجان قهوة.",
   "descriptionEn": "A voucher for a coffee.",
   "price": 100,
   "perPlayerLimit": null,
   "section": "food",
   "tagNew": false,
   "tagLimited": false
  },
  {
   "kind": "digital",
   "nameAr": "رمز بطاقة هدية",
   "nameEn": "Gift card code",
   "descriptionAr": "رمز بطاقة هدية من أحد الشركاء.",
   "descriptionEn": "A gift card code from one of our partners.",
   "price": 250,
   "perPlayerLimit": null,
   "section": null,
   "tagNew": false,
   "tagLimited": false
  }
 ]
}$tpl$::jsonb);
