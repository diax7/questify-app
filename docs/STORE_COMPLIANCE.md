# Store Compliance — Questify

**Purpose:** the gate every feature passes before it is built. Goal: the first App Store and
Google Play submissions pass review on the first try, and the Saudi launch meets PDPL, CST and
Ministry of Commerce rules.
**Researched:** 2026-10-16 against the official sources linked inline.
**Not legal advice.** Items marked for counsel must be confirmed by a Saudi lawyer before launch.

**How to read the status marks**

- **[verified 2026-10-16]**: the rule was read on the official (or operator-published) source on
  that date, and the quote or summary matches it.
- **[NOT verified — check]**: from memory, a secondary source, a draft, or an interpretation.
  Confirm before relying on it.
- "Interpretation" means the rule text is verified but how it applies to Questify is our reading.

Apple's App Review Guidelines page read for this document says "Last Updated: June 8, 2026".
All Apple guideline quotes below come from
https://developer.apple.com/app-store/review/guidelines/ unless another URL is given.

---

## 0. The ten things that most shape the product

1. **One binary, many organizers.** Apple 4.2.6 names "an event app with separate entries for
   each client event" as the accepted model. Per-client branded store apps are rejected unless the
   client submits them itself. White-label = in-app theming per event.
2. **Remote config may change data, not features.** Apple 2.5.2 and 2.3.1(a) forbid downloading
   code that "introduces or changes features" and forbid "hidden, dormant, or undocumented
   features". Every feature a flag can switch on must be in the reviewed binary and shown to the
   reviewer. OTA JavaScript updates are for fixes and small changes.
3. **No system permission may be the price of a reward.** Apple 5.1.2(i): an app may not require
   push, location or tracking to "receive monetary or other compensation, including but not
   limited to gift cards". Points redeem for gift cards, so a location quest needs a non-location
   path, and points are never given for turning on notifications.
4. **Raffles are the riskiest feature.** Apple lists "lotteries and raffles" under the Gambling
   age-rating descriptor (18+). Saudi Arabia requires a Chamber of Commerce licence and Ministry
   supervision for every commercial prize draw. v1 ships a fixed-price points store and rank-based
   prizes only.
5. **Points can never be bought** (ADR-002 already). If they ever are, Apple requires in-app
   purchase, the points may not expire, and Google forbids using purchased items to win prizes of
   real-world value.
6. **UGC needs moderation built in**: pre-publication filtering, report, block, terms accepted
   before the first submission, published contact, timely action (Apple 1.2, Google UGC).
7. **Account deletion inside the app and on a web page** (Apple 5.1.1(v), Google User Data).
8. **The reviewer must be able to play a whole event**: a demo account that bypasses SMS, a
   permanent demo event with every quest type, and a printable QR code (Apple 2.1, Google sign-in
   details).
9. **Organization developer accounts** (a Saudi company, not a sole establishment) on both stores:
   the company name shows as seller, Google's 12-tester / 14-day closed test is skipped, and the
   EU DSA contact details shown publicly are the company's, not a home address.
10. **PDPL**: a privacy notice before collection, consent per purpose, separate marketing consent,
    guardian consent for people without full legal capacity, a 72-hour breach report to SDAIA,
    and a lawful basis for any data leaving the Kingdom.

---

## 1. Apple App Store

### 1.1 Developer account: individual vs organization

| Rule | Source | Status |
|---|---|---|
| Individual or sole proprietor/single-person business: "your personal legal name will be listed as the seller on the App Store." Aliases or company names as your name delay enrollment. | https://developer.apple.com/help/account/membership/program-enrollment/ | [verified 2026-10-16] |
| "If you are a sole proprietor/single-person business, you must join as an individual and your legal name will appear as the seller." | same | [verified 2026-10-16] |
| Organization: must be a legal entity that can contract with Apple. "We don't accept DBAs, fictitious businesses, trade names, or branches." The legal entity name is the seller. Needs a D-U-N-S Number, legal binding authority (owner/founder, executive, senior project lead, or delegated employee), and a work email. | https://developer.apple.com/programs/enroll/ and the enrollment help page above | [verified 2026-10-16] |
| D-U-N-S is free in most jurisdictions, issued by Dun & Bradstreet; Apple offers a lookup. Not needed for individuals. Government organizations exempt. | https://developer.apple.com/help/account/membership/D-U-N-S/ | [verified 2026-10-16] |
| An individual membership can be converted to an organization by request (founder/co-founder, D-U-N-S, business documents). | https://developer.apple.com/help/account/membership/updating-your-account-information/ | [verified 2026-10-16] |
| Apple Developer Program fee (USD 99/year). | https://developer.apple.com/programs/ | [NOT verified — check] |

**Questify reading (interpretation):** a Saudi sole establishment (مؤسسة فردية) is a
sole proprietorship, so Apple would enroll it as an individual and show Dhia's personal name as
seller. To show a company name, Questify needs a separate legal entity (for example a
single-person LLC) with its own D-U-N-S. Request the D-U-N-S early; Google says it can take up to
30 days (section 2.1).

### 1.2 Guideline 1.2 — User-generated content

Apps with user-generated content "must include:

- A method for filtering objectionable material from being posted to the app
- A mechanism to report offensive content and timely responses to concerns
- The ability to block abusive users from the service
- Published contact information so users can easily reach you"

Also in 1.2: apps used primarily for "objectification of real people (e.g. 'hot-or-not' voting),
making physical threats, or bullying do not belong on the App Store". "It is your responsibility
to remove content that violates this guideline, your terms of service, or your community
standards." [verified 2026-10-16]

Related:

- **1.4.5:** "Apps should not urge customers to participate in activities (like bets, challenges,
  etc.) ... in a way that risks physical harm". Organizer-written challenges are Questify's
  responsibility. [verified 2026-10-16]
- **1.5:** the app and its Support URL must "include an easy way to contact you". [verified
  2026-10-16]
- Apple's rejection letters for 1.2 commonly also ask that users agree to terms that state there
  is no tolerance for objectionable content or abusive users. [NOT verified — check; not in the
  guideline text]

What Questify must build (both stores, see 2.9 for Google):

- Text submissions and display names pass a profanity/abuse filter (Arabic and English) before
  they are visible. Photos pass automated image moderation or organizer pre-approval before they
  are public.
- A report action on every submission, every profile and every display name on a leaderboard.
- Block a user (hides their content from me; stops them interacting with me).
- A moderation queue for organizers plus a Questify platform queue, with a stated response time.
- Contact details (email and in-app contact) on the store listing, in the app and on the website.
- Voting quests vote on submissions or ideas, never on a person's looks.

### 1.3 Guideline 2.1 — App completeness, demo account and demo event

- **2.1(a):** "include demo account info (and turn on your back-end service!) if your app includes
  a login. If you are unable to provide a demo account due to legal or security obligations, you
  may include a built-in demo mode in lieu of a demo account with prior approval by Apple. Ensure
  the demo mode exhibits your app's full features and functionality." Placeholder text and empty
  websites must be removed. [verified 2026-10-16]
- **Before You Submit:** "Provide App Review with full access to your app. If your app includes
  account-based features, provide either an active demo account or fully-featured demo mode, plus
  any other hardware or resources that might be needed to review your app (e.g. login credentials
  or a sample QR code)." [verified 2026-10-16]
- **2.1(b):** in-app purchases must be visible and functional. Not applicable in v1 (no purchases).
  [verified 2026-10-16]

What App Review needs from Questify:

1. **A reviewer account that does not need a real SMS.** Apple reviewers cannot receive an OTP sent
   to a number you give them. Allow-list one reviewer phone number with a fixed code on the server
   (or provide an email login for that account). Treat this as a security hole to contain: one
   number, scoped to the demo tenant only, rate-limited, logged, and covered by an outsider test
   that proves the code works for no other number.
2. **A permanent demo event** ("App Review Demo", always live, no end date) in its own demo tenant,
   containing every quest type the binary supports: QR scan, challenge, photo submission, text
   submission, vote, quiz, and a location quest with its non-location alternative. Seed a
   leaderboard with fictional players and a prize catalogue the reviewer can redeem.
3. **A sample QR code** attached to the review notes as an image (and printable), plus the event
   join code.
4. **Review notes** that walk through join → quest → points → leaderboard → redeem → report/block
   → delete account, and that list every feature behind a flag (see 1.5).
5. **Staff or organizer mode**, if the mobile app has one, needs its own demo credentials.
6. Backend, SMS provider, push and image moderation all live during review.

### 1.4 Guideline 2.3 — Metadata and screenshots

| Rule | What it means for Questify | Status |
|---|---|---|
| 2.3 metadata, including privacy information, description, screenshots and previews, must "accurately reflect the app's core experience". | Describe Questify as a platform: the attendee joins an organizer's event. | [verified 2026-10-16] |
| 2.3.1(a) "Don't include any hidden, dormant, or undocumented features ... All new features, functionality, and product changes must be described with specificity in the Notes for Review section ... (generic descriptions will be rejected)". | Drives the feature-flag rule in 1.5 and PD-02. | [verified 2026-10-16] |
| 2.3.3 Screenshots "should show the app in use, and not merely the title art, login page, or splash screen." | Show quests, leaderboard, prize store, in Arabic and English sets. | [verified 2026-10-16] |
| 2.3.5 pick the most appropriate category. | A non-game category (see PD-15). | [verified 2026-10-16] |
| 2.3.6 answer the age rating questions honestly. | See 1.14. | [verified 2026-10-16] |
| 2.3.7 unique name, 30 characters max, no keyword stuffing with trademarks or popular app names, no prices in names/subtitles. | Check "Questify" availability (Q-021). | [verified 2026-10-16] |
| 2.3.8 icons, screenshots and previews must suit a 4+ audience; "For Kids" / "For Children" are reserved for the Kids Category; app name and icons (including alternate icons) should be similar "to avoid creating confusion". | Do not swap the app icon to organizer logos. | [verified 2026-10-16] |
| 2.3.9 secure rights to everything in icons/screenshots; "display fictional account information instead of data from a real person". | Screenshots use a fictional organizer brand and fictional players, never a real client's logo without written permission. | [verified 2026-10-16] |
| 2.3.10 no names, icons or imagery of other mobile platforms. | No Android devices or Google Play badges in iOS screenshots. | [verified 2026-10-16] |
| 2.3.12 "What's New" must list significant changes. | Release notes per version. | [verified 2026-10-16] |
| 2.3.13 In-app events shown on the App Store must be real, timed events with a working deep link. | Optional marketing tool later. | [verified 2026-10-16] |

