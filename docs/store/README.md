# Store submission pack (T-806, prepared 2026-11-13)

Ready-to-paste answers for every store form that does not need Dhia's store accounts. Written from the code and docs as
they stand on 2026-11-13 (`apps/app/app.json`, `apps/app/package.json`, `apps/app/eas.json`, `docs/STORE_COMPLIANCE.md`,
`docs/legal/privacy-policy.md`, `docs/DATA_MODEL.md`, ADR-007, ADR-072, ADR-073, ADR-560 to ADR-569, ADR-640). **The T-806
box stays unticked:** it needs the real submission, the push go-live checklist (RUNBOOK) and the Android Firebase file.

| File | Form it fills |
|---|---|
| `app-store-privacy-labels.md` | App Store Connect, App Privacy ("nutrition labels"), and the `NSPrivacyCollectedDataTypes` list for the privacy manifest |
| `app-store-age-rating.md` | App Store Connect, age rating questionnaire |
| `app-store-review-notes.md` | App Review Information: sign-in, Notes for Review, the review demo event, sample QR codes |
| `play-data-safety.md` | Play Console, Data safety |
| `play-content-rating.md` | Play Console, IARC content rating questionnaire, target audience, other App content declarations |
| `play-review-notes.md` | Play Console, App access (sign-in details), permissions, account deletion link, release notes for the reviewer |
| `screenshots-and-listing.md` | Screenshot shot list (screens, languages, sizes), listing texts in Arabic and English |

Marks: **[code]** read in the code or config in this repo; **[doc]** stated by a repo doc; **[form]** the store form's
wording or option list, taken from the store page read on 2026-11-13 or from memory and **to be confirmed on the live
form** when the account exists. Nothing here was entered into a store.

## Facts the forms rest on

### Account and sign-in [code]

- Own account system only: Saudi mobile number (+966) with an SMS code, or email with a code (ADR-030). No Google,
  Apple, Facebook or any other third-party sign-in exists in `apps/app` (no such package in `package.json`, no such call
  in `src`). **Sign in with Apple is therefore not required** (Apple 4.8; STORE_COMPLIANCE 1.9).
- Sign-up asks for: terms and privacy acceptance (versions recorded), username, avatar (one of six fixed pictures), birth
  year. Under 13 cannot sign up (ADR-028). No real name is asked by Questify.
- **Account deletion is in the app:** Profile, "Delete account" (`apps/app/app/delete-account.tsx`, reached from
  `ProfileScreen.tsx`), confirmed with a code sent to the phone or email; held prizes are forfeited on request. A web page
  does the same without the app: `/{ar|en}/delete-account` (`apps/web/src/app/[lang]/delete-account`). Both stores' deletion
  rules are met on paper (Apple 5.1.1(v), Google User Data).
- "Download my data" is in Profile (`data-export.tsx`).

### Native modules and what each does to the forms [code: `apps/app/package.json`, `app.json`]

| Package | Privacy-form effect |
|---|---|
| `expo-camera` | Camera for QR scanning and photo quests. Decoding is on the phone; no frame is sent. Permission text below |
| `expo-image-picker` | System photo picker (`photosPermission: false`): no photo-library permission on either platform |
| `expo-location` | Foreground only, while the app is open (ADR-072). Permission text below. Background location blocked in `app.json` |
| `react-native-nfc-manager` | Reads an NFC sticker the player taps in the app. `NFCReaderUsageDescription`, NDEF entitlement. The chip id is the sticker's, not the player's |
| `expo-notifications` | Push through Apple (APNs) and Google (FCM). Token sent only after the player says yes |
| `expo-secure-store`, `@react-native-async-storage/async-storage` | Session tokens (keychain/keystore, this device only) and the random install id; nothing leaves except through the API |
| `expo-device`, `expo-application` | Phone model, OS and app version, read lazily and sent only inside a request the player writes (T-312) |
| `expo-updates` | EAS Update, JavaScript only, fixes and small changes (STORE_COMPLIANCE 1.5) |
| `react-native-view-shot`, `expo-sharing` | Recap image drawn on the phone and given to the system share sheet; nothing uploaded |
| `expo-haptics`, `expo-keep-awake`, `expo-linking`, `expo-localization`, `expo-font`, `expo-splash-screen`, `expo-status-bar`, `expo-constants`, `expo-file-system`, `expo-router`, `expo-dev-client`, `barcode-detector`, `uqr`, `react-native-*`, `@expo/*`, fonts | No data collection, no network of their own |

