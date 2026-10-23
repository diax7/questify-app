# Features — Questify

> Features are prioritized area by area in the feature brainstorming sessions (from 2026-10-16).
> A prioritized feature moves from the "Captured" tables into its area section, so each feature
> has one home. The first release's cut lands in `SCOPE.md`.
>
> **Priorities (MoSCoW):**
> - **Must:** the first release cannot ship without it.
> - **Should:** in the first release; cut only if time forces it.
> - **Could:** in the first release if it is cheap.
> - **Won't (v1):** not in the first release. Recorded so it isn't proposed again.
>
> **Source tags:** *user* = the user's idea; *deck* / *BRD* = imported; *Claude* = consultant
> suggestion the user accepted.
>
> **Area order:**
> 1. Joining and onboarding
> 2. Quests
> 3. Verification and fair play
> 4. Points, levels and streaks
> 5. Rewards shop and prize handover
> 6. Leaderboard and big screen
> 7. **The Questify layer:** cross-event profile, levels, items, achievements, Questify quests, recommendations, player data, after the event. Expanded by the user in Area 4 and taken **next**, before Areas 5 and 6, because the shop and boards show its items
> 8. Event home and venue map
> 9. Staff mode
> 10. Organizer dashboard
> 11. Notifications and messaging
> 12. Analytics and reports
> 13. Sponsors and exhibitors
> 14. Platform admin, trust and safety

---

# Prioritized by area

## Area 1 — Joining and onboarding (2026-10-16)

Decisions: ADR-024 (join methods), ADR-028 (age), ADR-030 (sign-in), ADR-031 (browse first),
ADR-032 (names). Target: **from the first scan to the first coin in under 3 minutes, install included** (ADR-098).

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-01 | Join an event by event code, join QR, invite link, or the public events list | Must | user | Public (listed) or private events (ADR-024) |
| F-69 | Sign in with a Saudi phone number (+966) or an email address, by one-time code | Must | user | No passwords, no social logins (ADR-030). Login-code sends rate-limited per number, address and device |
| F-70 | Browse before signing in: public events, an event's quests and prizes | Must | Claude | Sign-in is asked at the Join tap (ADR-089, refines ADR-031) |
| F-71 | One scan does everything: the join QR or invite link opens the app, or the store, and after install lands in that event | Must | Claude | Deferred deep link. Android: install referrer. iOS: the event page copies the code and the app offers a one-tap paste. Verify: Q-070 |
| F-72 | Event web page per event: banner, prizes, store buttons, link preview for WhatsApp and social apps | Must | Claude | Where invite links land when the app isn't installed; serves F-71. Works only once the event is activated (F-265) |
| F-73 | Profile at sign-up: username (strictly unique, filtered) + avatar from Questify's set + birth year | Must | user | Under 13 is refused kindly (ADR-028, year-based rule ADR-075). The real name is not asked here (ADR-032, ADR-084) |
| F-74 | Join card: the event's rules (PD-07) and what the organizer will see (PD-17) on one card, with one Join button | Must | Claude | Replaces a series of consent screens |
| F-75 | Several events at once, with an event switcher | Must | Claude | One account across all organizers |
| F-76 | Stay signed in; sign out; change phone or email, or add a second one (email to a phone account, or the reverse), with a fresh code | Must | Claude | No code at every launch |
| F-77 | Account deletion in the app and on a web page | Must | compliance | PD-16. Deletes the profile, points, submissions, votes and items; keeps prize-handover records only as long as legally required (Q-051) |
| F-78 | Join fields set by the organizer: full name, company, job title, department, ticket number or custom; each optional or required; up to 5 | Should | Claude | Full name only when the event needs it (ADR-032). Shown on the join card and shared only with that organizer |
| F-79 | Guest list: the organizer uploads phone numbers and emails; invited people see "You're invited" after signing in, with no code | Should | Claude | A private event can be limited to its guest list |
| F-80 | Company email lock: a private event accepts only verified addresses on chosen domains (e.g. `@company.com`) | Should | Claude | Needs email sign-in or a verified email on the profile (ADR-030) |
| F-81 | Welcome reward on joining an event, with the full coin-to-balance animation | Should | Claude | The organizer sets the amount or turns it off. Counts toward score like any points (Area 4) |
| F-82 | First-time intro: a language choice, then four skippable story cards (join, quests, points and ranking, prizes and your profile) with the mascot and animation, ending with Scan an event QR and Explore events | Must | user | ADR-096. Waits on the mascot choice (Q-069); replaces the earlier three-card idea |

**Won't (v1):**

| Feature | Why not |
|---|---|
| Sign in with Apple or Google | Adding either one obliges Sign in with Apple (Apple 4.8) and creates account-merging cases. Revisit with usage data |
| Guest play (earn points without an account) | Points tied to no one: multi-account farming, orphaned prizes |
| Play without installing (App Clip, Instant App) | Google shut down Play Instant in December 2025. An App Clip opened from a QR code must stay under 15 MB, which is too small for the art |
| Phone numbers outside Saudi Arabia | The user chose +966 only (ADR-030). Visitors without a Saudi number sign in with email |
| Login codes over WhatsApp | Not chosen for v1. A cheaper channel to revisit if SMS cost hurts (Stage 6) |

## Area 2 — Quests (2026-10-16)

Decisions:
- ADR-033: the quest model and v1 types.
- ADR-034: share quests.
- ADR-035: mini-games.
- ADR-036: video.
- ADR-038: categories.
- ADR-039: the community quest.

Roles (ADR-037) shape who can run each feature. Verification (who confirms what, and
anti-cheat) is Area 3.

### Quest types

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-03 | Scan a QR code | Must | user | Live camera only, one scan per player per code (F-55, Area 3) |
| F-04 | Challenge: do something at a booth or venue; staff confirm it | Must | user | Also how physical booth games are scored. Verification: Area 3 |
| F-05 | Submit a photo or text | Must | user | Organizer-only (ADR-023); points pending until approved (PD-12). Photos from the camera or system picker (PD-10) |
| F-06 | Vote among options written by the organizer (text or organizer-uploaded images) | Must | user | Never on people's looks (PD-13). Player submissions are never vote options (ADR-075) |
| F-07 | Quiz | Must | user | One try per question, points for each right answer, optional timer, the right answer shown after |
| F-83 | Enter a code (from a slide, a speaker or a push message) | Must | Claude | The check-in that works at virtual events |
| F-84 | Meet someone: scan another player's meet code; both earn | Should | Claude | One scan by either player completes it for both. No repeat pairs; the organizer sets a daily cap per player. Built by T-303c with a one-minute meet code, not My QR (ADR-209) |
| F-85 | Survey: questions with no right answer (rate a session, feedback) | Should | Claude | Results go to the organizer; speakers' feedback in Area 12 |
| F-86 | Location check-in: be inside an area | Could | Claude | Foreground location only (PD-09); a QR at the spot always works too (ADR-015) |
| F-87 | Mini-games as a quest type: four games in v1 (memory match, slide puzzle, catch, tap rush); the reward is points for passing the organizer's target (easy, medium or hard) on the first pass | Should | user / deck | ADR-097. Which games and how they are checked: ADR-097. Built: memory match and slide puzzle (T-305), catch and tap rush (T-305c, ADR-216 to ADR-218) |
| F-88 | Share quest: share event content to social apps, rewarded on trust | Should | user / deck | One reward per player per quest; organizer switches it on per event. Breaks Meta's spam policy: risk accepted in ADR-034 |