### 1.5 Guideline 2.5.2 — Downloaded code, remote config, server-driven UI, OTA updates

The rules:

- **2.5.2:** "Apps should be self-contained in their bundles, and may not read or write data
  outside the designated container area, nor may they download, install, or execute code which
  introduces or changes features or functionality of the app, including other apps."
  [verified 2026-10-16]
- **Apple Developer Program License Agreement, section 3.3, "B. Executable Code":** "an Application
  may not download or install executable code. Interpreted code may be downloaded to an
  Application but only so long as such code: (a) does not change the primary purpose of the
  Application by providing features or functionality that are inconsistent with the intended and
  advertised purpose of the Application (b) does not bypass signing, sandbox, or other security
  features of the OS; and (c) for Applications distributed on the App Store, does not create a store
  or storefront for other Applications."
  https://developer.apple.com/support/terms/apple-developer-program-license-agreement/
  [verified 2026-10-16]
- **2.3.1(a):** no hidden, dormant or undocumented features (quoted in 1.4). [verified 2026-10-16]
- **4.7:** HTML5/JavaScript mini apps and mini games not embedded in the binary are allowed, but
  the developer is responsible for them; they must follow 5.1 privacy, include filtering, reporting
  and blocking, follow 3.1 for digital goods, must not get native APIs without permission (4.7.2),
  need an index with universal links (4.7.4), and need age restriction for content above the app's
  rating (4.7.5). [verified 2026-10-16]
- **4.2.3(ii):** "If your app needs to download additional resources in order to function on initial
  launch, disclose the size of the download and prompt users before doing so." [verified
  2026-10-16]
- **Expo's own position:** EAS Update updates JavaScript, styling and images only; native code and
  permission changes need a store build; "your updates need to follow the App Store and Play Store
  guidelines ... This usually means changes to your app's behavior need to be reviewed."
  https://docs.expo.dev/eas-update/introduction/ [verified 2026-10-16]

What each mechanism may do (interpretation of the verified rules above):

| Mechanism | Allowed | Conditions / limits |
|---|---|---|
| Remote config values: currency name, colors, logos, copy, translations, point values, quest content, schedules, prize catalogue | Yes. This is data. | Content shown in the app must meet the guidelines (organizer content is Questify's responsibility). Large first-launch downloads need a size prompt (4.2.3(ii)). |
| Feature flag that turns a reviewed feature on or off for an event | Yes | The feature exists in the binary, was reachable in the demo event during review, and is listed in Notes for Review. Kill switches (turning things off) are always fine. |
| Feature flag that reveals a feature the reviewer never saw | No | 2.3.1(a) "dormant features". Grounds for removal and account termination under 2.3.1. |
| Server-driven UI: server sends layouts that the app renders from native components compiled into the binary | Yes, if the components and behaviours were in the reviewed binary | A layout is data. A new behaviour (a new quest mechanic) needs code, so it needs a store release. Not a named Apple rule: interpretation. |
| OTA JavaScript update (EAS Update or similar) | Yes, for fixes and modest changes | Interpreted code under DPLA 3.3: must not change the primary purpose or bypass security, and per 2.5.2 should not introduce new features. Use for bug fixes, copy, styling, layout tweaks. New features, new quest types and anything needing a new permission go through review. |
| Remote HTML5/JS mini-games or challenges in a WebView | Allowed under 4.7, with obligations | Avoid in v1. If added later: WebKit only (2.5.6), filtering/report/block, privacy, index with universal links, age gating. |
| Downloading native code, plug-ins, dynamic frameworks | Never | 2.5.2 and DPLA 3.3. |
| Turning on a capability that changes the age rating or privacy label (chat, social feed, location, ads, analytics SDK) | Only after updating App Store Connect | Privacy answers can be updated without an app update (see 1.13). Age-rating changes per version: [NOT verified — check]. |

Flutter note: Flutter ships Dart compiled ahead of time, so "OTA" in Flutter means a third-party
code-push product. Its compliance claim was not researched. [NOT verified — check in Stage 6]

### 1.6 Guideline 3.1 — In-app purchase: when it applies and when it does not

Rules [all verified 2026-10-16]:

- **3.1.1:** "If you want to unlock features or functionality within your app, (by way of example:
  subscriptions, in-game currencies, game levels, access to premium content, or unlocking a full
  version), you must use in-app purchase. Apps may not use their own mechanisms to unlock content
  or functionality, such as license keys, augmented reality markers, QR codes, cryptocurrencies".
- **3.1.1:** "Any credits or in-game currencies purchased via in-app purchase may not expire".
- **3.1.1:** "Digital gift cards, certificates, vouchers, and coupons which can be redeemed for
  digital goods or services can only be sold in your app using in-app purchase. Physical gift cards
  that are sold within an app and then mailed to customers may use payment methods other than
  in-app purchase."
- **3.1.1(a) / 3.1.3:** outside the United States storefront, apps "may not include buttons,
  external links, or other calls to action that direct customers to purchasing mechanisms other
  than in-app purchase".
- **3.1.3(b) Multiplatform:** items bought elsewhere may be used in the app "provided those items
  are also available as in-app purchases within the app".
- **3.1.3(c) Enterprise:** apps "only sold directly by you to organizations or groups for their
  employees or students" may unlock previously purchased content; "Consumer, single user, or family
  sales must use in-app purchase."
- **3.1.3(e):** physical goods or services "consumed outside of the app" must use non-IAP payment.
- **3.1.3(f):** "Free apps acting as a stand-alone companion to a paid web based tool ... do not
  need to use in-app purchase, provided there is no purchasing inside the app, or calls to action
  for purchase outside of the app."
- **3.1.3(g):** buying "boosts" or ads displayed in the same app must use in-app purchase.
- **3.2.2(x):** apps "must not force users to rate the app, review the app ... Apps may otherwise
  incentivize users to take specific actions within apps".
- **5.6.1:** use Apple's API to ask for ratings; custom review prompts are disallowed.

| Scenario | IAP required? | Why |
|---|---|---|
| v1: attendees earn points by playing; nothing is sold | No | No purchase exists (ADR-002). |
| QR code scanned at a booth to earn points | No | It records a check-in; it does not unlock paid functionality. Never let a code unlock a paid tier (3.1.1). |
| Selling points, boosts, extra attempts, cosmetic items to attendees | Yes | 3.1.1 in-game currency. Purchased points may not expire. Also collides with prize rules (1.12, 2.10). Do not do it. |
| Prizes: t-shirts, gift cards, subscriptions given for points | No | Nothing is sold. |
| Organizer pays Questify on the web dashboard (contract, invoice, card) | No | Outside the app. The attendee app must have no purchase UI and no "upgrade" links (3.1.3(f), 3.1.1(a)). |
| Organizer buys or upgrades a plan inside the mobile app (staff/organizer mode) | Yes, assume so | It unlocks digital functionality (3.1.1). 3.1.3(c) covers only sales "directly by you to organizations ... for their employees or students", which is a weak fit for event audiences. |
| Attendee pays for a physical event ticket in the app | No IAP; use Apple Pay/card | 3.1.3(e) service consumed outside the app. |
| Sponsor pays to be featured inside the app | IAP if bought in the app; B2B contract outside the app is a sales deal | 3.1.3(g). Interpretation for the off-app contract. |
| "Rate us 5 stars for 50 points" | Forbidden | 3.2.2(x), 5.6.1, 5.6.3. |

### 1.7 Guideline 4.2 — Minimum functionality

"Your app should include features, content, and UI that elevate it beyond a repackaged website."
4.2.2: apps "shouldn't primarily be marketing materials, advertisements, web clippings, content
aggregators, or a collection of links." 4.2.3(i): the app must work without installing another
app. [verified 2026-10-16]

For Questify: native camera QR scanning, live leaderboards, push, photo submission and a prize
store clear this bar. Two risks: (1) an app that is empty until you have an event code; the demo
event (1.3) and a short "how it works" screen solve it; (2) wrapping the web dashboard in a
WebView for organizers would be a "repackaged website".

### 1.8 Guidelines 4.2.6 and 4.3 — Template and white-label apps

- **4.2.6:** "Apps created from a commercialized template or app generation service will be rejected
  unless they are submitted directly by the provider of the app's content. These services should
  not submit apps on behalf of their clients and should offer tools that let their clients create
  customized, innovative apps that provide unique customer experiences. Another acceptable option
  for template providers is to create a single binary to host all client content in an aggregated
  or 'picker' model, for example as a restaurant finder app with separate customized entries or
  pages for each client restaurant, or as an event app with separate entries for each client
  event." [verified 2026-10-16]
- **4.3(a):** "Don't create multiple Bundle IDs of the same app ... consider submitting a single app
  and providing the variations using in-app purchase." [verified 2026-10-16]
- **4.1(c):** "You cannot use another developer's icon, brand, or product name in your app's icon or
  name, without approval". **5.2.1:** don't use protected third-party material (trademarks)
  without permission. [verified 2026-10-16]

What this means:

| Model | Verdict |
|---|---|
| **A. One "Questify" app; each event wears its organizer's brand after the attendee joins** (logo, colors, currency name, copy, banner, sponsor tiles) | The model Apple names as acceptable. v1. |
| **B. A separate branded store app per client, submitted by Questify** | Rejected under 4.2.6 ("should not submit apps on behalf of their clients") and at risk under 4.3(a). Google has the same rule (2.14). |
| **C. A branded app submitted by the client from the client's own developer account** | Allowed by 4.2.6 ("submitted directly by the provider of the app's content"). A later enterprise offer; each app needs its own review, demo, privacy labels and listing. |

In-app theming limits: keep the Questify app icon and name fixed (2.3.8 similarity, 4.1(c)).
Organizer logos inside the app need a licence from the organizer (Organizer Terms, section 4).

### 1.9 Guideline 4.8 — Login services / Sign in with Apple

Apps that use "a third-party or social login service (such as Facebook Login, Google Sign-In ...)
to set up or authenticate the user's primary account" must also offer an equivalent login that
limits data to name and email, lets users keep their email private, and does not collect
interactions for advertising without consent. Not required if "Your app exclusively uses your
company's own account setup and sign-in systems." [verified 2026-10-16]

