# UX — Guided setup (organizer onboarding wizard)

> Experience plan only, theme-agnostic. Draft 2026-10-17 from the user's request.
> Phone layout first (max 30 characters wide), as in `DASHBOARD_AND_CONSOLE.md`.

## 1. Why it exists

An organizer who starts from an empty dashboard does not know which options exist, so they never
use them (user, 2026-10-17). The guided setup walks them through every option **before** they
build, explains each in plain words with an example of how players will experience it, takes their
choices, and builds the event from them. They can change everything later.

## 2. Rules

1. **Every step can be skipped, and the whole wizard can be skipped.** Skipping a step keeps the
   template's default for it. Skipping everything creates a plain Draft from the chosen template.
2. **Each option is an explained card**, not a bare switch:
   - a name and one line on what it does;
   - **"What players will see"**: a small mock of the player screen, or one sentence;
   - **"You will need"**: any hint about what it requires, such as "NFC needs physical tags.
     Questify can supply them, or you can buy them";
   - a choice (on/off or a pick).
3. **Choices become real settings.** The wizard only sets the same switches, fields and content the
   dashboard already has, through the same operations (F-197), so it is also the groundwork for
   the later AI wizard (ADR-060).
4. **Add-ons not unlocked** show as "Available with an add-on. Ask Questify." and cannot be
   switched on (ADR-076). The card still explains what it does.
5. **Re-runnable.** "Guided setup" stays on the event Overview. Each Build section also has
   "Explain this", which opens that wizard step on its own.
6. **Progress is saved.** Leaving and coming back resumes at the same step.
7. **Plain words, one decision per screen.** A progress bar and "Step 4 of 10" show where they are.
8. **The wizard is not AI.** It is a fixed, rule-based interview. The AI version is a later
   addition (ADR-060).

## 3. The steps

| # | Step | Asks | Explained options |
|---|---|---|---|
| 0 | Welcome | "About 5 minutes. Skip anything." | Start / Skip wizard |
| 1 | Your event | Name, dates, time zone, in person / virtual / workplace, public or private | Each type explains what changes (maps and location quests only make sense in person) |
| 2 | Start from | A template or empty | A preview of the template's categories and quests |
| 3 | How players join | Event code, join QR, invite link, public list, guest list, company-email lock | Each with an example ("Players scan this QR on your poster and land in the event") and where it appears |
| 4 | How players prove a quest | Player scans a printed QR; QR shown on a screen (rotating); operator scans the player; NFC tag | Printed or on a screen or phone: "Print it, or open the station page on any screen." NFC: "Needs physical tags. Questify can supply them or you can buy them. Players tap with their phone. Keep the QR as a backup." |
| 5 | Quest types | Tick the types you plan to use: quiz, vote, photo or text, enter a code, meet someone, survey, location, mini-game, share | Each shows a one-line example and how the player completes it |
| 6 | Rewards | A shop? Digital codes? Rank prizes? A prize desk? | "Players spend points on rewards you set. You decide the stock." Prize desk: place and hours |
| 7 | Keeping people playing | Ranking, today's ranking, streak, community goal, live polls, flash quests | A one-line example of each; the community goal shows a progress-bar mock |
| 8 | Sponsors | "Do you have sponsors?" | Shows exactly where they would appear (presented-by category, the strip on Home) with a mock. **Add sponsor** or **Skip** |
| 9 | Your team | How many operators? | Invite by phone or email, or make a batch of single-use QRs, with presets |
| 10 | Maps and agenda | Upload a picture or floor plans? Add sessions? | "A map can be just a picture" |
| 11 | Look and words | Logo, banner, accent color; rename player / operator / quest / category | A live mock of Home with their logo |
| 12 | Review | A summary of every choice | Edit any line; **Create my event** |

After step 12: the event opens as a Draft with the go-live checklist and **Rehearse now**.

## 4. Wireframes (phone)

Step 4, one of the option cards:

```
+----------------------------+
| Step 4 of 12   [Skip step] |
| ========------------------ |
| How do players prove       |
| they did a quest?          |
|                            |
| [x] QR code                |
|     Players scan it with   |
|     the app.               |
|     Show as: (x) printed   |
|     ( ) on a screen        |
|     What players see:      |
|     [ mock: scanner ]      |
|                            |
| [ ] NFC tag                |
|     Players tap a tag      |
|     with their phone.      |
|     You will need: physical|
|     tags. Questify can     |
|     supply them, or buy    |
|     your own.              |
|     [ mock: tap screen ]   |
|                            |
| [ Back ]    [*Continue*]   |
| Skip the whole wizard      |
+----------------------------+
```

Step 8, sponsors:

```
+----------------------------+
| Step 8 of 12   [Skip step] |
| Do you have sponsors?      |
|                            |
| We can show them here...   |
| [ mock: category banner ]  |
| ...and here.               |
| [ mock: logo strip on Home]|
|                            |
| [*+ Add a sponsor*]        |
| [ Skip ]                   |
+----------------------------+
```

Step 12, review:

```
+----------------------------+
| Review your event          |
| Joining: code, QR          |
| Proof: printed QR, NFC     |
| Quests: quiz, vote, photo  |
| Rewards: shop, prize desk  |
| Sponsors: skipped          |
| Team: 20 operators (batch) |
| Each line: [Edit]          |
|                            |
| [*Create my event*]        |
| You can change anything    |
| later.                     |
+----------------------------+
```

**Computer:** the card list on the left, a larger live preview of the player screen on the right,
updating as options are ticked.

## 5. Required states

| Screen | Loading | Empty | Error | Success | Populated |
|---|---|---|---|---|---|
| Any step | Option cards appear as the template loads | Nothing chosen: "You can skip this step. The template's default stays." | "We couldn't save that choice. Tap Continue to try again. Your other answers are kept." | Next step opens | Cards with the current choices |
| Review | Summary builds from saved answers | Everything skipped: "You skipped every step. We will create a plain event from the template." | Creating failed: "Your event wasn't created. Nothing was lost. Tap Create again." | The Draft opens with the checklist | Summary with Edit on each line |

## 6. Edge cases

- **Add-on not unlocked:** the card explains the feature and says "Ask Questify". No switch.
- **Virtual event:** steps 4 (physical proof), 10 (maps) and location quests are hidden or
  reduced to the virtual-friendly options (enter a code, quiz, vote, survey).
- **Resuming** after a closed tab or an expired session: the same step, the same answers.
- **Two team members** run the wizard on the same event: the last save wins, as everywhere else.
- **A choice that conflicts with another**, such as item rewards without a prize desk: the review
  step flags it, and the go-live checklist keeps it as a required item.
- **Arabic and English:** the wizard itself is bilingual and mirrored in Arabic; what the
  organizer types follows the one-language-required rule.

## 7. Assumptions to confirm

- The wizard opens automatically once, right after sign-up, and is reachable any time afterwards.
- The wizard's copy and mock previews are maintained by the Questify team as data, so a changed
  option updates the wizard without a release.
- The number of steps is fixed at 12 plus a welcome and a review; add-on-locked steps still show.
