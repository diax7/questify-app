# The full phone demo (staging)

For Dhia, testing alone on his Android phone and his iPhone against staging. Staging holds fake data only.

- Player app: **https://questify.nafes.com/play** (the real app, running in the phone's browser).
- Dashboard: **https://questify.nafes.com/en/sign-in** (works in a phone browser too).
- The event: **Questify Full Demo / عرض كويستفاي الكامل**, by the organizer **Questify Demo Organizer**. Its join code
  is printed at the top of the QR sheet and on the dashboard's event page.

The event was built by `scripts/demo/full-demo.mjs` (how it runs: the last section). It holds 19 quests of every kind the
product has, 5 shop rewards (2 with reward codes), 2 rank prizes, a community goal, a map, 2 sponsors, Home blocks and a
2-talk agenda.

## What you need

- Both phones, and something to show QR codes: the printed sheet, a laptop screen, or one phone's screen while the other
  scans.
- Your mailbox. Every sign-in is a 6-digit code by email (or by SMS for a Saudi number, see "Signing in").
- About an hour for everything; 15 minutes for the core loop (sign in, join, scan, rank, redeem).

## 1. Sign in to the dashboard (once)

The demo organizer's owner account uses the address you gave the coordinator. Its password is a random one nobody knows.

1. Open https://questify.nafes.com/en/forgot-password, type that address, open the email, set your own password.
2. Sign in at https://questify.nafes.com/en/sign-in: password, then the emailed code.
3. You see **Questify Demo Organizer** and the event **Questify Full Demo**. Open it.

If the event page says it waits for activation: sign in to the console with your Questify admin account (in a private
tab, so the owner session stays), open **Events**, find the demo event and **Activate** it, ticking **Big screen**. This
is the real T-210 path. The event starts within 2 minutes of being built, so once active it is live.

## 2. Install nothing: open the app in the browser

On each phone open **https://questify.nafes.com/play**. On the iPhone, Safari's Share, **Add to Home Screen** makes it
open full screen; on Android, Chrome's menu, **Add to Home screen**. Allow the camera when the scanner asks.

There is no installable staging build of the native app right now (the iPhone needs the Apple account, T-010; installed
older builds break on sync until rebuilt). The browser app is the same code; the differences are listed under "Known
gaps".

## 3. Signing in on the phones

- **Email (recommended):** phone 1 with your address, phone 2 with a plus address of it, for example
  `dhia+phone2@...`: it lands in the same inbox and counts as a second player. Codes take a few seconds.