- Phone number + SMS OTP and/or email + code is Questify's own account system, so Sign in with
  Apple is **not** required.
- Adding Google Sign-In later means also offering Sign in with Apple (it meets the three tests).
- If Sign in with Apple is offered, account deletion must revoke its tokens through the Sign in
  with Apple REST API.
  https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion/
  [verified 2026-10-16]

### 1.10 Guideline 5.1.1 — Privacy, account deletion, permission purpose strings

Rules [verified 2026-10-16 unless marked]:

- **5.1.1(i):** privacy policy linked in App Store Connect and "within the app in an easily
  accessible manner". It must say what data is collected, how, and all uses; confirm third parties
  (analytics, SDKs, related entities) give equal protection; and explain retention/deletion and how
  to revoke consent or request deletion.
- **5.1.1(ii):** get consent for collecting user or usage data; give an easy way to withdraw
  consent; "Ensure your purpose strings clearly and completely describe your use of the data."
- **5.1.1(iii):** request only data relevant to core functionality; "Where possible, use the
  out-of-process picker or a share sheet rather than requesting full access to protected resources
  like Photos".
- **5.1.1(iv):** don't trick or force consent; "if a user declines to share Location, offer the
  ability to manually enter an address."
- **5.1.1(v):** "If your app supports account creation, you must also offer account deletion within
  the app." If the app has no significant account-based features, allow use without login.
- **5.1.1(ix):** apps in regulated fields "such as ... gambling" must be submitted by a legal
  entity, not an individual.
- **5.1.1(x):** basic contact info may be requested if optional and features don't depend on it.
- **5.1.4:** apps that can collect personal information from a minor must have a privacy policy and
  follow children's privacy laws; apps may ask for birthdate "only for the purpose of complying with
  these statutes".
- **5.1.5:** "notify and obtain consent before collecting, transmitting, or using location data"
  and explain the purpose in the app.
- **2.5.14:** explicit consent and a clear indicator when recording user activity, "This includes
  any use of the device camera".
- **Account deletion guidance:** users must be able to "initiate deletion of their account within
  the app"; deletion removes the account "along with any data associated with the account that the
  developer isn't legally required to maintain".
  https://developer.apple.com/support/offering-account-deletion-in-your-app/

Purpose strings (Info.plist). An app that touches a protected resource without its usage
description exits, and App Review rejects it.
https://developer.apple.com/library/archive/qa/qa1937/_index.html [verified 2026-10-16]

