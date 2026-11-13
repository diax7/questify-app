# Screenshots shot list and listing texts

Prepared 2026-11-13. **No screenshot was taken.** Capture needs a real build on a device (EAS build, Dhia's step). The
store size and count rules below are from memory of the two consoles **[form: confirm in App Store Connect and Play
Console when the accounts exist]**; the content rules are from STORE_COMPLIANCE 1.4 (Apple 2.3.3, 2.3.8 to 2.3.10) and 2.10.

## 1. Rules the shots must follow

- Show the app in use, not the splash, the login or the intro only (Apple 2.3.3).
- **Fictional** organizer brand, fictional players and prizes; no real client's logo without written permission (Apple
  2.3.9; Organizer Terms section 4). The demo event's players and prizes are already fictional (ADR-560).
- No Android device frames, Play badges or status-bar icons on the iOS set; no iOS imagery on the Play set (Apple 2.3.10).
- Suitable for ages 4+ imagery (Apple 2.3.8); nothing that reads as a kids' app (Play 2.10): show real event flows.
- No personal data: the reviewer account's number and code never appear. Status bar clean (iOS 9:41 with full battery and
  signal; Android system UI demo mode).
- **Western digits in the Arabic set** (ADR-018) and the Arabic layout truly right to left (back chevrons, tab order,
  the ranking's rank column). `userInterfaceStyle` is `light`: capture light only.
- The screenshot folder stays out of git except the few proof images `docs/evidence/` allows (WORKER_BRIEF: about 10,
  each under 300 KB).
- Decision for Dhia before capture: which event is photographed. Recommended: the review demo event (fictional by
  construction) once its display name reads well on a store page; if the name "App Review Demo" shows and is unwanted,
  use a throwaway fictional organizer on a staging environment instead of renaming the demo event.

## 2. Sizes and counts

| Store | Device class | Size (portrait) | Count | Notes |
|---|---|---|---|---|
| App Store | iPhone 6.9" (iPhone 16/17 Pro Max class) | 1320 x 2868 (1290 x 2796 or 1260 x 2736 also accepted) | 1 to 10; use 8 | The only mandatory iPhone size today; smaller iPhone sizes are scaled from it |
| App Store | iPhone 6.5" | 1284 x 2778 or 1242 x 2688 | optional | Only if the form still asks for it |
| App Store | iPad | none | none | `supportsTablet: false`, so no iPad set is requested |
| App Store | Optional app preview video | none in this pack | | Skip for v1 |
| Google Play | Phone | 1080 x 2400 (9:20) is fine; any ratio 16:9 to 9:16, 320 to 3840 px on a side, PNG or JPEG without alpha | 2 to 8; use 8 | |
| Google Play | 7-inch and 10-inch tablet | not required | | The app is portrait and phone-first (`orientation: portrait`) |
| Google Play | Feature graphic | 1024 x 500 | 1 | Adventure-game style from the brand deck, no phone frame, no tiny text |
| Google Play | App icon | 512 x 512 | 1 | From `apps/app/assets/brand/icon.png` |

Each language gets its own full set: **Arabic (ar) and English (en)** for both stores, 8 shots each, 32 captures in all
(16 for iOS, 16 for Android), same order and the same event data so the two languages are comparable.

## 3. The eight shots (same screens, both languages)

Order tells the story: join, play, scan, see the result, climb, redeem, grow, play.

| # | Screen to capture | State to prepare | Caption (en) | Caption (ar) | Why it is in the set |
|---|---|---|---|---|---|
| 1 | Questify Home with "My events" and the event code field | Signed in as a fictional player with the demo event joined; the field shows the demo join code | "Got an event code? Join in seconds" | «هل وصلك رمز فعالية؟ انضم في ثوانٍ» | Explains the model: one app, many organizers (ADR-006) |
| 2 | The event's Quests tab | A mix of quest types; two done, points total visible | "Finish quests around the event" | «أنجز المهام في أرجاء الفعالية» | Quest variety (Apple 2.3.1: describe the real product) |
| 3 | Scan tab with the scanner open | Camera pointed at a printed sample QR (a device photo, not a stock image) | "Scan a QR code to earn points" | «امسح رمز QR واكسب النقاط» | Core action; camera use is obvious |
| 4 | A quest result sheet with the points won | After a scan: points added and the ranking move | "See your points at once" | «شاهد نقاطك فورًا» | Reward loop |
| 5 | Ranking tab | Fictional players, the reviewer-style test account in the top five, usernames only | "Climb the live ranking" | «تصدّر الترتيب المباشر» | Contest element, matches the Contests answer |
| 6 | Rewards tab | Several fictional prizes with prices in the event's points | "Redeem points for real prizes" | «استبدل نقاطك بجوائز حقيقية» | Rewards; no price in money, nothing for sale |
| 7 | Profile with level, streak card and My locker | Level 3 with items; streak card visible | "Grow your level across events" | «ارتقِ بمستواك من فعالية إلى أخرى» | Questify-wide progression |
| 8 | A mini-game (memory match) mid-play, or the photo wall if storage is live (G6) | Memory match, cards half-flipped | "Play quick mini-games" | «العب ألعابًا مصغّرة سريعة» | Variety; native game (not a WebView) |

Avoid: the sign-in screen, the intro cards alone, any screen with a real phone number, the review-only "Pick a code"
sheet, push permission sheets, and error states.

**Locale pass for the Arabic set:** the same screens with the app language set to Arabic (Profile > language). Check the
captions in the image with a native reader and with the `ux-araby` rules (masculine imperative, no «تم», brand in Latin
letters). Captions are baked into the image if the shots are framed; if plain screenshots are used, drop the caption
column and keep only the screens.

## 4. Listing texts

Brand in Latin letters in both languages (ADR-125). Terms follow `docs/design/ARABIC_GLOSSARY.md`. Western digits. Nothing
below promises a feature that is not in the build (wallet passes and device attestation are left out on purpose, G8).
Character counts were measured; Apple's limits (name and subtitle 30, promotional text 170, keywords 100, description
4,000) and Google's (title 30, short description 80, full description 4,000) are from memory **[form]**.

