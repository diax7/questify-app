# Expo SDK check against store rules

**Checked:** 2026-10-20 (T-015, Q-046, NFR-010).
**What was checked:** `apps/app` as installed: `expo` 57.0.30, `react-native` 0.86.3, React 19.2.3.
**Result:** Expo SDK 57 meets every current App Store and Google Play build rule. Three things
still need doing before the first store upload (see Actions). One deadline is coming: Xcode 27.

How the facts were found: the store pages and Expo docs below (read on 2026-10-20), and the
packages in `node_modules` (React Native's `gradle/libs.versions.toml`, each library's
`PrivacyInfo.xcprivacy`).

## Status table

| Rule | Store requirement now (source, date) | What Expo SDK 57 gives | Status | Action |
|---|---|---|---|---|
| Apple: Xcode and iOS SDK | Since 28 April 2026, uploads must be built with Xcode 26 or later and the iOS 26 SDK. https://developer.apple.com/news/upcoming-requirements/ (read 2026-10-20) | Expo lists SDK 57 as needing Xcode 26.4+. The EAS `sdk-57` iOS image runs Xcode 26.6 on macOS Tahoe 26.5.2. https://docs.expo.dev/versions/latest/ and https://docs.expo.dev/build-reference/infrastructure/ (read 2026-10-20) | Meets | Keep the EAS image on `auto` or `sdk-57`. Do not pick `latest`: it is now Xcode 27.1 RC (A3). |
| Apple: minimum iOS target | Since 9 September 2026, apps must target iOS 13 or later. https://developer.apple.com/news/upcoming-requirements/ (read 2026-10-20) | SDK 57 supports iOS 16.4+. https://docs.expo.dev/versions/latest/ | Meets | None. iOS 16.4 is the app's floor (Q-082). |
| Apple: age-assurance APIs | Build with Xcode 26.2 / iOS 26.2 SDK or later for the full Declared Age Range API set. https://developer.apple.com/support/age-assurance/ (`STORE_COMPLIANCE.md` §1.13, verified 2026-10-16) | Xcode 26.6 on the `sdk-57` image. No age-range library is installed yet. | Meets | None now. |
| Apple: required-reason APIs in the privacy manifest | Since 1 May 2024, uploads must declare approved reasons for listed APIs used by the app's code, including third-party SDKs. https://developer.apple.com/news/upcoming-requirements/ and https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api (read 2026-10-20) | React Native 0.86.3, `expo-constants`, `expo-localization`, `expo-file-system` and `@react-native-async-storage/async-storage` ship their own `PrivacyInfo.xcprivacy`. Expo says Apple does not reliably read manifests inside static CocoaPods, so the app must repeat those reasons in `ios.privacyManifests`. https://docs.expo.dev/guides/apple-privacy/ (read 2026-10-20) | Meets (since this check) | Done: added the reasons to `apps/app/app.json` (A1). Repeat for every new native library. |
| Apple: listed third-party SDKs need a manifest and a signature | The SDKs on Apple's list need their own privacy manifest when added. Binary ones also need a signature. https://developer.apple.com/support/third-party-SDK-requirements/ (read 2026-10-20) | None of the app's libraries is on the list. "hermes" is on the list, but Apple told the React Native team that entry means Imgur's Hermes, not Meta's engine. https://github.com/react-native-community/discussions-and-proposals/discussions/776 (2024-04, read 2026-10-20) | Meets | Check the list before adding any SDK (for example Firebase, Google Sign-In, Lottie, SDWebImage). |
| Apple: data collected (privacy manifest and nutrition label) | The manifest also records the data types the app collects. Xcode combines all manifests into one privacy report. https://developer.apple.com/support/third-party-SDK-requirements/ (read 2026-10-20) | The app collects nothing yet. `NSPrivacyCollectedDataTypes` is not set. | Action needed (later) | A2: before the first TestFlight upload, add the collected data types (phone number, name, user ID, photos, location as features land) and check Xcode's privacy report. |
| Google Play: target API level | Since 31 August 2026, new apps and updates must target Android 16 (API 36) or higher. Existing apps may request an extension to 1 November 2026; a new app cannot rely on it. https://developer.android.com/google/play/requirements/target-sdk (read 2026-10-20) | `compileSdkVersion` 36 and `targetSdkVersion` 36. Seen in Expo's table and in React Native 0.86.3's `libs.versions.toml` (`targetSdk = "36"`, `compileSdk = "36"`, `minSdk = "24"`). https://docs.expo.dev/versions/latest/ | Meets | After the first upload, confirm API 36 in Play Console's App bundle explorer (`STORE_COMPLIANCE.md` checklist). |
| Google Play: 16 KB memory pages | Apps targeting Android 15+ must support 16 KB page sizes on 64-bit devices. The page now says updates that don't will be blocked from 1 February 2027. https://developer.android.com/guide/practices/page-sizes (page dated 2026-10-16, read 2026-10-20). Google's earlier post set 1 November 2025 for new apps and updates with native code. https://android-developers.googleblog.com/2025/07/transition-to-16-kb-page-sizes-android-apps-games-android-studio.html | React Native supports 16 KB pages since 0.77. Expo libraries since `expo@53.0.14`. The app is on React Native 0.86.3 and `expo` 57.0.30. https://github.com/expo/fyi/blob/main/android-16kb-page-sizes.md and https://reactnative.dev/blog/2025/01/21/version-0.77 (read 2026-10-20) | Meets | After the first upload, check "Memory page size" in App bundle explorer. Recheck when adding any library with native code. |
| Android 16: edge-to-edge | Apps targeting API 36 cannot opt out of edge-to-edge on Android 16. https://developer.android.com/about/versions/16/behavior-changes-16 (read 2026-10-20) | Edge-to-edge is always on in Expo (since SDK 54; the `edgeToEdgeEnabled` setting was removed). The app draws safe areas with `react-native-safe-area-context`. https://expo.dev/blog/edge-to-edge-display-now-streamlined-for-android and https://github.com/expo/expo/pull/42518 | Meets (to confirm on a phone) | During T-009's phone check, confirm no content sits under the status or navigation bar on Android 15/16, in both directions. |
| Android 16: predictive back | Apps built with React Native 0.81+ target API 36 and have predictive back on by default. https://reactnative.dev/blog/2025/08/12/react-native-0.81 | React Native 0.86 targets API 36, so this applies (not separately confirmed for 0.86). The app has no custom native back handling. | Meets (to confirm on a phone) | Test the back gesture on an Android 16 phone in T-009/T-010. |
| Expo support window | SDK releases get about one year of fixes. https://expo.dev/changelog/sdk-57 (SDK 57 released 2026-06-30) | SDK 57 is supported until about mid-2027. SDK 58 came out 2026-10-15. | Meets | Plan the move to SDK 58 before Apple's Xcode 27 deadline (A3). |
| Account deletion; Sign in with Apple | Apple 5.1.1(v) and Google User Data require in-app account deletion. Sign in with Apple is needed only with third-party or social sign-in (Apple 4.8). `STORE_COMPLIANCE.md` §1.9, §1.10, §2.5 (verified 2026-10-16) | Not tied to the SDK version. Questify uses phone OTP and email code, no social sign-in (ADR-030), so Sign in with Apple does not apply. | Not SDK-related | None here. Tracked in `STORE_COMPLIANCE.md`. |

