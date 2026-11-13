# Google Play Console: App access (sign-in details), review notes, permissions

Prepared 2026-11-13. Where: Play Console, the app, Policy and programs, App content, **App access** (up to five sets of
instructions); the same console page also takes the listing contact and the release notes. Placeholders as in
`app-store-review-notes.md` section 0: the **same** reviewer number, the **same** six-digit code (the console shows it
once; paste it into both stores in one go), the same join code and window. Google reviews are often slower than
Apple's, so open the window for 30 days.

## 1. App access: "All or some functionality is restricted"

Instruction set 1 (name: `Reviewer, full access`). Fields Play asks for: username, password, any other instructions.

| Field | Value |
|---|---|
| Username or phone | `{{REVIEWER_PHONE}}` |
| Password | `{{REVIEWER_CODE}}` (six digits; the app asks for it as "Code") |
| Any other instructions (paste) | the block below |

```
Questify signs in with a mobile number and a one-time code (or email and a code); there is no third-party sign-in.
1. Open the app, tap Skip on the intro, tap Sign in, accept the terms and privacy policy.
2. Type the number above and tap "Send the code". No SMS is sent to it while this review window is open.
3. Type the 6-digit password above as the code and tap Confirm. The account already exists (no profile step).
This code works for this one number and the demo event only, until {{WINDOW_END}}.
4. Home > "Event code or link": type {{JOIN_CODE}} > Open > Join. "App Review Demo" is a live event of a fictional organizer with every quest type and event feature in this build, fictional players and prizes. Nothing is sold; there are no ads from an ad network and no tracking.
5. No camera? Scan tab > "Pick a code (review only)", then pick a listed code: it works as a scan, so no printed code is needed.
6. Delete account: Profile > Delete account > send the confirmation code (the same code works) > confirm. Web page: {{WEB_ORIGIN}}/en/delete-account.
Permissions are optional and never needed to earn or redeem anything: camera, location while the app is open (a QR is always an alternative), notifications, NFC. The app holds no SMS, storage, photo-library, microphone or background-location permission.
Contact: {{CONTACT_EMAIL}}.
```

(About 1,500 characters; Play's field limit is a few hundred to a few thousand characters per box **[form]**; cut step 5
and the permissions sentence if the box is short, then point to the privacy policy and the Data safety section.)

**Instruction set 2 (only if Play asks for staff mode, STORE_COMPLIANCE 2.11 "up to five instruction sets"):** the same
account is an operator of the demo event: Questify Home > the staff block for "App Review Demo" > pair a device and
rotating QR screens. No second credential exists, and none is needed.

## 2. Notes that match the declarations

| Play question | Answer | Where it is shown |
|---|---|---|
| Why camera? | Scan the QR codes at an event and take quest photos the player chooses to send. Decoding happens on the phone. Asked when the scanner opens | Permission text above; Data safety "Photos" |
| Why location? | Optional check-in quests and a fair-play check, only while the app is open, fine accuracy because a quest spot can be 20 m wide; a QR is always an alternative; nothing is stored as a coordinate | Data safety "Precise location" |
| Why notifications? | Event announcements, rank changes and reward reminders; asked after the player joins an event; declining changes nothing else | Data safety "Device or other IDs" |
| Why NFC? | Optional tap-to-check-in at stickers; reading starts when the player taps in the app; every NFC quest has a QR | |
| Background use | None | `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION` blocked in `app.json` |
| User-generated content | Yes, moderated: terms before first submission, Report and Block in the app, pre-approved photos, organizer and Questify queues | `play-content-rating.md` section 4 |
| Remote code | Only EAS Update JavaScript (Google's interpreter exception, STORE_COMPLIANCE 2.12); native code and permissions change only through a store release | STORE_COMPLIANCE 2.12 |
| Real-money gambling and contests | None; free participation, fixed-price points store and rank prizes, official rules in the app | STORE_COMPLIANCE 2.9 |
| Child safety | Not for children; 13 and over; no under-13 sign-up | ADR-028 |

## 3. Account deletion fields

- Data safety: URL `{{WEB_ORIGIN}}/en/delete-account`; the page names "Questify" and the developer exactly as the listing
  does, shows the deletion path first, and works without the app (Google 13327111).
- Policy section 8 and the page must say the same about what is kept: points-record rows with the player removed,
  frozen results under an anonymous label, prize-handover records for the period the law requires
  (`{{RETENTION_PRIZE_RECORDS}}`), and a one-way fingerprint (`{{RETENTION_FINGERPRINT}}`). Placeholders wait on
  counsel (G8).

## 4. Closed testing and release track (personal account)

If the Play account is Dhia's personal one (ADR-010): a **closed test with at least 12 testers opted in for 14
continuous days** before production access (STORE_COMPLIANCE 2.2). The testers can use the same reviewer window only
if it is open; real testers should use their own phones and real SMS. Use the closed-test period as the dress rehearsal
for the push checklist on Android (the Firebase file is a hard gate, G4) and for the merged-manifest check.

## 5. Android specifics to attach to the release

| Item | Value |
|---|---|
| Package | `app.questify.mobile` |
| Format | Android App Bundle from an EAS `production` profile (G3: it does not exist yet) |
| Target SDK | 36 (Expo SDK 57 / React Native 0.86.3), 16 KB page sizes met per EXPO_SDK_CHECK; confirm in the App bundle explorer |
| Languages | Arabic and English (`supportedLocales ar, en`) |
| Release notes (en-US) | "First release. Join an event with its code, finish quests, climb the ranking and redeem prizes." |
| Release notes (ar) | «الإصدار الأول. انضم إلى فعالية برمزها، وأنجز المهام، وارتقِ في الترتيب، واستبدل الجوائز.» |
| Firebase file | `google-services.json` wired through `android.googleServicesFile` (RUNBOOK; not set today) |
| Notification icon | 96 px all-white PNG on transparent (not set today) |