### Quest content and rules

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-02 | Quest list per event: each card shows what to do, where, the reward and the time it takes | Must | user | Filters and sorting are decided with the structures |
| F-52 | Quest details: steps with per-step progress, reward, estimated time, difficulty, tips, location | Must | deck | Every organizer-written field in Arabic and English (F-68) |
| F-90 | Passport (collection) quest: "visit 5 of these 8 booths" | Must | Claude | A multi-step quest whose steps can be done in any order |
| F-91 | Start and end times; show or hide a quest live | Must | Claude | Table stakes across competitors |
| F-92 | Repeatable quests with a cap per player | Must | Claude | A maximum per player (Cvent's repeat cap) |

**Won't (v1):**

| Feature | Why not |
|---|---|
| F-89: submit a short video (up to 30 s) | Moved after v1 by the user (ADR-069); photo and text cover v1 |
| "Open a link" or "watch a video" quests | Attention can't be checked, so they get farmed for points that buy real prizes |
| Augmented-reality quests | A heavy build for one effect; revisit after launch |
| Team quests | Individuals only at launch (ADR-025) |

### Categories (the user's design, ADR-038)

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-93 | Every quest belongs to one category; simple events get a default "General" category | Must | user | Categories are ordered by the organizer |
| F-94 | Categories expand and collapse; a collapsed one shows its progress: "2,000 / 10,000 pts · 3 / 10 quests" | Must | user | The layout is designed in Stage 4 |
| F-95 | Optional category completion bonus, paid on top of its quests' points | Must | user | |
| F-53 | Quest order inside a category, set by the organizer: "any order", or "in order" (each quest unlocks the next) | Must | user / BRD | Chains are in-order categories; the bonus for finishing a chain is F-95 |
| F-97 | A category opens at a set time (e.g. 4 pm, day 2) | Must | Claude | |
| F-98 | A category unlocks after another is completed ("Chapter 2" after "Chapter 1") | Should | Claude | |
| F-51 | Daily or weekly refresh: a category's quests reset when the event day (or week) starts (F-240) | Should | deck | For multi-day events and company seasons. Points already earned stay (FR-1619) |
| F-99 | Hidden category: not shown until a secret QR is scanned or a hint is pushed | Could | Claude | |

### Polls, community and live moments

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-100 | Live poll: a vote pushed to everyone as a pop-up card | Should | user | The vote type (F-06) delivered live. One or several choices; points optional; results shown after voting, at close, or never |
| F-101 | Community quest: every player works toward one shared goal | Should | user | Detail below; ADR-039 |
| F-102 | Flash quests and boosts: quests that appear for a short window; double-point windows on a category or zone | Should | Claude | Fired live or scheduled. No prayer-time pause (ADR-065) |
| F-103 | Live finale: countdown, last community push, winner reveal on the big screen | Should | Claude | Built in Area 6 |

**Community quest (F-101), as designed with the user:**
- **The measure:** total points earned by all players, completions of a chosen quest or
  category, or number of players who did something.
- **How players contribute:** by playing. Points earned count toward the shared goal as
  participation points; **nothing is deducted from anyone's balance** (ADR-039, as corrected in
  Area 12).
- **Window:** start and end times. Short windows work, e.g. "20 minutes before the finale".
- **Milestones (optional):** each has its own reward.
- **Reward when the goal is reached:**
  - points for each player;
  - unlock a quest, category or store item;
  - a real-world moment the organizer announces;
  - or nothing.
- **Who gets the reward:** players who contributed at least once by default; the organizer can
  switch it to everyone in the event.
- **If the goal is missed:** nothing is awarded, and no pity reward is faked.
- **Where it shows:** a progress bar on the event home and the big screen, plus a push at each
  milestone.

**Experience ideas not chosen for v1:**

| Idea | Note |
|---|---|
| Fog-of-war map (zones revealed as you complete quests there) | Proposed for Area 8; the user didn't pick it |
| Bingo view of a category | |
| Bring a friend (both earn when the friend finishes a first quest) | |
| Quiet-zone boost (dashboard suggests boosting booths with few visits) | Flash boosts (F-102) can still be fired by hand |
| Kudos tokens | |
| Collectible cards | Not picked here; the deck's collection (F-58) gets its final call in Area 7 |
| Prediction quests | Claude advised against them: rewarding a guessed outcome with points that buy prizes looks like betting |

## Area 3 — Verification and fair play (2026-10-16)

Decisions:
- ADR-040: verification methods per quest.
- ADR-041: flags only; people decide.
- ADR-042: submission review.

**The rule:** the system never punishes anyone on its own. It flags, and the event team decides.

### Verification

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-54 | Verification methods per quest: the organizer enables one or more of: the player scans the quest's QR; an operator scans the player's QR; an NFC tag | Must | user | Replaces the deck's easy/hard model (ADR-040) |
| F-55 | Live camera only (no scanning from the gallery); one completion per player per quest, or up to its repeat cap; a clear "already completed" message | Must | deck / BRD | |
| F-67 | Printable QR per quest from the dashboard: view, download, print sheet | Must | BRD | |
| F-104 | My QR: each player's personal code, rotating every 30 seconds in the app | Must | Claude | Used by operator scans, kiosks (F-107) and prize redemption (Area 5); meet-someone (F-84) uses its own one-minute code (ADR-209). A screenshot expires within a minute |
| F-108 | Operator manual award: find a player by username or phone and award a quest or points | Must | Claude | When nothing can be scanned. Reason required; logged with the operator's name |
| F-109 | Caps on manual awards, set by the owner: maximum per award and per operator per day; a report of every manual award | Must | Claude | |
| F-105 | NFC tags: written from staff mode on a phone ("Write to NFC tag" on the quest), tapped by players in the app; the QR as backup | Should | user | Basic tags; the web dashboard can't write tags. Platform limits: Q-071 |
| F-106 | Rotating QR on a screen: the quest's QR on an operator's phone or on a station page opened on any tablet or TV, changing every 30–60 s | Should | Claude | The deck's "staff shows a one-time QR" is this, on the operator's phone |
| F-107 | Unattended kiosk: a tablet signed in as a station scans each player's My QR | Should | Claude | No staff needed; the rotating My QR proves the player is there |

### Fair play

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-110 | Points record: every change stored with reason, quest, operator, device and time; never edited or erased | Must | Claude | Corrections are new entries. On account deletion, entries are anonymized (FR-1739). The base for history (F-60), disputes and audits |
| F-111 | Exclusion list: the owner's team and operators never appear on boards or win rank prizes; the owner can add phone numbers or email domains | Must | Claude | Mirrors Saudi draw rules and Airmeet's staff exclusion |
| F-112 | Remove an award, with a reason (owner) | Must | Claude | Written to the record as a new entry |
| F-117 | Ban a player from an event (owner) | Must | Claude | Their name leaves the board; their record is kept |
| F-113 | Rate limits on typed codes and login codes | Must | Claude | Per player and per device |
| F-119 | Submission review queue for operators and the owner: approve, or reject with a reason; points pending until approved | Must | Claude | PD-12 |
| F-120 | Auto-approve per quest: points land at once, and the team can still remove the submission and its points later | Should | user | ADR-042 |
| F-114 | Automatic flags (no automatic action): several accounts on one device in an event (phone and email accounts alike), location far from the venue or faked, impossible speed between stations, bursts of completions | Should | user / Claude | ADR-041, ADR-084. Location flags are off for virtual events |
| F-116 | Flagged-activity page: each case with its evidence; clear it, remove points or ban, by hand | Should | user | The admin acts; the system never does |
| F-115 | Device integrity (Apple App Attest, Google Play Integrity) as one more flag | Could | Claude | Never blocks |
| F-118 | Help desk: from a quest or the event, "Report a problem" or "Ask a question" (type, text, optional photo); operators reply and mark it solved; the player gets a push | Should | user | Covers broken or missing QR codes. Private between player and event team |

**Won't (v1):**

| Feature | Why not |
|---|---|
| Automatic penalties: holding or removing points without a person deciding | The user's rule (ADR-041) |
| Secure NFC tags (a fresh signed code per tap) | Not picked; basic tags plus the QR backup for v1 |
| Bluetooth beacons | Need hardware and background location (PD-09) |

## Area 4 — Points, levels and streaks (2026-10-16)

Decisions:
- ADR-043: rank by points earned.
- ADR-044: two layers, the event and Questify.
- ADR-045: streaks.

