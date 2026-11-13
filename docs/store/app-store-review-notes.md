# App Store Connect: App Review Information, Notes for Review, demo event

Prepared 2026-11-13 for Apple 2.1(a), 2.3.1(a), 2.5.2, 5.1.1(v) (STORE_COMPLIANCE 1.3 to 1.5, 1.10). Where: App Store
Connect, the version page, App Review Information. Placeholders in `{{ }}` are filled on the day of submission from the
console's **App Review demo** page (RUNBOOK "The App Review demo"); nothing secret is written in this repo.

## 0. Fill-in values (from the console, same day)

| Placeholder | Where it comes from |
|---|---|
| `{{REVIEWER_PHONE}}` | Questify's own reviewer SIM, typed on the console page when the demo is created (Q-520: not chosen yet) |
| `{{REVIEWER_CODE}}` | **Prepare for review** shows a new six-digit code **once**; paste it straight into the Password field and into Play Console |
| `{{WINDOW_END}}` | Same page: the review window (14 days by default, 30 at most). Choose it to outlast both reviews; Apple often takes 1 to 3 days, longer after a rejection, so use 30 |
| `{{JOIN_CODE}}` | Same page: the demo event's join code |
| `{{WEB_ORIGIN}}` | Production web origin (G3) |
| `{{STATION_LINK}}` | The station page paired beforehand for the screen-QR quest (RUNBOOK review-day items) |
| Contact fields | Dhia's name, phone and email (App Review Information requires them) |

## 1. App Review Information form

| Field | Value |
|---|---|
| Sign-in required | **Yes** |
| User name | `{{REVIEWER_PHONE}}` (in international format) |
| Password | `{{REVIEWER_CODE}}` (the six-digit code; the app asks for it as "Code") |
| Contact | Dhia, phone and email that answer within a day |
| Attachment | `Questify-review-qr.pdf`: the sample QR codes (section 4) and, if wanted, section 3 as a PDF |

Why the unusual "password": Apple reviewers cannot receive an SMS (STORE_COMPLIANCE 1.3, item 1). While the review window
is open the server accepts one fixed code for one phone number in the demo tenant only (ADR-561, ADR-563), and sends
no SMS. The rule lives in the database's sign-in functions, is rate-limited, audited, and covered by an outsider test
that proves the code fails for every other number.

## 2. Notes for Review (paste; about 3,400 characters; the field's limit is 4,000 **[form]**)

```
SIGN IN (no SMS needed)
1. Open the app, tap Skip on the intro, tap Sign in, accept the terms and privacy policy ("Accept and continue").
2. Mobile number: the one in the User name field. Tap "Send the code". No SMS is sent to it during review.
3. Enter the Password-field value (6 digits) as the code, tap Confirm. The account already exists: no profile step.
The code works for this number and the demo event only, until {{WINDOW_END}}. Questify has its own sign-in (phone or email with a one-time code) and no third-party sign-in, so Sign in with Apple does not apply. Phone numbers are Saudi (+966) by design; email codes also work.

THE DEMO EVENT
Home > "Event code or link": type {{JOIN_CODE}} > Open > Join. "App Review Demo" is a permanent live event of a fictional organizer. Its ranking players, brand and prizes are fictional (digital prizes carry DEMO- codes). Nothing is sold anywhere in the app: no purchase, no points for money, no ads, no tracking.
Every quest type in this build is in it: scan a QR code, enter a code, send an answer (text or photo), vote and a live poll, quiz, challenge, survey, share (opens the system share sheet; the player picks app and recipients; nothing is posted for them), passport, check-in at a spot (its QR is the alternative), meet someone, mini-games (memory match, slide puzzle: native code, results checked by the server), an NFC quest (every NFC quest also has its QR), a screen-QR quest (open {{STATION_LINK}} on any screen and scan it) and kiosk quests.
No camera available? Scan tab > "Pick a code (review only)" lists the event's codes; picking one works as a scan. Printed codes are attached.
The account is played to level 3, so Profile > My locker shows its level items. Items come only from levels, achievements and souvenirs; none can be bought, traded or gifted.

WHAT TO TRY
Quests tab: finish a few quests; points and the ranking update. Rewards tab: reserve a reward (points are held; a code or pickup follows). Event info: Official Rules (they name Questify as administrator and state Apple is not a sponsor). Profile: language switch (Arabic is right to left), Notifications, Blocked accounts, Download my data.
Safety: terms and community guidelines are accepted before the first submission. Photo wall (when visible): every photo has Report and Block; photos appear only if their owner allowed it and the event team picked them. Player profiles have Report and Block; quests, rewards and announcements have Report. Get help sends a private request to the event team.
Permissions, all optional and never required to earn or redeem anything: camera (scan, photos), location while the app is open (check-in quests and fair play; QR instead), notifications (asked after joining), NFC. No microphone, no photo-library access, no background location.
Delete account: Profile > Delete account > send the confirmation code (the same code works) > confirm. The next sign-in makes a fresh reviewer account.

REMOTE CONFIGURATION (2.5.2, 2.3.1(a))
The server changes data only (names, points, prizes, which reviewed features an event uses). Every feature is in this binary and on in the demo event; no code is downloaded except EAS Update JavaScript for fixes. Live polls, community goals, flash quests and boosts are decided by the server and shown from the app's own polling (no push needed).

Questions: {{CONTACT_EMAIL}}.
```

## 3. Longer walkthrough (attach as a document; also the reviewer's cheat sheet)

Use the numbered path the review expects: join, quest, points, leaderboard, redeem, report/block, delete account
(STORE_COMPLIANCE 1.3 item 4). Paths below are the labels in the app's English strings (`packages/shared/src/i18n/messages.ts`).

