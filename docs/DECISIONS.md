# Decisions — Questify (ADR log)

A diary of the big choices and why. `Accepted` = the user decided. `Proposed` = Claude's
recommendation awaiting the user. Newest at the bottom.

---

> **Proposed decisions waiting for review:** `STORE_COMPLIANCE.md` §6 lists 30 decisions that store
> and Saudi rules force (PD-01 to PD-30). Each one becomes an ADR here when the user accepts it,
> and its PD row then points to that ADR.

---

## ADR-001 — One cross-platform codebase for iOS and Android
**Status:** Accepted (user, 2026-10-16)
**Decision:** Build one app from a single codebase for both stores. It must feel near-native.
**Why:** One developer working through Claude Code; two native apps would double the work and
the bugs.
**Framework:** Expo (React Native), decided in Stage 6 (ADR-101).

## ADR-002 — No payments in v1
**Status:** Accepted (user, 2026-10-16)
**Decision:** v1 has no purchases of any kind. Points are earned, never bought.
**Why:** It keeps v1 smaller and keeps in-app purchase rules out of the first review.
**Revisit when:** the business model (Stage 3) decides how organizers pay.

## ADR-003 — A multi-tenant platform, not a single-event app
**Status:** Accepted (user, 2026-10-16)
**Decision:** One Questify app and dashboard serve any number of organizers and events
worldwide.
**Why:** The product is meant for any event planner or company, not one client.
**Consequence:** Tenant isolation (no organizer can see another's data) is a core security
requirement from day one.

## ADR-004 — Behavior is configuration, not code
**Status:** Accepted (user, 2026-10-16)
**Decision:** Features, quest types, currency, rewards, branding and copy are controlled from the
admin dashboard without code changes or store releases.
**Why:** The user wants to adapt live events and white-label clients without going back through
App Review.
**Still open:** the exact mechanism and the store limits on it. Defined in Stage 6
(`CONFIGURABILITY.md`), bounded by `STORE_COMPLIANCE.md`.

## ADR-005 — Plan fully before any code
**Status:** Accepted (user, 2026-10-16)
**Decision:** No development starts until features, requirements, design, stack and store
compliance are documented and approved.

## ADR-006 — White-label is one app, with branding per event inside it (PD-01)
**Status:** Accepted (user, 2026-10-16)
**Decision:** One Questify app on each store. Every organizer's events live inside it and carry
that organizer's branding after the attendee joins. No per-client store apps; the app icon and
name never change per organizer (PD-30).
**Why:** Apple 4.2.6 names an event app with entries per client event as acceptable and rejects
template apps submitted for clients. Google bans near-duplicate apps.

## ADR-007 — Remote configuration changes data, never adds unreviewed features (PD-02)
**Status:** Accepted (user, 2026-10-16)
**Decision:** Every feature the dashboard can switch on ships in the reviewed binary and is
switched on in the review demo event. After review, features can be switched off or on per
event. A new kind of feature (e.g. a new quest mechanic) is a store release.
**Why:** Apple 2.5.2 and 2.3.1(a) ban downloaded features and dormant features.
**Consequence:** Flexibility comes from a rich set of building blocks configured by data, not
from downloading new behavior.

## ADR-008 — No raffles or draws (PD-06)
**Status:** Accepted (user, 2026-10-16)
**Decision:** No raffles, lotteries or random draws for prizes. Prizes come from a fixed-price
points store and optional rank prizes.
**Why:** Apple rates raffles as gambling (18+). In Saudi Arabia every commercial draw needs a
Chamber of Commerce licence and a Ministry-supervised draw.
**Settled later:** the deck's other chance mechanics were removed (ADR-026).

## ADR-009 — A permanent review demo event, with a demo-only QR picker (PD-21, extended)
**Status:** Accepted (user, 2026-10-16)
**Decision:** A demo tenant with an "App Review Demo" event that has every feature and quest
type switched on. It also provides:
- a reviewer phone number with a fixed login code;
- printable QR codes attached to the review notes;
- a **demo-only QR picker**: the reviewer can pick a quest's code from a list instead of scanning
  it, so every quest can be completed without being at a venue.

The fixed login code and the QR picker work **only** inside the demo tenant, enforced on the
server and proven by an outsider test.
**Why:** Reviewers must be able to reach every feature (Apple 2.1). Without the restriction, the
picker and fixed code would be a cheating hole in real events.
**Note:** The demo event is hidden from the public, never deleted. Every app update goes through
review again and needs it.

## ADR-010 — Launch on the existing individual developer accounts
**Status:** Accepted (user, 2026-10-16). This declines PD-23. **Reconfirmed in the Stage 5 pressure-test (2026-10-17), after the company was formed (ADR-076):** the user chose to stay personal. Claude recommended moving to the company's accounts. The open consequence for counsel is Q-078.
**Decision:** Publish under Dhia's individual Apple and Google Play accounts. Dhia's legal name
shows as the seller.
**Why:** The accounts already exist and the user is fine with the name showing.
**Consequences:**
- **Google:** a personal account created after 13 Nov 2023 must run a closed test with
  12+ testers opted in for 14 consecutive days before production access. Budget three or more
  weeks before the first public Android release, and recruit the testers early.
- **Apple (EU):** trader status shows personal address, phone and email on EU product pages. Settled
  by ADR-014 and ADR-081 (no EU storefronts).
- **Later:** Apple converts an individual membership to an organization on request; Google apps
  can be transferred to an organization account. Revisit when a company is formed.

## ADR-011 — Organizers provide the prizes; Questify runs the game
**Status:** Accepted (user, 2026-10-16)
**Decision:** Prizes are supplied by the organizer. Questify provides the digital experience and
administers the game; it never funds prizes.
**Still open:** how this fits Apple 5.3.1 ("contests must be sponsored by the developer"), Q-040.

## ADR-012 — PDPL: comply as far as practical, not a launch blocker
**Status:** Accepted (user, 2026-10-16)
**Decision:** Follow PDPL as far as practical without letting it block the launch.
**Note:** The overlap with store requirements is not optional, because the stores enforce it:
- privacy policy;
- in-app account deletion;
- disclosure before data is shared with organizers or third-party AI;
- no required permissions.

Those items cover most of PDPL's day-one duties anyway.

## ADR-013 — The visual identity is the adventure-game style of the Questify brand deck
**Status:** Accepted (user, 2026-10-16)
**Decision:** The whole app, including screens, components, icons, animations and transitions,
follows `design/references/Questify-brand-deck.pdf`:
- a casual adventure-game look: wood, parchment, gold, vines, 3D-rendered icons;
- the deck's logo, app icon and seven-color palette.

This replaces the dark cyberpunk theme in BRD v2 (April 2026).
**Details:** `design/REFERENCES.md`. The full system will be in `design/DESIGN_SYSTEM.md` (Stage 4).

## ADR-014 — Launch in the Saudi Arabia storefront only
**Status:** Accepted (user, 2026-10-16). Answers Q-048. **Widened by ADR-081** to Saudi Arabia + GCC.
**Decision:** At launch the app is available only in the Saudi Arabia storefront on both stores.
Other countries are added later by changing store availability, with no new build.
**Why:** It is the target market. It also keeps Dhia's personal trader details off EU product
pages (ADR-010).
**Note:** Apple still requires a trader-status declaration even without EU distribution. The
details show only on EU storefronts.

## ADR-015 — Location is optional and never blocks anything (resolves PD-08 / Q-019)
**Status:** Accepted (user, 2026-10-16)
**Decision:** The app asks for location with a short explanation that it improves the
experience: nearby quests and the map. Refusing blocks nothing. Every location-based quest can
also be completed by scanning the QR code placed at that spot.
**Why:** Apple 5.1.2(i) forbids requiring location to earn points or prizes. The QR alternative
also works indoors, where GPS is weak.
**To verify in Stage 4:** Apple's rules for the explanation screen shown before the system prompt
(button wording, and that the system prompt always follows).

## ADR-016 — How design assets and the design system are produced
**Status:** Accepted (user, 2026-10-16). Answers Q-065.
**Decision:**
- **Painted assets (3D icons, textures, frames, logo variants) are generated by Codex** with
  OpenAI's GPT image model, through the founder's ChatGPT subscription. The work is driven by
  `design/codex-image-2/CODEX_BRIEF.md` and `ASSET_LIST.md`.
- Claude curates the results.
- Anything that can be drawn in code (buttons, bars, toggles, labels) is built by Claude.
- **The design system is code-first**: a browsable Design System page with tokens and live
  components in Arabic and English. That page is the source of truth; Figma is optional and used
  only for handoff.

**Why:**
- The style depends on bevels, textures and motion, which only code shows truthfully.
- One source of truth avoids keeping Figma and code in sync.
- Assets ship without baked-in text, so every label stays bilingual, and blank or tintable bases
  keep white-label branding and new features possible without new artwork.

## ADR-017 — Typefaces: Baloo Bhaijaan 2 (display) + Rubik (body)
**Status:** Accepted (user, 2026-10-16). Answers Q-067.
**Decision:**
- **Display** (titles, buttons, ribbons, numbers in game elements): **Baloo Bhaijaan 2**,
  weights 500–800.
- **Body** (descriptions, forms, settings, long text): **Rubik**, weights 400–700.

Both are used for Arabic and English. The logo stays artwork and is not set in these fonts.
**Why:**
- One display family drawn for Arabic and Latin together keeps both languages on-brand.
- Its round, chunky shapes are the closest match to the gold wordmark, and five weights give
  real hierarchy.
- Rubik's softened corners match the display face and stay readable at small sizes in both
  scripts.
- Both are free under the SIL Open Font License, for the app and the web.

**Compared in:** the Font Lab page (https://claude.ai/artifact/CxYQ8cNEKfeoA9Yb2uokef).

## ADR-018 — Western digits everywhere
**Status:** Accepted (user, 2026-10-16). Answers Q-068.
**Decision:** Numbers always use Western digits (0–9) in both Arabic and English: points, ranks,
prices, dates, times, countdowns, codes. Never Arabic-Indic digits (٠–٩).
**Why:** One number style across both languages, as is common in Saudi apps. It also avoids
mixed digits when organizer content, QR codes and phone numbers meet in one screen.
**Consequence:** Number formatting must force the Latin numbering system even when the Arabic
locale is active (e.g. `ar-SA-u-nu-latn`). A test should cover it.

## ADR-019 — Arabic brand name: كويستفاي
**Status:** Superseded by ADR-125 (user, 2026-10-21). Was Accepted (user, 2026-10-16), answering Q-066.
**Decision:** The brand name in Arabic is **كويستفاي**. It is used in Arabic text: the Arabic
store listing, Arabic copy and every Arabic mention of the brand. It has no logo of its own
(ADR-020).

## ADR-020 — One logo: the English wordmark, in both languages
**Status:** Accepted (user, 2026-10-16)
**Decision:** The gold "Questify" wordmark is the only logo. It is used unchanged in the Arabic
interface too. There is no Arabic wordmark. The generated one was removed from the library.
**Why:** The founder's choice. One mark keeps the brand consistent across languages.

## ADR-021 — Questify has a mascot
**Status:** Accepted (user, 2026-10-16). Which one is open: Q-069.
**Decision:** A recurring guide character appears in onboarding, tips, empty states and
celebrations. Five options, with two images each (a hero and an expression sheet), are queued for Codex
(Phase 6): a falcon explorer, a fennec fox scout, a living gold compass, an Arabian oryx ranger
and a treasure-chest buddy. Claude merges the 10 images into one voting board; the team picks
one; a full character sheet follows.


## ADR-022 — Organizers pay per event
**Status:** Accepted (user, 2026-10-16). Answers Q-001.
**Decision:** Organizers pay per event, priced by size and billed outside the app on the web
dashboard. Attendees are always free. On-ground services (booths, staff) are priced separately
when offered.

## ADR-023 — Quest submissions are visible to the organizer only at launch
**Status:** Accepted (user, 2026-10-16). Answers Q-007.
**Decision:** Photos and text that attendees submit go to the organizer's staff for approval and
are not shown to other attendees. A public gallery is a later feature that requires the full
moderation set (filter, report, block, queue; Apple 1.2).

## ADR-024 — Four ways to join an event
**Status:** Accepted (user, 2026-10-16). Answers Q-003. **Extended by ADR-105** (three access types).
**Decision:** Attendees join by event code, by scanning a join QR, by invite link, or from a
public list of events. Each event is public (listed) or private (code, QR or link only).

## ADR-025 — Individual players only at launch
**Status:** Accepted (user, 2026-10-16). Answers Q-005. Claude recommended individuals + optional
teams.
**Decision:** Everyone plays as an individual. Teams come later.
**Cost noted:** corporate and school events often want team scores. Adding teams later touches
the leaderboard, scoring and data model, so the data model should leave room for a team link.

## ADR-026 — No chance-based rewards at all
**Status:** Accepted (user, 2026-10-16). Answers Q-052; extends ADR-008.
**Decision:** The Mystery Box and Spin the Wheel are removed, along with raffles. Every reward
is a fixed price in points.

## ADR-027 — Web dashboard for organizers, staff mode in the mobile app
**Status:** Accepted (user, 2026-10-16). Answers Q-012.
**Decision:** Organizers set up and run events on a web dashboard. Staff use a staff mode inside
the same mobile app to approve challenges and scan redemptions.

## ADR-028 — Minimum age 13
**Status:** Accepted (user, 2026-10-16). Answers Q-014.
**Decision:** Users must be 13 or older; sign-up asks for the birth year. Guardian consent for
under-18s follows counsel's answer to Q-042.

## ADR-029 — Online only (no offline mode)
**Status:** Accepted (user, 2026-10-16). Answers Q-013. Claude recommended queuing actions during
drops.
**Decision:** The app needs a connection; actions without signal fail with a clear message to
retry.
**Cost noted:** crowded venues often have weak signal, and a failed scan at a booth is the moment
players give up. If pilots show this, a send-when-back queue for scans is the first fix.

## ADR-030 — Sign-in: Saudi phone number or email, by one-time code
**Status:** Accepted (user, 2026-10-16). Answers Q-004; accepts PD-14, narrowed to +966 numbers.
**Decision:**
- Attendees sign in with a **Saudi phone number (+966)** by SMS code, or with an **email
  address** by email code.
- There are no passwords and no Apple or Google sign-in in v1.
- Sessions persist until the user signs out.

**Why:**
- Saudi users expect phone sign-in.
- Email covers visitors without a Saudi number, and makes the company-domain lock possible
  (F-80).
- With our own account system and no social logins, Sign in with Apple is not required
  (Apple 4.8).

**Claude recommended:**
- At first, phone only. The user chose that, then added email after the conflict with the domain
  lock was raised.
- Any country code, not +966 only. The user chose +966: international SMS costs more, and email
  covers foreign visitors.

**Consequences:**
- Two code channels (SMS, email), each rate-limited per address and device.
- One person could hold a phone account and an email account. Guest lists and company locks
  (F-79, F-80) bind an event to verified identities. Duplicate-account rules are settled in
  Area 3.

## ADR-031 — Browse first, sign in to earn
**Status:** Accepted (user, 2026-10-16)
**Decision:** Without an account, anyone can open the app and browse public events, an event's
quests and its prizes. Sign-in is required at the first action that earns points or joins a
private event. There is no guest play.
**Why:** People see what they can win before meeting a login wall. Every point stays tied to a
verified person.

## ADR-032 — Nickname and avatar in public; the real name only when an event needs it
**Status:** Accepted (user, 2026-10-16). **The nickname became a unique username in ADR-084.** Answers Q-011; accepts PD-20 in part. Whether a player can
appear anonymously on a board is settled in Area 6.
**Decision:**
- Every player picks a nickname, filtered as user content, and an avatar from Questify's set.
  Only these appear on leaderboards and anywhere other players can see.
- An event can require the full name, among other join fields (F-78). It is shown on the join
  card and shared only with that event's organizer.
**Why:** It minimizes what is collected (PDPL), and people play more freely under a nickname.
Organizers who hand over prizes or run company events still get real names when they need them.

## ADR-033 — Quest model: a type, a reward and rules
**Status:** Accepted (user, 2026-10-16)
**Decision:** Every quest is a **type** (how it is completed) plus a **reward** plus **rules**
(when it is open, how often it can be done, what unlocks it, where it is).
- Types ship in the app binary. A new type is a store release (ADR-007).
- Rewards, rules and all text are data the organizer edits.

**v1 types:** scan QR, challenge, submission (photo, text, short video), quiz, vote, enter a
code, meet someone, survey, location check-in, built-in mini-game, share.
**Why:** One shape for every quest keeps the dashboard, the app and the data model simple. New
types plug in without touching the others (F-42).

## ADR-034 — Share quests are rewarded on trust
**Status:** Accepted (user, 2026-10-16). Answers Q-054. Claude recommended no reward, then a
proof-checked share (link or screenshot approved by staff); the user chose the honor system.
**Decision:** A share quest gives its points when the player completes the phone's share action.
There is no proof step.
- One reward per player per quest.
- The organizer turns share quests on per event.

**Costs accepted:**
- Meta's spam policy bans giving anything of value for shares, likes or follows. Posts and the
  organizer's pages are at risk on Facebook and Instagram.
- The phone's share sheet cannot confirm a post was published, so opening and closing it can
  earn the points.
- An App Reviewer may ask about it.

**Revisit if:** players farm it, or Meta acts against an organizer. The fallback is the
proof-checked share.

## ADR-035 — Three to five mini-games built into the app
**Status:** Accepted (user, 2026-10-16). **Specified by ADR-097.** Answers Q-055. Claude recommended physical booth games
scored by staff, then two built-in games; the user chose 3 to 5.
**Decision:** v1 ships 3 to 5 mini-games inside the app. Physical booth games are also supported
through Challenge quests.
- A game quest awards points for finishing, or for passing a target the organizer sets, not for
  raw score.
- The server rejects impossible results.
- Which games: Stage 4.

**Costs accepted:** each game is a store release with its own design, art, tuning and QA (ADR-007).
Scores computed on the phone can be faked; the target model and server checks contain that.

## ADR-036 — Submissions include short video
**Status:** Accepted (user, 2026-10-16), then **deferred to after v1** by ADR-069. Extends ADR-023.
Claude recommended photo and text only.
**Decision:** Players can submit photos, text and videos of up to 30 seconds.
- Videos are compressed on the phone and uploaded with progress and retry.
- Each quest can turn video off.
- Videos go to the organizer only, like every submission.

**Costs accepted:** heavy uploads on crowded venue networks (the app is online-only, ADR-029),
slower review, and higher storage and moderation cost (Q-045).

## ADR-037 — Four roles
**Status:** Accepted (user, 2026-10-16). The detailed permissions come in Areas 9, 10 and 14.
**Decision:**

| Role | Who | Can |
|---|---|---|
| **Platform admin** | The Questify team | Everything, across all organizers |
| **Event owner** | The organizer | All of an event's settings: branding, names, categories, quests, prizes, rules |
| **Operator** | The organizer's event staff | Operations only: scan players' and quests' QR codes, add points, redeem prizes. No settings |
| **Player** | Attendees | Play |

**Why:** Operators run the floor and must not be able to change the game.
**Consequences:**
- Points an operator adds by hand carry a reason and are logged with who added them.
- Limits on those points are set in Areas 3 and 9.
- Tenant isolation (ADR-003) applies to every role except platform admin.

## ADR-038 — Every quest lives in a category; chains are in-order categories
**Status:** Accepted (user, 2026-10-16)
**Decision:**
- Each quest belongs to exactly one category, ordered by the organizer. A default "General"
  category is created with each event.
- A category can:
  - require its quests in order, or allow any order;
  - pay an optional completion bonus;
  - open at a set time;
  - unlock after another category;
  - refresh daily or weekly;
  - stay hidden until found.
- In the app, categories expand and collapse; a collapsed category shows the points and quests
  completed out of its totals.

**Why:**
- It's the user's design.
- One concept covers what competitors split into chains, sections and passports, so the
  dashboard has one thing to learn.

## ADR-039 — Community quest
**Status:** Accepted (user, 2026-10-16)
**Decision:** An optional event feature where all players work toward one goal; detail in
`FEATURES.md` (F-101).
- The organizer picks the measure.
- **Players contribute by playing:** their earned points count toward the shared goal as
  participation points, and nothing is deducted from their balance.
- By default, the reward goes only to players who contributed. The organizer can widen it to
  everyone.
- **Corrected in Area 12:** a "donate from your balance" mode was recorded in Area 2. The user
  clarified that community points are participation points, never deducted, so that mode was
  removed.

**Why:** a shared goal gives the whole room one moment to rally around, and no competitor
researched has one.

## ADR-040 — Verification methods per quest
**Status:** Accepted (user, 2026-10-16). Answers Q-006 and Q-009 together with ADR-041.
**Decision:** For each quest, the organizer enables one or more methods:
1. the player scans the quest's QR: printed, or rotating on a screen (an operator's phone, a
   station page, F-106);
2. an operator, or an unattended kiosk tablet, scans the player's **My QR**, which rotates every
   30 seconds (F-104, F-107);
3. the player taps an **NFC tag**, written from staff mode on a phone, with the QR as backup
   (F-105).

When nothing can be scanned, an operator awards the quest by hand. A reason is required, and the
owner's caps apply (F-108, F-109).

This replaces the deck's easy/hard model (F-54). The deck's "staff shows a one-time QR" is
method 1 on the operator's phone.

**Why:**
- The user's design.
- One rotating personal code covers operators, kiosks, meet-someone quests and prize
  redemption.
- Screenshots and shared photos expire within a minute.
- NFC suits venues that don't want QR codes on display.

**Not chosen:** secure NFC tags that sign each tap, and Bluetooth beacons.

## ADR-041 — Fair play: the system flags, people decide
**Status:** Accepted (user, 2026-10-16). **One narrow exception added by ADR-100:** an open flag holds a prize handover. Claude recommended holding a flagged player's new points
until review; the user chose flags only.
**Decision:**
- Suspicious patterns are flagged and listed on a flagged-activity page with their evidence:
  - several accounts on one phone;
  - location far from the venue or faked;
  - impossible speed between stations;
  - bursts of completions;
  - failed device-integrity checks.
- Nothing is held, removed or blocked automatically.
- The event team clears a case, removes points or bans the player, by hand.
- Every change is a new entry in the permanent points record (F-110).

**Why:** wrong automatic penalties hurt honest players at a live event, where there's no time to
appeal.
**Cost accepted:** a cheater can spend flagged points in the store before anyone looks. Area 5
can let the owner pause redemption for a flagged player, as a manual action.

## ADR-042 — Submission review, with optional auto-approve
**Status:** Accepted (user, 2026-10-16). Accepts PD-12 with one exception. Claude recommended
manual review only.
**Decision:**
- Photo and text submissions (video after v1, ADR-069) go to a review queue that operators,
  editors and the owner work through. Points stay pending until a submission is approved.
- The owner can mark a quest **auto-approve**: points land at once, and the team can still remove
  the submission, which takes the points back.

**Why:** a lighter queue for low-value quests at big events.
**Risk accepted:** obvious junk earns points until someone looks. Submissions are visible only to
the organizer (ADR-023), so nothing objectionable reaches other players.

## ADR-043 — Boards rank points earned; spending never costs rank
**Status:** Accepted (user, 2026-10-16). **Amended by ADR-134 (2026-10-22):** this is now each event's default, and the owner may choose otherwise.
**Decision:**
- In each event, a player has a **score** (all points earned there) and a **balance** (earned −
  spent).
- Leaderboards and rank prizes use the score.
- Shop purchases lower only the balance.

**Why:** if spending lowered rank, players would hoard and the rewards shop, Questify's clearest
advantage, would go unused.

## ADR-044 — Two layers: the event, and Questify across events
**Status:** Accepted (user, 2026-10-16). **XP amounts refined by ADR-083:** one hidden amount per
quest, first completion only. Designed in Area 7. The fixed-XP rule was confirmed in
Area 6.
**Decision:**
- **The event layer:**
  - the organizer's currency, score, balance and board;
  - belongs to that event.
- **The Questify layer:**
  - a lifetime player profile across all events;
  - Questify XP and a lifetime level;
  - special items (avatar frames, characters; name colors were later dropped by ADR-046);
  - Questify achievements and Questify's own quests (e.g. attend three events);
  - a daily streak.
- **Questify XP is a fixed amount** per completed quest, by type and difficulty, the same in
  every event. Organizers set event points freely (one event may award 50,000, another
  500), so a lifetime level built on event points would be unfair.

**Why (user):**
- It gives players a reason to join more events.
- It gives organizers a reason to use Questify: an existing base of players.
- It gives Questify one player database: events attended, activity, profile. That base is for
  invitations matched to interests and history, and has marketing and commercial value.

**Claude's caution (raised once):** collect for stated purposes, not "whatever we can collect".
- PDPL needs a purpose and consent for each use.
- Store privacy labels must list every data type.
- Marketing pushes need an in-app opt-in (Apple 4.5.4).
- More data held means a bigger breach.

Settled in Area 7: Q-072 (data and consent) and Q-073 (what organizers may access).

## ADR-045 — Two streaks, each switchable
**Status:** Accepted (user, 2026-10-16). Claude recommended event streaks only.
**Decision:**
- **Event streak:**
  - counts days of a multi-day event or company season with at least one quest;
  - the organizer switches it on, with or without bonus points.
- **Questify daily streak:**
  - encourages opening Questify every day, with or without an event;
  - platform admins can switch it off;
  - it rewards XP or items, never an event's points.

**Dependency:** a daily streak needs something worth doing every day. Area 7 designs that
content. Without it, the streak only rewards opening the app.
**Settled in Area 7:** any Questify activity keeps the streak alive: the daily challenge (F-137),
an event quest, or a Questify quest. It rewards XP or items, never event points or gems, because
gems come only from Questify quests, achievements and level-ups (ADR-046).

## ADR-046 — Special items, gems and the Questify shop
**Status:** Accepted (user, 2026-10-16)
**Decision:**
- **Items in v1:** avatar frames, titles, and extra characters. No name colors.
- **How items are earned:**
  - level-ups (every level unlocks something);
  - Questify achievements and Questify quests;
  - event souvenirs granted by organizers;
  - the Questify shop.
- **Gems** are the Questify layer's own currency.
  - Earned from Questify quests, achievements and level-ups.
  - Spent only in the Questify shop.
  - Never bought (ADR-002), never traded.

**Why a third currency:**
- Event points belong to their event and close with it (ADR-048).
- XP must never be spent, or spending would lower a level.
- A shop therefore needs its own coin.

## ADR-047 — Player data across events, and Questify-run invitations
**Status:** Accepted (user, 2026-10-16). Answers Q-072 and Q-073.
**Decision:**
- **Broad collection, within the limits already decided.** Questify keeps a single player
  database across events: events attended, activity, interests, city, and the other data the
  app collects.
  - Every data type is listed in the privacy policy and in the Apple and Google privacy
    declarations.
  - No background location (PD-09). No tracking SDKs (PD-27).
- **Marketing consent:** promotional push, SMS and email go only to players who opted in.
  - The opt-in is not pre-ticked, set per channel, and can be changed any time (Apple 4.5.4,
    CST).
- **Organizers never see players from other organizers' events.** To reach new players, an
  organizer asks Questify to send invitations by interests, city or history.
  - Questify sends them to opted-in players.
  - The organizer sees only the results: sent, opened, joined.

**Why:** the player base becomes a reason for organizers to choose Questify, and a paid service.
No organizer's attendee list ever reaches a competitor.
**Claude's caution stands (ADR-044):** broad collection widens the PDPL duties, the privacy
declarations and the impact of a breach. It goes to counsel's review with the other legal
questions.

## ADR-048 — After the event: a shop window, then the balance closes
**Status:** Accepted (user, 2026-10-16). Answers Q-016.
**Decision:**
- When an event ends, its shop stays open for a window the organizer sets (default 3 days).
  Then the event balance closes.
- These stay forever: score, rank, passport stamp, souvenirs, XP, level, achievements and items.
- Each event produces a shareable recap card. There is no yearly Wrapped in v1.

**Why:**
- Players get time to redeem on their way out.
- Organizers don't carry open prize obligations forever.
- Everything that shows who the player is lasts.

## ADR-049 — Prize handover: reserve in the app, pick up at the desk
**Status:** Accepted (user, 2026-10-16). Answers Q-010.
**Decision:**
1. The player redeems in the app. The points leave the balance and one unit of stock is held.
2. At the desk, an operator scans the player's rotating My QR (F-104), sees the pending items and
   taps Handed over.
3. If an item isn't collected within the time the organizer sets, the points and the stock return
   automatically.
4. A redemption can be cancelled before pickup, and the points return.

Every step is written to the points record (F-110).
**Why:**
- The player knows the item is theirs before walking to the desk.
- Operators make no decisions at the desk.
- Disputes are settled by the record.

**Note:** the automatic return of an unclaimed reservation is a timeout, not a penalty, so it
fits ADR-041.

## ADR-050 — Digital rewards: codes uploaded by the organizer
**Status:** Accepted (user, 2026-10-16). Answers Q-018.
**Decision:**
- The organizer uploads a list of codes per digital reward (gift cards, subscriptions, discounts).
- Each redemption reveals one code in the app and keeps it in the player's history.
- The organizer is warned when codes run low.

Automatic issuing through a Saudi gift-card supplier (e.g. Resal) is a later integration.
**Why:**
- It works with any brand from day one, with no supplier contract.
- It gives virtual events rewards that don't need a desk.

## ADR-051 — Optional rank prizes, pending counsel
**Status:** Accepted (user, 2026-10-16). Legal check: Q-041.
**Decision:**
- An organizer may attach prizes to final ranks, e.g. the top 3.
- Winners are revealed at the finale and collect their prizes through the normal handover.
- The exclusion list (F-111) keeps staff out.

Whether rank prizes at a commercial event count as a "commercial competition" that needs a
Chamber licence is for counsel. The feature can be switched off per event if the answer
requires it.

## ADR-052 — The ranking: top 10 plus you, 11 rows, no scrolling
**Status:** Accepted (user, 2026-10-16). Answers Q-017; declines PD-20's anonymous option.
**Decision:**
- **The board:**
  - The event ranking shows the top 10, with the player highlighted.
  - A player below 10th appears as an 11th row with their real rank.
  - It fits 11 rows without scrolling.
- **Ties:** whoever reached the score first ranks higher.
- **Visibility:** everyone appears under their nickname; there is no hidden mode.
- **Rankings:**
  - the overall event ranking;
  - today's ranking for multi-day events;
  - a Questify-wide ranking by XP (lifetime and this month) on Questify home.

**Why:** one glance answers "where am I?".
- Low-ranked players see only themselves on the 11th row, and no one else sees them. That
  removes most of the reason for a hidden mode (the research found low-ranked players prefer
  anonymity).

**Claude suggested, not taken:** the bracket view, a gap-to-next-rank line, a full-ranking link,
category rankings, and biggest climbers.

## ADR-053 — Navigation: the event is the app while you're in it
**Status:** Accepted (user, 2026-10-16). Answers Q-058.
**Decision:**
- **Bottom bar inside an event:** Home, Quests, a large distinctive round center button,
  Rewards, Profile.
- **The center button** opens the scanner (QR and NFC) and toggles to My QR.
- **The event ranking** lives on Home as a card.
- **Questify home** is reached on purpose:
  1. tap the event pill in the top bar;
  2. pick "Questify home" or another event in the sheet that opens.

  Never from the bottom bar.
- **On launch,** the app opens in the event the player is in during its dates; otherwise on
  Questify home.

**Why:** most of a player's time is inside one event, and an accidental exit mid-event loses
them.
**Cost noted:** ranking is one tap deeper than a dedicated tab. Claude recommended a Ranking tab;
the user chose Profile.
**Extended in Area 8:** Questify home has its own bar: Home, Explore, ● (scan an event's join QR),
Shop (gems), Profile. The center button means "scan" everywhere.

## ADR-054 — The big screen is a web page with scenes
**Status:** Accepted (user, 2026-10-16). Answers Q-015.
**Decision:**
- The organizer opens a link from the dashboard on any screen, picks scenes and orders them:
  - live ranking (top 10, updating within seconds);
  - community quest progress;
  - live poll results;
  - finale countdown and winner reveal;
  - a photo wall.
- There is no ranking freeze before the finale.
- **The photo wall** shows only approved submissions the organizer picks, from players who
  allowed that photo on screen. This is a per-photo exception to ADR-023 (submissions are
  organizer-only).

**Why:** the room watches together. Competitors need a separate tool for this; for Questify it's
one link.

## ADR-055 — Maps: flexible pictures, optional pins
**Status:** Accepted (user, 2026-10-16). Answers Q-057.
**Decision:**
- An event can have any number of named maps (Floor 1, Floor 2, Outdoor area), and players
  switch between them.
- Each map is an uploaded picture. The organizer may place pins on it from the dashboard: named
  sections and booths, quests (status and points), and amenities.
- Maps are a reference for where things are, not navigation: no routes, no indoor positioning.
- "You are here" is the last station the player scanned.

**Why:**
- Some organizers have only a picture; others want a detailed plan.
- One model covers both, with no hardware.

## ADR-056 — A light agenda
**Status:** Accepted (user, 2026-10-16). **Extended by ADR-095:** registration, capacity and My sessions. Claude recommended no agenda (link out to the organizer's
own) plus a "Happening now" strip.
**Decision:**
- Organizers can add sessions (time, room, speaker) by hand or import them from a spreadsheet.
- Players see the list.
- Quests can link to a session, e.g. an "enter the code" check-in or a "rate this session"
  survey.
- No bookmarks, reminders or personal schedule.

**Why:** events without their own app still get a schedule, and sessions become places to earn.
**Cost noted:** one more thing for organizers to enter and keep in sync with their own systems.

## ADR-057 — Operators: two ways in, and a separate mode
**Status:** Accepted (user, 2026-10-16). Extends ADR-027 and ADR-037.
**Decision:**
- **Becoming an operator:**
  - the owner adds the person by phone or email; or
  - the owner generates a **personal operator QR** for one person: long, complex and
    single-use. Scanning it asks the person to confirm. The owner sees who claimed it and can
    remove them at any time.
- **Playing:** operators can't play the event they staff, unless the owner allows it. An
  allowed operator switches between **Operator mode** and **Player mode**. Each mode has its own
  home, icons and bottom bar.
- **Abilities:** each operator's abilities are all on by default; the owner can turn any of them
  off.
- **Assignment:** operators can act anywhere by default; the owner can limit them to specific
  quests or booths.
- **Operator-mode bar:** Home, Prize desk, ● Scan, Inbox, Tools.

**Why:**
- Big events bring temporary crews, and a personal QR lets them start in seconds.
- Invites suit core staff.
- Separate modes keep a staff member from scanning as a player by mistake.

## ADR-058 — Organizers rename the system's words
**Status:** Accepted (user, 2026-10-16)
**Decision:**
- Per event, the organizer renames **player**, **operator**, **quest** and **category**. The
  currency is already named per event (F-24).
- Each term is set once, in Arabic and English, singular and plural, and applied everywhere in
  that event.
- Questify home and the Questify layer use Questify's default words.

**Why:** configuration over code. A university says "student", a festival says "visitor", a
company says "team member".
**Consequence for Stage 4 copy:**
- Arabic nouns change with the definite article, plurals and agreement.
- Every string that includes a renameable word is written so the substitution reads naturally,
  and is checked with the `ux-araby` skill.
- Where a sentence can't absorb a variable noun, it is rephrased instead.

## ADR-059 — The organizer's team: owner and editors
**Status:** Accepted (user, 2026-10-16). Refines ADR-037's "event owner". **Powers split in ADR-077.**
**Decision:**
- An organizer account has one **owner**, who handles billing, the team and everything else.
- It can also have **editors**, who build and run events but can't change billing or the team.
- There are no read-only seats in v1.
- Owner and editors both count as the event's team, so they are excluded from boards and rank
  prizes (F-111).

## ADR-060 — The AI wizard is for later; the groundwork is now
**Status:** Accepted (user, 2026-10-16)
**Decision:**
- **The future feature: an AI wizard.**
  - An interactive interview, with answers as buttons or text. It asks about the event, follows
    up where something is missing or unclear, and moves area by area.
  - It works for new events and to edit existing ones (quests, translations).
  - At the end it lists every change ("adding this, editing this, deleting this"). The organizer
    approves all, picks some, or goes back to the conversation.
  - The AI provider is undecided (OpenAI, Google or Anthropic).
- **Groundwork in v1:**
  - every dashboard action is also a validated API operation;
  - edits can be grouped into **change sets** that are reviewed item by item and applied in part
    or in full (F-197).

**Why:** it lets the AI wizard arrive without rebuilding the dashboard, and keeps the choice of
AI provider open. It also matches the agent-first principle: an agent can do anything a user can.

## ADR-061 — Branding in the adventure theme: logo and banner only
**Status:** Accepted (user, 2026-10-16). Answers Q-059. **Widened by ADR-085:** one accent color from a
curated palette.
**Decision:**
- In the adventure theme, an organizer brands an event with their **logo** and an **event
  banner**. Currency name and icon (F-24) and renamed words (ADR-058) were already decided.
- No colors or other visual settings.
- More customization, such as accent colors, comes only with future **themes**. Whether and
  which themes is a later decision.
- The user wasn't sure even logo and banner belong in v1, so they are a Should.

**Consequence for Stage 6:** the design tokens should be organized so a second theme can be added
later without rewriting screens.

## ADR-062 — Scale: 50,000+ players in one event
**Status:** Accepted (user, 2026-10-16). Answers Q-064 in part; the number of events at once is
still open.
**Decision:** plan for single events of **50,000+ players**, at festival and Riyadh Season-zone
scale (Beast Land: 82,000 players over 45 days).
**Consequences:**
- The live ranking, the scan path and the big screen must handle bursts, e.g. 20,000 scans
  within a minute after a keynote reveals a code.
- Push sends must handle the whole event at once.

These become performance requirements (NFRs) in the SRS and shape Stage 6.

## ADR-063 — Live edits with explicit choices; confirmations everywhere
**Status:** Accepted (user, 2026-10-16). Extends F-123.
**Decision:**
- **Organizers can change a live event.**
  - Editing a quest's points asks: apply to **future completions only**, or **also to past
    completions**.
  - Deleting a quest people already completed asks whether to **keep** or **remove** the points
    they earned.
  - Every adjustment is a new entry in the points record, never an overwrite (F-110).
- **Product-wide rule:** every consequential action, in the dashboard and in the app, opens a
  screen that explains exactly what will happen and how. The person confirms after reading.
  This covers deleting, edits that affect players, removing points, cancelling and logging out.

**Why:** organizers must be able to fix mistakes on the day. Players must never lose points
because of a click nobody understood.
**Note:** a retroactive change after rank prizes were handed over doesn't take prizes back; the
confirmation screen says so.

## ADR-064 — v1 billing by invoice
**Status:** Accepted (user, 2026-10-16). Implements ADR-022 for v1. **Amended by ADR-076:** the
platform holds no prices or invoices; activation paths and limits are in ADR-076.
**Decision:**
1. The organizer requests an event and picks its size.
2. Questify sends an invoice, paid by bank transfer.
3. Questify activates the event when paid.

There is no online payment in v1. Prices and sizes are set in Stage 3.

## ADR-065 — Messaging channels and rules
**Status:** Accepted (user, 2026-10-16). Accepts PD-24 with one change: promotional SMS is allowed
in v1.
**Decision:**
- **Push** carries personal and event messages, with a notification center in the app. Pushes
  have no daily cap, and there are no automatic prayer-time or quiet-hour pauses.
- **Organizer announcements** go by push and in the app.
- **Questify's promotional messages** go to opted-in players (F-140) by push, email and SMS.
- **Login codes and operator invites** go by SMS from the "Questify" service sender, or by
  email.

**Claude recommended:**
- a default cap of 6 broadcast pushes per player per day;
- automatic pauses at prayer times for the event's city, plus night-time quiet hours;
- promotional messages by push and email only.

**Costs accepted:**
- Notification overload is the top complaint about Whova (72% negative of 113 reviews). Players
  who feel spammed mute or uninstall.
- Untimed pushes during prayer may feel out of place at Saudi events.

**Required for promotional SMS (Saudi rules, CST):**
- no promotional messages 22:00–09:00 Saudi time (01:00–12:00 in Ramadan); an opt-out takes effect
  within 24 hours (FR-1738);
- a promotional sender registered separately from the service sender, with the "-AD" suffix;
- the player's opt-in recorded with its date and channel;
- a working opt-out in every message and in the app;
- a per-message cost.

The provider question is Q-034.
**Revisit if:** pilot players mute or uninstall over notifications. The cap and the prayer pause
are the first fixes.

## ADR-066 — Analytics scope for v1
**Status:** Accepted (user, 2026-10-16). Answers Q-056 by dropping the metrics it asked about.
**Decision:**
- **The dashboard covers:**
  - participation;
  - quests and categories;
  - rewards and economy;
  - survey results;
  - optional quest ratings.
- **Out of the dashboard:** average time spent and the traffic heatmap. They would need presence
  data the app doesn't collect (no background location, PD-09).
- **Reports:** spreadsheet exports plus a one-page PDF report.
- Comparison with past events and a cross-event benchmark are not in v1.

## ADR-067 — Sponsors in v1: organizer-managed profiles, no data shared
**Status:** Accepted (user, 2026-10-16)
**Decision:**
- Organizers create sponsor profiles (name, logo, tier, booth) and tag quests, categories,
  rewards and souvenirs to them.
- Sponsors can be shown as:
  - **presented-by categories**;
  - a **sponsor strip on Home**.
- Sponsors have no login, no report link and no access to player data. The organizer reports to
  them with analytics and exports filtered by sponsor.
- No lead sharing in v1.

**Why:**
- It gives organizers something to sell to sponsors from day one.
- No player data leaves the organizer.

**Revisit:** consent-based lead sharing is what B2B exhibitors pay for most. It is the first
sponsor feature to reconsider after launch.

## ADR-068 — Running the platform: onboarding, support and safety
**Status:** Accepted (user, 2026-10-16). Accepts PD-11 for the content v1 actually has.
**Decision:**
- **Organizers sign up freely and draft events.** Publishing needs Questify's activation after
  the invoice is paid; that activation is the approval.
- **One platform-admin role** in the Questify console, with every action logged.
- **Support can open and edit any organizer's event.** Every access and change is logged and
  visible to the organizer.
  - Claude recommended read-only access; the user chose full edit for faster help on event day.
- **Safety tools:**
  - report any player, nickname or content;
  - Arabic and English nickname filter;
  - block a player;
  - a platform-wide ban, applied by a person with a reason and an email appeal.
- **User content in v1:**
  - nicknames;
  - photo-wall photos (consented and approved);
  - private submissions (organizer-only).
  - Together with reporting and unpublishing organizer content (PD-29 as narrowed in ADR-073),
    this covers Apple 1.2 and Google's user-content policy for this scope. A public feed would
    need more (ADR-023).

**Cost noted:** full support edit means a support mistake can change a live event. The log and
the organizer's visibility of it are the safeguard.

## ADR-069 — v1 ships everything prioritized, except video
**Status:** Accepted (user, 2026-10-16). Claude recommended a pilot release of the Musts first.
**Decision:**
- The first public release contains every feature prioritized in `FEATURES.md`: Must, Should
  and Could.
- **The one exception:** video submissions (F-89), deferred to a later update.
- Priorities set the build order inside v1. Any later cut starts from the bottom, and the user
  decides it.
- The boundary is in `SCOPE.md`.
- No pilot event is scheduled yet (Q-022).

**Costs accepted:**
- The longest build before any real event shows what players actually use.
- The heaviest Shoulds stay in v1: 3–5 mini-games, NFC, the gem shop and extra characters,
  promotional SMS.
- Google's 14-day closed test with 12+ testers (ADR-010) still has to run before the Android
  public release. It could be timed as a soft pilot.

## ADR-070 — Player data is hosted inside Saudi Arabia
**Status:** Accepted (user, 2026-10-17). Answers PD-26 and Q-032.
**Decision:** Personal data is stored and processed in Saudi Arabia. Every vendor that receives
player data (SMS, email, push, analytics, crash reports) goes into the data map, and any transfer
abroad is documented.
**Why:**
- It's the simplest PDPL position.
- It's a selling point to government and corporate organizers.
- It suits the broad player database (ADR-047).

**Consequence for Stage 6:** this narrows the backend, database and vendor choices (Q-031, Q-034).
Each candidate is checked for a Saudi region.

## ADR-071 — No AI moderation in v1
**Status:** Accepted (user, 2026-10-17). Answers Q-045; PD-18 applies only when AI is added.
**Decision:**
- Submissions are reviewed by people: the review queue, with optional auto-approve (ADR-042).
- Nicknames and text are checked against Arabic and English word lists.
- Nothing is sent to a third-party AI service.

**Revisit if:** review queues overflow at large events. Adding an external AI then requires PD-18's
disclosure and permission screen.

## ADR-072 — Location while the app is open, never in the background
**Status:** Accepted (user, 2026-10-17). Accepts PD-09, widened. PD-09 proposed location only during
a location quest. **Confirmed (user, 2026-10-21, Q-087):** whenever the app is open, not only during a location quest.
**Decision:**
- With the player's permission ("While using the app"), the app reads location whenever it is
  open. It never reads location in the background.
- Location powers:
  - location check-in quests (F-86);
  - the "far from the venue" fair-play flag (F-114).
- Refusing blocks nothing (ADR-015).

**Note for Stage 6:**
- Use approximate location unless a location quest needs precise location.
- Declare location in the store privacy labels as linked to the user, since it's stored for flags.

## ADR-073 — Compliance review: the last decisions
**Status:** Accepted (user, 2026-10-17). Closes the review of `STORE_COMPLIANCE.md` §6.
**Decision:**
- **PD-29, narrowed:**
  - no automatic filter on organizer content;
  - players report it (F-220);
  - Questify reviews reports and can unpublish any quest, text or image.
  - Claude pushed back once on "no checks at all"; the user chose this minimum.
- **PD-28, replaced:**
  - the App Store and Google Play declarations (age rating, privacy labels, data safety) always
    describe **every feature as switched on**;
  - switching a feature off never makes a declaration wrong, so the console checklist (F-225)
    is dropped.
  - A **new** capability still means updating the declarations, but it comes with a store
    release anyway (ADR-007).
- **PD-03 and PD-04, accepted in the user's words:**
  - without a store release, Questify only switches existing features on or off and changes
    content, settings, copy and styling;
  - a disabled feature is hidden, as if it weren't there;
  - nothing new is ever added by download.
- **Also accepted:**
  - PD-07 (auto-written official rules);
  - PD-10 (system photo picker);
  - PD-13 (votes never on looks);
  - PD-15 (store category not Games);
  - PD-16 (account deletion in the app and on the web);
  - PD-17 (what the organizer receives, shown before joining);
  - PD-25 (Arabic first for Saudi-facing text);
  - PD-27 (no ad networks or tracking SDKs).

## ADR-074 — Quality targets for v1
**Status:** Accepted (user, 2026-10-17). All four were Claude's recommendations.
**Decision:**
- **Availability:** 99.9% a month for the player service, dashboard, staff mode and big screen.
  Maintenance is planned outside live-event hours.
- **Devices:** iOS 16+ and Android 9+, phones and tablets. Animations degrade gracefully on
  low-end phones.
- **Peak burst:** 20,000 quest completions within one minute in one event. 95% of completions
  are confirmed within 1 second, even at that peak.
- **Live ranking:** reflects changes within 5 seconds, in the app and on the big screen.

These become NFR-002 to NFR-008 in `SRS.md`.

## ADR-075 — Gaps closed while writing the SRS
**Status:** Accepted (user, 2026-10-17) for the four questions below. The other rules apply
earlier decisions and are listed in `SRS.md` §1.16 (FR-1601 to FR-1629).
**User decisions:**
- **Votes:** options written by the organizer (text or the organizer's own images). Player
  submissions never become vote options. Claude recommended consented submissions as options.
- **A second sign-in identifier:** any account can add a verified email or +966 number and sign
  in with either. This makes the company-email lock (F-80) work for phone accounts.
- **Age:** the year-based rule. Current year − birth year ≥ 13 is allowed.
- **Balance:** removing points after a player spent them lowers the balance to zero, never
  below. The points record still shows the full removal. Claude recommended allowing a negative
  balance.

**Retired:** FR-253 (pausing flash quests at prayer times), because the user chose no
prayer-time pauses in ADR-065. That later answer explicitly covered flash drops.
**Left to Stage 6:** tuning values with sensible defaults (Q-074).

## ADR-076 — Commercial model on the platform: activation, limits and add-ons
**Status:** Accepted (user, 2026-10-17). From the Stage 1 review. Amends ADR-064. Closes review item
D2 and part of D7.
**Decision:**
- **Who sells:** an existing company of the user's sells Questify.
- **Outside the platform:** pricing, invoicing and payment. The platform holds no prices,
  invoices, VAT or company data.
- **Three ways an event is activated:**
  1. the owner taps **Request activation** in the dashboard;
  2. a Questify admin activates any event directly;
  3. Questify builds the event for the organizer (managed service, ADR-077).
- **At activation, the admin sets:**
  - a **hard limit** (joining stops at the paid size), a **soft limit** (owner and Questify
    warned at 80% and 100%, joining never blocked), or **no limit**;
  - the **add-ons** the event bought. Organizers see only the switches that were unlocked.
- **The Questify console shows usage** per event and organizer: login SMS, promotional SMS and
  email, push volume, players, storage.

**Why:**
- The user wants commerce kept off the platform for now.
- Limits and add-ons still let them sell sizes and packages without any payment code.

## ADR-077 — Organizer team powers and managed events
**Status:** Accepted (user, 2026-10-17). From the Stage 1 review (D9). Refines ADR-059.
**Decision:**
- **Editors run everything about events**:
  - building them;
  - operators, caps and exclusions;
  - removing awards, banning players, pausing redemption;
  - the live control room.
- **Owner only:**
  - the team (adding and removing editors);
  - activation requests;
  - ownership transfer;
  - deleting the organizer account.
- **The owner can limit an editor to chosen events,** so agencies keep clients apart. By default
  editors see all events.
- **Managed events** are built by Questify inside the client's own organizer account. Questify
  then invites the client as owner and hands over through an ownership transfer. Support access
  stays logged (ADR-068).

## ADR-078 — Sign-in for the dashboard and the Questify console
**Status:** Accepted (user, 2026-10-17). From the Stage 1 review (D23). Claude recommended an
authenticator app for platform admins.
**Decision:**
- Owners, editors and Questify platform admins sign in with **email + password + a one-time code
  sent by email**.
- Sessions expire after inactivity.
- The player app keeps phone or email code sign-in (ADR-030).

**Risk accepted:**
- Whoever controls an admin's mailbox can reset the password and receive the code.
- A Questify admin can edit every organizer's event (ADR-068), so one compromised admin mailbox
  exposes the whole platform.
- **Revisit before launch** if the admin team grows or handles enterprise clients.

## ADR-079 — Running Questify: support, alerts, response times, content, terms
**Status:** Accepted (user, 2026-10-17). From the Stage 1 review (D25 and the owner-side grilling).
**Decision:**
- **Support is outside the platform:** a WhatsApp hotline, an email address and a phone number.
  - The dashboard and app show these three details.
  - Platform admins edit them in the console, with no release needed.
- **Email alerts to organizers,** each type switchable per team member:
  - event activated;
  - stock or codes running low;
  - new flags;
  - content unpublished by Questify;
  - Questify support opened the event;
  - size limit at 80% and 100%.
- **Reports** (usernames, organizer content, players) are handled within **24 hours**, and
  within **1 hour** while the event is live. Live-event reports are marked urgent in the console
  and alert the team.
- **The Questify team** is 3 or more people at launch, sharing **one admin role** (ADR-068 stands;
  Claude suggested two roles). Every action is logged.
- **Daily challenge questions** are written by the team, by hand.
  - The console warns when fewer than 7 days are queued.
  - A day without questions has no challenge; the streak still counts any Questify activity.
- **Organizer terms:**
  - organizer terms, a data processing agreement and the content rules are accepted by
    click-through at sign-up;
  - the version and time are logged;
  - changes need re-acceptance.

## ADR-080 — Rehearsal mode before go-live
**Status:** Accepted (user, 2026-10-17). From the Stage 1 review (D6). Replaces the Area 10 Won't on
test players.
**Decision:**
- Before an event goes live, the organizer's own team (owner, editors, operators) can join a
  Draft or Scheduled event on real phones:
  - scan the real printed QR codes and NFC tags;
  - use stations and the prize desk;
  - open the big screen.
- Everything done in rehearsal is wiped at go-live.
- No one outside the team can join.

**Why:**
- Misprinted codes are found before attendees find them.
- Prospects can try their own event before paying.

## ADR-081 — Storefronts: Saudi Arabia and the GCC
**Status:** Accepted (user, 2026-10-17). **Superseded by ADR-092 the same day.** From the Stage 1 review (D1). Widens ADR-014. Claude
recommended every storefront except the EU.
**Decision:** at launch the app is available in the Saudi Arabia, UAE, Kuwait, Qatar, Bahrain and
Oman storefronts.
**Cost accepted:**
- Visitors whose Apple ID or Google account belongs to another country can't install the app at
  Saudi events. That includes many tourists and expats.
- Widening later needs no new build.

## ADR-082 — Capacity and recovery targets
**Status:** Accepted (user, 2026-10-17). Answers the rest of Q-064 (D28).
**Decision:**
- **Peak load:** up to **10 live events at once**, about **100,000 players** live across all of
  them, on top of the single-event targets in ADR-062 and ADR-074.
- **Backups:** at most **5 minutes** of data lost (point-in-time recovery).
- **Recovery:** service back within **1 hour**.
- A restore is rehearsed before launch.

## ADR-083 — Game rules settled in the Stage 1 review
**Status:** Accepted (user, 2026-10-17). Items D3, D8, D13–D16 and D26–D27.
**Decision:**
- **Online-only everywhere** stays (ADR-029), including operator devices. Claude recommended a
  queue on staff devices only.
- **Celebration in two steps:**
  1. within 300 ms of a scan, a short "Scanned! checking…" beat (sound, buzz, spinning coin);
  2. the full +points celebration when the server confirms.

  A celebration never has to be taken back.
- **Winners are confirmed by the organizer before the reveal.** The dashboard shows the top
  ranks with any open flags. Confirming freezes the prize ranking.
- **Prize pickup:**
  - one prize desk per event, with location and opening hours shown on every reservation;
  - after the desk's last opening hours, physical rewards can't be reserved;
  - digital codes stay redeemable until the shop window closes;
  - rank-prize winners get a push with their claim deadline.
- **The event day:**
  - the organizer sets when it starts, default 4:00 am in the event's time zone;
  - today's ranking, daily categories and streaks use it.
- **The event streak** counts consecutive **event days**. Days the event is closed don't break it.
- **Questify XP:**
  - every quest gives the same hidden amount, on its **first completion only**;
  - repeats and refreshes give event points but no XP;
  - difficulty-based XP and XP on repeats are platform settings the Questify team can switch on
    later. The Questify team configures platform rules as organizers configure events.
- **The ten SRS defaults** (FR-1607, FR-1415, FR-1602, FR-213, FR-252, FR-1610, FR-1616,
  FR-1618, FR-1625, FR-139) are accepted.
- **Not in v1:** streak freeze, "most improved", live completion counts, Ramadan and
  national-day templates, ticket-number checks, Hijri dates, the parallel-session rule,
  Saudi-dialect celebration copy, a Resal prize bundle, finale prize sponsors and ranking naming.
- Teams (ADR-025) and lead sharing (ADR-067) stay out.

## ADR-084 — Identity rules: usernames, duplicates, deletion, minors
**Status:** Accepted (user, 2026-10-17). Items D5, D18, D19, D21. Changes ADR-032's nickname to a
username.
**Decision:**
- **Usernames:**
  - the nickname becomes a **username**: a strictly unique gamer tag, shown as **@username** on
    the profile;
  - whether players may change it is a platform setting for the Questify team;
  - previous usernames are always kept in the history.
- **Leaving an event:** a player can leave. They stop playing it and stop its pushes. The
  organizer keeps what the join card disclosed.
- **Duplicate accounts:** two accounts that play the same event from the same device are
  flagged for the organizer (flags only, ADR-041).
- **Deleting and signing up again:**
  - the account and its data are deleted (PD-16);
  - a one-way fingerprint of the phone or email is kept, so event bans and one-time rewards
    (the welcome reward) still apply after a re-sign-up;
  - nothing personal can be read from the fingerprint.
- **Players aged 13–17** use the app exactly like adults. Claude pushed back once on
  promotional messages: under PDPL a minor may lack the capacity to consent. The user kept "no
  difference", and the risk goes to counsel with Q-042.
- **Not in v1:** signing out other devices, and re-checking before redeeming.

## ADR-085 — Organizer tools from the Stage 1 review
**Status:** Accepted (user, 2026-10-17). Items D4, D10–D12, D17, D20, D24, D25.
**Decision:**
- **Audience targeting:** a category or reward can be limited to players whose join field (e.g.
  section, ticket type, department) or guest-list tag matches. It serves women-only and family
  sections, VIP and corporate needs.
- **Branding:** one accent color per event, from a curated palette that fits the adventure art.
- **Submissions:** the organizer chooses per quest whether a rejected submission can be resent.
  A submission approved after the event ends adds to score and rank, and to the balance only
  while the shop window is open.
- **Operations:**
  - bulk or compensation awards (logged, outside operator caps);
  - regenerating a quest QR (the old code stops working at once);
  - batch single-use operator QRs with ability presets.
  - Not picked: operator auto-expiry, the live operator list.
- **The whole dashboard works on a phone browser.**
- **Accessibility:** no target in v1, by the user's choice. Reduce-motion stays as a performance
  fallback (NFR-009). Claude noted that adding accessibility later costs more than designing it
  in.

## ADR-086 — Reuse check: what we integrate, what we build
**Status:** Accepted (user, 2026-10-17). Stage 2. Narrows Q-031; the exact vendors are picked in
Stage 6.
**Research (2026-10-17):**
- **Supabase:** the managed cloud has no Middle East region, so it can't meet ADR-070. Self-hosting
  is possible, but the backups, point-in-time restore and high availability become ours to run.
- **Clouds live inside Saudi Arabia:**
  - Google Cloud Dammam (bought through CNTXT, with invoiced billing);
  - Oracle Jeddah and Riyadh (each a single availability domain);
  - Huawei, Alibaba (SCCC) and Tencent.
  - AWS and Azure are announced but not live. Microsoft states November 2026.
- **Open-source gamification engines** (ActiDoo, Oasis and newer projects) are old or thin, and none
  fits Questify's model.
- **Novu** is mature and self-hostable, but needs MongoDB, Redis and workers.

**Decision:**

| Piece | Call | How |
|---|---|---|
| Backend (accounts, database, real-time, files) | **Reuse components** | A managed PostgreSQL in a live Saudi region, which gives managed backups and 5-minute restore (ADR-082), plus our own API using mature open-source libraries for sign-in, real-time updates and storage |
| Game logic (quests, categories, verification, points record, XP, shop, rankings) | **Build** | It is the product. Reuse an in-memory sorted-set store (e.g. Redis) for the live rankings |
| Notifications (push, SMS, email, notification center, mute, schedules, campaigns) | **Build a thin layer** | A notification table, scheduled jobs and three provider connections (Apple/Google push, a Saudi SMS provider, email). The CST and consent rules live in our code |
| Animation, QR/NFC, admin-panel UI | **Reuse components** | Rive or Lottie players, the platforms' QR and NFC libraries, an open-source admin-panel framework. Picked in Stage 6 |

**Why:**
- One developer, 99.9% availability and 5-minute recovery favor managed infrastructure inside
  the Kingdom over self-hosted platforms.
- What makes Questify different is built in-house; everything else is reused.

## ADR-087 — Business decisions (Stage 3)
**Status:** Accepted (user, 2026-10-17). Claude's recommendations were taken, except as noted.
**Decision:**
- **First customer:** event organizers and agencies.
- **North-star metric:** activated players per event (joined players who complete a quest).
- **Pricing shape:** per event by player-size tier (300 / 1,000 / 5,000 / 20,000 / custom) plus
  add-ons. Prices are set outside the platform (ADR-076).
- **Riskiest assumption:** players will install a new app to play an event. It is tested by
  activation and install-to-first-coin at the first events (`METRICS.md`).
- **Beachhead:** the founder's own network, then festivals and exhibitions.
- **Channels:** direct outreach and demos; event agencies as resellers.
- **Outside the platform:** anything Questify supplies physically or as a service (devices,
  screens, gifts, staff) is dealt with and paid for separately. The platform and these documents
  do not model it. Which features become paid add-ons is the user's call, made outside the
  platform; the platform can gate any of them.

## ADR-088 — UX review decisions
**Status:** Accepted (user, 2026-10-17). From the review of the Stage 4 UX plan.
**Decision:**
- **Layouts (player app):** Event Home as one stack with Up next first; Quests as an accordion;
  quest details as a bottom sheet; ranking as a card on Home that opens full screen; center
  button opens the camera with a Scan | My QR toggle; Rewards with balance on top and a grid;
  Profile with identity on top and rows; joining with the join card first and sign-in at the first
  reward.
- **Operator mode:** approved as drafted, with these changes:
  - Handed over has a 10-second Undo;
  - a banned player's reserved items are held for the owner to release;
  - every result screen stays until the next scan or a tap.
- **Organizer dashboard:**
  - at least one of Arabic or English is required to save (Claude recommended both);
  - activation can be requested at any time;
  - two editors on one quest: last save wins, with the change log as the only safety net
    (Claude recommended a differences screen; **risk accepted:** an overwritten edit can be lost
    and must be restored by hand from the log);
  - phone navigation is a top bar with a sideways section strip.
- **Theme:** all UX files are theme-agnostic; the visual theme may change completely.

## ADR-089 — Sign-in happens at the Join tap
**Status:** Accepted (user, 2026-10-17). Refines ADR-031; chosen in the player-app UX review.
**Decision:**
- Anyone can browse public events, an event's preview, quests and prizes without an account.
- Tapping **Join** on the join card asks for sign-in (phone or email code, then username, avatar
  and birth year for new players). The event is joined, and the consent on the join card
  recorded, only after sign-in succeeds.
- Closing the sign-in screen joins nothing.
- **Up next** (event Home) shows the quest the organizer pinned as the current focus; with none
  pinned, the open quest with the best points for its estimated time.
- Locked quests stay visible in the list with a line saying what unlocks them. Hidden categories
  are not shown.

**Why:** the join card tells the player what the organizer will receive. That statement needs an
account to attach to; ADR-031's "sign-in at the first reward" left a consent with no identity.
**Cost:** one form before the Home screen instead of after the first tap on Go; still within
the 3-minute first-coin target (ADR-098).

## ADR-090 — Flexible layout and a guided setup wizard
**Status:** Accepted (user, 2026-10-17), in the player-app UX review.
**Decision:**
- **Flexible layout:** the Questify team can reorder, hide, rename and re-icon the items of every
  bar, the Profile rows and the Home sections, as data, without a release. This fits ADR-007: the
  app ships all screens, and configuration only chooses what shows and in which order.
- **Guardrails:** the scanner / My QR button, Settings and legal (which holds account deletion,
  PD-16), and Home can never be hidden, and a bar has at most five slots.
- **Guided setup wizard** for organizers (`ux/ONBOARDING_WIZARD.md`):
  - an interview of explained option cards, each with what players will see and what it needs
    (for example, NFC needs physical tags);
  - every step and the whole wizard can be skipped;
  - choices become real settings and can be changed later;
  - a sponsors step shows where sponsors would appear, with Add or Skip.
- The wizard is rule-based. The AI wizard (ADR-060) remains a later addition and will use the same
  operations.

**Settled the same day:** the Questify team defines approved layout presets and organizers pick one per event (F-276).

## ADR-091 — Wallet passes with a fixed ID code
**Status:** Accepted (user, 2026-10-17). Amends ADR-040; research: `research/WALLET_PASSES.md`.
**Decision:**
- Players can add an event pass to **Apple Wallet and Google Wallet**. It carries the Questify
  frame with the event's logo and name, dates, @username, score, balance, level, rank and the
  last-updated time.
- The pass holds a **fixed ID code**, unique per player per event, on both wallets. No rotating
  code. Stations, kiosks and the prize desk accept it like My QR, and the result screen shows the
  username so the operator can compare it with the person.
- The in-app My QR still rotates every 30 seconds.
- The server stays the truth: the pass is a copy, can be updated, and the code can be revoked.
- Added from the app in v1; adding from a web page waits.

**Claude recommended:** a pass for information only, with the secure rotating My QR kept for
staffed quests. The user chose a full wallet identity and accepted the risk.
**Risk accepted:**
- A screenshot of a pass can be shown by someone else. Operators see the username; the existing
  flags (the same code at two stations too close in time) and the revocable code are the only
  controls (ADR-041).
- Apple does not guarantee that updates arrive.
- Pass data is stored in the player's Apple or Google account, outside Saudi Arabia (ADR-070).
  The pass holds no phone, email or birth year. A line says so before adding. Counsel to review
  (Q-043).
**User statements (2026-10-17):** Apple allows an organizer's logo on the pass, and the lawyer accepts pass data stored in Apple and Google accounts abroad. Neither was checked independently (Q-076, Q-043).

## ADR-092 — Storefronts: everywhere except the EU
**Status:** Accepted (user, 2026-10-17). Supersedes ADR-081; widens ADR-014.
**Decision:** at launch the app is available in every country's storefront on both stores, except
the European Union's.
**Why:**
- Foreigners at Saudi events (tourists, expats with foreign Apple IDs) can install the app.
- Excluding the EU keeps the personal trader details of the individual developer account
  (ADR-010) off EU product pages.

**Consequences:**
- Players outside the Kingdom sign in with email (ADR-030).
- Nothing outside the EU is checked yet for local rules on content, prizes or data; Saudi rules
  are the only ones planned (PDPL, Ministry of Commerce, CST).
- Each storefront the app is listed in sets its own age-rating and legal expectations in the
  stores' forms (to review in Stage 8).

## ADR-093 — Questify admin controls in v1, and the risks left in
**Status:** Accepted (user, 2026-10-17). Extends ADR-090.
**Decision, in v1:**
- **Translation matrix:** every text in the app as key, Arabic, English; edited at any time and
  live without a release; shipped defaults are the fallback; placeholders are protected (F-277).
- **Off switch for any feature,** platform-wide (F-278).
- **Tuning numbers** (F-279) and **maintenance mode** (F-280).
- **A banner to all players** (F-281).
- **Items, achievements and gem prices** stay editable in the console (F-216).

**Not in v1 (the user's choice):** theme settings as data, choosing celebration animations,
editing intro cards and mascot lines, gradual rollout, seasonal campaigns, per-country settings,
draft/preview/publish, versions with rollback, and A/B tests. The last-working configuration on
the phone was added afterwards (ADR-094).

**Risk accepted:** with no draft or rollback, a bad save (a wrong text, a
hidden bar item, a wrong threshold) goes live to every player at once and can only be fixed by
editing it again. (The app-side risk of an unreadable configuration was removed by ADR-094.)
**What still limits the damage:** every change is written to the admin log (FR-1409); a protected
set of bar items cannot be hidden (FR-1750); placeholders in texts cannot be removed (FR-1767);
texts and numbers are validated on save.

## ADR-094 — More admin tools, and a last-working configuration
**Status:** Accepted (user, 2026-10-17). Extends ADR-093.
**Decision, added to v1:**
- **Safety:** the app keeps its last working configuration and uses it if a new one cannot be
  read (F-282). Claude recommended this one tool; the user accepted it. Draft/publish, rollback and
  A/B tests stay out.
- **Player tools:** find a player and view their record (read-only, logged); fix an account
  (change a username, reset sign-in, merge a phone and an email account); push to a group; handle
  a legal data request (export or delete).
- **Message and filter tools:** edit the word lists; edit SMS, email and push templates (the CST
  rules are enforced when saving); edit legal documents as versions with forced re-acceptance;
  edit help and FAQ content.
- **Operations:** a platform health view; organizer account tools; admin accounts and sessions;
  Questify-wide ranking seasons.
- **Left out on purpose:** restoring an account after the player deleted it. The stores require
  real deletion and Google forbids freezing (PD-16); the fingerprint kept for bans (ADR-084) is
  not a restore path.

**Consequence:** the Questify console now holds many powers (see F-216, F-257 to F-264, F-277 to
F-294). Admin sign-in is email, password and an email code (ADR-078), and one admin role (ADR-079),
so a compromised admin mailbox can do all of it. That risk was accepted in ADR-078 and is larger now. The user considers email, password and a code "very safe" (2026-10-17), so ADR-078 stands.

## ADR-095 — Sessions, workshops and activities with registration
**Status:** Accepted (user, 2026-10-17). Extends ADR-056 and replaces its "no bookmarks, reminders
or personal schedule".
**Decision:**
- A session has a type (talk, workshop, activity), time, place, speaker names and a description.
- **The organizer chooses per session:** open to anyone, or registration required with a seat
  limit and a closing time. When full, the app shows Full. There is no waitlist (Claude
  recommended one).
- Registration is **free**. No prices or payments (ADR-002, PD-22). When ticketing is added later,
  the registration record is where it connects.
- Players get **My sessions**, a reminder push before a registered session, and a warning (not a
  block) for overlapping registrations.
- **Check in** at the door by operator scan of My QR or the wallet pass; counted as attendance with
  optional points.
- Organizers get a spreadsheet import (sessions only), an attendance and no-show report, live
  opening and closing of registration, and a push to everyone registered for a session.

**Left out on purpose:** speaker profiles, session ratings, networking, seat maps, selling tickets.

## ADR-096 — Player onboarding
**Status:** Accepted (user, 2026-10-17). Replaces the earlier three-card mascot intro (F-82).
**Decision:**
- **First organic launch:** a language choice, then **four story cards** with the mascot and
  animation (join, quests, points and ranking, prizes and profile), skippable at any moment, ending
  with Scan an event QR and Explore events. No permission is asked and no data collected.
- **From a join QR or link:** the player sees the event preview and joins first, then the full
  intro with a Skip button (once per install), then Home. Claude recommended skipping the intro on
  this path to protect the first-coin time; the user chose to show it. **Cost:** up to about 15
  seconds before the first coin unless skipped.
- **Replay** from Settings. **Content** through the translation matrix and layout controls.
- **Not chosen:** the interactive practice quest, the video, first-visit tips on every screen,
  and organizer-written welcome tips.

## ADR-097 — Mini-games: which, where and how
**Status:** Accepted (user, 2026-10-17). Specifies ADR-035.
**Decision:**
- **Five games in all:** four organizer quest types (memory match, slide puzzle, catch, tap rush)
  and the **daily word** on Questify home. Stack tower and pattern repeat were cut to stay within the
  3 to 5 limit (the user first picked six, then took Claude's advice to drop one).
- **Where:** a mini-game is a quest type inside a category; the quest sheet's button is Play. The
  daily word is on Questify home only, not an organizer quest type.
- **Reward:** points for passing the organizer's target (easy, medium or hard) on the first pass. No
  scaling by score and no game ranking.
- **Attempts:** one by default, changeable by the organizer.
- **Checking:** the server issues each round with a seed and start time and replays the phone's
  inputs. A reported score is never trusted. A failed result send can be retried for ten minutes.
- **Branding:** organizer images can appear on cards, puzzles and falling items.
- **Daily word:** one word a day for everyone, six guesses, feedback by position, in Arabic and
  English, using a word bank the Questify team writes; counts for the daily streak and XP.

**Cost:** each game still needs its own design, art, tuning and testing, and a new game is a store
release (ADR-007). Arabic letter shaping in the daily word needs careful testing.

## ADR-098 — First-coin target: 3 minutes from the first scan, install included
**Status:** Accepted (user, 2026-10-17). From the Stage 5 pressure-test. Replaces the 60-second
target.
**Decision:** a new player should reach their first coin (the first quest completed, with the
points shown) in under **3 minutes from the first scan, install included**. The time to download
and install is also reported separately in the metrics.
**Why:** 60 seconds from the first scan cannot hold on a congested venue network once the download,
sign-in code and intro are counted. Claude recommended 90 seconds from the first app open; the user
chose the whole-journey measure.
**Consequence:** the target now depends on the venue's network, so the install-size budget
(NFR-028) and the first-download size matter more.

## ADR-099 — Content cadence and SMS cost (Stage 5)
**Status:** Accepted (user, 2026-10-17).
**Decision:**
- **Challenge cadence:** the daily challenge and the daily word run **weekly at launch**, and the
  Questify team switches them to daily when players use the app on days with no event (F-316). The
  daily streak still counts any Questify activity (ADR-045).
- **Login SMS cost:** Questify absorbs it and watches it in the usage view (F-258). There is no
  per-event allowance or cap. Claude recommended an allowance per size tier with email after it ran
  out.
**Risk accepted:** the SMS bill grows with players, not with what an organizer pays. A single large
event can cost more in SMS than it earns. The only brakes are the per-player resend limit (FR-110),
the email fallback (FR-1812) and the usage view. Price per SMS is still unknown (Q-034).

## ADR-100 — An open flag holds a prize handover
**Status:** Accepted (user, 2026-10-17). From the Stage 5 pressure-test. Narrow exception to ADR-041.
**Decision:** while a player has an open flag, the prize desk holds their reserved items ("Held,
ask the owner") until an owner or editor clears the flag or bans the player. The organizer can turn
the hold off per event. Nothing is removed and no points change: it is a pause until a person looks.
**Why:** with flags only, a cheater could take real prizes before anyone read the flag. The hold
keeps "people decide" without letting the prize leave first.
**Cost:** a wrongly flagged honest player waits at the desk until the owner clears the flag; the
hold depends on someone watching the Inbox on event day.

## ADR-101 — Framework: Expo (React Native) with TypeScript
**Status:** Accepted (user, 2026-10-17). Answers Q-030. Stage 6.
**Research (2026-10-17):**
- Expo's own docs: EAS Build runs iOS builds on Expo's cloud Macs and EAS Submit uploads to App Store
  Connect from Windows or Linux, so no Mac is needed to ship. Free plan: 15 iOS and 15 Android builds a
  month in a low-priority queue; Starter $19 a month, Production $199 a month.
- Flutter's own docs: Flutter web draws on a canvas, is "not suitable" for text-rich or SEO content,
  and its WebAssembly mode cannot run on iPhone browsers. Flutter iOS builds from Windows need a
  separate cloud-Mac service (Codemagic, Odevio).
- React Native needs an app restart when the layout direction changes (Arabic ↔ English inside the
  app); Flutter switches live. Flutter's Impeller engine had Arabic glyph and RTL-icon bugs in 2023–24,
  mostly fixed.
- NFC read/write works in both; the React Native library needs a development build, not Expo Go.
  Rive runs in both. Flutter's Flame is a better game engine, but the mini-games are small.
**Decision:** The player app (iOS and Android, and a web build as a bonus) is built with Expo and
TypeScript, in a monorepo with the web app and the server.
**Why:** It is the only option that fits a Windows machine, one app for both phones, a real-HTML web
version and a single language across app, dashboard and server (one developer with Claude).
**Alternatives rejected:** Flutter (the closest call: smoother animation and live RTL, but a weak web
version, a second cloud-build tool and a second language); Kotlin Multiplatform (weakest web and
Windows-to-iPhone path); two native apps (ruled out by the user).
**Consequence:** Everyone uses development builds from day one. Language switch in Settings restarts
the app (Q-079). Updating React Native/Expo versions is a regular chore.

## ADR-102 — Technical shape (modular monolith, PostgreSQL, TypeScript everywhere)
**Status:** Accepted (user, 2026-10-17), after the Stage 6 grill (`_blueprint/STAGE6_GRILL.md`).
**Decision:**
- **One TypeScript server** (Node 22, Fastify) as a modular monolith with a few workers; no separate
  services until a proven need (`ARCHITECTURE.md`).
- **PostgreSQL** (managed, in Saudi) with **one shared schema, an `organizer_id` on every tenant row
  and row-level security**. *One-way door:* changing the database or the tenancy model later means
  migrating live data.
- **A Redis-compatible store** for rankings, rate limits and short-lived codes; always rebuildable
  from the ledger.
- **One Next.js web app** for the event page, station and big-screen pages, the organizer dashboard
  and the Questify console. The player web build is a bonus (F-318).
- **An internal REST API under `/v1`** with an idempotency key on every unsafe call, built so it can
  be opened later for the AI wizard (ADR-060).
- **Jobs in PostgreSQL** (pg-boss); push straight through APNs and FCM; wallet passes signed on
  our server.
**Condition:** the database choice depends on Q-031: if the chosen cloud does not offer managed PostgreSQL with point-in-time recovery in a Saudi region, T-014 re-opens this decision before any database work (T-003).
**Why:** Smallest thing that meets 20,000 completions a minute and one developer's capacity; shared
types between app and server; the module borders allow later splits.
**Alternatives:** Microservices (more failure modes and deployment work for scale that may not come);
a document database (the points record needs transactions); one database per organizer (too much to run);
React-Admin or Retool for the dashboard (the wizard, live preview and renamable words need custom screens).

## ADR-103 — SMS: a Saudi gateway, Msegat or Taqnyat
**Status:** Accepted (user, 2026-10-17 shortlist "Msegat or Taqnyat"; **2026-10-19: the user has an active Msegat account with a services sender and an ads sender, so Msegat is the gateway**). Taqnyat stays a possible second gateway.
**Research (2026-10):** Saudi gateways cost SAR 0.063–0.14 per SMS depending on bundle; sender names
cost SAR 230 a year and need the commercial registration and a Chamber of Commerce letter. Twilio costs
about SAR 0.73 per segment and cannot use a Saudi sender name for a Saudi brand. Tawked is SAR 0.09
per code but is a small vendor.
**Decision:** SMS goes through a Saudi, CST-licensed gateway behind our own interface, so switching
is configuration. Get written quotes from Msegat and Taqnyat and pick one, keeping the other as backup.
**Why:** Cheapest for the volume (about SAR 1,300–2,200 for 20,000 logins), local, and it satisfies
the registered-sender rules (ADR-065).
**Cost:** Questify absorbs it (ADR-099). Unknown until the quotes: Msegat shows no fixed public price.
**Risk accepted (Stage 6 grill):** one gateway at launch with the email code as the only fallback; the user declined automatic failover to a second gateway. A gateway outage at the start of an event locks out phone-only players until it recovers.

## ADR-104 — Build-phase hard rules and quality bar
**Status:** Accepted (user, 2026-10-17). Stage 7.
**Decision:**
- Eight hard rules (`rules.md`): server-side authorization; deny by default with outsider tests;
  personal data in Saudi Arabia and out of logs; Arabic and English for every string; timeout, retry
  and fallback on every outside call; append-only ledger and audit with idempotency keys; configuration
  never downloads features; docs are the source of truth.
- **Quality bar: Max on the core, Standard elsewhere.** Core = points and XP ledger, sign-in and
  sessions, tenant isolation, prize reservation and handover, wallet signing, signed QR/NFC proofs,
  admin powers.
- The root `CLAUDE.md` is **not** changed until planning ends and the user approves; the proposed
  diff is `_blueprint/CLAUDE_BUILD_DRAFT.md`.
**Why:** The rules come from real requirements (NFR-016 to NFR-021). Max everywhere would slow one
developer against an already large plan (Q-077); Standard everywhere would give the money-like parts
(points, prizes) no extra rigor.
**Trade-off:** Two bars to remember; the core list in `rules.md` is the boundary.

## ADR-105 — Access types, tickets and feature layers (wireframe review)
**Status:** Accepted (user, 2026-10-18). Extends ADR-024, ADR-049, ADR-076, ADR-093.
**Decision:**
- **Access types per event:** Public, Unlisted, Private. Private needs the owner's approval; invited people join without it; the waiting player sees a waiting screen and gets a push. The type can change any time and current players stay. The hard limit counts accepted players; a full event offers a waiting list (FR-1818 to FR-1821).
- **Tickets:** one ticket center with four types (report a player, app problem, suggestion, question or prize problem). The type decides the recipient. **One reply, then the ticket closes** (the user chose this over Claude's recommended two-way thread). The event team can escalate to Questify; Questify can send back or take over. Players see their tickets and the full notification history in their profile. The owner sees a tickets inbox with counts, reported players and content, a prize-problems view and the join requests queue (FR-1822 to FR-1825).
- **Feature layers:** each feature that exists in the app is Off or On platform-wide with a per-organizer override; Questify allows it per event; the owner switches it inside that. A feature the owner may not use shows as a locked card with "Ask Questify". Features not yet in the app have no switch (the user declined a registry of unbuilt features) (FR-1826, FR-1827).
**Why:** The user asked for more control for owners and the Questify team, and for a safe way to hold a feature back from everyone.
**Trade-offs:** One reply means players cannot follow up in the same ticket; revisit if event teams find it too tight. No "beta" label; an override per organizer does the same job.

## ADR-106 — Customization: Home, looks, reservation, names, texts, cheers
**Status:** Accepted (user, 2026-10-18). Extends ADR-058, ADR-090.
**Decision:**
- **Home:** new blocks (custom text card, quick links, top-3 podium preview, featured quest or reward), a banner slider with tap actions, countdown blocks, and a drag-and-preview editor (FR-1828 to FR-1831).
- **Looks:** ranking layout List or Podium, scores shown or rank only; Quests list or card grid; shop grid or list (FR-1832, FR-1833).
- **Prize reservation On or Off;** Off means redeem at the desk in one step; the shop can be switched Off (FR-1834).
- **Event info page builder, one extra custom page, default notification topics** (FR-1835, FR-1836).
- **Name display:** Username, Full name or Both, visible to everyone in the event or to staff only. This relaxes FR-120 and ADR-032; the join card must say who sees the name; Questify-wide pages stay username-only; counsel to confirm (Q-080) (FR-1842).
- **Event text overrides** from an approved list (FR-1843); **first-N bonus** (FR-1840); **Cheers** with five fixed reactions, on or off per event, only during a started cheers moment (FR-1841).
- **Team tools:** View as organizer, Questify home layout editor, per-organizer feature usage (FR-1837 to FR-1839); **operator activity** and a **go-live readiness checklist** (FR-1844, FR-1845); the wizard has **ten steps** (FR-1846).
**Not chosen, recorded so they are not proposed again without a reason:** bring a friend, event badges, smart nudges, people's-choice awards, story mode, run-of-show scheduler, group boards, certificates, organizer league, personal goals, streak freeze, save for later, search and filters on Quests, personal quiet hours, profile privacy toggles, combo bonus, golden QR, quest hints, bulk import, notices to organizers, misconduct ladder, benchmarks, API keys for agencies, an editor for layout presets and templates, emergency broadcast, quiet-station alerts, icons per quest.
**Assumptions to confirm:** banner slides up to five with auto-advance; layout presets and templates are supplied as data by the team; the five reactions are heart, applause, fire, star, party.

## ADR-107 — Hosting: CranL (Riyadh) for now
**Status:** Accepted (user, 2026-10-19). Answers Q-031 for the build and early events.
**Decision:** Questify is built and run on **CranL, Pro plan, region `riyadh-1`** (Jeddah `jeddah-1` for a second copy). CranL's managed PostgreSQL, Redis, S3-compatible buckets, CDN, realtime, cron and email are used first. The user already has a CranL account, uses its MCP and CLI, and finds it works well.
**Why:** The fastest and cheapest path to a running system; it works with Claude directly; the Saudi regions exist; the server stays plain containers plus PostgreSQL, so moving later is a data migration, not a rewrite (ADR-102).
**Risks accepted (Claude's note, not yet answered by CranL):** CranL does not publish high availability, point-in-time restore, backups copied to a second city, an uptime commitment, who runs the Riyadh hardware, or its CST registration. The recovery targets (5 minutes of data loss, 1 hour to recover; ADR-082) are therefore **not yet proven** on this host.
**Conditions before real players:** (1) the Pro plan is active (Basic excludes Riyadh and Jeddah); (2) CranL answers the written question list in `INTEGRATIONS.md` (Hosting options); (3) a restore rehearsal passes (T-805); (4) a nightly backup copy is also sent to a second place in Saudi Arabia that we control, so a CranL failure cannot lose data; (5) if any answer is unsatisfactory, move production to Oracle (Riyadh, Jeddah), sccc or Google Dammam.
**Alternatives considered:** Oracle (best documented, not yet checked in the console), Google Dammam, sccc, Huawei, local VPS, Supabase (no Middle East region), hosts abroad (fail ADR-070).

## ADR-108 — Build process and the quality baseline
**Status:** Accepted (user, 2026-10-19). Ends the planning phase.
**Decision:**
- **Planning ends and the build starts.** The root `CLAUDE.md` changes from PLANNING to BUILD (using `_blueprint/CLAUDE_BUILD_DRAFT.md`).
- **Process driver: `TASKS.md` plus the Superpowers skills plus `cto-cycle`; GitHub Spec Kit is not used.** The user asked about Spec Kit (a GitHub tool for spec-driven development; installed as `specify` 0.13.0). Claude's comparison (blog and ThoughtWorks reviews, 2026): Spec Kit adds a second set of spec, plan and task files next to our 546 requirements and 125 tasks; its user-story model fits infrastructure phases poorly; and it leans toward large runs while the core needs small steps with review. OpenSpec (lighter, per-change) may be adopted after launch.
- **A quality and security baseline** (`docs/QUALITY_BASELINE.md`): OWASP ASVS 5.0 Level 2 for the core and Level 1 elsewhere, OWASP MASVS L1 plus privacy for the app, a test pyramid with mutation tests, property tests and a load test on the core, infrastructure as code, observability with service levels and runbooks, a second backup copy in Saudi Arabia, and an independent penetration test before the first public event. New tasks T-016 to T-019 (Phase 0) and T-809 to T-811 (Phase 8).
**Why:** The user wants the build to follow worldwide best practice for infrastructure, security, code and tests, not only to follow our own plan.
**Trade-offs:** More Phase 0 work before the first feature; a paid external penetration test; the baseline adds checks to every core change.

### ADR-107 addendum (2026-10-19): what CranL's backups really are
After the staging environment was created, CranL's API documentation showed that its managed-database "snapshots" save only the rows of the `public` schema, are kept 7 days, and cannot restore roles, row-level-security policies, functions or other schemas; there is no point-in-time recovery or physical backup. That does **not** meet NFR-026 (5 minutes of data loss, 1 hour to recover). Consequences: (1) CranL stays the choice for the build and **staging**; (2) the independent nightly dump to a second place in Saudi Arabia (T-019) is mandatory, not optional, and still gives up to 24 hours of loss; (3) **production on CranL is not acceptable until CranL provides point-in-time recovery or we run our own WAL archiving**, otherwise production moves to Oracle, sccc or Google Dammam (T-811). Decided by evidence, not by the user; the user may overrule it.

## ADR-109 — Fewest moving parts: 2 apps and 2 databases per environment
**Status:** Accepted (user, 2026-10-19).
**Decision:** Each environment (staging, later production) runs **two apps and two databases**: (1) the **API app**, which also runs the background workers and scheduled jobs (backup dump, reservation expiry, messages) in the same container, switched by a mode setting; (2) the **web app** (Next.js: event page, dashboard, console, big screen); (3) **PostgreSQL**; (4) **Redis** for live rankings, rate limits and short-lived codes. One storage bucket per environment (included in the plan). The user was offered a no-Redis option (rankings straight from PostgreSQL) and a one-app option and chose to keep Redis.
**Why:** The worker and the scheduled jobs add no benefit as separate apps at this size; Redis keeps ranking reads fast at the largest events (NFR-005).
**Later:** the worker can be split into its own app by starting the same image in worker mode (`ARCHITECTURE.md`, Growth path). The CranL staging project `Nafes` holds `questify-api-staging`, `questify-db` and `questify-cache` now; `questify-web-staging` is added with T-011.

### ADR-107 addendum 2 (2026-10-19): backup is deferred, key custody noted
The user decided that **no backup work is needed while staging holds only fake data** and that it will be done **after the app is live** (before real players). T-019 therefore stays open but is not a Phase 0 blocker; T-002 is closed for staging with the restore proof waived. **This is a release-gate item:** no real player data may enter CranL until a tested, independent, encrypted backup exists (`QUALITY_BASELINE.md`, release gate; T-811).
For later: the user's preference for the decryption key is **a secret stored in CranL**. Claude's note: anyone who gets into the CranL account could then decrypt every backup, which weakens the independent copy; a key held off CranL is recommended. The design question of where the second copy lives (Oracle Object Storage in Riyadh or Jeddah was recommended) is still open. Design findings kept for then: CranL Pro allows one bucket per account and the `b7r-media` bucket already uses it; a backup role with BYPASSRLS and `pg_read_all_data` is needed because row-level security is forced; the job can run as a CranL cron command inside the API container; use `rclone` or a small signed upload for the transfer; restore must be proved by a script.

## ADR-110 — Switching language asks, then restarts the app
**Status:** Accepted (user, 2026-10-19). Answers Q-079.
**Decision:** The app starts in the phone's language (Arabic or English; any other phone language starts in English). In Settings the player can pick the other language: the app says "The app will restart", and on confirmation saves the choice and reopens. The saved choice wins over the phone's language from then on. No instant switching and no choose-once-only.
**Why:** React Native reads the layout direction once, at launch, so a full mirror needs a restart. Per-component direction handling costs much more and needs extra right-to-left testing on every screen; choosing once would strand a player who picked wrong or shares a phone. Most players never switch.
**Consequences:** A first launch needs no restart (an Arabic phone is already right to left; any other phone is left to right, which is English). A player whose saved language differs in direction from the phone sees one quick restart at their first launch after reinstalling, only if the choice survived (it does not, so in practice only after an in-app switch). The choice is stored on the phone in a key named `questify.language`.
**Note (2026-10-20, found on the user's phone):** Expo Go cannot apply an in-app direction change: it resets the right-to-left setting every time it opens a project (Expo localization guide). So in Expo Go the switch restarts, the texts turn Arabic, but the layout stays left to right. A development build and the store app mirror fully. When a restart does not change the direction, the app now keeps the chosen language for the texts (earlier it fell back to the layout's language, which looked like the switch did nothing) and does not restart again. `extra.supportsRTL: true` in `app.json` lets Expo Go and builds mirror when the phone itself is set to Arabic.
**Note (2026-10-20, user decision):** screen content mirrors by itself (each screen frame takes the language's direction and text starts at the language's reading side), so Arabic screens read right to left in Expo Go too. **The bottom tab bar keeps the same order in both languages** (Home on the left), by the user's choice over the usual Arabic convention of reversing it; the tab bar is locked to left to right in code.

## ADR-111 — Foundation review: mutation testing on the core, infrastructure tasks stay in Phase 0
**Status:** Accepted (user, 2026-10-19), after an independent review of the Phase 0 foundation (score 79/100, "solid with fixes").
**Decision:**
- **Mutation testing runs on the core only** (sign-in and sessions, tenant isolation, API conventions and idempotency, route access; the ledger, prize handover, wallet signing and signed proofs as they are built). The rest is covered by ordinary tests. The reviewer found the earlier "everything" scope gave 20 to 35 minute runs and test busywork for little gain.
- **T-017 (infrastructure as code) and T-018 (observability) stay in Phase 0.** The reviewer suggested moving them after the first playable loop; the user chose to keep them before Phase 1.
**Fixed from the review in the same change:** points, balances and statuses closed to hand edits at the database (column grants and guard triggers), player phone and email moved to `player_contact`, owner-only team changes, explicit filters in the sign-in queries, one shared connection helper with the context set in one round trip, app-wide route access (every route declares who may call it), a guard against a restart loop in the app, CI fails if the database tests would be skipped and now runs the API build, the API image installs only the API's packages.
**Deferred with a home:** a config cache keyed by visibility (T-111), request and response schemas in `packages/shared` before the app calls its first real endpoint (T-111), the ledger trigger for score and balance (T-105), editor event-scope rules in the database (T-101).

## ADR-112 — Staff email goes through the Gmail API from questify@nafes.com
**Status:** Accepted (user, 2026-10-20). Replaces the Gmail SMTP app-password stop-gap of 2026-10-19; Resend stays the backup.
**Decision:** Questify's emails (staff sign-in codes, invites) are sent from **`questify@nafes.com`**, a mailbox in
the existing Google Workspace of `nafes.com`, through the **Gmail API**, authorised by a Google Cloud **service
account with domain-wide delegation** limited to the `gmail.send` scope. No mailbox password or personal login is
stored anywhere; the service account key lives in the CranL secret store only. The dashboard lives on
**`questify.nafes.com`** (a separate DNS record when the web app is deployed).
**Email authentication (checked in public DNS, 2026-10-20):** `nafes.com` already has SPF
(`v=spf1 include:_spf.google.com ~all`), Google's 2048-bit DKIM key (`google._domainkey`), and DMARC
(`p=none`, reports to `dmarc@nafes.com`). Nothing new is needed for Gmail API mail to pass all three. Tightening
DMARC to `p=quarantine` and then `p=reject` affects all of nafes.com's mail, so it is the domain owner's step, done
after reading the reports. Resend, the backup, would send from its own subdomain (for example `send.nafes.com`)
with its own SPF and DKIM.
**Why:** the user wants no password on the server and mail that does not land in spam; Google Workspace on a
domain with SPF, DKIM and DMARC already in place gives both.
**Consequences:** one Workspace licence for `questify@nafes.com` (if it is a new user). Google stays a foreign
provider that sees staff addresses and codes, so the data-map entry and Q-083 (counsel) still apply. T-021 replaces
the SMTP sender in the API with a Gmail API sender (no new library: a signed service-account token and one HTTPS
call, with the same timeouts and the Resend fallback). The Gmail app password is no longer needed.

## ADR-113 — One trusted proxy hop: the web forwarder passes the client address through
**Status:** Accepted (user, 2026-10-21). Proposed in T-011, CTO plan review 2026-10-20.
**Decision:** The web app's `/v1` forwarder passes `X-Forwarded-For` through unchanged (a Next.js route handler
cannot see its own peer) and calls the API at its **internal** address (`API_ORIGIN`, plain http and a one-word host,
enforced at start-up). The API trusts exactly one hop (`TRUST_PROXY_HOPS=1`): the entry CranL's edge adds. The
mobile app reaches the API through the same edge, so both paths have the same count.
**Evidence (2026-10-20, from inside the staging container):** `http://questify-api-staging-3ez01s:3000` answers over
the project's private network (Docker DNS, a 10.0.1.x peer, no HTTP proxy adding headers on that path).
**Proven on staging (2026-10-20):** 30 failed sign-ins straight to the public API, each with a different forged
`X-Forwarded-For`, were throttled on the 31st, and the next attempt through the web forwarder was throttled as well:
the edge appends the real client address and both paths count it the same way.
**Replaces:** the T-006 note's chain "edge, dashboard proxy, API", which assumed the forwarder appends.

## ADR-114 — Questify-wide quests get their own table
**Status:** Accepted (user, 2026-10-21). Proposed in T-103 planning, CTO review 2026-10-20. The user's note: Questify
runs no quests inside organizers' events; each event has its own. Questify's own quests live on Questify home, outside
every event, which is what `questify_quest` holds.
**Decision:** `quest.event_id` is NOT NULL: every row in `quest` belongs to an event and its organizer, so tenant
row-level security stays one simple rule. Quests not tied to an event (FR on Questify-wide quests) get their own table,
`questify_quest`, when they are built.
**Replaces:** DATA_MODEL's earlier note that such quests are `quest` rows with a null `event_id`.
**Why:** a null tenant key would need an exception in every quest policy and in the outsider and cross-tenant tests.

## ADR-115 — `uqr` draws QR codes in the dashboard
**Status:** Accepted (user, 2026-10-21). Proposed in T-104, CTO plan review 2026-10-20.
**Decision:** The dashboard draws quest QR codes with `uqr` 0.1.3 (unjs, MIT, no dependencies, 79 kB), pinned
exactly, in `apps/web` only, through `encode()` into an SVG path (never raw HTML). The API signs codes; it never draws
them.
**Why:** a QR encoder (Reed–Solomon, masks, version tables) is not worth owning; `qrcode` brings `pngjs`,
`dijkstrajs` and `yargs`. **Fallback:** `qrcode-generator` (also dependency-free) if `uqr` stalls; the token format does
not depend on the library.

## ADR-116 — Quest QR codes are signed with their own secret, `QR_SECRET`
**Status:** Accepted (user, 2026-10-21). Proposed in T-104, CTO plan review 2026-10-20.
**Decision:** A quest QR holds `{DASHBOARD_ORIGIN}/q/{token}`; the token is base64url of a format byte, the quest id,
its code version and a 128-bit HMAC-SHA256 tag over those, under `HMAC(QR_SECRET, "questify/qr/v1/quest")`. `QR_SECRET`
is a new required production secret (32+ characters), set by Dhia in the secret store, separate from `AUTH_SECRET`.
**Why:** printed codes live a whole event, and `AUTH_SECRET` is rotated whenever someone with access leaves (RUNBOOK);
deriving from it would force every organizer to reprint each time. A leak of `QR_SECRET` voids every code in every
event at rotation (RUNBOOK procedure). A per-quest random nonce was considered and rejected: SECURITY and ARCHITECTURE
call for signed codes, and rotating station codes (FR-314) need a key anyway.

## ADR-117 — Player email sign-in codes go through the staff email path (Gmail, Resend backup) for now
**Status:** Accepted (user, 2026-10-20, T-107 planning: "Use Gmail for now").
**Decision:** Players who sign in by email (no +966 number, or when SMS fails, FR-108, FR-1812) get their one-time
code through the same sender as staff codes (ADR-112: the Gmail API from questify@nafes.com, Resend as backup). Only
the email address and a short-lived code pass through the provider; nothing else about the player does. A separate
daily budget for player codes keeps staff sign-in codes deliverable when players' volume spikes.
**Why:** email sign-in is required (non-Saudi numbers, the SMS fallback), and no in-region email provider has been
chosen. This is a known, accepted exception to hard rule 3 for the address and the code only, recorded in the data map
(SECURITY.md). **Revisit:** when a Saudi email provider is chosen (Q-034); the switch is configuration behind the
`EmailSender` interface.


## ADR-118 — Live rankings in a managed Redis from T-106
**Status:** Accepted (user, 2026-10-20, T-106: "Redis now").
**Decision:** Event rankings live in a Redis-compatible store (CranL managed Redis in the Nafes project, `riyadh-1`),
one sorted set per event and ranking, written after each completion commits and rebuilt from PostgreSQL whenever it is
missing or doubted. PostgreSQL stays the source of truth; the store holds nothing that cannot be rebuilt (ADR-102). The
client is the official `redis` package (node-redis).
**Why:** the approved architecture (ARCHITECTURE.md, TECH_STACK.md) and NFR-005: top 10 and "my rank" for 20,000-player
events and the big screen in milliseconds without counting rows on every request. **Cost:** one managed Redis service
on CranL. **Staging:** the service is created with the next staging deploy; until then the API runs without it only in
development and tests that do not need rankings.

## ADR-119 — The first word lists come from LDNOOBW, cut and reviewed
**Status:** Accepted (user, 2026-10-21, T-109: "Open list + my review").
**Decision:** The Arabic and English lists that block offensive usernames (FR-118, FR-1412) start from the "List of
Dirty, Naughty, Obscene, and Otherwise Bad Words" (LDNOOBW, CC BY 4.0, credited in `docs/legal/THIRD_PARTY.md`), cut by
Claude to remove entries that would block ordinary names or words (for example «فرج», a common name; «بيضان»; "how to
kill"). They are data in the database, edited later by a Questify admin (FR-1779); the migration only seeds them.
Matching runs in the database after Arabic and case folding: entries of four letters or fewer match a whole token of
the username (between `_`, digits or its ends); longer entries, and a few short ones that never appear in innocent
words, match anywhere.
**Why:** an empty list blocks nothing at launch (store review, PD-11), and a list made from scratch would miss common
terms. The cut keeps false refusals rare; the admin can add or remove words without a release.

## ADR-120 — A contact change proves the new contact, not the old one
**Status:** Accepted (user, 2026-10-21). Proposed by Claude in T-108; CTO review.
**Decision:** A player changes their phone or email, or adds the second one, with a code sent to the new contact only
(FR-125, FR-139). The old contact is not asked for a code. Every change and add sends a notice to the old value of that
channel and to the other channel (SMS for a phone, email for an email, both languages, never naming the new value),
writes an audit entry without the contact, and keeps the player's sessions.
**Why:** a player who lost their phone number cannot prove it, and FR-125 exists for exactly that case. ASVS 5.0 V7.5.1
asks for re-authentication before changing an attribute that signs a person in; the notices, the audit entry and kept
sessions (so the real owner can change it back) compensate, and support handles a takeover reported from a notice.
**Cost:** someone holding an unlocked phone with the app can move the account to their own number; the owner learns of
it from the notice. Revisit if support sees such cases (an extra code to the old contact when it is still reachable).

## ADR-121 — One font at one size for every player
**Status:** Accepted (user, 2026-10-21: "there is no accessibility settings in our app, its one font, one size and
its the same for all users, we accept this").
**Decision:** The app draws all its text at the theme's sizes and ignores the phone's text-size setting
(`allowFontScaling={false}` in `AppText` and in every text field). It follows ADR-085, which set no large-text target
for v1. The phone's Reduce Motion setting is still respected, because FR-408 requires it.
**Why:** every screen keeps the layout it was designed with. In particular the ranking fits 11 rows on the smallest
phone with no scrolling (FR-603), which no layout can promise at very large text sizes.
**Cost:** players who rely on large text see the app's own size. Screen readers still read every row in full.

## ADR-122 — A player reads the configuration of an event they joined
**Status:** Accepted (user, 2026-10-22). Proposed by Claude, 2026-10-21, T-117.
**Context:** `GET /v1/config?event=` is public and reads the event with no caller, so row-level security hides every
event that is not public. An unlisted or private event's words never reached the app, and Home and the ranking read
such an event's ranking switch as off (Home said the ranking was off; the ranking answered 404).
**Decision:** `SettingsService.forEvent(eventId, playerId?)` reads the event as anyone first, cached per event; only
when that answers "not found" and a player is given does it read again with the player's context, cached for that
player alone (15 seconds). A new player route, `GET /v1/events/{id}/config`, answers the
same document with the same ETag to a player who joined the event. Home and the ranking pass the player too.
**Why:** the database already decides who may see an event; the route adds no rule of its own. The public route keeps
its meaning for anyone without a session.
**Cost:** a public event still costs one reading per event every 15 seconds. An unlisted or private event costs one
reading per player every 15 seconds, and its entries share the 1000-entry cache. The phone keeps one copy per event,
removed when the app forgets the event.

## ADR-123 — One environment for now: the CranL staging services become production
**Status:** Accepted (user, 2026-10-21: "I dont want staging for now, only production"; chose "make it production").
**Decision:** There is no staging environment for now. The live CranL services (`questify-api-staging`,
`questify-web-staging`, their database, secrets, the Gmail email setup and the admin account) are renamed and
repointed as production; nothing is rebuilt. Every change that was waiting for "staging" (migrations 0007 onward,
the managed Redis with `noeviction`, `QR_SECRET`, Msegat's static-IP check) is now done on production.
**Amends:** ADR-107 and the RUNBOOK's staging steps.
**Cost:** changes are tried on the live environment; the local suite (`ci:full`) and the database tests are the
safety net until real players arrive, when a separate test environment is reconsidered.

## ADR-124 — A released username is held for a number of days a Questify admin sets
**Status:** Accepted (user, 2026-10-21). Answers Q-094.
**Decision:** A platform setting, edited in the Questify admin console, holds a username a player gave up for N days
before anyone else can take it. 0 days (the default) frees it at once, as built in T-109. The username history
(FR-1702) still records who had each name.

## ADR-125 — The brand is written "Questify" in Latin letters in Arabic text too
**Status:** Accepted (user, 2026-10-21). Answers Q-098; supersedes ADR-019.
**Decision:** Arabic text writes the brand as "Questify", the same as English. The strings that write «كويستفاي»
(SMS, emails, the event web page, the contact texts) change to "Questify" in the copy pass (T-808). The Arabic store
listing uses the same name. The logo stays the English wordmark (ADR-020).

## ADR-126 — No "+" next to the coin balance
**Status:** Accepted (user, 2026-10-21). Answers Q-053.
**Decision:** The coin balance is shown with no button beside it. In games a "+" beside coins means "buy more", and
Questify sells no coins (ADR-002); store reviewers may read it as an in-app purchase.

## ADR-127 — The minimum iPhone software is iOS 16.4
**Status:** Accepted (user, 2026-10-21). Answers Q-082.
**Decision:** The app supports iOS 16.4 and later (NFR-008), the minimum of Expo SDK 57 (Q-046). Android stays 9 and
later.

## ADR-128 — The owner's "billing" powers mean requesting activation; the platform holds no invoices
**Status:** Accepted (user, 2026-10-21). Answers Q-089.
**Decision:** ADR-076 stands: the platform holds no prices, invoices or payments. Where older text gives the owner
"billing" powers (ADR-059, F-188, FR-1011, FR-1012) it means requesting activation, limits and add-ons; SRS §3 and §4
and `INTEGRATIONS.md` drop platform-sent invoices. Those texts are corrected in the copy pass (T-808) or the next task
that touches them.

## ADR-129 — Free sounds in the adventure style, a full set
**Status:** Accepted (user, 2026-10-21: "use free sounds that match our theme and style, we would need much more than 3
sounds"). Answers Q-103.
**Decision:** The app uses royalty-free sounds whose licence allows commercial use without credit in the app (for
example CC0), chosen to match the brand's adventure style (ADR-013). The set covers more than the scan beat: scanned,
success, refused, level up, reward redeemed, rank change, button taps and the other celebration moments. Each file and
its licence are listed in the design references. Sounds respect the phone's silent switch.

## ADR-130 — The mascot is Saqr, the falcon explorer
**Status:** Accepted (user, 2026-10-21). Answers Q-069.
**Decision:** Saqr is the mascot for onboarding, tips, empty states and celebrations. Its character sheet comes next
in the design work (Phase 6); the other four concepts are dropped.

## ADR-131 — No trademark registration; the store listing name must still be unique
**Status:** Accepted (user, 2026-10-21: "no need to have trademark"). Answers Q-021.
**Decision:** Questify registers no trademark. Other apps named Questify exist (checked 2026-10-21): on the App Store
"Questify - Task RPG" (Taylor Reilly, playquestify.com) and "Focus Timer · Questify"; on Google Play "Questify"
(com.codetechno.questify, a quiz game), "Questify - Daily Quest Tracker", "Questify : Sor & Cevapla" and others. Apple
requires a unique app name, so the listing uses a longer name (for example "Questify: Event Quests"), reserved when the
Apple account exists (T-010). Google Play does not require unique names.
**Cost:** another Questify could object to the name later; the user accepts that risk.

## ADR-132 — Where four partly delivered features are finished
**Status:** Accepted (user, 2026-10-21, Claude's recommendations). Answers Q-096, Q-097, Q-099, Q-101 and Q-102.
**Decision:**
- Q-096: exclusion lists check current contacts only; no contact history. Revisit if an organizer reports it.
- Q-097: a root `not-found.tsx` in Arabic and English, stacked, comes with the next web task that touches the shell.
- Q-099: the event's about text, address and map position are added to the event form in T-613.
- Q-101 and Q-102: optional location, estimated minutes, difficulty and tips join the quest form when the builder
  grows (T-3xx); steps come with multi-step quests; "Up next" switches to points per minute then.

## ADR-133 — Rewards: derived stock, spending in the ledger, one reservation per expiry transaction
**Status:** Accepted (user, 2026-10-22). Proposed by Claude, 2026-10-21; T-201, T-202. Extends ADR-043, ADR-048, ADR-049.
**Decision:**
- A reward's stock left is `stock_total − units_out`. Only the definer functions move `units_out`, under a lock on the
  reward, and a CHECK keeps it between 0 and the total, so the count never drifts and an organizer cannot lower the
  stock below what is reserved.
- Spending is in the points ledger: `redeem` takes the price from the balance and `redeem_return` gives back exactly
  what the redemption paid. Neither moves the score. A unique index allows one of each per reservation.
- Every path takes its locks in one order: enrollment, then reward, then redemption. The pickup timeout handles one
  reservation per transaction and chooses the row without a lock, so it never holds two players' locks.
- The shop is open while the event is live and for `shop_days_after` days after it ends. Reward edits are allowed
  until the event is archived.

**Why:** a stock count kept as a copy can drift under races; one derived from what is out cannot. A batch expiry in
one transaction would deadlock against a player's reserve (CTO plan review).

## ADR-134 — Each event chooses whether spending lowers the ranking
**Status:** Accepted (user, 2026-10-22: "I think each event could have its own thinking or way. So let's make it an
option for them."). Amends ADR-043 and ADR-133.
**Decision:**
- An event setting, "Spending lowers rank" (FR-1847), edited by the owner in the dashboard. **Off by default**, which
  keeps ADR-043: the ranking, rank prizes and the finale use points earned, and purchases lower only the balance.
- On: a `redeem` entry also lowers the score and `redeem_return` restores it, so the ranking, rank prizes and the
  finale follow what the player still holds. The score never goes below zero, since a player can spend only the
  balance.
- The setting locks once the event is live (Claude's assumption, so the board never reshuffles mid-event; the user
  can widen it). The ranking cache is rebuilt from the ledger as usual.
- The dashboard explains the trade-off next to the switch: with it on, players may hold their points instead of
  using the shop.
**Build:** T-219 (migration 0025). Only the owner may change it (FR-1847). The ledger entry itself says what it moved
(the definers write `score_delta`), and a return mirrors its own payment, so changing the setting later never
unbalances a return. Spending after the end follows ADR-135.

## ADR-135 — After the event ends, spending moves the balance only
**Status:** Proposed (Claude, 2026-10-22, from the T-219 CTO plan review; Q-106 asks Dhia).
**Decision:** with "spending lowers rank" on, a purchase lowers the score only while the event is live. In the days the
shop stays open after the end (ADR-048) a purchase lowers the balance only, so the final score, the final ranking and
rank prizes (T-214) never change after the end. A post-end cancel of a purchase made while live still gives its score
back, since a return mirrors its payment.
**Why:** otherwise a winner who spends after the end would change the results, and the results would depend on when
they were read.

## ADR-136 — Digital rewards are delivered at once, and their codes are encrypted by the API
**Status:** Proposed (Claude, 2026-10-22; T-203).
**Decision:**
- Redeeming a digital reward gives the oldest unused uploaded code at once and records the redemption as `delivered`:
  no pickup time, no timeout and no cancel, since the player has seen the code. The per-player limit counts delivered
  codes. A stock that claims a code the table does not have refuses the redemption (never a delivery without a code).
- Codes are encrypted in the API with AES-256-GCM, the reward id as associated data, under a key derived from a new
  secret `REWARD_CODE_SECRET`; a keyed HMAC finds repeats. The database, its dumps and backups hold no readable code.
  Organizers never see a code after upload; the player sees theirs in the reserve answer and in their history.
- One key for now: rotating it makes every code not yet given unreadable, so a rotation means re-uploading those codes
  (RUNBOOK). A key version joins when a rotation is first needed.
**Why:** a code is money's worth; a leaked dump must not hand them out, and a code already shown cannot be taken back.

## ADR-137 — My QR is a fixed code; prizes need the player's own confirmation
**Status:** Accepted (user, 2026-10-22; T-205). Amends FR-306 and FR-307 and the "rotates every 30 s" of ADR-057's
operator flow.
**Decision:**
- My QR is a fixed code: the player's id and a version, signed by the API with its own key from `QR_SECRET`
  (`questify/qr/v1/my`). It works offline and can be shown as long as the player likes.
- Showing it only identifies the player. A station scan pays the code's owner only; the prize desk (T-206) hands over
  only after the player accepts in their own app.
- The player can replace the code at any time (5 times a day); every earlier code then stops at once.
**Why:** Dhia (2026-10-22): "Fixed code with verification, like he cannot just get the prize with just showing the
QR, he must redeem it or accept it from his account." A rotating code needed a connection every few hours and still
let a friend send a fresh screenshot.
**Risk accepted:** a photographed code can be carried to stations by someone else and earns its owner points there.
Mitigations: the station shows the player's name and avatar, T-209's burst and impossible-speed flags, and reset. The
meet-someone scan (T-303) needs its own answer, since a fixed code can be shared in a group chat.

## ADR-138 — Operator invites go by email only
**Status:** Accepted (user, 2026-10-22; T-204). Amends FR-901 and ADR-057's "phone or email".
**Decision:** the owner invites an operator by email, or hands a personal operator QR to one named person (or prints a
batch with an ability preset, FR-1720). No SMS invite and no add-by-phone. Claiming an email invite needs the account's
own email to match; the invite email is cleared once the invite is claimed, cancelled or expired.
**Why:** Dhia: "send email only". SMS costs money per message and a personal QR already covers people at the venue.

## ADR-139 — Operator management is the owner's; one completion engine serves both scans
**Status:** Proposed (Claude, 2026-10-22; T-204, T-205).
**Decision:**
- Only the event's owner (or a Questify admin) invites, changes and removes operators; editors read the list. Claim
  addresses go to the owner only: an editor holding one could make themselves an operator.
- The station scan and the player's own scan go through one database function (`record_completion`); operators who
  may not play are refused in one place, a guard on the points record that covers quests and the shop.
- No rate limit on station scans: every scan needs a real signed My QR, pays a player at most to the quest's cap, is
  held to one completion per operator, player and quest in any 10 seconds, and names the operator in the points
  record. T-209's flags watch bursts.
- Booths have no model yet: operators are limited by quest (Q-107).
**Why:** the owner holds the event's admin powers (FR-901 to FR-909); one engine keeps every completion rule in one
place; a rate limit would add a write per scan and stop nothing a signed code does not already stop.

## ADR-140 — Activation runs through definers and a console behind its own access kind
**Status:** Proposed (Claude, 2026-10-22; T-210, ADR-076).
**Decision:**
- The owner requests and withdraws activation (`request_event_activation`, `withdraw_event_activation`); a request is one
  row per event, pending or rejected with the admin's note. The history is the audit log.
- A Questify admin activates a draft, rejects a request with a note, or changes the limit later, through definers that
  confirm the account itself is an active platform admin (`app_admin_id()`), not only the request's admin flag.
  Activation sets the add-ons to exactly the chosen list; add-ons change later through the settings service.
- The console's routes live under `/v1/admin/` with a new access kind `admin`; anyone who is not an active platform
  admin gets 404, so the console is not advertised (a request without a session or Origin is refused first with 401 or
  403, as on every route). The dashboard's console pages check the same before rendering.
**Why:** the admin powers are on the Max bar: two independent checks (the route hook and the database), every action
audited, and no write grant on the new tables or columns.

## ADR-141 — A seat is a pending, active or banned player; the hard limit is a wall at the enrollment
**Status:** Proposed (Claude, 2026-10-22; T-210). Needs Dhia's acceptance: a ban keeps the seat.
**Decision:**
- Seats are enrollments that are pending, active or banned. A player who left or was removed frees the seat. A banned
  player keeps the seat, so an organizer who bans cheaters cannot fill those seats with new players past the paid size.
- Only a move into pending or active takes a seat, so a ban (also of a player who left) is never refused for being over
  the limit, and lifting a ban takes no new seat.
- The hard limit is a trigger on `enrollment`, so every way of joining meets it (`join_event`, T-212's `join_invited`):
  joins at the last seat wait their turn on a per-event transaction lock; the refusal is `QL409`, answered as 409
  `event_full` ("This event is full."). Every caller that writes an enrollment maps it with `isEventFull`.
- The marks: 80% from `ceil(0.8 × limit)` (240 of 300) and 100% at the limit, each recorded once per limit
  (`event_limit_alert`) and shown on the dashboard. Changing the limit recomputes them; a limit below the players
  already in keeps them all and closes joining (hard).
**Why:** the paid size is what Questify sells (ADR-076); a wall outside the database could be raced by two joins.

## ADR-142 — What an event needs before activation
**Status:** Proposed (Claude, 2026-10-22; T-210). Completes the note in the T-102 plan.
**Decision:** activation refuses (422 `activation_incomplete`, with the field) an event without a start and an end, or
whose end has passed, and a physical event without a venue in either language. The rest of the checklist only advises
(DASHBOARD_AND_CONSOLE A3). An event activated after its start becomes live at once.
**Why:** a scheduled event must have its times (`event_times_once_active`), and players of a physical event need to know
where it is.

## ADR-145 — The join locks work on any access type, and a guest passes them
**Status:** Proposed (Claude, 2026-10-22; T-212).
**Decision:** "guest list only" (FR-134) and the email-domain lock (FR-135) are event settings that apply whatever the
access type, though the SRS phrases them for private events. A person whose verified phone or email is on the guest
list passes both locks and joins active even in a private event (FR-1819's invited half). A member is never refused by
a lock added after they joined; banned and removed players stay out first. A pending requester later put on the guest
list goes in without approval when they join again (T-212 review). An operator the owner lets play (FR-907) skips the
fields and both locks: the owner chose them.
**Why:** tying the locks to "private" would block changing the access type at any time (FR-1820) or silently drop the
lock; the organizer named the guest, so a second gate for them would only cause support calls.

## ADR-146 — The domain lock is checked at the join only
**Status:** Proposed (Claude, 2026-10-22; T-212, answers the T-108 note).
**Decision:** a member of a domain-locked event whose email later leaves the domain (`confirm_contact_change`) stays a
member. The lock gates the join; it does not pause a membership.
**Why:** pausing needs a new enrollment state, a trigger on contact changes and a way back, for a rare case the
organizer can handle by banning. Revisit if a company asks for it.

## ADR-147 — The welcome reward is a ledger entry granted when an enrollment first becomes active
**Status:** Proposed (Claude, 2026-10-22; T-212, CTO plan review).
**Decision:** `event.welcome_points` (1 to 100 000, empty = off), set by the owner or an editor. A trigger on
`enrollment` writes one `welcome` entry (actor `system`, score and balance by the same amount) the first time an
enrollment becomes active: a join, an invited join, the owner's approval of a pending join (T-218) or a lifted ban.
One per enrollment (a unique index): leaving and joining again grants nothing more. The amount is fixed once anyone has
joined or the event is live, whichever comes first, so every member gets the same. The join answers with `welcome`
(the points this join granted) and the app plays the coin animation once.
**Why:** one place covers every path into `active`, so T-218 cannot forget it; the ledger stays the only source of
score and balance (FR-137). The one-time rule across account deletion waits for the fingerprint (T-217).
**Cost accepted:** every join (operators' too) reads the event FOR SHARE, so joins and edits of the event wait for each
other briefly; 0027 alone had avoided that. Fine at this scale.

## ADR-148 — Join answers: the card 0.2, team-only reads, a versioned save of the fields
**Status:** Proposed (Claude, 2026-10-22; T-212).
**Decision:**
- The join card is version 0.2 for every event; an event with join fields adds "Your answers in the fields below" to
  what the organizer receives. An app on 0.1 is asked to read the card again (`card_version_stale`).
- Answers (`join_answer`) are written only by the join definers and read only by that event's team (event scope), the
  player themself and the platform admin. They appear in the dashboard's players list. Up to 5 fields, one of each
  named kind and any custom ones; a saved field's kind never changes.
- The dashboard saves the whole field list with the version it read: a save from a stale page is refused
  (`join_fields_changed`), since deleting a field deletes the answers given to it.
- The guest list is shown masked (a phone's last four digits, an email's first letter and domain); the audit keeps
  counts, never a contact. Owners and editors manage it, like the rest of the event's setup.
**Why:** answers are personal data (PDPL): the narrowest readers that serve FR-131, and no silent loss of answers.

## ADR-149 — Heavy checks run on GitHub, by hand
**Status:** Accepted (user, 2026-10-23).
**Decision:** the full suite with every browser test (`full.yml`) and mutation testing (`mutation.yml`, incremental)
run on GitHub's Linux runners, started by hand on a pushed branch. The PC runs the quick checks while coding. The pull
request gate (`ci.yml`) is unchanged.
**Why:** Dhia: "not only Mutation, but any test could be there, faster and more efficient." The repository is public,
so the minutes are free and the runners have 4 cores; Stryker's workers crash on Windows under load, which left up to
947 test databases on a nearly full disk; and the PC stays free while the checks run.
**Cost:** GitHub tests only pushed code, so a branch is pushed before its heavy checks. Re-check this if the
repository becomes private (minutes are then billed, CLAUDE.md CI rules).

## ADR-150 — The prize desk: the owner picks how players confirm; hours are optional; no undo
**Status:** Accepted (user, 2026-10-23; T-206). Amends FR-1716 (hours optional), FR-1717 (experiences follow the desk
too) and OPERATOR_MODE 3.3 (no Undo).
**Decision:**
- The player confirms every handover in their own app (ADR-137), and the event's owner chooses how
  (`handover_confirm`): **Collect first** (default): the player taps Collect on a reservation, which is ready at the
  desk for 5 minutes; the desk's Handed over is then final. **Desk offer**: the desk taps Hand over and the player
  accepts on My QR within 2 minutes; the accept is final.
- A handover is final and written to the points record once; there is no undo.
- Desk hours are optional. None set: the desk is open the whole time. Set (1 to 14 windows): items and experiences are
  handed over or confirmed only inside a window and are no longer reservable after the last window ends. Digital codes
  never go through the desk and keep FR-1717's rule.
**Why:** Dhia (2026-10-23): "we have the 2 options, in the event settings the owner chooses"; "Drop the undo"; "having
a desk hours is optional things. Like by default, it is open all the time. But he can make it like on and off. And it
applies to all the rewards." Claude read "all the rewards" as every reward that goes through the desk.

## ADR-151 — Prize desk details
**Status:** Proposed (Claude, 2026-10-23; T-206).
**Decision:**
- While the desk is closed between windows, a new reservation's pickup time starts at the next opening, so a
  reservation made overnight does not expire before the desk opens.
- The pickup timeout skips a reservation the player is collecting or was offered right now; a Collect or offer already
  live may finish past the pickup deadline. A new Collect, offer or handover on an overdue reservation is refused.
- Desk hours bound FR-1609: a reservation made 5 minutes before the last window ends is collectible for those minutes.
- An operator never hands over or cancels their own reservation at the desk (they cancel it as a player).
- An experience ends as `handed_over`, shown as "Confirmed"; an event with only experiences needs no desk place.
- The desk sees no price, score or balance; the operator's cancel returns the points as the operator in the points
  record.
**Why:** the CTO plan review (86 → 93): each closes a gap where the desk, the timeout and the player could disagree.

## ADR-152 — Manual awards: caps, removals, bulk targets
**Status:** Accepted (Dhia, 2026-10-23; T-207).
**Decision:**
- Manual-award caps are per event only: a maximum per award and a maximum per person per day, set by the owner and
  followed by every operator and every editor. The owner's own dashboard awards are uncapped. No per-operator cap.
- A removed quest award stays used: the completion stays on record and counts toward the quest's repeat cap; only its
  points come off. A mistaken removal is put right with a new manual award.
- Bulk award (FR-1712) ships with two targets: an uploaded or pasted list (usernames or phone numbers) and "everyone
  who completed a chosen quest". Session targets come with T-505; category targets later.
- Owners and editors may remove an award (the dashboard role table); FR-320 amended.
- (CTO plan review, Claude's call) An editor's bulk award gives each player at most the per-award cap and does
  not count toward the daily cap; the owner's bulk is uncapped. Q-118 asks Dhia whether to lift the editor limit.
**Why:** Dhia's answers to the T-207 interview (2026-10-23): event caps only; the removed quest stays used, so a
cheater cannot simply scan again; the list and quest-completer targets cover the "code failed" case now; the editor is
the person on the floor on event day.

## ADR-153 — Flags in v1: same device and bursts; location, speed and integrity later
**Status:** Proposed (Claude, 2026-10-23; T-209). Q-119, Q-120.
**Decision:**
- T-209 builds two detectors, run by a trigger on every new completion inside its transaction: **same device**
  (FR-330, FR-1745: every account of the event seen on one install id gets a case, once per account and phone) and
  **bursts** (FR-333: 10 or more scans within 5 minutes, manual awards not counted, counting again after a resolved
  case). Thresholds live in one function until T-703 makes them console numbers.
- FR-331 (far from the venue) and FR-332 (impossible speed) move to T-303, which brings the location permission, quest
  pins and the venue pin. FR-334 (device integrity) moves to a new T-812 (needs Dhia's Apple and Google setup).
- No separate operator-burst flag: a station scan is the scanned player's completion, so it shows as that player's
  burst with the operator named.
**Why:** both detectors use data already stored (`quest_completion.device_id`, times); the other three have no data
yet. A trigger covers every completion path without copying the completion engine.

## ADR-154 — The desk's hold and the owner's pause
**Status:** Proposed (Claude, 2026-10-23; T-209). Amends FR-1747 ("release" = lifting the ban). Q-120.
**Decision:**
- One check in `finish_handover` (both confirm paths), the desk's offer and the desk lookup: paused (FR-1604) first,
  then banned (FR-1747), then an open flag while the event's hold is on (FR-1815, default on, owner's switch).
- The operator sees "Held, ask the owner" for a flag or a ban, never which; a paused player shows the paused screen.
  The desk's Cancel stays available.
- A banned player's items are released by lifting the ban; there is no per-item release.
- A pause also refuses the player's new reservations and Collect, with a message (FR-518). A flag or ban hold tells the
  player nothing in the app.
- A held reservation keeps its pickup timeout.
**Why:** one gate in the one handover body cannot be skipped; not naming the reason keeps flags private to the team.

## ADR-155 — Flag cases: who acts and how a case closes
**Status:** Proposed (Claude, 2026-10-23; T-209).
**Decision:**
- Owners and editors (in their events) read cases, clear them and close them as "points removed" (only after a
  removal entry for that player since the case was raised; the removal is T-207's). Only the owner bans, pauses and
  switches the hold. A ban closes the player's open cases as "banned". A closed case is never reopened; a new burst
  opens a new case.
- Every action is audited.
**Why:** FR-1815 lets editors end the hold; FR-518 and the 0019 ban are the owner's.

## ADR-156 — The desk finds a player by username or phone
**Status:** Proposed (Claude, 2026-10-23; T-209). New FR-1848.
**Decision:** an operator with the hand-over ability can find an event member by exact username or exact Saudi mobile
when My QR cannot be read, and sees the same items as after a scan. 30 finds per operator per 10 minutes.
**Why:** every handover still needs the player's Collect or Accept in their own app (ADR-137), so finding by name
gives nothing away; it is the same lookup as the manual award's (T-207).

## ADR-157 — Rehearsal data is stamped and erased at go-live
**Status:** Proposed (Claude, 2026-10-23; T-211). Amends NFR-019 (Proposed sentence).
**Decision:**
- Every ledger entry carries an immutable `rehearsal` flag, set at insert from the enrollment (a rehearsal account,
  ADR-158). At go-live one definer deletes the event's rehearsal entries with the completions, reservations, flags,
  notes and accounts hanging off them, restores stock and repairs the ranking.
- The ledger's append-only trigger allows exactly one thing more: DELETE of a `rehearsal` row inside that definer
  (a transaction-local setting naming the event). UPDATE and TRUNCATE stay refused for every row; the API role still
  has no DELETE grant. The audit log is untouched; the erase is audited with counts.
- NFR-019 gains: "Rehearsal records (ADR-080) are not part of the record: they are erased at go-live, and the erase is
  audited with counts."
**Why:** keeping rehearsal rows and filtering them everywhere (reversing entries) would need a rehearsal filter in
every rule and read forever, and the team could not complete a one-time quest live; separate tables double the core
engine; a shadow event breaks the printed QR codes ADR-080 wants tested. Rehearsal rows belong to no real player.

## ADR-158 — Who rehearses: a rehearsal code and separate rehearsal accounts
**Status:** Proposed (Claude, 2026-10-23; T-211).
**Decision:**
- The owner and editors see a rehearsal code (`XXXX-XXXX`, 32 unambiguous capitals and digits) on the event page and
  may rotate it. Joining with it creates a
  rehearsal enrollment (`joined_via = 'rehearsal'`) on a Draft or Scheduled event, activated or not; it skips access
  rules, join fields, welcome points and the player limit. At most 25 per event.
- A rehearsal account is deleted at go-live with its data; team roles stay. A player with a real enrollment in the
  event cannot rehearse with that account.
- Owners and editors can erase all rehearsal data and accounts at any time before go-live.
**Why:** staff accounts have no phone, so the database cannot tie a phone to a team member; the UX already designs a
standing code. The cap and the erase stop a leaked code becoming a free unpaid event (F-265).

## ADR-159 — Rehearsal plays like live
**Status:** Proposed (Claude, 2026-10-23; T-211).
**Decision:** for a rehearsal account before go-live, the event counts as live: quests, shop (open), prize desk
(hours ignored), awards, removals, flags and spend-lowers-rank work. Per-quest and per-reward rules apply as written.
A digital reward shows a random test code and never touches the code pool or its stock.
**Why:** the team tests what players will see; a real code shown in rehearsal could never be taken back (T-203 note).

## ADR-160 — The go-live moment: wipe at the tick or the first live write
**Status:** Proposed (Claude, 2026-10-23; T-211).
**Decision:** the erase runs when the tick moves the event to live, or inline at the first live write if that comes
first, under a lock on the event's rehearsal row. Rehearsal writes take a shared lock on that row first and re-check
the start against the clock, so none commits after the erase. Events that never rehearsed pay one key lookup.
**Why:** live is computed from the start time, so there is no single go-live transaction to hang the erase on.

## ADR-161 — The goal: one pin per event, and FR-522 moves to T-304
**Status:** Proposed (Claude, 2026-10-23; T-213).
**Decision:** a member pins at most one reward per event as their goal, stored on their enrollment
(`goal_reward_id`, written only by `set_goal`). Home shows the pinned reward while it is in the shop, not closed and
under the player's limit, whatever its stock, with what is left to earn (0: "you have enough"; sold out says so). With no pin, Home shows the
cheapest reward the player cannot yet afford that is in stock, not past its closing time and not at their limit
(the first in shop order on a tie; a reward not yet open counts); none when everything is affordable. No goal when
the event's shop is switched off. FR-522 (an item as a quest's or category's reward) moves from T-213 to T-304 with
its partner FR-1617; shop sections (FR-516) were already built in T-201.
**Why:** the goal is the player's own choice and follows them across phones; FR-522 needs category completion and a
handover for an item outside the shop, which T-304 brings.

## ADR-162 — Rank prizes: their own table, collected as desk items with no price
**Status:** Proposed (Claude, 2026-10-23; T-214; amended after the CTO plan review; Q-130 asks Dhia).
**Decision:** a rank prize is a `rank_prize` row (a rank range 1–100, item or experience, names and description),
never a `reward`, so no shop read can ever list or sell it. At the reveal each winner gets a `redemption` with
`rank_prize_id` and price 0, picked up through the same desk flow as shop items (FR-521): the flag hold, ban hold and
pause apply; the handover writes the usual 0/0 `handover` entry. The player cannot cancel it; an operator's cancel or
the timeout ends it with no ledger entry. The owner sets the claim deadline at the reveal (default: the end of the
desk's last open window, or the shop's closing when the desk has no hours, kept 1 to 60 days away; none when the
desk's hours end before that), between 1 hour and 60 days away; the
reveal is refused when the desk has hours and none fall before the deadline. Prize ranges, kinds and the switch lock
once the event is live and stay locked after it ends, before and after confirmation (the dashboard says so); names
and descriptions stay editable until results are confirmed. The reveal is idempotent
through the place's stored redemption and a unique (prize, enrollment) key; the redemption's key contains a space, so
no player request can collide with it.
**Why:** a separate table fails closed (a rank prize cannot leak into the shop for free) while reusing the whole
handover path the desk already enforces.

## ADR-163 — Confirming results: owner only, after the end, against what the owner saw
**Status:** Proposed (Claude, 2026-10-23; T-214; Q-127, Q-128 and Q-129 ask Dhia).
**Decision:** only the owner confirms, only once the event has ended. The confirmation carries the ranked enrollment
ids the owner saw and is refused if the places changed since. Open flags are shown and named in the dialog but never
block. Confirming stores the top places (`result_place`, at least 10) and freezes them: removals are refused from
then on (a removal locks the event before the enrollment, so it and a confirm serialize), and a later ban, flag or
cancel return changes no place. No undo, no pass-down and no re-issue in v1: a banned winner's prize is held at the
desk and the owner may cancel it; a winner who left keeps the place with an uncollectable item; an unclaimed prize
expires. Rehearsal cannot confirm, since it never ends.
**Why:** the final score only settles at the end (manual awards close with the live event, ADR-135 freezes spending's
effect); checking against what the owner saw means the owner confirms exactly the list they reviewed.

## ADR-164 — The reveal is a separate owner step; the winner's push waits for T-501
**Status:** Proposed (Claude, 2026-10-23; T-214).
**Decision:** after confirming, the owner presses Reveal winners. Only then do winners get their prize item, the
player app shows the results and a "You won" card on Home, and the event's results become readable by players. The
push of FR-1718 is sent by T-501 from the revealed places; until then the Home card carries the message.
**Why:** FR-520 reveals only after confirmation, and an organizer may confirm early and reveal on stage (T-307's
big-screen scene calls the same reveal). There is no push infrastructure yet.

## ADR-165 — Each event's official rules: a fixed block from data, then the organizer's text
**Status:** Proposed (Claude, 2026-10-23; T-214; amended after the CTO plan review: store gate).
**Decision:** for an event with active rank prizes the server builds a fixed rules block from data, in Arabic and
English: Questify administers the contest and the organizer provides the prizes (wording for counsel, Q-040/Q-041);
Apple and Google are not sponsors; how winners are picked (final score, ties to whoever reached it first, the team,
operators, banned players and the exclusion list cannot win); the number of winners and each rank's prize; the end
time and the claim-deadline rule. The organizer's `rules_ar`/`rules_en` (plain text, up to 10,000 characters) go
below it. The app shows the rules natively on the info page; `/[lang]/e/[code]/rules` shows the same as plain text,
never empty while prizes exist, with the event read's visibility (404 for draft and archived).
**Why:** STORE_COMPLIANCE §1.12 (Apple 5.3.1/5.3.2, Google §2.9) requires official rules stating the sponsor and that
Apple and Google are not involved; building them from data means no event with prizes can lack them. FR-1707 wants a
rules page per event, which T-110 and T-113 left here.

## ADR-166 — Today's ranking: read from the ledger, one Redis copy per event day
**Status:** Proposed (Claude, 2026-10-23; T-216; Q-132 asks Dhia).
**Decision:** today's points are the sum of the player's ledger entries created inside the current event day (FR-1714's
day start), so awards, removals and rank-lowering spends of that day count as they do overall; ties go to whoever
reached today's points first (the last of today's entries, lowest first). Who is ranked is the overall rule plus today's
points above 0. Today's ranking exists only while the event is live and spans more than one event day, and is on
unless the owner turns it off (`rankingToday` switch, FR-608); hiding the ranking hides both. No table and no ledger
trigger change: the after-scan write, the repair job and the backstop each keep a Redis copy per day (key
`{event}/{day}`), so the day start empties the board with nothing to delete.
**Why:** reading the append-only ledger keeps the points core untouched and leaves one source of truth; a key per day
gives the reset for free and reuses the whole Redis store, its rebuilds and its PostgreSQL fallback.

## ADR-167 — A declined join request is a status of its own
**Status:** Proposed (Claude, 2026-10-23; T-218; Q-133 asks Dhia).
**Decision:** declining a Private event's join request sets the enrollment to a new status `declined`: no seat, not
ranked, cannot score. The player sees "Your request was declined" and cannot ask again, unless the organizer puts
them on the guest list (then they go in as an invited person). The owner or an editor can still accept a declined
request later. Declining a waiting-list request on a Public or Unlisted event bars that player the same way: the
organizer's power over who plays. Accept and decline are audited with the enrollment id only.
**Why:** a separate status keeps the decision visible to both sides and stops repeat requests from reaching the
queue, without reusing `removed` (an organizer's sanction) or `left` (the player's own choice).

## ADR-168 — Seats count accepted players; the waiting list is a flagged pending join
**Status:** Proposed (Claude, 2026-10-23; T-218; amends ADR-141; Q-134 asks Dhia).
**Decision:** a seat under the player limit is an `active` or `banned` enrollment (FR-1821: accepted players only);
`pending` and `declined` take none, and the limit is checked on every move into `active`: a request already made is
never dropped for being over the limit, while its acceptance is checked. A hard-limited event at its limit answers a
join with `full`, whatever its access type (a Private event's request without an invitation is never refused); the
player may then join the waiting list, which is the same join with `waitlist: true` making a `pending` enrollment
with `waitlisted = true`. Releasing someone is accepting them, oldest first. The limit itself stays Questify's
(console, ADR-141) until an owner ceiling exists.
**Why:** one pending state with one accept path serves both requests and the waiting list, so there is one
definer, one audit action and one seat check; counting pending rows would let unanswered requests fill the event.
**Amends ADR-141 (T-218 code review):** a player who left can be neither banned nor lifted (`not_allowed`): the ban
would take a seat the limit never checked, and a lift would make them active without their own join. A player who
left and rejoins can be banned then; until they do, they hold no seat and cannot score.

## ADR-169 — Changing an event's access type keeps everyone where they are
**Status:** Proposed (Claude, 2026-10-23; T-218; Q-135 asks Dhia).
**Decision:** the owner or an editor changes the access type on the event form at any time, after a confirmation
that names the effect. Members keep their status; pending requests stay pending after a switch to Public or
Unlisted, and the owner still accepts or declines them (the queue shows while any exist).
**Why:** FR-1820 keeps every current player; letting waiting requests in automatically on a switch would admit
people the owner never looked at.

## ADR-170 — One targeting rule per category or reward, enforced in the database
**Status:** Proposed (Claude, 2026-10-23; T-220; kept by the CTO plan review; Q-136 asks Dhia).
**Decision:** a category or a reward may carry one rule: *answer* (a join field and chosen options of it) or *tag* (a
set of guest tags); none means everyone. A player outside the audience does not see the item (quests, Home, the shop,
the public event page hides every targeted category), cannot complete its quests (`record_completion`: 403
`quest_not_open`, `reason: not_for_you`, the same for an operator's scan and the team's quest award) and cannot
reserve or pin the reward (404). A rule can change any time; earlier points and reservations stay. Rehearsal
enrollments see everything. The owner or an editor in scope sets rules; audited with ids only.
**Why:** FR-1708 says other players "don't see it"; checking in the shared completion and reservation paths means no
route can forget it, and a refusal with a reason at the booth beats a silent "not found" for a visible QR code.

## ADR-171 — Only choice fields can target
**Status:** Proposed (Claude, 2026-10-23; T-220; kept by the CTO plan review; Q-137 asks Dhia).
**Decision:** a `custom` join field gains optional options (2 to 20, each with an id and Arabic and English labels);
the app shows a picker and the join accepts only an option id. Targeting by answer is allowed only on such a field.
Options are set only while the field has no answers; afterwards labels change and options are added, but an option an
answer or a rule names cannot be removed (ADR-173). A returning player keeps the answers they gave before.
**Why:** join answers are free text today; "Women", "women" and "نساء" would match by luck, and a rule the organizer
believes in but that silently misses players is worse than none.

## ADR-172 — A guest entry carries one optional tag
**Status:** Proposed (Claude, 2026-10-23; T-220; kept for now by the CTO plan review; Q-138 asks Dhia).
**Decision:** `event_guest.tag` (1 to 30 characters, matched case-insensitively). The paste box applies one tag to the
whole paste; pasting a contact already listed with a tag sets its tag. A player's tags are those of every entry that
matches a verified phone or email. A tagged contact is on the guest list, so it is invited and skips a private
event's approval (the paste box says so). For a prize kept for named people, a tag is the right tool: players pick
their own answers (the reward editor says so).
**Why:** one tag per entry covers the common cases (VIP, Speaker, Women's section) with no new table and no new paste
format to learn; several groups are several pastes.

## ADR-173 — Targeting fails closed
**Status:** Proposed (Claude, 2026-10-23; T-220; kept by the CTO plan review).
**Decision:** a join field named by a rule cannot be deleted, nor one of its options in use removed or its options
cleared (409 `join_field_in_use {reason: rules}`, naming the categories and rewards; `{reason: answers}` when answers
name it). A removed reward that still holds a rule is listed in "Who sees what" so its rule can be cleared.
**Why:** a deleted field quietly opening a Women-only category to everyone is the failure that would hurt an
organizer most; refusing with the names lets them change the rule first.

## ADR-174 — Mutation testing runs on GitHub, in batches, on the files a task changed
**Status:** Accepted (Dhia, 2026-10-24). Amends ADR-111 (scope) and ADR-149 (where heavy checks run).
**Decision:**
1. Mutation testing covers core code only, and only the files a task changed (the task lists its globs).
2. One GitHub run (`mutation.yml`) per batch of 2 or 3 core tasks, started by the coordinator.
3. Survivors are chased only while a file is under 90%; at 90% or more the file is done.
4. It never runs on the developer PC.
**Why:** a local run takes about 18 GB and can crash Dhia's PC; batching and changed-file scope keep GitHub minutes
low, and 90% is the core target ADR-111 already set.

## ADR-175 — A deleted account becomes a tombstone; its records stay, naming no one
**Status:** Proposed (Claude, 2026-10-24; T-217).
**Decision:** account deletion keeps the `player` row as a tombstone (id, `status = 'deleted'`, `deleted_at`; username,
birth year and avatar cleared) and keeps the player's enrollments, ledger entries, completions, handed-over prizes and
frozen result places, which then name no one. Contacts, sessions, username history, acceptances, join answers, flags,
device ids, ledger-note reasons and operator assignments are deleted or cleared. The player's flags go too, so the organizer's
flag history for them is lost; the audit log keeps the decisions as ids. The player leaves every board; a
frozen result shows "Deleted player". No restore exists.
**Why:** the ledger is append-only (NFR-019) and the records hold RESTRICT keys; anonymising in place keeps event
totals and frozen results right (FR-1739) while removing everything personal. Answers Q-086 and Q-092.

## ADR-176 — Deletion fingerprints: a keyed hash, kept only as ban and welcome marks
**Status:** Proposed (Claude, 2026-10-24; T-217).
**Decision:** each contact carries an HMAC-SHA256 fingerprint computed by the API with a key derived from the server
secret. On deletion only marks are kept: (fingerprint, event, banned | welcomed), and (fingerprint, platform, banned)
for a platform-banned account; no player id. Joining an event with a `banned` mark is refused, the welcome reward is
skipped with a `welcomed` mark, and sign-up or a contact change is refused with a platform mark. An account with no
ban and no welcome leaves nothing. A mark goes with its event's data.
**Why:** FR-1704 needs bans and one-time rewards to survive a re-sign-up, and a plain hash of a Saudi mobile number can
be reversed by trying every number. The key cannot be rotated without losing the marks (Q-141).

## ADR-177 — Deletion always takes a fresh code, in the app and on the web page
**Status:** Proposed (Claude, 2026-10-24; T-217).
**Decision:** one flow for both: a one-time code to the account's phone or email (purpose `deletion`, never usable to
sign in), then a short-lived single-use deletion token that lists pending handovers, then the confirmation. The public
code request answers the same whether or not an account uses the contact. Deletion is immediate. A platform-banned
account may delete.
**Why:** re-authentication for a destructive action (ASVS L2), one path to test instead of two, and the web page
(FR-127) needs a way to prove ownership without the app.

## ADR-178 — Pending handovers are forfeited with consent; handed-over records stay anonymised
**Status:** Proposed (Claude, 2026-10-24; T-217).
**Decision:** a player with a reserved prize or a desk item waiting sees the list and must tick that they give them
up; the deletion then cancels them through the normal cancel path (stock returns) before erasing. Handed-over records
stay, attached to the anonymised enrollment.
**Why:** FR-128 and the T-217 done-condition ("a pending handover is explained before deletion"); once the record names
no one it is no longer personal data, so no purge job is needed now (Q-142 for counsel).

## ADR-179 — Questify XP follows the event ledger by trigger, in its own append-only rows
**Status:** Proposed (Claude, 2026-10-24; T-401).
**Decision:** an `AFTER INSERT` trigger on `ledger_entry` writes XP: one credit per (player, quest), ever, on the
first non-rehearsal `quest` entry; one reversal when a `removal` reverses a credited quest entry (the quest stays used,
ADR-152). XP lives in `player_xp` (total and level), append-only `xp_entry` and `level_reached` (first time per
level, never removed). No other ledger kind pays or takes XP. A deleted account keeps its XP rows on the tombstone.
**Why:** every writer of a quest credit already ends in one ledger insert, so no path can pay points and forget XP;
the rows point at `player_xp`, not `player`, so they never wait on a deletion's player lock. Plan:
`docs/plans/2026-10-24-t-401-xp.md`.

## ADR-180 — 100 XP per quest; 30 levels on a gentle curve
**Status:** Proposed (Claude, 2026-10-24; T-401). Q-145.
**Decision:** `platform_setting` `xp.questXp` = 100 (server only, never in the public config). Level n starts at
`50·(n−1)·(n+2)` XP: level 2 at 200, 5 at 1,400, 10 at 5,400, 30 at 46,400. Both seeded; T-709 edits them.
**Why:** an early level-up comes after two quests (levels 2 to 6 after 2, 5, 9, 14 and 20 quests); a full event of
about 20 quests (2,000 XP) reaches level 6; level 10 takes 54 quests and level 30 464, so many events.

## ADR-181 — Level titles, one per five levels
**Status:** Proposed (Claude, 2026-10-24; T-401). Q-148.
**Decision:** 1–5 مستكشف Explorer, 6–10 مقتفي الأثر Pathfinder, 11–15 مغامر Adventurer, 16–20 صائد الكنوز Treasure
Hunter, 21–25 بطل Champion, 26–30 أسطورة Legend. Stored as data (`level_title`); T-709 edits them.
**Why:** FR-706 and F-128's adventure theme.

## ADR-182 — Not in T-401: XP on repeats, difficulty-based XP, the level-up item and gems
**Status:** Proposed (Claude, 2026-10-24; T-401). Q-147.
**Decision:** the platform switches for XP on repeats and by difficulty (ADR-083: "later") are not built. T-401
records each level reached; T-402 grants the item for each (FR-721) and T-404 the gems (ADR-046). Until T-402, the XP
bar shows the next level without its reward (FR-416).
**Why:** no speculative switches; the item catalogue does not exist yet.

## ADR-183 — Photo submissions are a separate task (T-301b)
**Status:** Proposed (Claude, 2026-10-24; T-301; revised after the CTO plan review). Q-149.
**Decision:** T-301 ships text submissions from start to finish and builds no photo pipeline. The quest schema refuses
`photo` with "not available yet", as `video` (FR-1006); `submission.kind` keeps the column. T-301b builds photos once a
Questify bucket exists; sharing `b7r-media` under a prefix is not used.
**Why:** CranL Pro allows one bucket per account and `b7r-media` uses it (ADR-107 addendum 2), so ADR-109's bucket does
not exist yet; a switch for an unbuilt store is a speculative feature. Plan: `docs/plans/2026-10-24-t-301-submissions.md`.

## ADR-184 — Pending points live on the submission; the ledger holds only points that moved
**Status:** Proposed (Claude, 2026-10-24; T-301; revised after the CTO plan review).
**Decision:** a submission stores the points it will pay; the points and the repeat cap are checked and fixed when it is
sent. Approval re-checks only the player (active) and the event (live or ended), then writes the ordinary completion
(`method = 'submission'`, key `'sub:' || id`) and `quest` ledger entry (score always; balance only while the shop window
is open, FR-1710); rejection writes nothing. Auto-approve does both in the submit call. XP follows by ADR-179. A player
leaving the event (ban, removal, leave, deletion) closes their pending submissions with a system reason. One removal
path: `remove_award` marks the linked submission removed. The `sub:` key prefix is reserved (refused at the API and in SQL), and a reviewer's own key is unique per reviewer and event.
**Why:** score, balance, ranking, flags and XP need no new path, and the ledger never holds points that did not move.

## ADR-185 — Photos are uploaded through the API and re-encoded (T-301b)
**Status:** Proposed (Claude, 2026-10-24; T-301; moved to T-301b). Q-151.
**Decision:** `POST /v1/quests/{id}/photo` takes up to 8 MB (JPEG, PNG, HEIC by magic bytes) and re-encodes it with
`sharp` (with `limitInputPixels`, one image at a time) to JPEG of at most 2,048 px, which strips EXIF (GPS, device). The team views photos through 5-minute signed URLs
on the bucket's host, never the API origin. New dependencies: `sharp`, `aws4fetch`.
**Why:** SECURITY threat 8 (type checks, re-encoding, not served from the API origin) and no location data stored.

## ADR-186 — Retention of submission photos (T-301b)
**Status:** Proposed (Claude, 2026-10-24; T-301; moved to T-301b). Q-152.
**Decision:** rejected and removed photos, and those of a deleted account or a wiped rehearsal, are deleted at once
through a `media_delete` outbox the worker drains (timeout, retry). Approved photos follow event retention (Q-075).
**Why:** PDPL minimisation: a rejected photo has no further purpose.

## ADR-187 — Auto-approved submissions stay in the queue until seen
**Status:** Proposed (Claude, 2026-10-24; T-301). Q-153.
**Decision:** an auto-approved submission pays at once and shows in the team's queue as "not yet seen" until a reviewer
opens it (`mark_submissions_seen`; any review sets it too); the team can remove it (FR-328).
**Why:** ADR-042's accepted risk stays small, and Google's UGC policy asks that points follow moderation.

## ADR-188 — Resubmission
**Status:** Proposed (Claude, 2026-10-24; T-301). Q-154.
**Decision:** with the quest's resubmit option off, a rejection closes the quest for that player. With it on, a new
submission is allowed while the quest is open. Always at most one pending submission per player and quest, and pending
ones count against the repeat cap.
**Why:** FR-1709 with no double pending points.

## ADR-189 — Who reviews and who removes submissions
**Status:** Proposed (Claude, 2026-10-24; T-301). Q-155.
**Decision:** the owner, editors and operators with the `review` ability approve or reject (FR-324); removing an
approved submission is for the owner and editors only, as removals of awards (ADR-152).
**Why:** reviewing is daily venue work; taking points back is a manager's act.

## ADR-190 — T-302's scope: text vote options, no new enter-code work
**Status:** Proposed (Claude, 2026-10-24; T-302). Q-158.
**Decision:** vote options are the organizer's text for now; organizer images wait for a Questify bucket (Q-149). FR-1629
holds by construction: options live only in the quest's config, typed by the organizer. FR-211 (enter a code) shipped in
T-105 and its "variants" are the existing `hint`; no typed-answer quiz question in v1. Showing vote results to players
comes with live polls (F-100, T-306).
**Why:** ships the two types without waiting on storage, and keeps T-302 to what its FRs ask.

## ADR-191 — Quiz shape
**Status:** Proposed (Claude, 2026-10-24; T-302). Q-156.
**Decision:** multiple-choice questions (1 to 20, 2 to 6 choices, one right); one attempt per player (`repeat_cap = 1`);
`quest.points` is the points per right answer, frozen on the attempt at start; the server serves one question at a time
and returns the right answer only after the player answered or the question closed. Start, next and answer are
idempotent by their natural keys (one attempt per player and quiz, one answer per question). Any paid finish earns the
quest's full XP, as any completion.
**Why:** FR-208 and FR-209 with no way to read ahead or retry, and an edit of the quest changes nothing already started.

## ADR-192 — The quiz timer runs on the server
**Status:** Proposed (Claude, 2026-10-24; T-302). Q-157.
**Decision:** one timer for every question of a quiz (5 to 300 seconds, or none). A question's clock starts when the
server serves it and ends at `served_at + timer + 2 s` of grace; an answer after that is refused and the question closes
with no points. There is no clock between questions.
**Why:** the phone's clock cannot be trusted (rule 1); the grace absorbs a slow network; players read the right answer
before going on.

## ADR-193 — A quiz pays once, at the end
**Status:** Proposed (Claude, 2026-10-24; T-302). Q-159.
**Decision:** when the last question is answered or closed, right answers × the frozen points are paid as one completion
(key `quiz:<attempt>`, reserved) and one ledger entry through the shared payment path; no right answers pays nothing and
writes no completion, and the quest shows as done. An attempt left unfinished is paid by the lifecycle tick once the
quest closes or the event leaves live, with the approval's re-checks (ADR-184) and the shop window (FR-1710).
**Why:** one entry per completion keeps the ledger's shape; a player who walks away still gets what they earned.

## ADR-194 — Vote and quiz edits after the first answer
**Status:** Proposed (Claude, 2026-10-24; T-302).
**Decision:** once anyone has voted or started the quiz, only text may change; ids, the number and order of options,
questions and choices, the right answers and the timer are locked (`quest_locked`). Points stay editable for the
future: an attempt froze its points at start, and a vote pays at once.
**Why:** a moved right answer or a removed option would make earlier answers and votes mean something else.

## ADR-195 — Vote counts and erasure
**Status:** Proposed (Claude, 2026-10-24; T-302). Q-158.
**Decision:** the owner and editors see each option's count; players see only their own choice in T-302. A deleted
account's votes and quiz answers are deleted (counts drop); its quiz attempts stay for the ledger.
**Why:** STORE_COMPLIANCE PD-16 lists votes among what deletion removes.

## ADR-196 — T-303 splits into three
**Status:** Proposed (agreed by CTO review) (Claude, 2026-10-24; T-303). Q-160.
**Decision:** T-303 builds challenge, survey and share quests (FR-203, 214, 219, 220). T-303b builds location check-in
with the QR fallback, the location prompt's timing and the far-from-venue and impossible-speed flags (FR-215, 216, 1744,
331, 332). T-303c builds meet-someone quests (FR-212, 213).
**Why:** the location work is one store story (permission, purpose strings, privacy labels) and meet-someone needs its
own short-lived proof (ADR-137) and a two-player payment; neither fits one session beside the other three types.

## ADR-197 — A challenge is confirmed at the station
**Status:** Proposed (agreed by CTO review) (Claude, 2026-10-24; T-303). Q-161.
**Decision:** a `challenge` quest's only verification is My QR: an operator with `scan_quests` (and FR-909's quest
limits) picks it at the station and scans the player's My QR; an owner or editor may confirm with a manual award. The
player has no path to complete it, and there is no "request confirmation" queue.
**Why:** the station scan already carries every check (open window, operator play rule, 10-second guard); a queue
would be a second review system for the same outcome.

## ADR-198 — Survey quests
**Status:** Proposed (agreed by CTO review) (Claude, 2026-10-24; T-303). Q-162.
**Decision:** 1 to 20 questions, each a choice (2 to 10), a rating (1 to 5) or short text (up to 500 characters), each
required unless the organizer says not. One response per player, paid on submit; a manual award also completes the
quest, so the player cannot send the survey after one. The owner and editors see the total, counts, averages and the
newest 50 text answers per question, names not shown; operators and players see none. Structure locks after the first
response (ADR-194); a deleted account's responses are deleted.
**Why:** FR-214 sends results to the organizer only; names add nothing a survey needs and FR-1210 shares results with
speakers.

## ADR-199 — Share quests
**Status:** Proposed (agreed by CTO review) (Claude, 2026-10-24; T-303). Q-163.
**Decision:** a share quest holds the organizer's message and an optional `https://` link; the app opens the system share
sheet and pays on its `sharedAction` (Android always reports it: the cost ADR-034 accepted). Feature `shareQuests` is on
by default; creating a share quest is turning it on, and the event's switch off hides every share quest and refuses the
payment. The API checks the composed config.
**Why:** ADR-034 (reward on trust, one per player, organizer's switch); features are composed in one place (T-007).

## ADR-200 — T-304 splits into four
**Status:** Proposed (Claude, 2026-10-24; T-304). Q-164.
**Decision:** T-304 builds the category rules and the points bonus (FR-231 to FR-235). T-304b builds passport quests
(FR-224). T-304c builds daily and weekly refresh (FR-236, FR-1619) and hidden categories (FR-237). T-304d builds item
rewards for a quest or category (FR-522, FR-1617). FR-238 (reveal a hidden category by hint push) moves to T-501.
**Why:** each part needs its own mechanism (a step proof, a period clock, a desk item source); the rules and the bonus
share one idea of "done" that the others build on. Push does not exist before T-501.

## ADR-201 — Category gates
**Status:** Proposed (Claude, 2026-10-24; T-304). Q-165.
**Decision:** a category may open at a set time, unlock after one other category (no self, no cycle) and require its
quests in order. The gates bind the player's paths and the operator's station scan; an owner's or editor's manual award
passes them. A quest is done with a completion, or a quiz finished with no right answers; a category is done when each
of its visible quests is (strict, for the bonus). The gates never leave a dead end: an unlock category outside the
player's audience counts as met, and in order skips earlier quests that have closed; a pending submission still blocks
the next quest. A quiz already started finishes and pays under a lock set later.
**Why:** staff fix problems by hand and already pass the method check; a zero-right quiz is finished play (FR-208).

## ADR-202 — The completion bonus
**Status:** Proposed (Claude, 2026-10-24; T-304). Q-166.
**Decision:** a category's bonus is points, paid once per player by the database in the transaction whose completion
(or zero-right quiz finish) finishes the category (ledger kind `bonus`, actor `system`), at the amount set then, with
no XP. It moves the balance only while the shop is open, as a quest's points do. It is its own removable credit
(ADR-152): removing a quest's completion leaves the bonus, the owner removes the bonus separately, and a removed bonus
is not paid again. A quest added, hidden or deleted later neither takes a paid bonus back nor pays one.
**Why:** FR-231; the ledger is the one source of points (ADR-111) and the database already holds the enrollment lock
that makes "last quest" safe under races.
