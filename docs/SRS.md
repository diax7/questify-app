# Software Requirements Specification — Questify

> The numbered list of what Questify must do. Each item is testable and has a permanent ID.
> **v1 draft, 2026-10-17, revised after the Stage 1 review.** The master spec (see `README.md`).

## How to read this

- **What it's based on:** `FEATURES.md` (the prioritized features), `SCOPE.md` (the v1
  boundary) and `DECISIONS.md` (the ADRs). When they disagree with this file, the ADRs win, and
  this file is corrected.
- **IDs:** `FR-` numbers are grouped by area. FR-1xx is Area 1, FR-2xx is Area 2, and so on;
  FR-10xx to FR-15xx cover Area 10 onward. Gaps in the numbering are allowed. IDs are never
  reused (CLAUDE.md).
- **Priority** comes from the feature. Everything below ships in v1 (ADR-069); the priority
  sets the build order.
- **"Organizer-set value"** means a setting the organizer chooses on the dashboard.
- **Surfaces:**
  - "The app": the mobile app players and operators use.
  - "The dashboard": the organizer's website.
  - "The Questify console": Questify's own admin site.
  - "The system": wherever the behavior lives.

## 1. Functional requirements

### 1.1 Area 1 — Joining and onboarding

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-101 | The app shall let a signed-in player join an event by typing its event code. | Must | F-01 | Given a valid event code, when the player enters it, then the app opens that event's join card. Given a code that matches no event, when the player enters it, then the app says the code was not found and no event is joined. |
| FR-102 | The app shall let a player join an event by scanning its join QR with the in-app scanner. | Must | F-01 | Given an event's join QR, when the player scans it in the app, then the app opens that event's join card. Given a QR that is not a Questify join QR, when the player scans it, then the app says it is not an event code and no event is joined. |
| FR-103 | The app shall open an event's join card when a player opens that event's invite link on a phone with the app installed. | Must | F-01 | Given the app is installed, when the player taps the event's invite link, then the app opens on that event's join card. Given an invite link for an event that no longer exists, when the player taps it, then the app says the event is not available. |
| FR-104 | The app shall show public (listed) events in a public events list and shall never show private events there. | Must | F-01, F-70 | Given one public and one private event, when anyone opens the public events list, then only the public event appears. Given a public event, when the player taps it in the list, then its event page opens. |
| FR-105 | The system shall let a player join a private event only through its event code, join QR or invite link. | Must | F-01 | Given a private event, when a player uses its code, join QR or invite link, then its join card opens. Given a private event, when a player searches the public events list, then it is not found. |
| FR-106 | The app shall let a person sign in with a Saudi phone number (+966) by entering a one-time code sent by SMS. | Must | F-69 | Given a +966 number, when the person requests a code and enters the code received, then they are signed in. Given a wrong or expired code, when the person enters it, then sign-in is refused with a message to request a new code. |
| FR-107 | The app shall let a person sign in with an email address by entering a one-time code sent by email. | Must | F-69 | Given an email address, when the person requests a code and enters the code received, then they are signed in. Given a wrong or expired code, when the person enters it, then sign-in is refused with a message to request a new code. |
| FR-108 | The app shall refuse phone numbers outside Saudi Arabia (+966) and point the person to email sign-in. | Must | F-69 | Given a +966 number, when the person submits it, then a code is sent. Given a number with another country code, when the person submits it, then no code is sent and the app offers email sign-in instead. |
| FR-109 | The app shall offer no password sign-in and no Apple, Google or other social sign-in. | Must | F-69 | Given the sign-in screen, when it opens, then the only options are a +966 phone number and an email address. Given any sign-in step, when it is shown, then it has no password field. |
| FR-110 | The system shall limit how many login codes can be sent per phone number, per email address and per device. | Must | F-69 | Given a number below its limit, when a code is requested, then it is sent. Given a device that has reached its limit, when it requests a code for a different number or address, then the request is refused with a message that says when to try again. |
| FR-111 | The app shall let a person without an account browse public events, an event's quests and its prizes. | Must | F-70 | Given a person who has not signed in, when they open a public event, then they see its quests and prizes. Given that person, when they browse, then no sign-in screen is shown until they try an action that earns points or joins a private event. |
| FR-112 | The app shall ask the person to sign in when they tap Join on an event's join card, and shall award no points and join no event without an account. | Must | F-70 | Given a person who has not signed in, when they tap Join, then the app asks them to sign in and joins the event only after sign-in succeeds. Given that person, when they close the sign-in screen without signing in, then no event is joined and no consent is recorded. |
| FR-113 | When a join QR or invite link is opened on a phone without the app, the system shall send the person to the event web page and the app store, and the app shall open that event's join card after install. | Must | F-71, F-72 | Given an Android phone without the app, when the person scans the join QR, installs the app and opens it, then the app opens that event's join card. Given a phone with the app already installed, when the person opens the link, then the app opens directly without the store. |
| FR-114 | On iOS, the event web page shall copy the event code and the app shall offer to paste it with one tap on first open. | Must | F-71 | Given an iPhone without the app, when the person opens the event web page, installs the app and opens it, then the app offers a one-tap paste that opens that event's join card. Given the person declines the paste, when the app opens, then no event is joined and the code can still be typed by hand. |
| FR-115 | The system shall provide a web page for each event that shows its banner, its prizes and buttons to the App Store and Google Play. | Must | F-72 | Given an event with a banner and prizes, when anyone opens its web page in a browser, then the banner, the prizes and both store buttons are shown. Given a private event, when its page is opened from its invite link, then the page loads without sign-in. |
| FR-116 | The event web page link shall produce a link preview of the event when shared in WhatsApp and social apps. | Must | F-72 | Given an event web page link, when it is pasted into a WhatsApp chat, then a preview of the event appears. Given the organizer changes the event banner, when the link is shared again, then the preview uses the new banner. |
| FR-117 | At sign-up, the app shall ask for a username, an avatar from Questify's set and a birth year, and shall not ask for the real name. | Must | F-73 | Given a new account, when sign-up runs, then it asks only for username, avatar and birth year. Given a person who tries to continue without a username, avatar or birth year, when they tap continue, then the app asks for the missing item. |
| FR-118 | The system shall filter usernames as user content and refuse a username that fails the filter. | Must | F-73 | Given an acceptable username, when the person submits it, then it is saved. Given a username that fails the filter, when the person submits it, then it is refused with a message to choose another. |
| FR-119 | The app shall refuse sign-up, with a kind message, when the current year minus the birth year is less than 13. | Must | F-73 | Given it is 2026 and the birth year is 2013, when the player submits it, then sign-up continues (year-based rule, ADR-075). Given the birth year is 2014, when the player submits it, then sign-up stops with a kind message and no account is created. |
| FR-120 | The system shall show only a player's username and avatar anywhere other players can see them. | Must | F-73 | Given a player who gave a full name as an event join field, when another player views a leaderboard, then only the username and avatar are shown. Given any screen visible to other players, when it shows that player, then no phone number, email or real name appears. |
| FR-121 | Before joining, the app shall show a join card with the event's official rules and what the organizer will receive, with one Join button. | Must | F-74 | Given an event, when the player opens its join card, then the rules, the list of data the organizer receives and one Join button appear on that card. Given the player leaves the card without tapping Join, when they return to the app, then they are not a member of the event and nothing has been shared. |
| FR-122 | The system shall let one account be a member of several events at once, from any organizers, and the app shall provide an event switcher. | Must | F-75 | Given a player in two events from two organizers, when they open the event switcher, then both events are listed. Given the player switches to the second event, when it opens, then its quests, score and balance are shown and the first event's points do not appear. |
| FR-123 | The app shall keep the player signed in across app launches until they sign out. | Must | F-76 | Given a signed-in player, when they close and reopen the app, then they are still signed in and no code is asked. Given a player who signed out, when they reopen the app, then they are signed out. |
| FR-124 | The app shall let a player sign out after a confirmation screen that explains what signing out does. | Must | F-76 | Given a signed-in player, when they tap Sign out and confirm, then they are signed out. Given the confirmation screen, when the player cancels, then they stay signed in. |
| FR-125 | The app shall let a player change their phone number or email address, applied only after a fresh one-time code sent to the new number or address is entered. | Must | F-76 | Given a new +966 number, when the player enters the code sent to it, then the account uses the new number. Given a wrong or expired code, when the player enters it, then the old number or address stays on the account. |
| FR-126 | The app shall let a player delete their account, after a confirmation screen, removing their profile, points, submissions, votes and items. | Must | F-77 | Given a player who confirms deletion, when deletion completes, then their profile, points, submissions, votes and items no longer exist and they no longer appear on any board. Given the confirmation screen, when the player cancels, then nothing is deleted. |
| FR-127 | The system shall let a person delete their account from a web page, with the same effect as deletion in the app. | Must | F-77 | Given a person who verifies their account on the deletion web page and confirms, when deletion completes, then the account and its data are deleted as in FR-126. Given a person who cannot verify ownership of the account, when they request deletion, then nothing is deleted. |
| FR-128 | On account deletion, the system shall keep prize-handover records only for as long as the law requires, and the deletion screens shall say so. | Must | F-77 | Given a deleted account that received a prize, when deletion completes, then the prize-handover record remains and is deleted once the legally required period ends. Given an account with no prize handovers, when it is deleted, then no record of it is kept. |
| FR-129 | The dashboard shall let the organizer add up to 5 join fields per event, chosen from full name, company, job title, department, ticket number or a custom field, each marked optional or required. | Should | F-78 | Given an event with 4 join fields, when the organizer adds a fifth, then it is saved. Given an event with 5 join fields, when the organizer tries to add a sixth, then the dashboard refuses it. |
| FR-130 | The app shall show the event's join fields on the join card and shall not let the player join until every required field is filled. | Should | F-78 | Given an event with a required company field, when the player fills it and taps Join, then they join. Given the same field left empty, when the player taps Join, then the app points to the empty field and the player does not join. |
| FR-131 | The system shall share join-field answers only with the organizer of that event. | Should | F-78 | Given a player who answered join fields in event A, when event A's organizer views the player list, then the answers are shown. Given a different organizer or another player, when they view that player, then the answers are not shown. |
| FR-132 | The dashboard shall let the organizer upload a guest list of phone numbers and email addresses for an event. | Should | F-79 | Given a list of numbers and addresses, when the organizer uploads it, then the event's guest list contains them. Given an entry that is not a valid phone number or email address, when the list is uploaded, then the dashboard reports that entry and does not add it. |
| FR-133 | The app shall show "You're invited" for an event to a signed-in person whose phone number or email is on its guest list, and let them join without a code. | Should | F-79 | Given a person whose email is on the guest list, when they sign in with that email, then the app shows "You're invited" for the event and they can join without a code. Given a person not on the list, when they sign in, then no invitation is shown. |
| FR-134 | The system shall let the organizer limit a private event to its guest list, refusing anyone not on it. | Should | F-79 | Given a private event limited to its guest list, when a listed person joins, then they join. Given the same event, when a person not on the list uses its code, QR or link, then the join is refused with a message that the event is by invitation. |
| FR-135 | The system shall let the organizer lock a private event to one or more email domains, so that only players with a verified email address on those domains can join. | Should | F-80 | Given an event locked to `@company.com`, when a player with a verified `@company.com` address joins, then they join. Given a player signed in only by phone or with an address on another domain, when they try to join, then the join is refused with a message naming the required domain. |
| FR-136 | When a player joins an event with a welcome reward, the system shall award the organizer-set amount and the app shall play the full coin-to-balance animation. | Should | F-81 | Given an event with a welcome reward, when a player joins, then the organizer-set amount is added and the coin-to-balance animation plays. Given an event whose welcome reward is turned off, when a player joins, then no welcome points are added and no animation plays. |
| FR-137 | The welcome reward shall count toward the player's score and balance like any other points. | Should | F-81 | Given a player who received a welcome reward, when they view their score and balance, then both include it. Given the points record, when the welcome reward is looked up, then it appears as an entry with its reason. |
| FR-138 | The app shall show a mascot intro of three skippable cards (quests, then points, then prizes) once per account. | Should | F-82 | Given a new account, when the player first reaches the app's home, then the three cards are shown in order and each can be skipped. Given an account that has seen or skipped the intro, when it signs in again on any phone, then the intro is not shown. |
| FR-139 | The app shall let any player add a second sign-in identifier (an email to a phone account, or a +966 number to an email account), applied only after a one-time code sent to it is entered; the player can then sign in with either. | Should | F-76, F-80 | Given a phone-only player, when they add `ali@company.com` and enter the code sent there, then their profile shows the verified email and they can join an event locked to `@company.com`. Given the email already belongs to another account, when they try to add it, then the app refuses and explains why. |

### 1.2 Area 2 — Quests

#### Quest types

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-201 | The app shall complete a scan-QR quest only from a live camera scan of the quest's QR, with no option to scan from saved images. | Must | F-03 | Given a player at the quest's QR, when they scan it with the in-app camera, then the quest is completed. Given the scanner, when the player looks for a way to load an image from the gallery, then none is offered. |
| FR-202 | The system shall allow one completion per player per quest, or up to the quest's repeat cap, and show a clear "already completed" message after that. | Must | F-03, F-92 | Given a player who has not completed a quest, when they complete it, then the points are awarded. Given a player who has reached the quest's limit, when they scan its QR again, then no points are awarded and the app shows "already completed". |
| FR-203 | The system shall complete a challenge quest only when a member of the event staff confirms it. | Must | F-04 | Given a player who finished a booth challenge, when an operator confirms it, then the quest is completed and its points are awarded. Given a player on a challenge quest, when no operator has confirmed it, then the quest stays incomplete. |
| FR-204 | The app shall let a player complete a submission quest with a photo from the in-app camera or the system photo picker, or with text, as the quest allows, without asking for photo-library permission. | Must | F-05 | Given a photo quest, when the player takes a photo or picks one through the system picker and submits it, then the submission is sent. Given the app on either platform, when the player submits a photo, then no photo-library permission prompt appears. |
| FR-205 | The system shall show submissions only to the organizer's team, never to other players. | Must | F-05 | Given a submitted photo, when the organizer's team opens the review queue, then they see it. Given another player in the same event, when they browse the app, then the submission is not visible anywhere. |
| FR-206 | The system shall hold a submission's points as pending until the submission is approved, unless the quest is set to auto-approve. | Must | F-05 | Given a submission on a quest without auto-approve, when it is sent, then its points show as pending and are not in the balance. Given that submission is rejected, when the player checks their points, then the pending points are gone and nothing was added. |
| FR-207 | The app shall let a player vote among the options the organizer set on a vote quest, and complete the quest with that vote. | Must | F-06 | Given a vote quest with three options, when the player picks one and submits, then the vote is recorded and the quest is completed. Given a player who already voted on that quest, when they open it again, then they cannot vote again. |
| FR-208 | The system shall award a quiz's points for each right answer. | Must | F-07 | Given a quiz of five questions, when the player answers three correctly, then they earn the points for three right answers. Given a player who answers every question wrong, when the quiz ends, then no points are awarded. |
| FR-209 | The app shall give one try per quiz question and show the right answer after the player answers. | Must | F-07 | Given a quiz question, when the player submits an answer, then the answer is locked and the right answer is shown. Given an answered question, when the player tries to change the answer, then the app does not allow it. |
| FR-210 | When the organizer sets a timer on a quiz, the app shall close each question at the end of the organizer-set time and award no points for it if unanswered. | Must | F-07 | Given a quiz with a timer, when the player answers correctly before time runs out, then the points are awarded. Given the time runs out before an answer, when the question closes, then it earns no points and the right answer is shown. |
| FR-211 | The system shall complete an enter-a-code quest when the player types the quest's code correctly. | Must | F-83 | Given a code shown on a slide, when the player types it correctly, then the quest is completed. Given a wrong code, when the player submits it, then no points are awarded, the app says the code is wrong, and repeated wrong tries are rate-limited. |
| FR-212 | The system shall complete a meet-someone quest for both players when either player scans the other's meet code (a one-minute code the shown player's app draws, ADR-209; amended 2026-10-24 from "personal QR"), and award both. | Should | F-84 | Given two players in the same event, when player A scans player B's meet code, then the quest is completed and points awarded for both. Given player B then scans player A, when the scan is checked, then no further points are awarded. |
| FR-213 | The system shall refuse repeat pairs on a meet-someone quest and stop a player at the organizer-set daily cap. | Should | F-84 | Given two players who already met on this quest, when either scans the other again on another day, then no points are awarded and the app says they already met. Given a player who reached the organizer-set daily cap, when they scan a new player, then neither player is awarded and the app says the daily limit is reached. |
| FR-214 | The system shall let a player complete a survey quest by answering questions that have no right answer, and send the results to the organizer only. | Should | F-85 | Given a survey quest, when the player answers its questions and submits, then the quest is completed and the answers reach the organizer's results. Given another player, when they view the event, then they cannot see anyone's survey answers. |
| FR-215 | The system shall complete a location check-in quest when the player is inside the quest's area, using location only while the app is open. | Could | F-86 | Given a player inside the area with location allowed, when they check in, then the quest is completed. Given a player outside the area, when they check in, then the quest is not completed and the app says they are not in the area yet. |
| FR-216 | Every location check-in quest shall also be completable by scanning the QR at that spot, and refusing location shall block nothing. | Could | F-86 | Given a player who refused location, when they scan the QR at the spot, then the quest is completed. Given a player who refused location, when they open the event, then every other feature works as before. |
| FR-217 | The app shall include built-in mini-games, and a game quest shall award its points for finishing the game or for passing the organizer-set target, not for raw score. | Should | F-87 | Given a game quest set to "finish", when the player finishes the game, then the points are awarded. Given a game quest with a target, when the player's result falls short of the organizer-set target, then no points are awarded and the player can see the target. |
| FR-218 | The system shall reject mini-game results that are impossible and award no points for them. | Should | F-87 | Given a valid result that passes the target, when it is submitted, then the points are awarded. Given a result that could not be reached in real play, when it is submitted, then it is rejected and no points are awarded. |
| FR-219 | The dashboard shall let the organizer turn share quests on or off per event. | Should | F-88 | Given an event with share quests on, when the organizer creates a share quest, then players can see and complete it. Given an event with share quests off, when players open the event, then no share quest is shown. |
| FR-220 | The system shall award a share quest's points when the player completes the phone's share action, with no proof step, once per player per quest. | Should | F-88 | Given a share quest, when the player completes the share action, then the points are awarded. Given a player who was already rewarded for that share quest, when they share again, then no further points are awarded. |

#### Quest content and rules

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-221 | The app shall show each event's quests in a list where every card shows what to do, where, the reward and the time it takes. | Must | F-02 | Given an event with quests, when the player opens the quest list, then each card shows what to do, where, the reward and the estimated time. Given an event with no visible quests, when the player opens the list, then the app shows an empty state instead of a blank screen. |
| FR-222 | The app shall show a quest's details: its steps with per-step progress, reward, estimated time, difficulty, tips and location. | Must | F-52 | Given a three-step quest with one step done, when the player opens it, then the steps show 1 of 3 done along with the reward, time, difficulty, tips and location. Given a quest with no tips or location set, when the player opens it, then those sections are not shown. |
| FR-223 | The dashboard shall hold every organizer-written quest field in Arabic and English, and the app shall show the version in the player's app language. | Must | F-52 | Given a quest written in both languages, when a player using Arabic opens it, then the Arabic text is shown right-to-left. Given the same player switches the app to English, when they reopen the quest, then the English text is shown. |
| FR-224 | The system shall support passport quests: a set of steps the organizer chooses, done in any order, completed when the player finishes the organizer-set number of them. | Must | F-90 | Given a passport quest of "5 of these 8 booths", when the player completes any 5 booths in any order, then the quest is completed. Given a player who has done 4, when they view the quest, then it shows 4 of 5 and is not completed. |
| FR-225 | The system shall let a quest be completed only between its start and end times. | Must | F-91 | Given a quest open from 10:00 to 12:00, when a player completes it at 11:00, then the points are awarded. Given the same quest at 12:01, when a player scans its QR, then no points are awarded and the app says the quest has ended. |
| FR-226 | The dashboard shall let the organizer show or hide a quest during a live event, and the app shall reflect the change without an app update. | Must | F-91 | Given a visible quest, when the organizer hides it, then players no longer see it and cannot complete it. Given a hidden quest, when the organizer shows it, then players see it in the quest list. |
| FR-227 | The system shall let the organizer make a quest repeatable with a cap per player, and award each completion up to the cap. | Must | F-92 | Given a quest with a cap of 3, when a player completes it a third time, then the third completion is awarded. Given the same player, when they try a fourth time, then no points are awarded and the app says the limit is reached. |

#### Categories

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-228 | The system shall place every quest in exactly one category and create a default "General" category with each event. | Must | F-93 | Given a new event, when it is created, then it has a "General" category. Given a quest, when the organizer tries to save it without a category or in two categories, then the dashboard requires exactly one. |
| FR-229 | The app shall show an event's categories in the order the organizer sets. | Must | F-93 | Given three categories, when the organizer reorders them, then players see the new order. Given an event with only the "General" category, when the player opens the quest list, then its quests appear under that one category. |
| FR-230 | The app shall let a player expand and collapse each category, and a collapsed category shall show points earned out of its total points and quests completed out of its total quests. | Must | F-94 | Given a category worth 10,000 points over 10 quests where the player earned 2,000 points from 3 quests, when it is collapsed, then it shows "2,000 / 10,000 pts · 3 / 10 quests". Given a collapsed category, when the player taps it, then it expands and shows its quests. |
| FR-231 | The system shall pay a category's completion bonus, when the organizer sets one, once the player completes all of its quests, on top of the quests' own points. | Must | F-95 | Given a category with a bonus, when the player completes its last quest, then the quest's points and the bonus are both awarded. Given a category with no bonus set, when the player completes it, then only the quests' points are awarded. |
| FR-232 | In a category set to "in order", the system shall unlock each quest only after the previous one is completed. | Must | F-53 | Given an in-order category, when the player completes quest 1, then quest 2 unlocks. Given the same category, when the player tries to complete quest 3 before quest 2, then it is refused and the app shows it is locked. |
| FR-233 | In a category set to "any order", the system shall let its quests be completed in any order. | Must | F-53 | Given an any-order category, when the player completes quest 3 first, then it is awarded. Given the organizer switches the category to "in order", when players open it, then quests unlock one after another. |
| FR-234 | The system shall let the organizer set a category to open at a set time, and shall not let its quests be completed before then. | Must | F-97 | Given a category that opens at 16:00 on day 2, when a player completes one of its quests after that time, then the points are awarded. Given the same category before 16:00 on day 2, when a player tries one of its quests, then it is refused and the app shows when it opens. |
| FR-235 | The system shall let the organizer set a category to unlock only after the player completes another chosen category. | Should | F-98 | Given "Chapter 2" set to unlock after "Chapter 1", when the player completes "Chapter 1", then "Chapter 2" unlocks for that player. Given a player who has not completed "Chapter 1", when they try a "Chapter 2" quest, then it is refused and the app says which category unlocks it. |
| FR-236 | The system shall let the organizer set a category to refresh daily or weekly, so that its quests can be completed again after each reset while points already earned stay. | Should | F-51 | Given a daily category, when the reset time passes, then the player can complete its quests again and their earlier points remain in their score. Given a category with no refresh, when a day passes, then completed quests stay completed. |
| FR-237 | The system shall keep a hidden category out of a player's view until that player scans its secret QR. | Could | F-99 | Given a hidden category, when a player scans its secret QR, then the category appears for that player. Given another player who has not scanned it, when they open the quest list, then the category is not shown. |
| FR-238 | The system shall reveal a hidden category to the players who receive the organizer's hint push for it. | Could | F-99 | Given a hidden category, when the organizer sends its hint push, then the category appears for the players who receive the push. Given no hint push has been sent, when players open the quest list, then the category stays hidden from those who did not scan its secret QR. |

#### Polls, community and live moments

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-239 | The system shall let the organizer push a live poll to everyone in the event, shown in the app as a pop-up card. | Should | F-100 | Given a live event, when the organizer sends a poll, then players in the event receive it and the app shows it as a pop-up card. Given a player not in that event, when the poll is sent, then they do not receive it. |
| FR-240 | A live poll shall accept one choice or several, as the organizer sets. | Should | F-100 | Given a poll set to one choice, when the player selects a second option, then the first is deselected. Given a poll set to several choices, when the player selects two options and submits, then both are recorded. |
| FR-241 | A live poll shall award points only when the organizer sets points on it. | Should | F-100 | Given a poll with points, when the player votes, then the points are awarded. Given a poll without points, when the player votes, then the vote is recorded and no points are awarded. |
| FR-242 | The app shall show live poll results after the player votes, when the poll closes, or never, as the organizer sets. | Should | F-100 | Given a poll set to "after voting", when the player votes, then the results are shown. Given a poll set to "never", when the poll closes, then players see no results. |
| FR-243 | The system shall let the organizer turn on a community quest for an event and pick its measure: total points earned by all players, completions of a chosen quest or category, or the number of players who did something. | Should | F-101 | Given a community quest measured by completions of a chosen category, when players complete that category, then the shared progress rises by one per completion. Given an event with the community quest off, when players open the event, then no community quest is shown. |
| FR-244 | Points players earn shall count toward a points-based community goal as participation points, and the system shall deduct nothing from any player's balance. | Should | F-101 | Given a points-based community quest, when a player earns 100 points, then the shared progress rises by 100. Given the same player, when they check their balance, then it shows the 100 points earned with nothing taken away. |
| FR-245 | A community quest shall count only activity between its organizer-set start and end times. | Should | F-101 | Given a community quest running for 20 minutes before the finale, when a player earns points inside the window, then they count. Given points earned before the start or after the end, when progress is calculated, then they do not count. |
| FR-246 | The system shall let the organizer add optional milestones to a community quest, each with its own reward, and send a push when each milestone is reached. | Should | F-101 | Given a milestone at half the goal, when progress reaches it, then the milestone reward is given and a push goes out. Given a community quest with no milestones, when progress rises, then only the final goal pays a reward. |
| FR-247 | When a community goal is reached, the system shall give the organizer-set reward: points for each player, unlocking a quest, category or store item, a real-world moment the organizer announces, or nothing. | Should | F-101 | Given a goal whose reward unlocks a category, when the goal is reached, then that category unlocks. Given a goal whose reward is "nothing", when the goal is reached, then the goal shows as reached and no reward is given. |
| FR-248 | The system shall give a community quest's reward to players who contributed at least once by default, or to everyone in the event when the organizer chooses. | Should | F-101 | Given the default setting, when the goal is reached, then players who contributed receive the reward and players who did not, do not. Given the organizer chose "everyone", when the goal is reached, then every player in the event receives it. |
| FR-249 | When a community goal is not reached by its end time, the system shall award nothing for the goal. | Should | F-101 | Given a goal reached before its end time, when it is reached, then its reward is given. Given a goal not reached when the window ends, when the window closes, then no goal reward is given to anyone and the app shows the goal was not reached. |
| FR-250 | The system shall show a community quest's progress as a bar on the event home and on the big screen. | Should | F-101 | Given a running community quest, when a player opens the event home, then the progress bar shows current progress against the goal. Given a big screen showing the event, when progress rises, then the bar updates. |
| FR-251 | The system shall let the organizer run flash quests that are available only for a short organizer-set window, fired live or scheduled. | Should | F-102 | Given a scheduled flash quest, when its window starts, then players see it and can complete it. Given the window has ended, when a player tries the flash quest, then it is no longer available and no points are awarded. |
| FR-252 | The system shall let the organizer run a double-point boost on a category or zone for an organizer-set window, fired live or scheduled. | Should | F-102 | Given a boost on a category, when a player completes one of its quests during the window, then they earn double that quest's points. Given the boost has ended, when a player completes the same kind of quest, then they earn the normal points. |
| FR-254 | The system shall let the organizer run a live finale: a countdown, a last community push, and a winner reveal on the big screen. | Should | F-103 | Given a finale set for 20:00, when it runs, then the big screen shows the countdown, then the last community push, then the winner reveal. Given the organizer has not started the finale, when players view the big screen, then no winner is revealed. |
| FR-255 | The finale's winner reveal shall rank players by score and show only their usernames and avatars. | Should | F-103 | Given the finale reveal, when winners are shown, then they are the top players by score in the event. Given a player who spent points in the shop, when the reveal ranks players, then their spending does not lower their place. |

### 1.3 Area 3 — Verification and fair play

The rule for this area (ADR-041): the system never punishes anyone on its own. It flags, and the
event team decides.

