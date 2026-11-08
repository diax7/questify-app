# Arabic glossary and copy rules

Written for the T-808 machine-checkable sweep (2026-11-07, `ux-araby` rules). It records the terms most strings already use,
so the next string keeps to them. It does not replace the person's read of every screen, which T-808 still needs.

## Rules applied

- **Western digits only** (ADR-018). None found in any Arabic string.
- **The brand is "Questify" in Latin letters** (ADR-125; «كويستفاي» is gone from the dashboard, app, emails, error texts and
  alerts). Left: the SMS family, see "Left for a human decision".
- **Masculine imperative** for actions («حاول مرة أخرى», «اختر»); "Skip" is «تخطي» (no shadda).
- **No «تم» + noun.** System confirmations use the light passive the product already used most: «حُفظت التغييرات»,
  «حُذف», «أُرسل». A heavy passive becomes a نحن verb («سجّلنا حضورك») or a nominal («البدء والانتهاء محدَّدان»).
  Real completion is «اكتمل» («اكتمل الدفع», «اكتمل الربط»).
- **No «الخاص بك», no «لديك» opening a notification** («وصلتك رسالة جديدة», «اسم مستخدمك»).
- **Tanween spelled out** («لاحقًا», «قليلًا», «أولًا», «مؤقتًا»); one spelling per word («تحقق», «تعذّر», «تخطي»).
- **Retry:** «حاول مرة أخرى» (not «أعد المحاولة», «حاول مجددًا»). The button «إعادة المحاولة» stays.
- **Counts:** where the number can be 1 to 10 and the noun would need a plural form, the text is a label plus the number
  («اللاعبون المنضمون: {count}»), as the product already does («الأجهزة المرتبطة: {count}»).
- Arabic comma «،» and question mark «؟»; placeholders keep their names and order; event words (FR-942) are untouched.

## Glossary (the term most strings use)

| Concept | Use | Not |
|---|---|---|
| Event | الفعالية | الحدث |
| Quest / category | المهمة (مهام) / الفئة | تحدٍّ for a generic quest |
| Points / currency | النقاط (the event's own word) | |
| Balance | الرصيد | |
| Prize / reward in the shop | الجائزة | مكافأة (a bonus of points: مكافأة الإكمال) |
| Prize desk | مكتب الجوائز | منصة الجوائز (a podium, wrong) |
| Ranking | الترتيب | |
| Sign in / out | تسجيل الدخول / تسجيل الخروج | |
| Player | اللاعب | المشارك, المستخدم |
| Operator / organizer | المشغّل / المنظِّم, الجهة المنظِّمة | المنظمة |
| Code | الرمز | كود, أكواد |
| NFC tag | بطاقة NFC | علامة NFC |
| Cheat or abuse case | الحالة | علامة |
| Paired device | مرتبط، ربط | مقترن |
| Pickup | الاستلام | |
| Skip | تخطي | تجاوز (when it means skip) |
| Phone | الجوال (a number: رقم الجوال) | |
| Email | البريد الإلكتروني | إيميل |
| Dashboard account (a `staff_user`: any organizer or Questify admin account) | حساب لوحة التحكم / Dashboard account | موظف, Staff (reads as a Questify employee) |
| Platform admin role (`staff.platform_role`) | دور مشرف المنصة | |

## Left for a human decision

1. **Official contest rules (`rules.*`, Q-131, counsel).** `rules.claimLater` and `rules.claimBy` say «من منصة الجوائز»; the
   English says "prize desk". Change to «من مكتب الجوائز» when counsel's wording lands. Not touched.
2. **Locked consent texts.** `optOut.done` «تم الإيقاف.» and `marketing.saved` «تم الحفظ.» open with «تم». Not touched
   (T-807); suggested «أُوقف.» and «حُفظ.». `consent_text_outdated` in `http-errors.ts` says «ثم أعد المحاولة» for the same reason.
3. **ADR-125, SMS part.** `SMS_BRAND.ar` («كويستفاي»), the five SMS literals (`players/sign-in.ts`, `contact.ts` twice,
   `reauth.ts`, `deletion/deletion.ts`), the seeded templates in migration 0127 and the validator text
   `console.messages.issue.brandMissing` still use the Arabic name. Moving them needs a new migration and the brand check to
   accept "Questify"; not a string edit.
4. **«حقل» for a form field** (about 30 uses; the skill prefers «خانة») and **«الافتراضي» for default** (7 uses; the skill
   prefers «تلقائي»). Both are the project's settled usage and unambiguous here; left.
5. **«المشاركة / المشاركات»** means both share and submission (`submissions.*`, `operators.ability.review`,
   `quests.type.share`). «الإجابات» would separate them.
6. **«المشارك» for a player** in `operator.desk.sellNeedsQr`, `community.measure.players`, `community.unlock.players`,
   `souvenir.eligibility`. The app guard (FR-941) forbids a literal «لاعب» and the English has no `{playerOne}`; needs a placeholder
   in both languages.
7. **Numbers that need a plural form, not a label** (a code change, not a string edit): `console.push.confirm.body`
   («نحو {count} لاعب»), `quests.points.clamped`, `announcements.page.limits`, `guests.tooMany`, `rewards.left`, `flags.kind.burst`.
8. **Plural "you"** in the ticket center (`tickets.escalate.note` «جرّبتم», `tickets.escalatedNote` «ملاحظتكم») and
   `quests.poll.helper`, `quests.poll.resultsInfo` («صوّتوا») against the masculine singular everywhere else.
9. «يستغرق» (`location.timeout`, `changeSetBusy`, `results.settleBody`) and «عندما تكون الفعالية مباشرة» (three `event_not_live`
   errors): correct modern Arabic, the skill's lighter forms are a taste call.

10. **Three words for "flags".** «حالات» (the flag screens, `console.switches.number.flagBurstCount`), «بلاغات» (`results.flags`,
   `results.reviewFlags`) and «إشارات» (`console.player.flags`,
   `console.player.noFlags`) all render the English "flags". They should converge on one word; which one (the glossary says
   «حالة») is a person's call, so the two other families are left as they are.

## What was checked

All 5,144 message keys, the 407 error texts, the email and alert templates and the `ar.json` permission texts passed
mechanical scans: Eastern digits, empty or English-only Arabic, numbers and placeholders against the English, «تم», «قم بـ»,
«الخاص بك», «من أجل», «يرجى», «هناك», «بشكل», Latin punctuation, tanween, hamza, ta marbuta, term variants. The sweep read the
longer texts of all non-locked keys and every error text; the short labels were scanned only. 56 locked keys (legal, consent,
privacy, guidelines, deletion, opt-out, marketing, staff acceptance) were not edited.