| Key | Needed when | Draft text (EN / AR) |
|---|---|---|
| `NSCameraUsageDescription` | QR scanning and photo quests | "Questify uses the camera to scan event QR codes and to take photos you choose to submit for quests." / "يستخدم Questify الكاميرا لمسح رموز QR في الفعالية ولالتقاط الصور التي تختار إرسالها في المهام." |
| `NSLocationWhenInUseUsageDescription` | Only if location quests ship | "Questify checks your location only when you start a location quest, to confirm you are at the event spot. You can use the QR option instead." / "يتحقق Questify من موقعك فقط عند بدء مهمة موقع، للتأكد من وجودك في مكان الفعالية. يمكنك استخدام رمز QR بدلاً من ذلك." (key name: [NOT verified — check]) |
| `NSPhotoLibraryUsageDescription` | Not needed if the system photo picker (PHPicker) is used | PHPicker gives selected photos without library access (WWDC20 "Handle the Limited Photos Library", https://developer.apple.com/videos/play/wwdc2020/10641/) [verified 2026-10-16] |
| `NSPhotoLibraryAddUsageDescription` | Only if the app saves images (e.g., a badge) to Photos | [NOT verified — check] |

Arabic strings must go through the `ux-araby` skill before release.

### 1.11 Guideline 5.1.2 — Data use and sharing

- **5.1.2(i):** "you may not use, transmit, or share someone's personal data without first
  obtaining their permission ... You must clearly disclose where personal data will be shared with
  third parties, including with third-party AI, and obtain explicit permission before doing so."
  Tracking needs App Tracking Transparency. "Your app may not require users to enable system
  functionalities (e.g. push notifications, location services, tracking) in order to access
  functionality, content, use the app, or receive monetary or other compensation, including but not
  limited to gift cards and codes." [verified 2026-10-16]
- **5.1.2(ii):** data collected for one purpose may not be repurposed without further consent.
  [verified 2026-10-16]
- **5.1.2(vi):** data from camera or photo APIs (depth/facial mapping) may not be used for
  marketing or data mining. [verified 2026-10-16]

What this means for Questify:

- **The organizer is a third party.** When an attendee joins an event, show who receives what:
  "Your display name, points, quest answers and submissions are shared with [Organizer]." Consent
  is part of joining.
- **AI moderation is third-party AI.** If photos or text go to an external AI moderation service,
  disclose it at the point of submission and get explicit permission, or run moderation in-house.
- **Push and location can never be required** to play, to earn redeemable points, or to redeem.
  No points for enabling notifications. Every location quest has a QR or staff-check alternative.
- No ads and no tracking SDKs in v1, so no ATT prompt. Adding either changes labels and ratings.

### 1.12 Guideline 5.3 — Contests, sweepstakes and prizes

- **5.3:** "Only include this functionality if you've fully vetted your legal obligations everywhere
  you make your app available and are prepared for extra time during the review process."
- **5.3.1:** "Sweepstakes and contests must be sponsored by the developer of the app."
- **5.3.2:** "Official rules for sweepstakes, contests, and raffles must be presented in the app and
  make clear that Apple is not a sponsor or involved in the activity in any manner."
- **5.3.3:** no IAP credit or currency for use with real money gaming.
- **5.3.4:** real money gaming or lotteries need licences where used, geo-restriction, and a free
  app. "Lottery apps must have consideration, chance, and a prize."
[all verified 2026-10-16]

Analysis (interpretation):

- A leaderboard where the top players win prizes is a **contest**. A random draw is a
  **sweepstakes/raffle**. A fixed-price points store ("300 points = t-shirt") is a redemption
  catalogue, which is the least contest-like design.
- **5.3.1 and multi-tenancy:** the organizer funds the prizes, but Apple wants the developer as
  sponsor. Official rules should name Questify (the developer entity) as sponsor/administrator of
  the contest mechanics and the organizer as prize provider, with the organizer bound by contract
  to deliver. How App Review treats organizer-funded contests on a platform is not documented.
  [NOT verified — check; see Open Questions]
- **Consideration:** if attendees spend points that have real-world value to enter a draw, the
  draw has consideration, chance and a prize. Apple's age rating defines Gambling as "Betting or
  wagering using real money or in-game currency that may be exchanged for real money", listing
  "lotteries and raffles" (section 1.14). That path leads to 18+, 5.1.1(ix) and 5.3.4 licensing.
  Points are never spent on draw entries.

### 1.13 Privacy nutrition labels, privacy manifest, required-reason APIs, SDK signatures

| Rule | Source | Status |
|---|---|---|
| Privacy details are "required to submit new apps and app updates"; they cover your data practices and those of third-party partners whose code is in the app; you may update answers "at any time, and you do not need to submit an app update". | https://developer.apple.com/app-store/app-privacy-details/ | [verified 2026-10-16] |
| Privacy Policy URL required for all apps; User Privacy Choices URL optional. | https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/ | [verified 2026-10-16] |
| "Tracking" = linking app data with third-party data for targeted ads or ad measurement, or sharing with a data broker. | app-privacy-details page above | [verified 2026-10-16] |
| Since May 1, 2024, apps must declare approved reasons for listed "required reason" APIs used by the app's code, including third-party SDKs, in the privacy manifest, or the upload fails. | https://developer.apple.com/news/upcoming-requirements/ and https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api | [verified 2026-10-16] |
| For SDKs on Apple's list of commonly used third-party SDKs, the SDK's privacy manifest is required when it is added; signatures are required when it is a binary dependency. | https://developer.apple.com/support/third-party-SDK-requirements | [verified 2026-10-16] |
| Xcode Organizer → archive → "Generate Privacy Report" aggregates all manifests into a PDF that maps to the nutrition label. | https://developer.apple.com/videos/play/wwdc2023/10060/ | [verified 2026-10-16] |
| React Native / Expo and Flutter ship privacy manifests for their own code in current versions. | context7 at Stage 6 | [NOT verified — check] |

Likely Questify label (planning estimate, to be confirmed against the final SDK list):

| Data type | Linked to user | Purpose |
|---|---|---|
| Contact Info: phone number, email, name/display name | Yes | App functionality |
| User Content: photos, text submissions, quiz answers, votes | Yes | App functionality |
| Identifiers: user ID; push token | Yes | App functionality |
| Location: coarse or precise (only if location quests ship) | Yes | App functionality |
| Usage Data: product interaction (analytics) | Yes or No, depends on SDK | Analytics |
| Diagnostics: crash data, performance | Usually No | App functionality |
| Tracking | None in v1 | — |

Workflow without a Mac: cloud builds upload the binary; borrow the Mac once per release that adds
or upgrades an SDK to run "Generate Privacy Report" on the archive.

### 1.14 Age rating — the current questionnaire

| Rule | Source | Status |
|---|---|---|
| Ratings are 4+, 9+, 13+, 16+, 18+ (13+, 16+, 18+ added in 2025); may vary by region. New required questions cover in-app controls, capabilities, medical/wellness and violent themes. A higher rating can be set to match a minimum-age policy. | https://developer.apple.com/news/?id=ks775ehf | [verified 2026-10-16] |
| Responses to the updated questions were required by January 31, 2026, to submit updates. | https://developer.apple.com/news/upcoming-requirements/ | [verified 2026-10-16] |
| New social media questions: "beginning in September 2026, responses will be required when submitting new apps or updates". Social media = "the ability to redistribute, amplify, or interact with user-generated content through a social feed or similar discovery method". | https://developer.apple.com/news/ ("Age rating questionnaire now includes social media questions") | [verified 2026-10-16] |
| Descriptor definitions: User-Generated Content and Messaging are compatible with 4+; **Social Media → 13+**; **Frequent contests → 13+**; Infrequent contests → 4+; **Gambling (includes "lotteries and raffles") → 18+**; Unrestricted web access → 16+. | https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/ | [verified 2026-10-16] |
| In regions where legally required, apps must check age with the Declared Age Range API; developers are responsible for their own age restrictions. Build with Xcode 26.2 / iOS 26.2 SDK or later for the full set. | https://developer.apple.com/support/age-assurance/ | [verified 2026-10-16] |

Expected Questify rating: **13+** (frequent contests: leaderboards and quizzes at every event; a
public submissions gallery with votes is probably "social media"). Answer the in-app controls
questions truthfully (age gate, moderation). If raffles were added with points as entry: 18+.

### 1.15 Export compliance / encryption

- If the app uses, contains or incorporates encryption, export compliance must be answered in App
  Store Connect. Categories include standard algorithms, "Crypto functionality within Apple's
  operating system", and proprietary algorithms. Determining exemption is the developer's
  responsibility; France also controls encryption apps.
  https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/
  [verified 2026-10-16]
- Set `ITSAppUsesNonExemptEncryption` to `NO` in Info.plist when the app "either uses no
  encryption, or only uses encryption that's exempt"; otherwise the questionnaire appears on every
  upload. `YES` needs documentation and an `ITSEncryptionExportComplianceCode`.
  https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption
  [verified 2026-10-16]
- Questify uses HTTPS/TLS through the OS only, which is commonly treated as exempt. Confirm when
  answering the questionnaire the first time. [NOT verified — check that no SDK adds non-exempt
  crypto]

### 1.16 EU Digital Services Act trader status

- Apple must verify and display trader contact details (address, phone, email) for traders in the
  EU. "Even if you don't distribute apps in the EU, you'll still need to declare a trader status."
  Organizations: the D-U-N-S address displays automatically. Traders verify email and phone with
  two-factor codes and upload a document proving business name and address. Non-traders: EU users
  are told consumer protection rights don't apply.
  https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/
  [verified 2026-10-16]
- Since February 17, 2025, apps without trader status were removed from the EU storefronts.
  https://developer.apple.com/news/upcoming-requirements/ [verified 2026-10-16]

Questify is a business and will be a trader. Its business address, phone and email become public
on EU product pages. With an individual account that would be Dhia's personal details.

### 1.17 TestFlight

- Internal testers: up to 100 App Store Connect users. External testers: up to 10,000 per app, by
  email or public link (with optional tester limit). The first build added to an external group
  goes to TestFlight App Review; later builds may not need a full review. Up to six builds per
  24 hours for TestFlight review. Builds expire after 90 days. A beta description and beta review
  information are required for external testing.
  https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/ and
  https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/
  [verified 2026-10-16]
- **2.2:** TestFlight builds must be intended for public release and follow the guidelines; testers
  may not be paid or rewarded for testing. [verified 2026-10-16]

No Mac needed: a cloud build uploads to App Store Connect, testers install from the TestFlight app.
Use TestFlight external review as a dress rehearsal: it uses the same guidelines.

### 1.18 Build requirements

- Since April 28, 2026, uploads must be built with Xcode 26 or later using the iOS 26 SDK.
- Since September 9, 2026, iOS apps must target iOS 13 or later.
  https://developer.apple.com/news/upcoming-requirements/ [verified 2026-10-16]
- The cloud build service chosen in Stage 6 must run Xcode 26.x (26.2+ for the age-assurance APIs).

### 1.19 Other Apple rules that touch Questify

| Rule | Status |
|---|---|
| 4.5.4 Push "must not be required for the app to function", must not carry sensitive personal data, and promotions need explicit opt-in "via consent language displayed in your app's UI" plus an in-app opt-out. | [verified 2026-10-16] |
| 4.5.3 no spam through push. | [verified 2026-10-16] |
| 2.4.1 "iPhone apps should run on iPad whenever possible." Reviewers may test on iPad: layouts must not break there. | [verified 2026-10-16] |
| 2.5.5 Apps "must be fully functional on IPv6-only networks." | [verified 2026-10-16] |
| 2.5.4 Background services only for their intended purposes (location, audio, etc.). Questify needs no background location. | [verified 2026-10-16] |
| 4.10 May not monetize built-in capabilities (push, camera). | [verified 2026-10-16] |
| 5.6.2 Developer identity information must be truthful and current. | [verified 2026-10-16] |

---

## 2. Google Play

### 2.1 Personal vs organization accounts; D-U-N-S

| Rule | Source | Status |
|---|---|---|
| Personal and organization accounts "have access to the same functionality". Choose organization "if you're engaged in commercial, industrial, professional, or governmental activities". Organization is expected for financial, health, VPN and government apps. | https://support.google.com/googleplay/android-developer/answer/13634885?hl=en | [verified 2026-10-16] |
| Organization accounts must have a D-U-N-S number (free from Dun & Bradstreet). "This process can take up to 30 days". The legal name and address in the Google payments profile must match the D&B profile. | https://support.google.com/googleplay/android-developer/answer/13628312?hl=en | [verified 2026-10-16] |
| Organizations must show a verified developer email **and phone number** on Google Play; the contact email should not be generic or personal. Personal accounts must verify a developer email. | same | [verified 2026-10-16] |
| Identity verification: organizations upload organization registration documents and an authorized representative's government photo ID; documents must match the payments profile exactly. | https://support.google.com/googleplay/android-developer/answer/15633622 | [verified 2026-10-16] |
| Account creation fee USD 25. | https://developer.android.com/static/developer-verification/guides/pdf-guides/adc-guide.pdf | [verified 2026-10-16] |

### 2.2 Closed-testing requirement for new personal accounts

"Developers with personal accounts created after November 13, 2023, must run a closed test for
their app with a minimum of **12 testers** who have been opted in continuously for at least
**14 days**." Then apply for production access and answer questions about the test. Testers who
opt out before 14 days don't count; re-opting in restarts their 14 consecutive days. Too few
testers or low engagement can mean more testing is required. Production and pre-registration stay
disabled until then.
https://support.google.com/googleplay/android-developer/answer/14151465?hl=en
[verified 2026-10-16]

An organization account is not subject to this rule (the rule names personal accounts only).
With a personal account, budget three or more weeks before the first public Android release.

### 2.3 Android developer verification (new in 2026)

- Every Play app package must be registered to a verified developer. "Effective September 30, 2026,
  all Play packages must be registered ... Apps not registered by Sep 30, 2026 will be removed from
  Play". Google auto-registers most Play apps; check the Play Console home page.
  https://support.google.com/googleplay/android-developer/answer/16984799?hl=en
  [verified 2026-10-16]
- Enforcement for installs on certified devices started September 30, 2026 in Brazil, Indonesia,
  Singapore and Thailand and expands globally in 2027.
  https://developer.android.com/developer-verification/guides [verified 2026-10-16]

For Questify: complete identity verification at account creation; confirm the package name is
registered right after the first upload.

### 2.4 Data safety form

- All developers must declare how they collect, share and protect user data, including data
  handled by third-party SDKs. "Collect" means sending data off the device. Encryption in transit
  can be declared only if it applies to all user data the app and its SDKs send. The form includes
  deletion questions. Google reviews it.
  https://support.google.com/googleplay/android-developer/answer/10787469 [verified 2026-10-16]
- The Data safety section must be "consistent with the disclosures made in the app's privacy
  policy". https://support.google.com/googleplay/android-developer/answer/10144311?hl=en
  [verified 2026-10-16]

Fill it from the same data inventory as the Apple label (1.13) so the two never disagree.

### 2.5 Account deletion (in-app path plus web link)

- If the app lets users create an account, it must provide "an in-app path to delete their app
  accounts and associated data" **and** "a web link resource where users can request app account
  deletion". The web resource must work without reinstalling the app, load without error,
  feature the deletion path prominently, and name the app or developer as on the listing.
  Associated data must be deleted; data kept for security, fraud prevention or legal reasons must
  be explained (e.g., in the privacy policy). Phone OTP accounts are app accounts.
  https://support.google.com/googleplay/android-developer/answer/13327111?hl=en
  [verified 2026-10-16]
- "you must delete all associated user data upon receiving an account deletion request, rather
  than merely freezing the account."
  https://support.google.com/googleplay/android-developer/answer/10144311?hl=en
  [verified 2026-10-16]

### 2.6 Target API level

"Starting August 31 2026: New apps and app updates must target Android 16 (API level 36) or
higher". An extension to November 1, 2026 exists only for existing apps.
https://developer.android.com/google/play/requirements/target-sdk and
https://support.google.com/googleplay/android-developer/answer/11926878 [verified 2026-10-16]

Questify is a new app: it must target API 36 from the first upload. The framework version chosen
in Stage 6 must support it. After upload, confirm the target in Play Console's App bundle explorer.

### 2.7 Permissions: camera, location, photos and videos, SMS

| Permission | Rule | Source | Status |
|---|---|---|---|
| Camera | Camera sensor data is personal and sensitive user data; follow the User Data policy (disclosure and consent when the use isn't obvious; don't request before consent where disclosure is required). | https://support.google.com/googleplay/android-developer/answer/10144311?hl=en | [verified 2026-10-16] |
| Location | Request "the minimum scope necessary (for example, coarse instead of fine, and foreground instead of background)"; never "for the sole purpose of advertising or analytics"; stop accessing it when no longer needed. Background location needs core-feature justification, a prominent in-app disclosure before the runtime prompt, a video and a declaration form. | https://support.google.com/googleplay/android-developer/answer/16558241?hl=en and https://support.google.com/googleplay/android-developer/answer/9799150 | [verified 2026-10-16] |
| Photos and videos | Only apps with a core need for broad access may keep `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO`. One-time or infrequent use (e.g., uploading a picture) must use a system picker such as the Android photo picker; a custom picker does not qualify for broad access. Remove the permissions from the manifest. | https://support.google.com/googleplay/android-developer/answer/14115180?hl=en | [verified 2026-10-16] |
| SMS (OTP) | Use the SMS Retriever API (automatic, no permission) or manual code entry; do not request SMS permissions for verification. | https://support.google.com/googleplay/android-developer/answer/10208820?hl=en and https://developer.android.com/identity/sms-retriever | [verified 2026-10-16] |
| Foreground services | Apps targeting Android 14+ must declare each foreground service type and justify it in Play Console. Questify should need none. | https://support.google.com/googleplay/android-developer/answer/9888379?hl=en | [verified 2026-10-16] |
| Notifications (`POST_NOTIFICATIONS` runtime prompt on Android 13+) | Ask in context, not at launch. | — | [NOT verified — check] |

Watch transitive permissions: an image or camera library may add `READ_MEDIA_IMAGES` to the merged
manifest. Inspect the merged manifest of every release build.

### 2.8 User-generated content policy

UGC apps "must implement robust, effective, and ongoing UGC moderation that":

- "Requires users accept the app's terms of use and/or user policy before users can create or
  upload UGC";
- "Defines objectionable content and behaviors ... and prohibits them in the app's terms of use or
  user policies";
- provides "an in-app system for reporting and blocking objectionable UGC and users", and acts on
  reports (apps with publicly accessible UGC must have report users, report content and block
  users);
- "Provides safeguards to prevent in-app monetization from encouraging objectionable user
  behavior."

Apps "that continually fail to address user complaints about objectionable content" violate the
policy. https://support.google.com/googleplay/android-developer/answer/9876937?hl=en
[verified 2026-10-16]

Questify note: points and prizes for submissions are an incentive, so "monetization" safeguards
apply. Points for a submission are confirmed only after it passes moderation and are revoked if it
is later removed.

### 2.9 Real-money gambling, games and contests

- Without a gambling licence and Google approval, apps may not let users "wager, stake, or
  participate using real money (including in-app items purchased with money) to obtain a prize of
  real world monetary value". Examples of violations include "Games that accept money in exchange
  for an opportunity to win a physical or monetary prize".
- **Gamified loyalty programs** are allowed where lawful. For non-game apps, chance-based rewards
  are allowed if the app publishes official rules in the app, discloses odds or the selection
  method, and states "a fixed number of winners, fixed entry deadline, and prize award date, per
  promotion". Fixed earning/redemption ratios must be shown "conspicuously in the app and also
  within the official terms". **Game apps may not use chance-based loyalty rewards.** (These
  loyalty rules are framed around a "qualifying monetary transaction"; Questify has none.)