### Name and subtitle

| Field | English | Arabic |
|---|---|---|
| App name (both stores) | `Questify: Event Quests` (22) | `Questify: مهام الفعاليات` (24) |
| Apple subtitle | `Quests, points and prizes` (25) | `مهام ونقاط وجوائز في الفعاليات` (30) |
| Google short description (80) | `Join an event, finish quests, climb the ranking and win prizes.` (63) | `انضم إلى فعالية، وأنجز المهام، وتصدّر الترتيب، واربح الجوائز.` (61) |

ADR-131: the unique listing name is reserved when the Apple account exists; "Questify: Event Quests" is the example it
gives. The in-app name stays `Questify` (`app.json`); the icon never changes per organizer (PD-30).

### Apple promotional text (170, editable without a release)

- en: `Got an event code? Join, finish quests, earn points and watch the live ranking. Redeem points for the organizer's prizes. Free, in Arabic and English.` (150)
- ar: `هل وصلك رمز فعالية؟ انضم، وأنجز المهام، واجمع النقاط، وتابع الترتيب المباشر. ثم استبدل نقاطك بجوائز المنظّم. مجاني، بالعربية والإنجليزية.` (139)

### Apple keywords (100, comma-separated, no spaces, no trademarks, no prices)

- en: `event,quest,qr,scan,leaderboard,points,prizes,conference,expo,festival,game,rewards,nfc,ranking` (95)
- ar: `فعالية,مهام,نقاط,جوائز,ترتيب,مؤتمر,معرض,مهرجان,مسح,لعبة,مكافآت,رمز` (66)

### Description (App Store description and Play full description)

English:

```
Questify turns events into games.

Your organizer gives you a code or a link. Join the event, finish quests, earn points and see where you stand on a live ranking. Then redeem your points for the prizes the organizer offers.

WHAT YOU CAN DO
• Scan QR codes and tap NFC tags around the venue
• Answer quizzes and surveys, vote in live polls, send a photo or a short answer
• Play quick mini-games
• Meet other players and check in at quest spots
• Follow the event's announcements and agenda
• Earn levels, achievements and items that stay with you from event to event
• Redeem points for the organizer's prizes

MADE FOR YOU
• Arabic and English, with full right-to-left support
• You choose a username. The organizer never sees your phone number or email
• Location, notifications and NFC are optional, and a QR code always works
• Delete your account any time from the app

Questify is free. Points are earned by playing and cannot be bought. Prizes are provided and handed over by each event's organizer. Apple and Google are not sponsors of any contest in the app.
```

Arabic:

```
يحوّل Questify الفعاليات إلى لعبة.

يعطيك المنظّم رمزًا أو رابطًا. انضم إلى الفعالية، وأنجز المهام، واجمع النقاط، وتابع ترتيبك المباشر. ثم استبدل نقاطك بجوائز يقدّمها المنظّم.

ماذا تفعل في Questify
• امسح رموز QR والمس بطاقات NFC في أرجاء المكان
• أجب عن الاختبارات والاستبيانات، وصوّت في الاستطلاعات المباشرة، وأرسل صورة أو إجابة قصيرة
• العب ألعابًا مصغّرة سريعة
• تعرّف إلى لاعبين آخرين وسجّل حضورك في أماكن المهام
• تابع إعلانات الفعالية وجدولها
• اكسب مستويات وإنجازات وعناصر تبقى معك من فعالية إلى أخرى
• استبدل نقاطك بجوائز المنظّم

صُمّم لك
• بالعربية والإنجليزية، مع دعم كامل للكتابة من اليمين إلى اليسار
• اختر اسم مستخدم. لا يرى المنظّم رقم جوالك ولا بريدك
• الموقع والإشعارات وNFC اختيارية، ورمز QR يعمل دائمًا
• احذف حسابك متى شئت من التطبيق

Questify مجاني. تكسب النقاط باللعب ولا يمكن شراؤها. يقدّم منظّم كل فعالية جوائزه ويسلّمها بنفسه. Apple وGoogle ليستا راعيتين لأي مسابقة في التطبيق.
```

Claims traced: join by code or link (`home.codeLabel`); quest types (registry); live polls (`vote` with live, T-306);
mini-games (T-305); meet and check-in quests (T-303b, T-303c); announcements and agenda (`announcements.tsx`,
`agenda.tsx`); levels, achievements, items (T-403, ADR-760); the organizer sees neither phone nor email (privacy policy
section 4); deletion in app (T-217); no purchase (ADR-002). If photos are still off at launch (G6), keep "send a photo".
It is in the binary and described in the notes; drop it only if the quest cannot be created at all.

### What's New (first version)

- en: `First release. Join an event with its code, finish quests, climb the ranking and redeem prizes.`
- ar: `الإصدار الأول. انضم إلى فعالية برمزها، وأنجز المهام، وارتقِ في الترتيب، واستبدل الجوائز.`

### URLs and contact fields

| Field | Value |
|---|---|
| Support URL | `{{WEB_ORIGIN}}/en/contact` (and `/ar/contact`); the page must carry real details first (G8) |
| Marketing URL (optional) | `{{WEB_ORIGIN}}/en` |
| Privacy policy URL | `{{WEB_ORIGIN}}/en/legal/privacy_policy` |
| Terms of use | Apple's Standard EULA applies (STORE_COMPLIANCE section 4); link the Terms of use page in the description if wanted |
| Copyright line (Apple) | the seller's legal name and year, filled when the account exists (ADR-010: Dhia's name) |
| Category | Not Games (PD-15); see the two privacy files |