## Actions

- **A1 (done 2026-10-20).** Added `ios.privacyManifests.NSPrivacyAccessedAPITypes` to
  `apps/app/app.json`. It copies the reasons shipped by the libraries in the app, as Expo's guide
  says to do:
  - UserDefaults `CA92.1` (React Native, `expo-constants`, `expo-localization`).
  - File timestamp `C617.1` (React Native, its Folly/glog/boost pods, AsyncStorage), and `0A2A.1`
    and `3B52.1` (`expo-file-system`, a dependency of `expo`).
  - System boot time `35F9.1` (React Native timing, boost).
  - Disk space `E174.1` and `85F4.1` (`expo-file-system`).
  - `expo config --type public` reads the new block correctly. The app's own code adds no native
    code, so it adds no reasons of its own.
- **A2 (before the first TestFlight upload, T-010).** Add `NSPrivacyCollectedDataTypes` and
  `NSPrivacyTracking: false` to `ios.privacyManifests` for the data the app collects by then.
  Archive in Xcode (or read the EAS build's privacy report) and run "Generate Privacy Report".
  Make the App Store nutrition label match it. Apple also emails missing reasons a few minutes
  after a TestFlight upload; fix any it lists.
- **A3 (before Apple requires Xcode 27).** Apps built with the iOS 27 SDK must use the scene-based
  life cycle or they do not launch on iOS 27. SDK 58 does this by default. SDK 57 can do it with
  `expo@57.0.23`+ and the `ios.enableSceneSupport` option of `expo-build-properties` (not
  installed; adding it is a new dependency). https://expo.dev/changelog/sdk-57 and
  https://github.com/expo/fyi/blob/main/ios-scene-lifecycle.md (read 2026-10-20). Recommended:
  move to SDK 58 rather than add the opt-in.
- **A4 (with T-010).** `apps/app/eas.json` has only a `development` profile. When adding the
  production profile, leave `image` unset (`auto`) or set `sdk-57`. Never `latest`.
- **A5 (after the first uploads).** In Play Console's App bundle explorer, confirm target API 36
  and 16 KB page support.

## Re-check when

- **Every Expo SDK upgrade** (next: SDK 58, released 2026-10-15). Recheck the table in
  https://docs.expo.dev/versions/latest/, the EAS image for the SDK, and every library's
  `PrivacyInfo.xcprivacy` against A1.
- **Every new library with native code.** Copy its required reasons into `ios.privacyManifests`,
  check Apple's SDK list, and check it supports 16 KB pages.
- **Apple's Xcode 27 deadline.** Not announced as of 2026-10-20 on
  https://developer.apple.com/news/upcoming-requirements/. Unconfirmed date. Past rules started
  29 April 2024 (Xcode 15) and 28 April 2026 (Xcode 26), so expect one in spring 2027. Check that
  page monthly from January 2027.
- **Google's next target API level.** Not announced on
  https://developer.android.com/google/play/requirements/target-sdk as of 2026-10-20. Unconfirmed.
  The API 35 and API 36 rules both started on 31 August (2025 and 2026), so expect API 37 around
  31 August 2027.
- **1 February 2027:** Google blocks updates without 16 KB page support (already met; confirm in
  Play Console).
- **Before each store submission** (NFR-010): reread both requirement pages above.
