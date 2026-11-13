# Google Play Console: Data safety

Prepared 2026-11-13. Where: Play Console, the app, Policy and programs, App content, Data safety. Categories, types,
purposes and the "collected / shared / ephemeral" definitions were read at
`support.google.com/googleplay/android-developer/answer/10787469` on 2026-11-13 **[form]**. Row numbers (#) refer to the
inventory in `README.md`; the Apple pack (`app-store-privacy-labels.md`) is built from the same list so the two never
disagree. The answers must also match the privacy policy (Google rule, STORE_COMPLIANCE 2.4): see G8 before pasting.

Definitions applied: **Collected** = sent off the phone, by the app or any SDK. **Shared** = given to a third party;
a service provider that only processes for Questify is not "shared". The event's organizer counts as a third party in
STORE_COMPLIANCE 1.11, so rows it receives are marked shared (G10, Q-778). **Ephemeral** = held only in memory for the
request: not claimed for anything (every item below is stored, or its derived values are).

## 1. Opening questions

| Question | Answer | Trace |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | README inventory |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | The release build refuses to start without an HTTPS API base URL (`apiBaseUrl` in `app-session.ts`); every SDK call (FCM) is TLS. The Android manifest sets no cleartext allowance. **Confirm with the merged manifest** (G4) |
| Do you provide a way for users to request that their data is deleted? | **Yes** | In app: Profile, Delete account. Web: `{{WEB_ORIGIN}}/en/delete-account` |
| Data deletion URL | `{{WEB_ORIGIN}}/en/delete-account` | The page works with no app and no sign-in, names Questify, deletes the account and its data (Google: "must delete, not freeze"). It must also appear in the policy (PD-16). The page title/app name must match the listing |
| Can users request that some data is deleted without deleting the account? | **No** (they can turn off marketing, location and push, and edit the profile, but no per-item deletion) | Keep the answer aligned with the policy's rights list |
| Independent security review ("Security reviewed by an independent third party") | **Do not claim** | None done (QUALITY_BASELINE targets, no audit report) |
| Follows the Play Families policy | **No**: the target audience is 13 and over (`play-content-rating.md`) | ADR-028 |

## 2. Data types

For each type: collected (C), shared (S), optional or required, purposes (Google's names). All are **not** processed
ephemerally. "Required" per Google means the app cannot work without it for any user.

### Location

| Type | C | S | Optional/Required | Purposes | Trace |
|---|---|---|---|---|---|
| Approximate location | Yes | No | **Optional** | App functionality; Fraud prevention, security and compliance | The Android permission pair `ACCESS_COARSE_LOCATION` + `ACCESS_FINE_LOCATION` is declared by `expo-location`; the app asks for a high-accuracy fix (`location.ts`). Declare both types so the form agrees with the manifest |
| Precise location | Yes | No | **Optional** | App functionality; Fraud prevention, security and compliance | Check-in quests (venue radius from 20 m), "far from venue" flag; foreground only (`isAndroidBackgroundLocationEnabled: false`, `ACCESS_BACKGROUND_LOCATION` blocked); QR always an alternative (ADR-015). Declared even though no coordinate is stored (DATA_MODEL "completion_position": accuracy, mocked mark and a venue distance rounded to 10 m stay). **No Permissions Declaration Form is needed** (that is for background location) |

### Personal info

| Type | C | S | Optional/Required | Purposes | Trace |
|---|---|---|---|---|---|
| Name | Yes | **Yes**, with the event's organizer | Optional | App functionality | The organizer's join question "Full name"; the join card shows what the team and other players see before the player joins (PD-17) |
| Email address | Yes | No | **Required** (the player gives a phone or an email; one is mandatory) | Account management; App functionality; Developer communications; Advertising or marketing (only after the separate opt-in) | `player_contact.email`; the organizer never sees it (policy section 4). Email codes go out through the email provider (a service provider, not "sharing"; `{{EMAIL_PROVIDER}}`) |
| Phone number | Yes | No | **Required** (see above) | Account management; App functionality; Developer communications; Advertising or marketing (only after the opt-in) | `player_contact.phone_e164`, +966 only; SMS delivered by Msegat as a service provider |
| User IDs | Yes | **Yes**, with the organizer (username) | Required | Account management; App functionality; Analytics; Personalization | Player id and the public @username |
| Other info | Yes | No | Birth year: Required; city and interests: Optional | App functionality (age gate); Personalization; Advertising or marketing (event suggestions and invitations, opt-in for promotion) | `player.birth_year`, `interests.tsx` |
| Address, Race and ethnicity, Political or religious beliefs, Sexual orientation | No | | | | Organizer join fields must not ask sensitive data (organizer content rules) |

### Messages

| Type | C | S | Optional/Required | Purposes | Trace |
|---|---|---|---|---|---|
| Other in-app messages | Yes | **Yes**, with the event team | Optional | App functionality | Help requests, reports of a player and suggestions (T-310, T-312); private between the player and the event team, or Questify's queue (ADR-248). Retention: 90 days after the later of the event's end and the sending (Q-210) |
| Emails, SMS or MMS | No | | | | The app reads no messages and asks for no SMS permission; the sign-in code is typed |

### Photos and videos

| Type | C | S | Optional/Required | Purposes | Trace |
|---|---|---|---|---|---|
| Photos | Yes | **Yes**, with the event team; with other players only when the owner allowed the photo on the wall and the team picked it | Optional (photo quests only) | App functionality | System picker or camera; the library is never read (`photosPermission: false`; `READ_MEDIA_*` blocked); EXIF is removed and photos are deleted by construction (ADR-828); photos stay off until the bucket question is answered (G6, Q-768) |
| Videos | No | | | | Never in v1 (FR-1006) |

### App activity

| Type | C | S | Optional/Required | Purposes | Trace |
|---|---|---|---|---|---|
| App interactions | Yes | **Yes**, with the organizer (their event only) | Required | App functionality; Analytics; Personalization | Quests done, points, ranks, streaks; the organizer's analytics and Questify's own numbers, first party only |
| Other user-generated content | Yes | **Yes**, with the event team | Optional | App functionality | Text submissions, quiz and survey answers, votes, ratings, join answers |
| Other actions | Yes | No | Optional | App functionality; Fraud prevention, security and compliance | Consent records, safety flags (blocks the player made, past usernames) |
| In-app search history, Installed apps | No | | | | No in-app search; no package queries beyond `expo-sharing`'s SEND intent query |

### App info and performance

| Type | C | S | Optional/Required | Purposes | Trace |
|---|---|---|---|---|---|
| Diagnostics (phone model, OS version, app version) | Yes | No | Optional | App functionality | Attached only when the player writes a problem report (T-312), user-initiated, deleted with the account. If the live form treats this as part of "Other in-app messages" only, drop this row (Apple's pack does not claim diagnostics) |
| Crash logs, Other app performance data | No | | | | No crash or performance SDK |

### Device or other IDs

| Type | C | S | Optional/Required | Purposes | Trace |
|---|---|---|---|---|---|
| Device or other IDs | Yes | No | Required | App functionality; Fraud prevention, security and compliance; Advertising or marketing (promotional push, opt-in) | The random install id (`X-Device-Id`) and the FCM push token. Not the advertising id; no `AD_ID` permission use (confirm in the merged manifest: Play adds the `AD_ID` permission when a library asks for it; if present, remove it or declare it) |

### Not collected

Financial info (no payments, ADR-002), Health and fitness, Audio files, Files and docs, Calendar, Contacts, Web browsing.

## 3. Sharing, in one place

| Recipient | What | Why | Consent |
|---|---|---|---|
| The event's organizer and its team | Name (if asked), username, activity, submissions, photos, help requests of that event only | They run the event and hand over the prizes | The join card before joining (PD-17), Organizer Terms and the DPA (draft) |
| Service providers (not "sharing") | Hosting (CranL, Riyadh), SMS (Msegat), email, push (FCM, APNs) | Deliver the service to Questify only | Policy section 4 |
| Nobody else | No advertisers, data brokers or analytics firms | | |

## 4. Matches that must hold when the form is checked against the app

| Check | Result |
|---|---|
| Data safety vs privacy policy | Not yet equal: retention periods are placeholders, the policy names wallet passes, device-integrity checks and an Android install link that are not built (G8) |
| Data safety vs merged manifest | Verify on the first release bundle: location, camera, notifications, NFC, no storage, no SMS, no `AD_ID`, no `READ_MEDIA_*` (G4) |
| Data safety vs Apple pack | Same inventory. Differences by design: Google's Diagnostics row (user-initiated report) and Messages row |
| Data safety vs ads declaration | See G5: if "contains ads" is answered Yes for the sponsor strip, no ad-data row is added (no ad SDK) |

## 5. Re-open when

An SDK is added; T-801 wallet passes (a pass is a new recipient of username, points, level and rank); T-812 Play
Integrity (declare as Device or other IDs / diagnostics after reading Google's note); a chat or feed is built; location or
photos change retention. The form can be edited without an app release but must match the live app.