https://support.google.com/googleplay/android-developer/answer/9877032?hl=en
[verified 2026-10-16]

For Questify: free participation and no purchasable points keep the app outside the prohibition.
The loyalty-program rules are still the best template for prize rules (official rules in app,
fixed ratio, fixed winners/deadline/award date). Listing the app as a Game would forbid any
chance element, which is one more reason for a non-game category.

### 2.10 Families policy, in case minors attend

- Every app declares a target age group in "Target audience and content". Any app whose target
  audience includes children must meet the Families policy. Google may review the declared audience
  against the app's imagery and terminology.
- Families requirements include: child-appropriate content; accurate Play Console answers; no
  AAID/SIM serial/IMEI etc. from children or users of unknown age in mixed-audience apps; only SDKs
  approved for child-directed services (or behind a neutral age screen); social features need an
  in-app safety reminder and adult controls; COPPA/GDPR compliance; certified ads SDKs only.
  https://support.google.com/googleplay/android-developer/answer/9893335?hl=en [verified 2026-10-16]
- "if your app targets any users who are under the age of 21, you must consider if they would be
  considered children under their local laws." A listing with youthful animation or young
  characters can be rejected unless the target changes to children.
  https://support.google.com/googleplay/android-developer/answer/9867159?hl=en [verified 2026-10-16]

For Questify: declare a 13+ (or 18+) audience, not children. The 3D icon style must not read as a
kids' app in the store listing. School events with under-13s are out of scope until a Families
review is done.

### 2.11 App content declarations (Policy → App content)

| Declaration | Questify answer (planned) | Status |
|---|---|---|
| Privacy policy URL | Required; also linked in the app | [verified 2026-10-16] |
| Ads | "No" in v1 | [verified 2026-10-16] |
| Sign-in details | Required: the reviewer phone number + fixed code, with the OTP explained in "Any other instructions"; up to five instruction sets (add organizer/staff mode) | [verified 2026-10-16] |
| Target audience and content | 13+ or 18+ (see 2.10) | [verified 2026-10-16] |
| Data safety | See 2.4 | [verified 2026-10-16] |
| Content rating (IARC questionnaire) | Required; "Unrated" apps may be removed. Declare user interaction, shared location (if used), UGC. | [verified 2026-10-16] |
| Permissions declaration form | Only if a sensitive permission is used; Questify should need none | [verified 2026-10-16] |
| News app | No | [verified 2026-10-16] |
| Government apps, financial features, health apps declarations | No | [NOT verified — check the current list in Play Console] |
Source: https://support.google.com/googleplay/android-developer/answer/9859455?hl=en

### 2.12 Remote code and OTA on Android

"An app distributed via Google Play may not modify, replace, or update itself using any method
other than Google Play's update mechanism. Likewise, an app may not download executable code (such
as dex, JAR, .so files) from a source other than Google Play. This restriction does not apply to
code that runs in a virtual machine or an interpreter where either provides indirect access to
Android APIs (such as JavaScript in a webview or browser). Apps or third-party code, like SDKs, with
interpreted languages (JavaScript, Python, Lua, etc.) loaded at run time ... must not allow
potential violations of Google Play policies."
https://support.google.com/googleplay/android-developer/answer/9888379?hl=en [verified 2026-10-16]

A JavaScript OTA update is within the interpreter exception. Apple's limits (1.5) are stricter, so
one rule set for both: OTA for fixes, store releases for features.

### 2.13 Spam and repetitive content

- "Creating multiple apps with highly similar functionality, content, and user experience. If
  these apps are each small in content volume, developers should consider creating a single app
  that aggregates all the content." (Repetitive Content)
- "We don't allow apps that send SMS, email, or other messages on behalf of the user without giving
  the user the ability to confirm the content and intended recipients." (Message Spam)
https://support.google.com/googleplay/android-developer/answer/9899034?hl=en [verified 2026-10-16]

Per-client branded Play apps carry the same risk as on Apple. An "invite friends" feature must use
the system share sheet, or show the exact message and recipients before sending.

### 2.14 EU trader status on Google Play

Google Play also collects a DSA trader declaration in Play Console. [NOT verified — check]

---

## 3. Saudi Arabia

### 3.1 PDPL essentials for a consumer app

Sources: Law https://sdaia.gov.sa/en/SDAIA/about/Documents/PersonalDataProtectionLaw.pdf ;
Implementing Regulation (IR) https://sdaia.gov.sa/en/SDAIA/about/Documents/ImplementingRegulation.pdf ;
SDAIA regulations index https://sdaia.gov.sa/en/SDAIA/about/Pages/RegulationsAndPolicies.aspx

| Topic | Rule | Status |
|---|---|---|
| Scope | The Law covers processing in the Kingdom "including the Processing of Personal Data related to individuals residing in the Kingdom by any means from any party outside the Kingdom" (Art. 2). Hosting abroad does not avoid it. | [verified 2026-10-16] |
| Privacy policy | Must be available "prior to collecting their Personal Data" and state purpose, data collected, means of collection, processing, storage and destruction, and data subject rights and how to exercise them (Art. 12). | [verified 2026-10-16] |
| Notice at collection | Legal basis; purpose; which data is mandatory vs optional; the collector's identity; "The entities to which the Personal Data will be disclosed ... and whether the Personal Data will be transferred, disclosed or processed outside the Kingdom"; consequences of not providing; rights (Art. 13). | [verified 2026-10-16] |
| Plain language | SDAIA's privacy policy guideline: written "in clear, non-misleading, easy-to-read, and understandable language suitable for the comprehension level of all categories of Data Subjects"; sets out rights and response times; gives a template. https://sdaia.gov.sa/Documents/PrivacyPolicyGuideline.pdf | [verified 2026-10-16] |
| Consent | IR Art. 11: freely given; purposes clear before consent; "given by a person who has full legal capacity"; documented with time and method; "Independent consent shall be obtained for each Processing purpose." Explicit consent for sensitive data, credit data and solely automated decisions. | [verified 2026-10-16] |
| Withdrawal | IR Art. 12: withdrawal "similar to or easier than" giving consent; stop processing without undue delay; notify recipients and ask them to destroy the data. | [verified 2026-10-16] |
| Minors and others without full capacity | IR Art. 13: the legal guardian consents or exercises rights; the controller must take "appropriate measures to verify validity of guardianship". | [verified 2026-10-16] |
| Age of full legal capacity in KSA (commonly 18) | Determines who needs guardian consent. | [NOT verified — check with counsel] |
| Other legal bases (contract, legal obligation, legitimate interest) | Law Art. 6 / IR Art. 16 (legitimate interest needs an assessment, not for sensitive data). | [NOT verified — check Art. 6 text] |
| Marketing messages | Law Art. 25: no advertising or awareness material to a person's personal means of communication (post, email) without prior consent and a clear opt-out. IR Art. 29 (direct marketing): consent per IR Art. 11, opt-out "at least as easy as" opting in, sender identity stated, stop immediately on withdrawal. | [verified 2026-10-16] |
| Breach notification | Notify SDAIA "within a delay not exceeding (72) hours of becoming aware" if harm is possible (IR Art. 24); notify affected people "without undue delay". SDAIA's notification service requires registration on the National Data Governance Platform. https://sdaia.gov.sa/en/SDAIA/about/Documents/PersonalDataBreachIncidents.pdf | [verified 2026-10-16] |
| Cross-border transfer | Law Art. 29 and the Transfer Regulation (updated September 2024): no harm to national security; adequate protection or an appropriate safeguard (SDAIA Standard Contractual Clauses, binding common rules, accreditation certificate, binding codes); transfer only the minimum necessary; risk assessment for safeguard-based transfers. SCCs come in four versions (controller/processor combinations), may not be edited, and make the importer submit to Saudi jurisdiction. https://sdaia.gov.sa/Documents/StandardContractualClausesForPersonalDataTransferEN.pdf | [verified 2026-10-16] |
| Registration (National Register of Controllers) | Required if the controller is a public entity, its "main activity is based on personal data processing", it processes sensitive data, or an individual processes beyond personal use. https://sdaia.gov.sa/Documents/TheRulesGoverningTheNationalRegisterOfControllersWithinTheKingdomPublicEN.pdf | [verified 2026-10-16] |
| DPO | Mandatory if a public entity processes at large scale, core activities "require regular and systematic monitoring of Data Subjects", or core activities process sensitive data (IR Art. 32). Can be an employee or external contractor; appointed in writing; contact details published to data subjects and registered on the platform. Voluntary appointment allowed. https://sdaia.gov.sa/en/SDAIA/about/Documents/RulesforAppointingPersonalDataProtectionOfficer.pdf | [verified 2026-10-16] |
| Impact assessment | IR Art. 25 requires impact assessments in defined cases. | [NOT verified — check triggers] |