- **SMS:** only a Saudi mobile (+966 5...). SMS goes through Msegat from the CranL server; it has not been proven from
  staging yet (Msegat's static-address check, `M0037`). Try it on one phone; if no code arrives within 2 minutes, use
  email. Please tell the coordinator which happened.
- Accept the terms, pick a username, a birth year and an avatar.
- **Join:** type the join code (or open the join link from the sheet). You land on the event's Home.

You can be signed in to the dashboard and to `/play` in the same phone browser at the same time: they are separate
sessions. A second tab for the dashboard is the easiest way to act as organizer and player on one phone.

## 4. What to try, and what you should see

Points below are the demo's; the ranking refreshes within about 15 seconds.

### Home

- A welcome banner, a "Doors" text card, a countdown to the demo's end, a featured **Coffee voucher**, the community
  goal's progress, the sponsors. Switch the language (Profile) to Arabic: everything turns right to left, digits stay
  0 to 9.

### Explore the venue

| Quest | How | You get |
| --- | --- | --- |
| Welcome desk | Scan its QR with the app's **Scan** button | 20 |
| Main stage | Scan its QR; it also has a pin on the map | 30 |
| Secret word | Type `FALCON` (any case) | 25 |
| Venue passport | Scan 3 of the 4 stamp codes (Hall A, Hall B, Food court, Sponsor booth) | 60 on the third stamp |
| Flash: coffee corner | Hidden until you launch it: dashboard, **Quests**, the flash quest, **Launch**. It appears on the phones for its window; scan its QR | 40 |

Scan from inside the app. The phone's own camera opens the code's web page, not the quest.

### Games and quizzes

- **Saudi trivia**: 3 questions, 30 seconds each, 15 points per right answer, one attempt.
- **Memory match, Slide puzzle, Catch the stars, Tap rush**: 35 points on the first pass; unlimited tries, one minute
  apart.

### Have your say

- **Best talk of the day** (vote): one choice, results show after you vote. 10 points.
- **Live poll: lunch**: not visible until you send it: dashboard, **Quests** (or **Control**), the poll, **Send**. It
  stays open 24 hours. Vote on both phones and watch the results.
- **Quick feedback** (survey): a 1 to 5 rating, a choice, an optional text. 20 points. The answers appear on the
  dashboard without names.
- **Tell us your best moment** (text submission): goes to the dashboard's **Submissions** for review. Approve it there:
  the phone gets 30 points and an inbox note. Reject one too, to see the player's side.
- **Say hello**: approved at once, 5 points.

### Meet and share

- **Meet someone new**: phone 1 opens it and shows its meet code; phone 2 scans it. Both get 15 points. A pair meets once.
- **Invite a friend**: shares the message through the browser's share sheet (or copies it). 10 points.
- **Photo pose at the booth** (challenge): done in front of staff. On the dashboard, **Awards**, give it to your player:
  50 points. (The staff station that scans a player's My QR is in the native app only.)

### The secret room

- The category is hidden. Scan the **Reveal: The secret room** code on the sheet: it appears. Then **Open the vault**:
  type `VAULT42` for 100 points.

### Rewards

| Reward | Price | What happens |
| --- | --- | --- |
| Coffee voucher | 30 | Digital: a code such as `DEMO-COFFEE-001` shows at once |
| Bookstore 10% off | 80 | Digital, the same way |
| Fresh juice | 15 | Reserved; collect at the prize desk within an hour |
| Questify tote bag | 50 | Reserved, tagged New |
| Front-row seat | 120 | An experience, tagged Limited, 5 in stock |

On the dashboard, **Rewards** shows the stock going down and the codes left; **Prizes** shows what is reserved. Handing a
reserved prize over at the desk is a staff phone job in the native app.

### Ranking, prizes and the goal

- **Ranking**: both phones, each sees the other. The top 3 win prizes: a **Gold trophy** for 1st, a **Backstage tour**
  for 2nd and 3rd (shown under the ranking's prizes and the rules).
- **50 quests together** (community goal): every completion counts for both players. At 5, a message; at 20, 10 points
  each; at 50, 25 points for everyone.

### Map and agenda

- **Hall map**: sections, the sponsor booth, prayer room, toilets, food, and the Main stage quest's pin.
- **Agenda**: two talks, "Opening keynote" and "Design for Arabic".

### Things to do from the dashboard while the phones watch

- **Announcements**: send one; it arrives in the phones' inbox (no push in a browser).
- **Boosts**: start a short double-points boost, then scan or play something.
- **Big screen** (when the event was activated with it): open the screen link on a laptop or TV and watch the ranking move.
- **Layout**: reorder or hide a Home block, then reload the phone.
- **Players**: see both accounts, their points and history.

### Questify Home (outside the event)

- The **daily word** game: five letters, six guesses, in Arabic and English. If the coordinator signed the script in as
  an admin, there is a word every day from the day after the build. A day with no word shows no game.

## Known gaps on this demo

- **No photos.** Photo storage is off (Q-149): submissions are text only, and no image can be uploaded anywhere.
- **The browser app has no NFC, no push notifications, no vibration and no recap image to share.** Staff tools (stations,
  the prize desk, writing NFC tags, pairing a screen) are native-app only and hidden in the browser.
- **No other players.** The ranking holds only your two accounts: the script uses real sign-ups only, and fake accounts
  would need real mailboxes.
- **Location quests** are off for the whole platform (they need a log check first), so the demo has none.
- **Email codes:** at most 5 sign-in codes an hour per staff account; player codes have a daily budget of 1,000 for the
  whole platform. Too many wrong codes pause that address for a while; wait, or use the other address.
- The **App Review demo** is a different event and cannot be joined by your own accounts (it keeps its own reviewer
  account in, and everyone else out).

If something does not behave as written here, note the time, the phone and the screen, and tell the coordinator.

## The printed codes

The script writes `demo-codes.html` (A4, English and Arabic, no network needed): the `/play` link, the join code and
link, the 3 quest codes, the 4 passport stamps, the secret room's reveal code and the two typed codes. Print it, or keep it
on a laptop screen. The dashboard's own **Codes** page of the event prints the same quest codes.

## For the coordinator: running the script

The script only calls the public API, as the dashboard does. It refuses any API host but the exact https staging one (or a local
one). Nothing secret is printed or stored in the repository. The state file `~/.questify-demo/<api host>.json` (mode 0600,
written whole through a temporary file and a rename) holds the pending challenge, the session cookies and the owner
password only when the script generated it; a `DEMO_OWNER_PASSWORD` or `DEMO_ADMIN_PASSWORD` from the environment is
never written. A state file that is not valid JSON stops the run ("state file unreadable"); fix or delete it.

```sh
# First time: make the owner account and its organizer; the code goes to DEMO_OWNER_EMAIL (Dhia's mailbox).
DEMO_OWNER_EMAIL='<dhia+demo@...>' node scripts/demo/full-demo.mjs signup
DEMO_CODE='<6 digits from Dhia>' node scripts/demo/full-demo.mjs code
# Optional, for activation and the daily word: a Questify admin account (password from the environment).
DEMO_ADMIN_EMAIL=... DEMO_ADMIN_PASSWORD=... node scripts/demo/full-demo.mjs login --as admin
DEMO_CODE='<6 digits>' node scripts/demo/full-demo.mjs code --as admin
# Build (again any time: it adds or tops up only what is missing), then the QR sheet is in ~/.questify-demo/demo-codes.html.
node scripts/demo/full-demo.mjs build
# Also fill the daily word for the next 6 days, turning the staging-wide word cadence to daily (see below):
node scripts/demo/full-demo.mjs build --daily-word
# A fresh event with a new join code (the old one is ended; if it cannot be ended the build stops):
node scripts/demo/full-demo.mjs build --reset
node scripts/demo/full-demo.mjs logout
```

A later sign-in (`login`, then `code`) needs a new emailed code: a staff session ends after a while. Without the admin
step the event waits in the console's activation queue (Dhia activates it, section 1).

**Exit status.** `build` exits 1 when any step was SKIPPED (a feature the platform keeps off, a refused call): the QR sheet
is still written and the SKIPPED lines are listed, but the build is not complete. Fix the cause and run `build` again: it
tops up a half-built item (reward codes, map pins, a sponsor's tag). `build` writes the shop settings only when they differ
from the demo's.

**The daily word (`--daily-word`).** The word's cadence is one setting for the whole staging platform, not for the demo
event, so `build` leaves it alone unless you pass `--daily-word`. With the flag, when today has no word and the cadence is
not daily, it turns daily from the next Questify day (the log says what it was, for example `was weekly`), and the next 6
days (tomorrow on; today's period has started and cannot take a word) are filled in both languages. Without the flag a
cadence that is not daily is left alone and no words are set. To revert, as a Questify admin send
`PUT /v1/admin/daily/cadence` with `{"kind":"word","cadence":"weekly"}` (or the previous value) and an `Idempotency-Key`;
the change applies from the next Questify day, and words already set stay in the bank. Tested end to end on the local
test database: `apps/api/test/demo/full-demo.int.test.ts`.