**None of the following exists in the app:** analytics SDK, crash reporter, advertising SDK, attribution SDK, tracking
domain, Firebase Analytics, Google Mobile Services other than FCM through `expo-notifications`, in-app purchase, payment
SDK, WebView, social SDK, AI service. Server error tracking is a self-hosted tool that takes ids only
(`docs/legal/README.md`, `{{ERROR_TRACKING_PROVIDER}}`; `DATA_MODEL.md` "Personal data catalog": the API log holds ids only).
That is why **Tracking is "No" on Apple** and **"Contains ads: see G5"** on Play.

### Permissions and purpose texts [code: `app.json`, `apps/app/locales/{en,ar}.json`]

| Key / permission | Text (English, as shipped) | Arabic (as shipped) |
|---|---|---|
| `NSCameraUsageDescription` (plugins `expo-camera`, `expo-image-picker`) | "Questify uses the camera to scan the QR codes at your event and to take photos you choose to send." | «يستخدم Questify الكاميرا لمسح رموز QR في فعاليتك ولالتقاط الصور التي تختار إرسالها.» |
| `NSLocationWhenInUseUsageDescription` | "Questify uses your location while the app is open to check you in at quest spots and to keep the game fair at your event. You can always scan the QR code instead." | «يستخدم Questify موقعك أثناء فتح التطبيق لتسجيل حضورك في أماكن المهام وللحفاظ على عدالة اللعب في فعاليتك. يمكنك دائمًا مسح رمز QR بدلًا من ذلك.» |
| `NFCReaderUsageDescription` | "Questify reads the NFC tags at your event when you tap one in the app. You can always scan the QR code instead." | «يقرأ Questify بطاقات NFC في فعاليتك حين تلمس إحداها من داخل التطبيق. يمكنك دائمًا مسح رمز QR بدلًا من ذلك.» |
| `NSPhotoLibraryAddUsageDescription` (`infoPlist`, English only in `app.json`; the locale files carry both) | "Questify saves your event recap image to Photos only when you choose Save Image." | «يحفظ Questify صورة ملخص فعاليتك في الصور فقط حين تختار حفظ الصورة.» |
| No microphone, no photo-library read, no contacts, no Bluetooth, no background location, no motion, no tracking (ATT) key | | |