#### Verification

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-301 | The dashboard shall let the organizer enable, per quest, one or more of three verification methods: the player scans the quest's QR; an operator or kiosk scans the player's My QR; the player taps an NFC tag. | Must | F-54 | Given a quest in the dashboard, when the organizer enables "player scans the quest's QR" and "NFC tag" and saves, then both methods are stored for that quest. Given the organizer clears all three methods, when they try to save, then the dashboard asks them to enable at least one. |
| FR-302 | The system shall record a quest completion only through a verification method enabled on that quest, or through a manual award (FR-308). | Must | F-54 | Given a quest with only "player scans the quest's QR" enabled, when the player scans it, then the completion is recorded. Given the same quest, when an operator scans the player's My QR for it, then no completion is recorded and staff mode says the quest uses another method. |
| FR-303 | The app shall scan quest codes from the live camera only and offer no way to scan an image from the photo gallery. | Must | F-55 | Given a player opens the scanner, when they look for an option to pick an image, then none exists and only the live camera is shown. Given the App Review demo event (ADR-009), when a reviewer opens the scanner, then the demo-only QR picker is offered; given any other event, then it is not. |
| FR-304 | The system shall allow one completion per player per quest, or up to the quest's repeat cap for a repeatable quest, and show a clear "already completed" message on any further attempt. | Must | F-55 | Given a player who has not completed a single-completion quest, when they scan it, then the completion is recorded. Given the player has already completed it, or reached its repeat cap, when they scan it again, then no points are added and the app shows "already completed". |
| FR-305 | The dashboard shall let the organizer view, download and print each quest's QR code, including as a print sheet. | Must | F-67 | Given a quest with the quest-QR method enabled, when the organizer opens its QR, then they can view it, download it and print a sheet. Given that quest has been deleted, when a player scans its printed code, then no completion is recorded. |
| FR-306 | The app shall show each player a personal My QR: a fixed code that identifies the player, which the player can replace at any time (ADR-137, amended 2026-10-22 from a code changing every 30 seconds). | Must | F-104 | Given a player opens My QR, when an operator, a kiosk or a prize desk scans it (meet-someone uses its own one-minute code since 2026-10-24, ADR-209), then the scan identifies that player. Given a player replaces their code, when the earlier code is scanned, then it is refused. |
| FR-307 | Showing My QR shall only identify the player: nothing of value leaves on the code alone. A station scan pays only the code's owner, and a prize is handed over only after the player accepts it in their own app (ADR-137, amended 2026-10-22 from rejecting codes older than one minute). | Must | F-104 | Given an operator scans a player's My QR at a station, when the scan is accepted, then the points go to that player and no one else. Given someone shows another player's code at the prize desk, when the desk asks for the handover, then nothing is handed over until the player accepts in their app. |
| FR-308 | Staff mode shall let an operator find a player by username or phone number and award them a quest or points by hand. | Must | F-108 | Given an operator searches a player's phone number, when they pick the player and award a quest, then the quest is completed for that player. Given no player matches the username or number, when the operator searches, then staff mode says no player was found and nothing is awarded. |
| FR-309 | The system shall require a reason for every manual award and record it in the points record with the operator's name. | Must | F-108 | Given an operator enters a reason and confirms a manual award, then the points record shows the award with the reason and the operator's name. Given the reason field is empty, when the operator tries to confirm, then the award cannot be sent and staff mode asks for a reason. |
| FR-310 | The system shall enforce the owner's caps on manual awards: a maximum per award and a maximum per operator per day. | Must | F-109 | Given an amount within both caps, when the operator confirms, then the award is recorded. Given an amount above the per-award cap, or an award that would take the operator past their daily cap, when the operator confirms, then the award is refused and staff mode shows the cap that applies. |
| FR-311 | The dashboard shall give the owner a report of every manual award, with player, quest or points, reason, operator and time. | Must | F-109 | Given operators made manual awards, when the owner opens the report, then each award is listed with those details. Given no manual awards were made, when the owner opens the report, then it shows that there are none. |
| FR-312 | Staff mode shall let an operator write a quest's NFC tag from a phone with "Write to NFC tag" on the quest. | Should | F-105 | Given an operator with the NFC-writing ability opens a quest with NFC enabled, when they tap "Write to NFC tag" and hold a tag to the phone, then the tag is written for that quest. Given the web dashboard, when the organizer looks for a way to write tags, then none is offered. |
| FR-313 | The app shall complete a quest when the player taps its NFC tag, and the quest's QR shall stay usable as a backup. | Should | F-105 | Given a quest with NFC enabled, when a player taps its tag in the app, then the completion is recorded. Given a player whose phone cannot read the tag, when they scan the quest's QR instead, then the completion is recorded. |
| FR-314 | The system shall show a quest's rotating QR on an operator's phone or on a station page opened on any tablet or TV, changing every 30 to 60 seconds. | Should | F-106 | Given a station page open on a TV, when a player scans the code shown, then the completion is recorded. Given a photo of the code shared after the code has changed, when another player scans the photo, then no completion is recorded. |
| FR-315 | The system shall let a tablet signed in as a station work as an unattended kiosk that scans each player's My QR and records the station's quest. | Should | F-107 | Given a kiosk tablet for a quest, when a player holds up their live My QR, then the completion is recorded with no operator present. Given a player shows an expired My QR screenshot, or has already completed the quest, when the kiosk scans it, then no completion is recorded and the kiosk shows why. |