1. **Intro and language.** First launch shows a language choice and four cards (`/intro`); Skip is on every step and
   nothing is asked of the system. Arabic and English are both complete.
2. **Sign-in.** "Before we start" (terms, privacy) > "Mobile number" > "Send the code" > "Enter the code" > Confirm.
3. **Join.** Home > "Event code or link" > Open > the join card says which answers the event team receives and whether
   other players see a full name; > Join.
4. **Quests.** Event tabs: Home, Quests, Ranking, Rewards, Scan, Profile. Open a quest, finish it, see points and
   the toast. Quest types and what to expect:

| Quest type (registry) | In the demo event | Reviewer path | Notes for the claim |
|---|---|---|---|
| `scan_qr` | several, one per verification: quest QR, My QR, NFC, screen QR, kiosk | Scan tab, or "Pick a code (review only)" | Camera is asked when the scanner opens, never at launch |
| `enter_code` | one | Quest sheet > type the code (in the quest hint) | |
| `submission` | text, and photo if storage is live (G6) | Quest sheet > write, or take or pick a photo | System picker; no library permission. Points are held until the team approves unless the quest auto-approves |
| `vote` | one, plus the live poll card on Home | Vote on the organizer's written options | Never a vote on a person's looks (PD-13) |
| `quiz`, `survey`, `challenge` | one each | Answer; challenge is organizer-verified | |
| `share` | one | Quest sheet > Share | Pays once per player and quest; the organizer can switch share quests off |
| `passport` | one | Collect steps by their codes | |
| `location` | one, with a QR alternative | "Check in" > continue > system location prompt, or scan the QR | Needs the platform switch `locationQuests` on (G7) |
| `meet` | one | Scan tab > pick the meet code (a fictional player's one-minute pass) | |
| `game` | memory match, slide puzzle | Play; attempts unlimited with a 1-minute cooldown | Native code; never sold |

5. **Event features switched on in the demo** (STORE_COMPLIANCE 1.3 item 4, each as already agreed): live poll with
   1,440 minutes; community quest with a running goal and an unlock step; a scheduled flash quest and a boost;
   NFC quest; paired station for the screen-QR quest; announcements; agenda sessions; cheers (when a moment is started);
   photo wall (when storage is live); streaks, daily challenge and daily word (Questify home, platform switches on).
6. **Ranking.** Ranking tab: fictional players with seeded points and the reviewer.
7. **Redeem.** Rewards tab > a reward > Reserve > rules sheet on the first redemption > confirmation; a digital reward
   shows its `DEMO-` code. Points are spent only on organizer prizes at a fixed price.
8. **Report and block.** Report is on a quest, reward, announcement, session, sponsor, event page, profile and ranking
   row (`ReportButton.tsx`); Block is on a player's profile and on a photo of the wall (`BlockButton.tsx`);
   Profile > "Blocked accounts" lists and unblocks.
9. **Staff mode.** The account is an operator of the demo event allowed to play: staff screens (pair a device, rotating QR)
   are reachable from a staff block on Questify Home (`OperatorEvents.tsx`). Needed for 2.1(a) "staff or organizer mode needs its own credentials": it is the same account.
10. **Delete account.** Profile > "Delete account"; a web page does the same: `{{WEB_ORIGIN}}/en/delete-account`.

## 4. Sample QR codes (attach as images)

Make them from the console's review page or the dashboard after Prepare: one image per printable quest code (scan,
passport steps, the hidden category's secret code, the NFC quest's QR), plus the join QR. Each encodes the signed
address the printed sticker carries. **They must carry the production web origin (G3)**, so make them after that
origin is fixed. Also attach the event's join code as text (it is already in the notes).

## 5. Review-day checklist (RUNBOOK "The App Review demo", T-806 notes)

- Phone check done: the push go-live checklist passed and is recorded (T-806 Done-when).
- Readiness list on the console page has no "missing" line.
- Prepare for review with this build's version; sign in as the reviewer once and **play to level 3 (at least 40 gems)**
  (T-404 note). Do not Prepare again after that: it would wipe the level (Q-522). If a rejection needs another
  window, Prepare, then play to level 3 again.
- Backend, SMS gateway, push and storage are live and watched while the review runs (STORE_COMPLIANCE checklist "Both").
- Test the credentials from a clean install on a phone that is not Dhia's the same day.
- After both reviews finish: **Close window** (the fixed code stops, the reviewer is signed out, the number becomes an
  ordinary number again and gets real SMS).
- If the reviewer guesses past the limits, the log line `review_demo.code_guessing` fires; **Prepare** gives a new code.

## 6. Replies to expect (prepared answers)

| Apple may ask | Answer |
|---|---|
| "Is the contest sponsored by the developer? (5.3.1)" | The official rules in the app name Questify as the administrator and the organizer as prize provider, and state Apple is not a sponsor (`rules.administrator`, `rules.notSponsors`). Q-040 (counsel) is open |
| "Why does the account have a fixed code?" | See section 1: the review window only; for this one number and the demo tenant only |
| "Which features can a flag turn on?" | Only the ones in this binary and on in the demo event (PD-02, ADR-007); kill switches turn things off |
| "Why does the app ask for location?" | Optional check-in quests and fair-play checks, while the app is open; every location quest also has a QR; refusing blocks nothing (ADR-015, PD-08) |
| "Why NFC?" | Optional tap-to-check-in at tagged stickers; reading is user-started; every NFC quest also has a QR |
| "Is there user-generated content?" | Yes: see Safety in the notes and `app-store-age-rating.md` |