The Questify layer itself (lifetime level, items, achievements, Questify quests, player data) is
Area 7.

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-121 | Two numbers per event: **score** (points earned; ranks you) and **balance** (earned − spent; what you can spend) | Must | Claude | Spending never lowers your rank by default; each event may choose otherwise (ADR-043, ADR-134) |
| F-08 | Balance and progress always visible, animated | Must | user | |
| F-24 | Event currency: name in Arabic and English + an icon from Questify's 3D set (coin, crown coin, gem, leaf, star) | Must | user | No uploaded icons |
| F-56 | Quest-complete celebration in two steps: a "Scanned! checking…" beat within 300 ms, then the full +points celebration (Claim) when the server confirms | Must | deck / BRD / user | ADR-083. Points are recorded whether or not Claim is tapped |
| F-11 | Rich animation and progress feedback. Celebrations grow with rarity: quest small; level up medium; category, community goal or finale full-screen | Must | user | Respects the phone's reduce-motion setting |
| F-122 | Pending points shown apart from the balance ("+150 pending") until approved | Must | Claude | Submissions (F-119) |
| F-60 | Activity history: every point earned, spent, removed or pending, with its reason | Must | deck / BRD | Read from the points record (F-110) |
| F-123 | Live point edits: the organizer chooses "future completions only" or "also past completions"; deleting a completed quest asks whether to keep or remove the points players earned from it | Must | Claude / user | Every option is explained on a confirmation screen (F-196). Adjustments are new entries in the points record (ADR-063) |
| F-124 | Questify XP: the same hidden amount for every quest, on its first completion only; never spent. Difficulty-based XP and XP on repeats are platform settings | Must | Claude / user | ADR-083 |
| F-57 | Lifetime Questify level with an XP bar and the next level's reward | Must | deck / user | Across all events (ADR-044). Rewards: Area 7 |
| F-59 | Event streak: consecutive event days with at least one quest (closed days don't break it), switched on by the organizer, with or without bonus points | Should | deck / user | ADR-083 |
| F-125 | Questify daily streak: any Questify activity that day counts (the daily challenge, an event quest, a Questify quest); can be switched off platform-wide | Should | user | Rewards in XP or items, never event points or gems (ADR-046) |
| F-126 | Next reachable reward: "120 more for a coffee" | Should | Claude | Starbucks' ladder lesson; placement in Area 8 |

The welcome reward (F-81) counts toward score like any other points. Every player gets the same
amount, so ranking is unaffected.

**Won't (v1):**

| Feature | Why not |
|---|---|
| Buying points; giving points to another player | ADR-002, PD-05 |
| Per-event levels | The lifetime level replaces them; the event shows score, rank and category progress |
| Organizer-uploaded currency icons | Off-style art to review (PD-29); the 3D set keeps every event on-brand |

## Area 7 — The Questify layer (2026-10-16)

Decisions:
- ADR-044: two layers.
- ADR-046: items, gems and the Questify shop.
- ADR-047: player data and invitations.
- ADR-048: after the event.

Lifetime XP and level: F-124 and F-57 (Area 4).

### Profile and progression

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-127 | Questify profile, across all events: character, frame, title, level and XP bar, achievements, passport, history | Must | user | Public view shows only username, character, frame, title, level, achievements and passport (ADR-032) |
| F-143 | Edit profile: character, frame, title; username only if the Questify team allows changes (platform setting), with previous usernames kept | Must | Claude / user | ADR-084 |
| F-128 | Level titles in Arabic and English, in the adventure theme (e.g. Explorer → Pathfinder → Adventurer → Legend) | Must | Claude | Names written with the `ux-araby` skill in Stage 4 |
| F-58 | Questify achievements, tiered bronze/silver/gold: events attended, quests done, cities played, top-10 finishes, community goals reached; locked ones shown as silhouettes | Must | deck / user | |
| F-133 | Event Passport: a stamp for every event played, with its logo, date and final rank | Must | Claude | The deck's "collection" |
| F-132 | Questify quests: always-on (attend 3 events, play in 2 cities, set your interests, follow Questify) and seasonal campaigns run by the Questify team | Must | user | Social-follow rewards carry ADR-034's accepted Meta risk |

### Special items, gems and the Questify shop

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-129 | Avatar frames and titles: earned, then equipped from a locker | Must | user | Shown on boards and the profile |
| F-131 | Every level-up unlocks an item | Must | user / Claude | |
| F-130 | Extra characters beyond the starter avatars | Should | user | New 3D art per character (Codex) |
| F-134 | Event souvenirs: the organizer grants an exclusive frame, title or character to winners, finishers or everyone who attended | Should | Claude | A possible paid add-on (Stage 3) |
| F-135 | Gems: the Questify layer's currency, earned from Questify quests, achievements and level-ups; never bought | Should | user | Separate from event points and XP (ADR-046) |
| F-136 | Questify shop: spend gems on frames, titles and characters | Should | user | No real money (ADR-002); no trading between players |

### Daily, discovery and invitations

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-137 | Daily challenge: three quick questions a day (culture, sport, upcoming events) from a bank the Questify team fills; a sponsor can fund a day | Should | Claude | About 90 questions a month to write; gives XP |
| F-138 | Interests and city on the profile; "For you" list of recommended public events | Should | Claude / user | |
| F-140 | Marketing opt-in, not pre-ticked, per channel (push, SMS, email); change it any time in settings | Must | compliance | Apple 4.5.4; CST promotional consent (PD-24) |
| F-139 | Questify invitations for organizers: an organizer asks Questify to invite opted-in players by interests, city or history; the organizer sees only the results (sent, opened, joined) | Should | user | Organizers never see other events' players (ADR-047). Paid, billed on the web (PD-22) |

### After the event

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-142 | After the event ends: the shop stays open for a window the organizer sets (default 3 days), then the balance closes. Score, rank, passport stamp, souvenirs, XP and achievements stay forever | Must | Claude | ADR-048 |
| F-141 | Event recap card: rank, quests done, souvenir, shareable | Should | Claude | |

**Won't (v1):**

| Feature | Why not |
|---|---|
| Name colors | Not picked |
| Gems from the daily streak or daily challenge | Not picked; those give XP |
| Leftover event points converting to gems | Not picked; would need a fair formula across event sizes |
| Yearly "Questify Wrapped" | Not picked; event recaps only |
| Collectible cards | Not picked in Area 2; the passport covers collection |
| Buying gems or items; trading items | ADR-002, PD-05 |

## Area 5 — Rewards shop and prize handover (2026-10-16)

Decisions:
- ADR-049: handover.
- ADR-050: digital codes.
- ADR-051: rank prizes.

Earlier decisions that apply here:
- Prizes come from the organizer (ADR-011).
- Fixed prices, no chance (ADR-026).
- Spending never lowers rank by default; each event may choose otherwise (ADR-043, ADR-134).
- The shop window after the event (ADR-048).

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-10 | Rewards shop per event: price in the event currency, picture, Arabic and English text, stock, per-player limit, availability window | Must | user | Everyone can spend, not only the top 10 |
| F-22 | Organizer creates and manages rewards and stock | Must | user | Dashboard detail in Area 10 |
| F-144 | Three kinds of reward: an item collected at a desk, a digital code shown in the app, an experience confirmed by an operator (VIP lounge, meet the speaker) | Must | Claude | |
| F-145 | Reserve, then pick up. The player taps Redeem: points leave the balance and stock is held. At the desk an operator scans My QR, sees the pending items and taps Handed over | Must | Claude | Unclaimed after the organizer's set time: points and stock return automatically (ADR-049) |
| F-146 | Digital codes uploaded by the organizer as a list per reward; each redemption reveals one code, kept in the player's history | Must | Claude | The organizer is warned when codes run low (ADR-050) |
| F-147 | Cancel a redemption before pickup (player or operator): the points and the stock return | Must | Claude | Logged in the points record |
| F-148 | Honest stock: the remaining count is shown and sold-out is clear; never faked | Must | Claude | FTC dark-pattern lesson (research) |
| F-153 | The event's official rules shown before a player's first redemption | Must | compliance | PD-07 |
| F-149 | Rank prizes: the organizer sets prizes per rank; winners revealed at the finale; handed over like any prize; staff excluded (F-111) | Should | Claude | Licence question for counsel: Q-041 (ADR-051) |
| F-150 | Prizes as quest or category rewards: an item instead of, or with, points | Should | Claude | Collected through the same handover |
| F-151 | Pin a goal: the player pins a reward and sees what's left to earn | Should | Claude | Shown by F-126 |
| F-62 | Shop sections (featured, merch, food, experiences) and tags (new, popular, limited) | Should | deck | Collectibles removed: covered by the passport |
| F-152 | Pause redemption for a player, by hand (owner) | Should | Claude | For flagged cases (ADR-041); never automatic |

**Won't (v1):**

| Feature | Why not |
|---|---|
| Shipping prizes to an address | Address data and logistics; desk pickup and digital codes cover v1 |
| Automatic gift cards from a supplier (e.g. Resal) | Later; organizers upload codes in v1 (Q-018 closed by ADR-050) |
| Score-tier unlocks | Not picked |
| Back-in-stock alerts | Not picked |
| Mystery boxes, wheels, draws | ADR-008, ADR-026 |

## Area 6 — Leaderboard and big screen (2026-10-16)

Decisions:
- ADR-052: the ranking.
- ADR-053: navigation, decided here because the ranking's place depended on it.
- ADR-054: the big screen.

Boards rank points earned (ADR-043); everyone is visible under their username.

### Rankings

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-09 | Event ranking: the top 10, with you highlighted; if you're below 10, you appear as an 11th row with your real rank. 11 rows, no scrolling | Must | user | Shown as a card on the event Home that opens the ranking screen. Rows compact enough for small phones (Stage 4) |
| F-155 | Ties: whoever reached the score first ranks higher | Must | Claude | Always one winner per rank prize |
| F-23 | Organizer ranking controls: ranking on or off, today's ranking on or off; banned and excluded players never shown | Must | user | F-111, F-117. The today's-ranking switch exists once F-61 (Should) is built |
| F-61 | Today's ranking for multi-day events, reset when the event day starts (F-240) | Should | deck / BRD | Weekly tab not chosen |
| F-154 | Questify-wide ranking by XP: lifetime and this month; on Questify home, not inside events | Should | Claude | Needs fixed XP (ADR-044, accepted) |
| F-160 | Rank alerts: "You're in the top 10!" and "You dropped out of the top 10" | Should | Claude | No push cap applies (ADR-065) |

### Navigation (ADR-053)

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-161 | Event bottom bar: Home, Quests, ● center button, Rewards, Profile | Must | user | Answers Q-058. Map placement: Area 8 |
| F-162 | Center button: a large, distinctive round button; opens the scanner (QR and NFC) with a toggle to My QR | Must | user / Claude | One place for both ways of proving you were there (ADR-040) |
| F-163 | Leaving the event takes two deliberate taps: the event pill in the top bar opens a sheet with "Questify home" and your other events | Must | user | Never one stray tap from the bottom bar |
| F-164 | The app opens where the player was: inside an event during its dates, otherwise on Questify home | Must | Claude | |

### Big screen (ADR-054)

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-156 | Big screen: a web page opened on any screen with a link from the dashboard; the organizer picks and orders its scenes | Must | Claude | Answers Q-015 |
| F-157 | Scene: live ranking, top 10, updating within seconds | Must | Claude | |
| F-158 | Scenes: community quest progress, live poll results | Should | Claude | F-100, F-101 |
| F-159 | Scene: photo wall of approved submissions picked by the organizer, only from players who allowed that photo on screen | Could | Claude | A per-photo exception to ADR-023 |

The finale countdown and winner reveal is also a big-screen scene; it is listed in Area 2 as F-103.

**Won't (v1):**

| Feature | Why not |
|---|---|
| Bracket view (5 above, 5 below) | Replaced by the user's 11-row design |
| Gap to the next rank; full-ranking link | Not wanted |
| Category ranking; biggest climbers | Not picked |
| Hiding from the public board | Not wanted; PD-20's anonymous option declined (ADR-052) |
| Ranking freeze before the finale | Not picked |
| A push for every rank change | Notification overload (Whova's top complaint) |

## Area 8 — Event home, venue map and Questify home (2026-10-16)

Decisions:
- ADR-055: maps.
- ADR-056: light agenda.
- ADR-053: navigation, extended with Questify home's bar.

### Event Home and info

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-50 | Event Home: banner with countdown, event progress, ranking card (F-09), your goal (F-126, F-151) | Must | deck | Answers "what do I do next?" in one screen |
| F-165 | Up next: one suggested quest (nearest, ending soonest or best value) with a Go button | Must | Claude | |
| F-168 | Event info page: about, venue and address (opens the phone's maps app), organizer contact, FAQ, rules, link to the organizer's site | Must | Claude | |
| F-166 | Happening now: a strip of what's live (open categories, flash quests and boosts, live polls, community quest, current sessions) | Should | Claude | |
| F-167 | Announcements on Home: the organizer's latest posts | Should | Claude | Also sent as push (Area 11) |
| F-169 | Light agenda: sessions with time, room and speaker; a quest (code, survey) can be linked to a session | Should | user | Extended by F-295 to F-304 (ADR-095): registration, capacity, My sessions, reminders. Superseded in part: ADR-056's "no bookmarks, reminders or personal schedule" |

### Maps (ADR-055)

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-63 | Event maps: the organizer adds any number of maps (floors, an outdoor area, zones), each named; players switch between them | Must | deck / user | A map can be just an uploaded picture |
| F-64 | Pins on a map, placed from the dashboard: named sections and booths, quests (showing done/open/locked and points), amenities (prayer rooms, toilets, food, info desk, first aid). Tap a pin for its details | Should | deck / user | Optional per map. A reference for where things are, not navigation |
| F-170 | Quests tab toggles between list and map; "you are here" is the last station you scanned | Should | Claude | No indoor positioning |

### Questify home (outside events)

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-171 | Questify home bar: Home, Explore, ● (scan an event's join QR), Shop, Profile | Must | Claude | The same center button as inside events. The Shop tab appears with the gem shop (F-136, Should) |
| F-172 | Questify Home: your events (live, upcoming, past), daily challenge, streak, Questify quests | Must | Claude | |
| F-173 | Explore: the public events list (ADR-024), "For you" (F-138), Questify-wide ranking (F-154) | Must | Claude | "For you" and the Questify-wide ranking appear as F-138 and F-154 (Should) are built |

**Won't (v1):**

| Feature | Why not |
|---|---|
| Speaker profiles, session ratings and networking, seat maps, a waitlist, selling tickets or any payment | Turns Questify into a full event app (the space where competitors are called cluttered); ADR-002 and PD-22 keep payments out (ADR-095) |
| Routes, indoor positioning, beacons | Hardware; maps are a reference, not navigation |
| A live street map with GPS distance to nearby quests | Maps are uploaded pictures; an outdoor area is one more map. Location check-in quests (F-86) still use GPS |

## Area 9 — Staff mode (2026-10-16)

Decisions:
- ADR-057: operator access and modes.
- ADR-058: renameable words.

Abilities that already exist and live in operator mode:
- scanning My QR (F-104);
- showing a rotating QR (F-106);
- writing NFC tags (F-105);
- manual awards (F-108, F-109);
- the review queue (F-119);
- the help desk (F-118);
- cancelling a redemption (F-147).

### Access and modes

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-174 | The owner adds an operator by phone number or email | Must | user | |
| F-175 | Personal operator QR: generated for one person, long and single-use. Scanning it shows "You'll be an operator for *Event X*", then a confirmation | Must | user | The owner sees who claimed it |
| F-185 | The owner removes an operator instantly | Must | Claude | |
| F-176 | Operators can't play the event by default; the owner can allow it. An allowed operator switches between Operator mode and Player mode | Must | user | Each mode has its own home, icons and bar |
| F-183 | Abilities per operator, all on by default: scan quests, award by hand, hand over prizes, review submissions, answer the help desk, write NFC tags, show a rotating QR. The owner can turn any off | Must | user | |
| F-184 | Assignment: by default an operator can act at any quest or booth; the owner can limit them to some | Should | user | A sponsor's booth staff see only their booth (Area 13) |

### Operator mode

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-177 | Operator bar: Home (pick your station, today's numbers), Prize desk, ● Scan, Inbox, Tools (manual award, rotating QR, write NFC, practice mode, switch to Player mode) | Must | Claude | Mirrors the player bar's center scan |
| F-178 | Station mode: pick the quest or booth once, then scan player after player. Full-screen green / orange ("already completed") / red result with sound and a buzz; ready again within a second | Must | Claude | Pre-selected for assigned operators |
| F-179 | Prize-desk mode: scan a player's My QR, see their reserved prizes, tap Handed over or cancel | Must | Claude | Never awards points (ADR-049) |
| F-180 | Operator inbox: submissions to review and help-desk tickets in one list, with a count badge | Must | Claude | |
| F-181 | My station today: completions today and in the last hour at this station, plus waiting items | Should | Claude | A glance, not analytics |
| F-182 | Practice mode: test scans show the real result screens but award and record nothing | Could | Claude | |

### Renameable words (ADR-058)

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-186 | The organizer renames "player" and "operator" for an event, once, in one place; applied everywhere in that event | Must | user | Arabic and English, singular and plural |
| F-187 | The same for "quest" and "category" | Should | user | e.g. mission, challenge; zone, chapter |

## Area 10 — Organizer dashboard (2026-10-16)

Decisions:
- ADR-059: team.
- ADR-060: AI-ready groundwork.
- ADR-061: branding.
- ADR-062: scale.
- ADR-063: live edits and confirmations.
- ADR-064: billing in v1.

The dashboard is on the web (ADR-027) and builds everything in Areas 1–9.

### Building events

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-20 | Create and manage events (physical, virtual, workplace): dates, venue, public or private, join methods | Must | user | |
| F-21 | Create and manage categories and quests: every type, its rewards, rules and verification | Must | user | Areas 2–3 |
| F-68 | Every organizer-written field has an Arabic and an English input; at least one is required, a missing one falls back to the other | Must | BRD / user | User, 2026-10-17 (UX review) |
| F-25 | Feature switches per event: shop, rank prizes, today's ranking, community quest, streak, live polls, maps, agenda, share quests, mini-games, meet-someone, help desk | Must | user | Only features in the reviewed app (ADR-007) |
| F-188 | Organizer team: an owner (billing, team, everything) and editors (build and run events; no billing or team changes) | Must | user | ADR-059 |
| F-189 | Event templates (conference, festival, campus, corporate) with categories, quests and rewards pre-filled in Arabic and English | Must | Claude | |
| F-190 | Duplicate an event, then change its dates and details | Must | Claude | |
| F-194 | Event lifecycle: Draft → Scheduled → Live → Ended (shop window, ADR-048) → Archived | Must | Claude | Activated by Questify once paid (ADR-064) |
| F-195 | Request activation: the owner asks Questify to activate an event; price and payment are settled outside the platform | Must | user | ADR-076. Questify's side: F-257 |
| F-193 | Preview the player screens in the dashboard | Should | user | No test players on a real phone |
| F-26 | Branding in the adventure theme: the organizer's logo, the event banner, and one accent color from a curated palette | Should | user | Plus currency (F-24) and words (ADR-058). ADR-061, ADR-085 |

### Running the event

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-66 | Live scan feed: completions as they happen, per quest and station, with completion rates | Must | BRD | |
| F-191 | Live actions from one screen: launch a flash quest or boost, send an announcement, open a live poll, pause a quest, skip a broken step, award by hand | Must | Claude | |
| F-192 | Live counters: stock running low, inbox waiting, flags raised, players online | Should | Claude | |
| F-198 | Change log: who changed what in the event, and when | Must | Claude | Owner and editors both edit live |

### Product-wide rule and groundwork

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-196 | Confirmation screens: every consequential action (delete, an edit that affects players, removing points, logout, cancelling) opens a screen that explains exactly what will happen; the person confirms after reading | Must | user | Dashboard and app alike (ADR-063) |
| F-197 | AI-ready groundwork: every dashboard action is also a validated API operation, and changes can be grouped into a change set that is reviewed item by item and applied in part or in full | Must | user | For the future AI wizard (ADR-060). Provider-agnostic |

**Won't (v1):**

| Feature | Why not |
|---|---|
| **AI wizard** (an interactive AI interview that builds or edits an event, then lists every change for approval) | A future version, by the user's choice; the groundwork (F-197) ships now |
| AI drafts and AI translation | Folded into the future AI wizard |
| Spreadsheet import | Not picked |
| Viewer (read-only) seats | Not picked; reports are exported |
| Colors and other themes | ADR-061; with a future theme |
| Test players on a real phone | Not picked; dashboard preview only |
| Online payment | Invoices in v1 (ADR-064) |

## Area 11 — Notifications and messaging (2026-10-16)

Decision: ADR-065.

Related features from earlier areas:
- announcements (F-167);
- rank alerts (F-160);
- community milestones (F-101);
- live polls (F-100);
- help-desk replies (F-118);
- the marketing opt-in (F-140).

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-199 | Push notifications. Personal: submission approved or rejected, prize reserved, ready or expiring, help-desk reply, operator invite. Event: announcements, flash quests and boosts, a category opening, community milestones, rank alerts, event starting soon, streak reminders | Must | user / Claude | No daily cap; no prayer or quiet-time pauses (ADR-065) |
| F-200 | Notification center in the app: every message kept, unread marked | Must | Claude | Nothing missed on a busy day is lost |
| F-201 | Push permission asked right after joining an event, with the reason ("Get told when flash quests drop"); never at launch; never rewarded | Must | Claude / compliance | PD-08 |
| F-203 | Organizer announcements: written in Arabic and English, sent now or scheduled, to everyone in the event, by push and in the app | Must | user | |
| F-43 | SMS: login codes and operator invites from the "Questify" service sender, with the purpose stated in the text | Must | user | PD-24. Provider: Q-034 |
| F-44 | Email: login codes, organizer team invites, invoices | Must | user | Promotional email is F-204 |
| F-204 | Questify promotional messages (campaigns, organizer invitations F-139) to opted-in players by push, email and SMS | Should | user | Promotional SMS needs its own registered sender, opt-in records and opt-out within 24 h; never 22:00–09:00 (Ramadan 01:00–12:00) Saudi time (CST, FR-1738) |
| F-202 | Per-topic mute: announcements, rank, community, reminders | Should | Claude | |

**Won't (v1):**

| Feature | Why not |
|---|---|
| A daily cap on broadcast pushes | Not wanted (ADR-065) |
| Automatic prayer-time pauses; quiet hours | Not wanted (ADR-065) |
| Organizer announcements by email or SMS | Push and in-app only |

## Area 12 — Analytics and reports (2026-10-16)

Decision: ADR-066.

Already decided:
- the live scan feed and completion rates (F-66, Area 10);
- organizers see only their own events (ADR-047);
- exports contain only what the join card disclosed (PD-17).

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-65 | Participation: joined, active players, activation rate, players over time, by join source (code, QR, link, public list, invitation), returning players | Must | deck | |
| F-205 | Quests and categories: completion rates, category funnels, where players drop off, most and least popular quests | Must | Claude | |
| F-206 | Rewards and economy: points earned and spent, redemptions per reward, stock left, unclaimed reservations | Must | Claude | |
| F-207 | Spreadsheet exports: players (with their join fields), completions, redemptions, submissions, survey answers | Must | Claude | Table stakes across competitors |
| F-208 | One-page post-event report (PDF) with the headline numbers and the event's logo, for clients and sponsors | Should | Claude | |
| F-209 | Survey results: answers per session or quest, rating averages, shareable with speakers | Should | Claude | Follows surveys (F-85) |
| F-210 | Quest ratings: optional thumbs up or down after completing a quest; a score per quest for the organizer | Could | Claude | The deck's "experience impact" |

**Won't (v1):**

| Feature | Why not |
|---|---|
| Average time spent; traffic heatmap | Dropped by the user (Q-056 closed, ADR-066) |
| Comparison with a past event | Not picked |
| Questify benchmark against similar events | Not picked |

## Area 13 — Sponsors and exhibitors (2026-10-16)

Decision: ADR-067.

Sponsor-related features from earlier areas:
- booth-limited operators (F-184);
- a sponsored daily challenge (F-137);
- souvenirs (F-134);
- organizer invitations (F-139).

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-211 | Sponsor profiles: name, logo, tier, booth. The organizer tags quests, categories, rewards and souvenirs to a sponsor, and "presented by" shows automatically | Must | Claude | Sponsors have no login; the organizer manages them |
| F-212 | Presented-by category: a category or zone carries the sponsor's banner and logo | Must | Claude | |
| F-214 | Analytics and exports filtered by sponsor | Should | Claude | How the organizer proves value to a sponsor |
| F-213 | Sponsor strip on the event Home: a row of sponsor logos, each opening that sponsor's quests | Could | Claude | |

**Won't (v1):**

| Feature | Why not |
|---|---|
| Sharing leads with sponsors (even with player consent) | Not wanted in v1; sponsors get counts through the organizer |
| Sponsor report link | Not picked; the organizer uses filtered exports (F-214) |
| Prize sponsor on the finale reveal; ranking naming rights | Not picked |

---

## Area 14 — Platform admin, trust and safety (2026-10-16)

Decision: ADR-068.

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-215 | Organizer sign-up: anyone creates an account and drafts events; publishing needs Questify's activation after payment | Must | Claude | Activation is the approval (ADR-064) |
| F-216 | Questify console. **Organizers and events:** activate, suspend. **Content:** Questify quests, achievements, items and the gem shop, daily-challenge questions, event templates, level titles, the XP table. **Also:** campaigns, the moderation queue, platform flags | Must | Claude | |
| F-227 | Review demo tenant, managed from the console | Must | compliance | ADR-009 |
| F-218 | Support access: platform admins can open and edit any event; every access and change is logged and visible to the organizer | Must | user | Full edit, by the user's choice (ADR-068) |
| F-219 | One platform-admin role; every action logged | Must | Claude | Separate roles when the team grows |
| F-220 | Report any player, username or content; reports go to the event team and Questify's queue | Must | compliance | PD-11 |
| F-221 | Word lists in Arabic and English: block offensive usernames; mark player-written text for its reviewer | Must | compliance | PD-11, PD-20 |
| F-226 | Organizer content: no automatic filter; reported quests, text and images go to Questify's queue, and Questify can unpublish them | Must | compliance | PD-29 as narrowed by the user (ADR-073) |
| F-222 | Block a player: hides them from your own screens | Must | compliance | |
| F-223 | Platform-wide ban: applied by a person, with a reason, and an appeal by email | Should | Claude | Never automatic (ADR-041) |
| F-224 | Download my data, from settings | Must | Claude | PDPL right of access |
| F-217 | Platform numbers: events, players, activity, invoiced revenue | Should | Claude | |

**Won't (v1):**

| Feature | Why not |
|---|---|
| F-225: a console checklist before switching on a capability | Not needed: the store listings always declare every feature as on (ADR-073) |
| Automatic filtering of organizer content | Reports and unpublishing instead (ADR-073) |

## Stage 1 review additions (2026-10-17)

Decisions: ADR-076 to ADR-085. The second review pass, which the user asked for, ran four
independent reviews and a one-question-at-a-time grilling. Each feature keeps its area in the
first column.

| # | Area | Feature | Priority | Source | Notes |
|---|---|---|---|---|---|
| F-228 | 1 | Usernames: strictly unique gamer tags, shown as @username on the profile; previous usernames kept | Must | user | ADR-084 |
| F-229 | 1 | Leave an event: stop playing and stop its pushes | Must | Claude | ADR-084 |
| F-231 | 1 | A one-way fingerprint of a deleted account's phone or email keeps event bans and one-time rewards in force after a re-sign-up | Must | Claude | ADR-084 |
| F-232 | 1 | Legal and consent steps: terms (version logged) and privacy policy at sign-up; terms again before the first submission; community guidelines in the submission screen; Settings → Legal; contact page; a rules page per event | Must | compliance | `STORE_COMPLIANCE.md` §4 |
| F-233 | 2 | Audience targeting: a category or reward visible only to players whose join field or guest-list tag matches | Should | Claude / user | ADR-085 |
| F-234 | 2 | Resubmission after rejection: allowed or not, set per quest | Should | user | ADR-085 |
| F-236 | 3 | Regenerate a quest QR: the old code stops working at once | Must | Claude | ADR-085 |
| F-237 | 3 | Bulk or compensation award: points to everyone in a session or a list, by the owner or an editor, logged, outside operator caps | Must | Claude | ADR-085 |
| F-238 | 3 | Station pages, kiosks and big screens are paired from staff mode or the dashboard and can be revoked; big-screen links can be regenerated | Must | Claude | Security (NFR-018) |
| F-240 | 4 | Event day start: an organizer setting, default 4:00 am in the event's time zone; used by today's ranking, daily categories and streaks | Should | Claude / user | ADR-083 |
| F-241 | 5 | One prize desk per event, with location and opening hours shown on every reservation | Must | user | ADR-083 |
| F-242 | 5 | After the desk's last opening hours, physical rewards can't be reserved; digital codes stay redeemable until the shop window closes | Must | Claude | ADR-083 |
| F-243 | 5 | Rank-prize winners get a push with their claim deadline | Should | Claude | ADR-083 |
| F-244 | 6 | Confirm winners: before the reveal, the organizer reviews the top ranks with open flags and confirms; the prize ranking freezes | Should | Claude | ADR-083 |
| F-245 | 9 | Batch operator QRs: many single-use operator QRs at once, each with an ability preset (Scanner, Prize desk, Moderator) | Should | Claude | ADR-085 |
| F-247 | 10 | Rehearsal mode: the organizer's team plays a Draft or Scheduled event on real phones; wiped at go-live; strangers can't join | Must | Claude | ADR-080 |
| F-248 | 10 | Invite an owner and transfer ownership (managed events hand-over) | Must | user | ADR-077 |
| F-249 | 10 | The owner can limit an editor to chosen events | Should | user | ADR-077 |
| F-250 | 10 | Dashboard sign-in: email + password + email code; sessions expire after inactivity | Must | user | ADR-078 |
| F-251 | 10 | The whole dashboard works on a phone browser | Must | user | ADR-085 |
| F-252 | 10 | Organizer terms, data processing agreement and content rules accepted by click-through at sign-up; version and time logged; re-acceptance when they change | Must | user | ADR-079 |
| F-253 | 10 | Email alerts to organizers, switchable per type: activated, stock or codes low, new flags, content unpublished, support access, size limit at 80% / 100% | Should | user | ADR-079 |
| F-254 | 10 | Each event has a time zone (default Riyadh); all its times are shown in it, labelled | Must | Claude | |
| F-257 | 14 | Activation by a Questify admin: a hard, soft or no player limit, and the add-ons the event bought | Must | user | ADR-076 |
| F-258 | 14 | Usage view: login SMS, promotional SMS and email, push volume, players and storage per event and organizer | Should | user | ADR-076 |
| F-259 | 14 | Support contact details (WhatsApp hotline, email, phone) edited in the console and shown in the dashboard and app | Must | user | ADR-079 |
| F-260 | 14 | Reports from live events are marked urgent and alert the Questify team (target: 1 h live, 24 h otherwise) | Must | user | ADR-079 |
| F-261 | 14 | Daily-question bank: the console warns when fewer than 7 days are queued | Should | user | ADR-079 |
| F-262 | 14 | Platform settings for Questify-wide rules: difficulty-based XP, XP on repeats, whether usernames can be changed, the daily streak | Must | user | ADR-083, ADR-084 |
| F-263 | 14 | Minimum app version per feature: an event using a newer quest type tells older apps to update; a forced update when needed | Must | Claude | |
| F-264 | 14 | The review demo event never ends or archives, needs no activation, and resets the reviewer's progress for each new build; the reviewer is an operator allowed to play | Must | Claude | ADR-009 |
| F-265 | 1 | Unpaid or unactivated events stay private: their web page, invite links and joining work only after activation (rehearsal mode excepted) | Must | Claude | Stops free Questify-branded pages |
| F-266 | 8 | Pin a quest as the event's current focus; Event Home's Up next shows it, otherwise the open quest with the best points for its estimated time | Should | user | ADR-089 |
| F-267 | 14 | Layout configuration: the Questify team (organizers choose among approved presets, F-276) reorders, hides, renames and re-icons the items of the player event bar, the Questify home bar, the operator bar, the Profile rows and the Home sections, without a release | Must | user | ADR-090 |
| F-268 | 14 | Layout guardrails: the app refuses a configuration that hides the scanner / My QR, Settings and legal (account deletion), or Home, or that has more than five bar slots | Must | Claude | Store rules require account deletion to stay reachable (PD-16) |
| F-269 | 10 | Guided setup wizard: a step-by-step interview when an organizer creates an event; each option is an explained card with what players will see and what it needs; every step and the whole wizard can be skipped; choices become real settings | Must | user | `ux/ONBOARDING_WIZARD.md`, ADR-090 |
| F-270 | 10 | The wizard can be re-run at any time and each Build section has "Explain this" | Should | user | |
| F-271 | 10 | The wizard's text, mock previews and hints are maintained by the Questify team as data | Should | Claude | Changes need no release |
| F-272 | 1 | Add to Apple Wallet and Add to Google Wallet: after joining and from Profile, the player adds an event pass | Must | user | ADR-091. From the app only in v1 |
| F-273 | 1 | The pass shows the Questify frame with the event's logo and name, dates, the @username, score, balance, level and rank, and when it was last updated | Must | user | ADR-091 |
| F-274 | 3 | The pass carries a fixed ID code, unique per player per event. Stations, kiosks and the prize desk accept it like My QR; the result screen shows the username so the operator can compare | Must | user | Fixed code, risk accepted (ADR-091) |
| F-275 | 1 | The pass updates when the player's numbers change (Apple push, Google API), rate-limited; the code can be revoked by the server | Must | Claude | Updates are not guaranteed on Apple; the server is the truth |
| F-276 | 10 | Layout presets: the Questify team defines approved layouts and the organizer picks one per event | Should | user | ADR-090 |
| F-277 | 14 | Translation matrix: every text in the app (not only organizer content), listed as key, Arabic, English; the Questify team edits either or both at any time and the change is live without a release | Must | user | ADR-093. Defaults ship in the app as a fallback |
| F-278 | 14 | Platform-wide off switch for any feature, with a message players see; a switched-off feature is hidden as if absent | Must | user | ADR-093. Compliance safety net |
| F-279 | 14 | Tuning numbers editable in the console: flag thresholds, QR refresh time, login-code limits, default reservation time, push and SMS limits | Should | user | ADR-093; answers Q-074 at runtime |
| F-280 | 14 | Maintenance mode: a message to players and pause of play, global or per event | Should | user | ADR-093 |
| F-281 | 14 | Banner to all players on Questify home, scheduled | Should | user | ADR-093 |
| F-282 | 14 | The app keeps the last configuration that worked and uses it if a new one cannot be read | Must | Claude / user | ADR-094 |
| F-283 | 14 | Find a player (by username, phone or email) and view their events, points record, flags and reports; read-only, every access logged | Must | user | ADR-094 |
| F-284 | 14 | Fix an account: change a username, reset sign-in, merge a phone account and an email account | Should | user | No restoring deleted accounts (PD-16, ADR-094) |
| F-285 | 14 | Send a push to a group: everyone in an event, or opted-in players by city or interest | Should | user | Promotional sends need the marketing opt-in (F-140, FR-1738) |
| F-286 | 14 | Handle a legal data request: export or delete one player's data, with a record that it was done | Must | user | PDPL right of access and deletion (F-224, PD-16) |
| F-287 | 14 | Edit the Arabic and English word lists that check usernames and player text | Must | user | FR-1628 |
| F-288 | 14 | Edit SMS, email and push templates, with the CST rules enforced (purpose stated, send windows) | Should | user | ADR-065 |
| F-289 | 14 | Edit the legal documents (terms, privacy policy, community guidelines, organizer DPA) as versions; new versions are shown and must be accepted | Must | user | FR-1705, FR-1726 |
| F-290 | 14 | Edit the help and FAQ content shown in the app and the dashboard | Should | user | |
| F-291 | 14 | Platform health dashboard: live events, errors, SMS delivery rate, queues | Should | user | |
| F-292 | 14 | Organizer account tools: change an owner's email, merge accounts, pause or restore an organizer | Should | user | |
| F-293 | 14 | Admin accounts and sessions: add and remove Questify admins, see their sessions, force a sign-out | Must | user | ADR-078 |
| F-294 | 14 | Questify-wide ranking seasons: reset or archive the monthly ranking on a schedule; lifetime XP stays | Should | user | F-154 |
| F-295 | 8 | Sessions with a type (talk, workshop, activity), time, place, speaker name(s), a description and an access mode set by the organizer per session: open, or registration required | Must | user | ADR-095. Replaces the light agenda (F-169) |
| F-296 | 8 | Registration: a player registers in the app for a registration-required session; it has a seat limit and a time when registration closes; when full it shows Full (no waitlist) | Must | user | ADR-095. Free; no payments |
| F-297 | 8 | My sessions: the sessions I registered for, with time and place, and a Cancel button that frees the seat | Must | user | |
| F-298 | 8 | Check in by scanning at the door: the operator scans My QR or the wallet pass; counted as attendance, with optional points | Must | user | Uses the existing scan paths (F-104, F-274) |
| F-299 | 8 | A reminder push before a registered session starts | Should | user | |
| F-300 | 8 | A warning (not a block) when a player registers for two overlapping sessions | Should | user | |
| F-301 | 8 | Spreadsheet import of sessions | Should | user | Narrow exception to "no import": sessions only |
| F-302 | 12 | Attendance and no-show report: registered vs attended per session, exportable | Should | user | |
| F-303 | 10 | The organizer opens or closes registration and changes the seat limit while the event runs | Should | user | |
| F-304 | 11 | The organizer sends a push to everyone registered for a session | Should | user | A service message, not marketing |
| F-305 | 1 | A player who arrives from a join QR or link sees the event preview and joins first, then the full intro with a Skip button, then Home | Must | user | ADR-096. Adds up to ~15 s before the first coin unless skipped |
| F-306 | 1 | Replay: "How Questify works" in Settings reopens the intro | Should | user | |
| F-307 | 14 | The intro's texts are in the translation matrix; its order and visibility use the layout controls | Should | user | F-277, F-267 |
| F-308 | 2 | Mini-game rounds are issued by the server with a start time and a random seed; the phone sends its inputs and the server replays them, so a reported score is never trusted | Must | Claude | ADR-097. Built (T-305, ADR-212) |
| F-309 | 2 | Attempts per mini-game quest: default 1, changeable by the organizer (one, a few, or unlimited with a cooldown) | Must | user | ADR-097. Built (T-305, ADR-213): 1 to 10, or unlimited with 1 to 1,440 minutes between rounds |
| F-310 | 2 | Organizer images (their logo or a sponsor's) can appear on cards, puzzle pictures and falling items | Should | Claude | ADR-097. T-305b, blocked on Q-149; the default pictures show until then |
| F-311 | 2 | A finished round whose result could not be sent is kept on the phone for a short time with a Retry button | Should | Claude | A result retry, not an offline queue (ADR-029). Built (T-305): in memory until the round's window ends |
| F-312 | 7 | Daily word on Questify home: one hidden word a day for everyone, six guesses, feedback by letter position, in Arabic and English; counts for the daily streak and XP | Should | user | ADR-097 |
| F-313 | 14 | Word bank in the console: valid and daily words in Arabic and English; a day with no word shows no game | Should | user | Like the daily questions (F-261) |
| F-314 | 1 | If the SMS login code has not arrived after about 30 seconds, the sign-in screen offers to send the code to an email instead | Must | Claude / user | Stage 5, FR-1812 |
| F-315 | 10 | The organizer can set email as the first sign-in option for an event held in a crowded venue | Should | Claude / user | Stage 5, FR-1813 |
| F-316 | 14 | Challenge cadence setting: the daily challenge and the daily word run weekly or daily (weekly at launch); the console warns when fewer than two periods of content are queued | Should | user | ADR-099 |
| F-317 | 5 | A player with an open flag has their prize handover held at the desk ("Held, ask the owner") until an owner or editor clears the flag or bans the player; the organizer can turn the hold off per event | Must | user | ADR-100; an exception to flags-only (ADR-041) |
| F-318 | — | The player app also runs in a web browser with every function that does not need phone hardware (NFC tap, adding to a phone wallet); camera scanning uses the browser camera | Could | user | ADR-101, ADR-102. A bonus, not a requirement (user, 2026-10-17) |
| F-319 | 1 | Right after the first sign-in, the app invites a phone-only player to add an email (optional, skippable), so the email code works if the SMS gateway fails | Could | Claude, approved by user 2026-10-18 | Stage 9 pass; FR-1812, FR-139 |
| F-320 | 1 | Three event access types per event: Public (listed, anyone joins), Unlisted (not listed; join with code, QR or link) and Private (code or link plus owner approval) | Must | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-321 | 1 | Private events: a player requests to join and the owner accepts or declines; invited people (guest list, invite by phone or email) join without approval; the waiting player sees a waiting screen and gets a push | Must | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-322 | 10 | The owner can change an event's access type at any time with a confirmation screen; players already in stay in | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-323 | 1 | Hard limit with a waiting list: when the accepted-player limit is reached, new players see 'Event is full' and can join a waiting list the owner or Questify releases from | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-324 | 3 | One ticket center in the app with four types (report a player, app problem, suggestion, question or prize problem); the type decides who receives it | Must | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-325 | 3 | A ticket is answered once and then closed; the event team can escalate to Questify and Questify can send back or take over | Must | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-326 | 7 | The player's profile shows My tickets with the replies, and the full history of notifications received | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-327 | 10 | Owner reports: a tickets inbox with counts by type, reported players and content, a prize-problems view, and a join requests queue | Must | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-328 | 14 | Platform feature flag: each feature is Off or On for the whole platform, with an override per organizer; an Off feature is hidden from owners and players | Must | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-329 | 14 | Three layers per event: the platform, then Questify allows the feature for the event, then the owner turns it on or off; a feature the owner may not use shows as a locked card with Ask Questify | Must | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-330 | 8 | Home blocks the owner can add: custom text card, quick-link buttons, top-3 podium preview, featured quest or reward | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-331 | 8 | Banner slider on Home: several slides, each with an image and a tap action (open a quest, reward, session, map pin, sponsor, a web link or nothing) | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-332 | 8 | Countdown blocks on Home: a label, a date and time, and what happens at zero (hide, or show a message); more than one allowed | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-333 | 8 | Home editor: drag blocks to reorder, show or hide each block, with a live phone preview, a Use Questify preset button and a Reset to default button | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-334 | 6 | Ranking layout per event: List (top 10 plus the player) or Podium (top 3 on a podium, then the rest and the player), both on one screen; scores shown or rank only | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-335 | 2 | Layout choices for Quests (list or card grid) and the Rewards shop (grid or list) | Could | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-336 | 5 | Prize reservation can be switched On or Off; when Off, prizes are redeemed at the prize desk, where staff scan the player, take the points and hand over in one step; the shop can also be switched off for an event with no prizes | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-337 | 8 | Event info page builder (about, schedule link, FAQ, contacts, rules, sponsors, custom section) and one extra custom page | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-338 | 11 | Default notification topics per event (players can still mute) | Could | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-339 | 14 | View as organizer (support view): a platform admin opens an organizer's event exactly as they see it, read-only first, every access logged | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-340 | 14 | Questify home layout editor with the same drag-and-preview editor and banner slider | Could | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-341 | 14 | Per-organizer feature usage view | Could | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-342 | 2 | First-N bonus: a quest pays extra points to the first N players who complete it, with a live count of bonuses left | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-343 | 6 | Cheers on the big screen: five fixed reactions players send while the owner has started a cheers moment; on or off per event | Could | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-344 | 1 | Name display per event: username only, full name only, or both, visible to everyone in the event or to staff only | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-345 | 10 | Event text overrides: the owner renames tabs and key buttons from a short approved list, in Arabic and English | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-346 | 9 | Operator activity view (scans per hour, awards, last activity per operator and station) and a staff briefing push to operators only | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-347 | 10 | Go-live readiness checklist: quests, QR printed, prize desk hours, rehearsal, at least two operators, big screen paired; also shown to the Questify team for events starting soon | Should | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |
| F-348 | 10 | The guided setup wizard has ten steps: Basics and access; Join rules; Quests; Rewards; Sponsors; Screens and staff; Home and look; Messages; Add-ons and activation; Rehearse and review | Must | user | Wireframe review 2026-10-18; ADR-105/ADR-106 |


**Won't (v1), decided in the review:**

| Feature | Why not |
|---|---|
| Authenticator-app second factor for admins | The user chose email codes for everyone (ADR-078) |
| Scans queued on staff devices during signal drops | Online-only stays (ADR-083) |
| Teams-lite; lead sharing | ADR-025 and ADR-067 stand |
| Stack tower and pattern repeat as mini-games | Cut to keep the games within the 3 to 5 limit (ADR-097); pattern repeat can come later |
| The daily word as an organizer quest type | Questify home only (ADR-097) |
| Accessibility target (screen readers, large text) | No target in v1 (ADR-085) |
| First-visit tips on every screen; organizer-written welcome tips | Not picked for the intro (ADR-096) |
| Different rules for players aged 13–17 | ADR-084; counsel (Q-042) |
| Signing out other devices; re-check before redeeming | Not picked (ADR-084) |
| Operator auto-expiry; live operator list | Not picked (ADR-085) |
| Streak freeze; "most improved"; live completion counts | Not picked (ADR-083) |
| Ramadan and national-day templates; ticket-number checks; Hijri dates; the parallel-session rule; Saudi-dialect celebration copy; a Resal prize bundle; finale prize sponsor and ranking naming | Not picked (ADR-083) |
| Storefronts beyond Saudi Arabia and the GCC | ADR-081 |
| Adding the wallet pass from the event web page without the app | The pass needs an account, and there is no web sign-in for players. After launch, if install friction is a problem |
| Rotating code on the wallet pass | Apple can't do it; the user accepted a fixed code on both wallets (ADR-091) |
| Theme settings as data; choosing celebration animations; editing intro cards and mascot lines; gradual rollout; seasonal campaigns; per-country settings; draft, preview and publish; versions with rollback; last-working configuration on the phone; A/B tests | Not picked for v1 (ADR-093). Their absence is a risk: see ADR-093 |


## Feature switches (canonical list)

**Per event, organizer:** shop; rank prizes; today's ranking; community quest; event streak;
live polls; flash quests and boosts; live finale; maps; agenda; share quests; mini-games;
meet-someone; help desk; NFC; kiosks; rotating screen QR; big screen and each of its scenes
(including the photo wall); hidden categories; sponsors; welcome reward; quest ratings.

Only switches unlocked at activation are shown (ADR-076).

**Platform, Questify team:**
- daily streak;
- daily challenge;
- share quests (the Meta fallback in ADR-034);
- XP by difficulty;
- XP on repeats;
- username changes;
- Questify invitations.

The store declarations always describe every feature as on (ADR-073).

## Platform foundations

| # | Feature | Priority | Source | Notes |
|---|---|---|---|---|
| F-40 | Multi-tenant: many organizers and events in one app, each organizer's data isolated | Must | user | ADR-003 |
| F-41 | Change without store releases: features, content, words and branding are data edited from the dashboard | Must | user | Limits: ADR-007, `STORE_COMPLIANCE.md` |
| F-42 | Extensible quest types: a new type plugs in without rewiring the others | Must | user | ADR-033 |
| F-45 | Arabic and English with full RTL; Western digits (ADR-018) | Must | user | |

---

## Explicitly out

- Payments of any kind in the app (ADR-002). Organizers pay by invoice (ADR-064).
- Raffles, lotteries, random draws and other chance rewards (ADR-008, ADR-026).
