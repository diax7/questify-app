# T-115 — The scanner and the celebration

Delivers FR-201 and FR-303 (the app's half: live camera only), FR-406, FR-408, FR-403, FR-410, and FR-621 in part;
FR-407 and FR-409 in part (see the scope note). The completion itself is the Max-bar core and does not change: the app
calls the existing `POST /v1/quests/{id}/complete` with `{proof: {type: "qr", code: token}}`. The new history read is
tenant isolation (Max).

## Scope note

- **What exists:** printed quest QRs hold `{DASHBOARD_ORIGIN}/q/{token}` (ADR-116): base64url of a format byte
  (`0x01`), the quest id, the code version and an HMAC tag. The server verifies everything; the app only reads the quest
  id to build the path. The Quests tab (T-114) maps a completion's answer (`completionAnswer`) and keeps the
  Idempotency-Key rule (`keyFor`).
- **Not here, and why:** My QR and its toggle (FR-622) need the rotating personal code of T-205; NFC (FR-621's tags)
  is T-3xx with `react-native-nfc-manager`; level-ups (FR-407's medium celebration) need XP (T-401); pending points
  (FR-409) need submissions (T-301): no quest can be pending yet, so nothing shows; the App Review demo QR picker
  (FR-303) is T-117's demo event. The "Scanned" beat's sound needs the brand deck's sound set, which does not exist yet
  (Q-103): the beat buzzes and spins, silently.
- **Store rules (STORE_COMPLIANCE §2.7):** the camera permission text in Arabic and English, asked for when the player
  first opens the scanner, never at launch; no gallery, no `READ_MEDIA_IMAGES`, no microphone.

## Decisions (tactical; for the CTO to challenge)

1. **The camera:** `expo-camera` (Expo's own module for SDK 57, installed with `npx expo install`), `CameraView` with
   `barcodeScannerSettings: {barcodeTypes: ["qr"]}`. No image picker anywhere in the app. Its config plugin with
   `cameraPermission` text, `microphonePermission: false` and `recordAudioAndroid: false`; the Arabic text through
   `expo-localization`'s per-locale `InfoPlist` strings. **New dependency, reason:** FR-201 needs a live camera; it is
   the SDK's maintained module, no third party.
2. **The buzz:** `expo-haptics` (`notificationAsync(Success)` on a valid scan, `Error` on a refusal). **New dependency,
   reason:** React Native's `Vibration` gives a fixed long buzz on iPhone; `expo-haptics` is the SDK's module. If the
   CTO prefers no second dependency, `Vibration.vibrate(40)` is the fallback.
3. **Reading a scan (`readScan`, pure, tested):** an https URL on a Questify host (`QUEST_CODE_HOSTS` in shared:
   `questify.nafes.com`, plus the staging web host in development builds only) whose path is exactly `/q/{50
   base64url characters}` → `{kind: "quest", questId, token}`, the quest id decoded from bytes 1–16 (format byte
   `0x01`; any other format → not a quest code). A join link (`parseJoinLink`) → `{kind: "join", code}`, opening the
   join card with `via: "qr"`. Anything else → "not a Questify code", and the camera keeps scanning. The decoder is
   written for Hermes (no `Buffer`, no `atob` reliance).
4. **One scan at a time:** after a read, the scanner pauses until the answer is shown and the player taps Scan again
   or closes; the same token read twice within the pause is ignored. Each scan takes a fresh Idempotency-Key; a network
   failure offers Retry with the same key (`keyFor`).
5. **The two-step celebration (FR-406):** within 300 ms of the read, a "Scanned! Checking…" card with a spinning coin
   and the success buzz; on the server's answer either the +points celebration with Claim (closing it; the points are
   already recorded, Claim only dismisses) or the refusal in clear words from `completionAnswer` (no points, no
   celebration, an error buzz). A completion that finishes the quest's category plays the full-screen category
   celebration after the small one (FR-407, in part), read from the Quests tab's data after the reload.
6. **Reduce motion (FR-408):** `AccessibilityInfo.isReduceMotionEnabled()` and its change event, in one hook
   (`useReduceMotion`); every animation (coin, celebration, balance) shows its end state at once when it is on.
   Animations use React Native's `Animated` with the native driver: no animation library.
7. **The balance (FR-403):** Home's points and balance count up to a new value (`Animated` over 600 ms, none with
   reduce motion); a pure `countSteps` decides the shown numbers. Home reloads on focus (T-113), so a scan's points
   arrive when the player returns.
8. **The center button and the Scan action (FR-621):** both open the scanner screen
   `app/event/[eventId]/scan-quest.tsx` (a modal stack screen). The Quests sheet's Scan button opens it for that quest:
   a scan of another quest's code still completes that other quest (the token decides), and says so. The "coming
   soon" sheet and `scan.tsx`'s redirect go (replace, not keep).
9. **Permission states:** not asked → an explanation card and "Allow the camera"; denied → why it is needed and "Open
   settings" (`Linking.openSettings`); the camera fails to start → a message and Close. Never a dead end.
10. **The activity history (FR-410):** `GET /v1/events/{id}/activity?cursor&limit` (player, active member) through a
    definer `member_activity(event, after_id, page)` on the ledger: the player's own entries only, newest first, `{id,
    at, kind, scoreDelta, balanceDelta, reason: {type: "quest", questId, title}}`; a pending member gets
    `membership_pending`, anyone else `not_enrolled`. Opened from Home ("History"), a plain list screen
    `app/event/[eventId]/history.tsx`. A deleted quest cannot be (deletes are refused once completed), so titles always
    resolve.

## Tests

- Database: `member_activity` returns only the caller's own entries for the event, newest first, paged by id; nothing
  for pending, left, banned, strangers, another organizer's player or no player; closed to PUBLIC.
- HTTP: the history route's answers and errors; the route inventory and the cross-tenant classification.
- App (Vitest): `readScan` (a valid quest URL, the staging host only in development, wrong host, wrong path, wrong
  length, wrong format byte, a join link, plain text, an Arabic-Indic or padded string); the base64url decoder; the scan
  pause rule; the celebration's step machine (scanned → celebrating | refused | network → retry with the same key);
  `countSteps`; `readActivity`.
- Mutation on the new app and API modules.

## Phases

1. **Database and API:** the history definer and route, tests, mutation.
2. **App:** dependencies and config, `readScan`, the scanner screen, the celebration, reduce motion, the balance count,
   the history screen, tests, `expo export` and `expo-doctor`.
3. **Docs:** API.md, DATA_MODEL, STORE_COMPLIANCE (the permission text in place), TASKS (tick; notes for T-205, T-117,
   T-3xx NFC, T-401), Q-103, STATE.

## Revision 1 (after CTO plan review 1, 88/100): overrides the sections above where they differ

- **M1, the host:** shared `QUEST_CODE_HOSTS` holds `questify.nafes.com`. The app adds one optional build variable,
  `EXPO_PUBLIC_QUEST_CODE_ORIGIN`, checked the way `apiBaseUrl` checks `EXPO_PUBLIC_API_URL` (https only; a malformed
  value stops the app at start). The development default is the staging web origin. A staging demo build sets it, so
  staging QRs scan on real phones; there is no `__DEV__` rule. The host check is for the experience only: the server's
  HMAC decides.
- **m2, the tab:** `scan.tsx` stays as a never-shown placeholder (the `scan` tab owns the round button). The button now
  opens `scan-quest`. The `scan.soon*` messages and the `soon` state in `_layout.tsx` and `QuestSheet.tsx` go, and the
  T-113 note in TASKS is corrected.
- **m3, the category step:** `categoryJustFinished(view, questId, answer)` is pure and tested. After a completion the
  scanner calls `fetchQuests` itself. The category celebration plays when the answer is not a replay, the scanned quest
  is now `done`, and every quest in its category is `done`. That same read gives the celebration the quest's title.
  Tested: a replay, a repeatable quest below its cap, the last quest, an already-complete category, a quest not found.
- **m4, another event's code:** paid in its own event (correct). When the quest is not in this event's quests, show
  "+N points" with a line saying it counted in another event, and skip the category step. Tested.
- **m5, scanner copy per answer** (ux-araby, both languages):
  - `completed`: +N points;
  - `wrong_code`: the API's words;
  - `not_open`: by reason;
  - `limit`: the quest's limit;
  - `reload` (404, `enrollment_inactive`): "This quest isn't available to you";
  - `wait`: the seconds;
  - `failed`: Retry, with a new key;
  - `network`: Retry, with the same key;
  - `signed_out`: the existing sign-out path.
  - A scan that is not a quest code: "This isn't a Questify code".
- **m6, the guard:** a ref guard plus `onBarcodeScanned={paused ? undefined : handler}`. The same unrecognised value
  shows and buzzes once only (`scanGate`, pure, tested).
- **m7, permissions:**
  - not asked: an explanation card with Allow;
  - denied with `canAskAgain`: Allow again;
  - denied without it: Open settings;
  - re-checked when the app returns to the front.
- **m8, the history contract:**
  - The answer is `{entries, nextCursor}`; `nextCursor` is the last ledger id as a string, or null.
  - `limit` defaults to 25 and is capped at 100, in the route and in the definer.
  - A malformed cursor is 400.
  - Hidden quests' entries still show (no `visible` filter).
  - `readActivity` shows an unknown `kind` or `reason.type` without breaking.
  - Tested with two enrollments of the same player in different events.
- **m9, the haptics:** `impactAsync(Light)` at the read, `notificationAsync(Success)` on the server's confirmation,
  `Error` on a refusal.
- **m10, the manifest:** `expo prebuild --no-install` into a scratch folder. Assert the camera permission is present
  and `RECORD_AUDIO`, `READ_MEDIA_IMAGES`, `NSMicrophoneUsageDescription` and `NSPhotoLibrary*` are absent. The result
  goes in STORE_COMPLIANCE.
- **m11:** the FR-303 demo picker note goes on T-710, not T-117.
- **Nits:**
  - The Arabic camera text goes through the app config's top-level `locales` (`ar.json` with
    `ios.NSCameraUsageDescription`); on Android the in-app card is the Arabic disclosure.
  - The tick records that the coin flight became Home's count-up.
  - The count-up runs only from a value already shown in the same event.
  - The camera is unmounted when the modal loses focus or the app goes to the background.
