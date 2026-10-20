---
document: organizer-dpa
version: 0.1-draft
status: draft, not reviewed by counsel (T-807)
date: 2026-10-20
languages: Arabic (primary), English
placeholders: "{{LEGAL_ENTITY_NAME}}, {{CR_NUMBER}}, {{REGISTERED_ADDRESS}}, {{PRIVACY_CONTACT}}, {{EMAIL_PROVIDER}}, {{ERROR_TRACKING_PROVIDER}}, {{SUBPROCESSOR_NOTICE_DAYS}}, {{BREACH_NOTICE_HOURS}}, {{RETENTION_ORGANIZER_DATA}}, {{AUDIT_TERMS}}"
roles_basis: "Questify as controller of player accounts: legal/privacy-policy.md §1 and §4, ADR-047 (one player database across events). Organizer decides the event data it receives: PD-17, F-78, FR-121, FR-1206, FR-1207. Not settled: Q-043, Q-078."
---

# اتفاقية معالجة البيانات | Data Processing Agreement

<div dir="rtl" lang="ar">

## اتفاقية معالجة البيانات للمنظمين في Questify

الإصدار 0.1 (مسودة)، 2026-10-20

### 1. الأطراف والغرض

هذه الاتفاقية بين {{LEGAL_ENTITY_NAME}}، سجل تجاري رقم {{CR_NUMBER}}، وعنوانه {{REGISTERED_ADDRESS}} ("نحن")، وبين المنظم صاحب الحساب ("أنت")، وهي جزء من شروط المنظمين. تبيّن كيف نعالج البيانات الشخصية في فعالياتك وفق نظام حماية البيانات الشخصية في المملكة العربية السعودية ولوائحه.

### 2. من يقرر ماذا

**بيانات تقررها أنت ونعالجها نيابة عنك:**
- إجابات حقول الانضمام التي تختارها (مثل الاسم الكامل أو جهة العمل)؛
- نشاط اللاعبين في فعاليتك كما يظهر في لوحة التحكم: المهام، والنقاط، والحجوزات، وتسليم الجوائز، والمشاركات، وإجابات الاستبيانات، والتذاكر؛
- الملفات التي تصدّرها.

في هذه البيانات أنت جهة التحكم ونحن جهة المعالجة. حين تصدّر ملفًا وتنقله خارج المنصة، تصبح مسؤولًا وحدك عن تلك النسخة.

**بيانات نقررها نحن:** حساب اللاعب (الجوال أو البريد، واسم المستخدم، وسنة الميلاد)، وملفه في Questify وسجل الفعاليات التي حضرها، والخبرة والإنجازات، وموافقاته على الرسائل الترويجية، وسجلات الأمان، وحسابات فريقك. نعالجها جهةَ تحكم وفق سياسة الخصوصية، لا وفق هذه الاتفاقية.

### 3. تعليماتك

- نعالج بيانات فعاليتك لتشغيلها فقط، وفق ما تضبطه في لوحة التحكم (حقول الانضمام، والمهام، والتصدير)، أو حين يُلزمنا نظام، ونخبرك بذلك ما لم يمنعنا النظام.
- لا نبيع بيانات فعاليتك، ولا نعطيها لمنظم آخر أو لرعاتك.
- ندعو اللاعبين إلى فعاليات أخرى بموافقتهم فقط، ولا نكشف لك هوياتهم.

### 4. التزاماتك جهةَ تحكم

- اطلب في حقول الانضمام ما تحتاجه فقط، ولغرض مشروع. تعرض بطاقة الانضمام للاعب ما ستتلقاه قبل أن ينضم، ولا يحمل التصدير حقلًا لم تعرضه البطاقة.
- استخدم البيانات لفعاليتك ووفق الأنظمة، واحفظ ما تصدّره بأمان.
- لا تشارك بيانات اللاعبين مع رعاتك أو غيرهم دون أساس نظامي.
- أجب عن طلبات أصحاب البيانات في ما تتحكم فيه، وسنساعدك (البند 9).

### 5. السرية والوصول

يصل إلى بيانات فعاليتك فريقك وفريق Questify عند الحاجة للدعم أو الأمان فقط. يُسجَّل كل دخول من فريق الدعم وكل تعديل، ويظهر لك. يلتزم كل من يصل إلى البيانات بالسرية.

### 6. موقع البيانات