#### Fair play

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-316 | The system shall store every change to a player's points as an entry in a permanent points record with its reason, quest, operator, device and time. | Must | F-110 | Given an operator scans a player's My QR for a quest, when the completion is recorded, then a new entry holds the reason, quest, operator, device and time. Given a change with no operator (e.g. the player scans a printed QR), when it is stored, then the entry still holds the reason, quest, device and time. |
| FR-317 | The system shall never edit or erase an entry in the points record; every correction is a new entry. | Must | F-110 | Given an award is removed, when the owner views the record, then the original entry is unchanged and a new removal entry follows it. Given any role, including the owner, when they view an entry, then no edit or delete option exists. |
| FR-318 | The system shall keep the owner's team and operators off every board of the event and out of rank prizes. | Must | F-111 | Given an operator allowed to play earns the highest score, when the board is shown, then the operator does not appear and the next player ranks first. Given rank prizes are set, when winners are decided, then no excluded person is among them. |
| FR-319 | The dashboard shall let the owner add phone numbers and email domains to the event's exclusion list. | Must | F-111 | Given the owner adds an email domain, when a player signed in with an email at that domain plays, then they never appear on the event's boards. Given a player already on the board, when the owner adds their phone number, then they leave the board. |
| FR-320 | The system shall let the owner or an editor remove an award, with a required reason, written to the points record as a new entry (ADR-152, amended 2026-10-23 from "the owner"). | Must | F-112 | Given the owner selects an award, enters a reason and confirms on the confirmation screen, then a removal entry is added and the player's score and balance drop by that amount. Given the reason is empty, when the owner tries to confirm, then the removal is not made. |
| FR-321 | The system shall let the owner ban a player from an event; the player's name leaves the event's boards and their points record is kept. | Must | F-117 | Given the owner bans a player and confirms, when the board is next shown, then the player's name is gone. Given the player is banned, when the owner opens their points record, then every entry is still there. |
| FR-322 | The system shall rate-limit attempts to enter typed codes, per player and per device. | Must | F-113 | Given a player within the limit, when they type a code, then it is checked normally. Given a player or device that has passed the limit, when they type another code, then it is refused and the app says when they can try again. |
| FR-323 | The system shall rate-limit requests for login codes, per player and per device. | Must | F-113 | Given a user within the limit, when they request a login code, then it is sent. Given a phone number or device that has passed the limit, when another code is requested, then none is sent and the app says when they can try again. |
| FR-324 | The system shall send photo and text submissions to a review queue that operators and the owner can work through. | Must | F-119 | Given a player submits a photo for a quest without auto-approve, when an operator opens their inbox, then the submission is in the queue. Given an operator whose review ability is turned off, when they open their inbox, then the submission is not shown to them. |
| FR-325 | The system shall let a reviewer approve a submission, or reject it with a required reason. | Must | F-119 | Given a submission in the queue, when the reviewer approves it, then the points are added to the player's score and balance. Given the reviewer rejects without a reason, when they confirm, then the rejection is not saved and a reason is asked for. |
| FR-326 | The system shall keep a submission's points pending, outside the score and balance, until it is approved. | Must | F-119 | Given a submitted quest worth 150 points, when it is waiting for review, then the player's score and balance do not include the 150. Given the submission is rejected, then the pending points disappear and nothing is added. |
| FR-327 | The dashboard shall let the owner mark a quest auto-approve, so that a submission's points land at once. | Should | F-120 | Given an auto-approve quest, when a player submits, then the points are added to score and balance at once. Given a quest without auto-approve, when a player submits, then the points stay pending. |
| FR-328 | The system shall let the event team remove an auto-approved submission later, which takes its points back as a new entry in the points record. | Should | F-120 | Given an auto-approved submission, when a team member removes it and confirms, then a removal entry is added and the player's score and balance drop by its points. Given the removal, when the record is viewed, then the original award entry is unchanged. |
| FR-329 | The system shall never hold, remove or block a player's points, completions or redemptions automatically because of a flag. | Should | F-114, F-115 | Given a player with an open flag, when they complete a quest or redeem a reward, then it goes through as for any player. Given a flag is raised, when the owner looks at the player's points, then nothing has changed until a person acts. |
| FR-330 | The system shall flag several accounts used on one phone in the same event. | Should | F-114 | Given two accounts play the same event from one phone, when the second account completes a quest, then a flag with the device evidence appears on the flagged-activity page. Given one account per phone, then no such flag is raised. |
| FR-331 | The system shall flag a player whose location, read while the app is open, is far from the venue or appears faked. (Moved to T-303 (ADR-153), then T-303b (ADR-196): it needs the venue pin and the app's location reading.) | Should | F-114 | Given a player with location permission whose phone reports a position far from the venue while completing a quest, then a flag with the location evidence is raised. Given a player who refused location, when they play, then nothing is blocked and no location flag is raised. |
| FR-332 | The system shall flag impossible speed between stations. (Moved to T-303 (ADR-153), then T-303b (ADR-196): it needs places for quests.) | Should | F-114 | Given a player's completions at two stations are closer in time than the distance between them allows, then a flag with both completions is raised. Given completions at a realistic pace, then no flag is raised. |
| FR-333 | The system shall flag bursts of completions. | Should | F-114 | Given a player completes an unusual number of quests in a short time, then a flag listing those completions is raised. Given a normal pace of play, then no flag is raised. |
| FR-334 | The system shall add a failed device-integrity check as one more flag, and never block the player because of it. (Moved to T-812 (ADR-153): it needs Apple App Attest and Google Play Integrity set up.) | Could | F-115 | Given a phone that fails the integrity check, when the player plays, then a flag is raised and the player can still play and redeem. Given a phone that passes, then no flag is raised. |
| FR-335 | The dashboard shall show a flagged-activity page that lists each case with its evidence. | Should | F-116 | Given flags were raised in an event, when the owner opens the page, then each case shows the player, the kind of flag and its evidence. Given no flags, when the page is opened, then it says there are none. |
| FR-336 | The flagged-activity page shall let the event team clear a case, remove points or ban the player, each by hand and recorded. | Should | F-116 | Given a case, when the owner removes points and confirms, then a removal entry is added to the points record and the case shows the action taken. Given the owner clears a case, then the player's points are unchanged and the case leaves the open list. |
| FR-337 | The app shall let a player open "Report a problem" or "Ask a question" from a quest or from the event, with a type, text and an optional photo. | Should | F-118 | Given a player on a quest whose QR is missing, when they send a report with a type and text, then it reaches the operator inbox linked to that quest. Given the text is empty, when the player tries to send, then the app asks for text. |
| FR-338 | Staff mode shall let an operator reply to a help-desk ticket and mark it solved, and the player shall get a push for the reply. | Should | F-118 | Given an open ticket, when an operator replies, then the player gets a push and sees the reply. Given the operator marks it solved, then it leaves the waiting list and the player sees it as solved. |
| FR-339 | The system shall keep each help-desk ticket private between the player and the event team. | Should | F-118 | Given a player sent a ticket, when the event team opens the inbox, then they can read it. Given another player, when they use the app, then they cannot see that ticket in any screen. |

### 1.4 Area 4 — Points, levels and streaks

#### Score, balance and feedback

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-401 | The system shall keep, per player per event, a score equal to all points earned in that event, and rank players by score. | Must | F-121 | Given a player earns 100 points from a quest and 50 from the welcome reward, when the board is shown, then their score is 150 and their rank uses 150. Given an award is removed, then the score drops by that amount. |
| FR-402 | The system shall keep, per player per event, a balance equal to points earned minus points spent, and spending shall lower only the balance. | Must | F-121 | Given a player with a score of 500 redeems a 200-point reward, when they look at their numbers, then the balance is 300 and the score is still 500. Given the redemption is cancelled or times out, then the balance returns to 500 and the score stays 500. |
| FR-403 | The app shall keep the player's balance and progress visible in the event and animate every change. | Must | F-08 | Given a player in an event, when they earn points, then the balance animates to its new value. Given the phone's reduce-motion setting is on, when the balance changes, then it updates without the motion. |
| FR-404 | The dashboard shall let the organizer name the event currency in Arabic and in English, and the app shall use that name wherever the event's points are named. | Must | F-24 | Given the organizer names the currency in both languages, when a player switches the app language, then the matching name appears on balance, prices and history. Given only one language is filled, when the organizer saves, then the dashboard asks for the other. |
| FR-405 | The dashboard shall let the organizer pick the currency icon only from Questify's 3D set: coin, crown coin, gem, leaf, star. | Must | F-24 | Given the organizer picks the leaf, when players open the event, then the leaf shows beside every amount. Given the organizer looks for a way to upload their own icon, then none is offered. |
| FR-406 | The app shall celebrate a completed quest in two steps: a "Scanned! checking…" beat (sound, buzz, spinning coin) within 300 ms of the scan, then the full celebration with the points and a Claim button once the server confirms; points are recorded whether or not Claim is tapped. | Must | F-56 | Given a valid scan, when the server confirms, then the checking beat turns into the +points celebration. Given the server rejects the scan (already completed, quest closed, banned), when the answer arrives, then the beat ends in a clear message and no celebration or points are shown. |
| FR-407 | The app shall scale celebrations by rarity: a quest small; a level-up medium; a category completed, a community goal reached or the finale full-screen. | Must | F-11 | Given a player completes the last quest of a category, when the celebrations play, then the quest's small celebration is followed by the full-screen category one. Given a player levels up, then a medium celebration plays, not a full-screen one. |
| FR-408 | The app shall respect the phone's reduce-motion setting in every celebration and progress animation. | Must | F-11 | Given reduce-motion is off, when a player completes a quest, then the full animation plays. Given reduce-motion is on, when the same happens, then the result and points show without the motion. |
| FR-409 | The app shall show pending points apart from the balance (e.g. "+150 pending") until they are approved. | Must | F-122 | Given a submission worth 150 is waiting for review, when the player looks at their balance, then it shows "+150 pending" next to an unchanged balance. Given the submission is approved, then the pending label goes and the balance rises by 150; given it is rejected, the pending label goes and the balance is unchanged. |
| FR-410 | The app shall show an activity history of every point earned, spent, removed or pending, each with its reason, read from the points record. | Must | F-60 | Given a player earned, spent and had points removed, when they open history, then each entry shows its amount and reason. Given an entry was corrected, then both the original and the correction appear, matching the points record. |

#### Live point edits

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-411 | The dashboard shall ask, when the organizer changes a live quest's points, whether to apply the change to future completions only or also to past completions. | Must | F-123 | Given a quest worth 100 completed by 40 players, when the organizer sets it to 150 and picks "future completions only", then the 40 players keep 100 and the next completion earns 150. Given the organizer picks "also past completions", then each of the 40 players gets a new +50 entry in the points record. |
| FR-412 | The dashboard shall ask, when the organizer deletes a quest that players already completed, whether to keep or remove the points they earned from it. | Must | F-123 | Given a completed quest is deleted with "keep", then players' scores and balances are unchanged. Given it is deleted with "remove", then each player who earned it gets a new removal entry and their score and balance drop by that amount. |
| FR-413 | The dashboard shall explain each live-edit option on a confirmation screen before it applies, and write every adjustment as a new entry in the points record. | Must | F-123 | Given the organizer picks an option, when the confirmation screen opens, then it says exactly what will happen to players' points and the change applies only after they confirm. Given rank prizes were already handed over, when a change to past completions is confirmed, then the screen has said the prizes are not taken back and none are. |

#### Questify XP and level

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-414 | The system shall give the same hidden amount of Questify XP for every quest, only on a player's first completion of it; repeats and refreshes give event points but no XP unless the platform setting allows it. | Must | F-124, F-262 | Given a player completes a quest for the first time, when it is recorded, then they gain the standard XP amount. Given they complete the same repeatable quest again, when it is recorded, then they gain its event points and no XP. |
| FR-415 | The system shall never spend or deduct Questify XP through any purchase. | Must | F-124 | Given a player redeems an event reward or buys in the Questify shop, when they look at their XP, then it is unchanged. Given a player opens any shop, then no price is in XP. |
| FR-416 | The app shall show a lifetime Questify level across all events, with an XP bar and the next level's reward. | Must | F-57 | Given a player earns XP in two different events, when they open their profile, then one level and one XP bar include both. Given the player crosses a level, then the bar resets toward the next level and shows that level's reward. |

#### Streaks

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-417 | The dashboard shall let the organizer switch on an event day streak for a multi-day event or company season; the streak counts the days on which the player completed at least one quest. | Should | F-59 | Given the streak is on, when a player completes a quest on a day, then that day counts toward their event streak. Given the streak is off, then players see no event streak. |
| FR-418 | The dashboard shall let the organizer run the event day streak with or without bonus points. | Should | F-59 | Given the streak is on with bonus points, when a player earns the streak bonus, then the bonus points are added as a new entry in the points record and count toward score and balance. Given it is on without bonus points, then the streak is shown and no points are added. |
| FR-419 | The system shall keep a Questify daily streak that any Questify activity that day keeps alive: the daily challenge, an event quest or a Questify quest. | Should | F-125 | Given a player with no event that day, when they finish the daily challenge, then the day counts toward the streak. Given a player completes an event quest, then the day counts the same way. |
| FR-420 | The Questify console shall let a platform admin switch the Questify daily streak off platform-wide. | Should | F-125 | Given the streak is on, when a platform admin switches it off, then no player sees a daily streak. Given an organizer, when they look for this switch in the dashboard, then none exists. |
| FR-421 | The system shall reward the Questify daily streak only with XP or items, never with event points or gems. | Should | F-125 | Given a player reaches a daily streak reward, when it is granted, then they receive XP or an item. Given the same reward, when the player checks their event balance and gems, then neither has changed. |
| FR-422 | The app shall show the player how many more points they need for the next reward they can reach (e.g. "120 more for a coffee"), or for their pinned goal when one is set. | Should | F-126, F-151 | Given a balance of 380 and a 500-point coffee as the next reward, when the player looks at the prompt, then it shows "120 more for a coffee". Given the player pinned a different reward, then the prompt shows what is left for the pinned reward. |

### 1.5 Area 5 — Rewards shop and prize handover

#### The shop

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-501 | The app shall show a rewards shop per event, where each reward has a price in the event currency, a picture, Arabic and English text and its stock, and every player with enough balance can redeem. | Must | F-10 | Given a player in an event, when they open the shop, then each reward shows its price with the currency icon, picture, text in the app's language and stock. Given a player outside the top 10, when they redeem a reward they can afford, then it goes through. |
| FR-502 | The system shall enforce each reward's per-player limit. | Must | F-10 | Given a reward limited to one per player, when a player redeems it the first time, then it goes through. Given the player already holds that many, when they try again, then the redemption is refused and the app says they reached the limit. |
| FR-503 | The system shall allow a reward to be redeemed only within its availability window. | Must | F-10 | Given a reward inside its window, when a player redeems it, then it goes through. Given the window has not opened or has closed, when a player tries to redeem, then it is refused and the app shows when it is or was available. |
| FR-504 | The dashboard shall let the organizer create, edit and remove rewards and manage their stock. | Must | F-22 | Given the organizer creates a reward with all its fields, when they save, then it appears in the event's shop. Given a sold-out reward, when the organizer raises its stock, then the shop shows it available again with the new count. |
| FR-505 | The system shall support three kinds of reward: an item collected at the event's prize desk, a digital code shown in the app, and an experience confirmed by an operator. | Must | F-144, F-241 | Given the organizer creates a reward, when they choose its kind, then the matching redemption flow is used. Given an item reward, when a player reserves it, then the reservation shows the prize desk's location and opening hours. |
| FR-506 | The system shall, when a player taps Redeem on an item or experience, take the price from the balance at once and hold one unit of stock as a reservation for that player. | Must | F-145 | Given a balance of 300 and a 200-point item with 5 in stock, when the player confirms Redeem, then the balance is 100, the stock shows 4 and the item is listed as reserved, with each step in the points record. Given a balance below the price, when the player taps Redeem, then the redemption is refused and nothing changes. |
| FR-507 | Staff mode shall let an operator at the prize desk scan the player's My QR, see the player's pending items and tap Handed over. | Must | F-145 | Given a player with a reserved item, when the operator scans their live My QR and taps Handed over, then the item is marked handed over and the step is written to the points record. Given the scan, when the operator looks at the desk screen, then no option to award points exists. |
| FR-508 | The system shall return the points and the stock automatically when a reservation is not collected within the organizer-set time. | Must | F-145 | Given a reservation older than the organizer-set time, when the time passes, then the points return to the balance, the unit returns to stock and the return is written to the points record. Given the item was handed over before the time, then nothing returns. |
| FR-509 | Staff mode shall let an operator confirm an experience reward for the player who redeemed it. | Must | F-144 | Given a player who redeemed a VIP-lounge experience, when an operator scans their My QR and confirms it, then the experience is marked confirmed and recorded. Given a player with no such redemption, when scanned, then there is nothing to confirm. |
| FR-510 | The dashboard shall let the organizer upload a list of codes for each digital reward. | Must | F-146 | Given a digital reward, when the organizer uploads a list of 100 codes, then the reward's stock is 100. Given an upload, when the organizer uploads more codes later, then the stock rises by their number. |
| FR-511 | The system shall reveal one uploaded code per redemption of a digital reward and keep it in the player's history; no code is given twice. | Must | F-146 | Given a player redeems a digital reward, when the redemption completes, then one code is shown and stays in their history. Given every uploaded code has been given out, when another player opens the reward, then it shows as sold out. |
| FR-512 | The dashboard shall warn the organizer when a digital reward's codes run low. | Must | F-146 | Given a digital reward whose codes run low, when the organizer opens the dashboard, then a warning names the reward and its remaining codes. Given enough codes remain, then no warning shows. |
| FR-513 | The system shall let the player or an operator cancel a redemption before pickup, returning the points to the balance, logged in the points record. | Must | F-147 | Given a reserved item not yet handed over, when the player cancels and confirms on the confirmation screen, then the points return to the balance and a new entry is written. Given the item was already handed over, when anyone looks for the cancel option, then it is not offered. |
| FR-514 | The app shall show each reward's real remaining stock and mark a sold-out reward clearly, never showing a false count. | Must | F-148 | Given a reward with 3 left, when the player opens the shop, then it shows 3 left. Given the last unit is reserved, then the reward shows as sold out at once and Redeem is not offered. |
| FR-515 | The app shall show the event's official rules before a player's first redemption in that event. | Must | F-153 | Given a player who has never redeemed in this event, when they tap Redeem, then the rules show before the redemption goes through. Given the player redeemed before in this event, when they tap Redeem again, then the rules do not show first. |
| FR-516 | The app shall show shop sections (featured, merch, food, experiences) and tags (new, popular, limited) on rewards. | Should | F-62 | Given the organizer puts a reward in "food" and tags it "limited", when a player opens the shop, then it appears in the food section with the "limited" tag. Given the player opens the "experiences" section, then only rewards in that section are listed. |
| FR-517 | The app shall let a player pin a reward as a goal and see how much is left to earn for it. | Should | F-151 | Given a player with a balance of 300 pins a 500-point reward, when they look at the goal, then it shows 200 left. Given their balance reaches 500, then the goal shows they can redeem it now. |
| FR-518 | The system shall let the owner pause redemption for a specific player by hand, and never pause it automatically. | Should | F-152 | Given the owner pauses a flagged player, when that player taps Redeem, then the redemption is refused and the app says redemption is paused for them. Given a player is flagged but not paused, when they redeem, then it goes through. |

#### Prizes outside the shop

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-519 | The dashboard shall let the organizer attach prizes to final ranks in an event, and switch rank prizes off for the event. | Should | F-149 | Given the organizer sets prizes for ranks 1 to 3, when they save, then the event shows those prizes. Given rank prizes are switched off, then no rank prizes are shown or awarded. |
| FR-520 | The system shall decide rank-prize winners by final score, leaving out everyone on the exclusion list, and reveal them only after the organizer confirms the winners (FR-1719). | Should | F-149, F-111, F-244 | Given the organizer confirmed the winners, when the finale reveal runs, then the confirmed players are shown in rank order. Given winners are not yet confirmed, when the reveal is started, then the dashboard asks for the confirmation first. |
| FR-521 | The system shall hand over rank prizes through the same reserve-and-pickup flow as shop items, without taking points from the winner's balance. | Should | F-149 | Given a rank-prize winner, when an operator scans their My QR at the desk, then the prize appears among their pending items and can be marked Handed over. Given the prize is handed over, then the winner's balance and score are unchanged. |
| FR-522 | The dashboard shall let the organizer set an item as the reward of a quest or category, instead of or together with points, collected through the same handover. | Should | F-150 | Given a quest whose reward is an item plus 50 points, when a player completes it, then 50 points are added and the item appears among their pending items at the desk. Given a category whose reward is an item only, when a player completes it, then the item is pending and no points are added for the category. |

### 1.6 Area 6 — Leaderboard and big screen

Boards rank the event score (points earned, ADR-043). Every player appears under their username;
there is no hidden mode (ADR-052).

#### Rankings

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-601 | The app shall show the event ranking as the top 10 players by event score, each under their username, with the viewing player's row highlighted when they are in the top 10. | Must | F-09 | Given a player ranked 4th, when they open the ranking, then they see ranks 1 to 10 with their own row (rank 4) highlighted. Given an event with only 6 ranked players, when a player opens the ranking, then 6 rows are shown and no empty rows are filled in. |
| FR-602 | The app shall show a player ranked below 10th as an 11th row under the top 10, with their real rank. | Must | F-09 | Given a player ranked 37th, when they open the ranking, then they see ranks 1 to 10 followed by an 11th row showing their username and rank 37. Given a player ranked exactly 10th, when they open the ranking, then they appear highlighted in the top 10 and no 11th row is added. |
| FR-603 | The app shall fit the event ranking (up to 11 rows) on one screen with no scrolling, on every supported phone size. | Must | F-09 | Given a player ranked below 10th on the smallest supported phone, when they open the ranking, then all 11 rows are visible without scrolling. Given the player tries to scroll the ranking, when they swipe, then no further rows appear (there is no full-ranking list). |
| FR-604 | A player's ranking row shall show only their public profile details (username, character, frame, title) and never their real name, phone or email. | Must | F-09 | Given an event that requires full names at join, when any player views the ranking, then each row shows username, character, frame and title only. Given a player with no title equipped, when their row is shown, then the row shows no title and no placeholder name. |
| FR-605 | The ranking shall not offer players any option to hide from it. | Must | F-09 | Given any player, when they look through profile and event settings, then no hide-from-ranking or anonymous option exists. Given a player ranked below 10th, when another player opens the ranking, then the first player is not shown to them (only the viewer's own 11th row appears). |
| FR-606 | The system shall break a tie in score by ranking higher the player who reached that score first. | Must | F-155 | Given players A and B both at 500 points and A reached 500 before B, when the ranking is shown, then A is ranked above B. Given A and B tie for a rank that carries a rank prize, when final ranks are set, then exactly one of them holds that rank. |
| FR-607 | The dashboard shall let the owner turn the event ranking on or off; when off, the app shows no event ranking for that event. | Must | F-23 | Given the owner turns the ranking off, when a player opens the event Home, then no ranking card is shown and the ranking screen cannot be opened. Given the owner turns it back on, when a player opens Home, then the ranking card is shown again with current ranks. |
| FR-608 | The dashboard shall let the owner turn today's ranking on or off for a multi-day event. | Must | F-23, F-61 | Given a multi-day event with today's ranking on, when a player opens the ranking, then today's ranking is available. Given the owner turns today's ranking off, when a player opens the ranking, then only the overall event ranking is available. |
| FR-609 | Every ranking shall exclude banned players and players on the event's exclusion list. | Must | F-23 | Given the owner bans a player in the top 10, when any player opens the ranking, then the banned player is gone and the next player moves up. Given an operator on the exclusion list earns points in Player mode, when the ranking is computed, then the operator never appears in it. |
| FR-610 | For a multi-day event, the app shall show today's ranking, built from points earned that day only and reset at the start of each event day, using the same 11-row layout and tie rule. | Should | F-61 | Given a player who earned 200 points yesterday and 50 today, when they open today's ranking, then their today's score is 50. Given the event day changes, when a player opens today's ranking, then all today's scores start from zero and the overall ranking is unchanged. |
| FR-611 | Questify home shall show a Questify-wide ranking by XP, with a lifetime view and a this-month view, using the same 11-row layout and tie rule. | Should | F-154 | Given a player ranked 120th by lifetime XP, when they open the Questify-wide ranking, then they see the top 10 and themselves as an 11th row with rank 120. Given a new calendar month starts, when a player opens the this-month view, then it ranks only XP earned this month while the lifetime view is unchanged. |
| FR-612 | The Questify-wide ranking shall appear only outside events (Questify home and Explore), never inside an event. | Should | F-154 | Given a player inside an event, when they browse the event's screens, then no Questify-wide ranking is shown. Given the player goes to Questify home, when they open Explore, then the Questify-wide ranking is available. |
| FR-613 | The system shall send a player a push when they enter the event's top 10 and when they drop out of it. | Should | F-160 | Given a player moves from 11th to 9th, when the ranking updates, then they get a push saying they are in the top 10. Given a player moves from 5th to 3rd, when the ranking updates, then no push is sent (rank changes inside the top 10 send no push). |

#### Navigation

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-620 | Inside an event, the app shall show a bottom bar with, in order: Home, Quests, a large round center button, Rewards, Profile. | Must | F-161 | Given a player inside an event, when any event screen is open, then the bottom bar shows Home, Quests, center button, Rewards, Profile in that order, the same in both languages with Home on the left (ADR-110 note, Q-100). Given a player inside an event, when they look at the bottom bar, then it holds no item that leaves the event. |
| FR-621 | The event center button shall open the scanner, which reads both QR codes and NFC tags. | Must | F-162 | Given a player taps the center button, when they point the camera at a quest QR, then the quest scan is processed. Given the scanner is open, when the player taps their phone on a quest's NFC tag, then the tag is read in the same scanner without switching screens. |
| FR-622 | The scanner shall offer a toggle to the player's My QR, and back. | Must | F-162 | Given the scanner is open, when the player taps the My QR toggle, then their rotating personal code is shown full-screen. Given My QR is shown, when the player taps the toggle again, then the scanner returns. |
| FR-623 | Leaving an event shall take two deliberate taps: tapping the event pill in the top bar opens a sheet listing "Questify home" and the player's other events, and tapping an entry goes there. | Must | F-163 | Given a player inside event A who has also joined event B, when they tap the event pill, then a sheet shows "Questify home" and event B, and tapping event B opens event B. Given the sheet is open, when the player dismisses it, then they stay in event A. |
| FR-624 | When opened, the app shall open inside the event the player is in during that event's dates, and otherwise on Questify home. | Must | F-164 | Given a player joined an event that runs today, when they open the app, then it opens on that event's Home. Given the player's only event ended yesterday, when they open the app, then it opens on Questify home. |

#### Big screen

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-630 | The dashboard shall give the organizer a big-screen link for the event that opens as a web page on any screen with a browser. | Must | F-156 | Given an organizer copies the big-screen link, when it is opened in a browser on a TV or laptop, then the event's big screen shows. Given the app is not installed on that screen, when the link is opened, then the big screen still works. |
| FR-631 | The dashboard shall let the organizer pick which scenes the big screen shows and set their order. | Must | F-156 | Given the organizer picks the live ranking and the community quest scenes in that order, when the big screen runs, then it shows those two scenes in that order. Given a scene the organizer did not pick, when the big screen runs, then that scene never appears. |
| FR-632 | The big screen shall offer a live ranking scene showing the event's top 10, updating within seconds of a score change. | Must | F-157 | Given a player's score lifts them into the top 10, when the live ranking scene is showing, then the scene shows them within seconds without a page reload. Given a banned or excluded player, when the scene shows, then they never appear. |
| FR-633 | The big screen shall offer a community quest scene showing live progress toward the shared goal. | Should | F-158 | Given a community quest is running, when players contribute, then the scene's progress rises without a page reload. Given the goal is reached, when the scene shows, then it shows the goal as reached. |
| FR-634 | The big screen shall offer a live poll results scene showing a live poll's results as votes come in. | Should | F-158 | Given a live poll is open, when players vote, then the scene's results update without a page reload. Given the poll closes, when the scene shows, then it shows the final results. |
| FR-635 | The big screen shall offer a photo wall scene that shows only approved photo submissions the organizer picked, from players who allowed that specific photo on screen. | Could | F-159 | Given an approved photo the organizer picked and the player allowed on screen, when the photo wall shows, then the photo appears. Given an approved photo the organizer picked but the player did not allow on screen, when the photo wall shows, then that photo never appears. |
| FR-636 | When submitting a photo to a quest, the app shall let the player allow or not allow that specific photo on the big screen, and the system shall record the choice per photo. | Could | F-159 | Given a player submits a photo and allows it on screen, when the organizer builds the photo wall, then the photo is eligible. Given the same player submits a second photo and declines, when the organizer builds the photo wall, then only the first photo is eligible. |
| FR-637 | The dashboard shall let the organizer pick photos for the photo wall only from submissions that are approved and allowed on screen. | Could | F-159 | Given an approved, allowed photo, when the organizer opens the photo wall picker, then it is listed. Given a photo still pending review or rejected, when the organizer opens the picker, then it is not listed. |

### 1.7 Area 7 — The Questify layer

The Questify layer is the player's lifetime profile across all events (ADR-044). It uses
Questify's default words, not an event's renamed words (ADR-058).

#### Profile and progression

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-701 | The app shall give each player one Questify profile across all events, showing character, frame, title, level with XP bar, achievements, Event Passport and event history. | Must | F-127 | Given a player who played three events, when they open their profile, then it shows all three in their history and passport, plus their level, XP bar and achievements. Given a new player who has played no event, when they open their profile, then it shows level 1, an empty passport and locked achievements. |
| FR-702 | Another player viewing a profile shall see only username, character, frame, title, level, achievements and passport. | Must | F-127 | Given player A opens player B's profile, when it loads, then A sees B's username, character, frame, title, level, achievements and passport only. Given B gave a full name, phone and city, when A views B's profile, then none of these is shown. |
| FR-703 | The app shall let a player edit their username, character, frame and title. | Must | F-143 | Given a player picks a different owned frame, when they save, then the new frame shows on their profile and ranking rows. Given a player picks a frame they don't own, when they try to equip it, then it cannot be equipped. |
| FR-704 | The system shall filter new usernames as user content and reject unacceptable ones with a reason. | Must | F-143 | Given a player enters an acceptable username, when they save, then it is accepted. Given a player enters a username the filter blocks, when they save, then it is rejected with a message and the old username stays. |
| FR-705 | The system shall rate-limit username changes. | Must | F-143 | Given a player who has not changed their username recently, when they change it, then the change is accepted. Given a player who has reached the change limit, when they try again, then the change is refused with a message saying when they can change it next. |
| FR-706 | The app shall show a level title for each level range, written in Arabic and English in the adventure theme. | Must | F-128 | Given a player's level falls in a title's range, when they view their profile in Arabic, then the Arabic level title shows. Given the player levels into the next range, when they view their profile, then the new title replaces the old one. |
| FR-707 | The system shall award Questify achievements in bronze, silver and gold tiers for events attended, quests done, cities played, top-10 finishes and community goals reached. | Must | F-58 | Given a player meets the bronze threshold for events attended, when the qualifying event is recorded, then the bronze achievement is awarded (at the player's next sync, seconds later: opening Profile or Questify quests, returning to the app, or about 15 seconds after a completion; ADR-274, amended 2026-10-26). Given a player already holds bronze, when they meet the silver threshold, then the achievement moves to silver. |
| FR-708 | The app shall show achievements not yet earned as silhouettes. | Must | F-58 | Given a player without any cities-played achievement, when they open achievements, then that achievement shows as a silhouette. Given the player earns it, when they reopen achievements, then it shows in full with its tier. |
| FR-709 | The system shall add an Event Passport stamp for every event a player played, showing the event's logo, its date and the player's final rank. | Must | F-133 | Given a player who played an event that has ended, when they open their passport, then a stamp shows the event's logo, date and final rank. Given an event that is still running, when the player opens their passport, then no final rank is shown for it yet. |
| FR-710 | The system shall offer always-on Questify quests (for example attend 3 events, play in 2 cities, set your interests, follow Questify) that players complete across events. | Must | F-132 | Given a player has attended 2 events, when they join and play a third, then the "attend 3 events" Questify quest completes and its reward is granted (at the player's next sync, seconds later; ADR-274, amended 2026-10-26). Given a player has already completed a Questify quest, when they meet its condition again, then the reward is not granted twice. |
| FR-711 | The Questify console shall let the Questify team run seasonal Questify quest campaigns for a period the team sets. | Must | F-132 | Given the Questify team publishes a seasonal campaign, when its start date arrives, then its quests appear to players. Given the campaign's period has ended, when a player opens Questify quests, then the campaign's quests are no longer offered. |

#### Special items, gems and the Questify shop

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-720 | The app shall keep each player's earned frames and titles in a locker, from which the player equips one frame and one title. | Must | F-129 | Given a player earns a new frame, when they open the locker, then the frame is there and can be equipped. Given a player equips a title, when another player views them on a ranking or profile, then that title shows. |
| FR-721 | The system shall unlock an item for the player at every level-up. | Must | F-131 | Given a player reaches a new level, when the level-up happens, then an item is added to their locker and the player is told which. Given a player jumps two levels at once, when the level-ups happen, then they get two items. |
| FR-722 | The system shall offer extra characters beyond the starter avatars, which players earn and pick for their profile. | Should | F-130 | Given a player earns an extra character, when they edit their profile, then they can pick it. Given a player has not earned an extra character, when they edit their profile, then only the starter avatars and earned characters are selectable. |
| FR-723 | The dashboard shall let the organizer grant an exclusive event souvenir (frame, title or character) to the event's winners, finishers or everyone who attended. | Should | F-134 | Given the organizer grants a souvenir frame to everyone who attended, when the grant runs, then every attendee finds the frame in their locker, marked as from that event. Given a player who did not attend, when the grant runs, then they do not get the souvenir. |
| FR-724 | The system shall keep gems as a separate Questify currency, earned only from Questify quests, Questify achievements and level-ups. | Should | F-135 | Given a player completes a Questify quest that rewards gems, when it completes, then their gem count rises and their event points and XP are unchanged by the gems. Given a player completes the daily challenge or keeps their daily streak, when it is recorded, then no gems are awarded. |
| FR-725 | The app shall offer no way to buy gems or items with money, and no way to trade gems or items between players. | Should | F-135, F-136 | Given a player opens the gem shop, when they look for a way to add gems, then no purchase option exists. Given two players, when either looks at the other's profile or locker, then no gift or trade option exists. |
| FR-726 | The app shall offer a Questify shop where players spend gems on frames, titles and characters. | Should | F-136 | Given a player with enough gems, when they buy a frame, then the gems are deducted and the frame is added to their locker. Given a player with too few gems, when they try to buy an item, then the purchase is refused and their gems are unchanged. |

#### Daily, discovery and invitations

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-730 | The app shall offer a daily challenge of three quick questions a day, drawn from a question bank the Questify team fills, that gives XP. | Should | F-137 | Given a player opens today's daily challenge, when they answer the three questions, then they earn XP and the challenge shows as done for today. Given the player already finished today's challenge, when they open it again the same day, then no further XP can be earned until the next day. |
| FR-731 | Completing the daily challenge shall keep the player's Questify daily streak alive. | Should | F-137 | Given a player has done no event or Questify quest today, when they complete the daily challenge, then their daily streak continues. Given platform admins switched the daily streak off, when a player completes the daily challenge, then no streak is shown or counted. |
| FR-732 | The Questify console shall let the Questify team mark a day's daily challenge as funded by a sponsor, and the app shall show that sponsor on that day's challenge. | Should | F-137 | Given the team marks Monday's challenge as funded by a sponsor, when a player opens Monday's challenge, then the sponsor is shown. Given Tuesday has no sponsor, when a player opens Tuesday's challenge, then no sponsor is shown. |
| FR-733 | The app shall let a player set their interests and city on their profile, and change them later. | Should | F-138 | Given a player selects interests and a city, when they save, then these are stored on their profile and not shown on their public profile. Given a player clears their interests, when they save, then the change is kept. |
| FR-734 | The app shall show a "For you" list of public events recommended from the player's interests and city. | Should | F-138 | Given a player interested in sport living in Riyadh, when they open "For you", then public events matching those appear. Given a private event matching the player's interests, when "For you" loads, then the private event is not listed. |
| FR-735 | The app shall ask for marketing consent separately per channel (push, SMS, email), with every option off by default. | Must | F-140 | Given a new player reaches the marketing consent step, when it shows, then push, SMS and email are all unticked. Given the player skips the step, when it closes, then they are opted out of all three channels. |
| FR-736 | The app shall let a player change each marketing channel's consent at any time from settings, and the system shall record each change with its date and channel. | Must | F-140 | Given a player opted in to SMS, when they turn SMS off in settings, then they receive no further promotional SMS and the change is recorded with date and channel. Given a player turns email on, when the change is saved, then the opt-in is recorded with date and channel. |
| FR-737 | The system shall send promotional push, SMS and email only to players opted in on that channel. | Must | F-140 | Given a player opted in to push only, when Questify sends a promotion on all channels, then the player receives the push but no SMS or email. Given a player opted in to nothing, when a promotion is sent, then they receive nothing. |
| FR-738 | The dashboard shall let an organizer request a Questify invitation to players chosen by interests, city or event history, for one of their events. | Should | F-139 | Given an organizer requests invitations for players interested in tech in Jeddah, when Questify sends them, then only opted-in players matching those criteria are invited. Given a matching player who has not opted in to promotional messages, when invitations are sent, then that player receives none. |
| FR-739 | The dashboard shall show an organizer only the results of their Questify invitations (counts sent, opened and joined), never the identities of the invited players. | Should | F-139 | Given an invitation campaign has run, when the organizer opens its results, then they see the numbers sent, opened and joined. Given the organizer looks for who was invited, when they browse the results or exports, then no player names, usernames, phones or emails are available. |
| FR-740 | The system shall bill Questify invitations to the organizer on the web, never inside the mobile app. | Should | F-139 | Given an organizer requests an invitation campaign, when it is confirmed, then the charge is handled on the web dashboard. Given any player or operator in the mobile app, when they use any screen, then no invitation purchase appears. Clarification (T-409, ADR-329): "confirmed" is a Questify admin's approval in the console; the charge is the off-platform invoice of ADR-064 and ADR-076, and the platform holds no price. |

#### After the event

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-750 | After an event ends, the system shall keep its rewards shop open for the organizer-set window (3 days if the organizer sets none), then close the event balance. (Amended 2026-10-27, T-410 plan, ADR-336, ADR-337: after the end the window may only grow and is frozen once closed; the balance closes by rule with no ledger write; holds made before the close stay collectible, FR-1609.) | Must | F-142 | Given an event ended 1 day ago with the default window, when a player opens its rewards shop, then they can still redeem with their balance. Given the window has passed, when the player opens the event, then the shop no longer accepts redemptions and the balance shows as closed. |
| FR-751 | After an event's balance closes, the system shall keep the player's score, rank, passport stamp, souvenirs, XP, level, achievements and items from that event permanently. | Must | F-142 | Given an event whose balance closed, when the player opens their profile and passport, then the event's stamp, final rank and souvenirs are still shown. Given the balance closed, when the player checks their XP and level, then nothing earned at that event was removed. |
| FR-752 | When an event ends, the app shall produce an event recap card for each player showing their rank, quests done and souvenir, which the player can share. (Amended 2026-10-27, T-410 plan, ADR-339: the rank is the final rank once results are revealed; the card is shared as an image made on the phone, or as one text line on a build without the share modules.) | Should | F-141 | Given an event has ended, when the player opens its recap card, then it shows their final rank, quests done and any souvenir, and a share action. Given the player earned no souvenir, when the recap card shows, then it shows rank and quests done without a souvenir. |

### 1.8 Area 8 — Event home, venue map and Questify home

#### Event Home and info

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-801 | The event Home shall show the event banner with a countdown, the player's event progress, the ranking card and the player's goal. | Must | F-50 | Given a player inside a running event with the ranking on, when they open Home, then they see the banner with countdown, their progress, the ranking card and their goal. Given the owner turned the ranking off, when the player opens Home, then the ranking card is not shown and the rest is. |
| FR-802 | Tapping the ranking card on the event Home shall open the ranking screen. | Must | F-50, F-09 | Given the ranking card is shown, when the player taps it, then the 11-row ranking screen opens. Given the player is ranked below 10th, when the card shows, then it reflects their real rank. |
| FR-803 | The goal on the event Home shall show the player's pinned reward and what is left to earn, or the next reachable reward when no reward is pinned. | Must | F-50, F-126, F-151 | Given a player pinned a reward costing 500 with a balance of 380, when they open Home, then the goal shows that reward and 120 left. Given a player with no pinned reward, when they open Home, then the goal shows the next reward they can reach and how much more they need. |
| FR-804 | The event Home shall show "Up next": one suggested open quest, chosen as the nearest, the one ending soonest or the best value, with a Go button that opens it. | Must | F-165 | Given a player with open quests, when they open Home, then one suggested quest shows with a Go button, and tapping Go opens that quest. Given a quest the player already completed, when Up next is chosen, then that quest is not suggested. |
| FR-805 | The app shall offer an event info page with about, venue and address, organizer contact, FAQ, rules and a link to the organizer's site. | Must | F-168 | Given an event with all info filled in, when a player opens the info page, then every listed section is shown. Given the player taps the venue address, when the tap registers, then the phone's maps app opens at that address. |
| FR-806 | The event Home shall show a "Happening now" strip of what is live: open categories, flash quests and boosts, live polls, the community quest and current sessions. | Should | F-166 | Given a flash quest and a live poll are running, when the player opens Home, then both appear in the strip. Given the flash quest ends, when the player returns to Home, then it is no longer in the strip. |
| FR-807 | The event Home shall show the organizer's latest announcements. | Should | F-167 | Given the organizer posts an announcement, when a player opens Home, then the announcement shows at the top of the announcements. Given the organizer posts a newer announcement, when a player opens Home, then it shows above the older one. |
| FR-808 | The dashboard shall let the organizer add agenda sessions (time, room, speaker) by hand or by importing a spreadsheet. | Should | F-169 | Given the organizer imports a spreadsheet of sessions, when the import completes, then each session appears with its time, room and speaker. Given the organizer adds a session by hand, when they save, then it appears in the agenda in time order. |
| FR-809 | The app shall show players the event's agenda as a list of sessions with time, room and speaker, without bookmarks, reminders or a personal schedule. | Should | F-169 | Given an event with sessions, when a player opens the agenda, then they see the list ordered by time. Given any session, when the player looks for a bookmark, reminder or add-to-my-schedule action, then none exists. |
| FR-810 | The dashboard shall let the organizer link a quest (for example an enter-the-code check-in or a survey) to an agenda session, and the app shall show the linked quest on that session. | Should | F-169 | Given a "rate this session" survey linked to a session, when a player opens that session, then the survey quest is shown and can be opened. Given a session with no linked quest, when a player opens it, then no quest is shown. |

#### Maps

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-820 | The dashboard shall let the organizer add any number of named maps to an event, each an uploaded picture. | Must | F-63 | Given the organizer uploads pictures named "Floor 1", "Floor 2" and "Outdoor area", when they save, then the event has three maps with those names. Given a map with no pins, when a player opens it, then the uploaded picture shows on its own. |
| FR-821 | The app shall let players switch between an event's maps by name. | Must | F-63 | Given an event with three maps, when the player picks "Floor 2", then the Floor 2 picture shows. Given the player then picks "Outdoor area", when it loads, then the outdoor map replaces it. |
| FR-822 | The dashboard shall let the organizer place pins on a map: named sections and booths, quests, and amenities (prayer rooms, toilets, food, info desk, first aid). | Should | F-64 | Given the organizer places a prayer-room pin, when a player opens that map, then the pin shows at that spot. Given the organizer removes a pin, when a player reopens the map, then the pin is gone. |
| FR-823 | A quest pin shall show that quest's status for the viewing player (done, open or locked) and its points. | Should | F-64 | Given a quest pin for a quest the player completed, when they view the map, then the pin shows done. Given a quest locked for the player, when they view the map, then the pin shows locked with its points. |
| FR-824 | Tapping a map pin shall show that pin's details. | Should | F-64 | Given a booth pin, when the player taps it, then the booth's name and details show. Given a quest pin, when the player taps it, then the quest's details show. |
| FR-825 | The app shall show maps as a reference only, with no routes, directions or indoor positioning. | Should | F-64, F-170 | Given a player viewing a map, when they look for directions to a pin, then no route or directions are offered. Given the player walks around the venue, when the map is open, then no live position marker moves. |
| FR-826 | The Quests tab shall toggle between a list view and a map view of the event's quests. | Should | F-170 | Given a player on the Quests tab in list view, when they tap the toggle, then the quests show as pins on the map. Given the player is in map view, when they tap the toggle, then the list returns. |
| FR-827 | The map view shall mark "you are here" at the last station the player scanned. | Should | F-170 | Given a player last scanned the quest at booth 12, when they open the map view, then "you are here" shows at booth 12. Given a player who has not scanned any station, when they open the map view, then no "you are here" marker shows. |

#### Questify home

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-830 | Outside events, the app shall show a bottom bar with, in order: Home, Explore, the same large round center button, Shop, Profile. | Must | F-171 | Given a player on Questify home, when any Questify-home screen is open, then the bar shows Home, Explore, center button, Shop, Profile in that order, the same in both languages with Home on the left (ADR-110 note, Q-100). Given the player taps Shop, when it opens, then it is the gem shop, not an event's rewards shop. |
| FR-831 | On Questify home, the center button shall open the scanner to scan an event's join QR. | Must | F-171 | Given a player taps the center button on Questify home, when they scan an event's join QR, then the join flow for that event starts. Given the player scans a QR that is not a Questify join QR, when it is read, then the app says it is not an event join code. |
| FR-832 | Questify Home shall show the player's events grouped as live, upcoming and past, plus the daily challenge, the daily streak and Questify quests. | Must | F-172 | Given a player with one live, one upcoming and two past events, when they open Questify Home, then each event appears under the right group and tapping one opens it. Given platform admins switched the daily streak off, when a player opens Questify Home, then no streak is shown. |
| FR-833 | Explore shall show the public events list, the "For you" list and the Questify-wide ranking. | Must | F-173 | Given public and private events exist, when a player opens Explore, then only public events are listed. Given the player taps an event in the list, when it opens, then they can view it and join. |

### 1.9 Area 9 — Staff mode

Operators work in the mobile app's staff mode (ADR-027); they have no settings (ADR-037).

#### Access and modes

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-901 | The dashboard shall let the event owner add an operator by email, and the system shall send that person an invite by email (ADR-138, amended 2026-10-22: email only, no phone or SMS invite). | Must | F-174 | Given the owner adds an operator by email, when they confirm, then the person gets an email invite and, after signing in with that email, becomes an operator for that event. Given the owner enters a malformed email, when they confirm, then the dashboard refuses it with a message and no invite is sent. |
| FR-902 | The dashboard shall let the owner generate a personal operator QR for one named person; the code is long and single-use. | Must | F-175 | Given the owner generates a personal operator QR, when the dashboard shows it, then it is tied to one person and can be shown or printed. Given the QR has already been claimed, when anyone scans it again, then the app says it has been used and grants no access. |
| FR-903 | Scanning a personal operator QR shall show "You'll be an operator for <event name>" and ask the person to confirm before access is granted. | Must | F-175 | Given a signed-in person scans a valid operator QR, when they confirm, then they become an operator for that event. Given they decline, when the screen closes, then they are not an operator and the QR is still unclaimed. |
| FR-904 | The dashboard shall show the owner who claimed each personal operator QR. | Must | F-175 | Given a person claims an operator QR, when the owner opens the operators list, then the QR shows as claimed by that person. Given a QR not yet claimed, when the owner opens the list, then it shows as unclaimed. |
| FR-905 | The dashboard shall let the owner remove an operator, taking effect at once. | Must | F-185 | Given the owner removes an operator, when that operator next tries to scan, then the scan is refused and staff mode is no longer available to them. Given the removed operator is on the station screen at the moment of removal, when they scan a player, then no points are awarded. |
| FR-906 | An operator shall not be able to play the event they staff unless the owner allows it. | Must | F-176 | Given an operator the owner has not allowed to play, when they try to complete a quest as a player in that event, then the app does not let them. Given the owner allows that operator to play, when the setting is saved, then Player mode becomes available to them. |
| FR-907 | An operator allowed to play shall switch between Operator mode and Player mode, each with its own home, icons and bottom bar. | Must | F-176 | Given an allowed operator in Operator mode, when they switch to Player mode, then the player Home and player bar replace the operator ones. Given the operator is in Player mode, when they open the scanner, then scans count as player scans, never as operator actions. |
| FR-908 | Every operator ability (scan quests, award by hand, hand over prizes, review submissions, answer the help desk, write NFC tags, show a rotating QR) shall be on by default, and the dashboard shall let the owner turn any of them off per operator. | Must | F-183 | Given a new operator, when they open staff mode, then all seven abilities are available. Given the owner turns off "award by hand" for that operator, when the operator opens Tools, then manual award is not available to them and the other abilities still are. |
| FR-909 | By default an operator shall be able to act at any quest or booth; the dashboard shall let the owner limit an operator to chosen quests or booths. | Should | F-184 | Given an operator with no assignment, when they pick a station, then every quest and booth is available. Given an operator limited to booth 5, when they open station mode, then only booth 5 is available and booth 5 is preselected. |

#### Operator mode

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-920 | Operator mode shall show a bottom bar with, in order: Home, Prize desk, a center Scan button, Inbox, Tools. | Must | F-177 | Given an operator in Operator mode, when any operator screen is open, then the bar shows Home, Prize desk, Scan, Inbox, Tools in that order. Given the owner turned off an operator's prize handover ability, when they open Prize desk, then they cannot mark any prize as handed over. |
| FR-921 | Operator Home shall let the operator pick their station and see today's numbers for it. | Must | F-177 | Given an operator opens Home, when they pick a quest as their station, then station mode starts for that quest. Given an operator assigned to one booth, when they open Home, then that booth is already picked. |
| FR-922 | The operator Tools tab shall hold manual award, rotating QR, write NFC tag, practice mode and switch to Player mode. | Must | F-177 | Given an operator allowed to play, when they open Tools, then all five entries show. Given an operator not allowed to play, when they open Tools, then "switch to Player mode" is not shown. |
| FR-923 | In station mode, after the operator picks a quest or booth once, staff mode shall scan players one after another without asking for the station again. | Must | F-178 | Given an operator picked quest X, when they scan three players in a row, then each scan counts for quest X with no station prompt. Given the operator wants another station, when they change it from Home, then later scans count for the new station. |
| FR-924 | Each station scan shall show a full-screen result: green for success, orange for "already completed", red for failure, each with a sound and a vibration, and the scanner shall be ready again within one second. | Must | F-178 | Given a player who has not done quest X, when the operator scans their My QR, then the screen turns green with a sound and a buzz and the scanner is ready again within one second. Given a player who already completed quest X, when the operator scans them, then the screen turns orange showing "already completed" and no points are awarded. |
| FR-925 | In prize-desk mode, scanning a player's My QR shall show that player's reserved prizes, each with Handed over and Cancel actions. | Must | F-179 | Given a player with two reserved prizes, when the operator scans their My QR, then both prizes show, and tapping Handed over on one marks it collected. Given the operator taps Cancel on a reservation, when it is confirmed, then the points return to the player's balance and the cancellation is written to the points record. |
| FR-926 | Prize-desk mode shall never award points. | Must | F-179 | Given an operator in prize-desk mode, when they scan a player's My QR, then no quest is completed and no points are added. Given a player with no reserved prizes, when scanned at the prize desk, then the screen says there is nothing to hand over. |
| FR-927 | The operator Inbox shall list submissions to review and help-desk tickets in one list, with a count badge on the Inbox tab. | Must | F-180 | Given 3 submissions and 2 tickets waiting, when the operator looks at the bar, then the Inbox badge shows 5 and the list holds all five. Given the owner turned off the operator's review ability, when they open Inbox, then submissions are not listed and tickets still are. |
| FR-928 | Operator Home shall show "My station today": completions at the operator's station today and in the last hour, plus waiting items. | Should | F-181 | Given 40 completions at the station today, 6 of them in the last hour, when the operator opens Home, then it shows 40 today and 6 in the last hour. Given the operator has not picked a station, when they open Home, then no station numbers are shown. |
| FR-929 | Practice mode shall show the real station result screens for test scans but award nothing and record nothing. | Could | F-182 | Given an operator in practice mode, when they scan a player who has not done the quest, then the green result shows but the player's score and the points record are unchanged. Given the operator leaves practice mode, when they scan the same player, then the scan awards points normally. |

#### Renameable words

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-940 | The dashboard shall let the organizer rename "player" and "operator" for an event in one place, in Arabic and English, singular and plural. | Must | F-186 | Given the organizer sets "player" to "student / students" and "طالب / طلاب", when they save, then all four forms are stored for that event. Given the organizer leaves a form empty, when they save, then the dashboard asks for the missing form before saving. |
| FR-941 | The app, dashboard and big screen shall use the event's renamed "player" and "operator" words everywhere inside that event. | Must | F-186 | Given an event that renamed "player" to "visitor", when a player views that event's screens in English, then "visitor" or "visitors" replaces "player" or "players". Given the same player opens Questify home, when it loads, then Questify's default words are used. |
| FR-942 | The dashboard shall let the organizer rename "quest" and "category" for an event in the same way (Arabic and English, singular and plural), applied everywhere in that event. | Should | F-187 | Given an event that renamed "quest" to "mission", when a player opens the Quests tab in English, then it reads "Missions". Given a Questify quest shown on Questify home, when the player views it, then it is still called a quest. |

### 1.10 Area 10 — Organizer dashboard

#### Building events

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-1001 | The dashboard shall let the owner or an editor create an event with its kind (physical, virtual or workplace), dates, venue, visibility (public or private) and join methods. | Must | F-20 | Given a signed-in editor, when they enter a kind, dates, venue, visibility and at least one join method and save, then a new event appears in their event list in the Draft state. Given an end date earlier than the start date, when they save, then the dashboard refuses the save and names the date field to fix. |
| FR-1002 | The dashboard shall offer the join methods event code, join QR, invite link and public list, and shall list the event in the public list only when its visibility is public. | Must | F-20 | Given a public event, when it is live, then players can find it in the public list and can also join by code, QR or link. Given a private event, when a player browses the public list, then the event does not appear and it can be joined only by code, QR or link. |
| FR-1003 | The dashboard shall let the owner or an editor edit and delete an event's details. | Must | F-20, F-196 | Given an event in Draft, when an editor changes its venue and saves, then the new venue is shown in the dashboard and the event preview. Given an editor deletes an event, when they press delete, then a confirmation screen explains what will be removed and nothing is deleted until they confirm. |
| FR-1004 | The dashboard shall let the owner or an editor create, edit, reorder and delete an event's categories. | Must | F-21 | Given an event, when an editor adds a category with its name and rules, then it appears in the category list and the player preview. Given a category that still holds quests, when the editor deletes it, then a confirmation screen states what happens to those quests and players' points before anything is removed. |
| FR-1005 | The dashboard shall let the owner or an editor create a quest of any quest type the app ships, inside a category, with its reward, rules and verification method. | Must | F-21 | Given a category, when an editor picks a quest type, sets its reward, rules and verification and saves, then the quest appears in that category. Given a quest without a category, when the editor tries to save, then the dashboard refuses and asks for a category. |
| FR-1006 | The dashboard shall not offer the video option for submission quests in v1. | Must | F-21 | Given an editor creates a submission quest, when they choose what players submit, then the choices are photo and text only. Given an API request to create a submission quest that accepts video, when it is sent, then it is rejected with a message that video is not available. |
| FR-1007 | The dashboard shall let the owner or an editor edit and delete existing quests, including in a live event, with the choices set in the live-edit rules. | Must | F-21, F-196 | Given a live quest that players completed, when an editor changes its points, then a confirmation screen asks whether to apply the change to future completions only or also to past completions. Given a live quest that players completed, when an editor deletes it, then a confirmation screen asks whether to keep or remove the points players earned from it. |
| FR-1008 | The dashboard shall hold an Arabic value and an English value for every field the organizer writes, and shall require at least one of them. | Must | F-68 | Given a quest title, when an editor enters it, then the dashboard shows one input for Arabic and one for English. Given a title with only an English value, when a player whose app language is Arabic opens the quest, then they see the English value; when both exist, each player sees their own language. |
| FR-1009 | The dashboard shall let the owner or an editor switch these features on or off per event: shop, rank prizes, today's ranking, community quest, streak, live polls, maps, agenda, share quests, mini-games, meet-someone and help desk. | Must | F-25 | Given the shop is on, when an editor switches it off and confirms, then players of that event no longer see the shop anywhere. Given a feature that is not in the reviewed app, when anyone looks for its switch, then no switch for it exists. |
| FR-1010 | The app shall hide a switched-off feature completely, as if it were not there. | Must | F-25, F-41 | Given live polls are off for an event, when a player opens that event, then no poll entry, card, tab or empty state appears. Given the switch is turned back on, when the player reopens the event, then live polls appear without an app update. |
| FR-1011 | The dashboard shall give each organizer account exactly one owner, who can manage billing, the team and everything else. | Must | F-188 | Given an organizer account, when the owner opens team settings, then they can invite and remove editors and open billing. Given the owner tries to remove themselves while they are the only owner, when they confirm, then the dashboard refuses and explains the account needs one owner. |
| FR-1012 | The dashboard shall let the owner invite editors by email, and editors shall build and run events but not change billing or the team. | Must | F-188, F-44 | Given the owner invites an email address as an editor, when the invitee accepts the emailed invite, then they can create and edit events. Given an editor, when they open billing or team settings or call those operations through the API, then the action is refused. |
| FR-1013 | The dashboard shall offer only the owner and editor roles for an organizer team, with no read-only seat. | Must | F-188 | Given the owner invites a team member, when they choose a role, then the only role offered is editor. Given an API request to create a read-only team member, when it is sent, then it is rejected. |
| FR-1014 | The system shall exclude the owner and editors from every board and from rank prizes of the organizer's events. | Must | F-188 | Given an editor who also plays an event, when the ranking is shown, then the editor does not appear on it. Given the editor's points would place them in a rank-prize position, when rank prizes are assigned, then the prize goes to the next eligible player. |
| FR-1015 | The dashboard shall let the owner or an editor start an event from a template (conference, festival, campus or corporate) that pre-fills categories, quests and rewards in Arabic and English. | Must | F-189 | Given an editor picks the festival template, when the event is created, then it holds the template's categories, quests and rewards with both Arabic and English text, ready to edit. Given an editor edits a quest that came from a template, when they save, then only their event changes and the template stays as it was. |
| FR-1016 | The dashboard shall let the owner or an editor duplicate an event into a new Draft event with the same setup, then change its dates and details. | Must | F-190 | Given an ended event, when an editor duplicates it, then a new Draft event appears with the same settings, categories, quests and rewards, and with no players, points or redemptions. Given the duplicate, when the editor changes its dates, then the original event's dates are unchanged. |
| FR-1017 | The system shall give every event one lifecycle state from Draft, Scheduled, Live, Ended and Archived, in that order, and show it in the dashboard. | Must | F-194 | Given a new event, when it is created, then its state is Draft. Given an event in Draft, when an editor tries to make it Scheduled or Live themselves, then the dashboard refuses and explains that Questify activates the event after the invoice is paid. |
| FR-1018 | The system shall keep an Ended event's shop open for the organizer-set window and then close the event balance. | Must | F-194 | Given an event ends with the shop window at its default of 3 days, when a player opens the shop on day 2, then they can still redeem. Given the window has passed, when the player opens the event, then the event balance is closed and the shop no longer accepts redemptions. |
| FR-1019 | The dashboard shall let the owner request activation of an event; editors cannot. | Must | F-195 | Given a Draft event, when the owner taps Request activation, then the request appears in the Questify console's queue. Given an editor opens the same event, when they look for the button, then it is not shown to them. |
| FR-1020 | The platform shall hold no prices, invoices or payments; price and payment are settled outside it. | Must | F-195 | Given an organizer opens the dashboard, when they browse any screen, then no price, invoice or payment screen exists. Given an activation request, when it is sent, then nothing is charged inside the platform. |
| FR-1021 | The Questify console shall let a platform admin activate any event, with or without a request, choosing a hard, soft or no player limit and the add-ons the event bought. | Must | F-194, F-257 | Given a requested event, when the admin activates it with a soft limit of 300, then it moves to Scheduled or Live and the owner is warned at 240 and 300 players. Given a hard limit of 300, when player 301 tries to join, then joining is refused with a clear message and the owner is alerted. |
| FR-1022 | The dashboard shall preview the player screens of an event as players will see them. | Should | F-193 | Given an event with quests and branding, when an editor opens the preview, then it shows the event's Home, quests and shop with the event's text, branding and switched-on features in Arabic and in English. Given the editor uses the preview, when they act in it, then no player, points or completions are created. |
| FR-1023 | The dashboard shall let the owner or an editor brand an event with the organizer's logo, an event banner and one accent color chosen from a curated palette. | Should | F-26 | Given an editor uploads a logo and a banner and picks an accent color from the palette, when a player opens the event, then all three appear. Given an editor looks for free color entry, font or theme settings, when they open branding, then none exist. |

#### Running the event

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-1024 | The dashboard shall show a live scan feed of completions as they happen, per quest and per station, with each quest's completion rate. | Must | F-66 | Given a live event, when a player completes a quest at a station, then the feed shows the completion under that quest and station without a page reload, and the quest's completion rate updates. Given a quest nobody has completed, when the editor views the feed, then the quest shows a completion rate of 0%. |
| FR-1025 | The dashboard shall offer, on one live control screen, launching a flash quest or a boost, sending an announcement and opening a live poll. | Must | F-191 | Given a live event, when an editor launches a flash quest from the control screen, then players see it in the app and receive its push. Given the flash quest or boost feature is switched off for the event, when the editor opens the control screen, then that action is not offered. |
| FR-1026 | The dashboard shall offer, on the same live control screen, pausing a quest and skipping a broken step for players. | Must | F-191, F-196 | Given an open quest, when an editor pauses it and confirms, then players can no longer complete it and see it as paused. Given a broken step in an in-order category, when an editor skips it and confirms on a screen that explains the effect, then players can continue to the next step without completing it. |
| FR-1027 | The dashboard shall offer, on the same live control screen, awarding a quest or points to a player by hand, within the owner-set caps and with a required reason. | Must | F-191 | Given an editor finds a player and enters points and a reason, when they confirm, then the points are added as a new entry in the points record with the editor's name and reason. Given an award above the owner-set cap or without a reason, when the editor confirms, then the award is refused with the reason. |
| FR-1028 | The dashboard shall show live counters for rewards running low on stock, inbox items waiting, flags raised and players online. | Should | F-192 | Given a live event, when a new help-desk ticket arrives, then the inbox counter rises by one without a page reload. Given no flags have been raised, when the editor views the counters, then the flags counter shows 0. |
| FR-1029 | The dashboard shall keep a change log for each event that records who changed what, and when. | Must | F-198 | Given an editor changes a quest's points, when the owner opens the change log, then an entry shows the editor's name, the quest, the old and new values and the time. Given two team members edit the same event, when the log is opened, then both edits appear as separate entries in time order. |
| FR-1030 | The system shall not let anyone edit or delete change-log entries. | Must | F-198 | Given the owner opens the change log, when they look for edit or delete actions on an entry, then none exist. Given an API request to change or delete a log entry, when it is sent, then it is rejected. |

#### Product-wide rule and groundwork

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-1031 | The dashboard and the app shall open a confirmation screen before every consequential action: deleting, an edit that affects players, removing points, cancelling and logging out. | Must | F-196 | Given a player taps log out, when the confirmation screen opens, then nothing happens until they confirm. Given the person dismisses the confirmation screen, when they return, then the action was not performed. |
| FR-1032 | Each confirmation screen shall state exactly what will happen and how, so the person confirms after reading it. | Must | F-196 | Given an editor removes points from a player, when the confirmation screen opens, then it names the player, the points removed and that a new entry is added to the points record. Given a retroactive points change after rank prizes were handed over, when the screen opens, then it states that prizes already handed over are not taken back. |
| FR-1033 | The system shall offer every dashboard action as an API operation that applies the same validation and role rules as the dashboard. | Must | F-197 | Given an editor creates a quest through the API with valid data, when the request is sent, then the quest is created exactly as if made in the dashboard and appears in the change log. Given an API request with an invalid value, when it is sent, then it is rejected with a message naming the field, and nothing is changed. |
| FR-1034 | The system shall let changes be grouped into a change set that lists each item (add, edit or delete) for review before anything is applied. | Must | F-197 | Given a change set that adds two quests and edits one reward, when the owner opens it, then each of the three changes is listed with its before and after values and none is applied yet. Given an item in the set that fails validation, when the set is opened, then that item is marked invalid with its reason. |
| FR-1035 | The system shall apply a reviewed change set in full or only the items the reviewer selects. | Must | F-197 | Given a change set with three items, when the reviewer selects two and applies, then only those two are applied and each appears in the change log. Given the reviewer applies none, when they close the set, then the event is unchanged. |

### 1.11 Area 11 — Notifications and messaging

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-1101 | The app shall send personal push notifications when a submission is approved or rejected, a prize is reserved, ready or expiring, a help-desk reply arrives, and an operator invite is received. | Must | F-199 | Given a player's submission is approved, when the reviewer approves it, then the player receives a push saying so. Given the player has refused push permission, when the submission is approved, then the message still appears in their notification center. |
| FR-1102 | The app shall send event push notifications for announcements, flash quests and boosts, a category opening, community milestones, rank alerts, the event starting soon and streak reminders. | Must | F-199 | Given a category opens in a live event, when it opens, then players of that event receive a push about it. Given a player who has left or not joined the event, when the category opens, then they receive no push for it. |
| FR-1103 | The system shall send pushes with no daily cap and no automatic prayer-time or quiet-hour pauses. | Must | F-199 | Given a player has already received many event pushes today, when another flash quest launches, then they receive its push. Given an announcement is sent at a prayer time or at night, when it is sent, then it is delivered without delay. |
| FR-1104 | The app shall keep every message in an in-app notification center and mark unread messages. | Must | F-200 | Given a player received three pushes during a session, when they open the notification center, then all three are listed and marked unread until opened. Given a player opens one message, when they return to the list, then only that message is marked read. |
| FR-1105 | The app shall ask for push permission only right after the player joins an event, with the stated reason, and never at launch. | Must | F-201 | Given a player opens the app for the first time, when the app launches, then no push permission prompt appears. Given the player joins their first event, when the join completes, then the app explains the reason ("Get told when flash quests drop") and then shows the system prompt. |
| FR-1106 | The app shall never reward granting push permission and shall block nothing when it is refused. | Must | F-201 | Given a player grants push permission, when it is granted, then no points, gems or items are given. Given a player refuses, when they play the event, then every quest, reward and screen works as for a player who granted it. |
| FR-1107 | The dashboard shall let the owner or an editor write an announcement in Arabic and English and send it now or schedule it for a set time. | Must | F-203 | Given an editor writes an announcement and chooses send now, when they confirm, then every player of the event receives it by push and sees it in the app. Given a scheduled announcement, when its time arrives, then it is sent to everyone in the event at that time and not before. |
| FR-1108 | The system shall deliver organizer announcements only by push and in the app, never by email or SMS. | Must | F-203 | Given an editor writes an announcement, when they look for delivery channels, then only push and in-app are offered. Given a player with an email and phone on file, when an announcement is sent, then they receive no email or SMS for it. |
| FR-1109 | The system shall send login codes and operator invites by SMS from the "Questify" service sender, with the purpose stated in the message text. | Must | F-43 | Given a player signs in with a +966 number, when they request a code, then they receive an SMS from "Questify" whose text says it is a login code. Given an operator invite is sent by SMS, when it arrives, then its sender is "Questify" and the text says it is an operator invite. |
| FR-1110 | The system shall send login codes, organizer team invites and organizer alerts by email. | Must | F-44 | Given a player signs in by email, when they request a code, then they receive it by email. Given an organizer turned an alert type off, when that event happens, then no email is sent for it. |
| FR-1111 | The system shall send Questify promotional messages, including organizer invitations, only to players who opted in on that channel (push, email or SMS). | Should | F-204 | Given a player opted in to push but not SMS, when a campaign is sent on both channels, then they receive the push and no SMS. Given a player withdraws their opt-in in settings, when the next campaign is sent, then they receive nothing on that channel. |
| FR-1112 | The system shall send promotional SMS only from a promotional sender registered separately from the "Questify" service sender. | Should | F-204 | Given a promotional SMS campaign, when it is delivered, then its sender is the promotional sender and not the service sender. Given a player opted in to promotional SMS, when they request a login code, then the code comes from the "Questify" service sender and not from the promotional sender. |
| FR-1113 | The system shall record each player's promotional opt-in with its date and channel. | Should | F-204 | Given a player opts in to SMS on a date, when a platform admin checks that player's consent, then the record shows SMS and that date. Given the player later opts out, when the record is checked, then it shows the opt-out and its date. |
| FR-1114 | The system shall include a working opt-out in every promotional message and in the app's settings. | Must | F-204 | Given a player receives a promotional SMS, when they use the opt-out it contains, then they receive no further promotional SMS. Given a player turns off promotional email in settings, when the next email campaign is sent, then they do not receive it. |
| FR-1115 | The app shall let a player mute push notifications per topic: announcements, rank, community and reminders. | Should | F-202 | Given a player mutes rank, when they drop out of the top 10, then they receive no rank push. Given the player muted rank only, when an announcement is sent, then they still receive its push. |

### 1.12 Area 12 — Analytics and reports

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-1201 | The dashboard shall show participation for an event: players joined, active players, activation rate, players over time and returning players. | Must | F-65 | Given an event with players, when an editor opens participation, then the figures and a players-over-time chart are shown. Given an event nobody has joined, when the editor opens participation, then every figure shows 0 and no error appears. |
| FR-1202 | The dashboard shall break participation down by join source: code, QR, link, public list and invitation. | Must | F-65 | Given players joined by code and by QR, when an editor opens the breakdown, then each source shows its own count and the counts add up to the players joined. Given no player joined from the public list, when the breakdown is shown, then that source shows 0. |
| FR-1203 | The dashboard shall build analytics only from actions players take in the app and shall not show time spent or a traffic heatmap. | Must | F-65 | Given an editor opens analytics, when they look through every report, then no average-time-spent or heatmap view exists. Given an editor exports analytics, when the file is opened, then it has no time-spent or heatmap data. |
| FR-1204 | The dashboard shall show quest and category analytics: completion rates, category funnels, where players drop off, and the most and least popular quests. | Must | F-205 | Given an in-order category with four steps, when an editor opens its funnel, then each step shows how many players reached it and the step with the largest drop is visible. Given a category with no completions, when it is shown, then its funnel shows 0 at every step. |
| FR-1205 | The dashboard shall show reward and economy analytics: points earned and spent, redemptions per reward, stock left and unclaimed reservations. | Must | F-206 | Given rewards were redeemed, when an editor opens the economy view, then each reward shows its redemptions and stock left. Given a reservation not yet picked up, when the view is opened, then it counts under unclaimed reservations. |
| FR-1206 | The dashboard shall export to a spreadsheet file the players (with their join fields), completions, redemptions, submissions and survey answers of an event. | Must | F-207 | Given an event with completions, when an editor exports completions, then the file lists every completion of that event. Given an event with no redemptions, when the editor exports redemptions, then the file holds only the column headers. |
| FR-1207 | Exports shall contain only the player data the event's join card disclosed to players before they joined. | Must | F-207 | Given a join card that disclosed username and email only, when an editor exports players, then the file holds username and email and no phone number. Given a player data field the join card did not list, when any export runs, then that field is absent. |
| FR-1208 | The dashboard shall produce a one-page PDF report of an event with its headline numbers and the event's logo. | Should | F-208 | Given an ended event with a logo, when an editor downloads the report, then a one-page PDF shows the headline participation, quest and reward numbers and the logo. Given the report is generated, when it is read, then it holds no individual player's data. |
| FR-1209 | The dashboard shall show survey results per session or quest, with answers and rating averages. | Should | F-209 | Given a survey quest with ratings, when an editor opens its results, then each question shows its answers and its rating average. Given a survey nobody answered, when it is opened, then it shows no answers and no average. |
| FR-1210 | The dashboard shall let the owner or an editor share one session's or quest's survey results with its speaker. | Should | F-209 | Given survey results for one session, when an editor shares them, then the shared results cover only that session. Given the results for one session are shared, when the speaker reads them, then they contain no player's name, phone or email. |
| FR-1211 | The app shall offer an optional thumbs up or down after a player completes a quest, and the dashboard shall show a score per quest. | Could | F-210 | Given a player completes a quest, when the rating appears, then they can rate it or skip it without losing anything. Given ratings for a quest, when an editor opens quest analytics, then the quest shows its score built from those ratings. |

### 1.13 Area 13 — Sponsors and exhibitors

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-1301 | The dashboard shall let the owner or an editor create, edit and delete sponsor profiles with name, logo, tier and booth. | Must | F-211 | Given an editor enters a sponsor's name, logo, tier and booth, when they save, then the sponsor appears in the event's sponsor list. Given a sponsor tagged to quests, when the editor deletes it, then a confirmation screen lists the tagged items that will lose the sponsor. |
| FR-1302 | The dashboard shall let the owner or an editor tag quests, categories, rewards and souvenirs to a sponsor. | Must | F-211 | Given a sponsor profile, when an editor tags a quest to it, then the quest's settings show that sponsor. Given an untagged quest, when a player opens it, then no sponsor appears on it. |
| FR-1303 | The app shall show "presented by" with the sponsor's name and logo on every item tagged to that sponsor, with no further setup. | Must | F-211 | Given a reward tagged to a sponsor, when a player opens the shop, then the reward shows "presented by" with the sponsor's logo. Given the tag is removed, when the player reopens the shop, then "presented by" no longer shows. |
| FR-1304 | The system shall give sponsors no login, no report link and no access to player data. | Must | F-211 | Given a sponsor profile exists, when anyone looks for a sponsor sign-in or sponsor link, then none exists. Given a player completes a quest tagged to a sponsor, when the completion is recorded, then nothing about that player is sent to or viewable by the sponsor. |
| FR-1305 | The app shall show a presented-by category with the sponsor's banner and logo. | Must | F-212 | Given a category tagged to a sponsor with a banner, when a player opens the category, then the sponsor's banner and logo show at its top. Given the sponsor has no banner, when the category opens, then only the logo shows. |
| FR-1306 | The dashboard shall filter an event's analytics and exports by sponsor, covering only the items tagged to that sponsor. | Should | F-214 | Given two sponsors with tagged quests, when an editor filters by one sponsor, then analytics and exports show only that sponsor's quests, categories, rewards and souvenirs. Given a sponsor with no tagged items, when the filter is applied, then every figure shows 0. |
| FR-1307 | The app shall show a sponsor strip on the event Home: a row of sponsor logos, each opening that sponsor's quests. | Could | F-213 | Given an event with three sponsors, when a player opens Home, then the strip shows three logos and tapping one lists that sponsor's quests. Given an event with no sponsor profiles, when a player opens Home, then no strip shows. |

### 1.14 Area 14 — Platform admin, trust and safety

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-1401 | The dashboard shall let anyone create an organizer account and draft events without approval. | Must | F-215 | Given a new visitor, when they sign up, then they become the owner of a new organizer account and can create a Draft event. Given a Draft event of a new account, when the owner tries to publish it, then the dashboard explains that Questify activates events after the invoice is paid. |
| FR-1402 | The Questify console shall let a platform admin activate and suspend organizers and events. | Must | F-216 | Given a paid event, when an admin activates it, then the event leaves Draft and the action is logged. Given an admin suspends an organizer, when the action is confirmed, then the organizer's status shows suspended and the action is logged with the admin's name and time. |
| FR-1403 | The Questify console shall let a platform admin manage Questify quests, achievements, items and the gem shop, daily-challenge questions, event templates, level titles and the XP table. | Must | F-216 | Given an admin adds a daily-challenge question in Arabic and English, when it is saved, then it joins the question bank. Given an admin edits an event template, when an organizer starts a new event from it, then the new event uses the edited template and existing events are unchanged. |
| FR-1404 | The Questify console shall let a platform admin run promotional campaigns, work the moderation queue and review platform flags. | Must | F-216 | Given an admin creates a campaign, when they send it, then it reaches only opted-in players on the chosen channels. Given a new report arrives, when the admin opens the moderation queue, then the report is listed with what was reported and by whom. |
| FR-1405 | The Questify console shall let a platform admin switch any feature that ships in the app on or off with no compliance checklist, because the store declarations always describe every feature as on. | Must | F-216, F-41 | Given a feature that ships in the app, when an admin switches it on for an event, then it takes effect with no checklist step. Given a feature that is not in the reviewed app, when anyone looks for its switch, then none exists. |
| FR-1406 | The Questify console shall manage a review demo tenant whose "App Review Demo" event has every feature and quest type switched on, is hidden from the public and cannot be deleted. | Must | F-227 | Given the demo event, when a reviewer signs in with the reviewer phone number, then every feature and quest type is reachable. Given an admin tries to delete the demo event, when they confirm, then the console refuses, and the event never appears in the public list. |
| FR-1407 | The system shall accept the fixed reviewer login code and the demo QR picker only inside the review demo tenant. | Must | F-227 | Given the reviewer phone number, when the fixed code is entered, then sign-in succeeds into the demo tenant. Given a request using the fixed code or the QR picker against any other tenant's event, when it is sent, then the server rejects it. |
| FR-1408 | The Questify console shall let a platform admin open and edit any organizer's event. | Must | F-218 | Given an organizer reports a broken quest, when an admin opens their event and fixes the quest, then the fix is live for players. Given an admin opens the event only to look, when they leave, then the access is still recorded. |
| FR-1409 | The system shall log every support access to and change in an organizer's event, and show these entries to the organizer. | Must | F-218, F-198 | Given an admin edits a quest in an organizer's event, when the owner opens the change log, then an entry shows that Questify support made the change, what changed and when. Given an admin opened the event without changing anything, when the owner opens the log, then the access appears with its time. |
| FR-1410 | The Questify console shall have one platform-admin role and log every action taken in it. | Must | F-219 | Given an admin suspends an event, when another admin opens the console log, then the entry shows who did it, what and when. Given a signed-in organizer or player, when they try to open the console or call its operations, then access is refused. |
| FR-1411 | The app shall let anyone report any player, username or content, and send the report to the event team and Questify's moderation queue. | Must | F-220 | Given a player reports another player's username in an event, when they submit the report, then it appears in that event team's queue and in Questify's queue. Given the reported item is removed before review, when the report is opened, then it still shows what was reported. |
| FR-1412 | The system shall check every username against Arabic and English word lists and refuse a username that matches. | Must | F-221 | Given a player enters a username containing a listed Arabic word, when they save, then it is refused with a message asking for another username. Given a username that matches no list word, when they save, then it is accepted. |
| FR-1413 | The system shall publish organizer content without an automatic filter, and route reported organizer quests, text and images to Questify's moderation queue. | Must | F-226 | Given an organizer saves a quest, when it is published, then it goes live without any automatic content check. Given a player reports an organizer's image, when the report is submitted, then it appears in Questify's moderation queue. |
| FR-1414 | The Questify console shall let a platform admin unpublish any organizer quest, text or image. | Must | F-226 | Given a reported quest, when an admin unpublishes it, then players no longer see it and the action is logged. Given the organizer opens the event, when the quest was unpublished by Questify, then the change log shows that Questify unpublished it. |
| FR-1415 | The app shall let a player block another player, which hides the blocked player from the blocker's own screens. | Must | F-222 | Given a player blocks another, when they open the ranking or photo wall, then the blocked player's username and content do not show to them. Given the blocked player, when they view their own screens, then nothing tells them they were blocked. |
| FR-1416 | The Questify console shall let a platform admin ban a player from the whole platform, with a required reason, and shall never ban automatically. | Should | F-223 | Given an admin enters a reason and confirms a ban, when it is applied, then the ban holds across every event and is logged with the admin, reason and time. Given no reason is entered, when the admin confirms, then the ban is refused. |
| FR-1417 | The system shall tell a banned player the email address where they can appeal the ban. | Should | F-223 | Given a banned player opens the app, when they are blocked from playing, then they see that they are banned and the appeal email address. Given an appeal is accepted, when an admin lifts the ban, then the player can play again and the lift is logged. |
| FR-1418 | The app shall let a signed-in player download a machine-readable file of their own data from settings. | Must | F-224 | Given a signed-in player, when they request their data, then they receive a file with their profile, events, points record and submissions. Given a deleted account, when its owner tries to request data, then nothing is available. |
| FR-1419 | The Questify console shall show platform numbers: events, players and activity. | Should | F-217 | Given live events exist, when an admin opens platform numbers, then events, players and activity are shown. Given no events yet, when opened, then zero values are shown rather than errors. |

### 1.15 Platform foundations

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-1501 | The system shall serve many organizers and events in one app and one dashboard. | Must | F-40 | Given two organizers, when each creates events, then both use the same app and dashboard and each sees only their own events. Given a player joins events of both organizers, when they open the app, then both events are reachable from the same account. |
| FR-1502 | The system shall isolate each organizer's data so that no organizer, editor or operator can read or change another organizer's events, players, exports or analytics through the dashboard, the app or the API. | Must | F-40 | Given an editor of organizer A, when they request an event, export or analytics of organizer B by its identifier through the API, then the request is refused and no data is returned. Given a request holding only the public app credential and no signed-in user, when it asks for any organizer's data, then it is refused. |
| FR-1503 | The system shall apply changes to features, content, words and branding made in the dashboard or console to players without a store release. | Must | F-41 | Given an organizer renames "quest" for their event, when a player reopens the event, then the new word shows without an app update. Given an organizer changes a reward's name, when a player reopens the shop, then the new name shows without an app update. |
| FR-1504 | The system shall never add a feature by download; only features in the reviewed app can be switched on. | Must | F-41 | Given an organizer opens the feature switches, when they review the list, then every listed feature exists in the reviewed app. Given a new kind of feature, when Questify wants it on, then it reaches players only through a store release. |
| FR-1505 | The system shall treat every quest as a type plus a reward plus rules, so a new quest type can be added without changing how other types behave. | Must | F-42 | Given a release adds a new quest type, when an organizer opens the quest editor, then the new type is offered with the same reward and rules settings as the others. Given existing quests of other types, when the release is installed, then they keep working unchanged. |
| FR-1506 | The app and the dashboard shall offer Arabic and English, with the full layout mirrored right-to-left in Arabic. | Must | F-45 | Given a player sets the language to Arabic, when they open any screen, then text, navigation and layout read right to left. Given they switch to English, when the screen reloads, then it reads left to right with no Arabic text left in the interface. |
| FR-1507 | The app and the dashboard shall show every number in Western digits (0–9) in both languages. | Must | F-45 | Given the app language is Arabic, when a player views points, ranks, dates, times, countdowns and codes, then all digits are 0–9. Given the dashboard language is Arabic, when an editor views analytics and the change log, then every figure, date and time uses 0–9. |


### 1.16 Rules settled while writing this SRS (ADR-075)

These close gaps the area sections left open. They apply across areas. FR-1627 was merged into FR-1418 on 2026-10-17.

FR-253 (pausing flash quests at prayer times) was retired on 2026-10-17: the user chose no prayer-time pauses (ADR-065).

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-1601 | When an award is removed after the player spent points, the system shall lower the balance to no less than zero; the points record still shows the full amount removed. | Must | F-112, F-121 | Given a balance of 50 and a removed award of 200, when the removal is confirmed, then the balance is 0, the score drops by 200 and the record shows −200. Given a balance of 300 and a removed award of 200, when the removal is confirmed, then the balance is 100. |
| FR-1602 | Removing an award shall also remove the Questify XP that award gave (built with the XP ledger, T-401: T-207 shipped removals before XP existed). | Must | F-112, F-124 | Given a removed quest completion worth 25 XP, when the removal is confirmed, then the player's XP drops by 25. Given the drop crosses a level boundary, when it applies, then the level shown is recalculated and items already unlocked stay in the locker. |
| FR-1603 | Cancelling a reservation, by the player, an operator or the pickup timeout, shall return both the points and the unit of stock. | Must | F-145, F-147 | Given a reserved hoodie with 0 left in stock, when the reservation is cancelled, then the player's points return and the stock shows 1. Given the item was already handed over, when anyone tries to cancel it, then cancelling is refused. |
| FR-1604 | While the owner has paused redemption for a player, the system shall block both new redemptions and the handover of that player's existing reservations. | Should | F-152 | Given a paused player with one reservation, when an operator scans them at the prize desk, then the reservation shows as paused and cannot be handed over. Given the owner resumes the player, when the operator scans again, then the handover works. |
| FR-1605 | A player banned from an event shall be unable to earn, redeem or collect prizes in that event, and shall not appear on any of its rankings; their points record is kept. | Must | F-117 | Given a banned player, when they scan a quest, then no completion is recorded and the app says they can no longer take part. Given the ban is lifted by the owner, when they scan again, then completions work again. |
| FR-1606 | A platform-wide ban shall stop the account from signing in; the ban screen shows the reason and the appeal email address, and a platform admin can lift the ban, which is logged. | Should | F-223 | Given a banned account, when it tries to sign in, then sign-in is refused and the reason and appeal address are shown. Given a platform admin lifts the ban, when the player signs in, then sign-in works and the lift appears in the admin log. |
| FR-1607 | Suspending an organizer in the Questify console shall hide its events from players and make its dashboard read-only until the suspension is lifted. Platform flags are the fair-play flags of all events, visible to platform admins. | Must | F-216 | Given a suspended organizer, when a player opens one of its events, then the event is unavailable. Given the suspension is lifted, when the organizer opens the dashboard, then editing works again. |
| FR-1608 | An activated event shall move from Scheduled to Live at its start time, from Live to Ended at its end time or when the owner ends it early after a confirmation, and from Ended to Archived when its shop window closes. (Amended 2026-10-27, T-410 plan review, ADR-337 (5): Ended → Archived waits until the shop is closed, 30 days have passed since the end (the help desk's sending window, ADR-248), no reservation of any kind is left, results are revealed or 60 days have passed since the end, and no help-desk ticket is open; built by T-411, ADR-341.) | Must | F-194 | Given an event scheduled for 09:00, when 09:00 arrives, then it is Live without anyone acting. Given the owner ends it early and confirms, when the confirmation is accepted, then it is Ended and the shop window starts. |
| FR-1609 | A reservation made before an event's shop window closes shall stay collectible until its own pickup deadline. | Must | F-142, F-145 | Given a reservation made one minute before the shop closes, when the player reaches the desk within the pickup time, then it can be handed over. Given the pickup time ends, when the timeout runs, then the points and stock return as in FR-1603. |
| FR-1610 | When a player is in several live events, the app shall open the one they used most recently. | Must | F-164 | Given two live events and the player last used event B, when they open the app, then event B opens. Given no event is live, when they open the app, then Questify home opens. |
| FR-1611 | Today's ranking shall reset when the event day starts (FR-1715). | Should | F-61, F-240 | Given a Ramadan event with the day starting at 4:00 am, when a player scores at 1:00 am, then the points count toward the previous evening's ranking. Given 4:00 am passes, when the ranking refreshes, then today's ranking starts empty and the overall ranking is unchanged. |
| FR-1612 | When the event ranking is turned off, the big-screen ranking scene shall be unavailable and hidden from the scene list. | Must | F-23, F-157 | Given the ranking is off, when the organizer edits big-screen scenes, then the ranking scene is not offered. Given it is turned back on, when the organizer edits scenes, then the ranking scene is offered again. |
| FR-1613 | For a live poll whose results are set to 'never', the big-screen poll scene shall show only the number of votes. | Should | F-100, F-158 | Given a poll set to 'never', when its scene shows, then it displays the vote count and no results. Given a poll set to show results at close, when it closes, then the scene shows the results. |
| FR-1614 | The center button on Questify home shall scan event join QR codes only. (Clarified 2026-10-27, ADR-324: an operator's invite QR also opens there, since it is how staff join an event.) | Must | F-171 | Given a join QR, when the player scans it from Questify home, then that event's join card opens. Given a quest QR, when scanned from Questify home, then the app says to open the event first. |
| FR-1615 | An event streak shall count consecutive event days with at least one completed quest; a day the event is closed does not break it, and missing an open event day resets it to zero. The organizer-set bonus per streak day is paid with that day's first completed quest. | Should | F-59 | Given a 3-day streak and the event closed on Friday, when the player plays on Saturday, then the streak is 4. Given the event was open on Friday and the player didn't play, when Saturday starts, then the streak is 0. |
| FR-1616 | The next reachable reward shall be the player's pinned goal if one is set, otherwise the cheapest in-stock reward they cannot yet afford. | Should | F-126, F-151 | Given a pinned hoodie, when the player opens Home, then the hoodie and the points still needed are shown. Given no pin and every reward already affordable, when the player opens Home, then no next-reward line is shown. |
| FR-1617 | When an item given as a quest or category reward is out of stock, the system shall award only the quest's points and tell the organizer. | Should | F-150 | Given a category whose T-shirt reward has 0 stock, when a player finishes the category, then they receive the points and the app says the item ran out. Given stock runs out, when it happens, then the organizer sees a warning on the dashboard. |
| FR-1618 | Shop tags 'new' and 'limited' shall be set by the organizer; 'popular' shall be applied automatically to the most-redeemed rewards. | Should | F-62 | Given the organizer tags a reward 'new', when players open the shop, then it shows the tag. Given a reward becomes one of the most redeemed, when the shop refreshes, then it shows 'popular' without organizer action. |
| FR-1619 | A daily or weekly category refresh shall reset its quests for completion again and keep every point and record already earned. | Should | F-51 | Given a player earned 300 points in a daily category, when the category refreshes, then their score and history still include the 300. Given the refresh, when the player opens the category, then its quests can be completed again. |
| FR-1620 | A community quest's points reward shall give each eligible player the organizer-set amount. | Should | F-101 | Given a reached goal with a 200-point reward, when it is reached, then each contributing player receives 200. Given the organizer widened eligibility to everyone, when it is reached, then every player in the event receives 200. |
| FR-1621 | The finale's last community push shall be a community quest with a short window, shown in the finale big-screen scene. | Should | F-103 | Given a 20-minute community quest attached to the finale, when the finale scene runs, then its progress bar is shown. Given the goal is missed, when the window ends, then the scene shows it was not reached and no reward is given. |
| FR-1622 | The organizer shall choose who receives an event souvenir: players in a rank range, finishers of an organizer-chosen category or of every quest, or everyone who joined. | Should | F-134 | Given souvenir recipients set to 'top 3', when the event ends, then ranks 1 to 3 receive it. Given 'finishers of category Heritage', when a player completes that category, then they receive it. |
| FR-1623 | Quest ratings shall be switched on per event by the organizer, and players may skip rating. | Could | F-210 | Given ratings are on, when a player completes a quest, then a thumbs up/down prompt appears with a skip option. Given ratings are off, when a player completes a quest, then no prompt appears. |
| FR-1624 | Survey results shall be exportable as a spreadsheet and in the PDF report, so the organizer can share them with speakers. | Should | F-209 | Given a session survey, when the organizer exports results, then the file lists answers and averages for that session. Given a survey with no answers, when exported, then the file says no answers were received. |
| FR-1625 | Analytics shall count an active player as one who completed at least one quest, and the activation rate as active players divided by joined players. | Must | F-65 | Given 1,000 joined and 640 who completed a quest, when the organizer opens participation, then activation shows 64%. Given no player has joined, when it is opened, then activation shows no value rather than an error. |
| FR-1626 | Analytics filtered by sponsor shall show totals only; player-level exports stay with the organizer. | Should | F-214 | Given a sponsor filter, when the organizer opens analytics, then visits, completions and redemptions for that sponsor are shown as totals. Given the sponsor filter, when the organizer exports, then the sponsor export contains no player identities. |
| FR-1628 | The Arabic and English word lists shall also check player-written text (text submissions, help-desk tickets); a match marks the item for its reviewer and does not block it. | Must | F-221 | Given a text submission containing a listed word, when it reaches the review queue, then it is marked for attention. Given a username containing a listed word, when the player saves it, then it is refused as in F-221. |
| FR-1629 | Vote options shall be written by the organizer as text or organizer-uploaded images; player submissions never appear as vote options. | Must | F-06 | Given a vote quest, when the organizer adds options, then only text or their own images can be added. Given the organizer looks for submissions while editing options, when they search, then submissions are not offered. |


### 1.17 Changes from the Stage 1 review (ADR-076 to ADR-085)

Added on 2026-10-17 after the second review pass. Rewritten rows elsewhere in this file: FR-406, FR-414, FR-505, FR-520, FR-1019, FR-1020, FR-1021, FR-1110, FR-1114, FR-1415, FR-1418, FR-1419, FR-1611, FR-1615, NFR-001, NFR-006, NFR-019. "Nickname" became "username" throughout (ADR-084).

| ID | Requirement | Priority | Feature | Acceptance criteria |
|---|---|---|---|---|
| FR-1701 | Usernames shall be strictly unique, compared without regard to letter case, and shown on the profile as @username. | Must | F-228 | Given @ahmed exists, when another player tries Ahmed, then the app says it's taken. Given a free username, when the player saves it, then the profile shows @username. |
| FR-1702 | The system shall keep every username a player has used, visible to platform admins, and allow changing a username only while the platform setting permits it. | Must | F-228, F-262 | Given changes are allowed and a player renames @ahmed to @falcon, when an admin opens the account, then both names appear in its history. Given changes are switched off, when a player opens profile editing, then the username can't be edited. |
| FR-1703 | The app shall let a player leave an event after a confirmation screen; they stop playing it and receive no more of its pushes. | Must | F-229 | Given a player leaves an event, when the organizer later sends an announcement, then the player receives no push. Given the player joins again, when they do, then their earlier record in that event is restored. |
| FR-1704 | On account deletion the system shall keep a one-way fingerprint of the phone and email so that event bans and one-time rewards still apply if the same phone or email signs up again. | Must | F-231 | Given a player banned from an event deletes their account and signs up again with the same number, when they try to join that event, then joining is refused. Given the fingerprint, when anyone inspects it, then the original phone or email can't be read from it. |
| FR-1705 | Sign-up shall show the terms and privacy policy before any data is collected and record the accepted terms version and time. | Must | F-232 | Given a new player, when they accept the terms, then the version and time are stored. Given the terms change, when the player next opens the app, then they are asked to accept the new version. |
| FR-1706 | Before a player's first submission, the app shall show the terms again together with the community guidelines. | Must | F-232 | Given a player's first photo quest, when they open the submission screen, then the guidelines and terms are shown and must be accepted. Given they accepted before, when they submit again, then the screen goes straight to the camera. |
| FR-1707 | The app shall offer Settings → Legal (terms, privacy policy, community guidelines), a contact page with the support details, and a web page for each event's official rules. (2026-10-23, T-214, ADR-165: the rules page and the app's rules section show a fixed block built from the event's data, then the organizer's text.) | Must | F-232, F-259, F-153 | Given a player opens Settings → Legal, when they tap a document, then it opens in their language. Given an event with prizes, when anyone opens its rules link, then the rules page loads without the app. |
| FR-1708 | An organizer shall be able to limit a category or a reward to players whose join field or guest-list tag matches chosen values; other players don't see it. | Should | F-233 | Given a category limited to section = Women, when a player whose section is Men opens Quests, then that category is not listed. Given a player whose section is Women, when they open Quests, then it is listed. |
| FR-1709 | For each submission quest, the organizer shall choose whether a rejected submission may be sent again. | Should | F-234 | Given resubmission is allowed, when a player's photo is rejected, then they see the reason and can submit again while the quest is open. Given it isn't allowed, when rejected, then the quest shows as closed for that player. |
| FR-1710 | A submission approved after the event ended shall add its points to score and rank, and to the balance only while the shop window is open. | Should | F-234, F-142 | Given the event ended yesterday and the shop window is open, when a submission is approved, then score, rank and balance rise. Given the shop window has closed, when one is approved, then only score and rank rise. |
| FR-1711 | The dashboard shall let the organizer regenerate a quest's QR; the old code stops working at once. | Must | F-236 | Given a leaked quest QR, when the organizer regenerates it, then scans of the old code are refused. Given the new code, when a player scans it, then the completion is recorded. |
| FR-1712 | The owner or an editor shall be able to award points to every player in an uploaded or pasted list, or to everyone who completed a chosen quest, in one action, with a required reason, logged and outside the daily caps; an editor's amount stays inside the per-award cap (ADR-152, Q-118, amended 2026-10-23: sessions come with T-505, categories later). | Must | F-237 | Given a session whose code failed, when an editor awards 50 points to its attendees with a reason, then each receives 50 and the record shows the bulk award. Given no reason, when they try to confirm, then the award is refused. |
| FR-1713 | Station pages, kiosks and big screens shall work only after being paired from staff mode or the dashboard, and the organizer can revoke a pairing or regenerate a big-screen link at any time. | Must | F-238 | Given a station URL shared on WhatsApp, when it is opened on an unpaired device, then no QR is shown. Given a paired kiosk is revoked, when it next refreshes, then it stops working. *(T-309, ADR-241, pending Q-202: the big-screen link is the plain `/{lang}/screen` address and holds nothing; "Revoke all big screens" takes the place of regenerating it.)* |
| FR-1714 | The organizer shall set the time an event day starts, default 4:00 am in the event's time zone. | Should | F-240 | Given the default, when a player plays at 1:00 am, then it counts toward the previous event day. Given the organizer sets 6:00 am, when 6:00 am passes, then daily features reset. |
| FR-1715 | Today's ranking, daily category refreshes and streak days shall all use the event day from FR-1714. | Should | F-240, F-51, F-59, F-61 | Given the day starts at 4:00 am, when 4:00 am passes, then today's ranking resets and daily categories refresh together. Given 11:59 pm passes, when nothing else changes, then no reset happens. |
| FR-1716 | The organizer shall set one prize desk per event with its location (optionally a map pin), optional opening hours (none: open the whole time) and how players confirm a pickup (ADR-150), all shown on every item reservation. | Must | F-241 | Given a desk set for 4–10 pm in Hall B, when a player reserves an item, then the reservation shows Hall B and 4–10 pm. Given no hours are set, when a player reserves, then the desk shows as open the whole time. Given no desk place is set, when the organizer tries to publish item rewards, then the dashboard asks for the desk first. |
| FR-1717 | After the prize desk's last opening hours, item and experience rewards shall no longer be reservable; digital codes stay redeemable until the shop window closes (ADR-150). | Must | F-242 | Given the desk's last hours ended, when a player opens the shop, then item and experience rewards show as closed and digital codes can still be redeemed. Given the shop window closes, when a player opens it, then nothing can be redeemed. Given the desk has no hours, when the event runs, then nothing closes early. |
| FR-1718 | Rank-prize winners shall get a push naming their prize and the desk's hours as their claim deadline. (Amended 2026-10-23, T-214: the owner sets the claim deadline at the reveal, ADR-162; the app's "You won" card on Home is built, the push itself is sent by T-501 from the revealed places.) | Should | F-243 | Given confirmed winners, when the reveal runs, then each winner receives the push. Given a winner has turned off pushes, when they open the app, then the same message is in their notification center. |
| FR-1719 | Before the reveal, the dashboard shall show the top ranks for prizes with any open flags, and the organizer must confirm (or ban first); confirming freezes the prize ranking. (Amended 2026-10-23, T-214, ADR-163 Proposed: the owner confirms, once the event has ended, the exact places they saw; confirming also stops removals.) | Should | F-244 | Given the third-placed player has an open flag, when the organizer opens confirmation, then the flag is shown next to them. Given the organizer confirms, when later points arrive, then the prize ranking no longer changes. |
| FR-1720 | The dashboard shall generate many single-use operator QRs at once, each with an ability preset (Scanner, Prize desk, Moderator). | Should | F-245 | Given 50 Scanner QRs, when 50 staff claim them, then each becomes an operator with only scanning abilities. Given a QR already claimed, when someone else scans it, then it is refused. |
| FR-1721 | In rehearsal mode the owner, editors and operators shall be able to join a Draft or Scheduled event on real phones and use every feature; no one else can join. | Must | F-247 | Given a Draft event, when an operator scans the printed quest QR, then the completion is recorded as rehearsal. Given an ordinary player, when they open the event's link, then they cannot join yet. *Built (T-211, ADR-158):* "the team" is whoever the owner or an editor gives the event's rehearsal code to (staff accounts have no phone to match), at most 25 rehearsal accounts an event; a rehearsal account is separate from a real membership. |
| FR-1722 | At go-live, every rehearsal completion, redemption and point shall be wiped, and stock restored. | Must | F-247 | Given rehearsal reservations of 5 hoodies, when the event goes live, then stock is back to its full count. Given rehearsal scans, when the event goes live, then all scores start at zero. *Built (T-211, ADR-157, ADR-160):* flags, awards, handovers and the rehearsal accounts go too; the wipe runs at the tick or the first live write, and the team may erase earlier. A digital reward shows a test code in rehearsal and never spends a real one (ADR-159). |
| FR-1723 | The owner (or a platform admin for a managed event) shall be able to invite a new owner and transfer ownership; the previous owner becomes an editor or leaves. | Must | F-248 | Given Questify built a client's event, when the client accepts the owner invitation, then they own the account and Questify's support access is logged as usual. Given the invitation expires, when the client opens it, then they are asked to request a new one. |
| FR-1724 | The owner shall be able to limit an editor to chosen events; by default an editor sees every event in the account. | Should | F-249 | Given an editor limited to Event A, when they open the dashboard, then Event B is not listed and its exports can't be reached. Given the limit is removed, when they reload, then both events are listed. |
| FR-1725 | The dashboard and the Questify console shall sign people in with email, password and a one-time code sent by email, and end sessions after inactivity. | Must | F-250 | Given a correct password, when the email code is entered, then the session opens. Given a wrong code, when it is entered, then sign-in is refused and repeated failures are rate-limited. |
| FR-1726 | Organizer sign-up shall require accepting the organizer terms, the data processing agreement and the content rules, recording the versions and time; changed documents must be accepted again. | Must | F-252 | Given a new organizer, when they sign up, then the three acceptances are stored with versions. Given the DPA changes, when the owner next signs in, then the dashboard asks them to accept it before continuing. |
| FR-1727 | The system shall email organizers alerts, each type switchable per team member: activated, stock or codes low, new flags, content unpublished, support access, size limit at 80% and 100%. | Should | F-253 | Given stock falls low, when it happens, then subscribed team members get an email. Given an editor switched that type off, when it happens, then they get no email. |
| FR-1728 | Each event shall have a time zone (default Riyadh), and every time the event shows is in that time zone, labelled. | Must | F-254 | Given an event in Dubai time, when a player in Riyadh views a quest's opening time, then it is shown in Dubai time with the zone. Given no time zone chosen, when the event is created, then Riyadh is used. |
| FR-1729 | Features not unlocked for an event at activation shall be hidden in its dashboard and app. | Must | F-257 | Given the big-screen add-on was not unlocked, when the organizer opens switches, then the big screen is not offered. Given an admin unlocks it, when the organizer reloads, then it appears. |
| FR-1730 | The Questify console shall show usage per event and per organizer: login SMS, promotional SMS and email, push volume, players and storage. | Should | F-258 | Given a live event, when an admin opens usage, then today's SMS count is shown. Given an organizer with three events, when opened, then totals and per-event figures are shown. |
| FR-1731 | Platform admins shall edit the support contact details (WhatsApp hotline, email, phone) in the console; the dashboard and app show them without a release. | Must | F-259 | Given the hotline number changes, when an admin saves it, then the contact page shows the new number. Given no WhatsApp number is set, when a player opens the contact page, then only the email and phone are shown. |
| FR-1732 | Reports coming from a live event shall be marked urgent in the console and alert the Questify team. | Must | F-260 | Given a report from a live event, when it arrives, then it is at the top of the queue, marked urgent, and the team is alerted. Given a report about an ended event, when it arrives, then it is queued normally. |
| FR-1733 | The console shall warn when fewer than 7 days of daily-challenge questions are queued; a day with none shows no challenge. | Should | F-261, F-137 | Given 6 days queued, when an admin opens the console, then a warning is shown. Given no questions for today, when a player opens Questify home, then no daily challenge appears and the streak can still be kept by other activity. |
| FR-1734 | Platform settings shall control: XP by difficulty, XP on repeats, whether usernames can be changed, and the daily streak. | Must | F-262 | Given an admin turns on XP on repeats, when a player repeats a quest, then they gain XP. Given username changes are off, when a player opens profile editing, then the username is locked. |
| FR-1735 | An event using a feature newer than the player's app version shall tell the player to update; the platform can force an update below a minimum version. | Must | F-263 | Given a quest type added in a newer version, when an older app opens it, then it says to update the app. Given the minimum version is raised, when an older app starts, then it asks to update before continuing. |
| FR-1736 | The review demo event shall never end or archive, needs no activation, and resets the reviewer's progress for each new app build; the reviewer is an operator allowed to play. | Must | F-264 | Given a new build is submitted, when the reviewer signs in, then their demo progress is reset. Given months pass, when the reviewer opens the demo event, then it is still live. |
| FR-1737 | An event's web page, invite links and joining shall work only after the event is activated (rehearsal mode excepted). | Must | F-265 | Given an unpaid Draft event, when someone opens its event page, then it says the event is not open yet. Given the event is activated, when they open it, then the page and Join work. |
| FR-1738 | Promotional SMS shall never be sent between 22:00 and 09:00 Saudi time (01:00–12:00 during Ramadan), and an opt-out shall take effect within 24 hours. | Must | F-204 | Given a promotional SMS campaign scheduled for 23:00, when it is saved, then it is moved to 09:00 or refused with an explanation. Given a player opts out, when 24 hours pass, then no further promotional SMS reaches them. |
| FR-1739 | On account deletion, the player's entries in the points record and logs shall be anonymized, not removed; their scores in past rankings are frozen under an anonymous label. | Must | F-77, F-110 | Given a deleted player who finished 4th, when the ranking is viewed, then 4th shows an anonymous label. Given an auditor opens the points record, when they look at that player's entries, then the amounts remain and no personal data does. |
| FR-1740 | The app shall fill in the SMS login code automatically where the phone allows it. | Should | F-69 | Given an iPhone or Android phone receiving the code, when it arrives, then the code is offered for automatic entry. Given a phone that doesn't support it, when the code arrives, then the player types it. |
| FR-1741 | The event web page shall prompt visitors to install the app before they arrive. | Should | F-72 | Given someone opens the event page days before, when it loads, then it shows 'Get ready: install Questify' with store buttons. Given the event is live, when opened on a phone with the app, then it opens the app instead. |
| FR-1742 | Each quest's details shall name how it is verified, with a direct action (for example 'Show My QR to staff', 'Tap the NFC tag', 'Scan the code'). | Must | F-52, F-54 | Given a staffed challenge, when a player opens it, then it shows 'Show My QR to staff' with a button that opens My QR. Given a quest with both NFC and QR, when opened, then both options are shown. |
| FR-1743 | The app shall use the phone's language (Arabic or English) by default and let the player change it in settings. | Must | F-45 | Given a phone set to Arabic, when the app opens for the first time, then it is in Arabic. Given the player switches to English in settings, when they return, then the app is in English. |
| FR-1744 | The app shall ask for location only when the player first opens a location quest or joins an in-person event, with an explanation first, never at launch; location flags are off for virtual events. | Must | F-86, F-114 | Given a new player, when they open the app, then no location prompt appears. Given a virtual event, when a player plays from abroad, then no 'far from venue' flag is raised. |
| FR-1745 | The system shall flag any two accounts that play the same event from the same device, whatever their sign-in type. | Should | F-114 | Given a phone account and an email account on one device in one event, when both complete quests, then the organizer sees a flag. Given the same two accounts in different events, when they play, then no flag is raised. |
| FR-1746 | Every dashboard screen, including event building, shall be fully usable on a phone browser. | Must | F-251 | Given an editor on a phone, when they create a quest, set its verification and publish it, then every step works without a computer. Given a wide table such as the scan feed, when shown on a phone, then it adapts to the screen and stays readable. |
| FR-1747 | The prize desk shall hold a banned player's reserved items, show "Held, ask the owner" (the same words as a flag's hold, so the desk is not told which), and hand them over only after the owner releases them by lifting the ban. (Amended 2026-10-23: the 10-second Undo is struck, ADR-150; "release" is lifting the ban, ADR-154.) | Must | F-179, F-117 | Given a banned player with a reserved item, when an operator scans them at the desk, then the item shows as held and Handed over is unavailable. Given the owner lifts the ban, when the operator scans again, then the handover works. |
| FR-1748 | The dashboard shall let the owner or an editor pin one quest as the event's current focus; Event Home's Up next shall show the pinned quest, and when none is pinned, the open quest with the best points for its estimated time. | Should | F-266, F-165 | Given a pinned quest that is open, when a player opens Home, then Up next shows it. Given no pin or the pinned quest is closed, when a player opens Home, then Up next shows the open quest with the best points per estimated minute, and shows nothing if no quest is open. |
| FR-1749 | The Questify console shall let a platform admin reorder, hide, rename and choose the icon (from a fixed set) of each item of the player event bar, the Questify home bar, the operator bar, the Profile rows and the Home sections; changes shall reach installed apps without a release. | Must | F-267 | Given an admin moves Rewards to the first slot of the event bar, when a player reopens the app, then Rewards is in the first slot. Given an admin hides the Map tab, when a player opens Quests, then the Map toggle is not shown. |
| FR-1750 | The system shall reject a layout configuration that hides the scanner / My QR button, Settings and legal, or Home, or that has more than five slots in a bar. | Must | F-268 | Given an admin tries to hide Settings, when they save, then the console refuses and names the protected item. Given a configuration with six bar slots, when saved, then it is refused. |
| FR-1751 | (Steps now ten, see FR-1846.) The dashboard shall offer a guided setup wizard when an organizer creates an event, in which each option is shown as a card with a one-line explanation, a mock of what players will see, and a hint about what it needs. | Must | F-269 | Given a new event, when the wizard opens, then each step shows its options as cards. Given the NFC card, when it is shown, then it states that physical tags are needed and that Questify can supply them or the organizer can buy them. |
| FR-1752 | Every wizard step, and the whole wizard, shall be skippable; a skipped step keeps the template's default. | Must | F-269 | Given an organizer skips step 4, when they continue, then the template's verification defaults stay. Given an organizer skips the whole wizard, when they confirm, then a plain Draft is created from the chosen template. |
| FR-1753 | The wizard's choices shall become the same settings and content the dashboard edits, applied through the same operations, and shall be changeable afterwards. | Must | F-269, F-197 | Given an organizer ticks the quiz quest type in the wizard, when the event is created, then a quiz quest example exists and can be edited in the quest builder. Given the organizer later changes a choice in Build, then no wizard step blocks it. |
| FR-1754 | The wizard shall save progress and resume at the same step after the organizer leaves or the session expires. | Must | F-269 | Given an organizer closes the tab at step 6, when they return, then step 6 opens with their earlier answers. Given a different editor opens it, when they continue, then the last save wins. |
| FR-1755 | The wizard shall show a card for an add-on that is not unlocked with an explanation and 'Ask Questify', and shall not allow it to be switched on. | Must | F-269, F-257 | Given the big-screen add-on is locked, when step 7 shows it, then the card explains it and cannot be ticked. Given an admin unlocks it, when the organizer reopens the wizard, then it can be ticked. |
| FR-1756 | The dashboard shall let the organizer re-run the wizard from the event Overview and open any single step from its Build section ('Explain this'). | Should | F-270 | Given an existing Draft, when the organizer taps Guided setup, then the wizard opens with the current choices. Given the Build > Rewards section, when they tap Explain this, then step 6 opens alone. |
| FR-1757 | The Questify console shall let an admin edit the wizard's texts, mock previews and hints without a release. | Should | F-271 | Given an admin changes the NFC hint, when an organizer opens step 4, then the new hint shows. Given an unsaved edit, when the admin leaves, then they are asked to save or discard. |
| FR-1758 | The app shall offer Add to Apple Wallet on iPhone and Add to Google Wallet on Android after a player joins an event and from Profile. | Must | F-272 | Given a player who just joined, when the success screen shows, then the wallet button for their phone is offered. Given a player who already added the pass, when they open Profile, then the button shows 'In your wallet' and does not add a second pass. |
| FR-1759 | The wallet pass shall show the Questify frame with the event's logo and name, its dates, the player's @username, score, balance, level, rank and the time it was last updated. | Must | F-273 | Given a player in an event, when they open the pass, then those fields are shown. Given an event with no logo, when the pass is created, then the Questify frame shows with the event name only. |
| FR-1760 | The pass shall carry one fixed ID code, unique to the player in that event, that the server can revoke and replace. | Must | F-274 | Given a player's pass, when it is scanned at a station, then the server identifies that player in that event. Given the player is banned or leaves, when the code is scanned, then it is refused as not valid. |
| FR-1761 | Stations, kiosks and the prize desk shall accept the pass code like My QR, and the result screen shall show the player's username. | Must | F-274 | Given a player shows their wallet pass to an operator, when the operator scans it, then the quest is completed or the reserved items appear, with the @username on screen. Given the same code scanned at two stations too quickly to travel between them, when it happens, then a flag is raised for the organizer (F-114). |
| FR-1762 | The system shall update a pass when the player's numbers change, no more than once per organizer-visible interval, and the pass shall show when it was last updated. | Must | F-275 | Given a player earns points, when the update interval passes, then the pass is updated through Apple's push service or Google's API. Given Apple does not deliver the update, when the player pulls to refresh the pass, then the latest numbers load. |
| FR-1763 | The pass shall hold only the event, the @username and the numbers above, and never the phone number, email or birth year. | Must | F-273 | Given a pass, when its contents are inspected, then no phone, email or birth year is in it. Given the add-to-wallet button, when tapped, then a line first says the pass is stored in the player's Apple or Google account. |
| FR-1764 | The organizer shall pick one of the Questify team's approved layout presets for an event. | Should | F-276 | Given two presets, one with the Map tab and one without, when the organizer picks the second, then players see no Map tab. Given the Questify team retires a preset, when an event used it, then the event keeps its layout until the organizer picks another. |
| FR-1765 | The Questify console shall show every text in the app as a translation matrix of key, Arabic and English, searchable and filterable by screen and by missing language. | Must | F-277 | Given an admin searches 'Redeem', when results show, then each matching key lists its Arabic and English text. Given a key with no Arabic text, when the admin filters by missing Arabic, then it appears in the list. |
| FR-1766 | An admin shall be able to edit the Arabic text, the English text or both of any key, and the change shall appear in installed apps without a release. | Must | F-277 | Given an admin corrects an English string and saves, when a player reopens the app, then the new text shows. Given the admin saves an empty value, when saved, then the app falls back to the text shipped in the app. |
| FR-1767 | The matrix shall protect the placeholders inside a text (such as {player} and {points}) and refuse a save that removes or renames one. | Must | F-277, F-186 | Given a string containing {player}, when an admin saves a version without it, then the save is refused naming the missing placeholder. Given both languages contain the same placeholders, when saved, then it is accepted. |
| FR-1768 | The app shall ship with Arabic and English defaults for every text and use them when the matrix has no value or cannot be reached. | Must | F-277 | Given no connection to the matrix, when the app starts, then it shows the shipped texts. Given a key the matrix has not set, when its screen shows, then the shipped text appears. |
| FR-1769 | An admin shall be able to switch off any feature platform-wide, with a message players see, and a switched-off feature shall be hidden as if it were absent. | Must | F-278 | Given an admin switches off share quests, when a player opens an event, then no share quest is listed. Given the switch is turned back on, when a player reopens the event, then share quests are listed again. |
| FR-1770 | The console shall let an admin edit the tuning numbers: flag thresholds, QR refresh time, login-code limits, default reservation time, push and SMS limits. | Should | F-279 | Given an admin changes the default reservation time from 60 to 30 minutes, when a new reservation is made, then it expires after 30 minutes. Given a value outside the allowed range, when saved, then it is refused with the range. |
| FR-1771 | An admin shall be able to switch maintenance mode on, globally or for one event, with a message; while on, play is paused and players see the message. | Should | F-280 | Given maintenance on for one event, when a player of that event opens it, then they see the message and cannot scan. Given another event, when its player opens it, then play continues. |
| FR-1772 | An admin shall be able to schedule a banner message to all players on Questify home. | Should | F-281 | Given a banner scheduled for 18:00, when 18:00 arrives, then players see it on Questify home. Given the end time passes, when a player reopens the app, then the banner is gone. |
| FR-1773 | The app shall keep the last configuration it read successfully and use it when a newer configuration cannot be read or is invalid. | Must | F-282 | Given a malformed configuration arrives, when the app loads it, then it keeps using the previous one and shows no error. Given no configuration was ever received, when the app starts, then it uses the settings shipped inside the app. |
| FR-1774 | The Questify console shall let an admin find a player by username, phone or email and view their events, points record, flags and reports, read-only, and shall log every view. | Must | F-283 | Given an admin searches a username, when the player is found, then their record is shown without edit controls. Given the admin opens a record, when they do, then the admin log shows who viewed whom and when. |
| FR-1775 | An admin shall be able to change a player's username, reset their sign-in, and merge a phone account and an email account of the same person after both are verified. | Should | F-284 | Given an offensive username, when an admin changes it, then the old name is kept in the history and the player is told. Given two accounts of one person, when an admin merges them after both codes are verified, then points, items and history are combined and one account remains. |
| FR-1776 | The system shall not restore an account after the player has deleted it. | Must | F-284 | Given a deleted account, when an admin searches for it, then no restore action exists. Given the same person signs up again, when they do, then a new account is created (FR-1704 still applies). |
| FR-1777 | An admin shall be able to send a push to everyone in an event, or to opted-in players chosen by city or interest. | Should | F-285 | Given a push to an event's players, when sent, then all its players receive it. Given a push by city, when sent, then only players who opted in to marketing push in that city receive it. |
| FR-1778 | An admin shall be able to export or delete one player's data on a legal request, and the system shall record that it was done, by whom and when. | Must | F-286 | Given a verified request, when the admin runs the export, then a file of that player's data is produced and the action is logged. Given a deletion request, when it runs, then the account is deleted as in FR-126 and the log shows the request. |
| FR-1779 | An admin shall be able to edit the Arabic and English word lists used to check usernames and player text. | Must | F-287 | Given a new word is added, when a player chooses a username containing it, then it is refused. Given a word is removed, when a player chooses it, then it is accepted. |
| FR-1780 | An admin shall be able to edit the SMS, email and push templates, and the console shall refuse an SMS template that does not state its purpose or a promotional SMS template without the opt-out line. | Should | F-288 | Given a login-code SMS template without a purpose, when saved, then it is refused with the reason. Given a promotional SMS template with the opt-out line, when saved, then it is accepted. |
| FR-1781 | An admin shall be able to publish a new version of a legal document; players and organizers shall be asked to accept it before continuing, and the accepted version and time shall be recorded. | Must | F-289 | Given a new privacy policy version, when a player next opens the app, then they are asked to accept it. Given a player declines, when they decline, then they can read it but cannot continue to play. |
| FR-1782 | An admin shall be able to edit the help and FAQ content in Arabic and English. | Should | F-290 | Given an admin edits an FAQ answer, when a player opens help, then the new answer shows. Given an answer exists in one language only, when a player of the other language opens it, then the available one shows. |
| FR-1783 | The console shall show a platform health view: live events, error counts, SMS delivery rate and queue sizes. | Should | F-291 | Given live events, when an admin opens health, then each shows its players online and errors. Given the SMS delivery rate falls below the tuning threshold, when it does, then the view marks it. |
| FR-1784 | An admin shall be able to change an organizer owner's email, merge two organizer accounts, and pause or restore an organizer; each action shall need a confirmation screen and be logged. | Should | F-292 | Given an owner lost their email, when an admin changes it after verification, then the owner signs in with the new one. Given two accounts merged, when confirmed, then events and team move to one account. |
| FR-1785 | An admin shall be able to add and remove Questify admins, see their active sessions and force a sign-out. | Must | F-293 | Given a lost laptop, when an admin forces a sign-out, then that session ends at once. Given the last admin, when someone tries to remove them, then it is refused. |
| FR-1786 | The Questify-wide ranking shall run in monthly seasons that reset automatically at 04:00 Riyadh time on the 1st of each month, each past month kept and shown in the console, while lifetime XP and level stay; there is no admin reset (amended 2026-10-27, Dhia, Q-292, ADR-323). | Should | F-294 | Given a month ends, when the next one starts at 04:00 Riyadh time on the 1st, then the past month's final ranking stays readable in the console and the new month starts at zero. Given lifetime XP, when the season resets, then each player's level is unchanged. |
| FR-1787 | The dashboard shall let the organizer add sessions with a type (talk, workshop, activity), time, place, speaker names, a description in Arabic and English, and an access mode of open or registration required. | Must | F-295 | Given an organizer adds a workshop with registration required, when a player opens it, then the type, time, place, speakers and description are shown with a Register button. Given an open session, when a player opens it, then no Register button is shown. |
| FR-1788 | The app shall let a signed-in player register for a registration-required session until its registration closes or its seats run out, and shall show Full when no seat is left. | Must | F-296 | Given a workshop with 1 seat left, when two players register at the same moment, then exactly one succeeds and the other sees Full. Given registration has closed, when a player opens the session, then Register is not offered. |
| FR-1789 | A registration shall be free and shall record no payment information. | Must | F-296 | Given a player registers, when the record is stored, then it holds the player, the session and the time only. Given the dashboard, when an organizer edits a session, then no price field exists. |
| FR-1790 | The app shall show a player's registered sessions in My sessions, with time and place and a Cancel button; cancelling frees the seat immediately. | Must | F-297 | Given a registered player cancels after a confirmation screen, when it completes, then the seat count rises by one. Given a session that has already started, when the player opens My sessions, then it is marked as started and Cancel is not offered. |
| FR-1791 | An operator shall be able to check a player in to a session by scanning My QR or the wallet pass; the system shall record attendance and award the session's points, if any, once per player. | Must | F-298 | Given a registered player is scanned at the door, when the scan succeeds, then attendance is recorded and the points are awarded. Given a player who did not register, when scanned at a registration-required session, then the operator sees 'Not registered' and nothing is recorded unless the organizer allows walk-ins. |
| FR-1792 | The system shall send a registered player a reminder push before the session starts, at an organizer-set time that defaults to 15 minutes before. | Should | F-299 | Given a registered player, when 15 minutes remain, then they receive the reminder. Given they cancelled, when the time comes, then they receive nothing. |
| FR-1793 | The app shall warn, without blocking, when a player registers for a session that overlaps one they are already registered for. | Should | F-300 | Given two overlapping workshops, when a player registers for the second, then a warning names the first and asks to confirm. Given they confirm, when they do, then both registrations stay. |
| FR-1794 | The dashboard shall let the organizer import sessions from a spreadsheet and shall show the rows it could not import with the reason. | Should | F-301 | Given a spreadsheet with 20 sessions, when imported, then 20 sessions are created. Given a row with an invalid time, when imported, then that row is listed with the reason and the others are imported. |
| FR-1795 | The dashboard shall report, per session, the seats, the registered, the attended and the no-shows, and export the report. | Should | F-302 | Given a finished session, when the organizer opens the report, then registered, attended and no-shows are shown. Given a session with no registrations, when opened, then zeros are shown. |
| FR-1796 | The organizer shall be able to close or reopen registration and change the seat limit while the event is live; lowering the seats below the registered number shall be refused with that number. | Should | F-303 | Given 40 registered, when the organizer sets the limit to 30, then the change is refused naming 40. Given the organizer raises it to 60, when saved, then players see more seats at once. |
| FR-1797 | The organizer shall be able to push a message to everyone registered for a session. | Should | F-304 | Given a room change, when the organizer sends the message, then every registered player receives the push. Given a player who left the event, when sent, then they receive nothing. |
| FR-1798 | The app shall show, on its first organic launch, a language choice (Arabic or English, with the phone's language preselected) followed by four story cards: join an event, do quests, earn points and climb the ranking, win prizes and grow your profile. | Must | F-82 | Given a first launch, when the app opens, then the language choice shows first, then four cards. Given the player picks English, when the cards show, then they are in English and the choice can be changed later in Settings. |
| FR-1799 | Every intro screen shall have a Skip action, and the last card shall offer Scan an event QR and Explore events. | Must | F-82 | Given the second card, when the player taps Skip, then the intro ends and Questify home opens. Given the last card, when the player taps Explore events, then Explore opens. |
| FR-1800 | The intro shall ask for no permission and collect no data. | Must | F-82 | Given the intro, when it runs, then no system permission prompt appears. Given the player skips it, when they continue, then nothing is stored except that it was shown. |
| FR-1801 | A player who arrives from a join QR or invite link shall see the event preview and the join card first, then the full intro with Skip if it has not been shown on this install, then Home. | Must | F-305 | Given a new install opened from a join QR, when the player joins and signs in, then the intro plays before Home. Given the intro was already shown, when another join QR is scanned, then Home opens after joining with no intro. |
| FR-1802 | The intro shall show once per install, and Settings shall offer How Questify works to replay it. | Must | F-82, F-306 | Given the intro was shown, when the app reopens, then it does not show again. Given the player taps How Questify works, when it opens, then the four cards play and Skip works. |
| FR-1803 | The intro's texts shall come from the translation matrix and its cards shall be orderable and hideable through the layout controls, within the protected items. | Should | F-307 | Given an admin edits a card's text, when a new player opens the app, then the new text shows. Given an admin hides the third card, when the intro plays, then three cards show. |
| FR-1804 | The app shall offer four mini-games as a quest type: memory match, slide puzzle, catch and tap rush, each playable in Arabic and English and right-to-left. | Should | F-87 | Given a mini-game quest, when the player taps Play, then the chosen game opens full screen. Given the phone is in Arabic, when the game shows its instructions, then they are in Arabic and mirrored. |
| FR-1805 | The system shall issue each mini-game round with a start time and a random seed, accept the player's inputs, replay them on the server and decide the result there; a score reported by the phone shall never be trusted. | Must | F-308 | Given a player who finishes a round, when the inputs arrive, then the server replays them and finds the result. Given inputs that cannot produce the reported result, when they are replayed, then the round is rejected and a flag is raised. |
| FR-1806 | A mini-game quest shall pay its points when the player passes the organizer's target (easy, medium or hard), once, on the first pass. | Should | F-87 | Given a target set to medium, when a player passes it, then the points are awarded. Given the same player passes it again, when the result is replayed, then no points are added. |
| FR-1807 | A mini-game quest shall allow the number of attempts the organizer sets, one by default. | Must | F-309 | Given the default of one attempt, when a player has played once, then Play is replaced by 'Already played'. Given three attempts, when a player uses them all, then Play is off and says so. |
| FR-1808 | The organizer shall be able to add their own images to a mini-game's cards, puzzle pictures or falling items. | Should | F-310 | Given an organizer uploads a sponsor logo for memory match, when a player plays, then the cards show it. Given no image, when a player plays, then the default pictures show. |
| FR-1809 | The app shall keep a finished round's result for ten minutes when it cannot be sent, and offer Retry. | Should | F-311 | Given the connection drops at the end of a round, when the player reconnects within ten minutes and taps Retry, then the result is sent. Given more than ten minutes pass, when the player taps Retry, then the result is refused and the round counts as played. |
| FR-1810 | Questify home shall offer one daily word game with a hidden word, six guesses and feedback for each letter (right place, wrong place, absent), in Arabic or English, the same word for everyone that day. | Should | F-312 | Given a player who guesses correctly in four tries, when the result is saved, then the game shows solved in 4 and counts for the daily streak and XP. Given six wrong guesses, when the sixth is entered, then the word is revealed and no XP is given. |
| FR-1811 | The console shall hold a word bank per language with valid guesses and daily words, and a day without a daily word shall show no game. | Should | F-313 | Given no daily word for tomorrow, when an admin opens the word bank, then a warning shows. Given a missing daily word, when a player opens Questify home that day, then the game is not offered. |
| FR-1812 | If a login code sent by SMS has not been entered within about 30 seconds, the sign-in screen shall offer to send a code to an email address instead, without restarting sign-in. | Must | F-314 | Given a code that has not arrived after 30 seconds, when the player taps Send to email, then a code is sent to the email they enter and the SMS code is cancelled. Given the SMS arrives meanwhile, when the player enters it before choosing email, then sign-in succeeds. |
| FR-1813 | The organizer shall be able to set email as the first sign-in option shown to players of an event. | Should | F-315 | Given email is set first, when a player taps Join, then the email field is shown first with phone as the alternative. Given the default, when a player taps Join, then phone is shown first. |
| FR-1814 | The console shall let an admin set the daily challenge and the daily word to run weekly or daily, and shall warn when fewer than two periods of content are queued. | Should | F-316, F-261, F-313 | Given the cadence is weekly and one week of content is queued, when an admin opens the console, then a warning shows. Given the cadence is changed to daily, when saved, then players get a new challenge each day from the next day. |
| FR-1815 | While a player has an open flag, the prize desk shall hold that player's reserved items and show "Held, ask the owner"; the hold ends when an owner or editor clears the flag or bans the player, and the organizer can switch the hold off for an event. | Must | F-317, F-179 | Given a player with an open flag and a reserved hoodie, when the operator scans them at the desk, then the hoodie shows as held and Handed over is unavailable. Given the owner clears the flag, when the operator scans again, then Handed over works. Given the hold is switched off for the event, when the same player is scanned, then the handover works and the flag stays on the list. |
| FR-1816 | The player app shall also be available as a web build that offers every function not needing phone hardware; features that need NFC or a phone wallet shall say so and hide cleanly; scan quests use the browser camera. | Could | F-318 | Given a player opens the event link in a desktop or phone browser, when they sign in, then they can browse, complete quests, scanning with the browser camera and see the ranking. Given a quest needs an NFC tap, when it is shown on the web, then it says it needs the phone app. |
| FR-1817 | After a phone-only player's first sign-in, the app shall invite them once to add an email address, which they may skip; the email fallback in FR-1812 works only for players who have a verified email. | Could | F-319 | Given a phone-only player signs in for the first time, when the home screen opens, then an add-email card shows once and can be skipped. Given a phone-only player with no email and an SMS outage, when they request a code, then the sign-in screen says the email option needs a linked email. |
| FR-1818 | The system shall give each event an access type: Public, Unlisted or Private. A Public event is listed and anyone can join; an Unlisted event is not listed and is joined with its code, join QR or invite link; a Private event also needs the owner's approval. | Must | F-320 | Given a Public event, when a signed-in player opens the public list, then it appears and they can join. Given an Unlisted event, when the list is opened, then it does not appear, and joining works with the code, QR or link. Given a Private event, when a player has the code, then they can only ask to join. |
| FR-1819 | In a Private event the system shall hold each join request as pending until the owner or an editor accepts or declines it, shall let invited people join without approval, shall show a waiting player the event name, banner and a 'Waiting for approval' screen, and shall tell them of the decision by push and in the app. | Must | F-321 | Given a Private event and a player with only the code, when they tap Request to join, then the request is pending and they see the waiting screen. Given the owner accepts it, when the decision is saved, then the player gets a push and can play. Given a guest-list person, when they join, then no approval is needed. |
| FR-1820 | The dashboard shall let the owner or an editor change an event's access type at any time, shall explain the effect on a confirmation screen, and shall keep every current player in the event. | Should | F-322 | Given a live Public event, when the owner switches it to Private and confirms, then current players keep playing and new people must ask to join. |
| FR-1821 | When an event reaches its hard player limit the system shall count accepted players only, shall tell new players the event is full, shall let them join a waiting list, and shall let the owner (within the limit Questify set) or a platform admin release people from it or raise the limit. | Should | F-323 | Given a hard limit of 1,000 and 1,000 accepted players, when another player joins, then they see 'Event is full' and can join the waiting list. Given the limit is raised by 10, when the owner releases 10 people, then they are notified and can play. |
| FR-1822 | The app shall offer one ticket center with four types: Report a player, App problem, Suggestion, and Question or prize problem. The system shall route Report a player and Question or prize problem to the event team, and App problem and Suggestion to the Questify team. | Must | F-324 | Given a player opens a Report a player ticket in an event, when it is sent, then it appears in that event's tickets inbox and not in the Questify queue. Given an App problem ticket, when it is sent, then it appears in the Questify team's queue with the app version and phone model. |
| FR-1823 | The system shall let the receiving team reply once, after which the ticket closes; a further question is a new ticket. The event team shall be able to escalate a ticket to the Questify team with a note, and the Questify team shall be able to answer, send back or take over any ticket. | Must | F-325 | Given a team member replies to a ticket, when the reply is sent, then the ticket status is Closed and the player is notified. Given an event ticket the team cannot solve, when they tap Escalate to Questify, then it appears in the Questify queue with its source. |
| FR-1824 | The app shall show a player their own tickets with status and the team's reply, and a notification history listing every notification they received. | Should | F-326 | Given a player with a closed ticket, when they open Profile, My tickets, then they see the question and the reply. Given 30 earlier notifications, when they open Notification history, then all are listed, newest first. |
| FR-1825 | The dashboard shall show the owner and editors a tickets inbox with counts by type, a list of reported players and content with actions, a filtered view of prize problems, and for Private events a queue of join requests with Accept, Decline and Accept all. | Must | F-327 | Given 3 open tickets of different types, when the owner opens the inbox, then counts by type show 3 and each ticket opens. Given a Private event with 5 requests, when the owner taps Accept all, then all 5 players are accepted and notified. |
| FR-1826 | The Questify console shall let a platform admin set each feature that exists in the app to Off or On for the whole platform, and override it per organizer. A feature that is Off shall be hidden from owners and players. | Must | F-328 | Given a feature set Off platform-wide, when an owner opens the features page, then it is not listed and players never see it. Given an override On for one organizer, when that organizer opens the features page, then the feature is available to them. |
| FR-1827 | The system shall let an owner switch on a feature for an event only if Questify has allowed it for that event; a feature that is not allowed shall show to the owner as a locked card with an Ask Questify request, and shall be hidden from players. | Must | F-329 | Given a feature not allowed for an event, when the owner opens the features page, then it shows a locked card with Ask Questify. Given the request is approved, when the owner reopens the page, then the switch works. |
| FR-1828 | The dashboard shall let the owner or an editor add to the event Home a custom text card (Arabic and English), a row of quick-link buttons (agenda, map, shop, a quest, a web link) with icons from the Questify set, a top-3 podium preview, and a featured quest or reward. | Should | F-330 | Given an owner adds a custom text card, when a player opens Home, then the card shows in the player's language. Given a quick-link to the agenda, when the player taps it, then the agenda opens. |
| FR-1829 | The dashboard shall let the owner or an editor add up to five banner slides to the event Home, each with an image and a tap action; the app shall show one slide as a single banner and several as a swipeable, auto-advancing slider. | Should | F-331 | Given three slides, when a player opens Home, then they can swipe between them. Given a slide whose tap action opens a quest, when the player taps it, then that quest opens. Given one slide, when Home opens, then no slider dots show. |
| FR-1830 | The dashboard shall let the owner or an editor add one or more countdown blocks to Home, each with an Arabic and English label, a target date and time, and a behaviour at zero (hide or show a message). | Should | F-332 | Given a countdown set to 09:00, when it reaches zero with 'show message', then the block shows the message. Given 'hide', when it reaches zero, then the block disappears. |
| FR-1831 | The dashboard shall offer a Home editor in which the owner or an editor reorders blocks by dragging, shows or hides each block, sees a live phone preview, and can apply a Questify preset or reset to the default layout. Protected items shall still not be hideable (FR-1750). | Should | F-333 | Given the owner drags Announcements above Up next, when they save, then players see that order. Given Reset to default, when the owner confirms, then the Questify default order returns. |
| FR-1832 | The dashboard shall let the owner or an editor choose the event ranking layout, List or Podium, and whether scores are shown or only places. Either layout shall fit one screen without scrolling. | Should | F-334 | Given Podium, when a player opens the ranking, then the top 3 are on a podium and the remaining rows and the player's own row fit the screen with no scrolling. Given 'rank only', when the ranking opens, then no scores show. |
| FR-1833 | The dashboard shall let the owner or an editor choose the Quests layout, list or card grid, and the Rewards shop layout, grid or list. | Could | F-335 | Given Card grid, when a player opens Quests, then quests appear as larger cards inside their categories. |
| FR-1834 | The dashboard shall let the owner or an editor switch prize reservation On or Off for an event. When Off, the app shall not offer Reserve; the prize desk shall redeem by scanning the player's My QR or wallet pass code, taking the price from the balance and handing over in one step. The shop shall also be switchable Off. | Should | F-336 | Given reservation Off, when a player opens a reward, then it shows 'Redeem at the prize desk' and no Reserve button. Given the operator scans the player and picks the prize, when they confirm, then the price leaves the balance and the item is handed over. |
| FR-1835 | The dashboard shall let the owner or an editor choose and order the sections of the event info page, and add one extra custom page of text and images reachable from Home. | Should | F-337 | Given the owner reorders FAQ above Contacts, when a player opens Event info, then FAQ comes first. Given a custom page titled Venue rules, when a player taps its Home link, then it opens. |
| FR-1836 | The dashboard shall let the owner or an editor set which notification topics are on by default for the event's players, and players shall still be able to mute any topic. | Could | F-338 | Given 'Rank changes' off by default, when a new player joins, then rank pushes are off for them until they turn the topic on. |
| FR-1837 | The Questify console shall let a platform admin open an organizer's dashboard as that organizer sees it, read-only by default, with a visible banner and a log entry for every view. | Should | F-339 | Given an admin chooses View as organizer, when the dashboard opens, then a banner says it is a read-only support view and the access is in the event's log. |
| FR-1838 | The Questify console shall let a platform admin reorder and hide the blocks on Questify home and edit its banner slider. | Could | F-340 | Given the admin moves the daily word above the daily challenge, when they save, then players see the new order. |
| FR-1839 | The Questify console shall show, per organizer, which features are on and used, so the team can spot who needs help or an add-on. | Could | F-341 | Given an organizer with Cheers off, when the admin opens the usage view, then the row shows Cheers off. |
| FR-1840 | The dashboard shall let the owner or an editor set on a quest a bonus of X points for the first N completions; the system shall count completions inside the completion transaction so no more than N bonuses are paid, and the app shall show the bonuses left. | Should | F-342 | Given N = 50, when two players complete the quest at the same moment as the 50th, then exactly one gets the 50th bonus. Given the bonus is used up, when a player completes the quest, then they earn only the normal points. |
| FR-1841 | The system shall let the owner switch Cheers on or off for an event and start a cheers moment on the big screen. While a moment is live the app shall show a cheer button with five fixed reactions (heart, applause, fire, star, party), and the big screen shall show them floating up; the system shall rate-limit each player and accept no free text. | Could | F-343 | Given Cheers on and a moment started, when a player taps heart, then hearts float across the big-screen Cheers scene. Given no moment is live, when a player opens Home, then no cheer button shows. |
| FR-1842 | The dashboard shall let the owner or an editor choose per event how players are shown, Username only, Full name only or Both, and whether names are visible to everyone in the event or to staff only. Full name requires the full-name join field; the join card shall state who will see the name; Questify-wide pages always show usernames only. | Should | F-344 | Given 'Both' visible to everyone, when a player opens the ranking, then rows show full name and @username. Given 'staff only', when a player opens the ranking, then they see usernames while an operator scanning them sees the full name. |
| FR-1843 | The dashboard shall let the owner or an editor override, per event, a short approved list of labels (bottom-bar names, Rewards, Scan, Quests, Ranking, Profile, the currency word) in Arabic and English, with placeholders protected and the platform text used when blank. | Should | F-345 | Given Rewards renamed Prizes, when a player opens the event, then the bar and shop title say Prizes. Given a blank override, when the player opens the event, then the platform text shows. |
| FR-1844 | The dashboard shall show the owner and editors, per operator and station, scans per hour, awards or handovers and last activity, and shall let them send a push to operators only. | Should | F-346 | Given an operator with no scans for 30 minutes, when the owner opens Operators, then the last-activity column shows it. Given a staff briefing, when it is sent, then only operators receive it. |
| FR-1845 | The dashboard shall show a readiness checklist before go-live and the console shall show the same list for events starting soon; it shall block nothing. | Should | F-347 | Given no rehearsal was run, when the owner opens Overview, then the checklist shows Rehearsal run as missing. Given an event starting tomorrow, when an admin opens the activation view, then the same checklist shows. |
| FR-1846 | The setup wizard shall have these ten skippable steps in order: Basics and access, Join rules, Quests, Rewards, Sponsors, Screens and staff, Home and look, Messages, Add-ons and activation, Rehearse and review. This replaces the twelve steps of FR-1751. | Must | F-348 | Given an organizer opens the wizard, when they view the progress list, then ten steps show and each can be opened. Given any step is skipped, when the wizard continues, then the template's defaults stay. |
| FR-1847 | The dashboard shall let the owner choose, per event, whether shop purchases also lower the ranking score (off by default: purchases lower only the balance), locked once the event is live. | Must | F-121 | Given the option is off, when a player spends 100 points, then the balance drops by 100 and the score and rank do not change. Given the option is on, when a player spends 100 points, then the score drops by 100 and the ranking updates; when the redemption is cancelled, then both come back. Given a live event, when the owner opens the setting, then it cannot be changed. |
| FR-1848 | When a player's My QR cannot be read, the prize desk shall find the player by exact username or exact mobile number among the event's members and show the same items as a scan; every handover still needs the player's own confirmation in their app (ADR-156, added 2026-10-23, Proposed). | Should | F-179 | Given an operator with the hand-over ability types a member's username or mobile number, then the desk shows that player's waiting items. Given a removed player, the operator's own name, or 31 finds in 10 minutes, then nothing is shown and the desk says why. |

## 2. Non-functional requirements

Targets set by the user on 2026-10-17 (ADR-074) or by earlier decisions. Only what planning has
surfaced is listed. Stage 4 adds design targets (contrast, touch sizes), and Stage 6 adds the
technical ones.

| ID | Category | Requirement | Source |
|---|---|---|---|
| NFR-001 | Performance | Within 300 ms of a scan the device shows the "Scanned! checking…" beat; the full celebration follows the server's confirmation (NFR-002) | F-56, ADR-083 |
| NFR-002 | Performance | 95% of quest completions are confirmed by the server within 1 second, including during the peak burst (NFR-003) | ADR-074 |
| NFR-003 | Scale | One event absorbs a burst of 20,000 quest completions within one minute without losing any. A player whose request is rejected under load gets a clear retry message | ADR-062, ADR-074 |
| NFR-004 | Scale | One event supports 50,000+ players, and one announcement can be pushed to all of them | ADR-062 |
| NFR-005 | Performance | The live ranking, in the app and on the big screen, reflects a score change within 5 seconds | ADR-074 |
| NFR-006 | Availability | The player service, dashboard, staff mode and big screen are available 99.9% of each month. Planned maintenance runs in the lowest-traffic hours, with live events warned in advance | ADR-074 |
| NFR-007 | Reliability | The app is online-only. An action that fails for lack of connection is never silently lost or half-applied: the player sees a clear message and can retry | ADR-029 |
| NFR-008 | Compatibility | The app runs on iOS 16.4 and later (ADR-127) and Android 9 and later, on phones and tablets. Kiosk and station screens work on tablets | ADR-074, F-107 |
| NFR-009 | Compatibility | Animations degrade gracefully on low-end Android devices, and the phone's reduce-motion setting replaces them with static versions | F-11, research §6 |
| NFR-010 | Compatibility | Each store build meets the target-SDK and privacy-manifest requirements in force on its submission date | Q-046 |
| NFR-011 | i18n | Every user-facing string exists in Arabic and English, with full RTL. Every screen is checked in both directions | F-45 |
| NFR-012 | i18n | Numbers always use Western digits (0–9), including in the Arabic interface | ADR-018 |
| NFR-013 | i18n | Display text uses Baloo Bhaijaan 2 and body text uses Rubik, in both scripts | ADR-017 |
| NFR-014 | i18n | Renamed words (player, operator, quest, category, currency) read correctly in every string where they appear, in Arabic and English, singular and plural | ADR-058 |
| NFR-015 | i18n | Saudi-facing legal text, consents, prize rules, SMS, push and store listings are written in Arabic first, with English alongside | PD-25 |
| NFR-016 | Security | No organizer, editor or operator can read or change another organizer's data. This is enforced on the server and proven by tests that use only the public app credential | ADR-003, F-40 |
| NFR-017 | Security | The demo-only login code and QR picker work only inside the review demo tenant, proven by an outsider test | ADR-009 |
| NFR-018 | Security | Every server function and storage area is closed to the public by default; each grant is explicit and tested from an outsider's seat | ADR-003, global standards |
| NFR-019 | Auditability | Point changes, organizer edits, operator actions, data exports, and platform-admin or support actions are all recorded with who, what and when. Records are never edited or erased; corrections are new entries. On account deletion, a player's entries are anonymized, not removed. *Proposed (ADR-157, Q-124, T-211):* rehearsal records (ADR-080) are not part of the record: they are erased at go-live, and the erase is audited with counts | F-110, F-198, F-218, F-219, F-77 |
| NFR-020 | Privacy | Personal data is stored and processed in Saudi Arabia. Every vendor that receives personal data is listed in a data map | ADR-070 |
| NFR-021 | Privacy | No ad networks or tracking SDKs. Location only while the app is open. Photos only through the system picker or the camera. No permission is ever a condition for points or prizes | PD-27, ADR-072, PD-10, PD-08 |
| NFR-022 | Compliance | The store age rating, privacy labels and data-safety form always describe every feature as switched on | ADR-073 |
| NFR-023 | Configurability | Features are switched on or off, and content, words and branding changed, without a store release. No feature or code is ever downloaded | ADR-004, ADR-007, ADR-073 |
| NFR-024 | Maintainability | Design tokens are organized so a second visual theme can be added without rewriting screens | ADR-061 |

| NFR-025 | Scale | The platform runs up to 10 live events at once with about 100,000 players live in total, while each event meets NFR-002 to NFR-005 | ADR-082 |
| NFR-026 | Recovery | At most 5 minutes of data can be lost (point-in-time backups), and service is back within 1 hour; a restore is rehearsed before launch | ADR-082 |
| NFR-027 | Compatibility | Every dashboard screen works on current phone browsers as well as on computers | F-251 |
| NFR-028 | Performance | The first install stays small enough to download on a congested venue network; event images and art are downloaded when needed, not bundled. The size budget is set in Stage 6 | Stage 1 review |
| NFR-029 | Distribution | At launch, the app is listed in every country's storefront except the European Union's | ADR-092 |
| NFR-030 | Security | Dashboard and console sign-in requires email, password and an email code; sessions expire after inactivity | ADR-078 |
| NFR-031 | Performance | The store download of the app is at most 50 MB (a belief to be measured at the first build); event art, Rive files for rare scenes and mini-game pictures load when needed. This sets the budget NFR-028 asked for | NFR-028, Stage 6 |

Accessibility: v1 has no accessibility target, by the user's choice (ADR-085). NFR-009 (reduce-motion) stays as a performance fallback.

## 3. External interface requirements

| Interface | Used for | Contract |
|---|---|---|
| SMS provider (Saudi) | Login codes and operator invites from the service sender "Questify"; promotional SMS from a separately registered promotional sender | Registered sender IDs; OTP text states its purpose; promotional messages only to opted-in players, with opt-out (ADR-065). Provider: Q-034 |
| Email provider | Login codes, organizer team invites, invoices, promotional email to opted-in players | Unsubscribe in every promotional email (ADR-065). Provider: Q-034 |
| Apple and Google push services | All push notifications | Permission asked after joining an event, never rewarded (F-201) |
| Phone camera and NFC | QR scanning (live camera only), NFC tag reading and writing | Gallery images are never accepted as scans (F-55). NFC limits: Q-071 |
| System photo picker | Photo submissions | No photo-library permission (PD-10) |
| System share sheet | Share quests, recap cards | Completion is honor-system (ADR-034) |
| Phone maps app | "Open the venue address" from the event info page | Hand-off only; Questify draws no routes (ADR-055) |
| Device integrity (Apple App Attest, Google Play Integrity) | A fair-play flag signal | Flags only; never blocks (F-115, ADR-041) |
| App stores and install referrer | One-scan join through install (deferred deep link) | iOS method: Q-070 |
| Questify web pages | Event page, station (rotating QR) page, big screen, account-deletion page, organizer dashboard, Questify console | Arabic and English |

No payment gateway and no gift-card supplier in v1 (ADR-064, ADR-050).

## 4. Data requirements

The full model is `DATA_MODEL.md` (Stage 6). What the requirements above imply:

- **Players:**
  - phone (+966) and/or email;
  - username, character, frame, title;
  - birth year;
  - interests and city;
  - marketing opt-ins per channel, with dates;
  - Questify XP, level, achievements, items, gems, passport, streak;
  - location readings kept for fair-play flags.
- **Per event, per player:**
  - the organizer's join fields (only those disclosed on the join card, PD-17);
  - score and balance;
  - completions, reservations, submissions;
  - flags, tickets, ratings.
- **Organizers:**
  - the organizer account, with its owner and editors;
  - events, categories, quests, verification methods;
  - rewards, stock and uploaded codes;
  - maps and pins, sessions, sponsors;
  - announcements, renamed words, branding;
  - invoices and activation state.
- **Records that are never edited or erased:**
  - the points record (F-110);
  - the event change log (F-198);
  - operator and platform-admin action logs (F-219, F-218).
- **Who can see what:**
  - a player sees their own data and other players' public profiles (username, character, frame,
    title, level, achievements, passport);
  - an organizer's team sees only its own events;
  - sponsors see nothing directly (ADR-067);
  - platform admins see everything, and their access is logged (ADR-068).
- **Retention:**
  - an event balance closes after its shop window (ADR-048);
  - deleting an account removes the profile, points, submissions, votes and items, keeping prize
    handover records only as long as the law requires (PD-16, Q-051).
- **Residency:** all personal data in Saudi Arabia (ADR-070).

## 5. Traceability

One row per functional requirement. Tests are written in Stage 8 (`TEST_STRATEGY.md`).

| FR | Feature(s) | Priority | Verified by test |
|---|---|---|---|
| FR-101 | F-01 | Must | pending |
| FR-102 | F-01 | Must | pending |
| FR-103 | F-01 | Must | pending |
| FR-104 | F-01, F-70 | Must | pending |
| FR-105 | F-01 | Must | pending |
| FR-106 | F-69 | Must | pending |
| FR-107 | F-69 | Must | pending |
| FR-108 | F-69 | Must | pending |
| FR-109 | F-69 | Must | pending |
| FR-110 | F-69 | Must | pending |
| FR-111 | F-70 | Must | pending |
| FR-112 | F-70 | Must | pending |
| FR-113 | F-71, F-72 | Must | pending |
| FR-114 | F-71 | Must | pending |
| FR-115 | F-72 | Must | pending |
| FR-116 | F-72 | Must | pending |
| FR-117 | F-73 | Must | pending |
| FR-118 | F-73 | Must | pending |
| FR-119 | F-73 | Must | pending |
| FR-120 | F-73 | Must | pending |
| FR-121 | F-74 | Must | pending |
| FR-122 | F-75 | Must | pending |
| FR-123 | F-76 | Must | pending |
| FR-124 | F-76 | Must | pending |
| FR-125 | F-76 | Must | pending |
| FR-126 | F-77 | Must | pending |
| FR-127 | F-77 | Must | pending |
| FR-128 | F-77 | Must | pending |
| FR-129 | F-78 | Should | pending |
| FR-130 | F-78 | Should | pending |
| FR-131 | F-78 | Should | pending |
| FR-132 | F-79 | Should | pending |
| FR-133 | F-79 | Should | pending |
| FR-134 | F-79 | Should | pending |
| FR-135 | F-80 | Should | pending |
| FR-136 | F-81 | Should | pending |
| FR-137 | F-81 | Should | pending |
| FR-138 | F-82 | Should | pending |
| FR-201 | F-03 | Must | pending |
| FR-202 | F-03, F-92 | Must | pending |
| FR-203 | F-04 | Must | `test/db/challenge-survey-share.int`, `test/plays/survey-share.int` (T-303) |
| FR-204 | F-05 | Must | pending (T-301b: photos) |
| FR-205 | F-05 | Must | `test/db/submissions.int`, `test/submissions/routes.int` (T-301) |
| FR-206 | F-05 | Must | `test/db/submissions.int`, `test/submissions/routes.int`, `apps/app/src/event/submissions.test.ts` (T-301) |
| FR-207 | F-06 | Must | `test/db/vote-quiz.int`, `test/plays/routes.int`, `apps/app/src/event/plays.test.ts` (T-302) |
| FR-208 | F-07 | Must | `test/db/vote-quiz.int`, `test/plays/routes.int` (T-302) |
| FR-209 | F-07 | Must | `test/db/vote-quiz.int`, `test/plays/routes.int`, `apps/app/src/event/plays.test.ts` (T-302) |
| FR-210 | F-07 | Must | `test/db/vote-quiz.int`, `test/plays/routes.int`, `apps/app/src/event/plays.test.ts` (T-302) |
| FR-211 | F-83 | Must | pending |
| FR-212 | F-84 | Should | built (T-303c, ADR-209) |
| FR-213 | F-84 | Should | built (T-303c, ADR-210) |
| FR-214 | F-85 | Should | `test/db/challenge-survey-share.int`, `test/plays/survey-share.int`, `apps/app/src/event/survey-share.test.ts` (T-303); the results page and export are T-508 |
| FR-215 | F-86 | Could | built (T-303b) |
| FR-216 | F-86 | Could | built (T-303b) |
| FR-217 | F-87 | Should | built (T-305, ADR-213) |
| FR-218 | F-87 | Should | built (T-305, ADR-212) |
| FR-219 | F-88 | Should | `test/plays/survey-share.int` (every player read), `src/quests/switched-off.test.ts`, `test/db/challenge-survey-share.int` (T-303) |
| FR-220 | F-88 | Should | `test/db/challenge-survey-share.int`, `test/plays/survey-share.int`, `apps/app/src/event/survey-share.test.ts` (T-303) |
| FR-221 | F-02 | Must | pending |
| FR-222 | F-52 | Must | pending |
| FR-223 | F-52 | Must | pending |
| FR-224 | F-90 | Must | `test/db/passport.int`, `test/plays/passport.int`, `apps/app/src/event/passport.test.ts`, `e2e/passport.spec` (T-304b) |
| FR-225 | F-91 | Must | pending |
| FR-226 | F-91 | Must | pending |
| FR-227 | F-92 | Must | pending |
| FR-228 | F-93 | Must | pending |
| FR-229 | F-93 | Must | pending |
| FR-230 | F-94 | Must | pending |
| FR-231 | F-95 | Must | `test/db/category-rules.int`, `test/quests/category-rules.int`, `test/plays/routes.int`, `apps/app/src/event/quests.test.ts` (T-304) |
| FR-232 | F-53 | Must | `test/db/category-rules.int`, `test/quests/category-rules.int`, `test/plays/routes.int`, `apps/app/src/event/quests.test.ts` (T-304) |
| FR-233 | F-53 | Must | `test/db/category-rules.int`, `test/quests/category-rules.int`, `test/plays/routes.int`, `apps/app/src/event/quests.test.ts` (T-304) |
| FR-234 | F-97 | Must | `test/db/category-rules.int`, `test/quests/category-rules.int`, `test/plays/routes.int`, `apps/app/src/event/quests.test.ts` (T-304) |
| FR-235 | F-98 | Should | `test/db/category-rules.int`, `test/quests/category-rules.int`, `test/plays/routes.int`, `apps/app/src/event/quests.test.ts` (T-304) |
| FR-236 | F-51 | Should | built (T-304c) |
| FR-237 | F-99 | Could | built (T-304c) |
| FR-238 | F-99 | Could | built (T-501g, ADR-357): `test/db/push-hint.int`, `test/reveal/hint.int`, `e2e/hidden-hint.spec` |
| FR-239 | F-100 | Should | `test/db/live-polls.int`, `test/plays/polls.int`, `apps/app/src/event/polls.test.ts`, `e2e/live-polls.spec.ts`, `test/db/push-events.int` (T-306; the push to members who have not voted, T-501e) |
| FR-240 | F-100 | Should | `test/db/live-polls.int`, `test/plays/polls.int`, `apps/app/src/event/polls.test.ts` (T-306) |
| FR-241 | F-100 | Should | `test/db/live-polls.int` (a 0-point poll records the vote and pays no points; Questify XP still follows, Q-184) (T-306) |
| FR-242 | F-100 | Should | `test/db/live-polls.int`, `test/plays/polls.int`, `apps/app/src/event/polls.test.ts` (T-306) |
| FR-243 | F-101 | Should | `test/db/community.int`, `test/community/routes.int`, `e2e/community.spec.ts` (T-306b) |
| FR-244 | F-101 | Should | `test/db/community.int` (participation points; nothing deducted) (T-306b) |
| FR-245 | F-101 | Should | `test/db/community.int` (window edges, removals of counted entries only) (T-306b) |
| FR-246 | F-101 | Should | `test/db/community.int` (milestones reached and paid, kept on a miss) (T-306b); `test/db/push-events.int` (one push per settle for the highest step reached, T-501e) |
| FR-247 | F-101 | Should | `test/db/community.int` (points, moment, nothing) (T-306b); `test/db/community-unlocks.int`, `test/community/unlocks.int` (unlocks) (T-306c) |
| FR-248 | F-101 | Should | `test/db/community.int` (contributors with the top-up, everyone at the reach) (T-306b) |
| FR-249 | F-101 | Should | `test/db/community.int` (a miss pays nothing for the goal) (T-306b) |
| FR-250 | F-101 | Should | `test/db/community.int`, `test/community/routes.int`, `apps/app/src/event/community.test.ts` (the Home bar; the big screen is T-504's) (T-306b) |
| FR-251 | F-102 | Should | built (T-307) |
| FR-252 | F-102 | Should | built (T-307) |
| FR-254 | F-103 | Should | pending |
| FR-255 | F-103 | Should | pending |
| FR-301 | F-54 | Must | pending |
| FR-302 | F-54 | Must | pending |
| FR-303 | F-55 | Must | pending |
| FR-304 | F-55 | Must | pending |
| FR-305 | F-67 | Must | pending |
| FR-306 | F-104 | Must | pending |
| FR-307 | F-104 | Must | pending |
| FR-308 | F-108 | Must | pending |
| FR-309 | F-108 | Must | pending |
| FR-310 | F-109 | Must | pending |
| FR-311 | F-109 | Must | pending |
| FR-312 | F-105 | Should | built (T-308) |
| FR-313 | F-105 | Should | built (T-308) |
| FR-314 | F-106 | Should | built (T-309) |
| FR-315 | F-107 | Should | built (T-309b, 2026-10-24); the rewording to "live code" pending Q-201 |
| FR-316 | F-110 | Must | pending |
| FR-317 | F-110 | Must | pending |
| FR-318 | F-111 | Must | pending |
| FR-319 | F-111 | Must | pending |
| FR-320 | F-112 | Must | pending |
| FR-321 | F-117 | Must | pending |
| FR-322 | F-113 | Must | pending |
| FR-323 | F-113 | Must | pending |
| FR-324 | F-119 | Must | `test/db/submissions.int`, `test/submissions/routes.int`, `apps/app/src/operator/review.test.ts`, `e2e/submissions.spec` (T-301) |
| FR-325 | F-119 | Must | `test/db/submissions.int`, `test/submissions/routes.int`, `e2e/submissions.spec` (T-301) |
| FR-326 | F-119 | Must | `test/db/submissions.int`, `test/submissions/routes.int` (T-301) |
| FR-327 | F-120 | Should | `test/db/submissions.int`, `test/submissions/routes.int` (T-301) |
| FR-328 | F-120 | Should | `test/db/submissions.int`, `test/submissions/routes.int`, `e2e/submissions.spec` (T-301) |
| FR-329 | F-114, F-115 | Should | pending |
| FR-330 | F-114 | Should | pending |
| FR-331 | F-114 | Should | built (T-303b) |
| FR-332 | F-114 | Should | built (T-303b) |
| FR-333 | F-114 | Should | pending |
| FR-334 | F-115 | Could | pending |
| FR-335 | F-116 | Should | pending |
| FR-336 | F-116 | Should | pending |
| FR-337 | F-118 | Should | partly built (T-310: text, from a quest or the event; the photo is T-301b, ADR-248): `test/db/tickets.int`, `test/tickets/routes.int`, `apps/app/src/event/help.test.ts` |
| FR-338 | F-118 | Should | partly built (T-310: the reply and Solved, read on Home and in Your requests; the push is T-501's): `test/db/tickets.int`, `test/tickets/routes.int`, `e2e/help-desk.spec` |
| FR-339 | F-118 | Should | `test/db/tickets.int`, `test/security/outsider.int`, `test/tickets/routes.int` (T-310) |
| FR-401 | F-121 | Must | pending |
| FR-402 | F-121 | Must | pending |
| FR-403 | F-08 | Must | pending |
| FR-404 | F-24 | Must | pending |
| FR-405 | F-24 | Must | pending |
| FR-406 | F-56 | Must | pending |
| FR-407 | F-11 | Must | pending |
| FR-408 | F-11 | Must | pending |
| FR-409 | F-122 | Must | `test/db/submissions.int`, `test/submissions/routes.int`, `apps/app/src/event/event.test.ts` (T-301) |
| FR-410 | F-60 | Must | pending |
| FR-411 | F-123 | Must | pending |
| FR-412 | F-123 | Must | pending |
| FR-413 | F-123 | Must | pending |
| FR-414 | F-124 | Must | pending |
| FR-415 | F-124 | Must | `test/db/gem-shop.int` (the shop prices in gems only; `gem_buy` never reads or writes XP); the gem shop screen shows prices in gems only (T-404b, `gem-shop-flow.test`) |
| FR-416 | F-57 | Must | `test/db/xp.int`, `test/db/profile-items.int`, app level bar (T-401/T-402 next reward) |
| FR-417 | F-59 | Should | server built T-405 (`test/db/event-streak.int`: day rows on every multi-day event, on or off; `own_event_streak` null while off); Home card (`apps/app/src/streaks/event-streak.test.ts`, `event.test`: nothing while off) and the dashboard Streak panel (`apps/web/src/lib/streak.test.ts`, `e2e/streak.spec.ts`) built T-405b |
| FR-418 | F-59 | Should | server built T-405 (`test/db/event-streak.int`: ledger kind `streak` with the day's first completion from day 2 through every door, score and balance, none without an amount; `test/streaks/routes.int`); shown on the success card, in the answer lines and in the history (T-405b: `celebration.test`, `amount.test`, `quests.test`, `plays.test`, `games.test`) |
| FR-419 | F-125 | Should | partial: server built T-405 (`test/db/daily-streak.int`: any event quest completion counts the Questify day, 04:00 Riyadh); the daily challenge's and the daily word's finished plays count it too (T-406, `test/db/daily-challenge.int`); the profile line and the sync toast are built T-405b (`daily-streak.test`, `sync-notices.test`, `player-state.test`) |
| FR-420 | F-125 | Should | partial: the platform key `dailyStreak` and its effect built T-405 (`test/db/daily-streak.int`, `test/streaks/routes.int`: off, nothing counted, shown or paid; no organizer switch); the profile hides it when `/v1/me` sends null (T-405b); the console page is T-703 |
| FR-421 | F-125 | Should | server built T-405 (`test/db/daily-streak.int`: XP milestones once ever, no ledger or gem entry from them, no gem source exists; a level crossed pays its level gems, Q-263); items not yet (ADR-298) |
| FR-422 | F-126, F-151 | Should | `apps/api/src/home/goal.test.ts`, `test/home/home.int`, `test/db/goal.int` (T-213) |
| FR-501 | F-10 | Must | pending |
| FR-502 | F-10 | Must | pending |
| FR-503 | F-10 | Must | pending |
| FR-504 | F-22 | Must | pending |
| FR-505 | F-144 | Must | pending |
| FR-506 | F-145 | Must | pending |
| FR-507 | F-145 | Must | pending |
| FR-508 | F-145 | Must | pending |
| FR-509 | F-144 | Must | pending |
| FR-510 | F-146 | Must | pending |
| FR-511 | F-146 | Must | pending |
| FR-512 | F-146 | Must | pending |
| FR-513 | F-147 | Must | pending |
| FR-514 | F-148 | Must | pending |
| FR-515 | F-153 | Must | pending |
| FR-516 | F-62 | Should | pending |
| FR-517 | F-151 | Should | `test/db/goal.int`, `test/rewards/routes.int` (T-213) |
| FR-518 | F-152 | Should | pending |
| FR-519 | F-149 | Should | pending |
| FR-520 | F-149, F-111 | Should | pending |
| FR-521 | F-149 | Should | pending |
| FR-522 | F-150 | Should | `test/db/quest-items.int`, `test/rewards/quest-items.int` (T-304d, ADR-205) |
| FR-601 | F-09 | Must | pending |
| FR-602 | F-09 | Must | pending |
| FR-603 | F-09 | Must | pending |
| FR-604 | F-09 | Must | `test/db/ranking.int`, `test/ranking/ranking.int`, `test/ranking/flow.int` (T-402 cosmetics) |
| FR-605 | F-09 | Must | pending |
| FR-606 | F-155 | Must | pending |
| FR-607 | F-23 | Must | pending |
| FR-608 | F-23, F-61 | Must | pending |
| FR-609 | F-23 | Must | pending |
| FR-610 | F-61 | Should | pending |
| FR-611 | F-154 | Should | server built T-408 (core; migration 0072, `GET /v1/questify/ranking`, `test/db/questify-ranking.int`, `test/db/questify-ranking-upgrade.int`; code review pending); screens built T-408b (Explore; code review pending) |
| FR-612 | F-154 | Should | built T-408b (the Questify-wide ranking is on Explore only; `event-isolation.test` checks that no event or operator file imports Explore or calls its route); code review pending |
| FR-613 | F-160 | Should | Built T-503 (periodic top-ten diff, ADR-362); independent tier B review owed: `test/db/rank-push.int`, `src/ranking/top-ten-tick.test.ts` |
| FR-620 | F-161 | Must | pending |
| FR-621 | F-162 | Must | built for QR and NFC (T-308) |
| FR-622 | F-162 | Must | pending |
| FR-623 | F-163 | Must | pending |
| FR-624 | F-164 | Must | pending |
| FR-630 | F-156 | Must | pending |
| FR-631 | F-156 | Must | pending |
| FR-632 | F-157 | Must | pending |
| FR-633 | F-158 | Should | pending |
| FR-634 | F-158 | Should | pending |
| FR-635 | F-159 | Could | pending |
| FR-636 | F-159 | Could | pending |
| FR-637 | F-159 | Could | pending |
| FR-701 | F-127 | Must | partial T-402 identity/equipment/level; T-403 server built (achievements, passport, owner history: `test/db/achievements.int`, `test/db/event-passport.int`, `test/questify/questify.int`), core code review pending; screens built T-403c, awaiting standard review (profile, public profile) |
| FR-702 | F-127 | Must | partial: `test/players/items.int` public allowlist; T-403 server adds tiers and ended public-event stamps only (`test/db/event-passport.int`, `test/questify/questify.int`), core code review pending; screens built T-403c (the public profile shows tiers and ended public stamps as sent; `apps/app/src/questify/*.test.ts`), awaiting standard review |
| FR-703 | F-143 | Must | `test/db/profile-items.int`, `test/players/items.int`, `test/players/profile.int` (T-402) |
| FR-704 | F-143 | Must | pending |
| FR-705 | F-143 | Must | pending |
| FR-706 | F-128 | Must | pending |
| FR-707 | F-58 | Must | server built T-403 (`test/db/achievements.int`: thresholds, jumps, replays, crossings), core code review pending; awarded at the next sync |
| FR-708 | F-58 | Must | partial: server answers `tier` null for a silhouette (`test/db/achievements.int`); screens built T-403c (padlock silhouette, `stamps.test.ts`), awaiting standard review |
| FR-709 | F-133 | Must | partial: stamps, local date and final rank (none while running) server-side (`test/db/event-passport.int`, `test/db/final-rank.int`); the event logo waits for T-602 (an emblem letter until then); screens built T-403c (`stamps.test.ts`: upcoming, live, results soon, rank, not ranked), awaiting standard review |
| FR-710 | F-132 | Must | server built T-403b (`test/db/questify-quests.int`: seeded attend 3 events and play in 2 cities, one award and one XP entry per quest under replays and crossings; `test/questify/quests.int`), core code review pending; paid at the next sync; "set your interests" built T-407c (core; migration 0071, `test/db/questify-quests.int` "set your interests", `test/db/interests-quest-upgrade.int`; code review pending), "follow Questify" not built (Q-245); the quests screen built T-403c (clamped progress, "Ends in N days" in Saudi days), awaiting standard review |
| FR-711 | F-132 | Must | server built T-403b (`test/db/questify-quests.int`: published only before the start, offered only inside the window, counts only plays inside it, 3-day late-sync grace; console doors admin-only and audited), core code review pending; console page built T-403c (`apps/web/e2e/console-questify.spec.ts`, `console-questify.test.ts`), awaiting standard review |
| FR-720 | F-129 | Must | `test/db/profile-items.int`, `apps/app/src/questify/profile-api.test.ts` (T-402) |
| FR-721 | F-131 | Must | `test/db/profile-items.int`, `test/db/profile-upgrade.int`, app profile-api tests (T-402) |
| FR-722 | F-130 | Should | `test/db/profile-items.int` ownership/starter/earned character (T-402) |
| FR-723 | F-134 | Should | pending T-402b (ADR-266) |
| FR-724 | F-135 | Should | server built T-404 (`test/db/gems.int`: closed source list, one entry per level, tier and paying Questify award, retroactive, amounts as data, event points, score and XP untouched, only `questify_sync` credits), core code review GO 93; the gem count on the Profile, the "+N gems" toast and the quests list (T-404b, `sync-notices.test`, `gems.test`) |
| FR-725 | F-135, F-136 | Should | server built T-404 (no purchase or transfer door, no door names another player, no gem field in the public profile; `test/db/gems.int`), core code review GO 93; on screen the shop has no add-gems control, no link out and no gift or trade door, and says gems are earned and cannot be bought (T-404b, `GemShopScreen`, `gem-shop-flow.test`) |
| FR-726 | F-136 | Should | partial: server built T-404 (`test/db/gem-shop.int`: deducts and adds to the locker, too few gems refused with the balance unchanged, one copy, seen price, replay); frames and titles only, no characters until character art exists (ADR-288); the shop screen with its confirmation sheet, owned and too-few-gems states (T-404b, `gem-shop-api.test`, `gem-shop-flow.test`) |
| FR-730 | F-137 | Should | partial: server built T-406 (`test/db/daily-challenge.int`: three answers in order pay 20 + 10 a right answer once, a replay or a second play pays nothing; `test/daily/routes.int`); the screen built T-406b (`apps/app/src/daily`, `daily-state.test`, `daily-flow.test`) |
| FR-731 | F-137 | Should | built T-406 (`test/db/daily-challenge.int`: a finished challenge keeps the day with no event play, nothing while the streak switch is off); the finish reloads the profile and syncs, so the streak and its milestones show (T-406b, `use-daily`) |
| FR-732 | F-137 | Should | built: server T-406 (a sponsor name on its period's challenge only, `test/db/daily-challenge.int`, `test/daily/routes.int`); the app's "Presented by" line built T-406b (`daily-lines.test`, `SponsorLine`); the console's field built T-406c (`e2e/console-daily.spec.ts`, `console-daily-forms.test`) |
| FR-733 | F-138 | Should | built T-407 (`player_preference`, `GET`/`PUT /v1/me/preferences`; `test/db/marketing.int`, `test/marketing/routes.int`) and T-407b (the Interests and city screen, from the Profile); never on a public profile, code review pending |
| FR-734 | F-138 | Should | built T-407 (`own_for_you`, `GET /v1/me/for-you`; event interests on the dashboard form, `e2e/events.spec.ts`) and T-407b (the For you list; a section of Explore since T-408b), code review pending |
| FR-735 | F-140 | Must | built T-407 (`set_marketing`: every channel off, the first answer recorded even when all stay off) and T-407b (the one-time step after sign-up); consent wording awaits counsel (Q-288), code review pending |
| FR-736 | F-140 | Must | built T-407 (the dated log, `GET`/`PUT /v1/me/marketing`) and T-407b (Settings → Offers and notifications, each switch saved at once), code review pending |
| FR-737 | F-140 | Must | built T-407 as the one audience door (`marketing_audience`, opted-in players only, per channel); the senders are T-409, T-501 and T-706, which must choose recipients there, code review pending |
| FR-738 | F-139 | Should | server built T-409 (migration 0073: the owner's request, the admin's approval with frozen names, the fill through `promo_pool`, the SMS sender tick; `invitationCampaigns` switch off until the RUNBOOK's three conditions); the web pages built T-409b (the dashboard's Invitations page, the console's queue and detail); code review pending |
| FR-739 | F-139 | Should | server built T-409 (rounded daily counts sent, opened, joined; never a player; the landing page's open door); pages built T-409b (rounded counts "120+" / "Fewer than 10" on the dashboard, exact ones in the console, the landing page `/{lang}/i`); code review pending |
| FR-740 | F-139 | Should | built T-409 (requested on the web, approved in the console, no price on the platform; `no-invitation-purchase.test` keeps the routes out of the app); code review pending |
| FR-750 | F-142 | Must | server built T-410 (migration 0074: the window guard, the API's rule, Home's `shopWindow` and no goal once closed; the balance closes by rule; `test/db/shop-window.int`); screens built T-410b (Home's banner with the desk line, the balance "Closed" and no goal once closed, the Rewards tab's closed panel and the cancel note; unit tests, device checks owed); T-410b code review 89 folded |
| FR-751 | F-142 | Must | built T-410 (the close writes nothing; score, final rank, stamp, souvenirs, XP, level, achievements and items proven untouched across the close, `test/db/shop-window.int`); code review pending |
| FR-752 | F-141 | Should | server built T-410 (`event_recap`, `GET /v1/events/{id}/recap`, `test/db/event-recap.int`); card built T-410b (`/event/[eventId]/recap`, shared as an image made on the phone, a text line on a build without the two native modules; unit tests, device checks owed); T-410b code review 89 folded |
| FR-801 | F-50 | Must | pending |
| FR-802 | F-50, F-09 | Must | pending |
| FR-803 | F-50, F-126, F-151 | Must | `apps/api/src/home/goal.test.ts`, `test/home/home.int`, `test/db/goal.int` (T-213) |
| FR-804 | F-165 | Must | pending |
| FR-805 | F-168 | Must | pending |
| FR-806 | F-166 | Should | Built T-502; independent tier B review owed |
| FR-807 | F-167 | Should | Built T-502; independent tier B review owed |
| FR-808 | F-169 | Should | pending |
| FR-809 | F-169 | Should | pending |
| FR-810 | F-169 | Should | pending |
| FR-820 | F-63 | Must | pending |
| FR-821 | F-63 | Must | pending |
| FR-822 | F-64 | Should | pending |
| FR-823 | F-64 | Should | pending |
| FR-824 | F-64 | Should | pending |
| FR-825 | F-64, F-170 | Should | pending |
| FR-826 | F-170 | Should | pending |
| FR-827 | F-170 | Should | pending |
| FR-830 | F-171 | Must | built T-408b (`app/(questify)/_layout.tsx`); code review pending |
| FR-831 | F-171 | Must | built T-408b (`/join-scan`, `classifyJoinScan`; `join-scan.test`); code review pending |
| FR-832 | F-172 | Must | built T-408b (`src/home/`; `home-groups.test`); code review pending |
| FR-833 | F-173 | Must | built T-408b (`src/explore/`); code review pending |
| FR-901 | F-174 | Must | pending |
| FR-902 | F-175 | Must | pending |
| FR-903 | F-175 | Must | pending |
| FR-904 | F-175 | Must | pending |
| FR-905 | F-185 | Must | pending |
| FR-906 | F-176 | Must | pending |
| FR-907 | F-176 | Must | pending |
| FR-908 | F-183 | Must | pending |
| FR-909 | F-184 | Should | pending |
| FR-920 | F-177 | Must | pending |
| FR-921 | F-177 | Must | pending |
| FR-922 | F-177 | Must | pending |
| FR-923 | F-178 | Must | pending |
| FR-924 | F-178 | Must | pending |
| FR-925 | F-179 | Must | pending |
| FR-926 | F-179 | Must | pending |
| FR-927 | F-180 | Must | `test/db/tickets.int` (the merged list and its count, 3 + 2 = 5), `apps/app/src/operator/inbox.test.ts` (T-310) |
| FR-928 | F-181 | Should | pending |
| FR-929 | F-182 | Could | pending |
| FR-940 | F-186 | Must | pending |
| FR-941 | F-186 | Must | pending |
| FR-942 | F-187 | Should | pending |
| FR-1001 | F-20 | Must | pending |
| FR-1002 | F-20 | Must | pending |
| FR-1003 | F-20, F-196 | Must | pending |
| FR-1004 | F-21 | Must | pending |
| FR-1005 | F-21 | Must | pending |
| FR-1006 | F-21 | Must | `packages/shared/src/quests/registry.test.ts`, `test/db/submissions.int`, `test/submissions/routes.int` (T-301; photos T-301b) |
| FR-1007 | F-21, F-196 | Must | pending |
| FR-1008 | F-68 | Must | pending |
| FR-1009 | F-25 | Must | pending |
| FR-1010 | F-25, F-41 | Must | pending |
| FR-1011 | F-188 | Must | pending |
| FR-1012 | F-188, F-44 | Must | pending |
| FR-1013 | F-188 | Must | pending |
| FR-1014 | F-188 | Must | pending |
| FR-1015 | F-189 | Must | pending |
| FR-1016 | F-190 | Must | pending |
| FR-1017 | F-194 | Must | pending |
| FR-1018 | F-194 | Must | server built T-410 (as FR-750; the dashboard's shop read carries `state` and `closesAt`); dashboard built T-410b (the closing line, the desk warning, the days field's rules, the refusal words; `e2e/shop-window.spec.ts`); T-410b code review 89 folded |
| FR-1019 | F-195 | Must | pending |
| FR-1020 | F-195, F-44 | Must | pending |
| FR-1021 | F-195, F-194 | Must | pending |
| FR-1022 | F-193 | Should | pending |
| FR-1023 | F-26 | Should | pending |
| FR-1024 | F-66 | Must | pending |
| FR-1025 | F-191 | Must | pending |
| FR-1026 | F-191, F-196 | Must | pending |
| FR-1027 | F-191 | Must | pending |
| FR-1028 | F-192 | Should | pending |
| FR-1029 | F-198 | Must | pending |
| FR-1030 | F-198 | Must | pending |
| FR-1031 | F-196 | Must | pending |
| FR-1032 | F-196 | Must | pending |
| FR-1033 | F-197 | Must | pending |
| FR-1034 | F-197 | Must | pending |
| FR-1035 | F-197 | Must | pending |
| FR-1101 | F-199 | Must | partly built (T-501: the store, center and sending machinery; T-501b: the APNs and FCM clients, sending once Dhia's keys are set; T-501d: the submission decision, the help-desk answer, a reservation ready at the desk and ending; the operator invite waits for T-617): `test/db/push-store.int`, `test/db/push-sending.int`, `test/db/push-producers.int`, `apps/api/src/push/apns.test.ts`, `apps/api/src/push/fcm.test.ts` |
| FR-1102 | F-199 | Must | partly built (T-501: event audience by status, membership and visibility, the topics; T-501b: the APNs and FCM clients, sending once Dhia's keys are set; T-501e: flash quests, boosts, live polls, community milestones, a category opening and the event starting soon, active members only, once each; T-501f: the daily streak reminder from 18:00 Riyadh, once a day, and the shop closing the day before; announcements are T-502's, rank alerts T-503's): `test/db/push-store.int`, `test/db/push-events.int`, `test/db/push-reminders.int`, `apps/api/src/push/contract.test.ts` |
| FR-1103 | F-199 | Must | partly built (T-501: no cap, no quiet hours, no per-event brake in the worker; T-501b: the real clients, sending once Dhia's keys are set): `apps/api/src/push/worker.test.ts` |
| FR-1104 | F-200 | Must | built T-501 and T-501c (every message a center row, read and unread; the center screen `/notifications` lists them newest first, a tap marks that one row read; phone check owed): `test/db/push-store.int` ("refused permission blocks nothing"), `test/push/routes.int`, `apps/app/src/push/{center,push-api}.test.ts` |
| FR-1105 | F-201 | Must | built T-501c (the explainer on the join result screens, only while the system is unasked and not snoozed 30 days; "Turn on" is the only way to the system prompt; a unit test of the flow and a source scan of who may read the permission; phone check owed): `apps/app/src/push/{push-flow,push-guards}.test.ts` |
| FR-1106 | F-201 | Must | built T-501 and T-501c (registering writes no ledger, XP or gem row; the app reads the permission only in the push folder, the sign-out hook and the join screens' explainer, and its texts promise nothing for allowing it): `test/db/push-store.int`, `apps/app/src/push/push-guards.test.ts` |
| FR-1107 | F-203 | Must | Built T-502; independent tier B review owed |
| FR-1108 | F-203 | Must | Built T-502; independent tier B review owed |
| FR-1109 | F-43 | Must | pending |
| FR-1110 | F-44 | Must | pending |
| FR-1111 | F-204 | Should | audience rule built T-407; T-409 moved it into `promo_pool`, read by the invitation fill and again at every claim, and made `marketing_audience` system-only; T-501f: invitations by push or SMS, one channel per player (push when opted in on push with a pushable phone), consent checked again at the hand-off, the fan-out and the claim (`test/db/invitation-push.int`); campaigns come with T-706, code review pending |
| FR-1112 | F-204 | Should | built for invitations T-409 (`MSEGAT_PROMO_SENDER`, never the service sender: the API refuses to start when they match); waits for the registered "-AD" name (Q-034); campaigns T-706 |
| FR-1113 | F-204 | Should | built T-407 (`marketing_consent` with channel, date, method and wording version; the admin's audited read `GET /v1/admin/players/{id}/marketing-consent`; its screen comes with T-704), code review pending |
| FR-1114 | F-204 | Must | built T-407 (signed opt-out link, `POST /v1/public/marketing/opt-out`, the web page `/[lang]/opt-out`) and T-407b (settings switches); every promotional sender must put `optOutUrl` in each message; a promotional push opens its center row, which carries the opt-out to Settings (T-501c, T-501f, ADR-356 (6)), code review pending |
| FR-1115 | F-202 | Should | built T-501 and T-501c (the four topics per player, mute stops the push and keeps the center row; the switches are in Settings → Offers and notifications; phone check owed): `test/db/push-store.int`, `test/push/routes.int`, `apps/app/src/push/push-api.test.ts` |
| FR-1201 | F-65 | Must | pending |
| FR-1202 | F-65 | Must | pending |
| FR-1203 | F-65 | Must | pending |
| FR-1204 | F-205 | Must | pending |
| FR-1205 | F-206 | Must | pending |
| FR-1206 | F-207 | Must | pending |
| FR-1207 | F-207 | Must | pending |
| FR-1208 | F-208 | Should | pending |
| FR-1209 | F-209 | Should | pending |
| FR-1210 | F-209 | Should | pending |
| FR-1211 | F-210 | Could | pending |
| FR-1301 | F-211 | Must | pending |
| FR-1302 | F-211 | Must | pending |
| FR-1303 | F-211 | Must | pending |
| FR-1304 | F-211 | Must | pending |
| FR-1305 | F-212 | Must | pending |
| FR-1306 | F-214 | Should | pending |
| FR-1307 | F-213 | Could | pending |
| FR-1401 | F-215 | Must | pending |
| FR-1402 | F-216 | Must | pending |
| FR-1403 | F-216 | Must | pending |
| FR-1404 | F-216 | Must | pending |
| FR-1405 | F-216, F-41 | Must | pending |
| FR-1406 | F-227 | Must | pending |
| FR-1407 | F-227 | Must | pending |
| FR-1408 | F-218 | Must | pending |
| FR-1409 | F-218, F-198 | Must | pending |
| FR-1410 | F-219 | Must | pending |
| FR-1411 | F-220 | Must | pending |
| FR-1412 | F-221 | Must | pending |
| FR-1413 | F-226 | Must | pending |
| FR-1414 | F-226 | Must | pending |
| FR-1415 | F-222 | Must | pending |
| FR-1416 | F-223 | Should | pending |
| FR-1417 | F-223 | Should | pending |
| FR-1418 | F-224 | Must | pending |
| FR-1419 | F-217 | Should | pending |
| FR-1501 | F-40 | Must | pending |
| FR-1502 | F-40 | Must | pending |
| FR-1503 | F-41 | Must | pending |
| FR-1504 | F-41 | Must | pending |
| FR-1505 | F-42 | Must | pending |
| FR-1506 | F-45 | Must | pending |
| FR-1507 | F-45 | Must | pending |
| FR-139 | F-76, F-80 | Should | pending |
| FR-1601 | F-112, F-121 | Must | pending |
| FR-1602 | F-112, F-124 | Must | pending |
| FR-1603 | F-145, F-147 | Must | pending |
| FR-1604 | F-152 | Should | pending |
| FR-1605 | F-117 | Must | pending |
| FR-1606 | F-223 | Should | pending |
| FR-1607 | F-216 | Must | pending |
| FR-1608 | F-194 | Must | built (T-102: Scheduled → Live → Ended, `test/db/event-lifecycle.int`; T-411: Ended → Archived by the tick's last step under ADR-337 (5) and ADR-341, `test/db/event-archive.int`, `test/events/archived.int`; never within 30 days of the end); reviewed |
| FR-1609 | F-142, F-145 | Must | built (T-202, T-206: holds keep their own deadline); tested across the close T-410 (handover, timeout and cancel after it, a rank prize, `test/db/shop-window.int`) |
| FR-1610 | F-164 | Must | pending |
| FR-1611 | F-61 | Should | pending |
| FR-1612 | F-23, F-157 | Must | pending |
| FR-1613 | F-100, F-158 | Should | pending |
| FR-1614 | F-171 | Must | built T-408b (`classifyJoinScan` checks the operator invite first, ADR-324); code review pending |
| FR-1615 | F-59 | Should | server built T-405 (`test/db/event-streak.int`: closed weekdays and dates neither count nor break, a missed open day restarts at 1, the bonus with the day's first completion) |
| FR-1616 | F-126, F-151 | Should | `apps/api/src/home/goal.test.ts`, `test/home/home.int`, `test/db/goal.int` (T-213) |
| FR-1617 | F-150 | Should | `test/db/quest-items.int`, `test/rewards/quest-items.int` (T-304d, ADR-205) |
| FR-1618 | F-62 | Should | pending |
| FR-1619 | F-51 | Should | built (T-304c) |
| FR-1620 | F-101 | Should | `test/db/community.int`, `test/db/community-locks.int` (T-306b) |
| FR-1621 | F-103 | Should | pending |
| FR-1622 | F-134 | Should | pending T-402b (ADR-266) |
| FR-1623 | F-210 | Could | pending |
| FR-1624 | F-209 | Should | pending |
| FR-1625 | F-65 | Must | pending |
| FR-1626 | F-214 | Should | pending |
| FR-1628 | F-221 | Must | `test/db/submissions.int` (text submissions, T-301), `test/db/tickets.int` (help-desk tickets, T-310) |
| FR-1629 | F-06 | Must | partly: text options only, organizer images wait for storage (ADR-190, Q-149); `test/db/vote-quiz.int`, `packages/shared/src/quests/registry.test.ts` (T-302) |
| FR-1701 | F-228 | Must | pending |
| FR-1702 | F-228, F-262 | Must | pending |
| FR-1703 | F-229 | Must | pending |
| FR-1704 | F-231 | Must | pending |
| FR-1705 | F-232 | Must | pending |
| FR-1706 | F-232 | Must | `test/db/submissions.int`, `test/submissions/routes.int` (T-301) |
| FR-1707 | F-232, F-259, F-153 | Must | pending |
| FR-1708 | F-233 | Should | pending |
| FR-1709 | F-234 | Should | `test/db/submissions.int`, `test/submissions/routes.int`, `apps/app/src/event/submissions.test.ts` (T-301) |
| FR-1710 | F-234, F-142 | Should | `test/db/submissions.int` (T-301) |
| FR-1711 | F-236 | Must | pending |
| FR-1712 | F-237 | Must | pending |
| FR-1713 | F-238 | Must | built (T-309; the link wording pending Q-202) |
| FR-1714 | F-240 | Should | pending |
| FR-1715 | F-240, F-51, F-59, F-61 | Should | pending |
| FR-1716 | F-241 | Must | pending |
| FR-1717 | F-242 | Must | pending |
| FR-1718 | F-243 | Should | built (T-214: the Home card; T-501d: the push and center row at the reveal naming the prize and the claim deadline, once per place, never to a winner who left or was removed; a real push leaves once Dhia's keys are set): `test/db/push-producers.int`, `test/db/results.int` |
| FR-1719 | F-244 | Should | pending |
| FR-1720 | F-245 | Should | pending |
| FR-1721 | F-247 | Must | pending |
| FR-1722 | F-247 | Must | pending |
| FR-1723 | F-248 | Must | pending |
| FR-1724 | F-249 | Should | pending |
| FR-1725 | F-250 | Must | pending |
| FR-1726 | F-252 | Must | pending |
| FR-1727 | F-253 | Should | partly built (T-503: the switches, outbox, sender and five of the seven sources; mail stays OFF per ADR-360; `content_unpublished` waits for T-701): `test/db/organizer-alerts.int`, `test/organizer-alerts/routes.int` |
| FR-1728 | F-254 | Must | pending |
| FR-1729 | F-257 | Must | pending |
| FR-1730 | F-258 | Should | pending |
| FR-1731 | F-259 | Must | pending |
| FR-1732 | F-260 | Must | pending |
| FR-1733 | F-261, F-137 | Should | built: server T-406 (`test/db/daily-content.int`: the warning at 6 vs 7 days, no challenge → `challenge: null`, the streak still kept by an event completion); the console banner and the menu badge built T-406c (`e2e/console-daily.spec.ts`, `console-daily.test`) |
| FR-1734 | F-262 | Must | pending |
| FR-1735 | F-263 | Must | pending |
| FR-1736 | F-264 | Must | pending |
| FR-1737 | F-265 | Must | pending |
| FR-1738 | F-204 | Must | built T-407 (`promoSendTime`: no SMS 22:00 to 09:00, 01:00 to 12:00 in Ramadan; an opt-out is effective at once); applied by the invitation sender T-409 (both bands in TypeScript, the fixed band again in SQL; 22:00 to 12:00 in Ramadan) and by T-706, code review pending |
| FR-1739 | F-77, F-110 | Must | pending |
| FR-1740 | F-69 | Should | pending |
| FR-1741 | F-72 | Should | pending |
| FR-1742 | F-52, F-54 | Must | pending |
| FR-1743 | F-45 | Must | pending |
| FR-1744 | F-86, F-114 | Must | built (T-303b) |
| FR-1745 | F-114 | Should | pending |
| FR-1746 | F-251 | Must | pending |
| FR-1747 | F-179, F-117 | Must | pending |
| FR-1748 | F-266, F-165 | Should | pending |
| FR-1749 | F-267 | Must | pending |
| FR-1750 | F-268 | Must | pending |
| FR-1751 | F-269 | Must | pending |
| FR-1752 | F-269 | Must | pending |
| FR-1753 | F-269, F-197 | Must | pending |
| FR-1754 | F-269 | Must | pending |
| FR-1755 | F-269, F-257 | Must | pending |
| FR-1756 | F-270 | Should | pending |
| FR-1757 | F-271 | Should | pending |
| FR-1758 | F-272 | Must | pending |
| FR-1759 | F-273 | Must | pending |
| FR-1760 | F-274 | Must | pending |
| FR-1761 | F-274 | Must | pending |
| FR-1762 | F-275 | Must | pending |
| FR-1763 | F-273 | Must | pending |
| FR-1764 | F-276 | Should | pending |
| FR-1765 | F-277 | Must | pending |
| FR-1766 | F-277 | Must | pending |
| FR-1767 | F-277, F-186 | Must | pending |
| FR-1768 | F-277 | Must | pending |
| FR-1769 | F-278 | Must | pending |
| FR-1770 | F-279 | Should | pending |
| FR-1771 | F-280 | Should | pending |
| FR-1772 | F-281 | Should | pending |
| FR-1773 | F-282 | Must | pending |
| FR-1774 | F-283 | Must | pending |
| FR-1775 | F-284 | Should | pending |
| FR-1776 | F-284 | Must | pending |
| FR-1777 | F-285 | Should | pending |
| FR-1778 | F-286 | Must | pending |
| FR-1779 | F-287 | Must | pending |
| FR-1780 | F-288 | Should | pending |
| FR-1781 | F-289 | Must | pending |
| FR-1782 | F-290 | Should | pending |
| FR-1783 | F-291 | Should | pending |
| FR-1784 | F-292 | Should | pending |
| FR-1785 | F-293 | Must | pending |
| FR-1786 | F-294 | Should | built T-408 (month boards of `xp_board`, `GET /v1/admin/questify/seasons[/:month]`) and T-408c (console page `/console/seasons`; code review pending) |
| FR-1787 | F-295 | Must | pending |
| FR-1788 | F-296 | Must | pending |
| FR-1789 | F-296 | Must | pending |
| FR-1790 | F-297 | Must | pending |
| FR-1791 | F-298 | Must | pending |
| FR-1792 | F-299 | Should | pending |
| FR-1793 | F-300 | Should | pending |
| FR-1794 | F-301 | Should | pending |
| FR-1795 | F-302 | Should | pending |
| FR-1796 | F-303 | Should | pending |
| FR-1797 | F-304 | Should | pending |
| FR-1798 | F-82 | Must | pending |
| FR-1799 | F-82 | Must | pending |
| FR-1800 | F-82 | Must | pending |
| FR-1801 | F-305 | Must | pending |
| FR-1802 | F-82, F-306 | Must | pending |
| FR-1803 | F-307 | Should | pending |
| FR-1804 | F-87 | Should | built (T-305: memory match and slide puzzle; T-305c: catch and tap rush, ADR-216 to ADR-218) |
| FR-1805 | F-308 | Must | built (T-305, ADR-212) |
| FR-1806 | F-87 | Should | built (T-305, ADR-213, ADR-215) |
| FR-1807 | F-309 | Must | built (T-305, ADR-213) |
| FR-1808 | F-310 | Should | default pictures built (T-305); organizer images T-305b, blocked on Q-149 |
| FR-1809 | F-311 | Should | built (T-305, ADR-213: the window is the time limit plus 10 minutes, memory only) |
| FR-1810 | F-312 | Should | partial: server built T-406 (`test/db/daily-word.int`: solved in four pays 50 XP and keeps the streak, six misses reveal the word with no XP, two-pass marks); the screen built T-406b (grid in the word's language, own keyboard, marks by colour plus glyph, `keyboard.test`, `daily-state.test`) |
| FR-1811 | F-313 | Should | built: server T-406 (`test/db/daily-content.int`: each word language warns under 2 periods, no word → `word: null`); the word bank tab built T-406c (`e2e/console-daily.spec.ts`, `console-daily-forms.test`); the starter guess lists in `data/word-lists/` built T-406d (`word-list-files.test`; sources in `docs/legal/THIRD_PARTY.md`) |
| FR-1812 | F-314 | Must | pending |
| FR-1813 | F-315 | Should | pending |
| FR-1814 | F-316, F-261, F-313 | Should | built: server T-406 (`test/db/daily-content.int`: a cadence per kind from the next day, weekly at launch, the two-period warning); the console control built T-406c (`e2e/console-daily.spec.ts`) |
| FR-1815 | F-317, F-179 | Must | pending |
| FR-1816 | F-318 | Could | pending |
| FR-1817 | F-319 | Could | pending |
| FR-1818 | F-320 | Must | pending |
| FR-1819 | F-321 | Must | built (T-218: requests, the waiting screen and the decision in the app; T-501d: the decision push and center row, once per decision, accept-all and a waiting-list release included; a real push leaves once Dhia's keys are set): `test/db/join-requests.int`, `test/db/push-producers.int` |
| FR-1820 | F-322 | Should | pending |
| FR-1821 | F-323 | Should | pending |
| FR-1822 | F-324 | Must | built (T-312, 2026-10-25) |
| FR-1823 | F-325 | Must | built (T-312, 2026-10-25; "take over" = Questify answers a ticket in its queue, Q-218) |
| FR-1824 | F-326 | Should | built (T-312: My tickets; T-312b merged into T-501c: Profile → Notifications opens the center, every message newest first, read and unread; phone check owed) |
| FR-1825 | F-327 | Must | pending |
| FR-1826 | F-328 | Must | pending |
| FR-1827 | F-329 | Must | pending |
| FR-1828 | F-330 | Should | pending |
| FR-1829 | F-331 | Should | pending |
| FR-1830 | F-332 | Should | pending |
| FR-1831 | F-333 | Should | pending |
| FR-1832 | F-334 | Should | pending |
| FR-1833 | F-335 | Could | pending |
| FR-1834 | F-336 | Should | pending |
| FR-1835 | F-337 | Should | pending |
| FR-1836 | F-338 | Could | pending |
| FR-1837 | F-339 | Should | pending |
| FR-1838 | F-340 | Could | pending |
| FR-1839 | F-341 | Could | pending |
| FR-1840 | F-342 | Should | built (T-313, 2026-10-25) |
| FR-1841 | F-343 | Could | pending |
| FR-1842 | F-344 | Should | pending |
| FR-1843 | F-345 | Should | pending |
| FR-1844 | F-346 | Should | pending |
| FR-1845 | F-347 | Should | pending |
| FR-1846 | F-348 | Must | pending |
| FR-1847 | F-121 | Must | pending |
| FR-1848 | F-179 | Should | pending |

## T-502 implementation clarification (2026-10-29; Proposed ADR-358 / Q-327)

FR-806: the new Happening now strip lists flash quests/boosts from Quests until their actual end, not only the live
feed's first 15 minutes. Poll/community retain their existing Home cards, open categories stay Quests, current
sessions remain T-505. This presentation choice is proposed for coordinator decision after review. FR-807 shows the
newest three sent announcements on Home, See all up to 50. FR-1107 adds bilingual compose/preview, send now, event-zone
scheduling, confirmation, history and cancellation before release. FR-1108 has push/in-app only, never an email/SMS
option or sender. Text/filter bounds, phase/audience rules, rolling caps and due skips are in ADR-358 and the plan.