Android (declared by the plugins; the merged manifest must be read on the first release build, G4): `CAMERA`,
`ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION` (`expo-location`, foreground; the app asks for a high-accuracy fix),
`POST_NOTIFICATIONS` (Android 13+), `NFC` (normal, feature not required), `INTERNET`, `VIBRATE`, plus the small ones the
libraries add (`RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, FCM's receive permission). Blocked in `app.json`:
`READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`, `RECORD_AUDIO`, `READ_MEDIA_IMAGES`,
`READ_MEDIA_VIDEO`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION`. No SMS permission (codes are typed).

### Other `app.json` findings the forms flag

| Item | Value | Verdict |
|---|---|---|
| `ITSAppUsesNonExemptEncryption` | `ios.config.usesNonExemptEncryption: false`, which Expo writes as `ITSAppUsesNonExemptEncryption = NO` | Correct on the evidence: the only crypto in `apps/app` is a random UUID (`src/api/uuid.ts`); everything else is the OS's HTTPS and keychain. No export-compliance document needed. Re-check if a package adds its own cipher |
| `ios.supportsTablet` | `false` | iPhone-only build; iPad runs it in compatibility mode. No iPad screenshots are asked for. STORE_COMPLIANCE 2.4.1 / checklist line "layout checked on iPad" still applies to the compatibility view |
| `ios.privacyManifests` | Required-reason API list only (UserDefaults CA92.1; file timestamp C617.1, 0A2A.1, 3B52.1; boot time 35F9.1; disk space E174.1, 85F4.1). **No `NSPrivacyCollectedDataTypes`, no `NSPrivacyTracking`** | Gap G2 |
| `userInterfaceStyle` | `light` | Screenshots in light only |
| Languages | `CFBundleLocalizations ar, en`; Android `supportedLocales ar, en` | The listing needs Arabic and English |
| `android.package`, `ios.bundleIdentifier` | `app.questify.mobile` on both | Fixed forever once uploaded |
| `name` | `Questify` | ADR-131: the App Store listing name must be unique, for example "Questify: Event Quests" (30 characters max) |
| Deep links | `scheme: questify` only; no `associatedDomains`, no Android intent filters | Join links on the web host open the browser, not the app; do not claim universal links in any note |
| Min iOS | 16.4 (Expo SDK 57, Q-082) | Above Apple's iOS 13 floor |

### Where the web pages live (for the URL fields)

Privacy policy `/{lang}/legal/privacy_policy`, terms `/{lang}/legal/terms_of_use`, community guidelines
`/{lang}/legal/community_guidelines`, support `/{lang}/contact`, deletion `/{lang}/delete-account`, an event's official
rules `/{lang}/e/{code}/rules` [code: `apps/web/src/app/[lang]`, `SubmissionEntry.tsx`, `reaccept.tsx`]. The origin is
written `{{WEB_ORIGIN}}` in the files: the one origin is `https://questify.nafes.com` (ADR-838, decided 2026-11-14; the join-link host in
`packages/shared/src/join/link.ts` and the EAS profiles now agree). Paste a URL only once that origin serves the page.

## The data inventory (one list for both stores)

Every row is a thing the player or the app sends to the Questify API. "Linked" = attached to the player's account.
Retention comes from the privacy policy draft v0.1 (placeholders `{{RETENTION_*}}` wait for counsel, Q-075) and
`DATA_MODEL.md`. Deletion = what `erase_player` does (DATA_MODEL "Account deletion").

| # | Data | Why (purpose) | Source in code or doc | Required? | Linked | Seen by | Retention | On account deletion |
|---|---|---|---|---|---|---|---|---|
| 1 | Mobile number (+966) | Sign-in, account protection, one-time codes by SMS, promotional SMS only if opted in | `player_contact.phone_e164`; `sign-in.tsx` | One of phone or email | Yes | Questify; SMS gateway (Msegat) sees it to deliver | Until deletion | Deleted; a keyed one-way fingerprint stays (ban and one-time-reward carry-over, `{{RETENTION_FINGERPRINT}}`) |
| 2 | Email address | Same, as the alternative | `player_contact.email` | One of phone or email | Yes | Questify; email provider (Google Gmail API today, ADR-112) | Until deletion | Deleted; fingerprint stays |
| 3 | Username, avatar | The player's public identity on rankings and profile | `player.username`, `avatar` | Yes | Yes | Other players in shared events; organizer team | Until deletion | Username cleared, avatar reset; ranking rows kept anonymously |
| 4 | Birth year | Age gate (13 minimum, ADR-028) | `player.birth_year` | Yes | Yes | Questify only | Until deletion | Set to NULL |
| 5 | City and interests | Suggest events, invite the player (optional) | `interests.tsx`, FR-733 | No | Yes | Questify only | Until deletion | Deleted |
| 6 | Join answers the organizer asks (full name, company, job title, department, ticket number, own fields) | Run the organizer's event; the join card shows them before joining (PD-17) | `JoinForm.tsx`, F-78 | Per organizer; the player may decline to join | Yes | That event's organizer and team only; full name to other players only if the organizer chose so and the join card said so | `{{RETENTION_EVENT_DATA}}` (Q-075, Q-115) | Deleted |
| 7 | Event activity: quests completed, points and XP, ranks, reservations, prize handovers, votes, quiz and survey answers, session sign-ups, ratings, streaks | The game itself; organizer analytics; Questify-wide levels | ledger, `quest_completion`, DATA_MODEL | Yes while playing | Yes | The event's organizer; ranking readers see username and score | Ledger is append-only and permanent | Rows kept on the tombstone with the player's identity removed; answers and votes deleted; ranks stay under an anonymous label |
| 8 | Submissions: text, photos (photo quests; photos need the storage bucket, G6) | Quest proof, review by the team, optional photo wall | `submission`, ADR-828, ADR-830 | Only in submission quests | Yes | Event team; other players only for photos the player allowed on the wall and the team picked | Photos 365 days after the event ends (interim, ADR-828); text `{{RETENTION_EVENT_DATA}}` | Deleted |
| 9 | Help requests and problem reports (text; model, OS, app version only when the player attaches them) | Support from the event team or Questify | `help.tsx`, T-310, T-312, ADR-248 | No | Yes | Event team (or Questify queue) | 90 days after the later of the event's end and sending (Q-210) | Deleted |
| 10 | Location reading (latitude, longitude, accuracy, age, mocked mark) | Check-in quests; fair-play flag "far from venue" | `src/event/location.ts`, ADR-072, ADR-206 to ADR-208 | No (a QR is always available) | Yes | Questify only | **No coordinate is stored** (DATA_MODEL "completion_position"): the reading is used in the request; accuracy, mocked mark and the distance to the venue rounded to 10 m stay with the completion | The kept rows are deleted |
| 11 | Install id (random UUID made at first launch) | Per-install limits, fraud signals, "several accounts on one phone" | `app-session.ts` `X-Device-Id`; DATA_MODEL says personal data | Yes | Yes | Questify only | While the install is in use | Cleared from completions; sessions deleted |
| 12 | Push token, platform, app language, app version | Deliver event and service notifications | `push_device`, T-501 | Only if the player turns push on | Yes | Questify; Apple and Google deliver the push | Until sign-out, 60 days unseen or deletion | Deleted |
| 13 | Consents: terms and privacy versions with time; marketing opt-in per channel with time | Proof of consent (PDPL) | `player_acceptance`, `marketing.*` | Terms: yes; marketing: no | Yes | Questify | Until deletion | Acceptances deleted (Q-095 asks counsel) |
| 14 | Safety records: flags, bans, blocks the player made, past usernames | Keep players safe | DATA_MODEL | n/a | Yes | Questify; the event team sees its event's flags | Until deletion / event data | Deleted; ban carries over by fingerprint |
| 15 | Network and server logs | Security, rate limits | API log holds ids only; rate-limit buckets are keyed hashes that expire | n/a | Not stored against the player | Questify operators | Short | n/a |

**Never collected:** payment details, contacts, photo library, microphone, advertising id, health data, precise movement
history, browsing history, installed apps, anything for tracking.

**Where data goes outside Questify** [doc: privacy policy v0.1 section 5; ADR-070]: hosting inside Saudi Arabia (CranL
`riyadh-1`), Msegat for SMS, an email provider for email codes, Apple and Google to deliver push (token and a notice
text that never carries phone or email), the event's organizer (rows 6 to 9 above). **Not in the build yet:** wallet passes
(T-801) and Apple App Attest / Play Integrity (T-812): add them to every form the day they ship (the privacy policy
already names both, G8).

## Gaps and mismatches found (none fixed silently)

Each has an entry in `docs/OPEN_QUESTIONS.md` (Q-769 to Q-778) with the recommended answer, and a note under T-806 in
`docs/TASKS.md`. The recommended answer is what the pack in this folder already assumes.

| Id | Gap | Where seen | Recommended | Q |
|---|---|---|---|---|
| G1 | The signed-in app has **no entry for the privacy policy, terms, community guidelines, support contact or the deletion page** (FR-1707's app half was never built; links exist only on the sign-in and re-accept screens and in the submission composer) | `ProfileScreen.tsx`, `sign-in.tsx`, `reaccept.tsx`, `SubmissionEntry.tsx`; STORE_COMPLIANCE 4 and checklist | Add a Legal block to Profile (three documents, support, deletion page) before submission. Apple 5.1.1(i) wants the policy "within the app in an easily accessible manner" | Q-769 |
| G2 | Privacy manifest lacks `NSPrivacyCollectedDataTypes` and `NSPrivacyTracking: false` | `app.json` `ios.privacyManifests`; `docs/compliance/EXPO_SDK_CHECK.md` action A2 still open | Add the list in `app-store-privacy-labels.md` section 3 and `NSPrivacyTracking: false`; run Xcode's privacy report once | Q-770 |
| G3 | **EAS has no store profile:** only `development`, `preview`, `demo-ios`; no `production`, no Android app bundle profile, no Google submit profile; `demo-ios` points at the staging API host and `ascAppId` is the placeholder `SET_ASC_APP_ID_DIGITS`. The QR/join origin `questify.nafes.com` differs from the join-link host `questify.sa` | `eas.json`; `join/link.ts`; EXPO_SDK_CHECK A4 | **Done 2026-11-14 (ADR-838):** `production` iOS and Android profiles (image `sdk-57`) and one web origin, `questify.nafes.com`. Still open: the production API URL (staging for now, Q-784) and `ascAppId` | Q-771, Q-784 |
| G4 | **Android build:** STORE_COMPLIANCE 2.7 still lists only INTERNET, VIBRATE, CAMERA (checked 2026-10-21, before location, NFC and push); no `google-services.json` or `android.googleServicesFile`; no notification icon | `app.json`; STORE_COMPLIANCE 2.7; RUNBOOK "The app's side of push" | Read the merged manifest of the first release bundle and rewrite 2.7; wire the Firebase file (hard gate, T-806 Done-when); set the 96 px icon | Q-772 |
| G5 | **Ads declaration vs the Home sponsor strip.** Docs say "Ads: No" (STORE_COMPLIANCE 2.11, PD-27), but ADR-311 itself reads Google as counting sponsored native content as an ad, and the app shows an organizer's sponsor strip and "Presented by" tags | `SponsorStrip.tsx`, `SponsorQuests.tsx`; ADR-067, ADR-311 | Play: answer "Yes, contains ads" unless the coordinator or counsel decide a disclosed organizer sponsor is not an ad (a wrong "No" risks the listing, a "Yes" costs a label). Apple: advertising "No" (no ad network, no advertiser content chosen by Questify). No effect on rating or labels | Q-773 |
| G6 | **Photos wait on storage** (Q-768: where CranL stores bucket files; photos stay off until answered). The forms must declare photos (ADR-073), the binary has the photo quest and wall, and the review demo needs "every quest type" | Q-768, ADR-828, ADR-830, RUNBOOK 1613 | Do not submit before the bucket answer: otherwise the photo quest and wall are dormant at review (Apple 2.3.1(a)). If Saudi storage is impossible, decide the fallback first, then the forms | Q-774 |
| G7 | **`locationQuests` is off by default** (platform switch), yet the labels declare location and the demo event must show "a location quest with its non-location alternative" | `complete.ts` `locationQuestsOn`; RUNBOOK 1438; PD-09 | Run the RUNBOOK's database-log check, turn the switch on before the review build is prepared, and keep it on; do not submit with the forms declaring a feature the reviewer cannot reach | Q-775 |
| G8 | **Privacy policy v0.1 does not match the build or the forms:** names wallet passes and device-integrity checks (T-801 and T-812 are unbuilt) and an Android install link (no code); says a location reading "is kept only with a flag" while DATA_MODEL says no coordinate is stored; says all data is in Saudi Arabia while the email provider is Google and photo storage is open (Q-768); every retention period is a placeholder (Q-075), and the contact page still says "We are preparing our contact details" (`contact.pending`) | `docs/legal/privacy-policy.md`; DATA_MODEL; `messages.ts` | Counsel's pass (T-807) must land first. Play's Data safety must match the policy, so the retention and deletion answers here are written on the as-built state and flagged where a period is missing. Trim the policy to what ships | Q-776 |
| G9 | **Age answers with the photo wall:** STORE_COMPLIANCE 1.2 asks for the "social" answer to be re-checked since players can now see each other's photos | `PhotoWall.tsx`; STORE_COMPLIANCE 1.2, 1.14 | UGC Yes, Messaging No, Social media No (browse, Report and Block only; no feed ranking, likes, comments or re-sharing), Contests Frequent: result 13+, equal to ADR-028's minimum age. Play target audience 13-15, 16-17, 18+ | Q-777 |
| G10 | **The organizer as a "third party" in Play's Data safety "shared" column.** Docs call the organizer a third party (STORE_COMPLIANCE 1.11) but the DPA draft makes Questify its processor | `organizer-dpa.md`; PD-17 | Declare the rows seen by the organizer as shared (over-disclosure is safe; the join card is the consent) and revisit when counsel settles Q-043 | Q-778 |
| G11 | Minor items, no Q: (a) the Arabic glossary says «بطاقة NFC» but the T-808 RTL pass of 2026-11-13 changed one string to «وسم NFC»: pick one term (the listing text here uses the glossary's «بطاقات NFC»); (b) the Arabic purpose strings still need a person's read (T-808); (c) the seller is Dhia personally (ADR-010): Play's closed test (12 testers, 14 days) and the EU trader declaration use his personal details, Q-078 is still open; (d) Q-520: no reviewer SIM number is chosen yet; (e) `NFC Tag Reading` must be enabled on the App ID in the Apple account | `locales/ar.json`; ADR-010; Q-520 | Fold (a) and (b) into T-808; (c) to (e) are Dhia's actions at account time | none |

## Order of work before pressing Submit

1. Settle G1 to G7 (code and config), G8 (counsel), then regenerate nothing here: only the lines marked `{{...}}` change.
2. Q-768 answered and photos on; `locationQuests` on; push checklist and Firebase file done (T-806 Done-when).
3. EAS production builds; TestFlight external round (STORE_COMPLIANCE 1.17); merged manifest read; Xcode privacy report.
4. Console: Prepare for review (version, window), play the reviewer to level 3, paste the number, the code (shown once)
   and the join code into the two review-notes files; print or attach the sample QR codes.
5. Capture the screenshots on devices (`screenshots-and-listing.md`).
6. Enter every form from the files in this folder; submit; **Close window** only after both stores finish review.
