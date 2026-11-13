# Google Play Console: content rating (IARC), target audience, app content declarations

Prepared 2026-11-13. Where: Play Console, the app, Policy and programs, App content. The IARC questionnaire's exact
questions change between releases; the topics below are the ones it asks (violence, sexuality, language, controlled
substances, user interaction, location sharing, digital purchases, gambling) and each answer is traced **[form: match
the live wording]**. IARC first asks for a category. Recommended: **"All other app types"** (it is not a game, PD-15,
and not a messenger or social network, so do not pick "Social / Communication").

## 1. IARC questionnaire

| Topic | Answer | Trace |
|---|---|---|
| Violence (cartoon, fantasy, realistic, weapons, blood, sexual violence) | **None** | Adventure-game art without combat; mini-games are memory match and slide puzzle (T-305). Organizer rules refuse physical-harm challenges (Apple 1.4.5; PD-29) |
| Sexuality and nudity | **None** | Voting never rates looks (PD-13); photo moderation and Report/Block (STORE_COMPLIANCE 1.2) |
| Language (profanity, crude humor) | **None** | Arabic and English word lists filter usernames and text (ADR-068, `THIRD_PARTY.md`) |
| Controlled substances (alcohol, tobacco, drugs: depiction, references) | **None** | Organizer content rules for a 13+ audience |
| Gambling and simulated gambling | **None** | No wagering, no chance-based reward, no raffles (PD-05, PD-06); fixed-price points store and rank prizes (ADR-008). Google forbids chance-based loyalty rewards in Game apps; the app is not listed as a Game |
| Contests / sweepstakes (if the form asks) | **Yes, skill-and-effort contests with prizes sponsored by the organizer, free to enter** | Rank prizes (STORE_COMPLIANCE 1.12, 2.9); official rules in the app (`rules.notSponsors`) |
| Digital purchases | **No** | Nothing is sold; points cannot be bought (ADR-002); no Play Billing |
| Does the app allow users to interact with each other? | **Yes** | Public usernames on rankings and profiles, the photo wall, "meet" quests, fixed-reaction cheers on the big screen. No free-text chat between players |
| Does the app share user-generated content with other users? | **Yes** | The opt-in photo wall (ADR-830) and public profiles; moderation and Report/Block exist |
| Does the app share the user's current physical location with other users? | **No** | A reading is used by the server only; players never see each other's location (DATA_MODEL "completion_position") |
| Does the app allow users to purchase digital goods? | **No** | As above |
| Unrestricted internet access / browser | **No** | No browser or WebView in the app; organizer links open the phone's browser |
| Does the app collect personal data? | Yes (Data safety covers it) | `play-data-safety.md` |

Expected outcome: an IARC rating in the teen range with the interactive-elements flags "Users interact", "Shares user
content" and (if the form adds it) "In-app contests". If IARC returns an older-teen result than 13 and over, **do not
argue it down**; compare with Apple's 13+ (`app-store-age-rating.md`) and Q-777. The Saudi system (GCAM) is produced from the
same answers.

## 2. Target audience and content

| Field | Answer | Trace |
|---|---|---|
| Target age groups | **13-15, 16-17, 18 and over.** Not 5 and under, 6-8, 9-12 | ADR-028 minimum age 13; 13 to 17 may play like adults (ADR-084); Q-042 (guardians) is open with counsel |
| Does the app appeal to children? | **No.** The adventure-game style must not read as a kids' app in the listing (STORE_COMPLIANCE 2.10): no cartoon-only screenshots without real event context, no youthful-animation framing in the feature graphic | Families policy avoided; no ad SDK |
| Store listing art | Screenshots of real event flows with fictional brand and players, both languages | `screenshots-and-listing.md` |

## 3. App content declarations (each section of Policy > App content)

| Declaration | Answer | Trace |
|---|---|---|
| Privacy policy | `{{WEB_ORIGIN}}/en/legal/privacy_policy` (Play shows one URL; the page switches language; use the English URL and keep the Arabic one in the Arabic listing if Play asks for a per-language URL) | Counsel's text first (G8) |
| Ads | **See G5. Recommended: "Yes, my app contains ads"** (the organizer's sponsor strip and "Presented by" labels are third-party promotional content shown in the app, ADR-067, ADR-311's own reading of Google). If the coordinator or counsel decide it is not an ad: "No". No ad SDK and no advertising id either way | `SponsorStrip.tsx` |
| App access | "All or some functionality is restricted": instructions in `play-review-notes.md` | Fixed code for one number, ADR-561 |
| Content ratings | Section 1 | |
| Target audience and content | Section 2 | |
| Data safety | `play-data-safety.md` | |
| Government apps | **No** | |
| Financial features | **No** (no payments, loans, wallets with money; points have no cash value, ADR-002) | |
| Health apps | **No** | |
| News apps | **No** | |
| COVID-19 contact tracing and status | **No** | |
| Advertising ID declaration | **No, the app does not use the advertising ID** (confirm that the merged manifest has no `com.google.android.gms.permission.AD_ID`; the target is API 36, so the declaration is required) | G4 |
| Photo and video permissions declaration | **Not needed**: the app does not hold `READ_MEDIA_IMAGES` or `READ_MEDIA_VIDEO`; the system picker is used | `app.json` blocks both; Play photo-permissions policy |
| Sensitive permissions declaration (SMS, call log, background location, all-files) | **None used** | `ACCESS_BACKGROUND_LOCATION` blocked; no SMS permission (codes typed; SMS Retriever not used) |
| Foreground service declarations | **None** | `FOREGROUND_SERVICE_LOCATION` blocked; no service type declared |
| Account deletion (Data safety section and App content) | In-app path plus web URL, as in the Data safety file | Google User Data policy |
| Developer verification (2026) | Confirm the package `app.questify.mobile` is registered on the Play Console home | STORE_COMPLIANCE 2.3 |
| EU DSA trader declaration | Trader; the details shown are the seller's (ADR-010: Dhia's personal details until the company takes the accounts, Q-078) | STORE_COMPLIANCE 2.14 **[NOT verified]** |
| Category and tags | Category: **Events** or **Lifestyle**, not Games (PD-15); decide with the listing. Tags are **[form]** | PD-15 |

## 4. Policy checks before the declarations are saved

- UGC policy (STORE_COMPLIANCE 2.8): terms accepted before the first submission (FR-1706), a definition of objectionable
  content (community guidelines), in-app Report and Block, points for a submission pending until moderation approves
  (PD-12). All present in the build except G1 (the guidelines, terms and policy are reachable from the sign-in and
  submission screens only).
- Spam policy 2.13: one app, one listing; the share quest uses the system share sheet.
- Real-money gambling policy 2.9: free participation, no purchasable points, fixed redemption price, official rules in the
  app, rank prizes only.
- Target API 36 and 16 KB pages: EXPO_SDK_CHECK says met; confirm in the App bundle explorer after the first upload.
- A **personal** developer account (ADR-010) must finish a closed test (12 testers, 14 continuous days) before
  production access (STORE_COMPLIANCE 2.2); budget three weeks.