Questify reading (interpretation, confirm with counsel):

- Profiles, points, leaderboards and submissions are the product, so "main activity based on
  personal data processing" is arguable. Register on the National Data Governance Platform anyway:
  it is needed to use SDAIA's breach-notification service.
- Live leaderboards and optional location checks could be read as "regular and systematic
  monitoring". Run SDAIA's DPO guidance tool on the platform; appoint a DPO (an external contractor
  is allowed) if it says so.
- Questify vs organizer roles (controller, joint controller, processor) must be fixed in the
  Organizer Terms / DPA before launch. It decides who answers access and deletion requests and who
  reports breaches.

### 3.2 SMS sender ID registration (CST) and local providers

| Rule | Source | Status |
|---|---|---|
| Providing SMS services in the Kingdom needs a CST permit (valid commercial registration, technical design, link to licensed operators, bank guarantee). Questify should buy from a licensed provider, not become one. | https://www.cst.gov.sa/ar/business/services/Permit-to-provide-short-message-services-SMS | [verified 2026-10-16] |
| Regulations for Curbing SPAM Messages & Calls (issued by CITC, now CST): sender names are registered in the operators' Bulk SMS e-System; no two senders share a name; promotional sender names get the suffix "-AD"; government agencies have priority over names linked to them. | Operator-published copy: https://www.stc.com.sa/content/dam/corporatesite/common/business/pdf/RegulationsforCurbingSPAMMessagesCallspdfEN.pdf | [verified 2026-10-16 — operator copy; confirm latest version with CST] |
| Senders must not contract with SMS providers not authorized by CST (4.6.3). | same | [verified 2026-10-16] |
| "When the sender sends SMS containing OTP, the sender must explain in SMS to the end user the reason for sending OTP and not just sending it." (4.6.2) | same | [verified 2026-10-16] |
| Promotional SMS: explicit opt-in, and "the consent contained in privacy policies and service contracts is not considered"; proof of consent; opt-out by traditional and electronic channels; stop within 24 hours; confirm activation/suspension; no promotional or awareness messages 22:00–09:00 (Ramadan 01:00–12:00) KSA time; no promotional SMS from a mobile number; never send service messages from a promotional name or the reverse. | same | [verified 2026-10-16] |
| Local provider practice (example: Taqnyat): sender name in English, at least 2 characters, service names up to 11 characters, promotional up to 8 (plus "-AD"); a clear link between the name and the entity; documents: authorization form authenticated through the Chamber of Commerce and a valid CR (or trademark, nic.sa domain, etc. to prove the link); about 3 business days; SAR 230 per year. | https://portal.taqnyat.sa/technical_explanations/en/technical_explanations/sender_name/ and https://portal.taqnyat.sa/technical_explanations/en/technical_explanations/subscribe_and_login/ | [verified 2026-10-16 — one provider's terms] |
| International aggregators (Twilio, etc.) and pre-registered Saudi sender IDs | Each provider handles KSA registration differently. | [NOT verified — check per provider in Stage 6] |

For Questify:

- Register one **service** sender name (e.g., "Questify") under the Questify company CR for OTPs
  and transactional messages. Template: "رمز التحقق لتسجيل الدخول إلى Questify: 123456. لا تشاركه مع
  أحد." / "Your Questify sign-in code is 123456. Do not share it." Add the Android SMS Retriever
  hash to the template.
- Organizer-branded SMS ("from STC Events") needs that organizer's own registered sender name. Not
  in v1.
- Promotional SMS is in v1 (ADR-065):
  - a separate "-AD" sender and separate consent;
  - never 22:00–09:00 (Ramadan 01:00–12:00);
  - opt-out within 24 hours (FR-1738).

### 3.3 Arabic language expectations

| Item | Source | Status |
|---|---|---|
| SDAIA expects privacy policies in language understandable to all categories of data subjects, which for Saudi consumers means Arabic. | Privacy Policy Guideline (3.1) | [verified 2026-10-16 — the Arabic conclusion is interpretation] |
| The draft Consumer Protection Law published for consultation: "Any information provided to consumers ... shall be in the Arabic language; other languages may be used in addition to Arabic." Not confirmed as enacted. | https://istitlaa.ncc.gov.sa/en/Trade/mci/Consumer/Pages/default.aspx | [NOT verified — check whether enacted] |
| The E-Commerce Law applies to providers outside the Kingdom who offer products or services to consumers in the Kingdom; requires disclosure of name, contact and CR (Art. 6) and contract terms (Art. 7). Relevant once anything is sold. | https://misa.gov.sa/app/uploads/2025/07/E-Commerce-Law.pdf | [verified 2026-10-16] |
| Ministry of Commerce competition rules require content that does not violate Sharia or customs observed in the Kingdom. | Asharqia Chamber conditions (3.4) | [verified 2026-10-16] |

Practical standard: Arabic is the primary language for all Saudi-facing text (store listing,
legal documents, consent screens, prize rules, OTP and push messages), English in addition.
Store listings localized in Arabic and English on both stores.

### 3.4 Random draws vs skill- or effort-based rewards

| Rule | Source | Status |
|---|---|---|
| The Ministry of Commerce states that "lottery" prizes that require buying goods to obtain cash prizes or enter prize draws are prohibited; violators are referred to the Public Prosecution. Requiring purchase as a condition of entering a commercial competition is prohibited under the Anti-Commercial Fraud Law and its regulation; competitions may not contain anything contrary to Sharia or customs. | https://mc.gov.sa/ar/mediacenter/News/Pages/20-03-24-01.aspx | [verified 2026-10-16] |
| Commercial competitions need an electronic licence from the Chamber of Commerce **before** the competition; must state participation method, prize types, start and end dates; the draw is held "under the supervision of the Ministry of Commerce"; purchase may not be required; prices may not rise; the licence number appears in ads; the organizer, relatives and employees may not take part; prizes delivered within 7 days of the draw; results announced on the same channel; no more than 60 days from announcement to prize delivery. Penalties under the Anti-Commercial Fraud Law include imprisonment up to three years and fines up to SAR 1 million. | https://mc.gov.sa/en/mediacenter/News/Pages/21-09-25-01.aspx (2025-09-21) | [verified 2026-10-16] |
| Chamber conditions (Asharqia example): at most two competitions per year per establishment, each at most 60 days; apply at least 30 days before; reviewed within 7 days; repeated winner keeps only the first prize; a sorting committee chaired by a Ministry or Chamber representative; fees SAR 500 permit and SAR 600 per draw (SAR 1,000 on holidays). | https://www.chamber.org.sa/en/subscribers/business-service/ | [verified 2026-10-16] |
| General prohibition of gambling (maysir) in Saudi law and its penalties | — | [NOT verified — check with counsel] |
| The draft Consumer Protection Law would repeal the Anti-Commercial Fraud Law; competition rules may move. | Istitlaa draft (3.3) | [NOT verified — check] |

What this means (interpretation, confirm with counsel):

- **Fixed-price redemption** (points earned by participating, exchanged at a published price) has
  no draw and no purchase. It is the most defensible design.
