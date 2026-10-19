# Wireframe review — brainstorm log (2026-10-18)

> The user reviewed the first wireframe (artifact `4Y63bxDGJQwW2sZgB3NqzC`) and asked for more
> customization. This file records each brainstorm round. **Nothing here is applied to the SRS,
> FEATURES, DECISIONS or the wireframe until the user says "all changes are approved".** Then it is
> processed into the docs and the wireframe is edited in one pass. Raw words: `INBOX.md` (2026-10-18).

## Round 1 — Event access types (answered)

| Question | Answer |
|---|---|
| Names | **Public / Unlisted / Private** |
| Private: do invited people need approval? | **No, invited people (guest list, invite by phone or email) join straight in** |
| What a player sees while waiting | **Event name, banner and a "Waiting for approval" screen; a push and in-app message when accepted or declined** |
| Changing the type | **Any time; players already in stay in**, with a confirmation screen |

Resulting rules (proposed, pending approval):
- **Public:** listed in the public events list; anyone can join.
- **Unlisted:** not listed; join with the event code, join QR or invite link. (This is today's "private" in ADR-024.)
- **Private (new):** code or link is not enough; a player **requests to join** and the owner **accepts or declines**; the owner can also **invite** people, who join without approval. Hard limit counts accepted players only.

## Round 2 — Tickets (answered)

| Question | Answer |
|---|---|
| Who receives a ticket? | **The ticket type decides** the recipient automatically |
| Ticket types players can pick | **Report a player, App problem / bug, Suggestion, Question or prize problem** (all four) |
| Conversation | **One reply then closed** (user chose this over Claude's recommendation of a two-way thread with statuses and screenshots) |
| Escalation | **Event team can escalate to Questify; Questify can send back or take over** |

Resulting rules (proposed, pending approval):
- One ticket center in the app replaces the separate help-desk and report entry points (FR-337, FR-1411 become ticket types).
- Routing: Report a player, Question / prize problem → the **event team** (inbox for operators with the ability, queue for owner and editors). App problem / bug and Suggestion → the **Questify team** console queue. A "Suggestion about the event" is a question for the event team.
- The receiving team answers **once**, then the ticket closes. Claude's note: players cannot follow up, so a "Reopen / ask again" would open a new ticket. Revisit if event teams find this too tight.
- Event team gets an **Escalate to Questify** button with a note; Questify's queue shows a source column (event or app) and can answer, send back, or take over any ticket.
- Report a player is also reachable from that player's profile (FR-1411, FR-1415 block stays separate).

## Round 3 — Feature flags (answered)

| Question | Answer |
|---|---|
| Platform states of a feature | **Off / On, plus a per-organizer override** (no separate "Beta" label) |
| List unbuilt features as "Not released"? | **No. Only features that exist in the app** (user chose this over Claude's registry recommendation) |
| Who controls a feature for one event? | **Three layers:** platform, then Questify allows it for the event, then the owner turns it on or off. The owner can never turn on something Questify has not allowed |
| How the owner sees a feature that is not available | **Locked card with "Ask Questify".** Features that are Off platform-wide are hidden from owners |

Resulting rules (proposed, pending approval):
- Each feature has a platform state **Off** or **On**. Questify can **override per organizer** (force on or off for one organizer) and **allow per event** (add-ons, activation).
- The owner's switches work only inside what Questify allowed. Not allowed → locked card + "Ask Questify". Off platform-wide → hidden from the owner and from players.
- No registry entries for features that are not built. A feature gets a switch when its code ships in the app; the new feature can ship switched Off and be turned on later without a store release. (Claude's note for the user: this still gives "not even developed" safety for features that are *in* the app but not ready to show.)

## Round 4 — Event Home: blocks, banners, countdown, editor (answered)

| Question | Answer |
|---|---|
| New Home blocks | **Custom text card, Quick-link buttons, Top 3 podium preview, Featured quest or reward** (all four) |
| What each banner slide can do | **Tap action only** (opens a quest, reward, session, map pin, sponsor, a web link, or nothing). Not chosen: schedule, separate Arabic/English images, auto-slide speed and order |
| Countdown | **Its own block:** label, date and time, and what happens at zero (hide or show a message). More than one allowed |
| How the owner arranges Home | **Drag blocks with a live phone preview**, a hide/show switch on each block, "Use Questify preset" and "Reset to default" |

Resulting rules (proposed, pending approval):
- Home blocks the owner can add, reorder or hide: banner slider, countdown(s), progress, ranking card, goal, up next, happening now, community goal, announcements, sponsor strip, **custom text card**, **quick-link buttons**, **top-3 podium preview**, **featured quest/reward**.
- **Banner slider:** several slides; one slide shows as a single banner; each slide has an image and a tap action. Slide timing and order use sensible defaults (Claude's assumption: swipe plus auto-advance, order as listed, up to 5 slides); schedule and per-language images are **not** in v1 because the user did not choose them.
- **Countdown block:** label, target date and time, behavior at zero (hide, or show a message); more than one countdown allowed.
- Protected items still cannot be hidden (scanner, Settings; FR-1750).

## Round 5 — Ranking looks, other layouts, reservation, full events (answered)

| Question | Answer |
|---|---|
| Ranking layouts | **List and Podium** |
| Other pages with a second layout | **Quests (list or card grid)** and **Rewards shop (grid or list)** |
| Reservation switched off | **Redeem at the desk:** staff scan the player's My QR, choose the prize, points leave the balance, item handed over at once. No stock is held in the app |
| Player limit reached | **"Event is full" plus a waiting list** the owner (or Questify) can release from |

Resulting rules (proposed, pending approval):
- Event setting **Ranking layout: List | Podium**. Podium shows the top 3 on a podium, then the next rows and the player's own row, still one screen with no scrolling (FR-603).
- Event settings **Quests layout: List | Card grid** and **Shop layout: Grid | List**.
- Event setting **Prize reservation: On | Off**. Off = the shop shows prizes and prices; the prize desk redeems by scanning My QR (or the wallet pass code), taking the price from the balance and handing the item over in one step. Digital codes are revealed at the desk step or by the operator. Reservation-related items (timeouts, cancel, "Reserved" screens) are hidden.
- Event setting **Shop: On | Off** (an event with no prizes). Points still rank.
- **Waiting list:** at the hard limit, new players see "Event is full" and can join a waiting list; owner or Questify releases people from it or raises the limit.

## Round 6 — More owner and team options, wizard, reports (answered)

| Question | Answer |
|---|---|
| More owner customization | **Default notification topics for the event, Extra custom page, Event info page builder.** (Not chosen: icon per quest) |
| More Questify-team control | **View as organizer (support view), Questify home layout editor, Per-organizer feature usage view.** (Not chosen: layout presets and event templates editor) |
| Wizard | **At most 10 steps total; merge some** |
| Reports the owner sees | **Tickets inbox with counts by type, Reported players and content, Prize problems, Join requests (Private events)** |
| Extra (typed by the user) | The player can **review their reports and the replies from their profile page**, and from the profile see the **full history of notifications** they received |

Resulting rules (proposed, pending approval):
- **Event info page builder:** the owner picks and orders sections (about, schedule link, FAQ, contacts, rules, sponsors, custom section).
- **Extra custom page:** one extra page (text and images) reachable from Home.
- **Default notification topics** per event (players can still mute).
- **Questify team:** *View as organizer* (read-only first, every access logged); *Questify home layout editor* with the same drag-and-preview editor and banner slider owners get; *per-organizer feature usage* table.
- **Layout presets and event templates** stay as shipped by the team in code/config for v1 (no editor was chosen). Claude's note: the owner still picks a preset (ADR-090, FR-1764), so presets must be authored somewhere; the simplest answer is that Claude and the team supply them as data and no console editor is built in v1. Confirm when approving.
- **Owner dashboard reports:** Tickets inbox with counts by type; Reported players and content; Prize problems (filtered view); Join requests queue (Private events) with Accept / Decline and Accept all.
- **Player profile:** *My tickets* (each report/suggestion, its status and the team's reply) and *Notification history* (everything received, not only the latest).
- **Proposed 10-step wizard (merge of the former 12):**
  1. Basics and access (name, dates, time zone, Public / Unlisted / Private)
  2. Join rules (join fields, guest list, approval for Private, player limit as set by Questify)
  3. Quests (template, categories)
  4. Rewards (shop on/off, reservation on/off, prizes, rank prizes)
  5. Sponsors
  6. Screens and staff (big screen, operators, prize desk) — merges the former Screens and Staff
  7. Home and look (branding, banners, countdown, Home layout, ranking, quests and shop looks, info page, custom page) — the former Branding, widened
  8. Messages (default notification topics, first announcement)
  9. Add-ons and activation (locked cards, Ask Questify)
  10. Rehearse and review — merges the former Rehearsal and Review

## Assumptions Claude made that the user has not confirmed

1. "One reply then closed" for tickets: the team answers once and the ticket closes; a follow-up is a new ticket.
2. No registry of unbuilt features; switches exist only for features inside the app.
3. Banner slides: up to 5, swipe plus auto-advance, order as listed; no schedule and no per-language images.
4. Layout presets and templates are supplied as data by the team; no console editor in v1.
5. "Prize problems" is a filtered view of tickets, not a separate system.
6. The hard limit counts accepted players only; a waiting list exists for full events.

## Idea round — Claude's suggestions and the user's picks (2026-10-18)

Claude offered 16 ideas in four sets. The user picked:

| Idea | Picked? | Notes |
|---|---|---|
| **First-N bonus** (a quest pays extra to the first N who finish it) | **Yes** | Owner sets N and the bonus |
| **Cheers on the big screen** | **Yes, widened by the user** | "Cheers, hearts and more emojis"; **on/off by the owner** |
| **Name display** (user's own idea) | **Yes** | Per event: username only, full name only, or both |
| **Event text overrides** (rename tabs and key buttons) | **Yes** | From a short approved list, in Arabic and English |
| Bring a friend, event badges, smart nudges | No | |
| People's-choice awards, story mode, run-of-show scheduler | No | |
| Scores visible or rank only, group boards | No | |
| Certificate, organizer league, personal goals, streak freeze | No ("none of those") | |

Proposed rules (pending approval):
- **First-N bonus:** a per-quest setting "bonus for the first N completions: +X points". The completion transaction counts completions in the same database transaction, so two players at the same moment cannot both take place N+1. Shown on the quest card as a live "37 of 50 bonuses left". Counts for the score like any other points; removing an award removes it.
- **Cheers:** players tap a cheer button (hearts, applause, fire, and other emojis from a fixed Questify set; no free text, so nothing to moderate). Reactions float across the big-screen "Cheers" scene and may show a small live counter in the app. Owner turns the feature on or off per event (and Questify can turn it off platform-wide). Rate limit per player per minute.
- **Name display (event setting): Username only | Full name only | Both.**
  - Full name comes from the "full name" join field, so choosing it requires that field to be on.
  - The join card must state in plain words that other players will see the name; the player sees this before joining.
  - It changes the rule in FR-120 / ADR-032 ("only username and avatar are public"); needs a Saudi lawyer's view (PDPL, data minimization) and an entry in the data map. Claude's recommendation: the join card consent line is required, the Questify-wide ranking and profile always show usernames only, and a player may not hide their name once they have joined.
  - Where it applies: event ranking, big screen, shop receipts at the desk, operator scan results, comments in tickets seen by the event team (always visible to the event team regardless).
- **Event text overrides:** the owner overrides a short whitelist of labels for this event (bottom-bar names, "Rewards", "Scan", "Quests", "Ranking", "Profile" and the currency word), each in Arabic and English, with placeholders protected. Falls back to the platform text (F-277) when blank.

### Follow-up answers (name display and cheers)

| Question | Answer |
|---|---|
| Who sees a full name when an event shows it | **Owner chooses: everyone in the event, or staff only** (a fourth setting) |
| Where cheers can be sent | **Only while a cheers-enabled big screen scene is live** (the owner starts a cheers moment) |
| Emoji set | **Five reactions** (user typed "5 ones"). Claude's proposal for the five, to confirm: heart, applause, fire, star, party. A fixed Questify set, so the owner can switch individual ones off |

Resulting settings (proposed, pending approval):
- **Name display:** *Username only | Full name only | Both*, plus *Visible to: everyone in the event | staff only*.
- **Cheers:** owner turns the feature on or off per event; a cheer button appears in the app only while the owner has started a cheers moment on a big-screen scene; five fixed reactions; per-player rate limit; no free text.

## Idea round 2 — answers (2026-10-18) and approval

| Set | Picks |
|---|---|
| A. Running the event day | **Operator activity** and **Go-live readiness checklist** |
| B. Player side | none chosen (save for later, search and filters, personal quiet hours, profile privacy toggles: not added) |
| C. Rules and tools | none chosen (combo bonus, golden QR, quest hints, bulk import: not added) |
| D. Team and organizers | none chosen (notices, misconduct ladder, benchmarks, API keys: not added) |

**Approval:** the user wrote "that's it, now update". Everything in this file marked pending is approved and is now being
applied: FEATURES (F-320 to F-348), SRS (FR-1818 to FR-1846), DECISIONS (ADR-105, ADR-106), OPEN_QUESTIONS, TASKS, and the wireframe
(clickable 10-step wizard, working tabs, variant switches, new screens).
