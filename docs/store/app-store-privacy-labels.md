# App Store Connect: App Privacy ("nutrition labels")

Prepared 2026-11-13. Where: App Store Connect, the app, App Privacy. Row numbers (#) refer to the data inventory in
`README.md`. Apple's data types and purposes are named as the form shows them **[form: confirm on the live form]**.
"Collect" in Apple's sense = sent off the phone to Questify's servers and kept longer than the request needs.

## 1. Top-level answers

| Question | Answer | Why (trace) |
|---|---|---|
| Do you or your third-party partners collect data from this app? | **Yes, we collect data** | Sign-in, activity and more leave the phone (README inventory) |
| Privacy Policy URL | `{{WEB_ORIGIN}}/en/legal/privacy_policy` (and the Arabic page `/ar/legal/privacy_policy` in the Arabic localization) | Policy exists as web pages (`docs/legal/README.md`); counsel's version and the filled placeholders come first (G8) |
| User Privacy Choices URL (optional) | `{{WEB_ORIGIN}}/en/delete-account` | Deletion page; add a Settings page later if wanted |
| Is any data used to track you (ATT)? | **No. No type is marked "Used to Track You".** | No ad network, no attribution, no data broker, no linking with other companies' data (PD-27; README "None of the following exists"). No `NSUserTrackingUsageDescription`; no ATT prompt |
| Third-party partners that collect data in the app | **None.** Apple (APNs) and Google (FCM) only carry a push token and a notice; no SDK of theirs collects for them. The event's organizer receives data, but is not a partner whose code is in the app | `package.json`: no analytics, ads or social SDK |

## 2. Data types, one by one

Every type below is **Linked to You** (it is attached to the player's account) and **not used for tracking**.
Anything not listed is "Not collected". Purposes use Apple's names.

| Apple category > type | Collected? | Purposes | Linked | Tracking | Rows | Note for the form |
|---|---|---|---|---|---|---|
| Contact Info > **Name** | Yes | App Functionality | Yes | No | 6 | The organizer's join question "Full name" (and "own fields"); Questify itself never asks a real name. Optional per organizer |
| Contact Info > **Email Address** | Yes | App Functionality; Developer's Advertising or Marketing | Yes | No | 2 | Sign-in; marketing only if the player opts in, per channel (`marketing.*`, ADR-065) |
| Contact Info > **Phone Number** | Yes | App Functionality; Developer's Advertising or Marketing | Yes | No | 1 | Sign-in; promotional SMS only with a separate opt-in |
| Contact Info > Physical Address, Other User Contact Info | No | | | | | City (row 5) is a profile choice, not an address: declared under Other Data Types |
| Location > **Precise Location** | Yes | App Functionality | Yes | No | 10 | Check-in quests and the "far from venue" fair-play flag, only while the app is open, only after the system prompt; no background access (`app.json` blocks it); QR is always an alternative. The form's wording "kept longer than needed to service the request" is met by the stored accuracy, mocked mark and rounded venue distance, so declare it |
| Location > Coarse Location | No | | | | | City is typed by the player |
| User Content > **Photos or Videos** | Yes | App Functionality | Yes | No | 8 | Photo quests (system picker or camera); no video (FR-1006); the photo library is never read. See G6: photos stay off until storage is settled but the binary contains them |
| User Content > **Customer Support** | Yes | App Functionality | Yes | No | 9 | Help-desk requests, reports of a player, problem reports with phone model, OS and app version the player chooses to attach, suggestions. Nothing is sent automatically, so **Other Diagnostic Data is not claimed** |
| User Content > **Other User Content** | Yes | App Functionality | Yes | No | 6, 7, 8 | Text submissions, quiz and survey answers, votes, join answers, ratings |
| User Content > Emails or Text Messages, Audio, Gameplay Content | No | | | | | No chat between players; the help desk is under Customer Support |
| Identifiers > **User ID** | Yes | App Functionality; Analytics; Product Personalization | Yes | No | 3, 7 | Player id and username; first-party analytics = the organizer's event dashboard and Questify's own platform numbers, no outside service |
| Identifiers > **Device ID** | Yes | App Functionality; Developer's Advertising or Marketing | Yes | No | 11, 12 | The random install id (fraud and per-install limits count as App Functionality) and the push token (promotional pushes need a recorded opt-in, FR-1111). It is **not** the advertising identifier; no `AdSupport` use |
| Usage Data > **Product Interaction** | Yes | App Functionality; Analytics; Product Personalization | Yes | No | 7 | Quests done, points, rankings, streaks, which screens' actions were taken; used for the game, the organizer's analytics and event suggestions |
| Usage Data > Advertising Data, Other Usage Data | No | | | | | No ads (see G5 for the sponsor strip); the sponsor strip shows organizer-chosen sponsors without targeting |
| Diagnostics > Crash Data, Performance Data, Other Diagnostic Data | No | | | | | No crash or performance SDK in the app. Apple's own TestFlight/App Store crash reports are Apple's. Revisit if one is added |
| Other Data Types | Yes | App Functionality (birth year); Product Personalization; Developer's Advertising or Marketing (city and interests, for event suggestions and invitations) | Yes | No | 4, 5, 13, 14 | Birth year, city, interests, consent records, safety records. Declare once with the combined purposes |
| Health & Fitness, Financial Info, Sensitive Info, Contacts, Browsing History, Search History, Purchases | No | | | | | No payments (ADR-002), no purchases, no contact upload, no in-app search. Organizer join fields must not ask sensitive data (organizer content rules) |

Summary line to expect on the product page, "Data Linked to You": Contact Info, Location, User Content, Identifiers,
Usage Data, Other Data. "Data Used to Track You": none.

## 3. Privacy manifest (`NSPrivacyCollectedDataTypes`) to match (G2)

Not in `app.json` yet (`EXPO_SDK_CHECK.md` A2). When added under `expo.ios.privacyManifests`, every entry uses
`NSPrivacyCollectedDataTypeLinked: true`, `NSPrivacyCollectedDataTypeTracking: false`; `NSPrivacyTracking: false`;
`NSPrivacyTrackingDomains: []`. Key names are from memory of Apple's manifest schema **[form: check against Apple's
"Describing data use in privacy manifests" before committing]**.

| Manifest data type | Purposes (`NSPrivacyCollectedDataTypePurpose...`) |
|---|---|
| `...Name` | `AppFunctionality` |
| `...EmailAddress` | `AppFunctionality`, `DeveloperAdvertising` |
| `...PhoneNumber` | `AppFunctionality`, `DeveloperAdvertising` |
| `...PreciseLocation` | `AppFunctionality` |
| `...PhotosorVideos` | `AppFunctionality` |
| `...CustomerSupport` | `AppFunctionality` |
| `...OtherUserContent` | `AppFunctionality` |
| `...UserID` | `AppFunctionality`, `Analytics`, `ProductPersonalization` |
| `...DeviceID` | `AppFunctionality`, `DeveloperAdvertising` |
| `...ProductInteraction` | `AppFunctionality`, `Analytics`, `ProductPersonalization` |
| `...OtherDataTypes` | `AppFunctionality`, `ProductPersonalization`, `DeveloperAdvertising` |

The required-reason API list already in `app.json` (UserDefaults CA92.1, file timestamp C617.1/0A2A.1/3B52.1, boot time
35F9.1, disk space E174.1/85F4.1) was copied from the SDK 57 libraries on 2026-10-20. **Re-read each library's own
`PrivacyInfo.xcprivacy` for the packages added since** (`react-native-nfc-manager`, `expo-location`, `expo-camera`,
`expo-image-picker`, `expo-secure-store`, `expo-notifications`, `expo-sharing`, `react-native-view-shot`, `expo-device`;
EXPO_SDK_CHECK "Re-check when": every new native library). Workflow without a Mac: the EAS build's report, or borrow a
Mac once for Xcode's "Generate Privacy Report" and make the label match it.

## 4. Other Apple fields that sit next to this form

| Field | Answer | Trace |
|---|---|---|
| Export compliance | Uses encryption: **Yes (standard HTTPS only, exempt)**; `ITSAppUsesNonExemptEncryption = NO` is already set, so the question is not asked per upload | `app.json` `usesNonExemptEncryption: false`; only a random UUID is made in the app; STORE_COMPLIANCE 1.15 |
| Content rights | Contains no third-party content except the organizer's, who license their logos in the Organizer Terms (section 4); the word lists' licences are in `docs/legal/THIRD_PARTY.md` | Apple 5.2.1 |
| Sign in with Apple | Not required (own accounts only) | STORE_COMPLIANCE 1.9; no third-party sign-in package |
| Account deletion | In app: Profile, Delete account; also on the web | README |
| EU trader status | Declare **trader** (Questify is a business); the seller is Dhia personally while ADR-010 stands, so his details show on EU pages (Q-078) | STORE_COMPLIANCE 1.16 |
| Category | Primary: **Lifestyle** or **Entertainment** (not Games, PD-15); no secondary (Social Networking would invite more UGC scrutiny) | PD-15; decide with the listing. The App Store category list is **[form]** |
| Copyright / Support URL | Support: `{{WEB_ORIGIN}}/en/contact` once the page carries real details (it shows "We are preparing our contact details" today, G8) | Apple 1.5 |

## 5. Re-open this form when

Any of: an SDK is added (analytics, crash, ads, social); wallet passes (T-801: pass fields carry username, points,
level, rank: no new type, but the pass is a new recipient); App Attest (T-812: a device attestation, declare under
Device ID / Other Diagnostic Data after reading Apple's guidance); photos or location change retention; a chat or a feed
is built. Privacy answers can be changed without an app update (STORE_COMPLIANCE 1.13), but must match the live app.