- **Rank-based prizes** (top 3 on the leaderboard) involve no chance. Whether an organizer's
  leaderboard with prizes counts as a "commercial competition" needing a Chamber licence (for
  example at a brand's promotional event) is not settled by the sources read. Counsel must answer.
- **Random draws** in KSA need a Chamber licence and Ministry-supervised draw per competition, with
  a 30-day lead time and a two-per-year cap per establishment. That cannot be self-service in an app.
  If draws ever ship: free entry, entry not bought with anything (points included), the organizer
  holds the licence, and the app shows the licence number. Not in v1.

---

## 4. Legal documents

All documents in Arabic and English, versioned, dated, hosted on a public web page (not a PDF
behind login), and reachable without an account.

| Document | Must contain | Where it is linked | Sources |
|---|---|---|---|
| **Privacy Policy** (attendees; one per platform, not per organizer) | Controller legal name, address, contact and privacy contact/DPO; data collected and how (sign-up, quests, camera, location, device, SDKs); purposes and legal basis per purpose; mandatory vs optional data; who receives data (organizers, SMS/email/push/hosting/moderation vendors, third-party AI if used); transfers outside the Kingdom and the safeguard used; retention period per data type and destruction method; rights (be informed, access, copy, correct, destroy, withdraw consent) and how to use them, with response times; account deletion and what is kept and why; minors and guardian consent; security measures; changes and how users are notified; labelled "Privacy Policy" in the title. | App Store Connect privacy URL; Play Console App content (shown on the listing); in the app (Settings → Legal, and on the sign-up screen before any data is collected); website footer. | Apple 5.1.1(i); Google User Data (https://support.google.com/googleplay/android-developer/answer/10144311?hl=en); PDPL Art. 12–13; SDAIA guideline. [verified 2026-10-16] |
| **Terms of Use** (attendees) | Who the parties are; eligibility and minimum age; account rules; how points work: earned only, no cash value, not transferable, not purchasable, per-event, may end when the event ends; prizes are provided and delivered by the organizer, Questify's role; UGC licence (user grants a licence to display submissions within the event), definition of objectionable content and a zero-tolerance statement, moderation and removal, report and block; suspension and termination; liability limits; governing law (KSA) and disputes; contact. | Accepted at sign-up (unticked checkbox or explicit "Agree" button, logged with time and version); shown again before the first UGC submission; Settings → Legal; App Store description link; Play listing website. | Google UGC (terms before UGC, objectionable content defined); Apple 1.2. [verified 2026-10-16] |
| **Apple EULA** | Use Apple's Standard EULA (applies automatically when no custom EULA is set; no link shown on the product page). A custom EULA must meet Apple's minimum terms: the EULA is between developer and user only, Apple not responsible; licence limited to Apple devices the user owns/controls; developer's name, address and contact for questions and claims; third-party terms; Apple as third-party beneficiary; and the other listed items. Recommendation: keep the Standard EULA; the Terms of Use cover the service. | App Store Connect → App Information → License Agreement (only if custom). | https://developer.apple.com/help/app-store-connect/manage-app-information/provide-a-custom-license-agreement ; https://www.apple.com/legal/internet-services/itunes/dev/stdeula/ ; https://www.apple.com/legal/internet-services/itunes/dev/minterms/ [verified 2026-10-16] |
| **Official Prize & Contest Rules** (a platform template; each event's rules generated from organizer settings) | Sponsor/administrator (Questify entity) and prize provider (organizer) with contact; eligibility (age, region, exclusions: organizer staff and relatives); event dates and entry deadline; how points are earned (quest values) and the fixed redemption price of each prize; for rank prizes: number of winners, ranking method, tie-break, award date; for any chance-based draw (not v1): odds or selection method, fixed number of winners, entry deadline, prize award date, no purchase necessary, KSA licence number; prize description and approximate value; delivery method and deadline; what happens to unclaimed prizes; cheating and disqualification; "Apple is not a sponsor of, and is not involved in, this activity in any manner" (and the same for Google: best practice, [NOT verified — check]); privacy reference; governing law. | Inside the app on the event page and the prize store, before joining and before redeeming (5.3.2 requires the rules "presented in the app"); also a web URL per event. | Apple 5.3.1–5.3.2; Google 9877032 loyalty-program rules; MoC competition conditions. [verified 2026-10-16] |
| **Community Guidelines** | What may be submitted (photos, text) and what may not (nudity, hate, harassment, threats, rating people's appearance, other people's personal data, IP infringement, dangerous challenges); voting rules; how to report and block; what moderators do and how fast; consequences (removal, point revocation, ban); appeal; contact. | In the submission composer ("By submitting you agree to the Community Guidelines"), the report flow, Settings → Legal. | Apple 1.2, 1.4.5; Google UGC. [verified 2026-10-16] |
| **Organizer Terms + Data Processing Agreement** (B2B, web dashboard) | Organizer obligations: deliver prizes; run lawful competitions (MoC licence where needed); moderate their event's content within a set time; write challenges that are safe and lawful; licence to use their logos and brand assets in the app; roles under PDPL (controller/processor), processing instructions, sub-processors, breach notice, SDAIA SCCs where data leaves the Kingdom; minors at their events; acceptable use; fees and invoicing (outside the app). | Accepted when an organizer account is created on the web dashboard. | Apple 1.2, 4.1(c), 5.2.1, 5.3.1; PDPL transfer regulation. [verified 2026-10-16] |
| **Support / Contact page** | Email, in-app contact route, response time, company name, CR number and address (also needed for DSA). | App Store Support URL; Play developer email/website; in-app Help. | Apple 1.2, 1.5, DSA page; Google 13628312. [verified 2026-10-16] |
| **Account deletion page** | How to delete in the app; a web form or email to request deletion without reinstalling; what is deleted, what is kept (e.g., prize-fulfilment records) and for how long; names the app and developer as on the listing. | Play Data safety deletion URL; privacy policy; Apple Privacy Choices URL (optional). | Google 13327111; Apple 5.1.1(v). [verified 2026-10-16] |
| **Marketing consent text** (if ever used) | Separate, unticked, per channel (push, email, SMS); sender named; how to opt out. Not bundled into the privacy policy. | Sign-up (optional step) and Settings → Notifications. | PDPL Art. 25, IR Art. 29; CST 4.6.6.1; Apple 4.5.4. [verified 2026-10-16] |

---

## 5. (a) Pre-submission checklist

### Apple

- [ ] Individual membership in use (ADR-010); seller name shows Dhia's legal name. Organization
      membership later, when the company takes over the accounts.
- [ ] Built with Xcode 26+ and the iOS 26 SDK (26.2+ if using age-assurance APIs); deployment
      target iOS 13 or later.
- [ ] Demo account in App Review Information works without SMS (fixed code for one allow-listed
      number, demo tenant only); credentials tested from a clean device the day of submission.
- [ ] "App Review Demo" event live, no end date, with every quest type in the binary; QR image and
      join code attached to the notes.
- [ ] Notes for Review describe every feature and every flag-controlled module, with steps.
- [ ] No feature in the binary is hidden from the reviewer; no flag can reveal unreviewed features.
- [ ] Screenshots show the app in use (not splash/login), fictional organizer brand and players,
      Arabic and English sets, no Android imagery.
- [ ] Name ≤ 30 characters; subtitle and keywords without trademarks or prices.
- [ ] Category is not Games.
- [ ] Age rating questionnaire answered, including the social media questions; expected 13+.
- [ ] Privacy nutrition label matches the SDK inventory and the Xcode privacy report.
- [ ] Privacy manifest present; required-reason APIs declared; listed third-party SDKs carry their
      manifests and signatures.
- [ ] Purpose strings for camera (and location if used) in Arabic and English; no photo library
      permission (PHPicker used).
- [ ] Account deletion reachable in the app (Settings → Account → Delete account); it deletes
      server data; Sign in with Apple tokens revoked if SIWA exists.
- [ ] Privacy policy URL in App Store Connect and linked in the app.
- [ ] Support URL with contact details; Terms and Community Guidelines linked in the app.
- [ ] Official rules shown in the app for every event with prizes, stating Apple is not a sponsor.
- [ ] No purchase UI and no links or calls to action to buy anything (outside the US storefront).
- [ ] Push not required for any feature; marketing push opt-in separate; in-app opt-out.
- [ ] No points for enabling push or location; every location quest has an alternative.
- [ ] `ITSAppUsesNonExemptEncryption` set correctly; export questionnaire reviewed once.
- [ ] DSA trader status declared and verified.
- [ ] Layout checked on iPad and on an IPv6-only network.
- [ ] One external TestFlight round passed review before the App Store submission.

### Google Play

- [ ] Organization account verified (D-U-N-S, documents match payments profile); developer email
      and phone shown on the profile.
- [ ] If a personal account was used instead: closed test with ≥ 12 testers opted in for 14
      continuous days, then production access applied for.
- [ ] Package name registered for Android developer verification.
- [ ] Target API level 36 confirmed in App bundle explorer.
- [ ] Merged manifest has no `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_SMS`,
      `ACCESS_BACKGROUND_LOCATION`, or unneeded foreground-service permissions.
- [ ] Android photo picker used for submissions; SMS Retriever hash in the OTP message.
- [ ] Location requested in the foreground only, coarse unless fine is needed, with an in-app
      explanation before the prompt.
- [ ] Data safety form complete, consistent with the privacy policy and SDKs; deletion questions
      answered; encryption-in-transit claimed only if true for all data.
- [ ] Account deletion web URL entered; it works without the app and names the app/developer.
- [ ] Sign-in details: reviewer number, fixed code, OTP explained; staff mode credentials if any.
- [ ] Target audience 13+ or 18+ declared; listing art not child-oriented.
- [ ] IARC content rating questionnaire completed.
- [ ] Ads declaration "No"; category not Games.
- [ ] UGC: terms accepted before first submission; report content, report user and block exist.
- [ ] Prize rules in the app with the fixed redemption ratio shown.
- [ ] Invite/share uses the system share sheet.
- [ ] DSA trader declaration (if Play Console asks).

### Both

- [ ] One app, one listing per store; organizer branding applied in the app after joining an event.
- [ ] OTA updates used only for fixes and small changes; native or permission changes go through
      a store release.
- [ ] Moderation live:
  - Arabic and English word lists for usernames and player text;
  - human review of submissions, with per-quest auto-approve (ADR-042), no AI (ADR-071);
  - report and block;
  - Questify queue with 24 h / 1 h-live targets (ADR-079).
- [ ] Points for submissions confirmed after moderation; revoked when content is removed.
- [ ] Voting quests never rate people's appearance.
- [ ] Points cannot be bought, transferred or spent on chance-based entries.
- [ ] Attendee sees which data the organizer receives before joining an event.
- [ ] Third-party AI moderation disclosed with explicit permission, or not used.
- [ ] Age gate at sign-up; under-13 blocked; guardian flow decided for 13–17 (see Open Questions).
- [ ] Privacy policy, terms, prize rules, community guidelines, deletion page and support page
      live in Arabic and English.
- [ ] Backend, SMS, email, push and moderation services live and monitored during review.
- [ ] Outsider test: the reviewer bypass code works only for the allow-listed number and only in
      the demo tenant.

### Saudi Arabia

- [ ] Questify legal entity with CR; Chamber of Commerce membership (needed for SMS sender
      authorization and any competition licence).
- [ ] Registered on SDAIA's National Data Governance Platform; DPO guidance tool run; DPO appointed
      if required (or voluntarily); DPO contact published.
- [ ] Privacy notice shown before collection; consent captured per purpose with time and version.
- [ ] Withdrawal of consent in Settings, as easy as giving it.
- [ ] Guardian consent flow for users without full legal capacity (per counsel's answer).
- [ ] Data map: what is stored where; any transfer outside the Kingdom has SDAIA SCCs (or another
      safeguard) and a risk assessment.
- [ ] Breach-response runbook with the 72-hour SDAIA notice and user notice.
- [ ] Service SMS sender name registered through a CST-authorized provider; OTP text states its
      purpose. Promotional SMS from a separate "-AD" sender, within the CST send window, with
      opt-out in 24 hours (ADR-065, FR-1738).
- [ ] Prize mechanics in v1 limited to fixed-price redemption and rank prizes; counsel confirmed
      whether rank prizes at commercial events need a Chamber licence.
- [ ] Arabic versions of all user-facing legal text reviewed by a native speaker and counsel.

---

## 6. (b) Product decisions this compliance forces

Status: **Proposed** until the user accepts them in `DECISIONS.md`. Review so far (2026-10-16):
- **Accepted:** PD-01 → ADR-006, PD-02 → ADR-007, PD-06 → ADR-008, PD-21 → ADR-009 (extended
  with a demo-only QR picker).
- **Declined:** PD-23 → ADR-010 (launch on individual accounts).
- **Accepted later the same day:** PD-08 → ADR-015 (location optional, QR alternative).
- **Accepted in the feature sessions:** PD-14 → ADR-030 (phone numbers limited to +966; email
  code as the alternative), PD-20 → ADR-032 (the anonymous-board option was declined in ADR-052).
  PD-24 → ADR-065, with promotional SMS allowed in v1 under a separately registered sender.
  PD-11 → ADR-068 (report, filter, block, queues, for nicknames, the photo wall and private
  submissions).
  PD-12 → ADR-042, with one exception: the owner may auto-approve a quest's submissions; points
  are revoked if the content is removed later.
- **Consolidated review (2026-10-17): complete. Every PD now has an outcome.**
  - **Covered by earlier ADRs:**
    - PD-05 → ADR-002/046;
    - PD-19 → ADR-028;
    - PD-22 → ADR-022/064;
    - PD-30 → ADR-006.
  - **Accepted → ADR-073:** PD-03, PD-04, PD-07, PD-10, PD-13, PD-15, PD-16, PD-17, PD-25,
    PD-27.
  - **Accepted with changes:**
    - PD-09 → ADR-072 (location while the app is open, never in the background);
    - PD-26 → ADR-070 (hosting in Saudi Arabia);
    - PD-29 → ADR-073 (reports and unpublish, no automatic filter).
  - **Replaced:** PD-28 → ADR-073. Store declarations always describe every feature as on, so no
    gate is needed.
  - **Deferred:** PD-18 → ADR-071 (no AI moderation in v1).

| ID | Decision | Reason | Source |
|---|---|---|---|
| PD-01 | **Outcome: ADR-006.** White-label means **one Questify app**; each event shows its organizer's brand after the attendee joins. No per-client store apps submitted by Questify. A client-owned app (client's own developer account) is a later enterprise option. | Apple names the event-app picker model as acceptable and rejects template apps submitted on clients' behalf; Google forbids highly similar multiple apps. | Apple 4.2.6, 4.3(a); Google Spam/Repetitive Content |
| PD-02 | **Outcome: ADR-007.** **Configuration changes data, never features.** Every feature a flag can switch on ships in the binary, is enabled in the demo event at review, and is listed in Notes for Review. New quest mechanics are store releases. | Downloaded code may not introduce features; dormant features are banned. | Apple 2.5.2, 2.3.1(a); DPLA 3.3 |
| PD-03 | **Outcome: ADR-073.** **Server-driven UI is a fixed native component library** rendered from server JSON. No remote JavaScript, HTML5 mini-games or WebView features in v1. | Keeps all behaviour in the reviewed binary; 4.7 brings extra obligations. | Apple 2.5.2, 4.7 |
| PD-04 | **Outcome: ADR-073.** **OTA updates (if Expo is chosen) are for bug fixes, copy, styling and layout only.** Anything adding a permission, native module or new feature is a store release. | Interpreted code may not change the primary purpose; native changes need a build. | DPLA 3.3; Expo EAS Update docs; Google Device and Network Abuse |
| PD-05 | **Outcome: ADR-002/046.** **Points are earned only**: never sold, never transferable between users, never spent on draw entries, no cash value. | Selling them triggers IAP and no-expiry; spending valuable points on chance is gambling under Apple's rating and needs licences; Google forbids purchased items as entry to real-value prizes. | Apple 3.1.1, 5.3.3–5.3.4, age-rating "Gambling"; Google 9877032 |
| PD-06 | **Outcome: ADR-008.** **v1 prizes: a fixed-price points store plus optional rank-based prizes. No random draws or raffles in v1**, and no draw UI in the binary. | Raffles push the rating to 18+ and need a Chamber licence and Ministry-supervised draw per competition in KSA. | Apple age ratings; MoC competition rules |
| PD-07 | **Outcome: ADR-073.** **Official rules are generated for every event with prizes** and shown in the app before joining and redeeming. Questify is named sponsor/administrator; the organizer is prize provider; text states Apple is not a sponsor. | Developer must sponsor contests; rules must be in the app. | Apple 5.3.1–5.3.2; Google loyalty-program rules |
| PD-08 | **Outcome: ADR-015.** **No system permission is ever a condition for points or prizes.** No points for enabling push or location. Every location quest has a QR or staff-check alternative. | Apple bans requiring push/location to receive compensation including gift cards. | Apple 5.1.2(i), 5.1.1(iv), 4.5.4 |
| PD-09 | **Outcome: ADR-072.** **Location: foreground only, coarse by default, only during a location quest.** No background location. | Minimum scope rule; background location needs a declaration and video. | Google location policy; Apple 5.1.5, 2.5.4 |
| PD-10 | **Outcome: ADR-073.** **Photos come from the system photo picker or the in-app camera.** No photo-library permission on either platform. | Infrequent media access must use the system picker; Apple prefers the out-of-process picker. | Google Photo and Video Permissions; Apple 5.1.1(iii) |
| PD-11 | **Outcome: ADR-068.** **UGC moderation is part of v1**: pre-publication text/name filter, image moderation or organizer pre-approval, report on every item and profile, block, organizer and platform queues with a response-time target, terms accepted before the first submission. | Required by both stores for UGC. | Apple 1.2; Google UGC |
| PD-12 | **Outcome: ADR-042.** **Points for submissions are pending until moderation approves them** and are revoked if the content is removed later. | Rewards must not encourage objectionable content. | Google UGC ("safeguards to prevent in-app monetization from encouraging objectionable user behavior") |
| PD-13 | **Outcome: ADR-073 (votes are organizer-written options, ADR-075).** **Voting quests vote on submissions or ideas, never on people's looks.** | "hot-or-not" voting is named as unacceptable. | Apple 1.2 |
| PD-14 | **Outcome: ADR-030.** **Sign-in = phone + SMS OTP, with email + code as the alternative. No social logins in v1.** Adding Google Sign-In later means adding Sign in with Apple. | Own account system needs no SIWA. | Apple 4.8 |
| PD-15 | **Outcome: ADR-073.** **Store category is not Games** (Apple and Play). | Google forbids chance-based loyalty rewards in Game apps; Apple contest/game scrutiny is higher. | Google 9877032; Apple 2.3.5 |
| PD-16 | **Outcome: ADR-073.** **Account deletion in the app and on a web page**, deleting points, submissions, votes and profile; prize-fulfilment records kept only as long as legally needed and disclosed. | Both stores require it; Google forbids "freezing". | Apple 5.1.1(v); Google 13327111, User Data |
| PD-17 | **Outcome: ADR-073.** **The attendee sees what the organizer receives before joining an event** (name, points, answers, submissions). | Sharing with a third party needs disclosure and permission; PDPL requires naming recipients. | Apple 5.1.2(i); PDPL Art. 13 |
| PD-18 | **Outcome: deferred, ADR-071.** **Moderation AI: disclose and ask, or keep it in-house.** If images or text go to an external AI service, the submission screen says so and gets explicit permission. | Apple names third-party AI sharing explicitly. | Apple 5.1.2(i) |
| PD-19 | **Outcome: ADR-028.** **Minimum age 13, with an age (or birth-year) question at sign-up.** Not designed for children; store target audience 13+ or 18+. Guardian consent for users without full legal capacity where consent is the legal basis (scope per counsel). | Avoids Families policy; PDPL needs full legal capacity for consent. | Google Families, Target audience; Apple 5.1.4; PDPL IR Art. 11, 13 |
| PD-20 | **Outcome: ADR-032 / ADR-052 / ADR-084.** **Leaderboards show a user-chosen display name, filtered, never the real name by default**, with an option to appear anonymously. | Data minimization; display names are UGC that needs filtering. | Apple 5.1.1(iii), 1.2; PDPL consent per purpose |
| PD-21 | **Outcome: ADR-009.** **A permanent review tenant**: "App Review Demo" event, fictional brand, every quest type, printable QR, reviewer number with fixed OTP restricted to that tenant and covered by an outsider test. | Reviewers need full access; the bypass is a security risk. | Apple 2.1(a), Before You Submit; Google sign-in details |
| PD-22 | **Outcome: ADR-022/076.** **Organizer billing lives only on the web dashboard.** The attendee app has no purchase UI and no upgrade links. Any in-app organizer purchase would use IAP. | Companion-app exemption requires no purchasing or calls to action. | Apple 3.1.1, 3.1.1(a), 3.1.3(f) |
| PD-23 | **Outcome: declined, ADR-010.** **Questify operates as a Saudi legal entity (not a sole establishment)** with CR, D-U-N-S and organization accounts on both stores. | Company name as seller; no Google closed-test gate; DSA public contact is the company's; SMS sender registration and competition licences need a CR. | Apple enrollment; Google 14151465, 13628312; Apple DSA; CST/Taqnyat |
| PD-24 | **Outcome: ADR-065.** **One service SMS sender ("Questify")**; OTP text states its purpose; promotional SMS allowed in v1 only under a separately registered sender with opt-in consent (ADR-065, see the outcome note above); organizer-branded SMS later, under the organizer's own registered sender. | CST rules on sender names, OTP wording and promotional consent. | CST anti-spam regulation 4.3, 4.6 |
| PD-25 | **Outcome: ADR-073.** **Arabic first** for every Saudi-facing string: legal documents, consent text, prize rules, purpose strings, OTP, push, store listings. | PDPL plain-language expectation; draft consumer law; market. | SDAIA guideline; Istitlaa draft |
| PD-26 | **Outcome: ADR-070.** **Data residency decided before the backend**: host personal data in the Kingdom, or document each transfer with SDAIA SCCs and a risk assessment. Every vendor (SMS, email, push, moderation, analytics, crash) is listed in a data map. | Transfer rules apply to every vendor receiving KSA residents' data. | PDPL Art. 29; Transfer Regulation; SCCs |
| PD-27 | **Outcome: ADR-073.** **No ads and no tracking SDKs in v1.** | Keeps labels simple; avoids ATT, Families ad rules and rating changes. | Apple 5.1.2(i), privacy details; Google Families |
| PD-28 | **Outcome: replaced, ADR-073.** **Turning on any capability that changes the age rating or privacy answers (chat, public feed, location, analytics) requires updating App Store Connect and Play Console first.** The admin dashboard shows this as a blocking step for platform admins. | Ratings and labels must match the live app. | Apple 2.3, 2.3.6, privacy details; Google Data safety |
| PD-29 | **Outcome: narrowed, ADR-073.** Organizer content is published without an automatic filter; Questify handles it through reports and unpublish (ADR-073, FR-1413), and challenges that risk physical harm are refused by policy. | Questify is responsible for all content in the app. | Apple 1.1, 1.4.5, 4.7 |
| PD-30 | **Outcome: ADR-006.** **App icon and name never change per organizer.** | Metadata and icons must stay consistent; other brands may not appear in the icon or name. | Apple 2.3.8, 4.1(c) |

---

## 7. (c) Open questions

Moved to `OPEN_QUESTIONS.md`, so that all unknowns live in one place. SC-02–06, 08, 10, 11,
13–15 and 17 became Q-040 to Q-051. The rest were merged into existing questions: SC-01 → Q-020,
SC-07 → Q-032, SC-09 → Q-030/033, SC-12 → Q-034, SC-16 → Q-014, SC-18 → Q-012.