نحفظ البيانات الشخصية ونعالجها داخل المملكة العربية السعودية. تخرج بيانات محدودة إلى خارجها في الحالات المذكورة في البند 7 فقط، وتشملها الضمانات التي تطلبها الأنظمة لنقل البيانات خارج المملكة.

### 7. المعالجون الفرعيون

| المعالج | ماذا يفعل | الموقع | ما يصله من بيانات الفعالية |
|---|---|---|---|
| CranL | الاستضافة وقواعد البيانات والتخزين | الرياض | كل بيانات الفعالية |
| Msegat | الرسائل النصية | داخل المملكة | رقم الجوال ونص الرسالة |
| {{EMAIL_PROVIDER}} | البريد الإلكتروني | يُحدَّد لاحقًا | عنوان البريد ونص الرسالة |
| Apple وGoogle (الإشعارات) | إشعارات الجوال | خارج المملكة | رمز الجهاز ونص الإشعار |
| Apple Wallet وGoogle Wallet | بطاقة الفعالية في المحفظة | خارج المملكة | اسم الفعالية وشعارها، واسم المستخدم، والنقاط، والترتيب |
| Apple App Attest وGoogle Play Integrity | فحص سلامة الجهاز | خارج المملكة | نتيجة فحص الجهاز |
| {{ERROR_TRACKING_PROVIDER}} | رصد الأخطاء | يُحدَّد لاحقًا | لا بيانات شخصية |

نُلزم كل معالج فرعي بحماية لا تقل عن هذه الاتفاقية. نخبرك قبل إضافة معالج فرعي أو استبداله بـ{{SUBPROCESSOR_NOTICE_DAYS}}، ولك أن تعترض.

### 8. الأمان

- نشفّر البيانات أثناء نقلها وأثناء حفظها، ونشفّر رموز الجوائز التي ترفعها تشفيرًا إضافيًا.
- نعزل بيانات كل منظم في الخادم وفي قاعدة البيانات، ونختبر العزل بطلبات لا تحمل إلا المفتاح العام للتطبيق.
- يدخل فريقك وفريقنا بكلمة مرور ورمز يصل إلى البريد، وتنتهي الجلسات بعد مدة خمول.
- سجل النقاط وسجلات التدقيق تُضاف إليها القيود ولا تُعدّل ولا تُحذف.
- لا نضع بيانات شخصية في سجلات الخادم، ولا نستخدم شبكات إعلانية أو أدوات تتبّع.
- نحتفظ بنسخ احتياطية مشفّرة داخل المملكة.

### 9. مساعدتك في حقوق أصحاب البيانات

يمكن للاعب تنزيل نسخة من بياناته وحذف حسابه من التطبيق. حذف الحساب يحذف بياناته في فعاليتك أيضًا، إلا ما يُبقيه النظام كما تبيّن سياسة الخصوصية. إذا وصلك طلب لا تستطيع تلبيته من لوحة التحكم، فراسل {{PRIVACY_CONTACT}} وسنساعدك.

### 10. التسرّب

إذا علمنا بتسرّب يمس بيانات فعاليتك، نخبرك دون تأخير، وخلال {{BREACH_NOTICE_HOURS}} ساعة على الأكثر من علمنا به، بما نعرفه وما فعلناه. ونساعدك في إبلاغ الهيئة السعودية للبيانات والذكاء الاصطناعي (سدايا) وأصحاب البيانات حين يلزم.

### 11. انتهاء الاتفاقية

- صدّر بيانات فعالياتك قبل حذف الحساب.
- بعد الانتهاء نحذف بيانات فعالياتك، أو نفصلها عن أصحابها، خلال {{RETENTION_ORGANIZER_DATA}}، ومعها النسخ الاحتياطية عند دورتها.
- يبقى سجل النقاط وسجلات التدقيق مع إزالة ما يدل على اللاعبين، وتبقى سجلات تسليم الجوائز المدة التي يطلبها النظام فقط.

### 12. التدقيق

{{AUDIT_TERMS}}

### 13. التغيير والتواصل

إذا غيّرنا هذه الاتفاقية نصدر إصدارًا جديدًا، ويوافق عليه المالك عند دخوله التالي قبل أن يتابع. للخصوصية: {{PRIVACY_CONTACT}}.

</div>

---

## Questify Data Processing Agreement for Organizers

Version 0.1 (draft), 2026-10-20

### 1. Parties and purpose

This agreement is between {{LEGAL_ENTITY_NAME}}, commercial registration {{CR_NUMBER}},
{{REGISTERED_ADDRESS}} ("we"), and the organizer that holds the account ("you"), and forms part of
the Organizer Terms. It sets out how we process personal data in your events under the Saudi
Personal Data Protection Law (PDPL) and its regulations.

### 2. Who decides what

**Data you decide on and we process for you:**
- answers to the join fields you choose (such as full name or employer);
- players' activity in your event as the dashboard shows it: quests, points, reservations, prize
  handovers, submissions, survey answers and tickets;
- the files you export.

For this data you are the controller and we are the processor. Once you export a file and take it
off the platform, you alone are responsible for that copy.

**Data we decide on:** the player's account (phone or email, username, birth year), their Questify
profile and history of events attended, XP and achievements, promotional-message consents, safety
records, and your team's accounts. We process these as controller under our Privacy Policy, not
under this agreement.

### 3. Your instructions

- We process your event's data only to run it, as you configure in the dashboard (join fields,
  quests, exports), or where a law requires it, and we tell you so unless the law prevents it.
- We do not sell your event's data or give it to another organizer or to your sponsors.
- We invite players to other events only with their consent, and we never reveal their identities
  to you.

### 4. Your duties as controller

- Ask in join fields only for what you need, for a legitimate purpose. The join card shows the player
  what you will receive before they join, and exports never carry a field the card did not show.
- Use the data for your event and within the law, and keep what you export secure.
- Do not share players' data with your sponsors or anyone else without a legal basis.
- Answer data-subject requests for what you control; we help you (section 9).

### 5. Confidentiality and access

Your team, and the Questify team only when needed for support or safety, can reach your event's
data. Every support access and change is logged and shown to you. Everyone with access is bound to
confidentiality.

### 6. Where the data stays

We store and process personal data inside the Kingdom of Saudi Arabia. Limited data leaves the
Kingdom only in the cases listed in section 7, covered by the safeguards the law requires for
transfers abroad.

### 7. Sub-processors

| Sub-processor | What it does | Location | Event data it receives |
|---|---|---|---|
| CranL | Hosting, databases and storage | Riyadh | All event data |
| Msegat | Text messages | Inside the Kingdom | Phone number and message text |
| {{EMAIL_PROVIDER}} | Email | To be confirmed | Email address and message text |
| Apple and Google (push) | Phone notifications | Outside the Kingdom | Device token and notification text |
| Apple Wallet and Google Wallet | The event pass in the wallet | Outside the Kingdom | Event name and logo, username, points and rank |
| Apple App Attest and Google Play Integrity | Device-integrity check | Outside the Kingdom | The device check result |
| {{ERROR_TRACKING_PROVIDER}} | Error monitoring | To be confirmed | No personal data |

We bind every sub-processor to protection no weaker than this agreement. We tell you
{{SUBPROCESSOR_NOTICE_DAYS}} before adding or replacing one, and you may object.

### 8. Security

- We encrypt data in transit and at rest, and add a further layer of encryption to the prize codes
  you upload.
- We isolate each organizer's data on the server and in the database, and test that isolation with
  requests that hold only the app's public key.
- Your team and ours sign in with a password and a code sent by email; sessions end after a period
  of inactivity.
- The points record and audit logs only take new entries; nothing in them is edited or erased.
- We keep no personal data in server logs, and use no ad networks or tracking tools.
- We keep encrypted backups inside the Kingdom.

### 9. Helping you with data-subject rights

A player can download a copy of their data and delete their account in the app. Deleting the
account also deletes their data in your event, except what the law requires us to keep, as the
Privacy Policy explains. If you receive a request you cannot meet from the dashboard, write to
{{PRIVACY_CONTACT}} and we will help.

### 10. Breaches

If we learn of a breach affecting your event's data, we tell you without delay, and at most
{{BREACH_NOTICE_HOURS}} hours after we learn of it, with what we know and what we have done. We help
you notify the Saudi Data and AI Authority (SDAIA) and the people affected where needed.

### 11. End of the agreement

- Export your events' data before deleting the account.
- After the end we delete your events' data, or unlink it from the people it concerns, within
  {{RETENTION_ORGANIZER_DATA}}, and from backups as they cycle.
- The points record and audit logs stay with anything identifying players removed; prize-handover
  records stay only as long as the law requires.

### 12. Audits

{{AUDIT_TERMS}}

### 13. Changes and contact

If we change this agreement we publish a new version, and the owner accepts it at their next
sign-in before continuing. Privacy: {{PRIVACY_CONTACT}}.
